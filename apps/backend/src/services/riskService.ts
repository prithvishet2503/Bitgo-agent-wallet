import { randomUUID } from 'node:crypto';
import {
  type AgentSubWallet,
  type GraduationCriterion,
  type GraduationEligibility,
  type Pact,
  type RiskAssessment,
  type RiskFactor,
  type RiskTier,
  type ScreeningResult,
  type SimulationResult,
  type SubWalletRiskSummary,
  type TransactionRecord,
  type TrustScore,
  nowIso,
  scoreToTier,
} from '@bitgo-agent-wallet/shared';
import { subWalletDao } from '../dal/models/subWallet.dao.js';
import { transactionDao } from '../dal/models/transaction.dao.js';
import * as auditService from './auditService.js';

/**
 * Section 5.2 (Fast-Follow) / Section 12.4 / 12.9 - Risk-Grading Engine.
 *
 * Auto-classifies every transaction into a risk tier (low / medium / high / critical)
 * and maintains a rolling trust score per agent sub-wallet. The risk assessment is
 * produced during the pre-execution pipeline (after simulation/screening, before
 * policy evaluation) and embedded in the TransactionRecord.
 *
 * Design decisions:
 * - Risk is ADVISORY for low/medium tiers — those pass through normally.
 * - High/critical tiers AUTO-ESCALATE to human approval even in Bounded Auto mode
 *   (user-confirmed behaviour).
 * - Trust score is a simple integer 0-100, stored directly on AgentSubWallet.
 *
 * Scoring factors and their weights (deterministic, no external API dependency):
 *   Value vs Pact max .......... 25%
 *   Screening verdict .......... 25%
 *   Contract risk .............. 15%
 *   Historical denial rate ..... 15%
 *   Value velocity ............. 10%
 *   Network/chain risk ......... 10%
 */

// --- Constants ---

const TRUST_SCORE_INITIAL = 100;
const TRUST_SCORE_MIN = 0;
const TRUST_SCORE_MAX = 100;

const TRUST_PENALTY_POLICY_VIOLATION = 2;
const TRUST_PENALTY_SCREENING_FLAG = 5;
const TRUST_PENALTY_QUARANTINE = 10;
const TRUST_PENALTY_SIMULATION_FAILURE = 2;
const TRUST_BONUS_CLEAN_EXECUTE = 1;
const VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h lookback for velocity check

// --- Section 12.4 - graduation eligibility criteria (deterministic checklist) ---

const GRADUATION_MIN_TRUST_SCORE = 90;
const GRADUATION_MIN_TOTAL_TRANSACTIONS = 20;
const GRADUATION_MAX_POLICY_VIOLATIONS = 2;
/** A graduation path exists only from Strict Mode - an agent already in
 * Bounded Auto cannot "graduate" anywhere, and a suspended agent is not a
 * candidate for more autonomy (Section 6.6 takes precedence over 12.4). */
const GRADUATION_FROM_MODE = 'strict';

// --- Public API ---

/**
 * Full risk assessment for a transaction. Called after simulation and screening
 * complete, before policy evaluation. Returns the assessment and updates the
 * sub-wallet's trust score as a side-effect.
 */
export function assessTransactionRisk(
  subWallet: AgentSubWallet,
  pact: Pact | null,
  request: { valueUsd: number; network: string; contractAddress: string | null; protocol: string | null },
  simulation: SimulationResult,
  screening: ScreeningResult,
): RiskAssessment {
  const factors: RiskFactor[] = [];

  // 1. Value vs Pact max (25%)
  factors.push(assessValueFactor(request.valueUsd, pact));

  // 2. Screening verdict (25%)
  factors.push(assessScreeningFactor(screening));

  // 3. Contract risk (15%)
  factors.push(assessContractFactor(request.contractAddress, request.protocol, screening));

  // 4. Historical denial rate (15%)
  factors.push(assessHistoryFactor(subWallet.id));

  // 5. Value velocity (10%)
  factors.push(assessVelocityFactor(subWallet.id, request.valueUsd, pact));

  // 6. Network/chain risk (10%)
  factors.push(assessNetworkFactor(request.network));

  // Weighted sum
  const overallScore = Math.round(
    factors.reduce((sum, f) => sum + f.score * f.weight, 0),
  );
  // Severity floors (Section 12.9 - grade by severity, not just aggregate
  // score): an active sanctions hit is never graded below critical, and any
  // other screening flag never below high - no matter how benign the value,
  // history, and velocity factors make the weighted sum look. Without the
  // floor a sanctioned-destination transaction could grade "medium" (the
  // screening factor is only 25% of the score), which reads as a severity
  // statement no compliance officer would accept.
  let tier = scoreToTier(overallScore);
  if (screening.verdict === 'flagged') {
    if (screening.reason === 'SANCTIONED_ADDRESS') {
      tier = 'critical';
    } else if (tier === 'low' || tier === 'medium') {
      tier = 'high';
    }
  }

  const assessment: RiskAssessment = {
    overallScore,
    tier,
    factors,
    assessedAt: nowIso(),
  };

  // Audit-log the assessment
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'RISK_ASSESSED',
    actorType: 'system',
    summary: `Risk assessed: ${tier} (score ${overallScore}) for transaction`,
    metadata: { riskAssessment: assessment },
  });

  return assessment;
}

/**
 * Updates the rolling trust score after a transaction reaches a terminal state
 * (executed / denied / screening_blocked / policy_denied / simulation_failed).
 * Called by the transaction pipeline when the outcome is known.
 */
export function updateTrustScore(
  subWallet: AgentSubWallet,
  outcome: {
    wasExecuted: boolean;
    hadPolicyViolation: boolean;
    hadScreeningFlag: boolean;
    hadQuarantineEvent: boolean;
    /** Section 6.3 - the pre-execution simulation predicted a revert. A
     * technical failure, deliberately NOT counted as a policy violation. */
    hadSimulationFailure?: boolean;
  },
): TrustScore {
  const ts = { ...subWallet.trustScore };
  ts.totalTransactions += 1;
  ts.lastUpdated = nowIso();
  // Guard for records persisted before `simulationFailures` existed.
  ts.simulationFailures = ts.simulationFailures ?? 0;
  const hadSimulationFailure = outcome.hadSimulationFailure ?? false;

  if (outcome.wasExecuted && !outcome.hadPolicyViolation && !outcome.hadScreeningFlag && !hadSimulationFailure) {
    ts.cleanAutoExecutes += 1;
    ts.score = Math.min(TRUST_SCORE_MAX, ts.score + TRUST_BONUS_CLEAN_EXECUTE);
  }
  if (outcome.hadPolicyViolation) {
    ts.policyViolations += 1;
    ts.score = Math.max(TRUST_SCORE_MIN, ts.score - TRUST_PENALTY_POLICY_VIOLATION);
  }
  if (outcome.hadScreeningFlag) {
    ts.screeningFlags += 1;
    ts.score = Math.max(TRUST_SCORE_MIN, ts.score - TRUST_PENALTY_SCREENING_FLAG);
  }
  if (outcome.hadQuarantineEvent) {
    ts.quarantineEvents += 1;
    ts.score = Math.max(TRUST_SCORE_MIN, ts.score - TRUST_PENALTY_QUARANTINE);
  }
  if (hadSimulationFailure) {
    ts.simulationFailures += 1;
    ts.score = Math.max(TRUST_SCORE_MIN, ts.score - TRUST_PENALTY_SIMULATION_FAILURE);
  }

  // Persist the updated trust score on the sub-wallet
  subWalletDao.createOrUpdate({ ...subWallet, trustScore: ts });


  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'TRUST_SCORE_CHANGED',
    actorType: 'system',
    summary: `Trust score changed to ${ts.score} (${outcome.wasExecuted ? 'executed' : 'denied'})`,
    metadata: {
      previousScore: subWallet.trustScore.score,
      newScore: ts.score,
      outcome,
    },
  });

  return ts;
}

/**
 * Returns the risk summary for a sub-wallet: current trust score + last N
 * risk assessments from recent transactions.
 */
export function getRiskSummary(subWalletId: string): SubWalletRiskSummary {
  const subWallet = subWalletDao.get(subWalletId);
  if (!subWallet) {
    throw new Error(`Sub-wallet ${subWalletId} not found`);
  }

  // Pull the 20 most recent transactions with risk assessments
  const recentTxs = transactionDao
    .list((tx) => tx.subWalletId === subWalletId && tx.riskAssessment !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20);

  return {
    subWalletId,
    trustScore: subWallet.trustScore,
    recentAssessments: recentTxs.map((tx) => tx.riskAssessment!),
  };
}

/**
 * Section 12.4 - Adaptive Autonomy, eligibility side. A deterministic
 * checklist over the trust-score counters; the mode change itself stays a
 * human-approved admin/compliance action (`subWalletService.setAutonomyMode`),
 * which snapshots this evaluation into its AUTONOMY_MODE_CHANGED audit entry.
 * Never auto-graduates: eligibility only *proposes*.
 */
export function evaluateGraduationEligibility(subWallet: AgentSubWallet): GraduationEligibility {
  const ts = { ...subWallet.trustScore, simulationFailures: subWallet.trustScore.simulationFailures ?? 0 };
  const criteria: GraduationCriterion[] = [
    {
      key: 'trust_score',
      label: 'Trust score',
      met: ts.score >= GRADUATION_MIN_TRUST_SCORE,
      current: ts.score,
      required: `>= ${GRADUATION_MIN_TRUST_SCORE}`,
    },
    {
      key: 'total_transactions',
      label: 'Transactions attempted',
      met: ts.totalTransactions >= GRADUATION_MIN_TOTAL_TRANSACTIONS,
      current: ts.totalTransactions,
      required: `>= ${GRADUATION_MIN_TOTAL_TRANSACTIONS}`,
    },
    {
      key: 'policy_violations',
      label: 'Policy violations',
      met: ts.policyViolations <= GRADUATION_MAX_POLICY_VIOLATIONS,
      current: ts.policyViolations,
      required: `<= ${GRADUATION_MAX_POLICY_VIOLATIONS}`,
    },
    {
      key: 'screening_flags',
      label: 'Screening flags',
      met: ts.screeningFlags === 0,
      current: ts.screeningFlags,
      required: '= 0',
    },
    {
      key: 'quarantine_events',
      label: 'Quarantine events',
      met: ts.quarantineEvents === 0,
      current: ts.quarantineEvents,
      required: '= 0',
    },
  ];

  const modeEligible =
    subWallet.autonomyMode === GRADUATION_FROM_MODE && subWallet.status === 'active';

  return {
    subWalletId: subWallet.id,
    eligible: modeEligible && criteria.every((c) => c.met),
    criteria: [
      ...criteria,
      {
        key: 'current_mode',
        label: 'Current autonomy mode',
        met: modeEligible,
        current: subWallet.autonomyMode === 'strict' ? 0 : 1,
        required: 'strict + active',
      },
    ],
    evaluatedAt: nowIso(),
  };
}

/** Whether a risk tier should auto-escalate to human approval even in
 * Bounded Auto mode. */
export function requiresHumanApproval(tier: RiskTier): boolean {
  return tier === 'high' || tier === 'critical';
}

// --- Internal factor assessors ---

function assessValueFactor(valueUsd: number, pact: Pact | null): RiskFactor {
  if (!pact || pact.maxTransactionValueUsd <= 0) {
    return { name: 'value_vs_pact_max', score: 10, weight: 0.25, description: 'No pact cap — low value risk' };
  }
  const ratio = valueUsd / pact.maxTransactionValueUsd;
  let score: number;
  let desc: string;
  if (ratio <= 0.1) { score = 5; desc = `Well under pact max (${(ratio * 100).toFixed(0)}%)`; }
  else if (ratio <= 0.5) { score = 25; desc = `Moderate vs pact max (${(ratio * 100).toFixed(0)}%)`; }
  else if (ratio <= 0.9) { score = 50; desc = `Close to pact max (${(ratio * 100).toFixed(0)}%)`; }
  else if (ratio <= 1.0) { score = 75; desc = `At pact max (${(ratio * 100).toFixed(0)}%)`; }
  else { score = 100; desc = `Exceeds pact max (${(ratio * 100).toFixed(0)}%)`; }

  return { name: 'value_vs_pact_max', score, weight: 0.25, description: desc };
}

function assessScreeningFactor(screening: ScreeningResult): RiskFactor {
  if (screening.verdict === 'clean') {
    return { name: 'screening_verdict', score: 0, weight: 0.25, description: 'Address clean — no flags' };
  }
  // Flagged addresses are high/critical regardless of other factors
  const baseScore = screening.reason === 'SANCTIONED_ADDRESS' ? 100 : 80;
  return {
    name: 'screening_verdict',
    score: baseScore,
    weight: 0.25,
    description: `Flagged by ${screening.vendor}: ${screening.reason}`,
  };
}

function assessContractFactor(
  contractAddress: string | null,
  protocol: string | null,
  screening: ScreeningResult,
): RiskFactor {
  if (!contractAddress) {
    return { name: 'contract_risk', score: 0, weight: 0.15, description: 'No contract interaction — EOA transfer' };
  }

  // If screening already flagged the contract, that's the dominant signal
  if (screening.verdict === 'flagged' && screening.reason === 'KNOWN_MALICIOUS_CONTRACT') {
    return { name: 'contract_risk', score: 90, weight: 0.15, description: 'Contract flagged as malicious by screening vendor' };
  }

  // Known protocols are lower risk
  if (protocol && ['uniswap-v3', 'aave-v3', 'compound-v3', 'curve'].includes(protocol)) {
    return { name: 'contract_risk', score: 15, weight: 0.15, description: `Known protocol: ${protocol}` };
  }

  // Unknown contract interaction — moderate risk
  return { name: 'contract_risk', score: 45, weight: 0.15, description: 'Unverified contract interaction' };
}

function assessHistoryFactor(subWalletId: string): RiskFactor {
  const recentTxs = transactionDao
    .list((tx) => tx.subWalletId === subWalletId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 50);

  if (recentTxs.length === 0) {
    return { name: 'historical_denial_rate', score: 0, weight: 0.15, description: 'No transaction history' };
  }

  const denialCount = recentTxs.filter(
    (tx) => tx.status === 'denied' || tx.status === 'policy_denied' || tx.status === 'screening_blocked',
  ).length;
  const denialRate = denialCount / recentTxs.length;

  let score: number;
  let desc: string;
  if (denialRate === 0) { score = 0; desc = 'Clean history — no denials'; }
  else if (denialRate <= 0.1) { score = 20; desc = `Low denial rate (${(denialRate * 100).toFixed(0)}%)`; }
  else if (denialRate <= 0.3) { score = 50; desc = `Moderate denial rate (${(denialRate * 100).toFixed(0)}%)`; }
  else { score = 80; desc = `High denial rate (${(denialRate * 100).toFixed(0)}%)`; }

  return { name: 'historical_denial_rate', score, weight: 0.15, description: desc };
}

function assessVelocityFactor(subWalletId: string, valueUsd: number, pact: Pact | null): RiskFactor {
  const since = new Date(Date.now() - VELOCITY_WINDOW_MS).toISOString();
  const recentTxs = transactionDao
    .list((tx) => tx.subWalletId === subWalletId && tx.createdAt >= since && tx.status === 'executed')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const sumUsd = recentTxs.reduce((acc, tx) => acc + tx.request.valueUsd, 0);
  const totalWithCurrent = sumUsd + valueUsd;

  if (!pact || pact.dailySpendCapUsd <= 0) {
    return { name: 'value_velocity', score: 10, weight: 0.10, description: 'No daily cap — low velocity risk' };
  }

  const ratio = totalWithCurrent / pact.dailySpendCapUsd;
  let score: number;
  let desc: string;
  if (ratio <= 0.3) { score = 5; desc = `Low velocity (${(ratio * 100).toFixed(0)}% of daily cap)`; }
  else if (ratio <= 0.7) { score = 30; desc = `Moderate velocity (${(ratio * 100).toFixed(0)}% of daily cap)`; }
  else if (ratio <= 1.0) { score = 70; desc = `Near daily cap (${(ratio * 100).toFixed(0)}%)`; }
  else { score = 100; desc = `Exceeds daily cap (${(ratio * 100).toFixed(0)}%)`; }

  return { name: 'value_velocity', score, weight: 0.10, description: desc };
}

function assessNetworkFactor(network: string): RiskFactor {
  const testnetIndicators = ['testnet', 'sepolia', 'goerli', 'holesky'];
  const isTestnet = testnetIndicators.some((i) => network.toLowerCase().includes(i));

  if (isTestnet) {
    return { name: 'network_risk', score: 40, weight: 0.10, description: `Testnet network: ${network}` };
  }
  return { name: 'network_risk', score: 5, weight: 0.10, description: `Mainnet network: ${network}` };
}

/** Creates the default trust score for a newly created sub-wallet. */
export function defaultTrustScore(): TrustScore {
  return {
    score: TRUST_SCORE_INITIAL,
    lastUpdated: nowIso(),
    totalTransactions: 0,
    cleanAutoExecutes: 0,
    policyViolations: 0,
    screeningFlags: 0,
    quarantineEvents: 0,
    simulationFailures: 0,
  };
}

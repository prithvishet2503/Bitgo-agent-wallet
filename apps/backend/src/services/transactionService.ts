import { randomUUID } from 'node:crypto';
import {
  type ApprovalDecisionInput,
  type ApprovalRequest,
  type TransactionRecord,
  type TransactionRequestInput,
  DomainError,
  ForbiddenError,
  NotFoundError,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { transactionDao } from '../dal/models/transaction.dao.js';
import * as subWalletService from './subWalletService.js';
import * as pactService from './pactService.js';
import * as simulationService from './simulationService.js';
import * as screeningService from './screeningService.js';
import * as approvalService from './approvalService.js';
import * as sendQueueService from './sendQueueService.js';
import * as gasSponsorshipService from './gasSponsorshipService.js';
import * as auditService from './auditService.js';
import * as riskService from './riskService.js';
import { notifyAlert } from '../notifications/channels.js';
import type { ChainExecutor } from './chainExecutor.js';

/** Section 12.7 - fractions of a pact cap that trigger a budget alert when
 * projected spend crosses them. Comma-separated env override, e.g.
 * `BUDGET_ALERT_THRESHOLDS=0.5,0.9`. */
const BUDGET_ALERT_THRESHOLDS = (process.env.BUDGET_ALERT_THRESHOLDS ?? '0.5,0.8,0.9')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0 && n <= 1)
  .sort((a, b) => a - b);

/**
 * Orchestrates the full agent-transaction lifecycle described across Sections
 * 6.2-6.5 and 6.10: pre-execution checks -> risk assessment -> policy
 * evaluation -> autonomy-mode routing -> (auto-proceed | human approval) ->
 * gas-sponsorship decision -> SendQueue.
 *
 * Mirrors wallet-platform's `send.ts` in one respect only: everything up
 * through deciding *that* a transaction should go out happens inline in the
 * request, and actual signing/broadcasting happens later, off a
 * `SendQueueEntry` (`completeBroadcast`, called by
 * scheduler/sendQueueWorker.ts) - never synchronously inside the HTTP request.
 * Unlike wallet-platform, there is no second service on the other end of that
 * queue: the same backend process that enqueues an entry also signs and
 * broadcasts it (see chainExecutor.ts) - the queue exists only to keep chain
 * latency off the request path, not to hand work to another service. Every
 * step is audit-logged (Section 6.8) as it happens.
 */

function newRecordShell(request: TransactionRequestInput, subWallet: { id: string; enterpriseId: string }): TransactionRecord {
  return {
    id: `tx_${randomUUID()}`,
    subWalletId: subWallet.id,
    enterpriseId: subWallet.enterpriseId,
    request,
    status: 'pending_approval', // placeholder, overwritten before returning
    simulation: null,
    screening: null,
    policyViolations: [],
    riskAssessment: null,
    gasSponsored: false,
    gasSponsorshipFallbackUsed: false,
    createdAt: nowIso(),
    decidedAt: null,
    executedAt: null,
    approvalRequestId: null,
  };
}

function assertAccessible(enterpriseId: string, actingUser: User): void {
  if (!actingUser.accessibleEnterpriseIds.includes(enterpriseId)) {
    throw new ForbiddenError('Cannot act on a resource outside an enterprise you have access to');
  }
}

export async function submitTransaction(request: TransactionRequestInput, actingUser: User): Promise<TransactionRecord> {
  const subWallet = subWalletService.getSubWallet(request.subWalletId);
  assertAccessible(subWallet.enterpriseId, actingUser);

  const record = newRecordShell(request, subWallet);
  transactionDao.createOrUpdate(record);

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'TRANSACTION_SUBMITTED',
    actorUserId: actingUser.id,
    actorType: 'agent',
    summary: `Agent "${subWallet.agentName}" submitted a $${request.valueUsd} transaction to ${request.to}`,
    metadata: { transactionId: record.id, request },
  });

  // Section 6.6 - a suspended sub-wallet cannot sign at all.
  if (subWallet.status === 'suspended') {
    record.policyViolations = [{ code: 'SUB_WALLET_SUSPENDED', message: `Sub-wallet ${subWallet.agentName} is suspended` }];
    record.status = 'policy_denied';
    record.decidedAt = nowIso();
    transactionDao.createOrUpdate(record);
    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'TRANSACTION_POLICY_DENIED',
      actorUserId: null,
      actorType: 'system',
      summary: 'Transaction denied: sub-wallet is suspended',
      metadata: { transactionId: record.id },
    });
    return record;
  }

  // A sub-wallet still waiting on its on-chain deployment has no address yet.
  if (subWallet.pendingDeployment || !subWallet.address) {
    record.policyViolations = [
      { code: 'SUB_WALLET_NOT_DEPLOYED', message: `Sub-wallet ${subWallet.agentName} is still deploying on-chain; try again shortly` },
    ];
    record.status = 'policy_denied';
    record.decidedAt = nowIso();
    transactionDao.createOrUpdate(record);
    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'TRANSACTION_POLICY_DENIED',
      actorUserId: null,
      actorType: 'system',
      summary: 'Transaction denied: sub-wallet has not finished on-chain deployment',
      metadata: { transactionId: record.id },
    });
    return record;
  }

  // Section 6.3 - pre-execution simulation, before anything else. In real
  // chain mode this is a genuine eth_call + estimateGas of the exact
  // AgentSubWallet.execute() call that would be broadcast (see
  // simulationService.ts / chainExecutor.simulateTransaction); in mock mode it
  // stays the deterministic placeholder model.
  const simulation = await simulationService.simulate(request, subWallet);
  record.simulation = simulation;
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'TRANSACTION_SIMULATED',
    actorUserId: null,
    actorType: 'system',
    summary: `Simulation ${simulation.willSucceed ? 'succeeded' : 'failed'} (est. fee $${simulation.estimatedFeeUsd})`,
    metadata: { transactionId: record.id, simulation },
  });
  if (!simulation.willSucceed) {
    record.status = 'simulation_failed';
    record.decidedAt = nowIso();
    transactionDao.createOrUpdate(record);

    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'TRANSACTION_SIMULATION_FAILED',
      actorUserId: null,
      actorType: 'system',
      summary: `Transaction blocked: simulation predicted failure (${simulation.failureReason})`,
      metadata: { transactionId: record.id, simulation },
    });

    // Section 12.4 - penalize trust score for a failed simulation. A technical
    // failure, deliberately NOT counted as a policy violation (that
    // conflation polluted the compliance counters the risk engine reads).
    riskService.updateTrustScore(subWallet, {
      wasExecuted: false,
      hadPolicyViolation: false,
      hadScreeningFlag: false,
      hadQuarantineEvent: false,
      hadSimulationFailure: true,
    });

    return record;
  }

  // Section 6.3 - threat/sanctions screening. Hard block on flagged.
  const screening = await screeningService.screenOutgoing(request.to, request.contractAddress, request.network);
  record.screening = screening;
  if (screening.verdict === 'flagged') {
    // Grade the blocked attempt too (Section 12.9 direction): the assessment
    // is stored on the transaction and audit-logged, so compliance can triage
    // flagged attempts by severity. This also makes the `critical` tier
    // reachable - a flagged screening contributing its full factor weight is
    // the strongest risk signal the engine has, and previously it could never
    // fire because assessment only ran on transactions that had *passed*
    // screening (structurally zeroing 25% of the score).
    const pactForAssessment = pactService.getPactForSubWallet(subWallet.id);
    record.riskAssessment = riskService.assessTransactionRisk(
      subWallet,
      pactForAssessment,
      request,
      simulation,
      screening,
    );
    record.status = 'screening_blocked';
    record.decidedAt = nowIso();
    transactionDao.createOrUpdate(record);

    // Section 12.4 - Penalize trust score for screening flag.
    riskService.updateTrustScore(subWallet, {
      wasExecuted: false,
      hadPolicyViolation: false,
      hadScreeningFlag: true,
      hadQuarantineEvent: false,
    });

    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'TRANSACTION_SCREENING_BLOCKED',
      actorUserId: null,
      actorType: 'system',
      summary: `Transaction hard-blocked by screening: ${screening.reason} (risk ${record.riskAssessment.tier}, score ${record.riskAssessment.overallScore})`,
      metadata: { transactionId: record.id, screening, riskAssessment: record.riskAssessment },
    });
    return record;
  }

  // Section 6.2 - Pact evaluation (must exist before risk assessment can
  // reference its limits).
  const pact = pactService.getPactForSubWallet(subWallet.id);
  if (!pact) {
    throw new DomainError(
      `Sub-wallet ${subWallet.agentName} has no Pact configured; an admin/compliance user must create one before it can transact`,
      'NO_PACT_CONFIGURED',
      409,
    );
  }
  const evaluation = pactService.evaluate(subWallet, pact, request);
  record.policyViolations = evaluation.violations;

  // Section 12.7 - Predictive budget alerts. Fires when *this* submission is
  // the one carrying projected spend across an alert threshold on a pact cap,
  // so admins hear the agent is trending toward its cap before the cap starts
  // escalating transactions to approval. Deterministic threshold math, not a
  // model - deduplicated by construction (a threshold only "crosses" once per
  // committed-spend level).
  for (const projection of pactService.projectSpend(subWallet.id, pact, request.valueUsd)) {
    if (projection.capUsd <= 0) continue; // degenerate cap; evaluation flags the tx anyway
    // ALL thresholds this submission crosses fire (a jump from 70% to 95%
    // alerts at both 80% and 90% - the 90% one is the one that matters).
    const crossed = BUDGET_ALERT_THRESHOLDS.filter(
      (t) => projection.committedRatio < t && projection.projectedRatio >= t,
    );
    for (const threshold of crossed) {
      const summary =
        `Agent "${subWallet.agentName}" projected to ${Math.round(projection.projectedRatio * 100)}% of its ` +
        `${projection.horizon} spend cap ($${projection.projectedUsd} of $${projection.capUsd} on transaction ${record.id})`;
      auditService.record({
        enterpriseId: subWallet.enterpriseId,
        subWalletId: subWallet.id,
        eventType: 'BUDGET_THRESHOLD_APPROACHED',
        actorUserId: null,
        actorType: 'system',
        summary,
        metadata: {
          transactionId: record.id,
          horizon: projection.horizon,
          threshold,
          committedUsd: projection.committedUsd,
          projectedUsd: projection.projectedUsd,
          capUsd: projection.capUsd,
        },
      });
      notifyAlert(`[budget ${Math.round(threshold * 100)}%] ${summary}`);
    }
  }

  // Section 5.2 / 12.9 - Risk-grading assessment. Produced after screening
  // (which already determined the address isn't blocked) and policy evaluation
  // (so we have the Pact limits for the value/vs-max and velocity factors).
  // High/critical risk tiers auto-escalate to human approval even in Bounded
  // Auto mode (user-confirmed behaviour).
  const riskAssessment = riskService.assessTransactionRisk(
    subWallet,
    pact,
    request,
    simulation,
    screening,
  );
  record.riskAssessment = riskAssessment;

  // Section 6.4 - Autonomy Modes + risk escalation.
  // Strict: every transaction pauses for human approval.
  // Bounded Auto: compliant transactions proceed; out-of-policy or
  // high/critical risk transactions escalate to human approval.
  const riskEscalates = riskService.requiresHumanApproval(riskAssessment.tier);
  const requiresApproval = subWallet.autonomyMode === 'strict' || !evaluation.compliant || riskEscalates;

  if (!requiresApproval) {
    queueForBroadcast(record, subWallet, pact, { auto: true });
    return record;
  }

  record.status = 'pending_approval';
  transactionDao.createOrUpdate(record);
  const approval = approvalService.createApprovalRequest(record, subWallet, simulation);
  record.approvalRequestId = approval.id;
  transactionDao.createOrUpdate(record);
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'APPROVAL_REQUESTED',
    actorUserId: null,
    actorType: 'system',
    summary: riskEscalates
      ? `Approval requested: risk-grading classified as ${riskAssessment.tier} (score ${riskAssessment.overallScore})`
      : evaluation.compliant
        ? `Approval requested (Strict Mode) for $${request.valueUsd} to ${request.to}`
        : `Approval requested: out-of-policy (${evaluation.violations.map((v) => v.code).join(', ')})`,
    metadata: { transactionId: record.id, approvalRequestId: approval.id, violations: evaluation.violations, riskAssessment },
  });
  return record;
}

/**
 * Marks a transaction ready to go out and enqueues a `SendQueueEntry` for it -
 * mirrors wallet-platform's `send.ts` writing a `SendQueue` document rather than
 * signing/broadcasting inline. Gas-sponsorship eligibility is decided here (it can
 * still block the transaction outright per Pact config) but the ledger entry and
 * `TRANSACTION_EXECUTED` event only land once `completeBroadcast` runs.
 */
function queueForBroadcast(
  record: TransactionRecord,
  subWallet: ReturnType<typeof subWalletService.getSubWallet>,
  pact: ReturnType<typeof pactService.getPact>,
  opts: { auto: boolean },
): void {
  const gasDecision = gasSponsorshipService.decide(subWallet, pact, record.simulation!.estimatedFeeUsd);

  if (gasDecision.reason === 'cap_exceeded_blocked') {
    record.status = 'denied';
    record.decidedAt = nowIso();
    transactionDao.createOrUpdate(record);
    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'GAS_SPONSORSHIP_CAP_EXCEEDED',
      actorUserId: null,
      actorType: 'system',
      summary: 'Transaction blocked: gas sponsorship cap exceeded and Pact is configured to block rather than fall back',
      metadata: { transactionId: record.id },
    });
    return;
  }

  record.gasSponsored = gasDecision.sponsor;
  record.gasSponsorshipFallbackUsed = gasDecision.fallbackUsed;
  record.status = 'approved';
  record.decidedAt = record.decidedAt ?? nowIso();
  transactionDao.createOrUpdate(record);

  const queueEntry = sendQueueService.enqueue({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    entryType: 'transaction_broadcast',
    relatedId: record.id,
  });

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'TRANSACTION_QUEUED_FOR_BROADCAST',
    actorUserId: null,
    actorType: 'system',
    summary: `Transaction ${opts.auto ? 'auto-approved' : 'approved'} and queued for signing/broadcast`,
    metadata: { transactionId: record.id, sendQueueEntryId: queueEntry.id, gasSponsored: record.gasSponsored },
  });
}

/** Called by the SendQueue worker (scheduler/sendQueueWorker.ts) once a
 * `transaction_broadcast` entry is dequeued - the only place a transaction
 * actually flips to `executed`. Idempotent against re-processing.
 *
 * In mock mode this is near-instant; in real chain mode this calls
 * executor.executeTransaction() which signs and broadcasts a real on-chain
 * transaction. The value moved on-chain is a tiny fraction of the USD figure
 * (see CHAIN_VALUE_SCALE_FACTOR in env.ts) - the backend still tracks the USD
 * figure as the authoritative record.
 *
 * Also updates the sub-wallet's trust score (Section 12.4) for a clean
 * auto-execution. */
export async function completeBroadcast(id: string, executor: ChainExecutor): Promise<void> {
  const record = getTransaction(id);
  if (record.status !== 'approved') return;

  const subWallet = subWalletService.getSubWallet(record.subWalletId);
  if (!subWallet.address) {
    throw new DomainError('Cannot broadcast: sub-wallet has no on-chain address yet', 'SUB_WALLET_NOT_DEPLOYED', 409);
  }

  const { txHash, valueWei } = await executor.executeTransaction({
    subWalletAddress: subWallet.address,
    to: record.request.to,
    valueUsd: record.request.valueUsd,
    transactionId: record.id,
  });

  if (record.gasSponsored) {
    gasSponsorshipService.recordSponsorship(record.subWalletId, record.id, record.simulation!.estimatedFeeUsd);
    auditService.record({
      enterpriseId: record.enterpriseId,
      subWalletId: record.subWalletId,
      eventType: 'GAS_SPONSORSHIP_APPLIED',
      actorUserId: null,
      actorType: 'system',
      summary: `Gas sponsored via EIP-7702 delegation ($${record.simulation!.estimatedFeeUsd})`,
      metadata: { transactionId: record.id },
    });
  }

  record.status = 'executed';
  record.executedAt = nowIso();
  transactionDao.createOrUpdate(record);

  // Section 12.4 - Update trust score for a clean execution.
  const freshSubWallet = subWalletService.getSubWallet(record.subWalletId);
  riskService.updateTrustScore(freshSubWallet, {
    wasExecuted: true,
    hadPolicyViolation: false,
    hadScreeningFlag: false,
    hadQuarantineEvent: false,
  });

  auditService.record({
    enterpriseId: record.enterpriseId,
    subWalletId: record.subWalletId,
    eventType: 'TRANSACTION_EXECUTED',
    actorUserId: null,
    actorType: 'system',
    summary: `Transaction broadcast and confirmed: $${record.request.valueUsd} to ${record.request.to} (${executor.mode} mode)`,
    metadata: { transactionId: record.id, txHash, valueWei, chainMode: executor.mode },
  });
}

export function getTransaction(id: string): TransactionRecord {
  const t = transactionDao.get(id);
  if (!t) throw new NotFoundError(`Transaction ${id} not found`);
  return t;
}

export function listTransactions(enterpriseId: string, subWalletId?: string): TransactionRecord[] {
  return transactionDao
    .list((t) => t.enterpriseId === enterpriseId && (!subWalletId || t.subWalletId === subWalletId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Section 6.5 - approve/deny a pending request. Also updates trust score
 * on denial. */
export function handleApprovalDecision(
  input: ApprovalDecisionInput,
  actingUser: User,
): { approval: ApprovalRequest; transaction: TransactionRecord } {
  const approval = approvalService.getApprovalRequest(input.approvalRequestId);
  const transaction = getTransaction(approval.transactionId);
  const outcome = approvalService.applyDecision(approval, actingUser, input.decision, input.reason);

  if (outcome.resolution === 'approved') {
    auditService.record({
      enterpriseId: approval.enterpriseId,
      subWalletId: approval.subWalletId,
      eventType: 'APPROVAL_GRANTED',
      actorUserId: actingUser.id,
      actorType: 'user',
      summary: `Transaction approved by ${actingUser.name}`,
      metadata: { approvalRequestId: approval.id, transactionId: transaction.id },
    });
    const subWallet = subWalletService.getSubWallet(transaction.subWalletId);
    const pact = pactService.getPact(subWallet.pactId!);
    transaction.decidedAt = nowIso();
    queueForBroadcast(transaction, subWallet, pact, { auto: false });
  } else if (outcome.resolution === 'denied') {
    transaction.status = 'denied';
    transaction.decidedAt = nowIso();
    transactionDao.createOrUpdate(transaction);

    // Section 12.4 - Penalize trust score for policy violation / denial.
    const subWallet = subWalletService.getSubWallet(transaction.subWalletId);
    riskService.updateTrustScore(subWallet, {
      wasExecuted: false,
      hadPolicyViolation: transaction.policyViolations.length > 0,
      hadScreeningFlag: false,
      hadQuarantineEvent: false,
    });

    auditService.record({
      enterpriseId: approval.enterpriseId,
      subWalletId: approval.subWalletId,
      eventType: 'APPROVAL_DENIED',
      actorUserId: actingUser.id,
      actorType: 'user',
      summary: `Transaction denied by ${actingUser.name}: ${outcome.reason}`,
      metadata: { approvalRequestId: approval.id, transactionId: transaction.id },
    });
  }

  return { approval, transaction };
}

/** Called by the timeout sweeper (Section 6.5 - deny-on-timeout default). */
export function sweepExpiredApprovals(): void {
  for (const approval of approvalService.listAllPendingAcrossEnterprises()) {
    const outcome = approvalService.expireIfTimedOut(approval);
    if (!outcome) continue;

    const transaction = getTransaction(approval.transactionId);
    if (outcome.resolution === 'denied') {
      transaction.status = 'denied';
      transaction.decidedAt = nowIso();
      transactionDao.createOrUpdate(transaction);

      // Section 12.4 - Penalize trust score for timeout denial.
      const subWallet = subWalletService.getSubWallet(transaction.subWalletId);
      riskService.updateTrustScore(subWallet, {
        wasExecuted: false,
        hadPolicyViolation: transaction.policyViolations.length > 0,
        hadScreeningFlag: false,
        hadQuarantineEvent: false,
      });

      auditService.record({
        enterpriseId: approval.enterpriseId,
        subWalletId: approval.subWalletId,
        eventType: 'APPROVAL_EXPIRED_DENIED',
        actorUserId: null,
        actorType: 'system',
        summary: `Approval window expired; denied by default-deny policy`,
        metadata: { approvalRequestId: approval.id, transactionId: transaction.id },
      });
    } else {
      const subWallet = subWalletService.getSubWallet(transaction.subWalletId);
      const pact = pactService.getPact(subWallet.pactId!);
      queueForBroadcast(transaction, subWallet, pact, { auto: false });
    }
  }
}

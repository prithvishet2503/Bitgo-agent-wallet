import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ScreeningReason, TransactionStatus } from '@bitgo-agent-wallet/shared';

// Static imports cannot work here: db.ts reads PERSISTENCE_MODE at module
// evaluation time, so the env assignment must execute before any project
// module loads (ESM static imports hoist above it). Deliberate module-loading
// boundary per the test-file exception.
process.env.PERSISTENCE_MODE = 'memory';
globalThis.fetch = (async () => {
  throw new Error('offline test environment');
}) as typeof fetch;
const { db, seedDemoData } = await import('../store/db.js');
const { scoreToTier } = await import('@bitgo-agent-wallet/shared');
const { transactionDao } = await import('../dal/models/transaction.dao.js');
const riskService = await import('./riskService.js');

const SW_ID = 'sw_risk';

function trustScoreFixture(overrides: Record<string, number> = {}) {
  return {
    score: 100,
    lastUpdated: new Date().toISOString(),
    totalTransactions: 25,
    cleanAutoExecutes: 23,
    policyViolations: 1,
    screeningFlags: 0,
    quarantineEvents: 0,
    simulationFailures: 0,
    ...overrides,
  };
}

function subWalletFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: SW_ID,
    enterpriseId: 'ent_demo',
    agentName: 'Risk Agent',
    chain: 'base' as const,
    address: '0xagentrisk',
    pendingDeployment: false,
    walletFullyCreated: true,
    sessionKeyRef: 'session_risk',
    fundingSource: 'allocated_balance' as const,
    allocatedBalanceUsd: 10000,
    drawDownLimitUsd: null,
    autonomyMode: 'strict' as const,
    status: 'active' as const,
    eip7702Delegated: false,
    pactId: null,
    trustScore: trustScoreFixture(),
    createdByUserId: 'user_admin',
    createdAt: new Date().toISOString(),
    suspendedAt: null,
    suspendedByUserId: null,
    suspendedReason: null,
    ...overrides,
  };
}

function pactFixture() {
  return {
    id: 'pact_risk',
    subWalletId: SW_ID,
    maxTransactionValueUsd: 500,
    dailySpendCapUsd: 2000,
    weeklySpendCapUsd: 5000,
    contractAllowlist: [],
    protocolAllowlist: [],
    networkAllowlist: ['base'],
    destinationAllowlist: [],
    destinationDenylist: [],
    sessionExpiresAt: null,
    gasSponsorshipCapUsdPerTx: null,
    gasSponsorshipCapUsdPerDay: null,
    gasSponsorshipFallback: 'own_balance' as const,
    createdByUserId: 'user_admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedByUserId: 'user_admin',
  };
}

function simulationFixture() {
  return {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.55,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  };
}

function screeningFixture(verdict: 'clean' | 'flagged', reason: ScreeningReason) {
  return { screenedAt: new Date().toISOString(), verdict, reason, vendor: 'test' };
}

function seededTx(status: TransactionStatus, valueUsd: number, ageHours: number) {
  return {
    id: `tx_${Math.random().toString(36).slice(2)}`,
    subWalletId: SW_ID,
    enterpriseId: 'ent_demo',
    request: {
      subWalletId: SW_ID,
      to: '0x1111111111111111111111111111111111111111',
      valueUsd,
      network: 'base',
      contractAddress: null,
      protocol: null,
      functionDescription: 'transfer',
    },
    status,
    simulation: null,
    screening: null,
    policyViolations: [],
    riskAssessment: null,
    gasSponsored: false,
    gasSponsorshipFallbackUsed: false,
    createdAt: new Date(Date.now() - ageHours * 3600_000).toISOString(),
    decidedAt: null,
    executedAt: null,
    approvalRequestId: null,
  };
}

beforeEach(() => {
  db.reset();
  seedDemoData();
  db.subWallets.set(SW_ID, subWalletFixture());
});

test('scoreToTier boundaries', () => {
  assert.equal(scoreToTier(0), 'low');
  assert.equal(scoreToTier(20), 'low');
  assert.equal(scoreToTier(21), 'medium');
  assert.equal(scoreToTier(50), 'medium');
  assert.equal(scoreToTier(51), 'high');
  assert.equal(scoreToTier(75), 'high');
  assert.equal(scoreToTier(76), 'critical');
  assert.equal(scoreToTier(100), 'critical');
});

test('factor weights sum to exactly 1.0', () => {
  const assessment = riskService.assessTransactionRisk(
    subWalletFixture(),
    pactFixture(),
    { valueUsd: 100, network: 'base', contractAddress: null, protocol: null },
    simulationFixture(),
    screeningFixture('clean', 'NONE'),
  );
  const weightSum = assessment.factors.reduce((sum, f) => sum + f.weight, 0);
  assert.equal(weightSum, 1);
});

test('clean low-value transaction grades low', () => {
  const assessment = riskService.assessTransactionRisk(
    subWalletFixture(),
    pactFixture(),
    { valueUsd: 20, network: 'base', contractAddress: null, protocol: null },
    simulationFixture(),
    screeningFixture('clean', 'NONE'),
  );
  assert.equal(assessment.tier, 'low');
});

test('REGRESSION: sanctioned destination floors tier at critical regardless of weighted score', () => {
  // Before the fix, the screening factor (25% weight) was structurally always
  // zero when assessment ran, and even with it counted, a sanctioned
  // destination with a small value would grade "medium" - an unacceptable
  // severity statement. The floor makes sanctions always critical.
  const assessment = riskService.assessTransactionRisk(
    subWalletFixture(),
    pactFixture(),
    { valueUsd: 20, network: 'base', contractAddress: null, protocol: null },
    simulationFixture(),
    screeningFixture('flagged', 'SANCTIONED_ADDRESS'),
  );
  assert.equal(assessment.tier, 'critical');
  // The weighted score itself stays honest...
  assert.ok(assessment.overallScore < 76);
});

test('REGRESSION: other screening flags floor tier at high', () => {
  const assessment = riskService.assessTransactionRisk(
    subWalletFixture(),
    pactFixture(),
    { valueUsd: 20, network: 'base', contractAddress: null, protocol: null },
    simulationFixture(),
    screeningFixture('flagged', 'MIXER_LINKED'),
  );
  assert.equal(assessment.tier, 'high');
});


test('updateTrustScore: simulation failure penalizes without polluting policy counters', () => {
  const sw = subWalletFixture();
  const updated = riskService.updateTrustScore(sw, {
    wasExecuted: false,
    hadPolicyViolation: false,
    hadScreeningFlag: false,
    hadQuarantineEvent: false,
    hadSimulationFailure: true,
  });
  assert.equal(updated.simulationFailures, 1);
  assert.equal(updated.policyViolations, 1); // pre-existing fixture count, unchanged
  assert.equal(updated.score, 98);
  assert.equal(updated.cleanAutoExecutes, 23);
});

test('updateTrustScore: clean execute adds bonus; score clamps at 100', () => {
  const sw = subWalletFixture({ trustScore: trustScoreFixture({ score: 100 }) });
  const updated = riskService.updateTrustScore(sw, {
    wasExecuted: true,
    hadPolicyViolation: false,
    hadScreeningFlag: false,
    hadQuarantineEvent: false,
  });
  assert.equal(updated.score, 100);
  assert.equal(updated.cleanAutoExecutes, 24);
});

test('updateTrustScore: legacy record without simulationFailures counter is healed', () => {
  const legacy = subWalletFixture();
  const legacyScore = { ...legacy.trustScore } as Partial<typeof legacy.trustScore>;
  delete (legacyScore as Record<string, number | string | undefined>).simulationFailures;
  const updated = riskService.updateTrustScore({ ...legacy, trustScore: legacyScore as typeof legacy.trustScore }, {
    wasExecuted: false,
    hadPolicyViolation: false,
    hadScreeningFlag: false,
    hadQuarantineEvent: false,
    hadSimulationFailure: true,
  });
  assert.equal(updated.simulationFailures, 1);
});

test('REGRESSION: critical tier reachable via composite factors', () => {
  // Seed a bad history: 50 transactions, 20 denied (>30% denial rate).
  for (let i = 0; i < 20; i++) transactionDao.createOrUpdate(seededTx('denied', 10, 1));
  for (let i = 0; i < 30; i++) transactionDao.createOrUpdate(seededTx('executed', 10, 1));
  // Value over cap + velocity over daily cap + testnet + flagged contract.
  const assessment = riskService.assessTransactionRisk(
    subWalletFixture(),
    pactFixture(),
    { valueUsd: 5000, network: 'sepolia', contractAddress: '0xmalicious0001', protocol: null },
    simulationFixture(),
    screeningFixture('flagged', 'KNOWN_MALICIOUS_CONTRACT'),
  );
  // 25 (value) + 20 (screening 80x0.25) + 13.5 (contract) + 12 (history) + 10 (velocity) + 4 (testnet) = 84.5 -> 85
  assert.equal(assessment.overallScore, 85);
  assert.equal(assessment.tier, 'critical');
});

test('graduation eligibility: clean strict agent is eligible', () => {
  const eligibility = riskService.evaluateGraduationEligibility(subWalletFixture());
  assert.equal(eligibility.eligible, true);
  assert.ok(eligibility.criteria.every((c) => c.met));
});

test('graduation eligibility: bounded_auto agent has nowhere to graduate', () => {
  const eligibility = riskService.evaluateGraduationEligibility(
    subWalletFixture({ autonomyMode: 'bounded_auto' }),
  );
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.criteria.some((c) => c.key === 'current_mode' && !c.met));
});

test('graduation eligibility: screening flag disqualifies', () => {
  const eligibility = riskService.evaluateGraduationEligibility(
    subWalletFixture({ trustScore: trustScoreFixture({ screeningFlags: 1, score: 95 }) }),
  );
  assert.equal(eligibility.eligible, false);
});

test('graduation eligibility: insufficient history disqualifies', () => {
  const eligibility = riskService.evaluateGraduationEligibility(
    subWalletFixture({ trustScore: trustScoreFixture({ totalTransactions: 5, cleanAutoExecutes: 5 }) }),
  );
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.criteria.some((c) => c.key === 'total_transactions' && !c.met));
});

test('graduation eligibility: suspended agent is not a candidate', () => {
  const eligibility = riskService.evaluateGraduationEligibility(
    subWalletFixture({ status: 'suspended' }),
  );
  assert.equal(eligibility.eligible, false);
});

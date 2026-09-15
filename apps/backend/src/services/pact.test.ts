import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Static imports cannot work here: db.ts reads PERSISTENCE_MODE at module
// evaluation time, so the env assignment must execute before any project
// module loads (ESM static imports hoist above it). Deliberate module-loading
// boundary per the test-file exception.
process.env.PERSISTENCE_MODE = 'memory';
// Fully offline: every network fetch throws. Screening degrades deterministically.
globalThis.fetch = (async () => {
  throw new Error('offline test environment');
}) as typeof fetch;

const { db, seedDemoData } = await import('../store/db.js');
const pactService = await import('./pactService.js');
const { transactionDao } = await import('../dal/models/transaction.dao.js');


function makePact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pact_test',
    subWalletId: 'sw_test',
    createdByUserId: 'user_admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedByUserId: 'user_admin',
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
    ...overrides,
  };
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    subWalletId: 'sw_test',
    to: '0x1111111111111111111111111111111111111111',
    valueUsd: 100,
    network: 'base',
    contractAddress: null,
    protocol: null,
    functionDescription: 'transfer',
    ...overrides,
  };
}

/** A committed transaction that counts toward cap math (approved or executed). */
function committedTx(status: 'approved' | 'executed', createdAt: string, valueUsd: number) {
  return {
    id: `tx_${Math.random().toString(36).slice(2)}`,
    subWalletId: 'sw_test',
    enterpriseId: 'ent_demo',
    request: makeRequest({ valueUsd }),
    status,
    simulation: null,
    screening: null,
    policyViolations: [],
    riskAssessment: null,
    gasSponsored: false,
    gasSponsorshipFallbackUsed: false,
    createdAt,
    decidedAt: null,
    executedAt: null,
    approvalRequestId: null,
  };
}

function subWalletFixture() {
  return {
    id: 'sw_test',
    enterpriseId: 'ent_demo',
    agentName: 'Test Agent',
    chain: 'base' as const,
    address: '0xagent123',
    pendingDeployment: false,
    walletFullyCreated: true,
    sessionKeyRef: 'session_test',
    fundingSource: 'allocated_balance' as const,
    allocatedBalanceUsd: 10000,
    drawDownLimitUsd: null,
    autonomyMode: 'bounded_auto' as const,
    status: 'active' as const,
    eip7702Delegated: false,
    pactId: null,
    trustScore: {
      score: 100,
      lastUpdated: new Date().toISOString(),
      totalTransactions: 0,
      cleanAutoExecutes: 0,
      policyViolations: 0,
      screeningFlags: 0,
      quarantineEvents: 0,
      simulationFailures: 0,
    },
    createdByUserId: 'user_admin',
    createdAt: new Date().toISOString(),
    suspendedAt: null,
    suspendedByUserId: null,
    suspendedReason: null,
  };
}

beforeEach(() => {
  db.reset();
  seedDemoData();
  db.subWallets.set('sw_test', subWalletFixture());
});

test('compliant request evaluates clean', () => {
  const result = pactService.evaluate(subWalletFixture(), makePact(), makeRequest());
  assert.equal(result.compliant, true);
  assert.deepEqual(result.violations, []);
});

test('value over per-transaction cap is violated', () => {
  const result = pactService.evaluate(subWalletFixture(), makePact(), makeRequest({ valueUsd: 501 }));
  assert.equal(result.compliant, false);
  assert.equal(result.violations[0].code, 'MAX_TX_VALUE_EXCEEDED');
});

test('committed (approved + executed) spend counts toward daily cap - no queue race', () => {
  const now = Date.now();
  // One approved (queued, not yet executed) + one executed transaction today.
  transactionDao.createOrUpdate(committedTx('approved', new Date(now - 60_000).toISOString(), 1200));
  transactionDao.createOrUpdate(committedTx('executed', new Date(now - 120_000).toISOString(), 500));
  // 1700 committed + 400 candidate > 2000 cap.
  const result = pactService.evaluate(subWalletFixture(), makePact(), makeRequest({ valueUsd: 400 }));
  assert.equal(result.compliant, false);
  assert.ok(result.violations.some((v) => v.code === 'DAILY_CAP_EXCEEDED'));
  // And a candidate that fits: 1700 + 300 <= 2000.
  const fits = pactService.evaluate(subWalletFixture(), makePact(), makeRequest({ valueUsd: 300 }));
  assert.equal(fits.compliant, true);
});

test('spend outside the daily window does not count', () => {
  transactionDao.createOrUpdate(committedTx('executed', new Date(Date.now() - 25 * 3600_000).toISOString(), 1900));
  const result = pactService.evaluate(subWalletFixture(), makePact(), makeRequest({ valueUsd: 400 }));
  assert.equal(result.compliant, true);
});

test('weekly cap enforced independently of daily', () => {
  const now = Date.now();
  // 3 days ago: still inside the weekly window, outside the daily one.
  for (let i = 0; i < 3; i++) {
    transactionDao.createOrUpdate(committedTx('executed', new Date(now - 3 * 24 * 3600_000).toISOString(), 1700));
  }
  const result = pactService.evaluate(subWalletFixture(), makePact(), makeRequest({ valueUsd: 100 }));
  assert.equal(result.compliant, false);
  assert.ok(result.violations.some((v) => v.code === 'WEEKLY_CAP_EXCEEDED'));
  assert.ok(!result.violations.some((v) => v.code === 'DAILY_CAP_EXCEEDED'));
});

test('contract, protocol, network allowlists and destination lists all enforced', () => {
  const pact = makePact({
    contractAllowlist: ['0xcontract1'],
    protocolAllowlist: ['uniswap-v3'],
    networkAllowlist: ['base'],
    destinationAllowlist: ['0xdest1'],
    destinationDenylist: ['0xdest2'],
  });
  const result = pactService.evaluate(
    subWalletFixture(),
    pact,
    makeRequest({
      to: '0xdest2',
      network: 'arbitrum',
      contractAddress: '0xcontract2',
      protocol: 'aave-v3',
    }),
  );
  const codes = result.violations.map((v) => v.code);
  assert.deepEqual(codes.sort(), [
    'CONTRACT_NOT_ALLOWLISTED',
    'DESTINATION_DENYLISTED',
    'DESTINATION_NOT_ALLOWLISTED',
    'NETWORK_NOT_ALLOWLISTED',
    'PROTOCOL_NOT_ALLOWLISTED',
  ]);
});

test('empty allowlists do not restrict; denylisted destination always blocks', () => {
  const pact = makePact({ destinationDenylist: ['0xdest2'] });
  const clean = pactService.evaluate(subWalletFixture(), pact, makeRequest({ to: '0xanything' }));
  assert.equal(clean.compliant, true);
  const denied = pactService.evaluate(subWalletFixture(), pact, makeRequest({ to: '0xdest2' }));
  assert.equal(denied.compliant, false);
});

test('expired session is a violation', () => {
  const pact = makePact({ sessionExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const result = pactService.evaluate(subWalletFixture(), pact, makeRequest());
  assert.equal(result.compliant, false);
  assert.equal(result.violations[0].code, 'SESSION_EXPIRED');
});

test('projectSpend computes ratios for both horizons', () => {
  const now = Date.now();
  transactionDao.createOrUpdate(committedTx('executed', new Date(now - 3600_000).toISOString(), 1000));
  const [daily, weekly] = pactService.projectSpend('sw_test', makePact(), 500);
  assert.equal(daily.horizon, 'daily');
  assert.equal(daily.committedUsd, 1000);
  assert.equal(daily.projectedUsd, 1500);
  assert.equal(daily.capUsd, 2000);
  assert.equal(daily.projectedRatio, 0.75);
  assert.equal(weekly.projectedRatio, 1500 / 5000);
});

test('projectSpend guards degenerate zero caps', () => {
  const [daily] = pactService.projectSpend('sw_test', makePact({ dailySpendCapUsd: 0 }), 500);
  assert.equal(daily.projectedRatio, 0);
  assert.equal(daily.committedRatio, 0);
});

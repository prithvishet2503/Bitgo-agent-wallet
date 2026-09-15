import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyDenialCode, TransactionRecord } from '@bitgo-agent-wallet/shared';

// Static imports cannot work here: db.ts reads PERSISTENCE_MODE at module
// evaluation time, so the env assignment must execute before any project
// module loads (ESM static imports hoist above it). Deliberate module-loading
// boundary per the test-file exception.
process.env.PERSISTENCE_MODE = 'memory';
globalThis.fetch = (async () => {
  throw new Error('offline test environment');
}) as typeof fetch;

const { db, seedDemoData } = await import('../store/db.js');
const approvalService = await import('./approvalService.js');
const { userDao } = await import('../dal/models/user.dao.js');
const transactionService = await import('./transactionService.js');

const ENT = 'ent_demo';
const SW = 'sw_approval';
function txFixture(valueUsd: number, violations: { code: PolicyDenialCode; message: string }[] = []): TransactionRecord {
  return {
    id: `tx_${Math.random().toString(36).slice(2)}`,
    subWalletId: SW,
    enterpriseId: ENT,
    request: {
      subWalletId: SW,
      to: '0x2222222222222222222222222222222222222222',
      valueUsd,
      network: 'base',
      contractAddress: null,
      protocol: null,
      functionDescription: 'transfer',
    },
    status: 'pending_approval',
    simulation: {
      simulatedAt: new Date().toISOString(),
      estimatedFeeUsd: 0.55,
      balanceChanges: [],
      contractInteractions: [],
      willSucceed: true,
      failureReason: null,
    },
    screening: null,
    policyViolations: violations,
    riskAssessment: {
      overallScore: 29,
      tier: 'medium',
      factors: [],
      assessedAt: new Date().toISOString(),
    },
    gasSponsored: false,
    gasSponsorshipFallbackUsed: false,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    executedAt: null,
    approvalRequestId: null,
  };
}

function subWalletFixture() {
  return {
    id: SW,
    enterpriseId: ENT,
    agentName: 'Approval Agent',
    chain: 'base' as const,
    address: '0xagentapproval',
    pendingDeployment: false,
    walletFullyCreated: true,
    sessionKeyRef: 'session_approval',
    fundingSource: 'allocated_balance' as const,
    allocatedBalanceUsd: 100000,
    drawDownLimitUsd: null,
    autonomyMode: 'strict' as const,
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
  db.subWallets.set(SW, subWalletFixture());
});

test('high-value transactions require two approvers', () => {
  const approval = approvalService.createApprovalRequest(txFixture(30_000), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.55,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  assert.equal(approval.requiredApprovals, 2);
  const lowValue = approvalService.createApprovalRequest(txFixture(100), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.55,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  assert.equal(lowValue.requiredApprovals, 1);
});

test('summaryText (Section 12.3) is built from the structured record', () => {
  const approval = approvalService.createApprovalRequest(
    txFixture(700, [{ code: 'MAX_TX_VALUE_EXCEEDED', message: 'over cap' }]),
    subWalletFixture(),
    {
      simulatedAt: new Date().toISOString(),
      estimatedFeeUsd: 0.85,
      balanceChanges: [],
      contractInteractions: [],
      willSucceed: true,
      failureReason: null,
    },
  );
  assert.ok(approval.summaryText.includes('Approval Agent'));
  assert.ok(approval.summaryText.includes('$700'));
  assert.ok(approval.summaryText.includes('MAX_TX_VALUE_EXCEEDED'));
  assert.ok(approval.summaryText.includes('Risk: medium (29/100)'));
  assert.ok(approval.summaryText.includes('$0.55'));
  assert.ok(approval.summaryText.includes('auto-denys in 15 minutes'));
});

test('non-admin/compliance roles cannot decide approvals', () => {
  const approval = approvalService.createApprovalRequest(txFixture(100), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.5,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  const developer = userDao.getByToken('demo-dev-token')!;
  assert.throws(
    () => approvalService.applyDecision(approval, developer, 'approve', null),
    /Only admin\/compliance roles/,
  );
});

test('a single denial immediately denies; unanimous approval required', () => {
  const approval = approvalService.createApprovalRequest(txFixture(30_000), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.5,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  const compliance = userDao.getByToken('demo-compliance-token')!;
  const outcome = approvalService.applyDecision(approval, compliance, 'deny', 'looks wrong');
  assert.equal(outcome.resolution, 'denied');
  assert.equal(approval.status, 'denied');
});

test('approvals accumulate to requiredApprovals; double-approve rejected', () => {
  const approval = approvalService.createApprovalRequest(txFixture(30_000), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.5,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  const admin = userDao.getByToken('demo-admin-token')!;
  const compliance = userDao.getByToken('demo-compliance-token')!;
  const first = approvalService.applyDecision(approval, admin, 'approve', null);
  assert.equal(first.resolution, 'still_pending');
  assert.throws(
    () => approvalService.applyDecision(approval, admin, 'approve', null),
    /already approved/,
  );
  const second = approvalService.applyDecision(approval, compliance, 'approve', null);
  assert.equal(second.resolution, 'approved');
  assert.equal(approval.status, 'approved');
});

test('expired approvals default to deny (not approve)', () => {
  const approval = approvalService.createApprovalRequest(txFixture(100), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.5,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  // Force the timeout into the past.
  const expired = { ...approval, timeoutAt: new Date(Date.now() - 1000).toISOString() };
  approvalService.applyDecision;
  const outcome = approvalService.expireIfTimedOut(expired);
  assert.equal(outcome?.resolution, 'denied');
  assert.equal(expired.status, 'expired');
});

test('decided approvals reject further decisions', () => {
  const approval = approvalService.createApprovalRequest(txFixture(100), subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.5,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  const admin = userDao.getByToken('demo-admin-token')!;
  approvalService.applyDecision(approval, admin, 'approve', null);
  assert.equal(approval.status, 'approved');
  const compliance = userDao.getByToken('demo-compliance-token')!;
  assert.throws(
    () => approvalService.applyDecision(approval, compliance, 'deny', null),
    /already approved/,
  );
});

test('handleApprovalDecision wires denial to trust score and audit log', () => {
  const transaction = txFixture(100);
  db.transactions.set(transaction.id, transaction);
  const approval = approvalService.createApprovalRequest(transaction, subWalletFixture(), {
    simulatedAt: new Date().toISOString(),
    estimatedFeeUsd: 0.5,
    balanceChanges: [],
    contractInteractions: [],
    willSucceed: true,
    failureReason: null,
  });
  const admin = userDao.getByToken('demo-admin-token')!;
  const result = transactionService.handleApprovalDecision(
    { approvalRequestId: approval.id, userId: admin.id, decision: 'deny', reason: 'no' },
    admin,
  );
  assert.equal(result.transaction.status, 'denied');
  assert.ok(db.auditLog.all().some((e) => e.eventType === 'APPROVAL_DENIED'));
});

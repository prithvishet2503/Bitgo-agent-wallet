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
import * as gasSponsorshipService from './gasSponsorshipService.js';
import * as approvalService from './approvalService.js';
import * as sendQueueService from './sendQueueService.js';
import * as auditService from './auditService.js';
import type { Signer } from './signer.js';

/**
 * Orchestrates the full agent-transaction lifecycle described across Sections
 * 6.2-6.5 and 6.10: pre-execution checks -> policy evaluation -> autonomy-mode
 * routing -> (auto-proceed | human approval) -> gas-sponsorship decision ->
 * SendQueue. Mirrors wallet-platform's `send.ts`: everything up through deciding
 * *that* a transaction should go out happens inline in the request; actually
 * signing and broadcasting happens later, off a `SendQueueEntry`
 * (`completeBroadcast`, called by scheduler/sendQueueWorker.ts) - never
 * synchronously inside the HTTP request. Every step is audit-logged (Section 6.8)
 * as it happens.
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

export function submitTransaction(request: TransactionRequestInput, actingUser: User): TransactionRecord {
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

  // Section 6.3 - pre-execution simulation, before anything else can happen.
  const simulation = simulationService.simulate(request);
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
    return record;
  }

  // Section 6.3 - threat/sanctions screening. "Failed screening = hard block, not
  // just a flag" - this overrides autonomy mode entirely, in both directions.
  const screening = screeningService.screenOutgoing(request.to, request.contractAddress);
  record.screening = screening;
  if (screening.verdict === 'flagged') {
    record.status = 'screening_blocked';
    record.decidedAt = nowIso();
    transactionDao.createOrUpdate(record);
    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'TRANSACTION_SCREENING_BLOCKED',
      actorUserId: null,
      actorType: 'system',
      summary: `Transaction hard-blocked by screening: ${screening.reason}`,
      metadata: { transactionId: record.id, screening },
    });
    return record;
  }

  // Section 6.2 - Pact evaluation.
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

  // Section 6.4 - Autonomy Modes.
  // Strict: every transaction pauses for human approval regardless of compliance.
  // Bounded Auto: compliant transactions proceed straight to the SendQueue;
  // out-of-policy transactions escalate to a human rather than being silently
  // allowed or silently dropped.
  const requiresApproval = subWallet.autonomyMode === 'strict' || !evaluation.compliant;

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
    summary: evaluation.compliant
      ? `Approval requested (Strict Mode) for $${request.valueUsd} to ${request.to}`
      : `Approval requested: out-of-policy transaction (${evaluation.violations.map((v) => v.code).join(', ')})`,
    metadata: { transactionId: record.id, approvalRequestId: approval.id, violations: evaluation.violations },
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
 * actually flips to `executed`. Idempotent against re-processing. */
export async function completeBroadcast(id: string, signerImpl: Signer): Promise<void> {
  const record = getTransaction(id);
  if (record.status !== 'approved') return;

  const { signature } = await signerImpl.sign(record.subWalletId, `transfer:${record.request.valueUsd}`);

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

  auditService.record({
    enterpriseId: record.enterpriseId,
    subWalletId: record.subWalletId,
    eventType: 'TRANSACTION_EXECUTED',
    actorUserId: null,
    actorType: 'system',
    summary: `Transaction broadcast and confirmed: $${record.request.valueUsd} to ${record.request.to}`,
    metadata: { transactionId: record.id, signature },
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

/** Section 6.5 - approve/deny a pending request. */
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

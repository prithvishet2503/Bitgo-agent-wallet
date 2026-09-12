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
import { db, type User } from '../store/db.js';
import * as subWalletService from './subWalletService.js';
import * as pactService from './pactService.js';
import * as simulationService from './simulationService.js';
import * as screeningService from './screeningService.js';
import * as gasSponsorshipService from './gasSponsorshipService.js';
import * as approvalService from './approvalService.js';
import * as auditService from './auditService.js';

/**
 * Orchestrates the full agent-transaction lifecycle described across Sections
 * 6.2-6.5 and 6.10: pre-execution checks -> policy evaluation -> autonomy-mode
 * routing -> (auto-execute | human approval) -> gas sponsorship -> execution.
 * Every step is audit-logged (Section 6.8) as it happens.
 */

function newRecordShell(request: TransactionRequestInput, subWallet: { id: string; masterAccountId: string }): TransactionRecord {
  return {
    id: `tx_${randomUUID()}`,
    subWalletId: subWallet.id,
    masterAccountId: subWallet.masterAccountId,
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

function assertSameAccount(masterAccountId: string, actingUser: User): void {
  if (masterAccountId !== actingUser.masterAccountId) {
    throw new ForbiddenError('Cannot act on a resource outside your master account');
  }
}

export function submitTransaction(request: TransactionRequestInput, actingUser: User): TransactionRecord {
  const subWallet = subWalletService.getSubWallet(request.subWalletId);
  assertSameAccount(subWallet.masterAccountId, actingUser);

  const record = newRecordShell(request, subWallet);
  db.transactions.set(record.id, record);

  auditService.record({
    masterAccountId: subWallet.masterAccountId,
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
    auditService.record({
      masterAccountId: subWallet.masterAccountId,
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
    masterAccountId: subWallet.masterAccountId,
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
    return record;
  }

  // Section 6.3 - threat/sanctions screening. "Failed screening = hard block, not
  // just a flag" - this overrides autonomy mode entirely, in both directions.
  const screening = screeningService.screenOutgoing(request.to, request.contractAddress);
  record.screening = screening;
  if (screening.verdict === 'flagged') {
    record.status = 'screening_blocked';
    record.decidedAt = nowIso();
    auditService.record({
      masterAccountId: subWallet.masterAccountId,
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
  // Bounded Auto: compliant transactions auto-execute; out-of-policy transactions
  // escalate to a human rather than being silently allowed or silently dropped.
  const requiresApproval = subWallet.autonomyMode === 'strict' || !evaluation.compliant;

  if (!requiresApproval) {
    finalizeExecution(record, subWallet, pact, { auto: true });
    return record;
  }

  record.status = 'pending_approval';
  const approval = approvalService.createApprovalRequest(record, subWallet, simulation);
  record.approvalRequestId = approval.id;
  auditService.record({
    masterAccountId: subWallet.masterAccountId,
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

function finalizeExecution(
  record: TransactionRecord,
  subWallet: ReturnType<typeof subWalletService.getSubWallet>,
  pact: ReturnType<typeof pactService.getPact>,
  opts: { auto: boolean },
): void {
  // Section 6.10 - gas sponsorship never bypasses simulation/screening (already
  // done above); it only decides who pays, and can still block per Pact config.
  const gasDecision = gasSponsorshipService.decide(subWallet, pact, record.simulation!.estimatedFeeUsd);

  if (gasDecision.reason === 'cap_exceeded_blocked') {
    record.status = 'denied';
    record.decidedAt = nowIso();
    auditService.record({
      masterAccountId: subWallet.masterAccountId,
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
  if (gasDecision.sponsor) {
    gasSponsorshipService.recordSponsorship(subWallet.id, record.id, record.simulation!.estimatedFeeUsd);
    auditService.record({
      masterAccountId: subWallet.masterAccountId,
      subWalletId: subWallet.id,
      eventType: 'GAS_SPONSORSHIP_APPLIED',
      actorUserId: null,
      actorType: 'system',
      summary: `Gas sponsored via EIP-7702 delegation ($${record.simulation!.estimatedFeeUsd})`,
      metadata: { transactionId: record.id },
    });
  }

  record.status = 'executed';
  record.executedAt = nowIso();
  record.decidedAt = record.decidedAt ?? nowIso();

  auditService.record({
    masterAccountId: subWallet.masterAccountId,
    subWalletId: subWallet.id,
    eventType: opts.auto ? 'TRANSACTION_AUTO_EXECUTED' : 'TRANSACTION_EXECUTED',
    actorUserId: null,
    actorType: 'system',
    summary: `Transaction ${opts.auto ? 'auto-' : ''}executed: $${record.request.valueUsd} to ${record.request.to}`,
    metadata: { transactionId: record.id, gasSponsored: record.gasSponsored },
  });
}

export function getTransaction(id: string): TransactionRecord {
  const t = db.transactions.get(id);
  if (!t) throw new NotFoundError(`Transaction ${id} not found`);
  return t;
}

export function listTransactions(masterAccountId: string, subWalletId?: string): TransactionRecord[] {
  return [...db.transactions.values()]
    .filter((t) => t.masterAccountId === masterAccountId)
    .filter((t) => !subWalletId || t.subWalletId === subWalletId)
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
      masterAccountId: approval.masterAccountId,
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
    finalizeExecution(transaction, subWallet, pact, { auto: false });
  } else if (outcome.resolution === 'denied') {
    transaction.status = 'denied';
    transaction.decidedAt = nowIso();
    auditService.record({
      masterAccountId: approval.masterAccountId,
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
  for (const approval of approvalService.listAllPendingAcrossAccounts()) {
    const outcome = approvalService.expireIfTimedOut(approval);
    if (!outcome) continue;

    const transaction = getTransaction(approval.transactionId);
    if (outcome.resolution === 'denied') {
      transaction.status = 'denied';
      transaction.decidedAt = nowIso();
      auditService.record({
        masterAccountId: approval.masterAccountId,
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
      finalizeExecution(transaction, subWallet, pact, { auto: false });
    }
  }
}

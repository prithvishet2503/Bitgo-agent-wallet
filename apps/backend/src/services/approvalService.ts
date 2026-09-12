import { randomUUID } from 'node:crypto';
import {
  type AgentSubWallet,
  type ApprovalChannel,
  type ApprovalRequest,
  type SimulationResult,
  type TransactionRecord,
  DEFAULT_APPROVAL_DEFAULT_ACTION,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  ForbiddenError,
  NotFoundError,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import { db, type User } from '../store/db.js';
import { notify } from '../notifications/channels.js';

/** Section 6.5 - Human Approval Flow. */

/** Transactions at or above this value require a second approver, consistent with
 * "Multi-approver support for high-value transactions" mirroring BitGo's existing
 * multi-sig governance model. */
export const HIGH_VALUE_MULTI_APPROVER_THRESHOLD_USD = 25_000;

const DEFAULT_CHANNELS: ApprovalChannel[] = ['console', 'mobile_push', 'slack'];

export function createApprovalRequest(
  transaction: TransactionRecord,
  subWallet: AgentSubWallet,
  simulation: SimulationResult,
): ApprovalRequest {
  const requiredApprovals = transaction.request.valueUsd >= HIGH_VALUE_MULTI_APPROVER_THRESHOLD_USD ? 2 : 1;
  const approval: ApprovalRequest = {
    id: `approval_${randomUUID()}`,
    transactionId: transaction.id,
    subWalletId: subWallet.id,
    masterAccountId: subWallet.masterAccountId,
    status: 'pending',
    requiredApprovals,
    approvals: [],
    denials: [],
    channelsNotified: DEFAULT_CHANNELS,
    typedPayload: {
      domain: { name: 'BitGo Agent Wallet', version: '1' },
      message: {
        agentSubWalletId: subWallet.id,
        agentName: subWallet.agentName,
        to: transaction.request.to,
        valueUsd: transaction.request.valueUsd,
        network: transaction.request.network,
        contractAddress: transaction.request.contractAddress,
        functionDescription: transaction.request.functionDescription,
        estimatedFeeUsd: simulation.estimatedFeeUsd,
      },
    },
    createdAt: nowIso(),
    timeoutAt: new Date(Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS).toISOString(),
    defaultAction: DEFAULT_APPROVAL_DEFAULT_ACTION,
    resolvedAt: null,
  };
  db.approvalRequests.set(approval.id, approval);
  notify(approval.channelsNotified, approval, subWallet.agentName);
  return approval;
}

export function getApprovalRequest(id: string): ApprovalRequest {
  const a = db.approvalRequests.get(id);
  if (!a) throw new NotFoundError(`Approval request ${id} not found`);
  return a;
}

export function listPending(masterAccountId: string): ApprovalRequest[] {
  return [...db.approvalRequests.values()].filter(
    (a) => a.masterAccountId === masterAccountId && a.status === 'pending',
  );
}

export type ApprovalOutcome =
  | { resolution: 'still_pending' }
  | { resolution: 'approved' }
  | { resolution: 'denied'; reason: string };

/** Applies one approve/deny decision. A single denial immediately denies the
 * transaction (unanimous approval is required); approvals accumulate until
 * `requiredApprovals` is reached. */
export function applyDecision(
  approval: ApprovalRequest,
  actingUser: User,
  decision: 'approve' | 'deny',
  reason: string | null,
): ApprovalOutcome {
  if (approval.status !== 'pending') {
    throw new ForbiddenError(`Approval request ${approval.id} is already ${approval.status}`);
  }
  if (approval.masterAccountId !== actingUser.masterAccountId) {
    throw new ForbiddenError('Cannot decide on an approval request outside your master account');
  }
  if (actingUser.role !== 'admin' && actingUser.role !== 'compliance') {
    throw new ForbiddenError('Only admin/compliance roles can approve or deny agent transactions');
  }

  if (decision === 'deny') {
    approval.denials.push({ userId: actingUser.id, decidedAt: nowIso(), reason });
    approval.status = 'denied';
    approval.resolvedAt = nowIso();
    return { resolution: 'denied', reason: reason ?? `Denied by ${actingUser.name}` };
  }

  if (approval.approvals.some((a) => a.userId === actingUser.id)) {
    throw new ForbiddenError('You have already approved this request');
  }
  approval.approvals.push({ userId: actingUser.id, decidedAt: nowIso() });
  if (approval.approvals.length >= approval.requiredApprovals) {
    approval.status = 'approved';
    approval.resolvedAt = nowIso();
    return { resolution: 'approved' };
  }
  return { resolution: 'still_pending' };
}

/** Section 6.5 - "Configurable approval timeout with default action (default:
 * auto-deny on timeout, not auto-approve)." Called by the timeout sweeper. */
export function expireIfTimedOut(approval: ApprovalRequest): ApprovalOutcome | null {
  if (approval.status !== 'pending') return null;
  if (Date.parse(approval.timeoutAt) > Date.now()) return null;

  if (approval.defaultAction === 'approve') {
    approval.status = 'approved';
    approval.resolvedAt = nowIso();
    return { resolution: 'approved' };
  }
  approval.status = 'expired';
  approval.resolvedAt = nowIso();
  return { resolution: 'denied', reason: 'Approval window expired (default-deny)' };
}

export function listAllPendingAcrossAccounts(): ApprovalRequest[] {
  return [...db.approvalRequests.values()].filter((a) => a.status === 'pending');
}

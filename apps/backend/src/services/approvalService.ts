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
  PERMISSIONS,
  hasPermission,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { approvalDao } from '../dal/models/approval.dao.js';
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
    enterpriseId: subWallet.enterpriseId,
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
    summaryText: buildSummaryText(transaction, subWallet.agentName, requiredApprovals, DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_DEFAULT_ACTION),
  };
  approvalDao.createOrUpdate(approval);
  notify(approval.channelsNotified, approval, subWallet.agentName);
  return approval;
}

/** Section 12.3 (deterministic subset) - plain-language approval summary,
 * template-built from the structured record (violations, risk tier, fee,
 * approver count, timeout, default action) so an auditor can verify every
 * claim against the fields it was derived from. No model output. */
function buildSummaryText(
  transaction: TransactionRecord,
  agentName: string,
  requiredApprovals: number,
  timeoutMs: number,
  defaultAction: 'approve' | 'deny',
): string {
  const req = transaction.request;
  const parts: string[] = [
    `Agent "${agentName}" requests to ${req.functionDescription} $${req.valueUsd} to ${req.to} on ${req.network}.`,
  ];
  if (transaction.policyViolations.length > 0) {
    parts.push(
      `Policy: ${transaction.policyViolations.length} violation(s): ${transaction.policyViolations.map((v) => v.code).join(', ')}.`,
    );
  } else {
    parts.push('Policy: within all pact limits.');
  }
  if (transaction.riskAssessment) {
    parts.push(`Risk: ${transaction.riskAssessment.tier} (${transaction.riskAssessment.overallScore}/100).`);
  }
  if (transaction.simulation) {
    parts.push(`Estimated fee: $${transaction.simulation.estimatedFeeUsd}.`);
  }
  parts.push(
    `Requires ${requiredApprovals} approval${requiredApprovals > 1 ? 's' : ''}; ` +
      `auto-${defaultAction}s in ${Math.round(timeoutMs / 60000)} minutes if undecided.`,
  );
  return parts.join(' ');
}

export function getApprovalRequest(id: string): ApprovalRequest {
  const a = approvalDao.get(id);
  if (!a) throw new NotFoundError(`Approval request ${id} not found`);
  return a;
}

export function listPending(enterpriseId: string): ApprovalRequest[] {
  return approvalDao.list((a) => a.enterpriseId === enterpriseId && a.status === 'pending');
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
  if (!actingUser.accessibleEnterpriseIds.includes(approval.enterpriseId)) {
    throw new ForbiddenError('Cannot decide on an approval request outside an enterprise you have access to');
  }
  if (!hasPermission(actingUser.role, PERMISSIONS.APPROVAL_DECIDE)) {
    throw new ForbiddenError('Only admin/compliance roles can approve or deny agent transactions');
  }

  if (decision === 'deny') {
    approval.denials.push({ userId: actingUser.id, decidedAt: nowIso(), reason });
    approval.status = 'denied';
    approval.resolvedAt = nowIso();
    approvalDao.createOrUpdate(approval);
    return { resolution: 'denied', reason: reason ?? `Denied by ${actingUser.name}` };
  }

  if (approval.approvals.some((a) => a.userId === actingUser.id)) {
    throw new ForbiddenError('You have already approved this request');
  }
  approval.approvals.push({ userId: actingUser.id, decidedAt: nowIso() });
  if (approval.approvals.length >= approval.requiredApprovals) {
    approval.status = 'approved';
    approval.resolvedAt = nowIso();
    approvalDao.createOrUpdate(approval);
    return { resolution: 'approved' };
  }
  approvalDao.createOrUpdate(approval);
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
    approvalDao.createOrUpdate(approval);
    return { resolution: 'approved' };
  }
  approval.status = 'expired';
  approval.resolvedAt = nowIso();
  approvalDao.createOrUpdate(approval);
  return { resolution: 'denied', reason: 'Approval window expired (default-deny)' };
}

export function listAllPendingAcrossEnterprises(): ApprovalRequest[] {
  return approvalDao.list((a) => a.status === 'pending');
}

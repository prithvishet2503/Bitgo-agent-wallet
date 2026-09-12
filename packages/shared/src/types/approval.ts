import { z } from 'zod';

/** Section 6.5 - Human Approval Flow. */
export const ApprovalChannelSchema = z.enum(['console', 'mobile_push', 'slack']); // Telegram/Discord are fast-follow (Section 5.2)
export type ApprovalChannel = z.infer<typeof ApprovalChannelSchema>;

export const ApprovalDefaultActionSchema = z.enum(['deny', 'approve']);
export type ApprovalDefaultAction = z.infer<typeof ApprovalDefaultActionSchema>;

/** Deliberate conservative default distinguishing BitGo from consumer wallets
 * (Section 6.5): deny-on-timeout, not auto-approve. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_APPROVAL_DEFAULT_ACTION: ApprovalDefaultAction = 'deny';

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** EIP-712 typed-data-style payload shown to approvers (Section 6.5 / Section 10.1) -
 * readable fields instead of opaque hex, per the no-blind-signing commitment. */
export const TypedApprovalPayloadSchema = z.object({
  domain: z.object({ name: z.literal('BitGo Agent Wallet'), version: z.literal('1') }),
  message: z.object({
    agentSubWalletId: z.string(),
    agentName: z.string(),
    to: z.string(),
    valueUsd: z.number(),
    network: z.string(),
    contractAddress: z.string().nullable(),
    functionDescription: z.string(),
    estimatedFeeUsd: z.number(),
  }),
});
export type TypedApprovalPayload = z.infer<typeof TypedApprovalPayloadSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  subWalletId: z.string(),
  masterAccountId: z.string(),
  status: ApprovalStatusSchema,
  requiredApprovals: z.number().int().positive().default(1), // multi-approver for high-value tx
  approvals: z.array(z.object({ userId: z.string(), decidedAt: z.string() })).default([]),
  denials: z.array(z.object({ userId: z.string(), decidedAt: z.string(), reason: z.string().nullable() })).default([]),
  channelsNotified: z.array(ApprovalChannelSchema),
  typedPayload: TypedApprovalPayloadSchema,
  createdAt: z.string(),
  timeoutAt: z.string(),
  defaultAction: ApprovalDefaultActionSchema,
  resolvedAt: z.string().nullable().default(null),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionInputSchema = z.object({
  approvalRequestId: z.string(),
  userId: z.string(),
  decision: z.enum(['approve', 'deny']),
  reason: z.string().nullable().default(null),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;

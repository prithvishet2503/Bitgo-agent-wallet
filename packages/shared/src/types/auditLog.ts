import { z } from 'zod';

/** Section 6.8 - Audit & Compliance.
 * Every agent action (attempted and executed), policy decision, approval/denial, and
 * mode change is logged immutably. This enum enumerates every event type produced
 * elsewhere in the system so the log stays exhaustive as features are added. */
export const AuditEventTypeSchema = z.enum([
  'ORGANIZATION_CREATED',
  'ENTERPRISE_CREATED',
  'SUB_WALLET_CREATED',
  'SUB_WALLET_DEPLOYMENT_QUEUED', // SendQueue entry enqueued (wallet_deployment)
  'SUB_WALLET_DEPLOYED', // SendQueue worker completed the (mocked) on-chain deployment
  'SUB_WALLET_SUSPENDED', // Section 6.6 - Emergency Stop
  'PACT_CREATED',
  'PACT_UPDATED',
  'AUTONOMY_MODE_CHANGED',
  'TRANSACTION_SUBMITTED',
  'TRANSACTION_SIMULATED',
  'TRANSACTION_SIMULATION_FAILED', // Section 6.3 - pre-execution simulation predicted a revert
  'TRANSACTION_SCREENING_BLOCKED', // Section 6.3 - screening hard block
  'TRANSACTION_POLICY_DENIED',
  'TRANSACTION_QUEUED_FOR_BROADCAST', // built, signed-and-queued via SendQueue (auto or post-approval)
  'APPROVAL_REQUESTED',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED_DENIED', // deny-on-timeout default firing
  'TRANSACTION_EXECUTED', // SendQueue worker completed the (mocked) broadcast
  'SEND_QUEUE_ENTRY_FAILED',
  'INCOMING_TRANSACTION_RECEIVED',
  'INCOMING_TRANSACTION_FLAGGED',
  'QUARANTINE_RELEASED',
  'GAS_SPONSORSHIP_APPLIED',
  'GAS_SPONSORSHIP_CAP_EXCEEDED',
  'RISK_ASSESSED',
  'TRUST_SCORE_CHANGED',
  'BUDGET_THRESHOLD_APPROACHED', // Section 12.7 - projected spend crossed an alert threshold on a pact cap
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  enterpriseId: z.string(),
  subWalletId: z.string().nullable(),
  eventType: AuditEventTypeSchema,
  actorUserId: z.string().nullable(), // null when the system/agent itself is the actor
  actorType: z.enum(['user', 'agent', 'system']),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogQuerySchema = z.object({
  enterpriseId: z.string(),
  subWalletId: z.string().optional(),
  eventType: AuditEventTypeSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().positive().max(1000).default(100),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

import { z } from 'zod';
import { PolicyDenialCodeSchema } from './pact.js';
import { RiskAssessmentSchema } from './risk.js';

/** Section 6.3 - Pre-Execution Checks: request payload an agent submits. */
export const TransactionRequestInputSchema = z.object({
  subWalletId: z.string(),
  to: z.string(),
  valueUsd: z.number().nonnegative(),
  network: z.string(),
  contractAddress: z.string().nullable().default(null),
  protocol: z.string().nullable().default(null),
  /** Free-form calldata description used for simulation/typed-data display; this
   * prototype does not encode real ABI calldata. */
  functionDescription: z.string().default('transfer'),
  idempotencyKey: z.string().optional(),
});
export type TransactionRequestInput = z.infer<typeof TransactionRequestInputSchema>;

export const TransactionStatusSchema = z.enum([
  'simulation_failed', // Section 6.3 - simulation predicts the tx would revert; hard block
  'screening_blocked', // Section 6.3 - failed screening = hard block
  'policy_denied', // Section 6.2 - Pact violation treated as a hard gate (sub-wallet suspended, gas cap w/ block-on-exceed)
  'pending_approval', // Section 6.5 - awaiting human approval
  'approved', // approved, queued for execution
  'denied', // explicitly denied by an approver, or denied on timeout (Section 6.5 default)
  'executed', // Section 6.4 - Bounded Auto auto-execution, or post-approval execution
  'expired', // approval window elapsed with default-deny action
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

/** Section 6.3 - balance/state change preview shown before signature. */
export const SimulationResultSchema = z.object({
  simulatedAt: z.string(),
  estimatedFeeUsd: z.number().nonnegative(),
  balanceChanges: z.array(
    z.object({ asset: z.string(), deltaUsd: z.number() }),
  ),
  contractInteractions: z.array(z.string()),
  willSucceed: z.boolean(),
  failureReason: z.string().nullable().default(null),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;

/** Section 6.3 / 6.9 - threat & sanctions screening result, shared by outgoing
 * (6.3) and incoming (6.9) screening since both use "the same vendor/engine". */
export const ScreeningVerdictSchema = z.enum(['clean', 'flagged']);
export type ScreeningVerdict = z.infer<typeof ScreeningVerdictSchema>;

export const ScreeningReasonSchema = z.enum([
  'SANCTIONED_ADDRESS',
  'KNOWN_MALICIOUS_CONTRACT',
  'MIXER_LINKED',
  'ILLICIT_SOURCE',
  /** SCREENING_FAIL_MODE=closed: the threat-intel vendor was unreachable, so
   * the transaction is held (flagged) rather than allowed through unscreened.
   * Not an assertion about the address - retry once the vendor recovers. */
  'SCREENING_UNAVAILABLE',
  'NONE',
]);
export type ScreeningReason = z.infer<typeof ScreeningReasonSchema>;

export const ScreeningResultSchema = z.object({
  screenedAt: z.string(),
  verdict: ScreeningVerdictSchema,
  reason: ScreeningReasonSchema,
  vendor: z.string(), // e.g. "mock-blockaid"
});
export type ScreeningResult = z.infer<typeof ScreeningResultSchema>;

/** Section 6.3-6.5 - Full transaction record with pre-execution checks, risk
 * assessment, and execution status. riskAssessment is populated by the
 * risk-grading engine (Section 5.2 fast-follow / Section 12.4/12.9). */
export const TransactionRecordSchema = z.object({
  id: z.string(),
  subWalletId: z.string(),
  enterpriseId: z.string(),
  request: TransactionRequestInputSchema,
  status: TransactionStatusSchema,
  simulation: SimulationResultSchema.nullable().default(null),
  screening: ScreeningResultSchema.nullable().default(null),
  policyViolations: z.array(
    z.object({ code: PolicyDenialCodeSchema, message: z.string() }),
  ).default([]),
  /** Section 5.2 / 12.9 - Risk-grading assessment produced during the
   * pre-execution pipeline. Null when risk assessment hasn't been run (e.g.
   * very old transactions from before the engine was added). */
  riskAssessment: RiskAssessmentSchema.nullable().default(null),
  gasSponsored: z.boolean().default(false),
  gasSponsorshipFallbackUsed: z.boolean().default(false),
  createdAt: z.string(),
  decidedAt: z.string().nullable().default(null),
  executedAt: z.string().nullable().default(null),
  approvalRequestId: z.string().nullable().default(null),
});
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;

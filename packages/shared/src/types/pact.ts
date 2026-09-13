import { z } from 'zod';

/** Section 6.2 - Policy / Pact Engine.
 * A Pact is the task-scoped rule set attached to a single agent sub-wallet.
 * Conceptually implemented as an ERC-7710 Delegation Manager grant (Section 10.1) -
 * this shape is the backend/off-chain mirror of that onchain delegation. */
export const PactSchema = z.object({
  id: z.string(),
  subWalletId: z.string(),
  maxTransactionValueUsd: z.number().nonnegative(),
  dailySpendCapUsd: z.number().nonnegative(),
  weeklySpendCapUsd: z.number().nonnegative(),
  contractAllowlist: z.array(z.string()).default([]), // empty = no contract restriction beyond network/destination rules
  protocolAllowlist: z.array(z.string()).default([]), // e.g. "uniswap-v3", "aave-v3"
  networkAllowlist: z.array(z.string()).default([]),
  destinationAllowlist: z.array(z.string()).default([]),
  destinationDenylist: z.array(z.string()).default([]),
  sessionExpiresAt: z.string().nullable(), // ISO timestamp; null = no expiry
  gasSponsorshipCapUsdPerTx: z.number().nonnegative().nullable().default(null),
  gasSponsorshipCapUsdPerDay: z.number().nonnegative().nullable().default(null),
  gasSponsorshipFallback: z.enum(['own_balance', 'block']).default('own_balance'),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedByUserId: z.string(),
});
export type Pact = z.infer<typeof PactSchema>;

export const CreatePactInputSchema = PactSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  updatedByUserId: true,
  createdByUserId: true,
});
export type CreatePactInput = z.infer<typeof CreatePactInputSchema>;

export const UpdatePactInputSchema = CreatePactInputSchema.partial().extend({
  subWalletId: z.string(),
});
export type UpdatePactInput = z.infer<typeof UpdatePactInputSchema>;

/** Structured, machine-readable denial reason returned to the agent so it can retry
 * within scope (Section 6.2 - "matching Cobo's retry-feedback pattern"). */
export const PolicyDenialCodeSchema = z.enum([
  'MAX_TX_VALUE_EXCEEDED',
  'DAILY_CAP_EXCEEDED',
  'WEEKLY_CAP_EXCEEDED',
  'CONTRACT_NOT_ALLOWLISTED',
  'PROTOCOL_NOT_ALLOWLISTED',
  'NETWORK_NOT_ALLOWLISTED',
  'DESTINATION_DENYLISTED',
  'DESTINATION_NOT_ALLOWLISTED',
  'SESSION_EXPIRED',
  'SUB_WALLET_SUSPENDED',
  'SUB_WALLET_NOT_DEPLOYED',
]);
export type PolicyDenialCode = z.infer<typeof PolicyDenialCodeSchema>;

export interface PolicyEvaluation {
  compliant: boolean;
  violations: Array<{ code: PolicyDenialCode; message: string }>;
}

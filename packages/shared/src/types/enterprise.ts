import { z } from 'zod';

/** Recommended starting cap of agent sub-wallets per Enterprise (Section 6.1;
 * matching enterprise scale needs without over-indexing on OKX's 50). */
export const DEFAULT_MAX_SUB_WALLETS_PER_ENTERPRISE = 25;

export const EnterpriseStatusSchema = z.enum(['active', 'suspended']);
export type EnterpriseStatus = z.infer<typeof EnterpriseStatusSchema>;

/**
 * An Enterprise is what the rest of the PRD calls a "master account" - the
 * institutional account an agent sub-wallet (Section 6.1) is nested under. It
 * belongs to exactly one Organization (`@ManyToOne` in BitGo's real
 * `EnterpriseEntity`), and an Organization can have more than one - e.g. separate
 * legal entities or business units each with their own agent sub-wallets, Pacts,
 * and audit trail.
 */
export const EnterpriseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().min(1).max(200),
  status: EnterpriseStatusSchema,
  maxSubWallets: z.number().int().positive(),
  createdAt: z.string(),
});
export type Enterprise = z.infer<typeof EnterpriseSchema>;

export const CreateEnterpriseInputSchema = z.object({
  organizationId: z.string(),
  name: z.string().min(1).max(200),
  maxSubWallets: z.number().int().positive().default(DEFAULT_MAX_SUB_WALLETS_PER_ENTERPRISE),
});
/** Post-parse shape (maxSubWallets always present once zod applies its default) -
 * what service/route code works with. */
export type CreateEnterpriseInput = z.infer<typeof CreateEnterpriseInputSchema>;
/** Pre-parse shape (maxSubWallets optional) - what SDK/CLI callers pass in. */
export type CreateEnterpriseRequestInput = z.input<typeof CreateEnterpriseInputSchema>;

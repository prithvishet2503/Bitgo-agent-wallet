import { z } from 'zod';

/**
 * Organization -> Enterprise -> (Agent Sub-)Wallet hierarchy, mirroring BitGo's
 * real user-management-service model: `OrganizationEntity` sits above
 * `EnterpriseEntity` (`@ManyToOne` Organization), and wallets are permissioned
 * resources scoped to an Enterprise. An Organization is the top-level tenant - one
 * customer signing up for BitGo Agent Wallet - that can contain multiple
 * Enterprises (e.g. separate business units or fund entities), each with its own
 * agent sub-wallets, Pacts, and audit trail.
 */
export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  createdAt: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * "Sign up my institution" - creates an Organization, a first Enterprise under it,
 * and a first admin User in one call. BitGo's real UMS does not expose a public
 * create-enterprise endpoint (identity is lazily materialized from wallet-platform,
 * which owns KYC/onboarding); this prototype has no separate identity source of
 * truth, so it exposes bootstrap explicitly instead.
 */
export const CreateOrganizationInputSchema = z.object({
  organizationName: z.string().min(1).max(200),
  enterpriseName: z.string().min(1).max(200),
  adminName: z.string().min(1).max(200),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationInputSchema>;

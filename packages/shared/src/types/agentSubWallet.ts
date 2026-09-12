import { z } from 'zod';
import { AutonomyModeSchema } from './autonomy.js';
import { SupportedChainSchema } from './common.js';

/** Section 6.1 - Agent Sub-Wallet Creation.
 * A distinct wallet type scoped to a single agent identity, with its own keys/session,
 * nested under an Enterprise. Built as an ERC-7579 modular smart account
 * (Section 10.1) with an EIP-7702 delegation for gas sponsorship (Section 6.10).
 */
export const SubWalletStatusSchema = z.enum(['active', 'suspended']);
export type SubWalletStatus = z.infer<typeof SubWalletStatusSchema>;

export const FundingSourceSchema = z.enum(['allocated_balance', 'draw_down']);
export type FundingSource = z.infer<typeof FundingSourceSchema>;

export const AgentSubWalletSchema = z.object({
  id: z.string(),
  enterpriseId: z.string(),
  agentName: z.string().min(1).max(128),
  chain: SupportedChainSchema,
  /** Address of the ERC-7579 smart account this sub-wallet controls. Null until
   * `SendQueueEntry` of type `wallet_deployment` completes (mirrors
   * wallet-platform's `coinSpecific.<chain>.pendingDeployment` pattern) - mocked in
   * this prototype, not a real on-chain deployment. */
  address: z.string().nullable(),
  /** True from creation until the deployment SendQueue entry resolves. Mirrors
   * wallet-platform's per-chain `pendingDeployment` flag, which prevents
   * double-deploy races via an atomic findOneAndUpdate; here the SendQueue worker
   * plays that idempotent-completion role instead. */
  pendingDeployment: z.boolean().default(true),
  /** Only true once deployment has completed - mirrors wallet-platform's
   * `walletFullyCreated`, which is set true only after address creation
   * completes, so partial-state reads can be distinguished from ready wallets. */
  walletFullyCreated: z.boolean().default(false),
  /** Scoped, time-bound session key identifier - never a full custody key
   * (Section 7 - Security). The underlying MPC/HSM key material is out of scope
   * for this prototype and is represented only by this opaque reference. */
  sessionKeyRef: z.string(),
  fundingSource: FundingSourceSchema,
  allocatedBalanceUsd: z.number().nonnegative().default(0),
  drawDownLimitUsd: z.number().nonnegative().nullable().default(null),
  autonomyMode: AutonomyModeSchema,
  status: SubWalletStatusSchema,
  /** EIP-7702 delegation to BitGo's audited paymaster/delegator contract
   * (Section 6.10). Undelegated sub-wallets pay their own gas. */
  eip7702Delegated: z.boolean().default(false),
  pactId: z.string().nullable(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  suspendedAt: z.string().nullable().default(null),
  suspendedByUserId: z.string().nullable().default(null),
  suspendedReason: z.string().nullable().default(null),
});
export type AgentSubWallet = z.infer<typeof AgentSubWalletSchema>;

export const CreateAgentSubWalletInputSchema = z.object({
  enterpriseId: z.string(),
  agentName: z.string().min(1).max(128),
  chain: SupportedChainSchema,
  fundingSource: FundingSourceSchema,
  allocatedBalanceUsd: z.number().nonnegative().default(0),
  drawDownLimitUsd: z.number().nonnegative().nullable().default(null),
  autonomyMode: AutonomyModeSchema.default('strict'),
});
export type CreateAgentSubWalletInput = z.infer<typeof CreateAgentSubWalletInputSchema>;

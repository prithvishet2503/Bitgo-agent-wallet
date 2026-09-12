import { z } from 'zod';

/**
 * Mirrors wallet-platform's `SendQueue` pattern: chain-touching work (deploying a
 * wallet's smart-contract account, broadcasting a signed transaction) is never
 * done synchronously inside the HTTP request that triggers it. The request
 * validates, builds, and enqueues a `SendQueueEntry`; a background worker
 * (apps/backend/src/scheduler/sendQueueWorker.ts, standing in for BitGo's
 * `SendQueueKafkaWorker`) dequeues it, signs via the `Signer` interface
 * (services/signer.ts, mirroring `SingleSigKmsProvider`), and "broadcasts"
 * (mocked) - only then does the underlying sub-wallet/transaction flip to its
 * final on-chain state.
 */
export const SendQueueEntryTypeSchema = z.enum(['wallet_deployment', 'transaction_broadcast']);
export type SendQueueEntryType = z.infer<typeof SendQueueEntryTypeSchema>;

export const SendQueueStatusSchema = z.enum(['queued', 'processing', 'completed', 'failed']);
export type SendQueueStatus = z.infer<typeof SendQueueStatusSchema>;

export const SendQueueEntrySchema = z.object({
  id: z.string(),
  enterpriseId: z.string(),
  subWalletId: z.string(),
  entryType: SendQueueEntryTypeSchema,
  /** The entity this entry resolves: the sub-wallet id for `wallet_deployment`,
   * or the transaction id for `transaction_broadcast`. */
  relatedId: z.string(),
  status: SendQueueStatusSchema,
  createdAt: z.string(),
  processedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type SendQueueEntry = z.infer<typeof SendQueueEntrySchema>;

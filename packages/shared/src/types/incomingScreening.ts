import { z } from 'zod';
import { ScreeningReasonSchema } from './transaction.js';

/** Section 6.9 - Incoming Transaction Screening.
 * Unlike outgoing transactions, incoming transfers cannot be pre-screened - screening
 * happens immediately after on-chain confirmation. Flagged funds are quarantined:
 * excluded from spendable balance but still visible, until compliance/admin release. */
export const QuarantineStatusSchema = z.enum(['quarantined', 'released', 'rejected']);
export type QuarantineStatus = z.infer<typeof QuarantineStatusSchema>;

export const IncomingTransactionSchema = z.object({
  id: z.string(),
  subWalletId: z.string(),
  enterpriseId: z.string(),
  fromAddress: z.string(),
  valueUsd: z.number().nonnegative(),
  network: z.string(),
  confirmedAt: z.string(),
  screeningVerdict: z.enum(['clean', 'flagged']),
  screeningReason: ScreeningReasonSchema,
  quarantine: z
    .object({
      status: QuarantineStatusSchema,
      quarantinedAt: z.string(),
      releasedAt: z.string().nullable().default(null),
      releasedByUserId: z.string().nullable().default(null),
      releaseNote: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type IncomingTransaction = z.infer<typeof IncomingTransactionSchema>;

export const SimulateIncomingTransactionInputSchema = z.object({
  subWalletId: z.string(),
  fromAddress: z.string(),
  valueUsd: z.number().nonnegative(),
  network: z.string(),
});
export type SimulateIncomingTransactionInput = z.infer<typeof SimulateIncomingTransactionInputSchema>;

export const ReleaseQuarantineInputSchema = z.object({
  incomingTransactionId: z.string(),
  releasedByUserId: z.string(),
  note: z.string().nullable().default(null),
});
export type ReleaseQuarantineInput = z.infer<typeof ReleaseQuarantineInputSchema>;

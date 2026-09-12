import { z } from 'zod';

/** Section 6.10 - Gas Sponsorship via EIP-7702.
 * Tracks cumulative sponsored gas per sub-wallet so Pact caps (per-tx and
 * daily/weekly) can be enforced. Sponsorship never bypasses simulation/screening -
 * it only determines who pays, decided after policy + screening pass. */
export const GasSponsorshipLedgerEntrySchema = z.object({
  id: z.string(),
  subWalletId: z.string(),
  transactionId: z.string(),
  amountUsd: z.number().nonnegative(),
  timestamp: z.string(),
});
export type GasSponsorshipLedgerEntry = z.infer<typeof GasSponsorshipLedgerEntrySchema>;

export interface GasSponsorshipDecision {
  sponsor: boolean;
  fallbackUsed: boolean;
  reason: 'sponsored' | 'cap_exceeded_fallback_own_balance' | 'cap_exceeded_blocked' | 'not_delegated';
}

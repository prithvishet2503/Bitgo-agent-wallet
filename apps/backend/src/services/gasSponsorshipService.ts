import { randomUUID } from 'node:crypto';
import type { AgentSubWallet, GasSponsorshipDecision, Pact } from '@bitgo-agent-wallet/shared';
import { nowIso } from '@bitgo-agent-wallet/shared';
import { db } from '../store/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Section 6.10 - Gas Sponsorship via EIP-7702.
 * "Gas sponsorship is not unconditional. Each Pact includes a sponsorship cap...
 * Transactions exceeding the cap either fall back to the sub-wallet's own funded
 * balance (if available) or are blocked, per policy configuration."
 *
 * Sponsorship is decided strictly after simulation + screening pass, and only
 * determines who pays - never whether the transaction is permitted at all
 * (that remains the Pact engine's job).
 */
function sponsoredSpendSince(subWalletId: string, sinceMs: number): number {
  return db.gasSponsorshipLedger
    .filter((e) => e.subWalletId === subWalletId)
    .filter((e) => Date.parse(e.timestamp) >= sinceMs)
    .reduce((sum, e) => sum + e.amountUsd, 0);
}

export function decide(subWallet: AgentSubWallet, pact: Pact, estimatedFeeUsd: number): GasSponsorshipDecision {
  if (!subWallet.eip7702Delegated) {
    return { sponsor: false, fallbackUsed: false, reason: 'not_delegated' };
  }

  const perTxCap = pact.gasSponsorshipCapUsdPerTx;
  const dailyCap = pact.gasSponsorshipCapUsdPerDay;

  const withinPerTxCap = perTxCap === null || estimatedFeeUsd <= perTxCap;
  const dailySpend = sponsoredSpendSince(subWallet.id, Date.now() - DAY_MS);
  const withinDailyCap = dailyCap === null || dailySpend + estimatedFeeUsd <= dailyCap;

  if (withinPerTxCap && withinDailyCap) {
    return { sponsor: true, fallbackUsed: false, reason: 'sponsored' };
  }

  if (pact.gasSponsorshipFallback === 'own_balance') {
    return { sponsor: false, fallbackUsed: true, reason: 'cap_exceeded_fallback_own_balance' };
  }
  return { sponsor: false, fallbackUsed: false, reason: 'cap_exceeded_blocked' };
}

export function recordSponsorship(subWalletId: string, transactionId: string, amountUsd: number): void {
  db.gasSponsorshipLedger.push({
    id: `gasledger_${randomUUID()}`,
    subWalletId,
    transactionId,
    amountUsd,
    timestamp: nowIso(),
  });
}

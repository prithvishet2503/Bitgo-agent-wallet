import { type ScreeningReason, type ScreeningResult, type ScreeningVerdict, nowIso } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.3 / 6.9 - Threat & sanctions screening.
 *
 * Stands in for a licensed vendor (Blockaid, Chainalysis, or BitGo's existing
 * compliance vendor - Section 11 open question "build vs. license"). Both outgoing
 * pre-execution screening (6.3) and incoming screening (6.9) call this same module,
 * matching the PRD's "same vendor/engine used for outgoing screening" requirement.
 *
 * The mock watchlists below are seed data for the demo, not a real threat feed.
 */
const SANCTIONED_ADDRESSES = new Set(['0xsanctioned0001', '0xsanctioned0002']);
const MALICIOUS_CONTRACTS = new Set(['0xmalicious0001', '0xmalicious0002']);
const MIXER_LINKED_ADDRESSES = new Set(['0xmixerlinked0001']);

export interface ScreenTargetInput {
  address: string;
  vendor?: string;
}

export function screen({ address, vendor = 'mock-blockaid' }: ScreenTargetInput): ScreeningResult {
  const normalized = address.toLowerCase();
  let verdict: ScreeningVerdict = 'clean';
  let reason: ScreeningReason = 'NONE';

  if (SANCTIONED_ADDRESSES.has(normalized)) {
    verdict = 'flagged';
    reason = 'SANCTIONED_ADDRESS';
  } else if (MALICIOUS_CONTRACTS.has(normalized)) {
    verdict = 'flagged';
    reason = 'KNOWN_MALICIOUS_CONTRACT';
  } else if (MIXER_LINKED_ADDRESSES.has(normalized)) {
    verdict = 'flagged';
    reason = 'MIXER_LINKED';
  }

  return { screenedAt: nowIso(), verdict, reason, vendor };
}

/** Screens both the destination and, if present, the contract being interacted with.
 * Failed screening on either target is a hard block (Section 6.3). */
export function screenOutgoing(to: string, contractAddress: string | null): ScreeningResult {
  const toResult = screen({ address: to });
  if (toResult.verdict === 'flagged') return toResult;
  if (contractAddress) {
    const contractResult = screen({ address: contractAddress });
    if (contractResult.verdict === 'flagged') return contractResult;
  }
  return toResult;
}

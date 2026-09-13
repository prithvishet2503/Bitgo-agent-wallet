import { type ScreeningReason, type ScreeningResult, type ScreeningVerdict, nowIso } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.3 / 6.9 - Threat & sanctions screening.
 *
 * Sanctioned-address checks use a real, free, public data source - the
 * community-maintained OFAC SDN crypto-address feed
 * (github.com/0xB10C/ofac-sanctioned-digital-currency-addresses), refreshed
 * periodically. This is a genuine step up from a fabricated demo list, but it
 * is still not a paid vendor (Blockaid/Chainalysis/TRM - Section 11 open
 * question "build vs. license"): those add malicious-contract and
 * mixer-linkage detection this free feed doesn't cover, which stay as small
 * curated demo sets below. Both outgoing pre-execution screening (6.3) and
 * incoming screening (6.9) call this same module, matching the PRD's "same
 * vendor/engine used for outgoing screening" requirement.
 */
const OFAC_ETH_LIST_URL =
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// A snapshot of real entries from the live OFAC feed (captured 2026-09-13),
// kept as a fallback if that feed is unreachable (offline dev, GitHub down) so
// screening still works - degraded, not broken - and as a fixed floor so
// tests/demos don't depend on network access.
const FALLBACK_SNAPSHOT = [
  '0x0330070fd38ec3bb94f58fa55d40368271e9e54a',
  '0x038989cbb1710c72b9920dc4fa529158f463e72c',
  '0x04dba1194ee10112fe6c3207c0687def0e78bacf',
  '0x08723392ed15743cc38513c4925f5e6be5c17243',
  '0x08b2efdcdb8822efe5ad0eae55517cf5dc544251',
  '0x0931ca4d13bb4ba75d9b7132ab690265d749a5e7',
];

// Kept alongside the real feed so the demo flow described in the README
// (`0xsanctioned0001`, etc.) keeps working without memorizing a real address.
const DEMO_TEST_ADDRESSES = new Set(['0xsanctioned0001', '0xsanctioned0002']);
const MALICIOUS_CONTRACTS = new Set(['0xmalicious0001', '0xmalicious0002']);
const MIXER_LINKED_ADDRESSES = new Set(['0xmixerlinked0001']);

let sanctionedAddresses = new Set(FALLBACK_SNAPSHOT.map((a) => a.toLowerCase()));
let lastRefreshedAt: string | null = null;
let lastRefreshError: string | null = null;
let usingFallback = true;

async function refreshSanctionsList(): Promise<void> {
  try {
    const res = await fetch(OFAC_ETH_LIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const addresses = (await res.json()) as unknown;
    if (!Array.isArray(addresses)) throw new Error('unexpected response shape (not an array)');
    sanctionedAddresses = new Set(addresses.map((a) => String(a).toLowerCase()));
    lastRefreshedAt = nowIso();
    lastRefreshError = null;
    usingFallback = false;
    // eslint-disable-next-line no-console
    console.log(`[screeningService] Refreshed OFAC sanctioned-address list: ${sanctionedAddresses.size} addresses`);
  } catch (err) {
    lastRefreshError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `[screeningService] Failed to refresh OFAC list (${lastRefreshError}) - using ${usingFallback ? 'built-in fallback snapshot' : 'last successfully fetched list'} (${sanctionedAddresses.size} addresses)`,
    );
  }
}

// Fire-and-forget on module load; the first few screens may run against the
// fallback snapshot until this resolves. Then refresh periodically so a
// long-running backend picks up newly sanctioned addresses without a restart.
void refreshSanctionsList();
const refreshTimer = setInterval(() => void refreshSanctionsList(), REFRESH_INTERVAL_MS);
refreshTimer.unref();

export interface SanctionsListStatus {
  count: number;
  lastRefreshedAt: string | null;
  lastRefreshError: string | null;
  usingFallback: boolean;
  source: string;
}

export function getSanctionsListStatus(): SanctionsListStatus {
  return { count: sanctionedAddresses.size, lastRefreshedAt, lastRefreshError, usingFallback, source: OFAC_ETH_LIST_URL };
}

export interface ScreenTargetInput {
  address: string;
  vendor?: string;
}

export function screen({ address, vendor = 'ofac-sdn-feed+mock-blockaid' }: ScreenTargetInput): ScreeningResult {
  const normalized = address.toLowerCase();
  let verdict: ScreeningVerdict = 'clean';
  let reason: ScreeningReason = 'NONE';

  if (sanctionedAddresses.has(normalized) || DEMO_TEST_ADDRESSES.has(normalized)) {
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

import { type ScreeningReason, type ScreeningResult, type ScreeningVerdict, nowIso } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.3 / 6.9 - Threat & sanctions screening.
 *
 * Two real, free, public data sources, neither requiring an API key or
 * signup - a genuine step up from a fabricated demo list, though still not a
 * paid vendor (Blockaid/Chainalysis/TRM - Section 11 open question "build vs.
 * license"):
 *
 * - **Sanctions**: the community-maintained OFAC SDN crypto-address feed
 *   (github.com/0xB10C/ofac-sanctioned-digital-currency-addresses), fetched
 *   in bulk and refreshed periodically.
 * - **Malicious contracts / mixers / stolen-funds**: GoPlus Security's free
 *   `address_security` API (gopluslabs.io - the same threat-intel API used by
 *   several production wallets), queried live per address. It aggregates
 *   real security-firm data (e.g. SlowMist, BlockSec) - verified against a
 *   known real-world case (the Ronin bridge exploiter address correctly
 *   comes back flagged for `stealing_attack`/`sanctioned`/`blacklist_doubt`).
 *
 * Both outgoing pre-execution screening (6.3) and incoming screening (6.9)
 * call this same module, matching the PRD's "same vendor/engine used for
 * outgoing screening" requirement.
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

// Kept alongside the real feeds so the demo flow described in the README
// (`0xsanctioned0001`, etc.) keeps working without memorizing a real address.
const DEMO_TEST_ADDRESSES = new Set(['0xsanctioned0001', '0xsanctioned0002']);
const DEMO_MALICIOUS_CONTRACTS = new Set(['0xmalicious0001', '0xmalicious0002']);
const DEMO_MIXER_LINKED_ADDRESSES = new Set(['0xmixerlinked0001']);

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

// --- GoPlus Security (malicious contracts, mixers, stealing/phishing) ---

const GOPLUS_ADDRESS_SECURITY_URL = 'https://api.gopluslabs.io/api/v1/address_security';
const GOPLUS_TIMEOUT_MS = 3000;

/** Fail-open vs fail-closed when the threat-intel vendor is unreachable
 * (Section 6.3 / PRD positioning: "deploy without a compliance exception").
 * `closed` (default): an unreachable vendor holds the transaction
 * (verdict flagged, reason SCREENING_UNAVAILABLE - retryable once the vendor
 * recovers; the OFAC feed and curated lists still apply regardless). `open`:
 * the previous behavior - vendor outage degrades to "this vendor found
 * nothing". An institution that can tolerate unscreened traffic during an
 * outage can opt into `open` explicitly. */
const SCREENING_FAIL_MODE = process.env.SCREENING_FAIL_MODE === 'open' ? 'open' : 'closed';

/** Our own network vocabulary -> GoPlus chain id. GoPlus's threat intel is
 * populated from real-world (mainnet) activity, so an unrecognized/testnet
 * network still checks against Ethereum mainnet reputation (address
 * identity/history is a real-world concern independent of which chain a demo
 * sub-wallet happens to be deployed on). */
const NETWORK_TO_GOPLUS_CHAIN_ID: Record<string, string> = {
  'ethereum-mainnet': '1',
  base: '8453',
  optimism: '10',
  arbitrum: '42161',
};

interface GoPlusAddressSecurityResult {
  data_source?: string;
  [flag: string]: string | undefined;
}

let goPlusLastCheckedAt: string | null = null;
let goPlusLastError: string | null = null;

/** Priority-ordered: the first matching category wins, since ScreeningResult
 * carries one reason. Sanctions take precedence (compliance cares most),
 * then active-theft/malicious-contract signals, then mixer linkage, then
 * general illicit-finance signals. */
function classifyGoPlusResult(result: GoPlusAddressSecurityResult): ScreeningReason | null {
  const flagged = (key: string): boolean => result[key] === '1';

  if (flagged('sanctioned')) return 'SANCTIONED_ADDRESS';
  if (
    flagged('stealing_attack') ||
    flagged('phishing_activities') ||
    flagged('blackmail_activities') ||
    flagged('honeypot_related_address') ||
    flagged('fake_token') ||
    flagged('fake_standard_interface') ||
    flagged('cybercrime') ||
    flagged('darkweb_transactions') ||
    flagged('blacklist_doubt') ||
    Number(result.number_of_malicious_contracts_created ?? '0') > 0
  ) {
    return 'KNOWN_MALICIOUS_CONTRACT';
  }
  if (flagged('mixer')) return 'MIXER_LINKED';
  if (
    flagged('money_laundering') ||
    flagged('financial_crime') ||
    flagged('fake_kyc') ||
    flagged('gas_abuse') ||
    flagged('malicious_mining_activities') ||
    flagged('reinit')
  ) {
    return 'ILLICIT_SOURCE';
  }
  return null;
}

/** Returns a reason if GoPlus flags the address, `null` if it doesn't, or
 * `'VENDOR_UNAVAILABLE'` when the lookup itself failed. Never throws; the
 * caller (`screen`) decides fail-open vs fail-closed via SCREENING_FAIL_MODE. */
async function checkGoPlusAddressSecurity(
  address: string,
  chainId: string,
): Promise<ScreeningReason | null | 'VENDOR_UNAVAILABLE'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOPLUS_TIMEOUT_MS);
  try {
    const res = await fetch(`${GOPLUS_ADDRESS_SECURITY_URL}/${address}?chain_id=${chainId}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { code?: number; result?: GoPlusAddressSecurityResult };
    if (body.code !== 1 || !body.result) throw new Error(`unexpected response (code=${body.code})`);

    goPlusLastCheckedAt = nowIso();
    goPlusLastError = null;
    return classifyGoPlusResult(body.result);
  } catch (err) {
    goPlusLastError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[screeningService] GoPlus lookup failed for ${address} (chain ${chainId}): ${goPlusLastError}`);
    return 'VENDOR_UNAVAILABLE';
  } finally {
    clearTimeout(timeout);
  }
}

export interface ScreeningStatus {
  ofac: {
    count: number;
    lastRefreshedAt: string | null;
    lastRefreshError: string | null;
    usingFallback: boolean;
    source: string;
  };
  goPlus: {
    lastCheckedAt: string | null;
    lastError: string | null;
    source: string;
  };
  /** 'closed' (default) holds transactions when the threat-intel vendor is
   * unreachable; 'open' degrades to clean. See SCREENING_FAIL_MODE. */
  failMode: 'closed' | 'open';
}

export function getScreeningStatus(): ScreeningStatus {
  return {
    ofac: { count: sanctionedAddresses.size, lastRefreshedAt, lastRefreshError, usingFallback, source: OFAC_ETH_LIST_URL },
    goPlus: { lastCheckedAt: goPlusLastCheckedAt, lastError: goPlusLastError, source: GOPLUS_ADDRESS_SECURITY_URL },
    failMode: SCREENING_FAIL_MODE,
  };
}

export interface ScreenTargetInput {
  address: string;
  /** Our domain's network string (e.g. `ethereum-mainnet`); mapped internally
   * to a GoPlus chain id. Omit to default to Ethereum mainnet reputation. */
  network?: string;
  vendor?: string;
}

export async function screen({
  address,
  network,
  vendor = 'ofac-sdn-feed+goplus+mock-blockaid',
}: ScreenTargetInput): Promise<ScreeningResult> {
  const normalized = address.toLowerCase();
  let verdict: ScreeningVerdict = 'clean';
  let reason: ScreeningReason = 'NONE';

  if (sanctionedAddresses.has(normalized) || DEMO_TEST_ADDRESSES.has(normalized)) {
    verdict = 'flagged';
    reason = 'SANCTIONED_ADDRESS';
  } else if (DEMO_MALICIOUS_CONTRACTS.has(normalized)) {
    verdict = 'flagged';
    reason = 'KNOWN_MALICIOUS_CONTRACT';
  } else if (DEMO_MIXER_LINKED_ADDRESSES.has(normalized)) {
    verdict = 'flagged';
    reason = 'MIXER_LINKED';
  } else {
    const chainId = (network && NETWORK_TO_GOPLUS_CHAIN_ID[network]) || '1';
    const goPlusReason = await checkGoPlusAddressSecurity(normalized, chainId);
    if (goPlusReason === 'VENDOR_UNAVAILABLE') {
      if (SCREENING_FAIL_MODE === 'closed') {
        // Fail-closed (default): hold the transaction rather than let it
        // through unscreened. Not an assertion about the address - the agent
        // can simply resubmit once the vendor recovers.
        verdict = 'flagged';
        reason = 'SCREENING_UNAVAILABLE';
      }
      // Fail-open: degrade to clean, the historical behavior.
    } else if (goPlusReason) {
      verdict = 'flagged';
      reason = goPlusReason;
    }
  }

  return { screenedAt: nowIso(), verdict, reason, vendor };
}

/** Screens both the destination and, if present, the contract being interacted with.
 * Failed screening on either target is a hard block (Section 6.3). */
export async function screenOutgoing(to: string, contractAddress: string | null, network?: string): Promise<ScreeningResult> {
  const toResult = await screen({ address: to, network });
  if (toResult.verdict === 'flagged') return toResult;
  if (contractAddress) {
    const contractResult = await screen({ address: contractAddress, network });
    if (contractResult.verdict === 'flagged') return contractResult;
  }
  return toResult;
}

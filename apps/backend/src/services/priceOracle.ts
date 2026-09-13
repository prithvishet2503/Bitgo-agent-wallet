import { ethers } from 'ethers';

/**
 * Real, live, on-chain ETH/USD price via Chainlink Price Feeds - the
 * standard decentralized price oracle for EVM chains. No API key, no signup:
 * it's a plain contract read (`latestRoundData()`) via the same RPC provider
 * `chainExecutor.ts` already holds, against a well-known, published feed
 * address (docs.chain.link/data-feeds/price-feeds/addresses) that BitGo
 * Agent Wallet doesn't deploy or control.
 *
 * This replaces what used to be a flat, made-up "$1 = X ETH" constant with a
 * genuinely real exchange rate. A separate, explicitly-labeled
 * `CHAIN_VALUE_SCALE_FACTOR` (see chainExecutor.ts) still scales the *amount*
 * of that real rate actually moved on-chain down to a testnet-safe size -
 * that scaling is a deliberate demo-safety choice, not a fake price.
 */

const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
];

/** Chainlink testnet feeds update far less often than mainnet's (mainnet:
 * minutes; Sepolia: can be hours) - treat anything older than this as too
 * stale to trust rather than silently pricing off a wildly outdated number. */
const MAX_STALENESS_SECONDS = Number(process.env.CHAIN_PRICE_MAX_STALENESS_SECONDS ?? String(24 * 60 * 60));
/** Don't hit the RPC on every single transaction - Chainlink prices don't
 * change meaningfully faster than this for our purposes. */
const CACHE_TTL_MS = 60_000;
/** Used only if the live oracle is unreachable or stale, so behavior degrades
 * gracefully instead of failing every transaction outright. */
const FALLBACK_ETH_USD_PRICE = Number(process.env.CHAIN_FALLBACK_ETH_USD_PRICE ?? '2500');

interface CachedPrice {
  value: number;
  fetchedAt: number;
  feedDescription: string;
  updatedAt: string;
}

let cached: CachedPrice | null = null;
let lastError: string | null = null;

export async function getEthUsdPrice(provider: ethers.Provider, feedAddress: string): Promise<number> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const feed = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);
    const [decimals, roundData, description] = await Promise.all([
      feed.decimals(),
      feed.latestRoundData(),
      feed.description(),
    ]);
    const [, answer, , updatedAt] = roundData as [bigint, bigint, bigint, bigint, bigint];

    const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
    if (ageSeconds > MAX_STALENESS_SECONDS) {
      throw new Error(`feed is stale (${ageSeconds}s old, max ${MAX_STALENESS_SECONDS}s)`);
    }

    const price = Number(answer) / 10 ** Number(decimals);
    cached = { value: price, fetchedAt: Date.now(), feedDescription: description, updatedAt: new Date(Number(updatedAt) * 1000).toISOString() };
    lastError = null;
    return price;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `[priceOracle] Chainlink lookup failed (${lastError}) - using ${cached ? 'last known price' : `fallback $${FALLBACK_ETH_USD_PRICE}/ETH`}`,
    );
    return cached?.value ?? FALLBACK_ETH_USD_PRICE;
  }
}

export interface PriceOracleStatus {
  source: 'chainlink' | 'fallback';
  ethUsdPrice: number;
  feedDescription: string | null;
  feedUpdatedAt: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export function getPriceOracleStatus(): PriceOracleStatus {
  return {
    source: cached ? 'chainlink' : 'fallback',
    ethUsdPrice: cached?.value ?? FALLBACK_ETH_USD_PRICE,
    feedDescription: cached?.feedDescription ?? null,
    feedUpdatedAt: cached?.updatedAt ?? null,
    lastFetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
    lastError,
  };
}

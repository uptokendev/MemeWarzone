/**
 * Partner token stats (pure helpers, no db import so tests stay offline).
 *
 * CrypticPump shows a "Live Stats" panel on its coin pages. For coins on our own curve there is no
 * GeckoTerminal pool, so they read these figures from us instead. The endpoint is read-only public
 * market data (the same numbers our token page shows) and the browser CORS opening for partner
 * origins is scoped to /api/partner only; every other indexer route keeps its own allowlist.
 */

export const PARTNER_ROUTE_PREFIX = "/api/partner";
export const PARTNER_CACHE_TTL_MS = 15_000;
export const PARTNER_CACHE_MAX_ENTRIES = 1000;

const DEFAULT_PARTNER_ORIGINS = ["https://crypticpump.com", "https://www.crypticpump.com"];
const PARTNER_CHAIN_IDS = new Set([56, 97, 101, 4663, 46630]);

export function partnerOrigins(extra: string = String(process.env.PARTNER_CORS_ORIGINS || "")): Set<string> {
  return new Set(
    DEFAULT_PARTNER_ORIGINS.concat(
      extra
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  );
}

export function isPartnerOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return false;
  return allowed.has(origin);
}

export function parsePartnerChainId(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && PARTNER_CHAIN_IDS.has(value) ? value : null;
}

/** EVM addresses lowercase; Solana base58 is case-sensitive and kept as given. */
export function normalizePartnerAddress(chainId: number, raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (chainId === 101) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
  const lower = value.toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(lower) ? lower : null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export type PartnerStatsRow = {
  chain_id: number | string;
  campaign_address: string;
  token_address: string | null;
  name: string | null;
  symbol: string | null;
  market_stage: string | null;
  last_price_bnb: string | number | null;
  last_price_usd: string | number | null;
  market_cap_usd: string | number | null;
  volume_24h_usd: string | number | null;
  liquidity_usd: string | number | null;
  holders: string | number | null;
  trades_24h: string | number | null;
  last_trade_at: Date | string | null;
  updated_at: Date | string | null;
  valuation_healthy: boolean | null;
  price_24h_ago: string | number | null;
};

export type PartnerTokenStats = {
  chainId: number;
  tokenAddress: string | null;
  campaignAddress: string;
  name: string | null;
  symbol: string | null;
  stage: string;
  priceUsd: number | null;
  pricePer1mUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  priceChange24hPct: number | null;
  holders: number | null;
  trades24h: number | null;
  lastTradeAt: string | null;
  updatedAt: string | null;
  pageUrl: string;
  source: "Meme Warzone";
};

export function buildPartnerTokenStats(row: PartnerStatsRow, appOrigin = "https://app.memewar.zone"): PartnerTokenStats {
  // An unhealthy valuation means the USD reference price could not be refreshed; withhold USD
  // figures rather than hand a partner a stale or wrong dollar value.
  const usdOk = row.valuation_healthy !== false;
  const priceUsd = usdOk ? num(row.last_price_usd) : null;

  // Same rule as the app's ticker (frontend/api/campaigns-base.js priceChange24hPct): current price
  // against the last 5s candle at or before 24h ago, or a younger coin's first price. Both are in
  // the quote asset, so this is the coin's own move, not the quote asset's USD move.
  const lastNative = num(row.last_price_bnb);
  const agoNative = num(row.price_24h_ago);
  const priceChange24hPct =
    lastNative != null && agoNative != null && lastNative > 0 && agoNative > 0
      ? (lastNative / agoNative - 1) * 100
      : null;

  const tokenAddress = row.token_address ? String(row.token_address) : null;
  return {
    chainId: Number(row.chain_id),
    tokenAddress,
    campaignAddress: String(row.campaign_address),
    name: row.name ? String(row.name) : null,
    symbol: row.symbol ? String(row.symbol) : null,
    stage: row.market_stage ? String(row.market_stage) : "BONDING",
    priceUsd,
    pricePer1mUsd: priceUsd != null ? priceUsd * 1_000_000 : null,
    marketCapUsd: usdOk ? num(row.market_cap_usd) : null,
    volume24hUsd: usdOk ? num(row.volume_24h_usd) : null,
    liquidityUsd: usdOk ? num(row.liquidity_usd) : null,
    priceChange24hPct,
    holders: num(row.holders),
    trades24h: num(row.trades_24h),
    lastTradeAt: iso(row.last_trade_at),
    updatedAt: iso(row.updated_at),
    pageUrl: `${appOrigin}/token/${tokenAddress || String(row.campaign_address)}`,
    source: "Meme Warzone",
  };
}

type CacheEntry<T> = { value: T; at: number };

/** Small TTL cache; oldest entry is evicted once full. */
export function createTtlCache<T>(ttlMs = PARTNER_CACHE_TTL_MS, maxEntries = PARTNER_CACHE_MAX_ENTRIES, now = Date.now) {
  const entries = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    size() {
      return entries.size;
    },
  };
}

import { apiFetch } from "@/lib/apiBase";
import { encodeCampaignPath } from "@/lib/chart/normalizeTrade";
import { parseMarketCandlePayload } from "@/lib/marketCandlePayload";

export type MarketStage =
  | "BONDING"
  | "GRADUATING"
  | "TOPAZ_PENDING"
  | "TOPAZ_ACTIVE"
  | "TOPAZ_DEGRADED"
  | "PAUSED"
  | "UNSUPPORTED";

export type GraduationMarker = {
  txHash: string | null;
  blockNumber: number;
  time: string;
  finalCurvePriceBnb: string | null;
  initialDexPriceBnb: string | null;
  liquidityTokenRaw: string | null;
  liquidityBnbRaw: string | null;
  liquidityLpRaw: string | null;
  burnedUnsoldTokenRaw: string | null;
  burnedUnusedLpTokenRaw: string | null;
  postBurnTotalSupplyRaw: string | null;
};

export type MarketState = {
  chainId: number;
  campaignAddress: string;
  tokenAddress: string;
  factoryAddress: string | null;
  campaignGeneration: string | null;
  marketStage: MarketStage;
  graduation: GraduationMarker | null;
  pairAddress: string | null;
  routerAddress: string | null;
  dexFactoryAddress: string | null;
  wrappedNativeAddress: string | null;
  stable: boolean | null;
  feeBps: number | null;
  poolVerified: boolean;
  supportEnabled: boolean;
  bondingActive: boolean;
  tradingEnabled: boolean;
  indexingStatus: {
    enabled: boolean;
    poolEnabled: boolean;
    lastIndexedBlock: number | null;
    lastFinalizedBlock: number | null;
    lastSwapAt: string | null;
    lastSyncAt: string | null;
    dataLagSeconds: number | null;
  };
  reserves: {
    tokenRaw: string | null;
    nativeRaw: string | null;
  };
  lastVerifiedAt: string | null;
  lastError: string | null;
};

export type MarketRoute = {
  chainId: number;
  marketStage: MarketStage;
  campaignAddress: string;
  token: string;
  pair: string | null;
  router: string | null;
  factory: string | null;
  wrappedNative: string | null;
  stable: boolean | null;
  feeBps: number | null;
  verified: boolean;
  tradingEnabled: boolean;
  verifiedAt: string | null;
  lastError: string | null;
};

export type MarketTrade = {
  chainId: number;
  campaignAddress: string;
  tokenAddress: string;
  pairAddress: string | null;
  marketStage: string;
  source: "bonding" | "topaz";
  side: "buy" | "sell";
  wallet: string;
  recipient: string | null;
  tokenAmountRaw: string;
  nativeAmountRaw: string;
  priceBnb: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: string;
  status: string;
};

export type MarketCandle = {
  bucket_start: string;
  o: string;
  h: string;
  l: string;
  c: string;
  price_o?: string | null;
  price_h?: string | null;
  price_l?: string | null;
  price_c?: string | null;
  mcap_o?: string | null;
  mcap_h?: string | null;
  mcap_l?: string | null;
  mcap_c?: string | null;
  canonical_version?: number | null;
  canonical_updated_at?: string | null;
  volume_bnb: string;
  trades_count: number;
  source_mask: number;
  bonding_trade_count: number;
  dex_trade_count: number;
  bonding_volume_bnb: string;
  dex_volume_bnb: string;
  last_block_number: number | null;
  last_log_index: number | null;
};

export type MarketCandleResponse = {
  items: MarketCandle[];
  graduationMarker: {
    time: string;
    txHash: string | null;
    blockNumber: number;
    finalCurvePriceBnb: string | null;
    initialDexPriceBnb: string | null;
    pairAddress: string | null;
    initialLiquidityBnbRaw: string | null;
    postBurnTotalSupplyRaw: string | null;
  } | null;
  marketStage: MarketStage;
  serverTime?: string | null;
  canonicalVersion?: number | null;
};

export type MarketSummary = {
  chain_id?: number;
  campaign_address?: string;
  marketStage: MarketStage;
  last_price_bnb?: string | null;
  market_cap_bnb?: string | null;
  liquidity_bnb?: string | null;
  bonding_reserve_bnb?: string | null;
  volume_5m_bnb?: string | null;
  volume_1h_bnb?: string | null;
  volume_4h_bnb?: string | null;
  volume_24h_bnb?: string | null;
  buy_volume_24h_bnb?: string | null;
  sell_volume_24h_bnb?: string | null;
  bonding_volume_24h_bnb?: string | null;
  dex_volume_24h_bnb?: string | null;
  trades_24h?: number;
  buys_24h?: number;
  sells_24h?: number;
  holders?: number | null;
  post_burn_total_supply_raw?: string | null;
  last_trade_block?: number | null;
  last_trade_at?: string | null;
  poolVerified: boolean;
  tradingEnabled: boolean;
  dataLagSeconds: number | null;
};

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(path, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error || body?.message || `Market API request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function campaignPath(campaignAddress: string, chainId: number): string {
  return encodeCampaignPath(chainId, campaignAddress);
}

export function fetchMarketState(campaignAddress: string, chainId: number, signal?: AbortSignal) {
  return readJson<MarketState>(
    `/api/token/${campaignPath(campaignAddress, chainId)}/market-state?chainId=${chainId}`,
    signal,
  );
}

export function fetchMarketRoute(campaignAddress: string, chainId: number, signal?: AbortSignal) {
  return readJson<MarketRoute>(
    `/api/token/${campaignPath(campaignAddress, chainId)}/trade-route?chainId=${chainId}`,
    signal,
  );
}

export function fetchMarketTrades(
  campaignAddress: string,
  chainId: number,
  options?: { limit?: number; cursor?: string; marketStage?: "all" | "bonding" | "topaz"; signal?: AbortSignal },
) {
  const params = new URLSearchParams({
    chainId: String(chainId),
    limit: String(options?.limit ?? 200),
    marketStage: options?.marketStage ?? "all",
  });
  if (options?.cursor) params.set("cursor", options.cursor);
  return readJson<{ items: MarketTrade[]; nextCursor: string | null }>(
    `/api/token/${campaignPath(campaignAddress, chainId)}/market-trades?${params.toString()}`,
    options?.signal,
  );
}

export async function fetchMarketCandles(
  campaignAddress: string,
  chainId: number,
  resolution: string,
  options?: { limit?: number; from?: number; to?: number; signal?: AbortSignal },
) {
  const limit = String(options?.limit ?? 2500);
  const canonicalParams = new URLSearchParams({
    chainId: String(chainId),
    resolution,
    limit,
  });
  const durableParams = new URLSearchParams({
    chainId: String(chainId),
    tf: resolution,
    limit,
  });
  if (options?.from != null) {
    canonicalParams.set("from", String(options.from));
    durableParams.set("from", String(options.from));
  }
  if (options?.to != null) {
    canonicalParams.set("to", String(options.to));
    durableParams.set("to", String(options.to));
  }

  const encoded = campaignPath(campaignAddress, chainId);
  try {
    const canonical = parseMarketCandlePayload(
      await readJson(
        `/api/token/${encoded}/canonical-market-candles?${canonicalParams.toString()}`,
        options?.signal,
      ),
    ) as MarketCandleResponse;
    if (canonical.items.length) return canonical;
  } catch {
    // /candles is the durable indexer history the Token Details chart already trusts.
  }

  return parseMarketCandlePayload(
    await readJson(
      `/api/token/${encoded}/candles?${durableParams.toString()}`,
      options?.signal,
    ),
  ) as MarketCandleResponse;
}

export function fetchMarketSummary(campaignAddress: string, chainId: number, signal?: AbortSignal) {
  return readJson<MarketSummary>(
    `/api/token/${campaignPath(campaignAddress, chainId)}/market-summary?chainId=${chainId}`,
    signal,
  );
}

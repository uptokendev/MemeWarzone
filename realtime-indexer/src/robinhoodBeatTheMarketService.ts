import { pool } from "./db.js";
import {
  calculateRobinhoodBeatTheMarket,
  ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION,
  type RobinhoodBeatTheMarketResult,
} from "./robinhoodBeatTheMarket.js";

export type RobinhoodBeatWindow = "1h" | "24h" | "7d" | "30d";
type QueryResult = { rows: any[] };
type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

const WINDOW_MS: Record<RobinhoodBeatWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const WINDOW_TIMEFRAME: Record<RobinhoodBeatWindow, "5m" | "1h"> = {
  "1h": "5m",
  "24h": "1h",
  "7d": "1h",
  "30d": "1h",
};

const TIMEFRAME_MS = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
} as const;

const CURRENT_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;

function normalizeWindow(value: unknown): RobinhoodBeatWindow {
  const raw = String(value || "24h").trim().toLowerCase();
  return raw === "1h" || raw === "7d" || raw === "30d" ? raw : "24h";
}

function timestampMs(value: unknown): number | null {
  if (!value) return null;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function unhealthy(error: string): RobinhoodBeatTheMarketResult {
  return {
    formulaVersion: ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION,
    healthy: false,
    error,
  };
}

export async function computeRobinhoodBeatTheMarket(input: {
  chainId: number;
  campaignAddress: string;
  window?: RobinhoodBeatWindow | string;
  nowMs?: number;
  persist?: boolean;
}, deps: { query?: QueryFn } = {}) {
  const query: QueryFn = deps.query || ((text, params) => pool.query(text, params as any[]));
  const chainId = Number(input.chainId);
  if (chainId !== 4663 && chainId !== 46630) {
    return { window: normalizeWindow(input.window), metric: unhealthy("Beat the Market is Robinhood-only.") };
  }

  const campaignAddress = String(input.campaignAddress || "").trim().toLowerCase();
  if (!campaignAddress) {
    return { window: normalizeWindow(input.window), metric: unhealthy("Campaign address is required.") };
  }

  const window = normalizeWindow(input.window);
  const nowMs = input.nowMs ?? Date.now();
  const timeframe = WINDOW_TIMEFRAME[window];

  const currentResult = await query(
    `select ms.last_price_usd,ms.reference_price_usd,ms.reference_price_updated_at,
            ms.valuation_source,ms.valuation_healthy,ms.updated_at,ms.quote_asset_type,ms.quote_token_address
       from public.market_stats ms
      where ms.chain_id=$1 and lower(ms.campaign_address)=lower($2)
      limit 1`,
    [chainId, campaignAddress],
  );
  const current = currentResult.rows[0];
  if (!current) return { window, metric: unhealthy("Normalized Robinhood market stats are unavailable.") };
  if (String(current.quote_asset_type || "").toUpperCase() !== "STOCK_TOKEN") {
    return { window, metric: unhealthy("Beat the Market requires a canonical Stock Battlefield quote asset.") };
  }
  if (!current.valuation_healthy || !current.last_price_usd || !current.reference_price_usd) {
    return { window, metric: unhealthy("Current normalized MEME/USD or Stock Token/USD valuation is unhealthy.") };
  }

  const currentUpdatedMs = timestampMs(current.updated_at);
  const currentReferenceMs = timestampMs(current.reference_price_updated_at);
  if (
    currentUpdatedMs == null || currentReferenceMs == null ||
    nowMs - currentUpdatedMs > CURRENT_EVIDENCE_MAX_AGE_MS ||
    nowMs - currentReferenceMs > CURRENT_EVIDENCE_MAX_AGE_MS
  ) {
    return { window, metric: unhealthy("Current Beat the Market valuation evidence is stale.") };
  }

  const endAt = new Date(Math.min(currentUpdatedMs, nowMs));
  const targetStartMs = endAt.getTime() - WINDOW_MS[window];
  const startResult = await query(
    `select bucket_start,c_usd,reference_price_usd,reference_price_updated_at,valuation_source,valuation_healthy
       from public.token_candles
      where chain_id=$1 and lower(campaign_address)=lower($2)
        and timeframe=$3
        and bucket_start <= $4
        and valuation_healthy=true
        and c_usd is not null and c_usd > 0
        and reference_price_usd is not null and reference_price_usd > 0
      order by bucket_start desc
      limit 1`,
    [chainId, campaignAddress, timeframe, new Date(targetStartMs)],
  );
  const start = startResult.rows[0];
  if (!start) return { window, metric: unhealthy(`No healthy normalized ${timeframe} candle exists for the ${window} start boundary.`) };

  const startAtMs = timestampMs(start.bucket_start);
  if (startAtMs == null || targetStartMs - startAtMs > TIMEFRAME_MS[timeframe] * 2) {
    return { window, metric: unhealthy(`The ${window} start boundary is too sparse for a ranked relative-performance metric.`) };
  }

  const metric = calculateRobinhoodBeatTheMarket({
    startMemeUsd: start.c_usd,
    endMemeUsd: current.last_price_usd,
    startQuoteUsd: start.reference_price_usd,
    endQuoteUsd: current.reference_price_usd,
  });
  if (!metric.healthy) return { window, metric };

  const quoteTokenAddress = String(current.quote_token_address || "").trim().toLowerCase();
  const startAt = new Date(startAtMs);
  const valuationSource = String(current.valuation_source || start.valuation_source || "").trim() || null;

  if (input.persist !== false) {
    await query(
      `insert into public.robinhood_beat_market_metrics(
         chain_id,campaign_address,quote_token_address,window_key,window_start_at,window_end_at,
         start_meme_usd,end_meme_usd,start_quote_usd,end_quote_usd,
         meme_return,quote_asset_return,relative_return,percentage_point_difference,
         formula_version,valuation_source,healthy,reason,computed_at,updated_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,null,now(),now())
       on conflict(chain_id,campaign_address,window_key,formula_version) do update set
         quote_token_address=excluded.quote_token_address,
         window_start_at=excluded.window_start_at,window_end_at=excluded.window_end_at,
         start_meme_usd=excluded.start_meme_usd,end_meme_usd=excluded.end_meme_usd,
         start_quote_usd=excluded.start_quote_usd,end_quote_usd=excluded.end_quote_usd,
         meme_return=excluded.meme_return,quote_asset_return=excluded.quote_asset_return,
         relative_return=excluded.relative_return,percentage_point_difference=excluded.percentage_point_difference,
         valuation_source=excluded.valuation_source,healthy=true,reason=null,computed_at=now(),updated_at=now()`,
      [
        chainId,
        campaignAddress,
        quoteTokenAddress,
        window,
        startAt,
        endAt,
        metric.startMemeUsd,
        metric.endMemeUsd,
        metric.startQuoteUsd,
        metric.endQuoteUsd,
        metric.memeReturn,
        metric.quoteAssetReturn,
        metric.relativeReturn,
        metric.percentagePointDifference,
        metric.formulaVersion,
        valuationSource,
      ],
    );
  }

  return {
    chainId,
    campaignAddress,
    quoteTokenAddress,
    window,
    windowStartAt: startAt.toISOString(),
    windowEndAt: endAt.toISOString(),
    valuationSource,
    metric,
  };
}

export const robinhoodBeatTheMarketServiceInternals = {
  normalizeWindow,
  timestampMs,
  WINDOW_MS,
  WINDOW_TIMEFRAME,
  CURRENT_EVIDENCE_MAX_AGE_MS,
};

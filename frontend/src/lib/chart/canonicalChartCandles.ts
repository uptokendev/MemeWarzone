import type { MarketCandle } from "@/lib/marketContinuityApi";

export type ChartMetric = "marketcap" | "price";
export type ChartDenomination = "USD" | "BNB";

export type CanonicalCandleRow = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function finiteNonNeg(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Server canonical OHLC only. Does not reconstruct candles from trades. */
export function marketCandlesForChart(
  rows: MarketCandle[] | null | undefined,
  metric: ChartMetric,
  denomination: ChartDenomination,
  nativeUsd: number,
): CanonicalCandleRow[] {
  if (denomination === "USD" && nativeUsd <= 0) return [];
  const denomMul = denomination === "USD" ? nativeUsd : 1;

  return (rows || [])
    .filter(
      (row) =>
        Number(row.trades_count || 0) > 0 ||
        Number(row.bonding_trade_count || 0) > 0 ||
        Number(row.dex_trade_count || 0) > 0,
    )
    .map((row): CanonicalCandleRow | null => {
      const timestamp = Math.floor(new Date(row.bucket_start).getTime() / 1000);
      const canonicalValues =
        metric === "marketcap"
          ? [row.mcap_o, row.mcap_h, row.mcap_l, row.mcap_c]
          : [row.price_o, row.price_h, row.price_l, row.price_c];
      const hasCanonical = canonicalValues.every((value) => finiteNonNeg(value) != null);

      let values: number[];
      if (hasCanonical) {
        values = canonicalValues.map((value) => Number(value));
      } else if (metric === "marketcap") {
        return null;
      } else {
        values = [row.o, row.h, row.l, row.c].map((value) => Number(value));
      }

      const [open, high, low, close] = values.map((value) => value * denomMul);
      if (![open, high, low, close].every(Number.isFinite)) return null;
      if (metric === "price" && (open <= 0 || high <= 0 || low <= 0 || close <= 0)) return null;
      if (metric === "marketcap" && (open < 0 || high < 0 || low < 0 || close < 0)) return null;
      if (metric === "marketcap" && open === 0 && high === 0 && low === 0 && close === 0) return null;
      if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
      return { time: timestamp, open, high, low, close };
    })
    .filter((row): row is CanonicalCandleRow => row != null);
}

/**
 * Live spot×sold may patch the latest series candle so the chart live label
 * matches the header. Older candles stay untouched. Never appends a new bar.
 */
export function patchActiveLatestBucket(
  rows: CanonicalCandleRow[],
  liveValue: number,
  intervalSeconds?: number,
  nowSec?: number,
): CanonicalCandleRow[] {
  void intervalSeconds;
  void nowSec;
  if (!rows.length || !Number.isFinite(liveValue) || liveValue <= 0) return rows;
  const last = rows[rows.length - 1];
  if (!last) return rows;
  return rows.map((row, index) => {
    if (index !== rows.length - 1) return row;
    return {
      ...row,
      high: Math.max(row.high, liveValue, row.open, row.close),
      low: Math.min(row.low, liveValue, row.open, row.close),
      close: liveValue,
    };
  });
}

export function assembleMarketCapCandles(input: {
  marketCandles: MarketCandle[] | null | undefined;
  denomination: ChartDenomination;
  nativeUsd: number;
  historyReady: boolean;
  liveMcapNative?: number | null;
  intervalSeconds: number;
  nowSec?: number;
  fallbackRows?: CanonicalCandleRow[];
}): CanonicalCandleRow[] {
  if (!input.historyReady) return [];
  const canonical = marketCandlesForChart(input.marketCandles, "marketcap", input.denomination, input.nativeUsd);
  const rows = canonical.length ? canonical : input.fallbackRows || [];
  if (!rows.length) return [];
  const liveNative = Number(input.liveMcapNative);
  if (!Number.isFinite(liveNative) || liveNative <= 0) return rows;
  const liveValue = input.denomination === "USD" && input.nativeUsd > 0 ? liveNative * input.nativeUsd : liveNative;
  return patchActiveLatestBucket(
    rows,
    liveValue,
    input.intervalSeconds,
    input.nowSec ?? Math.floor(Date.now() / 1000),
  );
}

/** ATH native = max(all canonical mcap_h, current mcap). Never below a visible high. */
export function canonicalAthNativeFromCandles(
  rows: Array<Pick<MarketCandle, "mcap_h">> | null | undefined,
  currentNative = 0,
): number {
  let peak = Number(currentNative) > 0 ? Number(currentNative) : 0;
  for (const row of rows || []) {
    const high = Number(row.mcap_h);
    if (Number.isFinite(high) && high > peak) peak = high;
  }
  return peak;
}

export function shouldEstablishChartRange(input: {
  historyReady: boolean;
  candleCount: number;
  initialHistoryFitted: boolean;
  userInteracted: boolean;
  previousCandleCount: number;
  previousFirstTime: number | null;
  nextFirstTime: number | null;
}): { paint: boolean; fit: boolean } {
  if (!input.historyReady || input.candleCount <= 0) {
    return { paint: false, fit: false };
  }
  if (!input.initialHistoryFitted) {
    return { paint: true, fit: true };
  }
  const historyPrepended =
    input.previousCandleCount > 0 &&
    input.nextFirstTime != null &&
    input.previousFirstTime != null &&
    input.nextFirstTime < input.previousFirstTime;
  const historyReplacedLarger = input.candleCount > input.previousCandleCount + 1;
  if (!input.userInteracted && (historyPrepended || historyReplacedLarger)) {
    return { paint: true, fit: true };
  }
  return { paint: true, fit: false };
}

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
  /**
   * Circulating supply for deriving market cap when the server has no canonical
   * mcap series. Robinhood post-grad candles carry price but no mcap, and the
   * trade-fill fallback charts slippage rather than the pool price, which put
   * candles far above the market cap the header reports.
   */
  supplyWhole?: number | null,
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

      const priceValues = [row.o, row.h, row.l, row.c].map((value) => Number(value));
      const derivableSupply = Number(supplyWhole);
      let values: number[];
      if (hasCanonical) {
        values = canonicalValues.map((value) => Number(value));
      } else if (metric === "marketcap") {
        // price x supply is the same basis the headline uses, so the two agree.
        if (!Number.isFinite(derivableSupply) || derivableSupply <= 0) return null;
        if (!priceValues.every((value) => Number.isFinite(value) && value > 0)) return null;
        values = priceValues.map((value) => value * derivableSupply);
      } else {
        values = priceValues;
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

function liveAgreesWithClose(close: number, liveValue: number): boolean {
  if (!Number.isFinite(close) || !Number.isFinite(liveValue) || liveValue <= 0) return false;
  if (close <= 0) return false;
  const diff = Math.abs(close - liveValue);
  const scale = Math.max(Math.abs(close), Math.abs(liveValue), 1e-18);
  return diff <= 1e-12 || diff / scale <= 1e-6;
}

function patchLast(rows: CanonicalCandleRow[], liveValue: number): CanonicalCandleRow[] {
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

/**
 * Live spot×sold may patch the current minute, or open a new current-minute
 * candle after history. Completed historical bars are not rewritten.
 */
/**
 * Carry the last close across empty buckets so a sparse market still draws a line.
 *
 * A quiet token only produces a candle when it trades. RH5661 has four 1m candles
 * across 2,844 slots, so the series was 99.9% holes and rendered as a blank canvas
 * with a few specks. BNB never showed this because an active token fills nearly
 * every bucket.
 *
 * Filler buckets are flat (open = high = low = close = previous close), which is
 * what actually happened: no trades, so no price movement. Output is capped, and
 * the newest buckets are kept, so a long quiet period cannot allocate unbounded rows.
 */
export function fillCandleGaps(
  rows: CanonicalCandleRow[],
  intervalSeconds: number,
  nowSec?: number,
  maxPoints = 3000,
): CanonicalCandleRow[] {
  const interval = Math.floor(Number(intervalSeconds));
  if (!rows.length || !Number.isFinite(interval) || interval <= 0) return rows;

  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const filled: CanonicalCandleRow[] = [];

  for (const row of sorted) {
    const previous = filled[filled.length - 1];
    if (previous) {
      const missing = Math.floor((row.time - previous.time) / interval) - 1;
      // Guard against a pathological span producing millions of rows.
      if (missing > 0 && missing <= maxPoints * 4) {
        for (let index = 1; index <= missing; index += 1) {
          const time = previous.time + interval * index;
          filled.push({ time, open: previous.close, high: previous.close, low: previous.close, close: previous.close });
        }
      }
    }
    filled.push(row);
  }

  // Extend to the current bucket so the line reaches the right edge rather than
  // stopping wherever the last trade happened to land.
  const now = Number(nowSec);
  if (Number.isFinite(now) && now > 0) {
    const currentBucket = Math.floor(now / interval) * interval;
    const last = filled[filled.length - 1];
    if (last && currentBucket > last.time) {
      const missing = Math.floor((currentBucket - last.time) / interval);
      if (missing > 0 && missing <= maxPoints * 4) {
        for (let index = 1; index <= missing; index += 1) {
          const time = last.time + interval * index;
          filled.push({ time, open: last.close, high: last.close, low: last.close, close: last.close });
        }
      }
    }
  }

  return filled.length > maxPoints ? filled.slice(filled.length - maxPoints) : filled;
}

export function patchActiveLatestBucket(
  rows: CanonicalCandleRow[],
  liveValue: number,
  intervalSeconds?: number,
  nowSec?: number,
): CanonicalCandleRow[] {
  if (!rows.length || !Number.isFinite(liveValue) || liveValue <= 0) return rows;
  const last = rows[rows.length - 1];
  if (!last) return rows;
  const interval = Number(intervalSeconds);
  const now = Number(nowSec);
  const bucketSec =
    Number.isFinite(interval) && interval > 0 && Number.isFinite(now)
      ? Math.floor(now / interval) * interval
      : NaN;
  const liveBucket = last.time === bucketSec;
  if (liveBucket) return patchLast(rows, liveValue);
  if (last.close > 0 && liveAgreesWithClose(last.close, liveValue)) return rows;
  if (Number.isFinite(bucketSec) && bucketSec > last.time) {
    return [
      ...rows,
      {
        time: bucketSec,
        open: last.close,
        high: Math.max(last.close, liveValue),
        low: Math.min(last.close, liveValue),
        close: liveValue,
      },
    ];
  }
  return rows;
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
  supplyWhole?: number | null;
}): CanonicalCandleRow[] {
  if (!input.historyReady) return [];
  const canonical = marketCandlesForChart(
    input.marketCandles,
    "marketcap",
    input.denomination,
    input.nativeUsd,
    input.supplyWhole,
  );
  const sparse = canonical.length ? canonical : input.fallbackRows || [];
  if (!sparse.length) return [];
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const rows = fillCandleGaps(sparse, input.intervalSeconds, nowSec);
  if (!rows.length) return [];
  const liveNative = Number(input.liveMcapNative);
  if (!Number.isFinite(liveNative) || liveNative <= 0) return rows;
  const liveValue = input.denomination === "USD" && input.nativeUsd > 0 ? liveNative * input.nativeUsd : liveNative;
  return patchActiveLatestBucket(rows, liveValue, input.intervalSeconds, nowSec);
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

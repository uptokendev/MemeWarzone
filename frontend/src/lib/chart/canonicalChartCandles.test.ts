import assert from "node:assert/strict";
import test from "node:test";
import type { MarketCandle } from "../marketContinuityApi.ts";
import {
  assembleMarketCapCandles,
  canonicalAthNativeFromCandles,
  marketCandlesForChart,
  patchActiveLatestBucket,
  shouldEstablishChartRange,
} from "./canonicalChartCandles.ts";

function candle(partial: Partial<MarketCandle> & { bucket_start: string }): MarketCandle {
  return {
    o: "0",
    h: "0",
    l: "0",
    c: "0",
    volume_bnb: "0",
    trades_count: 1,
    source_mask: 1,
    bonding_trade_count: 1,
    dex_trade_count: 0,
    bonding_volume_bnb: "0",
    dex_volume_bnb: "0",
    last_block_number: 1,
    last_log_index: 0,
    ...partial,
  };
}

test("first bonding market-cap candle keeps API open/low at zero", () => {
  const rows = marketCandlesForChart(
    [
      candle({
        bucket_start: "2026-08-20T12:00:00.000Z",
        mcap_o: "0",
        mcap_h: "0.002",
        mcap_l: "0",
        mcap_c: "0.0015",
      }),
      candle({
        bucket_start: "2026-08-20T12:01:00.000Z",
        mcap_o: "0.0015",
        mcap_h: "0.0021",
        mcap_l: "0.0014",
        mcap_c: "0.0020",
      }),
    ],
    "marketcap",
    "BNB",
    0,
  );
  assert.equal(rows[0]?.open, 0);
  assert.equal(rows[0]?.low, 0);
  assert.ok((rows[0]?.close ?? 0) > 0);
  assert.equal(rows[1]?.open, 0.0015);
});

test("market-cap candles ignore trade-series reconstruction and skip live-only current bars", () => {
  const assembled = assembleMarketCapCandles({
    marketCandles: [
      candle({
        bucket_start: "2026-08-23T20:00:00.000Z",
        mcap_o: "0",
        mcap_h: "0.0012",
        mcap_l: "0",
        mcap_c: "0.0011",
      }),
    ],
    denomination: "BNB",
    nativeUsd: 850,
    historyReady: true,
    liveMcapNative: 0.001216,
    intervalSeconds: 60,
    nowSec: Date.parse("2026-08-23T20:07:09Z") / 1000,
  });
  assert.equal(assembled.length, 1);
  assert.equal(assembled[0]?.open, 0);
  assert.equal(assembled[0]?.close, 0.0011);

  assert.deepEqual(
    assembleMarketCapCandles({
      marketCandles: [],
      denomination: "BNB",
      nativeUsd: 850,
      historyReady: true,
      liveMcapNative: 0.001216,
      intervalSeconds: 60,
      nowSec: Date.parse("2026-08-23T20:07:09Z") / 1000,
    }),
    [],
  );

  assert.deepEqual(
    assembleMarketCapCandles({
      marketCandles: [
        candle({
          bucket_start: "2026-08-23T20:00:00.000Z",
          mcap_o: "0",
          mcap_h: "0.0012",
          mcap_l: "0",
          mcap_c: "0.0011",
        }),
      ],
      denomination: "BNB",
      nativeUsd: 850,
      historyReady: false,
      liveMcapNative: 0.001216,
      intervalSeconds: 60,
      nowSec: Date.parse("2026-08-23T20:00:30Z") / 1000,
    }),
    [],
  );
});

test("live overlay patches only the active latest bucket with spot×sold", () => {
  const base = [
    { time: 1_140, open: 0, high: 2, low: 0, close: 1.5 },
    { time: 1_200, open: 1.5, high: 1.8, low: 1.4, close: 1.64 },
  ];
  const patched = patchActiveLatestBucket(base, 1.81, 60, 1_230);
  assert.equal(patched[0]?.close, 1.5);
  assert.equal(patched[1]?.close, 1.81);
  assert.equal(patched[1]?.high, 1.81);
  assert.equal(patched[1]?.open, 1.5);

  const laterBucket = patchActiveLatestBucket(base, 1.81, 60, 1_260);
  assert.equal(laterBucket[1]?.close, 1.64);
  assert.equal(laterBucket.length, 2);
});

test("ATH is max of canonical highs and current mcap", () => {
  const rows = [
    { mcap_h: "4.02" },
    { mcap_h: "7.34" },
    { mcap_h: "1.10" },
  ];
  assert.equal(canonicalAthNativeFromCandles(rows, 1.81), 7.34);
  assert.equal(canonicalAthNativeFromCandles(rows, 8.01), 8.01);
  assert.ok(canonicalAthNativeFromCandles(rows, 1.81) >= 7.34);
});

test("cold-load fits only after the first complete history snapshot", () => {
  assert.deepEqual(
    shouldEstablishChartRange({
      historyReady: false,
      candleCount: 1,
      initialHistoryFitted: false,
      userInteracted: false,
      previousCandleCount: 0,
      previousFirstTime: null,
      nextFirstTime: 1_000,
    }),
    { paint: false, fit: false },
  );
  assert.deepEqual(
    shouldEstablishChartRange({
      historyReady: true,
      candleCount: 12,
      initialHistoryFitted: false,
      userInteracted: false,
      previousCandleCount: 0,
      previousFirstTime: null,
      nextFirstTime: 1_000,
    }),
    { paint: true, fit: true },
  );
  assert.deepEqual(
    shouldEstablishChartRange({
      historyReady: true,
      candleCount: 13,
      initialHistoryFitted: true,
      userInteracted: false,
      previousCandleCount: 12,
      previousFirstTime: 1_000,
      nextFirstTime: 1_000,
    }),
    { paint: true, fit: false },
  );
  assert.deepEqual(
    shouldEstablishChartRange({
      historyReady: true,
      candleCount: 40,
      initialHistoryFitted: true,
      userInteracted: false,
      previousCandleCount: 3,
      previousFirstTime: 2_000,
      nextFirstTime: 1_000,
    }),
    { paint: true, fit: true },
  );
  assert.deepEqual(
    shouldEstablishChartRange({
      historyReady: true,
      candleCount: 40,
      initialHistoryFitted: true,
      userInteracted: true,
      previousCandleCount: 3,
      previousFirstTime: 2_000,
      nextFirstTime: 1_000,
    }),
    { paint: true, fit: false },
  );
});

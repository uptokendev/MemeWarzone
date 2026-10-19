import assert from "node:assert/strict";
import test from "node:test";
import type { MarketCandle } from "../marketContinuityApi.ts";
import {
  assembleMarketCapCandles,
  canonicalAthNativeFromCandles,
  continueFlatCandleBodies,
  marketCandlesForChart,
  patchActiveLatestBucket,
  priceAxisMinMove,
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
  assert.equal(assembled.length, 2);
  assert.equal(assembled[0]?.open, 0);
  assert.equal(assembled[0]?.close, 0.0011);
  assert.equal(assembled[1]?.close, 0.001216);

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

  const fromTrades = [{ time: 1_200, open: 0, high: 0.0012, low: 0, close: 0.0011 }];
  const fallback = assembleMarketCapCandles({
    marketCandles: [],
    denomination: "BNB",
    nativeUsd: 850,
    historyReady: true,
    intervalSeconds: 60,
    nowSec: 1_200,
    fallbackRows: fromTrades,
  });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.open, 0);

  const canonicalWins = assembleMarketCapCandles({
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
    intervalSeconds: 60,
    nowSec: Date.parse("2026-08-23T20:00:30Z") / 1000,
    fallbackRows: [{ time: 1_200, open: 0.9, high: 0.9, low: 0.9, close: 0.9 }],
  });
  assert.equal(canonicalWins[0]?.close, 0.0011);
  assert.equal(canonicalWins[0]?.open, 0);
});

test("live overlay patches the latest series candle with spot×sold", () => {
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
  assert.equal(laterBucket[0]?.close, 1.5);
  assert.equal(laterBucket[1]?.close, 1.64);
  assert.equal(laterBucket.length, 3);
  assert.equal(laterBucket[2]?.open, 1.64);
  assert.equal(laterBucket[2]?.close, 1.81);

  const agrees = patchActiveLatestBucket(base, 1.64, 60, 1_260);
  assert.equal(agrees.length, 2);
  assert.equal(agrees[1]?.close, 1.64);

  const rounding = patchActiveLatestBucket(base, 1.64 + 1e-10, 60, 1_260);
  assert.equal(rounding.length, 2);
  assert.equal(rounding[1]?.close, 1.64);

  const twoPercent = patchActiveLatestBucket(base, 1.64 * 1.02, 60, 1_260);
  assert.equal(twoPercent[1]?.close, 1.64);
  assert.equal(twoPercent.length, 3);
  assert.equal(twoPercent[2]?.close, 1.64 * 1.02);
});

test("sell-to-zero bonding candle is kept so the next buy can open at zero", () => {
  const rows = marketCandlesForChart(
    [
      candle({
        bucket_start: "2026-08-22T12:16:00.000Z",
        mcap_o: "0",
        mcap_h: "0.001216",
        mcap_l: "0",
        mcap_c: "0.001216",
      }),
      candle({
        bucket_start: "2026-08-22T12:23:00.000Z",
        mcap_o: "0.001216",
        mcap_h: "0.001216",
        mcap_l: "0",
        mcap_c: "0",
      }),
      candle({
        bucket_start: "2026-08-23T20:07:00.000Z",
        mcap_o: "0",
        mcap_h: "0.001216",
        mcap_l: "0",
        mcap_c: "0.001216",
      }),
    ],
    "marketcap",
    "BNB",
    0,
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[1]?.close, 0);
  assert.equal(rows[1]?.low, 0);
  assert.equal(rows[2]?.open, 0);
});

test("completed historical last bar is not rewritten to a different live mcap", () => {
  const headerNative = 0.001216086475611437;
  const usd = 699.5;
  const rows = assembleMarketCapCandles({
    marketCandles: [
      candle({
        bucket_start: "2026-08-22T12:16:00.000Z",
        mcap_o: "0",
        mcap_h: "0.0011",
        mcap_l: "0",
        mcap_c: "0.0011",
      }),
    ],
    denomination: "USD",
    nativeUsd: usd,
    historyReady: true,
    liveMcapNative: headerNative,
    intervalSeconds: 60,
    nowSec: Date.parse("2026-08-23T21:00:00Z") / 1000,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.close, 0.0011 * usd);
  assert.equal(rows[0]?.open, 0);
  assert.equal(rows[1]?.close, headerNative * usd);
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

test("a live candle without a market-cap series is drawn from price x supply, not dropped as zero", () => {
  // The trade indexers' candle_upsert (and DBC rows) carry no mcap_*: realtimeCandle stores null.
  // Number(null) is 0, so the bucket counted as a canonical all-zero candle and vanished from the
  // market-cap chart until a reload (BNB 0xa2bab122 and Solana Hsa3rJRQ replays, 2026-10-01).
  const live = candle({
    bucket_start: "2026-10-01T15:55:00.000Z",
    o: "2", h: "3", l: "2", c: "3",
    mcap_o: null, mcap_h: null, mcap_l: null, mcap_c: null,
    price_o: null, price_h: null, price_l: null, price_c: null,
  });
  const mcap = marketCandlesForChart([live], "marketcap", "BNB", 0, 100);
  assert.deepEqual(mcap.map((row) => [row.open, row.high, row.low, row.close]), [[200, 300, 200, 300]]);
  const price = marketCandlesForChart([live], "price", "BNB", 0, 100);
  assert.deepEqual(price.map((row) => [row.open, row.close]), [[2, 3]]);
  // Without a supply there is nothing honest to draw.
  assert.deepEqual(marketCandlesForChart([live], "marketcap", "BNB", 0, null), []);
  // A stored canonical series still wins over the derivation.
  const canonical = candle({ ...live, mcap_o: "7", mcap_h: "9", mcap_l: "6", mcap_c: "8" });
  assert.deepEqual(marketCandlesForChart([canonical], "marketcap", "BNB", 0, 100).map((row) => row.close), [8]);
  const assembled = assembleMarketCapCandles({
    marketCandles: [live], denomination: "BNB", nativeUsd: 0, historyReady: true,
    liveMcapNative: 300, intervalSeconds: 60, nowSec: Date.parse("2026-10-01T15:55:30Z") / 1000, supplyWhole: 100,
  });
  assert.equal(assembled.length, 1, "the live bucket is the candle; no bridge bar");
  assert.equal(assembled[0].close, 300);
});

test("a fully diluted coin's first candle opens at start price x supply, not at the sold-based $0", () => {
  // Robinhood gen-6 0x404d723d, canonical 1m rows as stored 2026-10-01: mcap_* is price x curve sold,
  // so mcap_o of the first candle is 0 and the chart drew one bar from $0.
  const rows = [
    candle({
      bucket_start: "2026-10-01T17:40:00.000Z",
      o: "0.000000001", h: "0.000000001632993161", l: "0.000000001", c: "0.000000001632993161",
      price_o: "0.000000001", price_h: "0.000000001632993161", price_l: "0.000000001", price_c: "0.000000001632993161",
      mcap_o: "0", mcap_h: "0.001216086475611437", mcap_l: "0", mcap_c: "0.001216086475611437",
    }),
    candle({
      bucket_start: "2026-10-01T17:45:00.000Z",
      o: "0.000000001632993161", h: "0.000000001632993161", l: "0.000000001578986154", c: "0.000000001578986154",
      price_o: "0.000000001632993161", price_h: "0.000000001632993161", price_l: "0.000000001578986154", price_c: "0.000000001578986154",
      mcap_o: "0.001216086475611437", mcap_h: "0.001216086475611437", mcap_l: "0.0010755424963696668", mcap_c: "0.0010755424963696668",
    }),
  ];
  const supply = 1_000_000_000;
  const out = marketCandlesForChart(rows, "marketcap", "BNB", 0, 681_160, supply);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].open - 1) < 1e-12, "opens at 1e-9 ETH x 1B = 1 ETH");
  assert.ok(Math.abs(out[0].close - 1.632993161) < 1e-12);
  assert.equal(out[1].open, out[0].close, "no gap");
  assert.ok(Math.abs(out[1].close - 1.578986154) < 1e-12);
  // Without a fixed supply (old launchpad coins) the stored price x sold series is kept.
  assert.equal(marketCandlesForChart(rows, "marketcap", "BNB", 0, 681_160)[0].open, 0);
  // ATH on the same basis as the header.
  assert.ok(Math.abs(canonicalAthNativeFromCandles(rows, 1.578986154, supply) - 1.632993161) < 1e-12);
  assert.equal(canonicalAthNativeFromCandles(rows, 0), 0.001216086475611437);
  const assembled = assembleMarketCapCandles({
    marketCandles: rows, denomination: "BNB", nativeUsd: 0, historyReady: true,
    liveMcapNative: 1.578986154, intervalSeconds: 60, nowSec: Date.parse("2026-10-01T17:45:30Z") / 1000,
    supplyWhole: 681_160, fixedSupplyWhole: supply,
  });
  assert.equal(assembled.length, 2, "the live value agrees with the last close: no bridge candle");
});

test("gen-8 flat spots draw a body from the previous close, in market cap and in price", () => {
  // YCC 1m on chain 97: three indexer rows, each o=h=l=c because one spot was stored.
  // The chart then had only the last-price line. Solana opens the next bar at the previous close.
  const supply = 1_000_000_000;
  const usd = 721;
  const p1 = "0.000000000369495624";
  const p2 = "0.000000000455183624";
  const flat = (bucket: string, price: string) => {
    const mcap = String(Number(price) * supply);
    return candle({
      bucket_start: bucket,
      o: price, h: price, l: price, c: price,
      price_o: price, price_h: price, price_l: price, price_c: price,
      mcap_o: mcap, mcap_h: mcap, mcap_l: mcap, mcap_c: mcap,
    });
  };
  const rows = [
    flat("2026-10-18T23:59:00.000Z", p1),
    flat("2026-10-19T00:01:00.000Z", p2),
    flat("2026-10-19T00:02:00.000Z", p2),
  ];
  const plain = assembleMarketCapCandles({
    marketCandles: rows, denomination: "USD", nativeUsd: usd, historyReady: true,
    intervalSeconds: 60, nowSec: Date.parse("2026-10-19T00:02:30Z") / 1000,
    fixedSupplyWhole: supply,
  });
  assert.equal(plain[0].open, plain[0].close);
  assert.equal(plain[1].open, plain[1].close);
  const linked = assembleMarketCapCandles({
    marketCandles: rows, denomination: "USD", nativeUsd: usd, historyReady: true,
    intervalSeconds: 60, nowSec: Date.parse("2026-10-19T00:02:30Z") / 1000,
    fixedSupplyWhole: supply,
    continueFlatBodies: true,
  });
  const grad = Number(p1) * supply * usd;
  const later = Number(p2) * supply * usd;
  assert.ok(Math.abs(linked[0].close - grad) < 1e-4);
  assert.equal(linked[0].open, linked[0].close, "graduation print stays on its own bar");
  assert.equal(linked[1].open, linked[0].close);
  assert.ok(Math.abs(linked[1].close - later) < 1e-4);
  assert.ok(linked[1].high > linked[1].low, "the move is a candle body");
  assert.equal(linked[2].open, linked[1].close);
  assert.equal(linked[2].open, linked[2].close, "a spot that did not move stays flat");
  const price = continueFlatCandleBodies(marketCandlesForChart(rows, "price", "BNB", 0));
  assert.equal(price[1].open, price[0].close);
  assert.ok(price[1].close > price[1].open);
  assert.ok(priceAxisMinMove(price.flatMap((row) => [row.open, row.close]), 1e-8) < 1e-10);
  const ranged = continueFlatCandleBodies([
    { time: 1, open: 10, high: 12, low: 9, close: 11 },
    { time: 2, open: 11, high: 15, low: 11, close: 14 },
  ]);
  assert.deepEqual(ranged[1], { time: 2, open: 11, high: 15, low: 11, close: 14 });
});

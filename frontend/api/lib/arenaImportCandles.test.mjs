import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_CANDLE_TIMEFRAMES, createCandleSource, impliedSupply, mergeBars, parseGeckoOhlcv, toCandleRows } from "./arenaImportCandles.js";

// Shape and values as GeckoTerminal returned them for Derpy Dave's Meteora pool (2026-09-27), newest first.
const GECKO = {
  data: {
    attributes: {
      ohlcv_list: [
        [1790467200, 6.296560093390712e-05, 6.471190125762476e-05, 6.296560093390712e-05, 6.395686202278415e-05, 24.1],
        [1790380800, 6.300681786582941e-05, 6.300681786582941e-05, 6.296560093390712e-05, 6.296560093390712e-05, 49.5],
        [1790294400, 6.01076e-05, 6.3087e-05, 6.01076e-05, 6.30068e-05, 6.2],
        [1790294400, 1, 1, 1, 1, 1], // duplicate timestamp: first kept after sort
        [0, 1, 1, 1, 1, 1], // bad timestamp
        [1790200000, 0, 1, 1, 1, 1], // zero open
        "garbage",
      ],
    },
  },
};

test("parses GeckoTerminal OHLCV ascending, drops bad and duplicate rows", () => {
  const bars = parseGeckoOhlcv(GECKO);
  assert.deepEqual(bars.map((b) => b.time), [1790294400, 1790380800, 1790467200]);
  assert.equal(bars[2].c, 6.395686202278415e-05);
  assert.equal(parseGeckoOhlcv({}).length, 0);
});

test("30m bars are two 15m bars merged: open of the first, close of the last, extremes of both", () => {
  const merged = mergeBars([
    { time: 1800, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { time: 2700, o: 1.5, h: 3, l: 1, c: 2.5, v: 5 },
    { time: 3600, o: 2.5, h: 2.6, l: 2.4, c: 2.5, v: 1 },
  ], IMPORT_CANDLE_TIMEFRAMES["30m"].seconds);
  assert.deepEqual(merged, [
    { time: 1800, o: 1, h: 3, l: 0.5, c: 2.5, v: 15 },
    { time: 3600, o: 2.5, h: 2.6, l: 2.4, c: 2.5, v: 1 },
  ]);
});

test("market-cap bars use the supply implied by the feed, so the last bar matches the header", () => {
  const bars = parseGeckoOhlcv(GECKO);
  // Live feed values for Derpy Dave: market cap 61496, price 0.00006406.
  const supply = impliedSupply(61496, 0.00006406, bars);
  const rows = toCandleRows(bars, supply);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].trades_count, 1);
  assert.ok(Math.abs(Number(rows[2].mcap_c) - 61496 * (6.395686202278415e-05 / 0.00006406)) < 1e-6);
  // No feed price: the newest close stands in, so the newest market-cap bar equals the feed's cap.
  const fallback = toCandleRows(bars, impliedSupply(61496, null, bars));
  assert.ok(Math.abs(Number(fallback[2].mcap_c) - 61496) < 1e-6);
  // No market cap at all: price bars only, never an invented cap.
  assert.equal(toCandleRows(bars, impliedSupply(null, 1, bars))[0].mcap_c, null);
});

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => GECKO };
  };
}

test("upstream is asked for USD in the import's own terms, once per cache window", async () => {
  const calls = [];
  let t = 1_000_000;
  const source = createCandleSource({ env: {}, fetchImpl: fakeFetch(calls), now: () => t });
  const args = { network: "solana", pairAddress: "BJ5468WZcJHK9uAgzoKSFJ26atrZQwVt2Rve5vvmJndq", tokenAddress: "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS", resolution: "1d" };
  const [a, b] = await Promise.all([source.bars(args), source.bars(args)]);
  assert.equal(calls.length, 1, "concurrent requests share one upstream call");
  assert.match(calls[0], /\/networks\/solana\/pools\/BJ5468WZcJHK9uAgzoKSFJ26atrZQwVt2Rve5vvmJndq\/ohlcv\/day\?aggregate=1&limit=1000&currency=usd&token=2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS$/);
  assert.equal(a.bars.length, 3);
  assert.equal(b.bars.length, 3);
  await source.bars(args);
  assert.equal(calls.length, 1, "cached");
  t += IMPORT_CANDLE_TIMEFRAMES["1d"].ttlMs;
  await source.bars(args);
  assert.equal(calls.length, 2, "refreshed after the ttl");
});

test("over the per-minute cap: stale cache is served, and without cache the caller is told to retry", async () => {
  const calls = [];
  let t = 5_000_000;
  const source = createCandleSource({ env: { ARENA_IMPORT_CANDLES_GECKO_PER_MIN: "2" }, fetchImpl: fakeFetch(calls), now: () => t });
  const base = { network: "solana", pairAddress: "P", tokenAddress: "T" };
  await source.bars({ ...base, resolution: "1m" });
  await source.bars({ ...base, resolution: "5m" });
  const blocked = await source.bars({ ...base, resolution: "15m" });
  assert.deepEqual(blocked, { bars: [], stale: false, rateLimited: true });
  t += IMPORT_CANDLE_TIMEFRAMES["1m"].ttlMs; // 1m entry expired, budget still spent this minute
  const stale = await source.bars({ ...base, resolution: "1m" });
  assert.equal(stale.stale, true);
  assert.equal(stale.bars.length, 3);
  assert.equal(calls.length, 2);
  t += 60_000;
  await source.bars({ ...base, resolution: "15m" });
  assert.equal(calls.length, 3, "a new minute restores the budget");
});

test("an upstream failure falls back to the last good bars, and only throws with nothing to show", async () => {
  let fail = false;
  let t = 9_000_000;
  const source = createCandleSource({
    env: {},
    fetchImpl: async () => (fail ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, json: async () => GECKO }),
    now: () => t,
  });
  const args = { network: "bsc", pairAddress: "0xpool", tokenAddress: "0xtoken", resolution: "1h" };
  await source.bars(args);
  fail = true;
  t += IMPORT_CANDLE_TIMEFRAMES["1h"].ttlMs;
  const stale = await source.bars(args);
  assert.equal(stale.stale, true);
  await assert.rejects(source.bars({ ...args, resolution: "4h" }), /GeckoTerminal 429/);
});

// As GeckoTerminal returned it for Derpy Dave (2026-09-27): a sell into wrapped SOL.
const TRADES = {
  data: [
    { attributes: { block_number: 450952545, block_timestamp: "2026-09-27T09:10:44Z", tx_hash: "35bk", tx_from_address: "C55z", kind: "sell",
      from_token_address: "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS", to_token_address: "So11111111111111111111111111111111111111112",
      from_token_amount: "50000.0", to_token_amount: "0.025404286", volume_in_usd: "3.1978" } },
    { attributes: { block_number: 450952600, block_timestamp: "2026-09-27T09:20:00Z", tx_hash: "buyUsdc", tx_from_address: "Abc", kind: "buy",
      from_token_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", to_token_address: "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS",
      from_token_amount: "5", to_token_amount: "78000", volume_in_usd: "5" } },
    { attributes: { tx_hash: "other", block_timestamp: "2026-09-27T09:00:00Z", from_token_address: "X", to_token_address: "Y", from_token_amount: "1", to_token_amount: "1" } },
  ],
};

test("pool trades are read in the import's own terms, newest first", async () => {
  const { parseGeckoTrades } = await import("./arenaImportCandles.js");
  const rows = parseGeckoTrades(TRADES, 101, "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS");
  assert.equal(rows.length, 2, "a trade that does not involve the import is dropped");
  assert.equal(rows[0].txHash, "buyUsdc");
  assert.equal(rows[0].side, "buy");
  assert.equal(rows[0].tokenAmount, 78000);
  assert.equal(rows[0].nativeAmount, null, "quoted in USDC: no native amount, the USD value carries it");
  assert.equal(rows[0].volumeUsd, 5);
  assert.equal(rows[1].side, "sell");
  assert.equal(rows[1].nativeAmount, 0.025404286);
  assert.equal(rows[1].maker, "C55z");
  assert.equal(rows[1].blockTime, Date.parse("2026-09-27T09:10:44Z") / 1000);
});

test("trades share the candle budget and cache", async () => {
  const calls = [];
  const source = createCandleSource({ env: { ARENA_IMPORT_CANDLES_GECKO_PER_MIN: "1" }, fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => TRADES }; }, now: () => 1 });
  const args = { network: "solana", pairAddress: "P", tokenAddress: "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS", chainId: 101 };
  const first = await source.trades(args);
  assert.equal(first.trades.length, 2);
  assert.match(calls[0], /\/pools\/P\/trades\?token=2wT8/);
  assert.equal((await source.trades(args)).trades.length, 2, "cached");
  assert.equal((await source.bars({ ...args, resolution: "1m" })).rateLimited, true, "one budget for both");
  assert.equal(calls.length, 1);
});

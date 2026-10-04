import assert from "node:assert/strict";
import test from "node:test";

import { addDecimalStrings, buildTotals, createPriceService, mergeTotals, priceAssetFor } from "./financePrices.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-04T12:30:00.000Z");
const H1 = Date.parse("2026-10-01T10:00:00.000Z");
const H2 = Date.parse("2026-10-02T15:00:00.000Z");

const spotReaders = (prices) => Object.fromEntries(Object.entries(prices).map(([asset, price]) => [
  asset,
  async () => (price == null ? { price: 0, source: "none", at: 0 } : { price, source: "spot", at: NOW - 5000 }),
]));

function klineFetch(closes, calls = []) {
  return async (url) => {
    calls.push(url);
    const params = new URL(url).searchParams;
    const start = Number(params.get("startTime"));
    const end = Number(params.get("endTime"));
    const rows = Object.entries(closes)
      .map(([hour, close]) => [Number(hour), "0", "0", "0", String(close)])
      .filter(([hour]) => hour >= start && hour <= end);
    return { ok: true, json: async () => rows };
  };
}

const failingFetch = async () => { throw new Error("offline"); };

test("asset mapping: wrapped tokens use the native price, stables are $1, campaign tokens have none", () => {
  assert.equal(priceAssetFor("WSOL"), "SOL");
  assert.equal(priceAssetFor("wbnb"), "BNB");
  assert.equal(priceAssetFor("WETH"), "ETH");
  assert.equal(priceAssetFor("USDC"), "USD");
  assert.equal(priceAssetFor("K88"), null);
  assert.equal(priceAssetFor("tBNB"), null);
});

test("event-time: each hour is valued at its own close, not at spot", async () => {
  const service = createPriceService({ spotReaders: spotReaders({ SOL: 200 }), fetchImpl: klineFetch({ [H1]: 100, [H2]: 150 }), nowMs: () => NOW, env: {}, historyCache: new Map() });
  const out = await service.valueEvents("SOL", [
    { hour: new Date(H1 + 20 * 60_000), raw: "1000000000" },
    { hour: new Date(H2).toISOString(), raw: "2000000000" },
  ], 9);
  assert.equal(out.amountUsd, 100 + 300);
  assert.equal(out.priceBasis, "event_time");
  assert.match(out.priceSource, /Binance SOLUSDT 1h close/);
  assert.equal(out.priceAt, new Date(H2).toISOString());
});

test("no history: the figure uses spot and says so (current price)", async () => {
  const service = createPriceService({ spotReaders: spotReaders({ SOL: 200 }), fetchImpl: failingFetch, nowMs: () => NOW, env: {}, historyCache: new Map() });
  const out = await service.valueEvents("SOL", [{ hour: H1, raw: "1500000000" }], 9);
  assert.equal(out.amountUsd, 300);
  assert.equal(out.priceBasis, "current");
  assert.equal(out.priceSource, "Binance SOLUSDT spot");
});

test("partial history: the hours without one fall back to spot and the basis is mixed", async () => {
  const service = createPriceService({ spotReaders: spotReaders({ BNB: 600 }), fetchImpl: klineFetch({ [H1]: 500 }), nowMs: () => NOW, env: {}, historyCache: new Map() });
  const out = await service.valueEvents("BNB", [{ hour: H1, raw: "1000000000000000000" }, { hour: H2, raw: "1000000000000000000" }], 18);
  assert.equal(out.amountUsd, 1100);
  assert.equal(out.priceBasis, "mixed");
});

test("missing price is null, never 0", async () => {
  const service = createPriceService({ spotReaders: spotReaders({ SOL: null, ETH: null }), fetchImpl: failingFetch, nowMs: () => NOW, env: {}, historyCache: new Map() });
  const events = await service.valueEvents("SOL", [{ hour: H1, raw: "1000000000" }], 9);
  assert.equal(events.amountUsd, null);
  assert.equal(events.priceUsd, null);
  const balance = await service.valueAtSpot("ETH", "1.5");
  assert.equal(balance.amountUsd, null);
  const token = await service.valueAtSpot("K88", "100");
  assert.equal(token.amountUsd, null);
  assert.equal(token.priceSource, null);
});

test("a zero amount is a real zero in USD", async () => {
  const service = createPriceService({ spotReaders: spotReaders({ SOL: 200 }), fetchImpl: failingFetch, nowMs: () => NOW, env: {}, historyCache: new Map() });
  const out = await service.valueEvents("SOL", [{ hour: null, raw: "0" }], 9);
  assert.equal(out.amountUsd, 0);
});

test("balances use spot with source and time", async () => {
  const service = createPriceService({ spotReaders: spotReaders({ BNB: 800 }), fetchImpl: failingFetch, nowMs: () => NOW, env: {}, historyCache: new Map() });
  const out = await service.valueAtSpot("WBNB", "0.25");
  assert.equal(out.amountUsd, 200);
  assert.equal(out.priceBasis, "current");
  assert.equal(out.priceAt, new Date(NOW - 5000).toISOString());
  const stable = await service.valueAtSpot("USDC", "12.5");
  assert.equal(stable.amountUsd, 12.5);
});

test("history is cached for closed hours and not fetched when fetching is off", async () => {
  const calls = [];
  const cache = new Map();
  const service = createPriceService({ spotReaders: spotReaders({ SOL: 200 }), fetchImpl: klineFetch({ [H1]: 100 }, calls), nowMs: () => NOW, env: {}, historyCache: cache });
  await service.valueEvents("SOL", [{ hour: H1, raw: "1000000000" }], 9);
  await service.valueEvents("SOL", [{ hour: H1, raw: "1000000000" }], 9);
  assert.equal(calls.length, 1);

  const offCalls = [];
  const off = createPriceService({ spotReaders: spotReaders({ SOL: 200 }), fetchImpl: klineFetch({ [H2]: 100 }, offCalls), nowMs: () => NOW, env: { SOL_USD_PRICE_FETCH: "0" }, historyCache: new Map() });
  const out = await off.valueEvents("SOL", [{ hour: H2, raw: "1000000000" }], 9);
  assert.equal(offCalls.length, 0);
  assert.equal(out.priceBasis, "current");
});

test("the current, unfinished hour is never taken from history", async () => {
  const current = Math.floor(NOW / HOUR) * HOUR;
  const service = createPriceService({ spotReaders: spotReaders({ SOL: 200 }), fetchImpl: klineFetch({ [current]: 1 }), nowMs: () => NOW, env: {}, historyCache: new Map() });
  const out = await service.valueEvents("SOL", [{ hour: current, raw: "1000000000" }], 9);
  assert.equal(out.amountUsd, 200);
});

test("all chains: USD adds up across chains, native only per chain and asset", () => {
  const perChain = [
    buildTotals([{ chainId: 101, chain: "solana", asset: "SOL", amount: "1.5", amountUsd: 300 }], { seed: [{ chainId: 101, chain: "solana" }] }),
    buildTotals([
      { chainId: 56, chain: "bnb", asset: "BNB", amount: "0.1", amountUsd: 80 },
      { chainId: 56, chain: "bnb", asset: "BNB", amount: "0.2", amountUsd: 160 },
    ], { seed: [{ chainId: 56, chain: "bnb" }] }),
    buildTotals([], { seed: [{ chainId: 4663, chain: "robinhood" }] }),
  ];
  const all = mergeTotals(perChain);
  assert.equal(all.amountUsd, 540);
  assert.deepEqual(all.byChain.map((c) => c.chainId), [101, 56, 4663]);
  const bnb = all.byChain.find((c) => c.chainId === 56);
  assert.equal(bnb.assets[0].amountNative, "0.3");
  assert.equal(all.byChain.find((c) => c.chainId === 4663).amountUsd, null);
  // Native mode: there is no cross-chain native sum anywhere in the payload.
  assert.equal("amountNative" in all, false);
  assert.ok(all.byChain.every((c) => !("amountNative" in c)));
});

test("amounts without a price are counted and left out of the USD total; unread amounts too", () => {
  const totals = buildTotals([
    { chainId: 101, chain: "solana", asset: "SOL", amount: "2", amountUsd: 400 },
    { chainId: 101, chain: "solana", asset: "K88", amount: "1000", amountUsd: null },
    { chainId: 56, chain: "bnb", asset: "BNB", amount: null, amountUsd: null },
  ]);
  assert.equal(totals.amountUsd, 400);
  assert.equal(totals.missingPriceCount, 1);
  assert.equal(totals.unknownAmountCount, 1);
  assert.equal(totals.byChain.find((c) => c.chainId === 101).assets.find((a) => a.asset === "K88").amountUsd, null);
});

test("nothing priced: the USD total is null, not 0", () => {
  const totals = buildTotals([{ chainId: 4663, chain: "robinhood", asset: "ETH", amount: "1", amountUsd: null }]);
  assert.equal(totals.amountUsd, null);
  assert.equal(totals.missingPriceCount, 1);
});

test("decimal strings add exactly", () => {
  assert.equal(addDecimalStrings("0.1", "0.2"), "0.3");
  assert.equal(addDecimalStrings("0.000000000000000001", "1"), "1.000000000000000001");
  assert.equal(addDecimalStrings("0", "0"), "0");
  assert.equal(addDecimalStrings("2.5", "0.5"), "3");
});

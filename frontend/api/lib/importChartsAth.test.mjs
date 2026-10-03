import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
const { createCandleSource } = await import("./arenaImportCandles.js");
const { warmImportChartsOnce } = await import("./importChartWarmer.js");
const { athFromDailyCandles } = await import("./arenaImportMarketFeed.js");

const ohlcv = (n = 3) => ({ data: { attributes: { ohlcv_list: Array.from({ length: n }, (_, i) => [1790000000 - i * 3600, 1, 2, 0.5, 1.5, 10]) } } });
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });

test("upstream 429 answers rateLimited (client retries) instead of throwing a 502", async () => {
  const src = createCandleSource({ env: {}, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  const bars = await src.bars({ network: "solana", pairAddress: "P", tokenAddress: "T", resolution: "1h" });
  assert.deepEqual([bars.bars.length, bars.rateLimited], [0, true]);
  const trades = await src.trades({ network: "solana", pairAddress: "P", tokenAddress: "T", chainId: 101 });
  assert.equal(trades.rateLimited, true);
  const broken = createCandleSource({ env: {}, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await assert.rejects(broken.bars({ network: "solana", pairAddress: "P", tokenAddress: "T", resolution: "1h" }), /GeckoTerminal 500/);
});

test("free tier: 12 calls a minute; warm() never spends the last 4 (kept for people opening coins)", async () => {
  let t = 0;
  let calls = 0;
  const src = createCandleSource({ env: {}, now: () => t, fetchImpl: async () => { calls += 1; return okRes(ohlcv()); } });
  assert.equal(src.budgetLeft(), 12);
  let warmed = 0;
  for (let i = 0; i < 20; i += 1) if (await src.warm({ network: "solana", pairAddress: `P${i}`, tokenAddress: "T" })) warmed += 1;
  assert.equal(warmed, 8);
  assert.equal(src.budgetLeft(), 4);
  assert.equal((await src.bars({ network: "solana", pairAddress: "X", tokenAddress: "T", resolution: "1h" })).bars.length, 3, "a person still gets a fresh chart");
  assert.equal(await src.warm({ network: "solana", pairAddress: "P0", tokenAddress: "T" }), false, "fresh enough: not refetched");
  t += 11 * 60_000;
  assert.equal(await src.warm({ network: "solana", pairAddress: "P0", tokenAddress: "T" }), true, "older than 10 minutes: refreshed");
  assert.equal(calls, 10);
});

test("warmer warms busiest imports with a pool on charted chains, within the budget", async () => {
  const warmedPairs = [];
  let left = 6;
  const source = {
    budgetLeft: () => left,
    warm: async ({ network, pairAddress }) => { warmedPairs.push(`${network}:${pairAddress}`); left -= 1; return true; },
  };
  const pool = { query: async (text) => {
    assert.match(text, /i\.status = 'passed' and coalesce\(s\.pair_address, ''\) <> ''/);
    assert.match(text, /order by s\.volume_24h_usd desc nulls last/);
    return { rows: [
      { chain_id: 101, token_address: "A", pair_address: "pa" },
      { chain_id: 97, token_address: "B", pair_address: "pb" },
      { chain_id: 56, token_address: "C", pair_address: "pc" },
      { chain_id: 4663, token_address: "D", pair_address: "pd" },
    ] };
  } };
  const out = await warmImportChartsOnce({ pool, source });
  assert.deepEqual(warmedPairs, ["solana:pa", "bsc:pc"], "testnet skipped; stops when only the reserve is left");
  assert.equal(out.warmed, 2);
});

test("ATH seed: highest daily high times today's supply; nothing without data", () => {
  const bars = [{ h: 0.002 }, { h: 0.01 }, { h: 0.004 }];
  // market cap 50,000 at price 0.005 -> supply 10,000,000 -> ATH 0.01 x 10M = 100,000
  assert.equal(athFromDailyCandles(bars, 50_000, 0.005), 100_000);
  assert.equal(athFromDailyCandles([], 50_000, 0.005), null);
  assert.equal(athFromDailyCandles(bars, 0, 0.005), null);
  assert.equal(athFromDailyCandles(bars, 50_000, null), null);
});

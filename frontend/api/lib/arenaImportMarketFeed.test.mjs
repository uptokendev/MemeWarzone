import assert from "node:assert/strict";
import test from "node:test";

import { countSolanaHolders, dexScreenerChainSlug, geckoMarket, geckoTerminalNetwork, pickDeepestPair, refreshImportMarketStats } from "./arenaImportMarketFeed.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";

const DAVE = "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS";
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

const pair = (over = {}) => ({
  dexId: "meteora",
  pairAddress: "PAIR1",
  baseToken: { address: DAVE },
  priceUsd: "0.00006017",
  marketCap: 57770,
  fdv: 57770,
  liquidity: { usd: 20129.38 },
  volume: { h24: 4.75 },
  ...over,
});

test("the deepest pair where the token is the base asset supplies its figures", () => {
  const picked = pickDeepestPair(101, DAVE, [
    pair({ pairAddress: "SHALLOW", liquidity: { usd: 900 } }),
    pair(),
    pair({ pairAddress: "QUOTE_SIDE", baseToken: { address: "So11111111111111111111111111111111111111112" }, liquidity: { usd: 9e9 } }),
  ]);
  assert.equal(picked.pairAddress, "PAIR1");
  assert.equal(picked.marketCapUsd, 57770);
  assert.equal(picked.liquidityUsd, 20129.38);
  assert.equal(picked.volume24hUsd, 4.75);
  // Solana addresses are case-sensitive.
  assert.equal(pickDeepestPair(101, DAVE.toLowerCase(), [pair()]), null);
  assert.equal(pickDeepestPair(56, "0xABC", [pair({ baseToken: { address: "0xabc" } })]).pairAddress, "PAIR1");
  assert.equal(pickDeepestPair(101, DAVE, [pair({ marketCap: null, fdv: 1234 })]).marketCapUsd, 1234);
});

test("chains: all three are covered by DexScreener and GeckoTerminal", () => {
  assert.equal(dexScreenerChainSlug(101, {}), "solana");
  assert.equal(dexScreenerChainSlug(56, {}), "bsc");
  assert.equal(dexScreenerChainSlug(4663, {}), "robinhood");
  assert.equal(dexScreenerChainSlug(97, {}), null);
  assert.equal(dexScreenerChainSlug(56, { DEXSCREENER_CHAIN_56: "bnb" }), "bnb");
  assert.deepEqual([101, 56, 4663, 46630].map(geckoTerminalNetwork), ["solana", "bsc", "robinhood", null]);
});

test("GeckoTerminal fallback: market cap, else FDV; no value means no market", () => {
  assert.deepEqual(geckoMarket({ market_cap_usd: null, fdv_usd: "61338.07", total_reserve_in_usd: "10548.65", volume_usd: { h24: "5.45" }, price_usd: "0.0000613" }), {
    priceUsd: 0.0000613, marketCapUsd: 61338.07, liquidityUsd: 10548.65, volume24hUsd: 5.45, pairAddress: null, dexId: "geckoterminal",
  });
  assert.equal(geckoMarket({ market_cap_usd: null, fdv_usd: null }), null);
  assert.equal(geckoMarket(null), null);
});

function dasFetch(owners) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const page = body.params.page;
    const accounts = page === 1 ? owners.map((o, i) => ({ owner: o, amount: i === 0 ? "0" : "5" })) : [];
    return { ok: true, json: async () => ({ result: { token_accounts: accounts } }) };
  };
}

test("holders are owners with a positive balance; a non-DAS RPC yields null, not zero", async () => {
  assert.equal(await countSolanaHolders("https://rpc", DAVE, dasFetch(["a", "b", "c", "c"])), 2);
  const notDas = async () => ({ ok: true, json: async () => ({ error: { code: -32601 } }) });
  assert.equal(await countSolanaHolders("https://rpc", DAVE, notDas), null);
  assert.equal(await countSolanaHolders("", DAVE, notDas), null);
});

test("a feed pass covers Solana, Robinhood and BNB, falls back to GeckoTerminal, and skips the unlisted", async () => {
  const writes = [];
  const geckoCalls = [];
  const pool = {
    query: async (text, params) => {
      if (/from public\.arena_token_imports i/.test(text)) {
        return { rows: [
          { chain_id: 101, token_address: DAVE, holders: null, holders_updated_at: null },
          { chain_id: 101, token_address: "Unlisted1111111111111111111111111111111111", holders: null, holders_updated_at: null },
          { chain_id: 4663, token_address: "0xRh", holders: null, holders_updated_at: null },
          { chain_id: 56, token_address: "0xBnb", holders: null, holders_updated_at: null },
        ] };
      }
      writes.push(params);
      return { rows: [] };
    },
  };
  const ok = (body) => ({ ok: true, json: async () => body });
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://api.dexscreener.com/tokens/v1/solana/")) return ok([pair()]);
    if (u.startsWith("https://api.dexscreener.com/tokens/v1/robinhood/")) return ok([pair({ baseToken: { address: "0xrh" }, marketCap: 250000, liquidity: { usd: 40000 } })]);
    if (u.startsWith("https://api.dexscreener.com/tokens/v1/bsc/")) return ok([]);
    if (u.startsWith("https://api.geckoterminal.com/")) {
      geckoCalls.push(u.replace("https://api.geckoterminal.com/api/v2", ""));
      if (u.endsWith("/networks/bsc/tokens/0xBnb")) return ok({ data: { attributes: { market_cap_usd: "90000", total_reserve_in_usd: "12000", volume_usd: { h24: "300" }, price_usd: "0.01" } } });
      if (u.endsWith("/networks/robinhood/tokens/0xRh/info")) return ok({ data: { attributes: { holders: { count: 321 } } } });
      if (u.endsWith("/networks/bsc/tokens/0xBnb/info")) return ok({ data: { attributes: { holders: { count: 77 } } } });
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return dasFetch(["x", "y", "z"])(url, init);
  };
  const summary = await refreshImportMarketStats({ pool, env: { SOLANA_RPC_URL: "https://rpc" }, fetchImpl, nowMs: NOW });
  assert.deepEqual(summary, { updated: 3, unlisted: 1, errors: [] });
  const byToken = Object.fromEntries(writes.map((w) => [w[1], { mcap: w[3], liq: w[4], holders: w[6], source: w[10] }]));
  assert.deepEqual(byToken[DAVE], { mcap: 57770, liq: 20129.38, holders: 2, source: "dexscreener" });
  assert.deepEqual(byToken["0xRh"], { mcap: 250000, liq: 40000, holders: 321, source: "dexscreener" });
  assert.deepEqual(byToken["0xBnb"], { mcap: 90000, liq: 12000, holders: 77, source: "geckoterminal" });
  // Solana holders came from Helius, so GeckoTerminal was asked only where it had to be.
  assert.ok(!geckoCalls.some((c) => c.includes(DAVE)));
});

test("GeckoTerminal calls are capped per pass, so the free rate limit is never exceeded", async () => {
  const pool = {
    query: async (text) => (/arena_token_imports i/.test(text)
      ? { rows: Array.from({ length: 30 }, (_, i) => ({ chain_id: 56, token_address: `0x${i}`, holders: null, holders_updated_at: null })) }
      : { rows: [] }),
  };
  let gecko = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("geckoterminal")) gecko += 1;
    return { ok: true, json: async () => (String(url).includes("dexscreener") ? [] : { data: { attributes: {} } }) };
  };
  await refreshImportMarketStats({ pool, env: {}, fetchImpl, nowMs: NOW });
  assert.equal(gecko, 20);
});

function snapshotQuery(importRow) {
  return async (text) => {
    if (/from public\.campaigns c/.test(text) && /c\.creator_address/.test(text)) return { rows: [] };
    if (/from public\.arena_token_imports/.test(text)) return { rows: [{ chain_id: 101, token_address: DAVE, owner_wallet: "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv", scan_json: {} }] };
    if (/from public\.arena_import_market_stats/.test(text)) return { rows: importRow ? [importRow] : [] };
    if (/token_holder_balances/.test(text)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  };
}
const deps = (row, nowMs = NOW) => ({ query: snapshotQuery(row), nowMs, resolveNativeUsd: async () => ({ price: 150, source: "test" }) });

test("an imported token with a fresh feed row is healthy market data for battles", async () => {
  const snap = await getArenaMarketSnapshot(101, DAVE, deps({ market_cap_usd: 57770, liquidity_usd: 20129.38, volume_24h_usd: 4.75, holders: 159, updated_at: new Date(NOW - 30_000).toISOString() }));
  assert.equal(snap.healthy, true, JSON.stringify(snap.reasons));
  assert.equal(snap.origin, "import");
  assert.equal(snap.dataSource, "import_market_feed");
  assert.equal(snap.marketCapUsd, 57770);
  assert.equal(snap.holders, 159);
  assert.equal(snap.creatorAddress, "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv");
});

test("no feed row, a stale row, or unknown holders are not healthy -- and holders never read as 0", async () => {
  assert.equal((await getArenaMarketSnapshot(101, DAVE, deps(null))).reason, "import_market_data_missing");
  const stale = await getArenaMarketSnapshot(101, DAVE, deps({ market_cap_usd: 1, liquidity_usd: 1, volume_24h_usd: 0, holders: 10, updated_at: new Date(NOW - 600_000).toISOString() }));
  assert.equal(stale.healthy, false);
  assert.ok(stale.reasons.includes("stale"));
  const noHolders = await getArenaMarketSnapshot(101, DAVE, deps({ market_cap_usd: 1, liquidity_usd: 1, volume_24h_usd: 0, holders: null, updated_at: new Date(NOW).toISOString() }));
  assert.equal(noHolders.holders, null);
  assert.ok(noHolders.reasons.includes("holders_missing"));
});

test("live baselines store an integer data lag (an import's lag is fractional seconds)", async () => {
  const { captureLiveBaselines } = await import("./arenaBattleMetrics.js");
  const seen = [];
  const snap = { marketCapUsd: 1000, holders: 30, liquidityUsd: 5000, updatedAt: new Date(NOW).toISOString(), dataLagSeconds: 4.619, dataSource: "import_market_feed", healthy: true };
  await captureLiveBaselines(
    { id: "b1", state: "live", chain_id: 101, started_at: new Date(NOW).toISOString(), challenger_token: DAVE, defender_token: "Other111111111111111111111111111111111111111" },
    { snapshots: { left: snap, right: snap }, query: async (sql, params) => { seen.push(params); return { rowCount: 2 }; } },
  );
  const lagParams = [seen[0][15], seen[0][33]];
  assert.deepEqual(lagParams, [5, 5]);
});

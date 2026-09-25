import assert from "node:assert/strict";
import test from "node:test";

import { countSolanaHolders, dexScreenerChainSlug, pickDeepestPair, refreshImportMarketStats } from "./arenaImportMarketFeed.js";
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

test("chains: Solana and BNB by default, Robinhood only once DexScreener lists it", () => {
  assert.equal(dexScreenerChainSlug(101, {}), "solana");
  assert.equal(dexScreenerChainSlug(56, {}), "bsc");
  assert.equal(dexScreenerChainSlug(4663, {}), null);
  assert.equal(dexScreenerChainSlug(4663, { DEXSCREENER_CHAIN_4663: "robinhood" }), "robinhood");
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

test("a feed pass writes listed imports, skips unlisted ones, and recounts holders when due", async () => {
  const writes = [];
  const pool = {
    query: async (text, params) => {
      if (/from public\.arena_token_imports i/.test(text)) {
        return { rows: [
          { chain_id: 101, token_address: DAVE, holders: null, holders_updated_at: null },
          { chain_id: 101, token_address: "Unlisted1111111111111111111111111111111111", holders: null, holders_updated_at: null },
          { chain_id: 4663, token_address: "0xrh", holders: null, holders_updated_at: null },
        ] };
      }
      writes.push(params);
      return { rows: [] };
    },
  };
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://api.dexscreener.com/")) {
      assert.match(String(url), /\/solana\//);
      return { ok: true, json: async () => [pair()] };
    }
    return dasFetch(["x", "y", "z"])(url, init);
  };
  const summary = await refreshImportMarketStats({ pool, env: { SOLANA_RPC_URL: "https://rpc" }, fetchImpl, nowMs: NOW });
  assert.deepEqual(summary, { updated: 1, unlisted: 1, errors: [] });
  assert.equal(writes.length, 1);
  const [chainId, token, price, mcap, liq, vol, holders, holdersAt] = writes[0];
  assert.deepEqual([chainId, token, price, mcap, liq, vol, holders], [101, DAVE, 0.00006017, 57770, 20129.38, 4.75, 2]);
  assert.equal(holdersAt, new Date(NOW).toISOString());
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

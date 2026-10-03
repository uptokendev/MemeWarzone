import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
const { publicMarketImport } = await import("./arenaImports.js");

const base = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  chain_id: 56,
  token_address: "0xabc0000000000000000000000000000000000001",
  owner_wallet: "0xowner",
  name: "Coin",
  symbol: "CN",
  created_at: "2026-10-01T00:00:00Z",
  price_usd: "0.00012",
  market_cap_usd: "120000",
  liquidity_usd: "15000",
  volume_24h_usd: "8000",
  holders: 310,
  dex_id: "pancakeswap",
  pair_address: "0xpair",
  market_updated_at: "2026-10-03T10:00:00Z",
  scan_json: { hardFindings: [] },
};

test("maps a listed import with numeric USD stats", () => {
  const row = publicMarketImport(base);
  assert.equal(row.chainId, 56);
  assert.equal(row.marketCapUsd, 120000);
  assert.equal(row.volume24hUsd, 8000);
  assert.equal(row.holders, 310);
  assert.equal(row.dexId, "pancakeswap");
  assert.equal(row.tradingBlocked, false);
  assert.equal("scan_json" in row, false, "the scan itself is not published");
  assert.equal("ownerWallet" in row, false, "owner wallets stay off the public list, like /recent");
});

test("missing market stats read as null, not zero", () => {
  const row = publicMarketImport({ ...base, price_usd: null, market_cap_usd: null, liquidity_usd: null, volume_24h_usd: null, holders: null });
  assert.equal(row.marketCapUsd, null);
  assert.equal(row.volume24hUsd, null);
  assert.equal(row.holders, null);
});

test("a honeypot scan blocks trading, same rule as the coin page", () => {
  assert.equal(publicMarketImport({ ...base, scan_json: { hardFindings: [{ code: "honeypot_sell_failed" }] } }).tradingBlocked, true);
  assert.equal(publicMarketImport({ ...base, scan_json: null }).tradingBlocked, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbcProgressPct, readAccounts, solanaProgressRpcUrls, withSolanaLaunchpadMarketCap } from "./solanaCampaignProgress.js";

test("RPC list: SOLANA_RPC_URL entries first, then the other mainnet names, http only, no duplicates", () => {
  const urls = solanaProgressRpcUrls({
    SOLANA_RPC_URL: "https://a.example, https://b.example",
    SOLANA_RPC_HTTP: "https://a.example",
    SOLANA_MAINNET_RPC: "not-a-url",
    VITE_SOLANA_RPC: "https://c.example",
  });
  assert.deepEqual(urls, ["https://a.example", "https://b.example", "https://c.example"]);
});

test("a refusing first RPC falls through to the next one instead of leaving every card at 0%", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === "https://dead.example") return { ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) };
    return { ok: true, status: 200, json: async () => ({ result: { value: [null] } }) };
  };
  const out = await readAccounts(["Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA"], { urls: ["https://dead.example", "https://live.example"], fetchImpl });
  assert.deepEqual(seen, ["https://dead.example", "https://live.example"]);
  assert.equal(out.size, 1);
});

test("every RPC refusing throws, so the caller logs it instead of silently reporting nothing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(readAccounts(["x"], { urls: ["https://dead.example"], fetchImpl }), /HTTP 403/);
});

const fixture = (name) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../shared/fixtures", name), "utf8").trim();
// Real mainnet accounts read 2026-10-06: KAIJU88's launchpad Campaign, DAZILLA's Meteora DBC pool and config.
const KAIJU = "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA";
const DAZILLA_POOL = "CAfqxMHTZc4YHdApxgxbMbUpV6U8CTKo8uoixa92DcaS";
const DAZILLA_CONFIG = "6GdLrNUhNWe2vqp3Hr75pcfMzzc65qruPjRoCERDeHAy";
const accounts = {
  [KAIJU]: { owner: "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt", data: [fixture("kaiju88-campaign-account.b64"), "base64"] },
  [DAZILLA_POOL]: { owner: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", data: [fixture("dazilla-dbc-pool-account.b64"), "base64"] },
  [DAZILLA_CONFIG]: { owner: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", data: [fixture("dazilla-dbc-config-account.b64"), "base64"] },
};
const chain = (overrides = {}) => async (_url, init) => {
  const [addresses] = JSON.parse(init.body).params;
  if (overrides.refuse?.some((a) => addresses.includes(a))) return { ok: false, status: 429, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ result: { value: addresses.map((a) => accounts[a] ?? null) } }) };
};

test("a DBC pool in the list no longer blanks every Solana card: both coins get their own progress", async () => {
  const out = await readAccounts([KAIJU, DAZILLA_POOL], { urls: ["https://live.example"], fetchImpl: chain() });
  assert.ok(out.get(KAIJU)?.curveTokenSupply > 0n, "KAIJU88 still decodes as a launchpad curve");
  const pool = out.get(DAZILLA_POOL);
  assert.equal(pool.launchType, "dbc");
  // The fixture pool holds 28.530175447 SOL against its config's 124.408396605 SOL threshold, the
  // same pair /api/dbc/create?live=1 hands the coin page (which then read 35.11 SOL = 28.22%).
  assert.equal(pool.quoteReserve, 28_530_175_447n);
  assert.equal(pool.threshold, 124_408_396_605n);
  assert.equal(dbcProgressPct(pool), 22.9326, "floored to 4 decimals, the coin page's own rounding");
});

test("a refused DBC config read leaves the launchpad coin's curve intact", async () => {
  const out = await readAccounts([KAIJU, DAZILLA_POOL], { urls: ["https://live.example"], fetchImpl: chain({ refuse: [DAZILLA_CONFIG] }) });
  assert.ok(out.get(KAIJU)?.curveTokenSupply > 0n);
});

test("launchpad market cap: price x post-graduation supply on the card, list and ATH; DBC coins untouched", async () => {
  const items = [
    { chainId: 101, campaignAddress: KAIJU, lastPriceBnb: "0.0000002247883802", athPriceBnb: "0.00000024", marketcapBnb: "59.18" },
    { chainId: 101, campaignAddress: DAZILLA_POOL, lastPriceBnb: "0.00000023", marketcapBnb: "178.55", athMarketcapBnb: "274.49" },
  ];
  const fetchImpl = chain();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  process.env.SOLANA_RPC_URL = "https://live.example";
  try {
    await withSolanaLaunchpadMarketCap(items, 120.4);
  } finally {
    globalThis.fetch = realFetch;
  }
  const [kaiju, dazilla] = items;
  // 540.25M sold by the $15k close + 140M pool liquidity + 20M creator reserve = ~700.25M (not 1B, not 263M sold).
  assert.ok(Math.abs(Number(kaiju.fullyDilutedSupply) - 700_249_328) < 1, kaiju.fullyDilutedSupply);
  assert.ok(Math.abs(Number(kaiju.marketcapBnb) - 0.0000002247883802 * Number(kaiju.fullyDilutedSupply)) < 1e-9);
  assert.ok(Math.abs(Number(kaiju.athMarketcapBnb) - 0.00000024 * Number(kaiju.fullyDilutedSupply)) < 1e-9);
  assert.equal(dazilla.fullyDilutedSupply, undefined);
  assert.equal(dazilla.marketcapBnb, "178.55");
});

test("no SOL price leaves launchpad market caps as they were", async () => {
  const items = [{ chainId: 101, campaignAddress: KAIJU, lastPriceBnb: "0.0000002", marketcapBnb: "59.18" }];
  await withSolanaLaunchpadMarketCap(items, null);
  assert.equal(items[0].marketcapBnb, "59.18");
  assert.equal(items[0].fullyDilutedSupply, undefined);
});

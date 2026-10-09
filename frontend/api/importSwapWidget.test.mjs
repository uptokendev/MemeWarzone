import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
const { widgetCors, widgetRateLimiter, widgetQuote } = await import("./importSwapWidget.js");

function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    end(data) { this.body = data ?? null; },
  };
}

test("widget CORS: any origin, no credentials, preflight answered", () => {
  const res = fakeRes();
  let nexted = false;
  widgetCors({ method: "OPTIONS", headers: { origin: "https://some-coin.site" } }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  assert.equal(nexted, false);
  const get = fakeRes();
  widgetCors({ method: "GET", headers: {}, ip: "10.0.0.1" }, get, () => { nexted = true; });
  assert.equal(nexted, true);
});

test("rate limit: fixed one-minute window per IP", () => {
  let t = 0;
  const allow = widgetRateLimiter({ limit: 3, now: () => t });
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a"), allow("b")], [true, true, true, false, true]);
  t = 60_000;
  assert.equal(allow("a"), true);
});

test("the widget only swaps Solana coins", async () => {
  const res = fakeRes();
  await widgetQuote({ method: "POST", body: { chainId: 56, token: "0x0", side: "buy", amountRaw: "1" }, headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /Solana/);
});

test("coin kind: our launchpad / DBC coins are bonding while on the curve; graduated, migrated and non-SOL DBC are not tradable here", async () => {
  const { bondingCoin } = await import("./importSwapWidget.js");
  const row = (over) => ({ launch_type: "launchpad", campaign_address: "Camp", creator_address: "Cre", name: "K", symbol: "K", logo_uri: null, bonding_active: true, market_stage: "BONDING", graduated_at_chain: null, dbc_quote_mint: null, dbc_migration: null, ...over });
  const db = (r) => ({ query: async () => ({ rows: r ? [r] : [] }) });
  assert.equal(await bondingCoin("m", db(null)), null, "not ours: the import path");
  const lp = await bondingCoin("m", db(row({})));
  assert.deepEqual([lp.kind, lp.tradable, lp.campaignAddress, lp.creator], ["launchpad", true, "Camp", "Cre"]);
  assert.match(lp.pageUrl, /\/token\/Camp\?chainId=101$/);
  assert.equal((await bondingCoin("m", db(row({ market_stage: "GRADUATED", bonding_active: false })))).reason, "graduated");
  const dbc = await bondingCoin("m", db(row({ launch_type: "dbc", dbc_quote_mint: "So11111111111111111111111111111111111111112" })));
  assert.deepEqual([dbc.kind, dbc.tradable], ["dbc", true]);
  assert.equal((await bondingCoin("m", db(row({ launch_type: "dbc", dbc_migration: { pool: "x" } })))).reason, "graduated");
  assert.equal((await bondingCoin("m", db(row({ launch_type: "dbc", dbc_quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })))).reason, "quote");
});

test("claim link: the imported coin's page with its claim dialog open", async () => {
  const { importClaimUrl } = await import("./importSwapWidget.js");
  assert.equal(importClaimUrl("Mint111"), "https://app.memewar.zone/token/Mint111?chainId=101&claim=prompt");
});

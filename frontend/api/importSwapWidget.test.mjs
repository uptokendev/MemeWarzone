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

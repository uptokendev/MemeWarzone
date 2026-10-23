// Admin reads for the swap widget: bearer with finance.view only, input checks, and the read model is called with the
// parsed window. No database (the read models are tested in api/lib/widgetAnalytics.db.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { widgetUsage } = await import("./widget.js");
const { financeWidget } = await import("./finance.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
const viewer = { isOwner: false, permissions: ["finance.view"] };
const analyst = { isOwner: false, permissions: ["analytics.view"] };

test("usage: 401 without a dashboard principal or without finance.view; 405 for writes", async () => {
  for (const principal of [undefined, analyst]) {
    const res = fakeRes();
    await widgetUsage({ method: "GET", query: {}, dashboardPrincipal: principal }, res, { build: async () => assert.fail("must not read") });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "FINANCE_VIEW_REQUIRED");
  }
  const res = fakeRes();
  await widgetUsage({ method: "POST", query: {}, dashboardPrincipal: viewer }, res);
  assert.equal(res.statusCode, 405);
});

test("usage: window, chain and partner filters are parsed; bad values are a 400", async () => {
  let seen = null;
  const build = async (input) => { seen = input; return { ok: true }; };
  const res = fakeRes();
  await widgetUsage({ method: "GET", query: { from: "2026-10-01", to: "2026-10-07T23:59:59.999Z", chainId: "56", partner: "none" }, dashboardPrincipal: viewer }, res, { db: {}, build });
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ from: seen.from, to: seen.to, chainId: seen.chainId, partner: seen.partner }, { from: "2026-10-01", to: "2026-10-07", chainId: 56, partner: "" });
  await widgetUsage({ method: "GET", query: { partner: "CrypticPump", chainId: "all" }, dashboardPrincipal: viewer }, fakeRes(), { db: {}, build });
  assert.equal(seen.partner, "crypticpump");
  assert.equal(seen.chainId, null);
  for (const query of [{ chainId: "1" }, { partner: "-x" }, { from: "yesterday" }, { from: "2026-10-09", to: "2026-10-01" }]) {
    const bad = fakeRes();
    await widgetUsage({ method: "GET", query, dashboardPrincipal: viewer }, bad, { db: {}, build });
    assert.equal(bad.statusCode, 400, JSON.stringify(query));
  }
});

test("finance widget: finance.view bearer only; the window and the price service reach the read model; failures are a 500", async () => {
  const res = fakeRes();
  await financeWidget({ method: "GET", query: {}, dashboardPrincipal: analyst }, res, { build: async () => assert.fail("must not read") });
  assert.equal(res.statusCode, 401);
  let seen = null;
  const prices = { valueEvents: async () => ({ amountUsd: 0 }) };
  const ok = fakeRes();
  await financeWidget({ method: "GET", query: { from: "2026-10-01", to: "2026-10-02" }, dashboardPrincipal: viewer }, ok, { db: {}, prices, build: async (input) => { seen = input; return { ok: true }; } });
  assert.equal(ok.statusCode, 200);
  assert.equal(seen.from, "2026-10-01");
  assert.equal(seen.to, "2026-10-02");
  assert.equal(seen.prices, prices);
  const err = console.error;
  console.error = () => {};
  try {
    const failed = fakeRes();
    await financeWidget({ method: "GET", query: {}, dashboardPrincipal: viewer }, failed, { db: {}, prices, build: async () => { throw new Error("boom"); } });
    assert.equal(failed.statusCode, 500);
  } finally {
    console.error = err;
  }
});

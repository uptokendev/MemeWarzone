import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { authorize } = await import("./lp-fees.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

const principal = (permissions) => ({ isOwner: false, permissions, email: "ops@example.com" });
const req = (query, extra = {}) => ({ method: "GET", url: `/api/dashboard/lp-fees?${new URLSearchParams(query)}`, headers: {}, query, ...extra });

test("mainnet read without bearer, ops key or creator: 401", async () => {
  const res = fakeRes();
  assert.equal(await authorize(req({ chainId: "56" }), res), null);
  assert.equal(res.statusCode, 401);
});

test("dashboard principal without finance.view: 403", async () => {
  const res = fakeRes();
  assert.equal(await authorize(req({ chainId: "56" }, { dashboardPrincipal: principal(["community.manage"]) }), res), null);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.permission, "finance.view");
});

test("dashboard principal with finance.view passes", async () => {
  const res = fakeRes();
  const auth = await authorize(req({ chainId: "56" }, { dashboardPrincipal: principal(["finance.view"]) }), res);
  assert.equal(auth.mode, "admin");
  assert.equal(res.statusCode, 0);
});

test("unchanged: ops key, testnet-open and creator-self modes", async () => {
  const saved = process.env.DASHBOARD_OPS_KEY;
  process.env.DASHBOARD_OPS_KEY = "ops-secret";
  try {
    assert.deepEqual(await authorize(req({ chainId: "56" }, { headers: { "x-ops-key": "ops-secret" } }), fakeRes()), { mode: "ops-key" });
    assert.deepEqual(await authorize(req({ chainId: "97" }), fakeRes()), { mode: "testnet-open" });
    assert.deepEqual(await authorize(req({ chainId: "46630" }), fakeRes()), { mode: "testnet-open" });
    const creator = "0x00000000000000000000000000000000000000AB";
    assert.deepEqual(await authorize(req({ chainId: "56", creator }), fakeRes()), { mode: "creator-self", creator: creator.toLowerCase() });
  } finally {
    if (saved == null) delete process.env.DASHBOARD_OPS_KEY; else process.env.DASHBOARD_OPS_KEY = saved;
  }
});

import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
delete process.env.API_RAILWAY_PROXY;
delete process.env.RAILWAY_API_PROXY;
delete process.env.VITE_API_RAILWAY_PROXY;

const { createRailwayProxyMiddleware } = await import("./railwayProxy.js");
const middleware = createRailwayProxyMiddleware({ serviceName: "test" });

function fakeRes() {
  return {
    statusCode: 0, body: null, headersSent: false, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  };
}

async function run(path, { method = "GET", headers = {} } = {}) {
  const res = fakeRes();
  let nextCalled = false;
  await middleware({ method, url: path, originalUrl: path, headers, query: {} }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function withOpsKey(fn) {
  const saved = process.env.DASHBOARD_OPS_KEY;
  process.env.DASHBOARD_OPS_KEY = "ops-secret";
  try { return await fn(); } finally {
    if (saved == null) delete process.env.DASHBOARD_OPS_KEY; else process.env.DASHBOARD_OPS_KEY = saved;
  }
}

const COMMAND_CENTER_SECURITY = [
  ["GET", "/api/security/creators"],
  ["GET", "/api/security/clusters"],
  ["GET", "/api/security/manual-review"],
  ["GET", "/api/security/mass-deployers"],
  ["GET", "/api/security/audit-log"],
  ["GET", "/api/security/contracts/sync-jobs?chain=bnb"],
  ["POST", "/api/security/creator/0x0000000000000000000000000000000000000001/tier"],
  ["POST", "/api/security/creator/0x0000000000000000000000000000000000000001/restrict"],
  ["POST", "/api/security/creator/0x0000000000000000000000000000000000000001/manual-review"],
  ["POST", "/api/security/cluster/abc/restrict"],
  ["POST", "/api/security/wallet/0x0000000000000000000000000000000000000001/restrict"],
  ["POST", "/api/security/contracts/pause-campaign"],
  ["POST", "/api/security/solana/pause-buys"],
];

for (const [method, path] of COMMAND_CENTER_SECURITY) {
  test(`security: no bearer and no ops key is refused before the route: ${method} ${path}`, async () => {
    await withOpsKey(async () => {
      const { res, nextCalled } = await run(path, { method });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, "DASHBOARD_SIGN_IN_REQUIRED");
      assert.equal(res.body.permission, method === "GET" ? "security.view" : "security.manage");
    });
  });

  test(`security: the ops key still reaches the route: ${method} ${path}`, async () => {
    await withOpsKey(async () => {
      const ok = await run(path, { method, headers: { "x-ops-key": "ops-secret" } });
      assert.equal(ok.nextCalled, true);
      const wrong = await run(path, { method, headers: { "x-ops-key": "nope" } });
      assert.equal(wrong.nextCalled, false);
      assert.equal(wrong.res.statusCode, 401);
    });
  });
}

for (const path of [
  "/api/security/status",
  "/api/security/creator/0x0000000000000000000000000000000000000001/profile",
  "/api/security/creator/0x0000000000000000000000000000000000000001/launch-eligibility",
]) {
  test(`security: the launch app's public read stays open without a bearer: ${path}`, async () => {
    await withOpsKey(async () => {
      const { nextCalled, res } = await run(path);
      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, 0);
    });
  });
}

test("security: a look-alike path does not inherit the public exemption", async () => {
  await withOpsKey(async () => {
    const { nextCalled, res } = await run("/api/security/status/extra");
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test("diagnostics: no bearer passes the gate so the handler can check the token", async () => {
  const { nextCalled } = await run("/api/diagnostics?token=x");
  assert.equal(nextCalled, true);
});

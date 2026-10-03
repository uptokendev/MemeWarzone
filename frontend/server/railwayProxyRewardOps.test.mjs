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

for (const path of [
  "/api/admin/rewards/overview",
  "/api/admin/rewards/ledger?chain=101",
  "/api/admin/rewards/publications",
  "/api/admin/rewards/routing",
  "/api/security/recruiter-payouts",
]) {
  test(`no bearer and no ops key is refused before the route: ${path}`, async () => {
    const saved = process.env.DASHBOARD_OPS_KEY;
    process.env.DASHBOARD_OPS_KEY = "ops-secret";
    try {
      const { res, nextCalled } = await run(path);
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, "DASHBOARD_SIGN_IN_REQUIRED");
      const post = await run(path, { method: "POST" });
      assert.equal(post.nextCalled, false);
      assert.equal(post.res.statusCode, 401);
    } finally {
      if (saved == null) delete process.env.DASHBOARD_OPS_KEY; else process.env.DASHBOARD_OPS_KEY = saved;
    }
  });
}

test("the ops key still reaches the route (server-to-server)", async () => {
  const saved = process.env.DASHBOARD_OPS_KEY;
  process.env.DASHBOARD_OPS_KEY = "ops-secret";
  try {
    const { res, nextCalled } = await run("/api/security/recruiter-payouts", { headers: { "x-ops-key": "ops-secret" } });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
    const wrong = await run("/api/security/recruiter-payouts", { headers: { "x-ops-key": "nope" } });
    assert.equal(wrong.nextCalled, false);
    assert.equal(wrong.res.statusCode, 401);
  } finally {
    if (saved == null) delete process.env.DASHBOARD_OPS_KEY; else process.env.DASHBOARD_OPS_KEY = saved;
  }
});

test("unrelated routes keep the old no-bearer pass-through", async () => {
  const { nextCalled } = await run("/api/security/creators");
  assert.equal(nextCalled, true);
});

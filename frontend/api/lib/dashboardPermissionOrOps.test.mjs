import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { permissionForMethod, requireDashboardPermissionOrOpsKey, withDashboardPermissionOrOpsKey } = await import("./dashboardPermissionOrOps.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

const principal = (permissions) => ({ isOwner: false, permissions, email: "ops@example.com" });
const PERMS = { read: "finance.view", write: "finance.manage" };

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) { saved[key] = process.env[key]; if (values[key] == null) delete process.env[key]; else process.env[key] = values[key]; }
  try { return fn(); } finally { for (const key of Object.keys(saved)) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; } }
}

test("reads need the read permission, writes the write permission", () => {
  assert.equal(permissionForMethod("GET", PERMS), "finance.view");
  assert.equal(permissionForMethod("HEAD", PERMS), "finance.view");
  assert.equal(permissionForMethod("POST", PERMS), "finance.manage");
  assert.equal(permissionForMethod("DELETE", PERMS), "finance.manage");
});

test("no bearer, no ops key: refused even with enforcement switched off", () => {
  withEnv({ API_AUTH_ENFORCE_SECURITY_MUTATIONS: "0", API_AUTH_ENFORCE_INTERNAL: "0", DASHBOARD_OPS_KEY: "ops-secret", OPS_READ_KEY: null }, () => {
    const res = fakeRes();
    assert.equal(requireDashboardPermissionOrOpsKey({ headers: {}, query: {} }, res, "finance.view"), null);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "DASHBOARD_SIGN_IN_REQUIRED");
  });
});

test("no ops key configured: an empty provided key never matches", () => {
  withEnv({ DASHBOARD_OPS_KEY: null, OPS_READ_KEY: null }, () => {
    const res = fakeRes();
    assert.equal(requireDashboardPermissionOrOpsKey({ headers: { "x-ops-key": "" }, query: {} }, res, "finance.view"), null);
    assert.equal(res.statusCode, 401);
  });
});

test("server-to-server ops key keeps working", () => {
  withEnv({ DASHBOARD_OPS_KEY: "ops-secret", OPS_READ_KEY: null }, () => {
    const res = fakeRes();
    assert.deepEqual(requireDashboardPermissionOrOpsKey({ headers: { "x-ops-key": "ops-secret" }, query: {} }, res, "finance.manage"), { mode: "ops-key" });
    const wrong = fakeRes();
    assert.equal(requireDashboardPermissionOrOpsKey({ headers: { "x-ops-key": "ops-secreT" }, query: {} }, wrong, "finance.manage"), null);
    assert.equal(wrong.statusCode, 401);
  });
});

test("a principal without the permission is refused with 403", () => {
  const res = fakeRes();
  assert.equal(requireDashboardPermissionOrOpsKey({ headers: {}, dashboardPrincipal: principal(["community.manage"]) }, res, "finance.view"), null);
  assert.equal(res.statusCode, 403);
});

test("a principal with the permission passes", () => {
  const res = fakeRes();
  const auth = requireDashboardPermissionOrOpsKey({ headers: {}, dashboardPrincipal: principal(["finance.view"]) }, res, "finance.view");
  assert.equal(auth.mode, "admin");
  assert.equal(res.statusCode, 0);
});

test("wrapper: finance.view cannot write, finance.manage can", async () => {
  let calls = 0;
  const handler = withDashboardPermissionOrOpsKey(async (_req, res) => { calls += 1; res.status(200).json({ ok: true }); }, "test", PERMS);

  const denied = fakeRes();
  await handler({ method: "POST", headers: {}, dashboardPrincipal: principal(["finance.view"]) }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(calls, 0);

  const allowed = fakeRes();
  await handler({ method: "POST", headers: {}, dashboardPrincipal: principal(["finance.manage", "finance.view"]) }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { authorizeDiagnostics, DIAGNOSTICS_PERMISSION } = await import("./diagnosticsAuth.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

const principal = (permissions) => ({ isOwner: false, permissions, email: "ops@example.com" });

async function withToken(value, fn) {
  const saved = process.env.DIAGNOSTICS_TOKEN;
  if (value == null) delete process.env.DIAGNOSTICS_TOKEN; else process.env.DIAGNOSTICS_TOKEN = value;
  try { return await fn(); } finally {
    if (saved == null) delete process.env.DIAGNOSTICS_TOKEN; else process.env.DIAGNOSTICS_TOKEN = saved;
  }
}

test("no bearer and no token: 401", async () => {
  await withToken("diag-secret", async () => {
    const res = fakeRes();
    assert.equal(await authorizeDiagnostics({ headers: {}, query: {} }, res), null);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "DASHBOARD_SIGN_IN_REQUIRED");
  });
});

test("wrong token: 401", async () => {
  await withToken("diag-secret", async () => {
    const res = fakeRes();
    assert.equal(await authorizeDiagnostics({ headers: {}, query: { token: "diag-secreT" } }, res), null);
    assert.equal(res.statusCode, 401);
  });
});

test("unset DIAGNOSTICS_TOKEN: an empty token never matches", async () => {
  await withToken(null, async () => {
    const res = fakeRes();
    assert.equal(await authorizeDiagnostics({ headers: {}, query: { token: "" } }, res), null);
    assert.equal(res.statusCode, 401);
  });
});

test("the token keeps working via ?token= and x-diagnostics-token", async () => {
  await withToken("diag-secret", async () => {
    const q = await authorizeDiagnostics({ headers: {}, query: { token: "diag-secret" } }, fakeRes());
    assert.deepEqual(q, { mode: "token", token: "diag-secret" });
    const h = await authorizeDiagnostics({ headers: { "x-diagnostics-token": "diag-secret" }, query: {} }, fakeRes());
    assert.equal(h.mode, "token");
  });
});

test("gated principal without diagnostics.view: 403", async () => {
  const res = fakeRes();
  assert.equal(await authorizeDiagnostics({ headers: {}, query: {}, dashboardPrincipal: principal(["finance.view"]) }, res), null);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.permission, DIAGNOSTICS_PERMISSION);
});

test("gated principal with diagnostics.view passes", async () => {
  const res = fakeRes();
  const auth = await authorizeDiagnostics({ headers: {}, query: {}, dashboardPrincipal: principal(["diagnostics.view"]) }, res);
  assert.equal(auth.mode, "dashboard");
  assert.equal(res.statusCode, 0);
});

test("ungated bearer is resolved against diagnostics.view", async () => {
  let asked = null;
  const ok = await authorizeDiagnostics(
    { headers: { authorization: "Bearer jwt" }, query: {} },
    fakeRes(),
    { resolvePermission: async (_req, _res, permission) => { asked = permission; return principal(["diagnostics.view"]); } },
  );
  assert.equal(asked, "diagnostics.view");
  assert.equal(ok.mode, "dashboard");

  const denied = fakeRes();
  const refused = await authorizeDiagnostics(
    { headers: { authorization: "Bearer jwt" }, query: {} },
    denied,
    { resolvePermission: async (_req, res) => { res.status(403).json({ code: "DASHBOARD_PERMISSION_REQUIRED" }); return null; } },
  );
  assert.equal(refused, null);
  assert.equal(denied.statusCode, 403);
});

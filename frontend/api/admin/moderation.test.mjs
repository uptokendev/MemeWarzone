import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
delete process.env.API_RAILWAY_PROXY;
delete process.env.RAILWAY_API_PROXY;
delete process.env.VITE_API_RAILWAY_PROXY;

const { createModerationHandler, moderationTabFromPath, MODERATION_READ_PERMISSIONS } = await import("./moderation.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, text: null, headersSent: false, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    send(text) { this.text = text; this.headersSent = true; return this; },
    end(text) { this.text = text ?? this.text; this.headersSent = true; },
  };
}

function emptyDb() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes("from public.recruiters")) {
        return { rows: [{ id: "7", wallet_address: "0x1111000000000000000000000000000000000001", code: "r7", display_name: "R7", status: "active", created_at: "2026-09-01T00:00:00Z", email: "r7@example.test" }] };
      }
      return { rows: [] };
    },
  };
}

const principals = {
  community: { authUserId: "u1", permissions: ["community.view"], isOwner: false },
  finance: { authUserId: "u2", permissions: ["finance.view"], isOwner: false },
  ops: { authUserId: "u3", permissions: ["operations.view"], isOwner: false },
};

function handler({ db = emptyDb(), clock } = {}) {
  let resolved = 0;
  const h = createModerationHandler({
    getDb: async () => db,
    getPriceService: async () => ({ async hourly() { return new Map(); }, async valueEvents() { return { amountUsd: 0, priceBasis: null }; } }),
    resolvePrincipal: async (req, res) => {
      resolved += 1;
      const p = principals[String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")];
      if (!p) { res.status(401).json({ ok: false, code: "DASHBOARD_AUTH_REQUIRED" }); return null; }
      return p;
    },
    can: (p, perm) => Boolean(p?.isOwner || p?.permissions.includes(perm)),
    now: clock || (() => new Date("2026-10-05T12:00:00Z")),
    env: {},
  });
  return { h, db, resolved: () => resolved };
}

async function call(h, path, { method = "GET", token } = {}) {
  const res = fakeRes();
  const url = new URL(path, "http://localhost");
  await h({ method, url: path, originalUrl: path, headers: token ? { authorization: `Bearer ${token}` } : {}, query: Object.fromEntries(url.searchParams.entries()) }, res);
  return res;
}

test("path parsing", () => {
  assert.deepEqual(moderationTabFromPath("/api/admin/moderation/airdrops"), { matched: true, tab: "airdrops" });
  assert.deepEqual(moderationTabFromPath("/api/admin/moderation/recruiters/"), { matched: true, tab: "recruiters" });
  assert.equal(moderationTabFromPath("/api/admin/moderationx").matched, false);
  assert.deepEqual(MODERATION_READ_PERMISSIONS, ["community.view", "finance.view"]);
});

test("no bearer is 401, a principal without community.view or finance.view is 403", async () => {
  const { h, db } = handler();
  assert.equal((await call(h, "/api/admin/moderation/airdrops")).statusCode, 401);
  const res = await call(h, "/api/admin/moderation/airdrops", { token: "ops" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "DASHBOARD_PERMISSION_REQUIRED");
  assert.equal(db.calls.length, 0, "no data read before the permission check");
});

test("GET only: writes are refused", async () => {
  const { h } = handler();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await call(h, "/api/admin/moderation/recruiters", { method, token: "community" });
    assert.equal(res.statusCode, 405, method);
  }
});

test("community.view sees recruiter emails, finance.view does not", async () => {
  const { h } = handler();
  const community = await call(h, "/api/admin/moderation/recruiters", { token: "community" });
  assert.equal(community.statusCode, 200);
  assert.equal(community.body.emailVisible, true);
  assert.equal(community.body.rows[0].email, "r7@example.test");
  const finance = await call(h, "/api/admin/moderation/recruiters", { token: "finance" });
  assert.equal(finance.statusCode, 200);
  assert.equal(finance.body.emailVisible, false);
  assert.equal("email" in finance.body.rows[0], false);
  const csv = await call(h, "/api/admin/moderation/recruiters?format=csv", { token: "finance" });
  assert.doesNotMatch(csv.text, /Email|@example\.test/);
});

test("unknown tab 404, bad filter 400", async () => {
  const { h } = handler();
  assert.equal((await call(h, "/api/admin/moderation/payouts", { token: "finance" })).statusCode, 404);
  assert.equal((await call(h, "/api/admin/moderation/leagues?chainId=97", { token: "finance" })).statusCode, 400);
});

test("CSV export is an attachment of the filtered rows", async () => {
  const { h } = handler();
  const res = await call(h, "/api/admin/moderation/leagues?format=csv", { token: "community" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^text\/csv/);
  assert.match(res.headers["content-disposition"], /attachment; filename="moderation-leagues-2026-10-05\.csv"/);
  assert.match(res.text, /^Period,Epoch start,Chain,Category,Place,Wallet,/);
});

test("the dataset is cached for 60 s", async () => {
  let t = Date.parse("2026-10-05T12:00:00Z");
  const { h, db } = handler({ clock: () => new Date(t) });
  const first = await call(h, "/api/admin/moderation/airdrops", { token: "finance" });
  const reads = db.calls.length;
  assert.equal(first.body.cached, false);
  t += 30_000;
  const second = await call(h, "/api/admin/moderation/leagues", { token: "finance" });
  assert.equal(second.body.cached, true);
  assert.equal(db.calls.length, reads, "no new reads inside the window");
  t += 31_000;
  const third = await call(h, "/api/admin/moderation/recruiters", { token: "finance" });
  assert.equal(third.body.cached, false);
  assert.ok(db.calls.length > reads);
});

test("the proxy routes /api/admin/moderation to the handler, which refuses without sign-in", async () => {
  const { createRailwayProxyMiddleware } = await import("../../server/railwayProxy.js");
  const middleware = createRailwayProxyMiddleware({ serviceName: "test" });
  const res = fakeRes();
  let nextCalled = false;
  await middleware({ method: "GET", url: "/api/admin/moderation/airdrops", originalUrl: "/api/admin/moderation/airdrops", headers: {}, query: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "DASHBOARD_SIGN_IN_REQUIRED");
});

// Runs the accounting migration and the handler against a real, empty
// Postgres. Skipped unless FINANCE_ACCOUNTING_TEST_DATABASE_URL is set; never
// point it at a shared database (it drops the four accounting tables first).
//
//   FINANCE_ACCOUNTING_TEST_DATABASE_URL=postgres://... node --test api/admin/financeAccounting.integration.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const url = process.env.FINANCE_ACCOUNTING_TEST_DATABASE_URL;
process.env.DATABASE_URL ||= url || "postgres://user:pass@127.0.0.1:1/none";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.resolve(here, "../../../db/migrations/20261004_000002_finance_accounting.sql"), "utf8");

test("accounting migration + handler on a real Postgres", { skip: !url && "FINANCE_ACCOUNTING_TEST_DATABASE_URL not set" }, async () => {
  const { default: pg } = await import("pg");
  const db = new pg.Pool({ connectionString: url, max: 3 });
  try {
    await db.query("drop table if exists public.finance_costs, public.finance_audit_log, public.finance_month_close, public.finance_settings");
    const { createFinanceAccountingHandler } = await import("./financeAccounting.js");
    const NOW = Date.parse("2026-10-04T12:00:00Z");
    const revenue = { "2026-09": 5000 };
    const handler = createFinanceAccountingHandler({
      db,
      nowMs: () => NOW,
      fx: { rate: async (date) => ({ usdPerEur: 1.1225, date: date || "2026-10-02", source: "ECB test" }) },
      prices: { spot: async (a) => ({ priceUsd: 100, source: "t", at: null }), hourly: async (a, h) => new Map(h.map((x) => [x, 100])), spotTable: async (assets) => assets.map((asset) => ({ asset, priceUsd: 100, source: "t", at: null })) },
      revenue: async ({ fromMonth, toMonth }) => {
        const months = {};
        for (const [m, v] of Object.entries(revenue)) if (m >= fromMonth && m <= toMonth) months[m] = { totalUsd: v, lanes: [] };
        return { months, notes: [], excludedTestCoinEvents: 0 };
      },
      balances: async () => ({ oursUsd: 1000, heldUsd: 2000, owedUsd: 1000, chains: [], errors: [] }),
    });
    const principal = { authUserId: "u1", email: "owner@example.com", permissions: ["finance.view", "finance.manage"] };
    const call = async (method, p, body, query = {}) => {
      let status = 200;
      let payload;
      const res = { headersSent: false, setHeader() {}, status(c) { status = c; return this; }, json(v) { payload = v; return this; }, send(v) { payload = v; return this; } };
      await handler({ method, path: p, query, body, dashboardPrincipal: principal }, res);
      return { status, body: payload };
    };

    // Before the migration: the clear message.
    const before = await call("GET", "/api/admin/finance/costs");
    assert.equal(before.status, 503);
    assert.equal(before.body.code, "FINANCE_ACCOUNTING_NOT_INSTALLED");

    await db.query(migration);
    await db.query(migration); // idempotent
    const rls = await db.query(`select relname, relrowsecurity from pg_class where relname in ('finance_costs','finance_audit_log','finance_month_close','finance_settings') order by relname`);
    assert.deepEqual(rls.rows.map((r) => [r.relname, r.relrowsecurity]), [["finance_audit_log", true], ["finance_costs", true], ["finance_month_close", true], ["finance_settings", true]]);
    const policies = await db.query(`select count(*)::int as n from pg_policies where tablename like 'finance_%'`);
    assert.equal(policies.rows[0].n, 0);

    const created = await call("POST", "/api/admin/finance/costs", { incurredOn: "2026-09-10", category: "servers", vendor: "Hetzner", amount: "100.5", currency: "EUR", recurring: "monthly" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.cost.amount, "100.5");
    assert.equal(created.body.cost.incurredOn, "2026-09-10");
    assert.equal(created.body.cost.amountUsd, 112.81125);
    const id = created.body.cost.id;
    assert.equal((await call("PATCH", `/api/admin/finance/costs/${id}`, { description: "API box" })).status, 200);
    const list = await call("GET", "/api/admin/finance/costs", undefined, { from: "2026-09", to: "2026-10" });
    assert.equal(list.body.totals.count, 2);

    const closed = await call("POST", "/api/admin/finance/close/2026-09", { action: "close", confirm: "CLOSE 2026-09" });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    revenue["2026-09"] = 1;
    const year = await call("GET", "/api/admin/finance/close");
    const sep = year.body.months.find((m) => m.month === "2026-09");
    assert.deepEqual([sep.status, sep.revenueUsd, sep.costsUsd], ["closed", 5000, 112.81125]);
    assert.equal((await call("POST", "/api/admin/finance/close/2026-09", { action: "reopen", confirm: "REOPEN 2026-09", reason: "test" })).status, 200);
    assert.equal((await call("PUT", "/api/admin/finance/tax-reserves", { name: "Flat", currency: "USD", brackets: [{ upTo: null, rate: 0.2 }] })).status, 200);
    assert.equal((await call("DELETE", `/api/admin/finance/costs/${id}`)).status, 200);

    // Constraints hold even outside the API.
    await assert.rejects(db.query(`insert into public.finance_costs (incurred_on, category, vendor, amount, currency, amount_usd, fx_rate, fx_source, created_by) values ('2026-09-01','food','x',1,'USD',1,1,'USD','t')`), /finance_costs_category_chk/);
    await assert.rejects(db.query(`insert into public.finance_month_close (month, status) values ('2026-09-02','open')`), /finance_month_close_first_day/);
    await assert.rejects(db.query(`insert into public.finance_month_close (month, status) values ('2026-08-01','closed')`), /finance_month_close_snapshot_chk/);

    const audit = await db.query(`select action, actor_email, entity_id, before is not null as has_before, after is not null as has_after from public.finance_audit_log order by id`);
    assert.deepEqual(audit.rows.map((r) => r.action), ["cost.create", "cost.update", "close.close", "close.reopen", "settings.tax_reserve_rules", "cost.delete"]);
    assert.ok(audit.rows.every((r) => r.actor_email === "owner@example.com"));
    assert.equal(audit.rows[1].has_before && audit.rows[1].has_after, true);
  } finally {
    await db.end();
  }
});

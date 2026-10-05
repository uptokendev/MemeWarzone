import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { createFinanceAccountingHandler, isFinanceAccountingPath } = await import("./financeAccounting.js");
const { createFakeAccountingDb } = await import("./financeAccountingFakeDb.mjs");
const { validateCostInput, expandCost, costTotals, quoteCost, FinanceInputError } = await import("../lib/financeAccountingCosts.js");
const { bracketTax, taxReserveSchedule, validateTaxRules, DEFAULT_TAX_RESERVE_RULES, effectiveTaxRules } = await import("../lib/financeAccountingTax.js");
const { computeDistribution, buildSafeBatch, buildSquadsProposal, validateDistributionSettings, effectiveDistributionSettings, usdToNativeUnits } = await import("../lib/financeAccountingDistributions.js");
const { parseEcbUsdRates, pickRate, createEurUsdSource } = await import("../lib/financeAccountingFx.js");
const { toCsv, csvCell } = await import("../lib/financeAccountingCsv.js");

// 2026-10-04 12:00 UTC
const NOW = Date.parse("2026-10-04T12:00:00Z");

const VIEWER = { authUserId: "u-view", email: "viewer@example.com", permissions: ["dashboard.view", "finance.view"] };
const MANAGER = { authUserId: "u-man", email: "Manager@Example.com", permissions: ["dashboard.view", "finance.view", "finance.manage"] };

const fakeFx = (usdPerEur = 1.1225) => ({ rate: async (date) => ({ usdPerEur, date: date || "2026-10-02", source: `ECB euro reference rate ${date || "2026-10-02"}` }) });
const fakePrices = {
  spot: async (asset) => ({ asset, priceUsd: { SOL: 200, BNB: 600, ETH: 4000 }[asset], source: `Binance ${asset}USDT spot`, at: "2026-10-04T12:00:00.000Z" }),
  hourly: async (asset, hours) => new Map(hours.map((h) => [h, { SOL: 150, BNB: 500, ETH: 3000 }[asset]])),
  spotTable: async (assets) => assets.map((asset) => ({ asset, priceUsd: { SOL: 200, BNB: 600, ETH: 4000 }[asset], source: "test", at: null })),
  valueEvents: async () => ({ amountUsd: 0, priceBasis: null, priceSource: null }),
};

function makeRevenue(byMonth) {
  return async ({ fromMonth, toMonth }) => {
    const months = {};
    for (const [m, usd] of Object.entries(byMonth.value)) {
      if (m >= fromMonth && m <= toMonth) months[m] = { totalUsd: usd, lanes: [{ chainId: 56, chain: "bnb", lane: "bonding_curve_fee", asset: "BNB", nativeAmount: "1", amountUsd: usd, priceBasis: "event_time", priceSource: "test" }] };
    }
    for (let y = Number(fromMonth.slice(0, 4)), m = Number(fromMonth.slice(5)); `${y}-${String(m).padStart(2, "0")}` <= toMonth; m === 12 ? (y += 1, m = 1) : (m += 1)) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      months[key] ||= { totalUsd: 0, lanes: [] };
    }
    return { months, notes: [], excludedTestCoinEvents: 2 };
  };
}

const SQUADS = "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv";
const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const op = (amountUsd) => ({ address: "op", status: "ok", amount: "1", raw: "1", amountUsd, priceUsd: 1 });
// Multisig: Solana 100 SOL ($20k), BNB 50 BNB ($30k), Robinhood empty. Operator wallets hold the $10k buffer.
const BAL_CHAINS = [
  { chainId: 101, chain: "solana", asset: "SOL", decimals: 9, multisigAddress: SQUADS, multisigUsd: 20000, multisigRaw: "100000000000", multisigAmount: "100", priceUsd: 200, operator: op(4000), protocolVault: op(0) },
  { chainId: 56, chain: "bnb", asset: "BNB", decimals: 18, multisigAddress: SAFE, multisigUsd: 30000, multisigRaw: "50000000000000000000", multisigAmount: "50", priceUsd: 600, operator: op(6000), protocolVault: op(0) },
  { chainId: 4663, chain: "robinhood", asset: "ETH", decimals: 18, multisigAddress: SAFE, multisigUsd: 0, multisigRaw: "0", multisigAmount: "0", priceUsd: 4000, operator: op(0), protocolVault: op(0) },
];

function setup({ installed = true, revenue = { value: {} }, balances } = {}) {
  const db = createFakeAccountingDb({ installed });
  const handler = createFinanceAccountingHandler({
    db,
    prices: fakePrices,
    fx: fakeFx(),
    nowMs: () => NOW,
    revenue: makeRevenue(revenue),
    revenueEvents: async () => ({ rows: [{ occurredAt: "2026-09-01T10:00:00.000Z", month: "2026-09", chainId: 56, chain: "bnb", lane: "bonding_curve_fee", asset: "BNB", amountNative: "0.1", priceUsd: 500, amountUsd: 50, priceSource: "Binance BNBUSDT 1h close", usdPerEur: 1.1, amountEur: 45.45, fxSource: "ECB", txHash: "0xabc", logIndex: 3, campaignAddress: "0xc" }], notes: [], truncated: false }),
    balances: balances || (async () => ({ asOf: "2026-10-04T12:00:00.000Z", oursUsd: 60000, heldUsd: 90000, owedUsd: 30000, multisigUsd: 50000, operatorUsd: 10000, chains: BAL_CHAINS, errors: [] })),
    payouts: async (days) => ({ networks: [
      { chainId: 56, chain: "bnb", status: "ok", data: { period: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-04T12:00:00.000Z", days }, types: [
        { id: "weekly_league", label: "Weekly league", asset: "BNB", paid: { recorded: true, period: { amount: "1.5", amountUsd: 900, count: 3, priceSource: "Binance BNBUSDT 1h close at each event" }, lastPayout: { at: "2026-09-28T00:00:00.000Z", amount: "0.5", txHash: "0xpaid" } }, owed: { known: true, total: { amount: "0.2", amountUsd: 120, priceSource: "spot" } }, coverage: { status: "covered" } },
      ] } },
      { chainId: 101, chain: "solana", status: "error", error: "The payouts read failed for chain 101." },
    ] }),
  });
  async function call(method, path, { principal = MANAGER, body, query = {} } = {}) {
    const headers = {};
    let statusCode = 200;
    let payload;
    let sent;
    const res = {
      headersSent: false,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; this.headersSent = true; return this; },
      send(value) { sent = value; this.headersSent = true; return this; },
    };
    await handler({ method, path, url: path, query, body, dashboardPrincipal: principal, headers: {} }, res);
    return { status: statusCode, body: payload, text: sent, headers };
  }
  return { db, call };
}

const COST = { incurredOn: "2026-09-10", category: "servers", vendor: "Hetzner", description: "API box", amount: "100", currency: "EUR", recurring: "none" };

// ------------------------------------------------------------- routing / auth

test("accounting paths are recognised; other finance paths are not", () => {
  for (const p of ["/api/admin/finance/costs", "/api/admin/finance/costs/12", "/api/admin/finance/close/2026-09", "/api/admin/finance/exports/costs", "/api/admin/finance/distributions/safe-batch", "/api/admin/finance/tax-reserves", "/api/admin/finance/fx"]) {
    assert.equal(isFinanceAccountingPath(p), true, p);
  }
  for (const p of ["/api/admin/finance/revenue", "/api/admin/finance/fee-routing", "/api/admin/finance/lp-harvest", "/api/admin/finance/costsx"]) {
    assert.equal(isFinanceAccountingPath(p), false, p);
  }
});

test("no dashboard principal: 401; ops key alone is not enough", async () => {
  const { call } = setup();
  const out = await call("GET", "/api/admin/finance/costs", { principal: null });
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "FINANCE_VIEW_REQUIRED");
});

test("finance.view reads everything but every write is refused with 403", async () => {
  const { call, db } = setup();
  for (const path of ["/api/admin/finance/costs", "/api/admin/finance/tax-reserves", "/api/admin/finance/close", "/api/admin/finance/distributions"]) {
    const out = await call("GET", path, { principal: VIEWER });
    assert.equal(out.status, 200, path);
    assert.equal(out.body.canManage, false, path);
  }
  const writes = [
    ["POST", "/api/admin/finance/costs", COST],
    ["PATCH", "/api/admin/finance/costs/1", { vendor: "x" }],
    ["DELETE", "/api/admin/finance/costs/1", undefined],
    ["PUT", "/api/admin/finance/tax-reserves", DEFAULT_TAX_RESERVE_RULES],
    ["POST", "/api/admin/finance/close/2026-09", { action: "close", confirm: "CLOSE 2026-09" }],
    ["PUT", "/api/admin/finance/distributions", {}],
  ];
  for (const [method, path, body] of writes) {
    const out = await call(method, path, { principal: VIEWER, body });
    assert.equal(out.status, 403, `${method} ${path}`);
    assert.equal(out.body.code, "FINANCE_MANAGE_REQUIRED");
  }
  assert.equal(db.state.costs.length, 0);
  assert.equal(db.state.audit.length, 0);
});

test("tables missing: clear 'not installed yet' answer, not a 500", async () => {
  const { call } = setup({ installed: false });
  for (const path of ["/api/admin/finance/costs", "/api/admin/finance/close", "/api/admin/finance/distributions", "/api/admin/finance/exports/costs"]) {
    const out = await call("GET", path, { principal: VIEWER });
    assert.equal(out.status, 503, path);
    assert.equal(out.body.code, "FINANCE_ACCOUNTING_NOT_INSTALLED");
    assert.match(out.body.error, /not installed yet/);
    assert.match(out.body.error, /20261004_000002_finance_accounting\.sql/);
  }
  const write = await call("POST", "/api/admin/finance/costs", { body: COST });
  assert.equal(write.status, 503);
});

// ------------------------------------------------------------- costs

test("cost validation: required fields, enums, amounts, dates, links", () => {
  const ok = validateCostInput({ ...COST, amount: "0012.50" }, { nowMs: NOW });
  assert.equal(ok.amount, "12.5");
  assert.equal(ok.recurringUntil, null);
  assert.equal(validateCostInput({ incurredOn: "2026-09-01", category: "other", vendor: "x", amount: 5 }, { nowMs: NOW }).currency, "USD");
  const bad = [
    [{ ...COST, category: "food" }, "category"],
    [{ ...COST, currency: "GBP" }, "currency"],
    [{ ...COST, amount: "0" }, "amount"],
    [{ ...COST, amount: "-5" }, "amount"],
    [{ ...COST, amount: "1e5" }, "amount"],
    [{ ...COST, vendor: "  " }, "vendor"],
    [{ ...COST, incurredOn: "2026-02-30" }, "incurredOn"],
    [{ ...COST, incurredOn: "2023-12-31" }, "incurredOn"],
    [{ ...COST, incurredOn: "2028-01-01" }, "incurredOn"],
    [{ ...COST, attachmentUrl: "http://x.example/a.pdf" }, "attachmentUrl"],
    [{ ...COST, attachmentUrl: "javascript:alert(1)" }, "attachmentUrl"],
    [{ ...COST, recurring: "weekly" }, "recurring"],
    [{ ...COST, owner: "me" }, "owner"],
    [{ ...COST, fxRate: "-1" }, "fxRate"],
  ];
  for (const [body, field] of bad) {
    assert.throws(() => validateCostInput(body, { nowMs: NOW }), (e) => e instanceof FinanceInputError && e.field === field, field);
  }
  assert.throws(() => validateCostInput({}, { partial: true, nowMs: NOW }), /Nothing to change/);
});

test("create: EUR keeps the EUR amount and stores the ECB rate; audit row written with after", async () => {
  const { call, db } = setup();
  const out = await call("POST", "/api/admin/finance/costs", { body: COST });
  assert.equal(out.status, 201);
  assert.equal(out.body.cost.amount, "100");
  assert.equal(out.body.cost.currency, "EUR");
  assert.equal(out.body.cost.amountUsd, 112.25);
  assert.equal(out.body.cost.fxRate, 1.1225);
  assert.match(out.body.cost.fxSource, /ECB euro reference rate 2026-09-10/);
  assert.equal(out.body.cost.createdBy, "manager@example.com");
  assert.equal(db.state.audit.length, 1);
  assert.deepEqual([db.state.audit[0].action, db.state.audit[0].entityType, db.state.audit[0].before, db.state.audit[0].after.vendor], ["cost.create", "finance_cost", null, "Hetzner"]);
  assert.ok(db.state.queries.indexOf("BEGIN") < db.state.queries.findIndex((q) => q.startsWith("insert into public.finance_audit_log")));
});

test("update and soft delete: audit keeps before and after; deleted rows leave the totals", async () => {
  const { call, db } = setup();
  await call("POST", "/api/admin/finance/costs", { body: { ...COST, currency: "USD", amount: "40" } });
  const patched = await call("PATCH", "/api/admin/finance/costs/1", { body: { amount: "60", vendor: "Hetzner Online" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.cost.amountUsd, 60);
  const audit = db.state.audit[1];
  assert.equal(audit.action, "cost.update");
  assert.equal(audit.before.amountUsd, 40);
  assert.equal(audit.after.amountUsd, 60);
  const del = await call("DELETE", "/api/admin/finance/costs/1");
  assert.equal(del.status, 200);
  assert.ok(del.body.cost.deletedAt);
  assert.equal(db.state.audit[2].action, "cost.delete");
  assert.equal(db.state.costs.length, 1, "soft delete keeps the row");
  const list = await call("GET", "/api/admin/finance/costs", { principal: VIEWER, query: { from: "2026-09", to: "2026-09" } });
  assert.equal(list.body.totals.totalUsd, 0);
  const again = await call("DELETE", "/api/admin/finance/costs/1");
  assert.equal(again.status, 404);
});

test("costs list: filters, totals per category and month, recurring expanded", async () => {
  const { call } = setup();
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-07-31", category: "tools_software", vendor: "GitHub", amount: "21", currency: "USD", recurring: "monthly" } });
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-08-15", category: "legal_accounting", vendor: "Notary", amount: "300", currency: "USD" } });
  const out = await call("GET", "/api/admin/finance/costs", { principal: VIEWER, query: { from: "2026-07", to: "2026-10" } });
  assert.equal(out.body.schemaVersion, "finance-costs-v2");
  assert.equal(out.body.totals.byMonth["2026-07"], 21);
  assert.equal(out.body.totals.byMonth["2026-08"], 321);
  assert.equal(out.body.totals.byMonth["2026-09"], 21);
  assert.equal(out.body.totals.byCategory.tools_software, 84);
  assert.deepEqual(out.body.occurrences.filter((o) => o.costId === "1").map((o) => o.date).sort(), ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"]);
  const filtered = await call("GET", "/api/admin/finance/costs", { principal: VIEWER, query: { from: "2026-07", to: "2026-10", category: "legal_accounting" } });
  assert.equal(filtered.body.totals.totalUsd, 300);
  assert.equal(filtered.body.entries.length, 1);
  const bad = await call("GET", "/api/admin/finance/costs", { principal: VIEWER, query: { from: "2026-07", to: "2027-01" } });
  assert.equal(bad.status, 400);
});

test("recurring expansion: monthly clamps to month end, yearly once a year, end date and onOrBefore", () => {
  const base = { id: "1", category: "servers", vendor: "v", description: "", amount: "10", currency: "USD", amountUsd: 10, fxRate: 1, fxSource: "USD", eurUsdRate: null, deletedAt: null };
  const monthly = { ...base, incurredOn: "2026-01-31", recurring: "monthly", recurringUntil: "2026-05-15" };
  assert.deepEqual(expandCost(monthly, "2026-01", "2026-12").map((o) => o.date), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(expandCost(monthly, "2026-03", "2026-03").map((o) => o.date), ["2026-03-31"]);
  const yearly = { ...base, incurredOn: "2024-03-01", recurring: "yearly", recurringUntil: null };
  assert.deepEqual(expandCost(yearly, "2024-01", "2026-12").map((o) => o.date), ["2024-03-01", "2025-03-01", "2026-03-01"]);
  assert.deepEqual(expandCost(yearly, "2025-04", "2026-02").map((o) => o.date), []);
  const open = { ...base, incurredOn: "2026-09-20", recurring: "monthly", recurringUntil: null };
  assert.deepEqual(expandCost(open, "2026-09", "2026-10", { onOrBefore: "2026-10-04" }).map((o) => o.date), ["2026-09-20"]);
  assert.deepEqual(expandCost({ ...base, incurredOn: "2026-09-20", recurring: "none", recurringUntil: null, deletedAt: "x" }, "2026-09", "2026-09"), []);
  assert.equal(costTotals(expandCost(monthly, "2026-01", "2026-12")).totalUsd, 40);
});

// ------------------------------------------------------------- FX

test("FX: ECB XML parsed newest first; weekends use the business day before; override wins", async () => {
  const xml = `<Cube><Cube time="2026-10-02"><Cube currency="USD" rate="1.1225"/><Cube currency="JPY" rate="176.99"/></Cube><Cube time='2026-10-01'><Cube currency='USD' rate='1.1200'/></Cube></Cube>`;
  const rows = parseEcbUsdRates(xml);
  assert.deepEqual(rows.map((r) => r.date), ["2026-10-02", "2026-10-01"]);
  assert.equal(pickRate(rows, "2026-10-04").date, "2026-10-02");
  assert.equal(pickRate(rows, "2026-10-04").exact, false);
  assert.equal(pickRate(rows, "2026-10-01").usdPerEur, 1.12);
  assert.equal(pickRate(rows, "2026-01-01").beforeRange, true);
  let calls = 0;
  const source = createEurUsdSource({ env: {}, nowMs: () => NOW, fetchImpl: async (url, init) => { calls += 1; assert.equal(init.method, "GET"); assert.match(url, /ecb\.europa\.eu/); return { ok: true, text: async () => xml }; } });
  const sat = await source.rate("2026-10-03");
  assert.equal(sat.usdPerEur, 1.1225);
  assert.match(sat.source, /latest business day on or before 2026-10-03/);
  await source.rate("2026-10-01");
  assert.equal(calls, 1, "cached");
  const fixed = await createEurUsdSource({ env: { FINANCE_EUR_USD_RATE: "1.05" }, fetchImpl: async () => { throw new Error("no network"); } }).rate("2026-10-01");
  assert.equal(fixed.usdPerEur, 1.05);
  assert.equal(await createEurUsdSource({ env: {}, fetchImpl: async () => { throw new Error("down"); } }).rate(), null);
});

test("FX conversion: USD 1, EUR ECB, crypto at the 12:00 UTC close of a past day, spot today, manual rate", async () => {
  const fx = fakeFx(1.1);
  const usd = await quoteCost({ amount: "10", currency: "USD", incurredOn: "2026-09-01", prices: fakePrices, fx, nowMs: NOW });
  assert.deepEqual([usd.amountUsd, usd.fxRate, usd.fxSource, usd.eurUsdRate], [10, 1, "USD", 1.1]);
  const eur = await quoteCost({ amount: "10", currency: "EUR", incurredOn: "2026-09-01", prices: fakePrices, fx, nowMs: NOW });
  assert.equal(eur.amountUsd, 11);
  const sol = await quoteCost({ amount: "2", currency: "SOL", incurredOn: "2026-09-01", prices: fakePrices, fx, nowMs: NOW });
  assert.equal(sol.amountUsd, 300);
  assert.match(sol.fxSource, /SOLUSDT 1h close at 2026-09-01 12:00 UTC/);
  const today = await quoteCost({ amount: "2", currency: "SOL", incurredOn: "2026-10-04", prices: fakePrices, fx, nowMs: Date.parse("2026-10-04T08:00:00Z") });
  assert.equal(today.amountUsd, 400);
  assert.match(today.fxSource, /spot at entry/);
  const manual = await quoteCost({ amount: "2", currency: "BNB", incurredOn: "2026-09-01", manualRate: 550, actorEmail: "m@x", prices: fakePrices, fx, nowMs: NOW });
  assert.equal(manual.amountUsd, 1100);
  assert.match(manual.fxSource, /manual rate entered by m@x/);
  await assert.rejects(quoteCost({ amount: "1", currency: "EUR", incurredOn: "2026-09-01", prices: fakePrices, fx: { rate: async () => null }, nowMs: NOW }), /Enter the rate by hand/);
});

// ------------------------------------------------------------- tax

test("tax brackets: Dutch default 19% to EUR 200k then 25.8%; zero for a loss", () => {
  const b = DEFAULT_TAX_RESERVE_RULES.brackets;
  assert.equal(bracketTax(100000, b), 19000);
  assert.equal(Math.round(bracketTax(300000, b)), 38000 + 25800);
  assert.equal(bracketTax(-5000, b), 0);
  assert.equal(effectiveTaxRules(null).isDefault, true);
  assert.match(effectiveTaxRules(null).note, /Based on KVK and the Belastingdienst .*checked 2026-10-05/);
  assert.throws(() => validateTaxRules({ name: "x", currency: "EUR", brackets: [{ upTo: 100, rate: 0.1 }, { upTo: 50, rate: 0.2 }, { upTo: null, rate: 0.3 }] }), /higher than the bracket before/);
  assert.throws(() => validateTaxRules({ name: "x", currency: "EUR", brackets: [{ upTo: null, rate: 19 }] }), /between 0 and 1/);
  assert.throws(() => validateTaxRules({ name: "x", currency: "EUR", brackets: [{ upTo: 100, rate: 0.1 }] }), /last bracket has no upper limit/);
});

test("tax schedule: increments of year-to-date tax; loss month releases; frozen months kept", () => {
  const rules = { currency: "EUR", brackets: [{ upTo: 200000, rate: 0.19 }, { upTo: null, rate: 0.258 }] };
  const out = taxReserveSchedule([
    { month: "2026-01", profitUsd: 110000, usdPerEur: 1.1 }, // 100k EUR -> 19k EUR = 20.9k USD
    { month: "2026-02", profitUsd: 220000, usdPerEur: 1.1 }, // ytd 300k EUR -> 63.8k EUR; minus 19k = 44.8k EUR = 49.28k USD
    { month: "2026-03", profitUsd: -110000, usdPerEur: 1.1 }, // ytd 200k EUR -> 38k; release 25.8k EUR = 28.38k USD
  ], rules);
  assert.deepEqual(out.rows.map((r) => r.reserveUsd), [20900, 49280, -28380]);
  assert.equal(out.ytdReserveUsd, 41800);
  const frozen = taxReserveSchedule([{ month: "2026-01", profitUsd: 1000, usdPerEur: 1, frozenReserveUsd: 123 }, { month: "2026-02", profitUsd: null, usdPerEur: 1 }], { currency: "USD", brackets: [{ upTo: null, rate: 0.5 }] });
  assert.equal(frozen.rows[0].reserveUsd, 123);
  assert.equal(frozen.rows[1].reserveUsd, null);
  assert.equal(frozen.ytdReserveUsd, null, "an unknown month makes the year unknown, not smaller");
});

test("tax page: label, default rules, editable by finance.manage with an audit row", async () => {
  const { call, db } = setup({ revenue: { value: { "2026-09": 10000 } } });
  const view = await call("GET", "/api/admin/finance/tax-reserves", { principal: VIEWER });
  assert.match(view.body.label, /Based on the Belastingdienst, wetten.overheid.nl and KVK, checked 2026-10-05/);
  assert.match(view.body.label, /can be changed afterwards/);
  assert.equal(view.body.rules.isDefault, true);
  assert.equal(view.body.rules.name, "Dutch corporate income tax (vennootschapsbelasting) 2026");
  assert.match(view.body.rules.source, /^https:\/\//);
  assert.equal(view.body.months.find((m) => m.month === "2026-09").reserveUsd, 1900);
  const put = await call("PUT", "/api/admin/finance/tax-reserves", { body: { name: "Flat 10%", currency: "USD", brackets: [{ upTo: null, rate: 0.1 }] } });
  assert.equal(put.status, 200);
  assert.equal(db.state.audit.at(-1).action, "settings.tax_reserve_rules");
  assert.equal(db.state.audit.at(-1).before, null);
  const after = await call("GET", "/api/admin/finance/tax-reserves", { principal: VIEWER });
  assert.equal(after.body.rules.isDefault, false);
  assert.equal(after.body.months.find((m) => m.month === "2026-09").reserveUsd, 1000);
});

// ------------------------------------------------------------- close

test("close: needs confirm, only past months; snapshot is frozen; reopen needs a reason and is logged", async () => {
  const revenue = { value: { "2026-09": 5000 } };
  const { call, db } = setup({ revenue });
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-09-05", category: "servers", vendor: "Hetzner", amount: "1000", currency: "USD" } });

  assert.equal((await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "close" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/finance/close/2026-10", { body: { action: "close", confirm: "CLOSE 2026-10" } })).status, 400);
  const closed = await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "close", confirm: "CLOSE 2026-09" } });
  assert.equal(closed.status, 200);
  assert.equal(db.state.audit.at(-1).action, "close.close");
  const snap = db.state.closes.get("2026-09-01").snapshot;
  assert.equal(snap.revenue.totalUsd, 5000);
  assert.equal(snap.costs.totalUsd, 1000);
  assert.equal(snap.profitUsd, 4000);
  assert.equal(snap.tax.reserveUsd, 760);
  assert.equal(snap.balances.oursUsd, 60000);
  assert.equal(snap.balances.multisigUsd, 50000);
  assert.equal(snap.fx.usdPerEur, 1.1225);
  assert.deepEqual(snap.prices.map((p) => p.asset), ["SOL", "BNB", "ETH"]);
  assert.equal(snap.revenue.testCoinsExcluded, true);

  // Revenue moves and a cost is added after the close: the closed month does not change.
  revenue.value["2026-09"] = 999999;
  const blocked = await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-09-20", category: "other", vendor: "late", amount: "5", currency: "USD" } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "MONTH_CLOSED");
  const blockedEdit = await call("PATCH", "/api/admin/finance/costs/1", { body: { amount: "1" } });
  assert.equal(blockedEdit.status, 409);
  const year = await call("GET", "/api/admin/finance/close", { principal: VIEWER });
  const sep = year.body.months.find((m) => m.month === "2026-09");
  assert.deepEqual([sep.status, sep.source, sep.revenueUsd, sep.profitUsd, sep.reserveUsd], ["closed", "snapshot", 5000, 4000, 760]);
  const month = await call("GET", "/api/admin/finance/close/2026-09", { principal: VIEWER });
  assert.equal(month.body.from, "snapshot");
  assert.equal(month.body.snapshot.revenue.totalUsd, 5000);
  assert.equal((await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "close", confirm: "CLOSE 2026-09" } })).status, 409);

  assert.equal((await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "reopen", confirm: "REOPEN 2026-09" } })).status, 400, "reason required");
  const reopened = await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "reopen", confirm: "REOPEN 2026-09", reason: "late invoice" } });
  assert.equal(reopened.status, 200);
  const log = db.state.audit.at(-1);
  assert.deepEqual([log.action, log.actorEmail, log.after.reason, log.before.status], ["close.reopen", "manager@example.com", "late invoice", "closed"]);
  const live = await call("GET", "/api/admin/finance/close", { principal: VIEWER });
  assert.equal(live.body.months.find((m) => m.month === "2026-09").revenueUsd, 999999);
});

test("a recurring cost that starts in a closed month can still get an end date", async () => {
  const { call } = setup();
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-08-01", category: "servers", vendor: "VPS", amount: "10", currency: "USD", recurring: "monthly" } });
  await call("POST", "/api/admin/finance/close/2026-08", { body: { action: "close", confirm: "CLOSE 2026-08" } });
  assert.equal((await call("PATCH", "/api/admin/finance/costs/1", { body: { recurringUntil: "2026-09-30" } })).status, 200);
  assert.equal((await call("PATCH", "/api/admin/finance/costs/1", { body: { amount: "20" } })).status, 409);
  assert.equal((await call("DELETE", "/api/admin/finance/costs/1")).status, 409);
});

// ------------------------------------------------------------- close order

test("close order: earlier months with activity must be closed first; months without activity never block", async () => {
  const { call } = setup({ revenue: { value: { "2026-07": 100, "2026-09": 5000 } } });
  const blocked = await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "close", confirm: "CLOSE 2026-09" } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "EARLIER_MONTHS_OPEN");
  assert.deepEqual(blocked.body.months, ["2026-07"]);
  const year = await call("GET", "/api/admin/finance/close", { principal: VIEWER });
  const sep = year.body.months.find((m) => m.month === "2026-09");
  assert.deepEqual([sep.closable, sep.closeBlockedBy], [false, ["2026-07"]]);
  assert.match(year.body.closeOrderRule, /reopen the latest first/);
  assert.equal((await call("POST", "/api/admin/finance/close/2026-07", { body: { action: "close", confirm: "CLOSE 2026-07" } })).status, 200);
  // August has no activity: it does not block September.
  assert.equal((await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "close", confirm: "CLOSE 2026-09" } })).status, 200);
  const reopenEarly = await call("POST", "/api/admin/finance/close/2026-07", { body: { action: "reopen", confirm: "REOPEN 2026-07", reason: "fix" } });
  assert.equal(reopenEarly.status, 409);
  assert.equal(reopenEarly.body.code, "LATER_MONTHS_CLOSED");
  assert.match(reopenEarly.body.error, /reopen 2026-09 first/);
  const after = await call("GET", "/api/admin/finance/close", { principal: VIEWER });
  assert.deepEqual(after.body.months.filter((m) => m.status === "closed").map((m) => [m.month, m.reopenable]), [["2026-07", false], ["2026-09", true]]);
  assert.equal((await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "reopen", confirm: "REOPEN 2026-09", reason: "fix" } })).status, 200);
  assert.equal((await call("POST", "/api/admin/finance/close/2026-07", { body: { action: "reopen", confirm: "REOPEN 2026-07", reason: "fix" } })).status, 200);
});

test("close order: a cost in an earlier open month blocks too", async () => {
  const { call } = setup();
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-03-02", category: "legal_accounting", vendor: "Notary", amount: "800", currency: "EUR" } });
  const out = await call("POST", "/api/admin/finance/close/2026-05", { body: { action: "close", confirm: "CLOSE 2026-05" } });
  assert.equal(out.status, 409);
  assert.deepEqual(out.body.months, ["2026-03"]);
});

// ------------------------------------------------------------- distributions

const SETTINGS = effectiveDistributionSettings({
  shares: [
    { id: "a", name: "Patrick", entity: "Dutch personal holding (BV)", bps: 5000, evmAddress: "0x1111111111111111111111111111111111111111", solanaAddress: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H" },
    { id: "b", name: "Sven", entity: "Dutch personal holding (BV)", bps: 3000, evmAddress: "0x2222222222222222222222222222222222222222", solanaAddress: "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv" },
    { id: "c", name: "Dough", entity: "US corporation", bps: 2000, withholdingPct: 15, withholdingOverride: true, evmAddress: "0x3333333333333333333333333333333333333333", solanaAddress: "So11111111111111111111111111111111111111112" },
  ],
});

test("distribution math: only the multisig is distributable; minus tax and open costs; operator buffer never counted", () => {
  const d = computeDistribution({ chains: BAL_CHAINS, taxReserveUsd: 5000, openCostsUsd: 1000.005, settings: SETTINGS });
  assert.equal(d.multisigUsd, 50000, "operator wallets ($10k) are not in it");
  assert.equal(d.distributableUsd, 43999.99);
  assert.deepEqual(d.shares.map((s) => s.amountUsd), [21999.99, 13199.99, 8799.99]);
  assert.deepEqual(d.shares.map((s) => s.withholdingUsd), [0, 0, 1319.99]);
  assert.equal(d.shares[2].netUsd, 7480);
  const patrick = d.shares[0];
  assert.equal(patrick.perChain.find((p) => p.chainId === 101).amountUsd, 8799.99);
  assert.equal(patrick.perChain.find((p) => p.chainId === 101).units, usdToNativeUnits(21999.99 * 0.4, 200, 9).toString());
  assert.equal(patrick.perChain.some((p) => p.chainId === 4663), false, "an empty Safe pays nothing");
  for (const chain of BAL_CHAINS.filter((c) => c.multisigUsd > 0)) {
    const total = d.shares.reduce((s, x) => s + BigInt(x.perChain.find((p) => p.chainId === chain.chainId).units), 0n);
    assert.ok(total <= BigInt(chain.multisigRaw), "never more than the multisig holds");
  }
  assert.ok(d.retainedUsd >= 6000 + 1319.99 - 0.05);
  const none = computeDistribution({ chains: BAL_CHAINS, taxReserveUsd: 49000, openCostsUsd: 2000, settings: SETTINGS });
  assert.equal(none.distributableUsd, 0);
  assert.equal(none.shortfallUsd, 1000);
  const negTax = computeDistribution({ chains: BAL_CHAINS, taxReserveUsd: -500, openCostsUsd: 0, settings: SETTINGS });
  assert.equal(negTax.distributableUsd, 50000, "a negative reserve never adds money");
  const unread = computeDistribution({ chains: [{ ...BAL_CHAINS[0], multisigUsd: null, multisigRaw: null }, BAL_CHAINS[1]], taxReserveUsd: 0, openCostsUsd: 0, settings: SETTINGS });
  assert.equal(unread.distributableUsd, null);
  assert.match(unread.blockers[0], /multisig balance on chain 101/);
});

test("distribution settings: entities, withholding %, 100% total, addresses checked; defaults", () => {
  const defaults = effectiveDistributionSettings(null);
  assert.deepEqual(defaults.shares.map((s) => [s.name, s.bps, s.entity, s.withholdingPct]), [["Patrick", 5000, "Dutch personal holding (BV)", 0], ["Sven", 3000, "Dutch personal holding (BV)", 0], ["Dough", 2000, "US corporation", 0]]);
  assert.equal("bufferUsd" in defaults, false);
  assert.equal(defaults.isDefault, true);
  assert.throws(() => validateDistributionSettings({ shares: [{ name: "A", bps: 6000 }, { name: "B", bps: 3000 }] }), /add up to 90%/);
  assert.throws(() => validateDistributionSettings({ shares: [{ name: "A", bps: 10000, evmAddress: "0x123" }] }), /not an EVM address/);
  assert.throws(() => validateDistributionSettings({ shares: [{ name: "A", bps: 10000, solanaAddress: "0OIl" }] }), /not a Solana address/);
  assert.throws(() => validateDistributionSettings({ shares: [{ name: "A", bps: 10000, withholdingPct: 120 }] }), /withholding/);
  assert.throws(() => validateDistributionSettings({ shares: [{ name: "A", bps: 10000, withholdingPct: 1.234 }] }), /two decimals/);
  const lower = validateDistributionSettings({ shares: [{ name: "A", bps: 10000, evmAddress: "0x1edcedf5e5d9c2fad5f9f6b964077dd74020a7a7" }], bufferUsd: 5 });
  assert.equal(lower.shares[0].evmAddress, SAFE, "checksummed");
  assert.equal("bufferUsd" in lower, false, "old buffer field ignored");
});

test("Safe batch: Transaction Builder shape, net native transfers from the Safe that was read, unsigned", () => {
  const d = computeDistribution({ chains: BAL_CHAINS, taxReserveUsd: 5000, openCostsUsd: 1000, settings: SETTINGS });
  const batch = buildSafeBatch({ chainId: 56, distribution: d, chains: BAL_CHAINS, createdAtMs: NOW });
  assert.equal(batch.version, "1.0");
  assert.equal(batch.chainId, "56");
  assert.equal(batch.createdAt, NOW);
  assert.equal(batch.meta.createdFromSafeAddress, SAFE);
  assert.equal(batch.meta.txBuilderVersion, "1.16.5");
  assert.match(batch.meta.description, /Proposal only/);
  assert.match(batch.meta.description, /shareholder resolution and the board's approval after the distribution test \(art\. 2:216 BW\)/);
  assert.match(batch.meta.description, /Dough \(US corporation\) 20%, 15% withheld/);
  assert.equal(batch.transactions.length, 3);
  for (const tx of batch.transactions) {
    assert.deepEqual(Object.keys(tx).sort(), ["contractInputsValues", "contractMethod", "data", "to", "value"]);
    assert.match(tx.value, /^\d+$/);
    assert.equal(tx.data, "0x");
    assert.equal(tx.contractMethod, null);
  }
  assert.equal(batch.transactions[2].value, d.shares[2].perChain.find((p) => p.chainId === 56).units, "net of withholding");
  assert.equal(JSON.stringify(batch).includes("signature"), false);
  assert.throws(() => buildSafeBatch({ chainId: 4663, distribution: d, chains: BAL_CHAINS }), /holds nothing distributable/);
  assert.throws(() => buildSafeBatch({ chainId: 97, distribution: d, chains: BAL_CHAINS }), /BNB 56 and Robinhood 4663/);
  const noAddr = effectiveDistributionSettings(null);
  assert.throws(() => buildSafeBatch({ chainId: 56, distribution: computeDistribution({ chains: BAL_CHAINS, taxReserveUsd: 0, openCostsUsd: 0, settings: noAddr }), chains: BAL_CHAINS }), /No EVM payout address for: Patrick, Sven, Dough/);
  const squads = buildSquadsProposal({ distribution: d, chains: BAL_CHAINS, createdAtMs: NOW });
  assert.match(squads, /PROPOSAL ONLY/);
  assert.match(squads, /dividend from MemeWarzone BV/);
  assert.match(squads, new RegExp(`Squads vault: ${SQUADS}`));
  assert.match(squads, /lamports to 9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H/);
  assert.match(squads, /operator wallet \(buffer, capped at \$10,000\) is not distributed/);
});

test("distributions route: labels, buffer shown, open costs, downloads; settings saved with audit", async () => {
  const { call, db } = setup({ revenue: { value: { "2026-09": 10000 } } });
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-10-01", category: "servers", vendor: "VPS", amount: "500", currency: "USD" } });
  await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-10-20", category: "servers", vendor: "future", amount: "999", currency: "USD" } });
  const view = await call("GET", "/api/admin/finance/distributions", { principal: VIEWER });
  assert.equal(view.body.label, "Proposal only. Nothing is sent from this page.");
  assert.match(view.body.dividendNote, /dividend from MemeWarzone BV/);
  assert.match(view.body.dividendNote, /art\. 4 Wet op de dividendbelasting 1965/);
  assert.equal(view.body.settings.shares[2].entityType, "us_corporation", "inferred from the legal entity text");
  assert.equal(view.body.settings.shares[2].withholdingPct, 0, "US corporation with 20%: exempt under art. 4 lid 2");
  assert.equal(view.body.settings.shares[2].withholding.fallbackRate, 0.05, "treaty rate if the exemption is refused");
  assert.equal(view.body.buffer.label, "Buffer: operator wallet, capped at $10,000 (not distributed)");
  assert.equal(view.body.buffer.totalUsd, 10000);
  assert.equal(view.body.buffer.capUsd, 10000);
  assert.deepEqual(view.body.multisig.map((m) => m.amountUsd), [20000, 30000, 0]);
  assert.equal(view.body.distribution.deductions.openCostsUsd, 500, "only costs dated up to today");
  assert.equal(view.body.distribution.deductions.taxReserveUsd, 1615.19);
  assert.equal(view.body.distribution.distributableUsd, Math.floor((50000 - 1615.19 - 500) * 100) / 100);
  assert.equal(view.body.safeChains.find((c) => c.chainId === 56).safe, SAFE);
  assert.equal(view.body.squadsVault, SQUADS);
  const missing = await call("GET", "/api/admin/finance/distributions/safe-batch", { principal: VIEWER, query: { chainId: "56" } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /No EVM payout address/);
  const saved = await call("PUT", "/api/admin/finance/distributions", { body: { settings: SETTINGS } });
  assert.equal(saved.status, 200);
  assert.equal(db.state.audit.at(-1).action, "settings.distribution");
  assert.equal(db.state.audit.at(-1).after.shares[2].entity, "US corporation");
  const after = await call("GET", "/api/admin/finance/distributions", { principal: VIEWER });
  assert.equal(after.body.history.length, 1, "who changed what is shown to every finance.view user");
  assert.equal(after.body.history[0].by, "manager@example.com");
  assert.ok(after.body.history[0].changes.includes("Patrick EVM payout address: not set -> 0x1111111111111111111111111111111111111111"));
  assert.ok(after.body.history[0].changes.includes("Dough withholding: from the rules -> 15% (set by hand)"));
  assert.equal(after.body.settings.shares[2].withholdingPct, 15, "the override wins");
  assert.equal(view.body.history.length, 0);
  const file = await call("GET", "/api/admin/finance/distributions/safe-batch", { principal: VIEWER, query: { chainId: "56" } });
  assert.equal(file.status, 200);
  assert.match(file.headers["content-disposition"], /attachment; filename="mwz-distribution-proposal-56-2026-10-04\.safe-batch\.json"/);
  assert.equal(JSON.parse(file.text).transactions.length, 3);
  const squads = await call("GET", "/api/admin/finance/distributions/squads-proposal", { principal: VIEWER });
  assert.match(squads.text, /Squads vault: fk5Y/);
});

// ------------------------------------------------------------- exports

test("CSV: quoting and formula guard", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-12.5"), "-12.5");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(null), "");
  assert.equal(toCsv([{ key: "a", label: "a" }, { key: "b", label: "b" }], [{ a: 1, b: "x\ny" }]), 'a,b\r\n1,"x\ny"\r\n');
});

test("exports: costs, close summaries, revenue events and payouts as CSV attachments", async () => {
  const { call } = setup({ revenue: { value: { "2026-09": 5000 } } });
  await call("POST", "/api/admin/finance/costs", { body: COST });
  await call("POST", "/api/admin/finance/close/2026-09", { body: { action: "close", confirm: "CLOSE 2026-09" } });
  const costs = await call("GET", "/api/admin/finance/exports/costs", { principal: VIEWER, query: { from: "2026-09", to: "2026-10" } });
  assert.equal(costs.status, 200);
  assert.match(costs.headers["content-type"], /text\/csv/);
  assert.match(costs.headers["content-disposition"], /mwz-costs-2026-09_2026-10\.csv/);
  const [header, row] = costs.text.trim().split("\r\n");
  assert.match(header, /amount_native,currency,fx_rate_usd_per_unit,fx_source,amount_usd,usd_per_eur,amount_eur/);
  assert.match(row, /closed \(snapshot\)/);
  assert.match(row, /100,EUR,1.1225/);
  const close = await call("GET", "/api/admin/finance/exports/close-summaries", { principal: VIEWER, query: { from: "2026-09", to: "2026-10" } });
  const lines = close.text.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /revenue_usd,costs_usd,profit_usd,tax_reserve_usd/);
  assert.match(lines[1], /^2026-09,closed,snapshot,5000,112.25,4887.75/);
  const events = await call("GET", "/api/admin/finance/exports/revenue-events.csv", { principal: VIEWER, query: { from: "2026-09", to: "2026-09" } });
  assert.match(events.text, /tx_hash/);
  assert.match(events.text, /0xabc/);
  const payouts = await call("GET", "/api/admin/finance/exports/payouts", { principal: VIEWER, query: { from: "2026-09", to: "2026-10" } });
  assert.equal(payouts.status, 200);
  assert.match(payouts.headers["content-disposition"], /mwz-payouts-2026-09_2026-10\.csv/);
  const plines = payouts.text.trim().split("\r\n");
  assert.match(plines[0], /paid_native,paid_usd,paid_eur,paid_count,paid_price_source,owed_now_native,owed_now_usd/);
  assert.match(plines[0], /last_payout_tx_hash/);
  assert.match(plines[1], /^56,bnb,weekly_league,Weekly league,BNB,/);
  assert.match(plines[1], /,1\.5,900,801\.78,3,/);
  assert.match(plines[1], /0xpaid/);
  assert.match(plines[2], /^101,solana,read failed/);
  assert.equal((await call("GET", "/api/admin/finance/exports/secrets", { principal: VIEWER })).status, 404);
});

test("balances: multisig (Squads / Safe) is the distributable source; operator wallet is the buffer", async () => {
  const { currentBalances } = await import("../lib/financeAccountingSources.js");
  const { buildTotals } = await import("../lib/financePrices.js");
  const dest = (id, amount, amountUsd, ownership = "ours") => ({ id, address: `${id}-addr`, ownership, flags: [], balances: [{ asset: "SOL", status: "ok", amount, raw: String(Number(amount) * 1e9), amountUsd, priceUsd: 200 }] });
  const solana = { chainId: 101, chain: "solana", nativeSymbol: "SOL", nativeDecimals: 9 };
  const bnb = { chainId: 56, chain: "bnb", nativeSymbol: "BNB", nativeDecimals: 18 };
  const out = await currentBalances({
    networks: [solana, bnb],
    build: async ({ network }) => {
      if (network.chainId === 56) throw new Error("rpc down");
      return { destinations: [dest("squads_vault", "10", 2000), dest("route_operator", "50", 10000), dest("protocol_vault", "1", 200), dest("league_weekly", "5", 1000, "owed")], prices: [{ asset: "SOL", priceUsd: 200 }], totals: { ours: buildTotals([{ chainId: 101, chain: "solana", asset: "SOL", amount: "61", amountUsd: 12200 }]), holdings: buildTotals([{ chainId: 101, chain: "solana", asset: "SOL", amount: "66", amountUsd: 13200 }]) } };
    },
  });
  const sol = out.chains[0];
  assert.deepEqual([sol.multisigAddress, sol.multisigUsd, sol.multisigRaw, sol.operator.amountUsd, sol.protocolVault.amountUsd], ["squads_vault-addr", 2000, "10000000000", 10000, 200]);
  assert.equal(out.chains[1].multisigUsd, null);
  assert.equal(out.multisigUsd, null, "a failed chain makes the total unknown");
  assert.match(out.errors[0], /Chain 56/);
});

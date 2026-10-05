import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { createFinanceAccountingHandler, isFinanceAccountingPath } = await import("./financeAccounting.js");
const { createFakeAccountingDb } = await import("./financeAccountingFakeDb.mjs");
const W = await import("../lib/financeAccountingWeekly.js");
const R = await import("../lib/financeTaxRules.js");

const NOW = Date.parse("2026-10-04T12:00:00Z"); // a Sunday: last complete week is 2026-W39
const SQUADS = "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv";
const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const VIEWER = { authUserId: "u-view", email: "viewer@example.com", permissions: ["dashboard.view", "finance.view"] };
const MANAGER = { authUserId: "u-man", email: "manager@example.com", permissions: ["dashboard.view", "finance.view", "finance.manage"] };

/** Rules with VAT switched off, so profit = revenue - costs. */
function noVatRules() {
  const rules = R.effectiveTaxRuleSet(null);
  for (const lane of Object.values(rules.vat.lanes)) Object.assign(lane, { treatment: "exempt", rate: 0, taxableShare: 0 });
  return rules;
}
const lane = (usd, laneId = "bonding-route:101") => ({ laneId, amountUsd: usd });
const rate1 = () => 1;

function days(map) {
  return Object.fromEntries(Object.entries(map).map(([d, usd]) => [d, { totalUsd: usd, lanes: [lane(usd)] }]));
}

// ------------------------------------------------------------------ weeks

test("ISO weeks: keys, Mondays, year edges; a week across a month end is split by date", () => {
  assert.equal(W.isoWeekKey("2026-01-01"), "2026-W01");
  assert.equal(W.isoWeekKey("2025-12-29"), "2026-W01");
  assert.equal(W.isoWeekKey("2027-01-01"), "2026-W53");
  assert.equal(W.isoWeekKey("2026-10-04"), "2026-W40");
  assert.equal(W.weekMonday("2026-W40"), "2026-09-28");
  assert.equal(W.weekMonday("2026-W54"), null);
  const segs = W.weekSegments("2026-09-28", "2026-10-04");
  assert.deepEqual(segs.map((s) => [s.week, s.month, s.start, s.end, s.days]), [["2026-W40", "2026-09", "2026-09-28", "2026-09-30", 3], ["2026-W40", "2026-10", "2026-10-01", "2026-10-04", 4]]);
});

// ------------------------------------------------------------------ VPB

test("VPB: brackets per year from the rules; a week across the year end taxes each year on its own", () => {
  const rules = noVatRules();
  // 2025-12-29 (Mon) .. 2026-01-04 (Sun): 4 days in 2025, 3 in 2026. 300k in 2025 days, 100k in 2026 days.
  const model = W.computeWeeks({
    today: "2026-01-05",
    fromDate: "2025-12-29",
    days: days({ "2025-12-30": 300000, "2026-01-02": 100000 }),
    usdPerEur: rate1,
    rules,
  });
  const week = model.weeks.find((w) => w.week === "2026-W01");
  assert.deepEqual(week.segments.map((s) => s.year), [2025, 2026]);
  assert.equal(Math.round(week.segments[0].vpbEur), 38000 + 25800, "2025: 19% of 200k + 25.8% of 100k");
  assert.equal(Math.round(week.segments[1].vpbEur), 19000, "2026 starts again in the first bracket");
  assert.equal(model.years.length, 2);
  // A year without brackets uses the latest earlier year and says so.
  const later = W.computeWeeks({ today: "2027-01-10", fromDate: "2027-01-04", days: days({ "2027-01-05": 1000 }), usdPerEur: rate1, rules });
  assert.equal(Math.round(later.weeks[0].vpbEur), 190);
  assert.ok(later.warnings.some((w) => /No corporate tax brackets for 2027; the 2026 brackets are used/.test(w)));
});

test("VPB: weekly reserve is marginal on the year-to-date profit; a loss week releases reserve", () => {
  const rules = noVatRules();
  const model = W.computeWeeks({
    today: "2026-03-01",
    fromDate: "2026-02-02",
    days: days({ "2026-02-03": 150000, "2026-02-10": 100000, "2026-02-17": 0.0001 }),
    usdPerEur: rate1,
    costsByMonth: new Map([["2026-02", [{ date: "2026-02-18", amountUsd: 80000, recurring: "none", eurUsdRate: 1 }]]]),
    rules,
  });
  const [w1, w2, w3] = model.weeks;
  assert.equal(Math.round(w1.vpbEur), 28500);
  assert.equal(Math.round(w2.vpbEur), 9500 + 12900, "50k at 19% then 50k at 25.8%");
  assert.equal(Math.round(w3.vpbEur), -(50000 * 0.258 + 30000 * 0.19), "loss week releases at the marginal rates");
  assert.equal(Math.round(model.weeks.reduce((s, w) => s + w.vpbEur, 0)), Math.round(170000 * 0.19), "sum of weeks = tax on the year");
});

test("VPB: a year that ends with a loss carries it forward (full up to EUR 1m, 50% above)", () => {
  const rules = noVatRules();
  assert.equal(W.taxableAfterLoss(100, 300), 0);
  assert.equal(W.taxableAfterLoss(1500000, 2000000), 1500000 - (1000000 + 250000));
  const model = W.computeWeeks({
    today: "2026-01-20",
    fromDate: "2025-12-01",
    days: days({ "2026-01-06": 50000 }),
    usdPerEur: rate1,
    costsByMonth: new Map([["2025-12", [{ date: "2025-12-02", amountUsd: 30000, recurring: "none", eurUsdRate: 1 }]]]),
    rules,
  });
  assert.equal(model.years[0].lossCarriedOutEur, 30000);
  const jan = model.weeks.find((w) => w.week === "2026-W02");
  assert.equal(Math.round(jan.vpbEur), Math.round(20000 * 0.19), "only the profit above the 2025 loss is taxed");
});

// ------------------------------------------------------------------ VAT, costs, reconciliation

test("VAT per lane: included in the fee (rate / (1 + rate)); exempt and outside-scope lanes pay none", () => {
  const rules = R.effectiveTaxRuleSet(null);
  assert.equal(R.vatLaneOf("bonding-route:101"), "trading_fees");
  assert.equal(R.vatLaneOf("dbc-referral:101"), "dbc_referral");
  assert.equal(R.vatLaneOf("whatever:1"), "other");
  const model = W.computeWeeks({
    today: "2026-02-10",
    fromDate: "2026-02-02",
    days: { "2026-02-03": { totalUsd: 1331, lanes: [lane(1210, "arena-boosts:101"), lane(121, "dbc-referral:101")] } },
    usdPerEur: () => 1.1,
    rules,
  });
  const w = model.weeks[0];
  assert.equal(Math.round(w.revenueEur), 1210);
  assert.equal(Math.round(w.vatEur * 100) / 100, Math.round((1100 * 0.21 / 1.21) * 100) / 100, "21% inside the arena boost fee; none on the Meteora referral");
});

test("costs: one-off on its date, recurring spread over the month's days; weeks reconcile to the month", () => {
  const rules = noVatRules();
  const costs = [
    { date: "2026-09-10", amountUsd: 100, recurring: "none", eurUsdRate: 1 },
    { date: "2026-09-01", amountUsd: 300, recurring: "monthly", eurUsdRate: 1 },
  ];
  const months = new Map([["2026-09", { status: "open", revenueUsd: 900, costsUsd: 400 }]]);
  const model = W.computeWeeks({
    today: "2026-10-04",
    fromDate: "2026-09-01",
    days: days({ "2026-09-02": 300, "2026-09-29": 600 }),
    usdPerEur: rate1,
    costsByMonth: new Map([["2026-09", costs]]),
    months,
    rules,
  });
  const w36 = model.weeks.find((w) => w.week === "2026-W36"); // Mon 31 Aug .. Sun 6 Sep: 6 September days
  assert.equal(Math.round(w36.costsUsd * 100) / 100, 60, "300 * 6/30");
  const rec = W.reconcileMonths(model, months, "2026-10-04");
  assert.equal(rec[0].month, "2026-09");
  assert.equal(rec[0].complete, true);
  assert.equal(rec[0].revenueDiffUsd, 0);
  assert.equal(rec[0].costsDiffUsd, 0);
  assert.equal(rec[0].reconciled, true);
  assert.deepEqual(rec[0].weeks, ["2026-W36", "2026-W37", "2026-W38", "2026-W39", "2026-W40"]);
});

test("closed month: the snapshot wins; the difference is booked on the month's last segment", () => {
  const months = new Map([["2026-09", { status: "closed", revenueUsd: 1000, costsUsd: 0 }]]);
  const model = W.computeWeeks({ today: "2026-10-04", fromDate: "2026-09-01", days: days({ "2026-09-02": 990 }), usdPerEur: rate1, months, rules: noVatRules() });
  const last = model.segments.filter((s) => s.month === "2026-09").at(-1);
  assert.equal(Math.round(last.closeAdjustmentUsd), 10);
  assert.equal(W.reconcileMonths(model, months, "2026-10-04")[0].revenueDiffUsd, 0);
});

// ------------------------------------------------------------------ withholding

test("withholding per entity: Dutch holding and US corporation exempt from 5%; treaty fallback; override", () => {
  const rules = R.effectiveTaxRuleSet(null);
  const nl = R.withholdingFor({ bps: 5000, entity: "Dutch personal holding (BV)" }, rules);
  assert.equal(nl.entityType, "dutch_holding_bv");
  assert.equal(nl.rate, 0);
  assert.match(nl.reason, /art\. 4 lid 1/);
  assert.equal(R.withholdingFor({ bps: 400, entityType: "dutch_holding_bv" }, rules).rate, 0.15);
  const us = R.withholdingFor({ bps: 2000, entity: "US corporation" }, rules);
  assert.equal(us.entityType, "us_corporation");
  assert.equal(us.rate, 0);
  assert.equal(us.fallbackRate, 0.05, "treaty art. 10: 5% for a company with at least 10%");
  assert.equal(us.confidence, "medium");
  assert.equal(R.withholdingFor({ bps: 700, entityType: "us_corporation" }, rules).fallbackRate, 0.15, "below 10%: treaty 15%");
  assert.equal(R.withholdingFor({ bps: 300, entityType: "us_corporation" }, rules).rate, 0.15);
  assert.equal(R.withholdingFor({ bps: 2000, entityType: "natural_person" }, rules).rate, 0.15);
  const other = R.withholdingFor({ bps: 2000, entityType: "other" }, rules);
  assert.equal(other.needsConfirmation, true);
  const forced = R.withholdingFor({ bps: 2000, entityType: "us_corporation", withholdingOverride: true, withholdingPct: 5 }, rules);
  assert.equal(forced.rate, 0.05);
  assert.equal(forced.override, true);
  assert.match(forced.reason, /Set by hand to 5%/);
});

test("rules: validated against the default shape, unknown keys dropped, low confidence flagged", () => {
  const table = R.rulesTable(R.effectiveTaxRuleSet(null));
  assert.ok(table.every((r) => /^https:\/\//.test(r.source) && r.checkedOn === "2026-10-05" && ["high", "medium", "low"].includes(r.confidence)));
  assert.ok(table.find((r) => r.key === "vat.trading_fees").needsConfirmation);
  assert.equal(table.find((r) => r.key === "vpb.2026").value, "19% up to EUR 200,000, 25.8% above");
  const changed = R.validateTaxRuleSet({ dividendTax: { rate: 0.2 }, evil: 1, vpb: { years: { 2027: { brackets: [{ upTo: 100000, rate: 0.2 }, { upTo: null, rate: 0.3 }] } } } });
  assert.equal(changed.dividendTax.rate, 0.2);
  assert.equal(changed.evil, undefined);
  assert.deepEqual(Object.keys(changed.vpb.years), ["2027"]);
  assert.throws(() => R.validateTaxRuleSet({ dividendTax: { rate: 15 } }), /fraction between 0 and 1/);
  assert.throws(() => R.validateTaxRuleSet({ dividendTax: { confidence: "sure" } }), /high, medium or low/);
  assert.equal(R.addMonthsToDate("2026-01-31", 1), "2026-02-28");
});

// ------------------------------------------------------------------ distribution

const SHARES = { shares: [
  { id: "a", name: "Patrick", entity: "Dutch personal holding (BV)", entityType: "dutch_holding_bv", bps: 5000, withholdingPct: 0, evmAddress: "0x1111111111111111111111111111111111111111", solanaAddress: "So11111111111111111111111111111111111111112" },
  { id: "b", name: "Sven", entity: "Dutch personal holding (BV)", entityType: "dutch_holding_bv", bps: 3000, withholdingPct: 0, evmAddress: "0x2222222222222222222222222222222222222222", solanaAddress: "So11111111111111111111111111111111111111112" },
  { id: "c", name: "Dough", entity: "US corporation", entityType: "us_corporation", bps: 2000, withholdingPct: 0, evmAddress: "0x3333333333333333333333333333333333333333", solanaAddress: "So11111111111111111111111111111111111111112" },
] };
const chain = (chainId, usd, price, decimals) => ({ chainId, chain: chainId === 101 ? "solana" : "bnb", asset: chainId === 101 ? "SOL" : "BNB", decimals, multisigAddress: chainId === 101 ? SQUADS : SAFE, multisigUsd: usd, multisigRaw: String(BigInt(Math.round((usd / price) * 1e6)) * 10n ** BigInt(decimals - 6)), priceUsd: price });

function simpleModel(records = []) {
  // Week 2026-W39 (21..27 Sep) earns 10,000; W40 is in progress (today 2026-10-04 is its Sunday).
  return W.computeWeeks({ today: "2026-10-04", fromDate: "2026-09-21", days: days({ "2026-09-22": 10000, "2026-10-01": 500 }), usdPerEur: rate1, rules: noVatRules(), records });
}

test("decision: profit after tax of the last complete week, capped by cash in the multisig; the rest carries over", () => {
  const model = simpleModel();
  assert.equal(model.weeks.find((w) => w.week === "2026-W40").status, "in_progress");
  // Profit 10,000, VPB 1,900 -> 8,100 entitlement. W40 in progress adds its reserve (95) to reserves held.
  const rich = W.decideWeek({ model, chains: [chain(101, 20000, 200, 9)], openCostsUsd: 0, usdPerEurNow: 1, settings: SHARES, rules: noVatRules(), today: "2026-10-04" });
  assert.equal(rich.week, "2026-W39");
  assert.equal(rich.entitlementEur, 8100);
  assert.equal(rich.availableEur, 8100);
  assert.equal(rich.cappedBy, "profit");
  assert.deepEqual(rich.shares.map((s) => [s.name, s.grossEur, s.withholdingEur, s.netEur]), [["Patrick", 4050, 0, 4050], ["Sven", 2430, 0, 2430], ["Dough", 1620, 0, 1620]]);
  assert.ok(rich.shares[0].perChain[0].units !== "0");
  assert.ok(rich.obligations.some((o) => o.key === "us_exemption_notice" && o.dueOn === "2026-11-04"));
  const poor = W.decideWeek({ model, chains: [chain(101, 5000, 200, 9)], openCostsUsd: 500, usdPerEurNow: 1, settings: SHARES, rules: noVatRules(), today: "2026-10-04" });
  // Cash 5,000 - open costs 500 - reserves held (1,900 + 95) = 2,505.
  assert.equal(poor.cashCapEur, 2505);
  assert.equal(poor.availableEur, 2505);
  assert.equal(poor.cappedBy, "cash");
  assert.equal(poor.carryOverEur, 5595);
  assert.match(poor.why, /carries over/);
  assert.equal(poor.checklist.balanceTest.passesOnEstimate, true);
});

test("withholding in the decision: a natural person gets 15% withheld, a return is due with the amount", () => {
  const model = simpleModel();
  const settings = { shares: [{ ...SHARES.shares[0], bps: 10000, entityType: "natural_person" }] };
  const d = W.decideWeek({ model, chains: [chain(101, 20000, 200, 9)], openCostsUsd: 0, usdPerEurNow: 1.1, settings, rules: noVatRules(), today: "2026-10-04" });
  assert.equal(d.shares[0].grossEur, 8100);
  assert.equal(d.shares[0].withholdingEur, 1215);
  assert.equal(d.shares[0].netEur, 6885);
  assert.equal(d.shares[0].grossUsd, 8910);
  const ret = d.obligations.find((o) => o.key === "dividend_tax_return");
  assert.equal(ret.amountEur, 1215);
  assert.equal(ret.dueOn, "2026-11-04");
});

test("recorded distributions (approved or paid) come off the carry-over; proposed ones do not", () => {
  const paid = simpleModel([{ week: "2026-W39", status: "paid", totalGrossEur: 8100, totalNetEur: 8100, totalWithholdingEur: 0 }]);
  const w39 = paid.weeks.find((w) => w.week === "2026-W39");
  assert.equal(w39.distributedEur, 8100);
  assert.equal(w39.distributableEur, 0);
  assert.equal(w39.carryOutEur, 0);
  const proposed = simpleModel([{ week: "2026-W39", status: "proposed", totalGrossEur: 8100 }]);
  assert.equal(proposed.weeks.find((w) => w.week === "2026-W39").distributableEur, 8100);
  // Approved but not paid: off the entitlement and held back from cash.
  const approved = [{ week: "2026-W38", status: "approved", totalGrossEur: 1000, totalNetEur: 1000, totalWithholdingEur: 0 }];
  const model = W.computeWeeks({ today: "2026-10-04", fromDate: "2026-09-14", days: days({ "2026-09-15": 2000, "2026-09-22": 10000 }), usdPerEur: rate1, rules: noVatRules(), records: approved });
  const d = W.decideWeek({ model, chains: [chain(101, 100000, 200, 9)], openCostsUsd: 0, usdPerEurNow: 1, settings: SHARES, rules: noVatRules(), records: approved, today: "2026-10-04" });
  assert.equal(d.reserves.approvedNotPaidEur, 1000);
  assert.equal(d.entitlementEur, Math.round((12000 - 12000 * 0.19 - 1000) * 100) / 100);
});

// ------------------------------------------------------------------ handler

const fakeFx = { rate: async (date) => ({ usdPerEur: 1.1, date: date || "2026-10-02", source: "ECB test" }) };
const fakePrices = { spot: async () => null, hourly: async () => new Map(), spotTable: async () => [], valueEvents: async () => ({ amountUsd: 0 }) };

function setup({ distributionsInstalled = true, multisigUsd = 50000 } = {}) {
  const db = createFakeAccountingDb({ distributionsInstalled });
  const dayRows = { "2026-09-22": { totalUsd: 11000, lanes: [lane(11000, "dbc-referral:101")] } };
  const handler = createFinanceAccountingHandler({
    db,
    prices: fakePrices,
    fx: fakeFx,
    nowMs: () => NOW,
    revenue: async ({ fromMonth, toMonth }) => {
      const months = {};
      for (let m = fromMonth; m <= toMonth; m = m.endsWith("-12") ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 5)}${String(Number(m.slice(5)) + 1).padStart(2, "0")}`) months[m] = { totalUsd: m === "2026-09" ? 11000 : 0, lanes: m === "2026-09" ? [{ amountUsd: 11000 }] : [] };
      return { months, notes: [] };
    },
    dailyRevenue: async () => ({ days: dayRows, notes: [] }),
    balances: async () => ({ chains: [chain(101, multisigUsd * 0.4, 200, 9), { ...chain(56, multisigUsd * 0.6, 600, 18) }], operatorUsd: 10000, errors: [] }),
  });
  async function call(method, path, { principal = MANAGER, body, query = {} } = {}) {
    let statusCode = 200;
    let payload;
    let sent;
    const headers = {};
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

test("routes: weekly and tax-rules are accounting paths", () => {
  for (const p of ["/api/admin/finance/weekly", "/api/admin/finance/tax-rules", "/api/admin/finance/distributions/records/3"]) assert.equal(isFinanceAccountingPath(p), true, p);
});

test("GET weekly: EUR per week, decision for the last complete week, per shareholder net, reconciliation", async () => {
  const { call } = setup();
  const out = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER, query: { weeks: "4" } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.schemaVersion, "finance-weekly-v1");
  assert.match(out.body.weekRule, /ISO weeks, Monday to Sunday, UTC/);
  assert.equal(out.body.weeks[0].week, "2026-W40");
  const w39 = out.body.weeks.find((w) => w.week === "2026-W39");
  assert.equal(w39.revenueEur, 10000, "11,000 USD at 1.1");
  assert.equal(w39.vatEur, 0, "Meteora referral: outside the scope of Dutch VAT");
  assert.equal(w39.vpbEur, 1900);
  assert.equal(out.body.decision.week, "2026-W39");
  assert.equal(out.body.decision.availableEur, 8100);
  assert.deepEqual(out.body.decision.shares.map((s) => s.netEur), [4050, 2430, 1620]);
  assert.equal(out.body.decision.shares[2].withholding.fallbackRate, 0.05);
  assert.equal(out.body.decision.shares[0].evmAddress, undefined, "addresses are not echoed in the weekly view");
  const sep = out.body.reconciliation.find((r) => r.month === "2026-09");
  assert.equal(sep.reconciled, true);
  assert.equal(out.body.recordsInstalled, true);
  assert.ok(out.body.needsConfirmation.length > 0);
});

test("tax rules: GET with sources; PUT needs finance.manage, is audit logged, and changes the weekly numbers", async () => {
  const { call, db } = setup();
  const view = await call("GET", "/api/admin/finance/tax-rules", { principal: VIEWER });
  assert.equal(view.status, 200);
  assert.match(view.body.label, /checked 2026-10-05/);
  assert.ok(view.body.table.length > 15);
  assert.equal((await call("PUT", "/api/admin/finance/tax-rules", { principal: VIEWER, body: { rules: {} } })).status, 403);
  const rules = structuredClone(view.body.rules);
  rules.withholding.us_corporation.exemptMinBps = 10000; // pretend the exemption is refused: treaty 5%
  const put = await call("PUT", "/api/admin/finance/tax-rules", { body: { rules } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(db.state.audit.at(-1).action, "settings.tax_rules");
  const weekly = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  const dough = weekly.body.decision.shares[2];
  assert.equal(dough.withholdingRate, 0.05);
  assert.equal(dough.withholdingEur, 81);
  const history = await call("GET", "/api/admin/finance/tax-rules", { principal: VIEWER });
  assert.ok(history.body.history[0].changes.some((line) => /Withholding: US corporation/.test(line)));
});

test("records: create from the decision week, approve after the checklist, paid needs tx hashes; carry-over drops", async () => {
  const { call, db } = setup();
  const wrongWeek = await call("POST", "/api/admin/finance/distributions/records", { body: { week: "2026-W38" } });
  assert.equal(wrongWeek.status, 400);
  const created = await call("POST", "/api/admin/finance/distributions/records", { body: { week: "2026-W39", availableOn: "2026-10-05" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rec = created.body.record;
  assert.equal(rec.status, "proposed");
  assert.equal(rec.totalGrossEur, 8100);
  assert.equal(rec.dividendTaxDueOn, "2026-11-05", "US exemption notice due 1 month after the dividend is made available");
  assert.equal(db.state.audit.at(-1).action, "distribution.create");
  assert.equal((await call("POST", "/api/admin/finance/distributions/records", { body: { week: "2026-W39" } })).status, 409);
  const early = await call("PATCH", `/api/admin/finance/distributions/records/${rec.id}`, { body: { status: "approved" } });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /shareholder resolution, board approval, balance test, liquidity test/);
  const approved = await call("PATCH", `/api/admin/finance/distributions/records/${rec.id}`, { body: { checklist: { shareholderResolution: true, boardApproval: true, balanceTest: true, liquidityTest: true }, status: "approved" } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.record.decidedBy, "manager@example.com");
  const noHash = await call("PATCH", `/api/admin/finance/distributions/records/${rec.id}`, { body: { status: "paid" } });
  assert.equal(noHash.status, 400);
  const badHash = await call("PATCH", `/api/admin/finance/distributions/records/${rec.id}`, { body: { txHashes: { 56: "0x12" } } });
  assert.equal(badHash.status, 400);
  const paid = await call("PATCH", `/api/admin/finance/distributions/records/${rec.id}`, { body: { status: "paid", txHashes: { 101: "5".repeat(88), 56: `0x${"a".repeat(64)}` } } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.record.status, "paid");
  assert.equal((await call("PATCH", `/api/admin/finance/distributions/records/${rec.id}`, { body: { status: "cancelled" } })).status, 409);
  const weekly = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  const w39 = weekly.body.weeks.find((w) => w.week === "2026-W39");
  assert.equal(w39.distributedEur, 8100);
  assert.equal(w39.carryOutEur, 0);
  assert.equal(weekly.body.decision.availableEur, 0);
  assert.equal(db.state.audit.filter((a) => a.action === "distribution.update").length, 2);
});

test("before the migration: weekly works with rules from code; recording and saving rules answer 503", async () => {
  const { call } = setup({ distributionsInstalled: false });
  const weekly = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  assert.equal(weekly.status, 200, JSON.stringify(weekly.body));
  assert.equal(weekly.body.recordsInstalled, false);
  assert.match(weekly.body.migration, /20261005_000001_finance_distributions\.sql/);
  const rec = await call("POST", "/api/admin/finance/distributions/records", { body: { week: "2026-W39" } });
  assert.equal(rec.status, 503);
  const rules = await call("GET", "/api/admin/finance/tax-rules", { principal: VIEWER });
  assert.equal(rules.body.installed, false);
  const put = await call("PUT", "/api/admin/finance/tax-rules", { body: { rules: rules.body.rules } });
  assert.equal(put.status, 503);
  assert.equal((await call("GET", "/api/admin/finance/distributions", { principal: VIEWER })).status, 200, "the existing pages keep working");
});

test("weekly proposal files: only the decision week; amounts from the weekly view; nothing signed", async () => {
  const { call } = setup();
  await call("PUT", "/api/admin/finance/distributions", { body: { settings: SHARES } });
  const old = await call("GET", "/api/admin/finance/distributions/safe-batch", { principal: VIEWER, query: { chainId: "56", week: "2026-W38" } });
  assert.equal(old.status, 400);
  const file = await call("GET", "/api/admin/finance/distributions/safe-batch", { principal: VIEWER, query: { chainId: "56", week: "2026-W39" } });
  assert.equal(file.status, 200, JSON.stringify(file.body));
  assert.match(file.headers["content-disposition"], /mwz-distribution-proposal-2026-W39-56-2026-10-04/);
  const batch = JSON.parse(file.text);
  assert.match(batch.meta.name, /2026-W39/);
  const total = batch.transactions.reduce((s, t) => s + BigInt(t.value), 0n);
  // 8,100 EUR * 1.1 = 8,910 USD; BNB holds 60% of the multisig -> ~5,346 USD at $600.
  assert.ok(Math.abs(Number(total) / 1e18 * 600 - 8910 * 0.6) < 1, `total ${total}`);
  const squads = await call("GET", "/api/admin/finance/distributions/squads-proposal", { principal: VIEWER, query: { week: "2026-W39" } });
  assert.match(squads.text, /Week 2026-W39 \(2026-09-21 to 2026-09-27\): available to divide EUR 8100\.00/);
  assert.match(squads.text, /PROPOSAL ONLY/);
});

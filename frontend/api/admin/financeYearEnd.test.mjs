// Year-end package (B8): P&L, balance sheet, tax summary and the package
// files, on one fixture worked out by hand. 15 SOL of fee revenue in 2026
// (10 SOL at $100 in March, 5 SOL at $200 in November, USD/EUR 1.1), one USD
// cost paid from the bank, a VAT payment, an approved distribution; SOL is
// $80 at 31 December 2026 (write-down) and $150 in February 2027 (reversal).
import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { createFinanceAccountingHandler, isFinanceAccountingPath } = await import("./financeAccounting.js");
const { createFakeAccountingDb } = await import("./financeAccountingFakeDb.mjs");
const Y = await import("../lib/financeYearEnd.js");
const R = await import("../lib/financeTaxRules.js");
const { crc32 } = await import("../lib/financeZip.js");

const NOW = Date.parse("2027-02-15T12:00:00Z");
const MANAGER = { authUserId: "u-man", email: "manager@example.com", permissions: ["dashboard.view", "finance.view", "finance.manage"] };
const VIEWER = { authUserId: "u-view", email: "viewer@example.com", permissions: ["dashboard.view", "finance.view"] };
const RATE = 1.1;
const near = (a, b, msg, tol = 0.011) => assert.ok(a != null && Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);
const VAT = 0.21 / 1.21;

const DAYS = {
  "2026-03-10": { totalUsd: 1000, lanes: [{ chainId: 101, chain: "solana", lane: "bonding_curve_fee", laneId: "bonding-route:101", source: "Bonding-curve trade fee protocol share", asset: "SOL", nativeAmount: "10", amountUsd: 1000 }] },
  "2026-11-05": { totalUsd: 1000, lanes: [{ chainId: 101, chain: "solana", lane: "bonding_curve_fee", laneId: "bonding-route:101", source: "Bonding-curve trade fee protocol share", asset: "SOL", nativeAmount: "5", amountUsd: 1000 }] },
};
const MONTH_USD = { "2026-03": 1000, "2026-11": 1000 };
const YEAR_END_HOUR = Date.parse("2026-12-31T23:00:00Z");

const fakeFx = { rate: async (date) => ({ usdPerEur: RATE, date: date || "2027-02-15", source: "ECB test" }) };
const fakePrices = {
  spot: async (asset) => (asset === "SOL" ? { priceUsd: 150, source: "spot test" } : null),
  hourly: async (asset, hours) => new Map(hours.filter((h) => asset === "SOL" && h === YEAR_END_HOUR).map((h) => [h, 80])),
  spotTable: async () => [],
  valueEvents: async () => ({ amountUsd: 0 }),
};

function nextMonth(m) {
  return m.endsWith("-12") ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 5)}${String(Number(m.slice(5)) + 1).padStart(2, "0")}`;
}

function setup({ distributions = [], payouts } = {}) {
  const db = createFakeAccountingDb();
  const handler = createFinanceAccountingHandler({
    db,
    prices: fakePrices,
    fx: fakeFx,
    nowMs: () => NOW,
    revenue: async ({ fromMonth, toMonth }) => {
      const months = {};
      for (let m = fromMonth; m <= toMonth; m = nextMonth(m)) {
        const usd = MONTH_USD[m] || 0;
        months[m] = { totalUsd: usd, lanes: usd ? Object.entries(DAYS).filter(([d]) => d.startsWith(m)).flatMap(([, d]) => d.lanes) : [] };
      }
      return { months, notes: [] };
    },
    dailyRevenue: async () => ({ days: structuredClone(DAYS), notes: [] }),
    revenueEvents: async () => ({ rows: Object.entries(DAYS).map(([d, day]) => ({ occurredAt: `${d}T10:00:00.000Z`, month: d.slice(0, 7), chainId: 101, chain: "solana", laneId: day.lanes[0].laneId, amountNative: day.lanes[0].nativeAmount, amountUsd: day.totalUsd, amountEur: day.totalUsd / RATE, txHash: `tx-${d}` })), truncated: false }),
    balances: async () => ({ chains: [{ chainId: 101, chain: "solana", asset: "SOL", multisigAddress: "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv", multisigAmount: 15, multisigUsd: 2250, multisigRaw: "15000000000", operator: { address: null, amount: 0, amountUsd: 0 }, protocolVault: { address: null, amount: 0, amountUsd: 0 } }], operatorUsd: 0, errors: [] }),
    vatEvidenceEvents: async () => ({ events: [] }),
    listDistributions: async () => distributions,
    payouts: payouts || (async () => ({ networks: [{ chainId: 101, chain: "solana", status: "ok", data: { types: [{ id: "weekly_league", label: "Weekly league prizes", asset: "SOL", owed: { known: true, total: { amount: "2", amountUsd: 300 } }, coverage: { status: "covered" } }, { id: "operator_fill", label: "Operator cap fill", owed: { known: true, total: { amount: "1", amountUsd: 150 } }, coverage: { status: "not_applicable" } }] } }], totals: { owed: { amountUsd: 300 } } })),
  });
  async function call(method, path, { principal = MANAGER, body, query = {} } = {}) {
    let statusCode = 200;
    let payload;
    const headers = {};
    const res = { headersSent: false, setHeader(k, v) { headers[k] = v; }, status(code) { statusCode = code; return this; }, json(value) { payload = value; this.headersSent = true; return this; }, send(value) { payload = value; this.headersSent = true; return this; } };
    await handler({ method, path, url: path, query, body, dashboardPrincipal: principal, headers: {} }, res);
    return { status: statusCode, body: payload, headers };
  }
  return { db, call };
}

const APPROVED = { id: "7", week: "2026-W49", status: "approved", decidedAt: "2026-12-01T10:00:00Z", availableOn: null, totalGrossEur: 100, totalWithholdingEur: 0, totalNetEur: 100, usdPerEur: RATE, perChain: [], shares: [] };

async function seed(call) {
  const ok = async (method, path, body, status = 201) => {
    const out = await call(method, path, { body });
    assert.equal(out.status, status, JSON.stringify(out.body));
    return out.body;
  };
  const bank = (await ok("POST", "/api/admin/finance/treasury/accounts", { name: "Bunq", kind: "bank", currency: "EUR" })).account.id;
  const cost = (await ok("POST", "/api/admin/finance/costs", { incurredOn: "2026-05-01", category: "servers", vendor: "Hetzner", amount: "110", currency: "USD", attachmentUrl: "https://example.com/invoice-1.pdf" })).cost;
  await ok("POST", "/api/admin/finance/treasury/movements", { kind: "opening_balance", occurredAt: "2026-01-02", toAccountId: bank, assetIn: "EUR", amountIn: "500" });
  await ok("POST", "/api/admin/finance/treasury/movements", { kind: "bank_payment", occurredAt: "2026-05-02", fromAccountId: bank, assetOut: "EUR", amountOut: "100", costId: cost.id });
  await ok("POST", "/api/admin/finance/tax/items", { taxType: "vat", period: "2026-Q1", kind: "payment", amountEur: "157.78", doneOn: "2026-04-20", accountId: bank });
  return { bank, cost };
}

test("route: year-end is an accounting path, read with finance.view", () => {
  assert.equal(isFinanceAccountingPath("/api/admin/finance/year-end"), true);
});

test("write-down: per asset at cost or lower market; the result carries the change, so a recovery reverses it (never above cost)", () => {
  const rules = R.effectiveTaxRuleSet(null);
  const chain = Y.vpbChain({ modelYears: [{ year: 2026, profitEur: 1000 }, { year: 2027, profitEur: 0 }], year: 2027, writeDownByYear: new Map([[2026, 300], [2027, 0]]), rules });
  assert.equal(chain[0].writeDownChangeEur, 300);
  assert.equal(chain[0].resultBeforeTaxEur, 700);
  near(chain[0].vpbEur, 133, "19% of 700");
  assert.equal(chain[1].writeDownChangeEur, -300, "the market recovered: the write-down is reversed");
  assert.equal(chain[1].resultBeforeTaxEur, 300);
  // A loss year carries forward and is used the next year.
  const loss = Y.vpbChain({ modelYears: [{ year: 2025, profitEur: -400 }, { year: 2026, profitEur: 1000 }], year: 2026, writeDownByYear: new Map(), rules });
  assert.equal(loss[0].lossCarriedOutEur, 400);
  assert.equal(loss[1].lossUsedEur, 400);
  assert.equal(loss[1].taxableEur, 600);
  // An unknown market value keeps the result unknown, never 0.
  const unknown = Y.vpbChain({ modelYears: [{ year: 2026, profitEur: 1000 }], year: 2026, writeDownByYear: new Map([[2026, null]]), rules });
  assert.equal(unknown[0].resultBeforeTaxEur, null);
  assert.equal(unknown[0].vpbEur, null);
});

test("valued holdings: FIFO lots at a date, market per asset, write-down = cost - market when lower", async () => {
  const lotInputs = { acquisitions: [{ date: "2026-01-05", asset: "SOL", amount: 10, eur: 1000, source: "a" }, { date: "2026-06-05", asset: "SOL", amount: 10, eur: 3000, source: "b" }], disposals: [{ date: "2026-07-01", asset: "SOL", amount: 5, proceedsEur: 1500, kind: "conversion", ref: "movement 1" }] };
  const v = await Y.valuedHoldings(lotInputs, "2026-12-31", "fifo", async (key, amount) => ({ eur: amount * 150, source: "test" }));
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].amount, 15);
  assert.equal(v.rows[0].costEur, 500 + 3000, "the oldest 5 left first");
  assert.equal(v.rows[0].marketEur, 2250);
  assert.equal(v.rows[0].writeDownEur, 1250);
  assert.equal(v.rows[0].bookEur, 2250);
  assert.deepEqual(v.rows[0].openLots.map((l) => [l.date, l.amount]), [["2026-01-05", 5], ["2026-06-05", 10]]);
  const before = await Y.valuedHoldings(lotInputs, "2026-03-01", "fifo", async () => ({ eur: null, source: "none" }));
  assert.equal(before.rows[0].amount, 10, "a cut-off date leaves later lots out");
  assert.equal(before.writeDownEur, null, "no price: unknown");
});

test("year end 2026: P&L, write-down, VPB, balance sheet balances, equity rolls forward, reconciles with the Close", async () => {
  const { call } = setup({ distributions: [APPROVED] });
  await seed(call);
  // Close March: its snapshot is then the source for that month.
  const closed = await call("POST", "/api/admin/finance/close/2026-03", { body: { action: "close", confirm: "CLOSE 2026-03" } });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const res = await call("GET", "/api/admin/finance/year-end", { principal: VIEWER, query: { year: "2026" } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const v = res.body;
  assert.equal(v.schemaVersion, "finance-year-end-v1");
  assert.equal(v.asOf, "2026-12-31");
  assert.equal(v.provisional, false);
  assert.equal(v._lots, undefined, "internal lot data is not served");

  const gross = 2000 / RATE;
  near(v.pnl.revenue.grossEur, gross, "gross revenue");
  near(v.pnl.revenue.vatEur, gross * VAT, "VAT 21/121");
  near(v.pnl.revenue.netEur, gross * (1 - VAT), "net revenue");
  assert.equal(v.pnl.revenue.lanes.length, 1);
  near(v.pnl.revenue.lanes[0].netEur, gross * (1 - VAT), "per lane");
  assert.deepEqual(v.pnl.costs.categories.map((c) => [c.category, c.eur]), [["servers", 100]]);
  const operating = gross * (1 - VAT) - 100;
  near(v.pnl.operatingResultEur, operating, "operating result");
  // 15 SOL cost 1818.18 EUR; at $80 they are worth 1090.91 EUR.
  near(v.pnl.writeDown.atYearEndEur, gross - (15 * 80) / RATE, "write-down at 31 December");
  near(v.pnl.writeDown.resultEffectEur, -(gross - (15 * 80) / RATE), "a loss in the year");
  const before = operating - (gross - (15 * 80) / RATE);
  near(v.pnl.resultBeforeTaxEur, before, "result before tax");
  near(v.pnl.vpb.vpbEur, before * 0.19, "VPB 19% bracket");
  near(v.pnl.vpb.reservedDuringYearEur, operating * 0.19, "the reserve left the write-down out", 0.05);
  near(v.pnl.resultAfterTaxEur, before * 0.81, "result after tax");

  const b = v.balance;
  near(b.assets.cashEur, 500 - 100 - 157.78, "bank: opening - cost paid - VAT paid");
  near(b.assets.crypto[0].bookEur, (15 * 80) / RATE, "SOL at the lower market value");
  assert.equal(b.assets.crypto[0].amount, 15);
  const line = (key) => b.liabilities.lines.find((l) => l.key === key).eur;
  assert.equal(line("unpaid_costs"), 0, "the cost was paid from the bank");
  near(line("vat_payable"), 2 * (1000 / RATE) * VAT - 157.78, "Q4 VAT (Q1 paid)", 0.02);
  near(line("vpb_payable"), before * 0.19, "VPB payable");
  assert.equal(line("distributions_payable"), 100, "approved, not paid");
  near(b.equity.openingBalancesRecordedEur, 500, "the opening balance is equity");
  near(b.equity.closingEur, 500 + before * 0.81 - 100, "equity roll-forward");
  assert.equal(b.check.balanced, true, JSON.stringify(b.check));
  assert.equal(b.offBalance.userFunds.onBalanceSheet, false);
  assert.equal(b.offBalance.userFunds.owedEur, null, "a past year: no figure at 31 December, unknown not 0");

  // Reconciliation with the Close: closed March from its snapshot, November live.
  const rec = new Map(v.reconciliation.months.map((m) => [m.month, m]));
  assert.equal(rec.get("2026-03").status, "closed");
  assert.equal(rec.get("2026-03").closeRevenueUsd, 1000);
  assert.equal(rec.get("2026-03").yearEndRevenueUsd, 1000);
  assert.equal(rec.get("2026-11").yearEndRevenueUsd, 1000);
  assert.equal(rec.get("2026-05").closeCostsUsd, 110);
  assert.equal(rec.get("2026-05").yearEndCostsUsd, 110);
  assert.equal(v.reconciliation.totals.reconciled, true);
  // The Close page itself says the same.
  const close = await call("GET", "/api/admin/finance/close", { query: { year: "2026" } });
  assert.equal(close.body.ytd.revenueUsd, v.reconciliation.totals.yearEndRevenueUsd);
  assert.equal(close.body.ytd.costsUsd, v.reconciliation.totals.yearEndCostsUsd);

  // Tax summary: VAT per quarter, deadlines with the annual accounts.
  const q1 = v.tax.vat.quarters.find((q) => q.period === "2026-Q1");
  near(q1.computedEur, (1000 / RATE) * VAT, "Q1 VAT computed");
  assert.equal(q1.paidEur, 157.78);
  assert.ok(v.tax.deadlines.some((d) => d.key === "accounts:2026:prepare" && d.dueOn === "2027-05-31"));
  assert.ok(v.tax.deadlines.some((d) => d.key === "accounts:2026:file" && d.dueOn === "2027-08-08"));
  assert.ok(v.tax.deadlines.some((d) => d.key === "vpb:2026:return" && d.dueOn === "2027-06-01"));

  // Warnings: November not closed; the rules with low confidence; no unknown silently 0.
  assert.ok(v.warnings.some((w) => w.area === "close" && /2026-05/.test(w.text) && /2026-11/.test(w.text)));
  assert.ok(v.warnings.some((w) => w.area === "rules"));
  assert.ok(v.rules.some((r) => r.key === "yearEnd.writeDown" && r.source.startsWith("https://")));
});

test("year end 2027 (running year): the write-down is reversed as SOL recovers; equity opens with 2026; users' money stays off the balance sheet", async () => {
  const { call } = setup({ distributions: [APPROVED] });
  await seed(call);
  const res = await call("GET", "/api/admin/finance/year-end", { query: { year: "2027" } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const v = res.body;
  assert.equal(v.provisional, true);
  assert.equal(v.asOf, "2027-02-15");
  const wd2026 = 2000 / RATE - (15 * 80) / RATE;
  assert.equal(v.pnl.writeDown.atYearEndEur, 0, "$150 is above cost");
  near(v.pnl.writeDown.resultEffectEur, wd2026, "reversal");
  near(v.pnl.resultBeforeTaxEur, wd2026, "only the reversal");
  const before2026 = (2000 / RATE) * (1 - VAT) - 100 - wd2026;
  near(v.balance.equity.openingEur, 500 + before2026 * 0.81 - 100, "opening equity = 2026 closing equity");
  assert.equal(v.balance.check.balanced, true, JSON.stringify(v.balance.check));
  const funds = v.balance.offBalance.userFunds;
  assert.equal(funds.owedUsd, 300);
  near(funds.owedEur, 300 / RATE, "owed to users in EUR");
  assert.deepEqual(funds.types.map((t) => t.type), ["weekly_league"], "the operator cap fill is our money, not a user's");
  assert.ok(v.warnings.some((w) => w.area === "year"), "provisional is said");
  assert.ok(v.balance.chainCheck.lines.some((l) => l.asset === "SOL" && l.differenceAmount === 0));
});

test("files: one CSV per schedule and a ZIP with README, JSON and every schedule; CSV totals equal the JSON", async () => {
  const { call } = setup({ distributions: [APPROVED] });
  await seed(call);
  const json = (await call("GET", "/api/admin/finance/year-end", { query: { year: "2026" } })).body;
  assert.ok(json.schedules.length >= 15);

  const csv = await call("GET", "/api/admin/finance/year-end", { query: { year: "2026", format: "csv", schedule: "01-profit-and-loss" } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers["Content-Disposition"], /mwz-year-end-2026-01-profit-and-loss\.csv/);
  const lines = String(csv.body).trim().split("\r\n");
  assert.equal(lines[0], "section,line,gross_eur,vat_eur,amount_eur,note");
  const after = lines.find((l) => l.startsWith("Result,Result after tax"));
  assert.equal(Number(after.split(",")[4]), json.pnl.resultAfterTaxEur);
  const costs = await call("GET", "/api/admin/finance/year-end", { query: { year: "2026", format: "csv", schedule: "07-costs" } });
  assert.match(String(costs.body), /https:\/\/example\.com\/invoice-1\.pdf/, "evidence link");
  assert.equal((await call("GET", "/api/admin/finance/year-end", { query: { year: "2026", format: "csv", schedule: "99-nope" } })).status, 400);
  assert.equal((await call("GET", "/api/admin/finance/year-end", { query: { year: "2026", format: "csv" } })).status, 400);
  assert.equal((await call("GET", "/api/admin/finance/year-end", { query: { year: "2031" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/finance/year-end", { body: {} })).status, 405);

  const zip = await call("GET", "/api/admin/finance/year-end", { query: { year: "2026", format: "zip" } });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers["Content-Type"], "application/zip");
  const files = unzip(zip.body);
  const names = [...files.keys()];
  assert.ok(names.includes("mwz-year-end-2026/README.txt"));
  assert.ok(names.includes("mwz-year-end-2026/year-end.json"));
  for (const s of json.schedules) assert.ok(names.includes(`mwz-year-end-2026/${s.name}.csv`), s.name);
  const readme = files.get("mwz-year-end-2026/README.txt");
  assert.match(readme, /BV in formation/);
  assert.match(readme, /01-profit-and-loss\.csv/);
  assert.match(readme, /art\. 2:387/);
  assert.match(readme, /https:\/\/www\.kvk\.nl\/deponeren/);
  const inZip = JSON.parse(files.get("mwz-year-end-2026/year-end.json"));
  assert.equal(inZip.pnl.resultAfterTaxEur, json.pnl.resultAfterTaxEur);
  assert.match(files.get("mwz-year-end-2026/06-revenue-events.csv"), /tx-2026-03-10/, "revenue events with their tx");
  assert.match(files.get("mwz-year-end-2026/10-fifo-lot-movements.csv"), /2026-03-10,in,SOL,10/);
});

/** Reads a ZIP (local headers), checks each CRC, returns name -> text. */
function unzip(buffer) {
  const out = new Map();
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const crc = buffer.readUInt32LE(at + 14);
    const size = buffer.readUInt32LE(at + 18);
    const nameLen = buffer.readUInt16LE(at + 26);
    const extra = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const data = inflateRawSync(buffer.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size));
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    out.set(name, data.toString("utf8"));
    at += 30 + nameLen + extra + size;
  }
  assert.equal(buffer.readUInt32LE(at), 0x02014b50, "central directory follows");
  return out;
}

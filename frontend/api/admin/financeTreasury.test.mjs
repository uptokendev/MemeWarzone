import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { createFinanceAccountingHandler, isFinanceAccountingPath } = await import("./financeAccounting.js");
const { createFakeAccountingDb } = await import("./financeAccountingFakeDb.mjs");
const T = await import("../lib/financeTreasury.js");
const C = await import("../lib/financeTaxCalendar.js");
const W = await import("../lib/financeAccountingWeekly.js");
const R = await import("../lib/financeTaxRules.js");
const D = await import("../lib/financeTreasuryDetect.js");

const NOW = Date.parse("2026-10-04T12:00:00Z"); // Sunday: last complete week 2026-W39
const SQUADS = "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv";
const OPERATOR = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";
const VIEWER = { authUserId: "u-view", email: "viewer@example.com", permissions: ["dashboard.view", "finance.view"] };
const MANAGER = { authUserId: "u-man", email: "manager@example.com", permissions: ["dashboard.view", "finance.view", "finance.manage"] };
const SIG = (c) => c.repeat(88);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} vs ${b}`);
const rules = () => R.effectiveTaxRuleSet(null);

// ------------------------------------------------------------------ validation

test("accounts: wallets need chain + address, banks keep only a masked IBAN, kind and address cannot change", () => {
  const w = T.validateAccountInput({ name: "Squads vault", kind: "multisig", chainId: 101, address: SQUADS, currency: "SOL" });
  assert.equal(w.chainId, 101);
  assert.throws(() => T.validateAccountInput({ name: "x", kind: "multisig", chainId: 56, address: SQUADS, currency: "BNB" }), /not a BNB Chain address/);
  assert.throws(() => T.validateAccountInput({ name: "x", kind: "operator_wallet", currency: "SOL" }), /chainId/);
  const b = T.validateAccountInput({ name: "Bunq", kind: "bank", iban: "NL91 ABNA 0417 1643 00", currency: "EUR" });
  assert.equal(b.ibanMasked, "NL** **** **** **** 4300");
  assert.ok(!JSON.stringify(b).includes("0417"), "the full IBAN is never kept");
  assert.throws(() => T.validateAccountInput({ name: "Bunq", kind: "bank", iban: "NL92ABNA0417164300", currency: "EUR" }), /check digits/);
  assert.throws(() => T.validateAccountInput({ address: SQUADS }, { partial: true }), /cannot change/);
  assert.throws(() => T.validateAccountInput({ name: "x", kind: "exchange", currency: "EUR", address: SQUADS }), /only for wallets/);
});

test("movements: each kind has its own legs and accounts; amounts, dates, hashes are checked", () => {
  const now = NOW;
  const ok = (body) => T.validateMovementInput({ occurredAt: "2026-09-25", ...body }, { nowMs: now });
  assert.equal(ok({ kind: "transfer_internal", fromAccountId: "1", toAccountId: "2", assetOut: "SOL", amountOut: "10", assetIn: "SOL", amountIn: "9.99" }).in.amount, "9.99");
  assert.throws(() => ok({ kind: "transfer_internal", fromAccountId: "1", toAccountId: "2", assetOut: "SOL", amountOut: "10", assetIn: "EUR", amountIn: "10" }), /conversion/);
  assert.throws(() => ok({ kind: "transfer_internal", fromAccountId: "1", toAccountId: "2", assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "2" }), /more than was sent/);
  assert.throws(() => ok({ kind: "transfer_internal", fromAccountId: "1", toAccountId: "1", assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "1" }), /two different accounts/);
  assert.equal(ok({ kind: "conversion", fromAccountId: "2", toAccountId: "2", assetOut: "SOL", amountOut: "10", assetIn: "EUR", amountIn: "2200" }).kind, "conversion");
  assert.throws(() => ok({ kind: "conversion", fromAccountId: "2", toAccountId: "2", assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "1" }), /changes the asset/);
  assert.throws(() => ok({ kind: "bank_payment", fromAccountId: "3", assetOut: "SOL", amountOut: "1" }), /EUR or USD/);
  assert.throws(() => ok({ kind: "bank_receipt", toAccountId: "3", assetIn: "EUR", amountIn: "100", costId: "4" }), /only for a bank payment/);
  assert.equal(ok({ kind: "bank_receipt", toAccountId: "3", assetIn: "EUR", amountIn: "100", revenueLane: "sponsorships" }).revenueLane, "sponsorships");
  assert.throws(() => ok({ kind: "owner_loan", fromAccountId: "1", toAccountId: "2", assetIn: "EUR", amountIn: "1" }), /not both/);
  assert.throws(() => ok({ kind: "opening_balance", toAccountId: "1", assetIn: "SOL", amountIn: "-1" }), /positive number/);
  assert.throws(() => ok({ kind: "fee", fromAccountId: "1", assetOut: "EUR", amountOut: "1", txHash: "abc" }), /txHash/);
  assert.throws(() => T.validateMovementInput({ kind: "fee", fromAccountId: "1", assetOut: "EUR", amountOut: "1", occurredAt: "2026-12-01" }, { nowMs: now }), /future/);
  assert.throws(() => ok({ kind: "fee", fromAccountId: "1", assetOut: "EUR", amountOut: "1", extra: 1 }), /Unknown field/);
  // Account kinds: a bank payment leaves a bank; a wallet cannot hold EUR.
  const accounts = new Map([["1", { id: "1", name: "Vault", kind: "multisig" }], ["3", { id: "3", name: "Bunq", kind: "bank" }], ["9", { id: "9", name: "Old", kind: "bank", archivedAt: "2026-01-01" }]]);
  assert.throws(() => T.checkMovementAccounts(ok({ kind: "bank_payment", fromAccountId: "1", assetOut: "EUR", amountOut: "5" }), accounts), /bank account/);
  assert.throws(() => T.checkMovementAccounts(ok({ kind: "opening_balance", toAccountId: "1", assetIn: "EUR", amountIn: "5" }), accounts), /wallet; it cannot hold EUR/);
  assert.throws(() => T.checkMovementAccounts(ok({ kind: "bank_payment", fromAccountId: "9", assetOut: "EUR", amountOut: "5" }), accounts), /archived/);
  assert.throws(() => T.checkMovementAccounts(ok({ kind: "bank_payment", fromAccountId: "77", assetOut: "EUR", amountOut: "5" }), accounts), /no such account/);
});

// ------------------------------------------------------------------ lots

test("FIFO: the oldest units leave first; gain = proceeds - their EUR cost; LIFO and average on request", () => {
  const acquisitions = [{ date: "2026-01-01", asset: "SOL", amount: 2, eur: 200 }, { date: "2026-02-01", asset: "SOL", amount: 2, eur: 400 }];
  const disposals = [{ date: "2026-03-01", asset: "SOL", amount: 3, proceedsEur: 600, kind: "conversion", ref: "m1" }];
  const fifo = T.runLots({ acquisitions, disposals });
  near(fifo.disposals[0].costEur, 200 + 200, "FIFO cost: 2 at 100 + 1 at 200");
  near(fifo.disposals[0].gainEur, 200, "FIFO gain");
  near(fifo.holdings.SOL.costEur, 200, "one unit at 200 left");
  near(T.runLots({ acquisitions, disposals, method: "lifo" }).disposals[0].costEur, 400 + 100, "LIFO cost");
  near(T.runLots({ acquisitions, disposals, method: "average" }).disposals[0].costEur, 450, "average 150 per unit");
  // A loss.
  near(T.runLots({ acquisitions, disposals: [{ ...disposals[0], amount: 1, proceedsEur: 50 }] }).disposals[0].gainEur, -50, "sold below cost");
  // A lot that comes in later is not available to an earlier disposal.
  const early = T.runLots({ acquisitions: [{ date: "2026-05-01", asset: "SOL", amount: 5, eur: 500 }], disposals });
  near(early.disposals[0].gainEur, 0, "no recorded cost: counted at proceeds (no gain)");
  assert.equal(early.uncovered[0].amount, 3);
  // Assets never mix.
  const mixed = T.runLots({ acquisitions: [...acquisitions, { date: "2026-01-01", asset: "BNB", amount: 1, eur: 1000 }], disposals: [{ date: "2026-03-01", asset: "BNB", amount: 1, proceedsEur: 900, kind: "conversion", ref: "b" }] });
  near(mixed.disposals[0].gainEur, -100, "BNB against BNB lots only");
  near(mixed.holdings.SOL.amount, 4, "SOL untouched");
});

test("lot events: revenue days are lots at their EUR value; conversions, crypto fees, crypto costs and paid distributions dispose", () => {
  const acq = T.revenueAcquisitions({ "2026-09-22": { lanes: [{ laneId: "bonding-route:101", asset: "SOL", nativeAmount: "5", amountUsd: 1100 }, { laneId: "home-placements:56", asset: "USD", nativeAmount: "10", amountUsd: 10 }] } }, () => 1.1);
  assert.equal(acq.length, 1, "a lane counted in USD off-chain is not a holding");
  near(acq[0].eur, 1000, "1,100 USD at 1.1");
  const movements = [
    { id: "1", kind: "conversion", occurredAt: "2026-09-25T10:00:00.000Z", out: { asset: "SOL", amount: "2" }, in: { asset: "EUR", amount: "500" }, valueEur: 500, fee: { asset: "SOL", amount: "0.01" }, feeEur: 2 },
    { id: "2", kind: "transfer_internal", occurredAt: "2026-09-24T10:00:00.000Z", out: { asset: "SOL", amount: "3" }, in: { asset: "SOL", amount: "2.99" }, valueEur: 600 },
    { id: "3", kind: "opening_balance", occurredAt: "2026-01-01T12:00:00.000Z", in: { asset: "USDC", amount: "100" }, valueEur: 90 },
    { id: "4", kind: "fee", occurredAt: "2026-09-26T10:00:00.000Z", out: { asset: "EUR", amount: "1" }, valueEur: 1 },
  ];
  const ev = T.treasuryLotEvents({
    movements,
    costs: [{ costId: "7", date: "2026-09-27", currency: "SOL", amount: "1", amountUsd: 220, eurUsdRate: 1.1 }],
    distributions: [{ status: "paid", week: "2026-W40", availableOn: "2026-10-03", usdPerEur: 1.1, perChain: [{ asset: "SOL", units: "500000000", amountUsd: 110 }] }, { status: "proposed", perChain: [{ asset: "SOL", units: "1" }] }],
  });
  assert.deepEqual(ev.disposals.map((d) => [d.kind, d.asset, Number(d.amount.toFixed(4))]).sort(), [["conversion", "SOL", 2], ["cost", "SOL", 1], ["distribution", "SOL", 0.5], ["fee", "SOL", 0.01], ["transfer_shortfall", "SOL", 0.01]].sort());
  assert.deepEqual(ev.acquisitions.map((a) => a.asset), ["USDC"]);
  near(ev.disposals.find((d) => d.kind === "cost").proceedsEur, 200, "crypto cost at its EUR value");
  // Profit per day: gain on the conversion, the fee, the transfer shortfall.
  const lots = T.runLots({ acquisitions: [{ date: "2026-09-01", asset: "SOL", amount: 10, eur: 1000 }, ...ev.acquisitions], disposals: ev.disposals });
  const byDay = T.treasuryByDay({ lotDisposals: lots.disposals, movements, rules: rules(), usdPerEur: () => 1.1 });
  near(byDay.get("2026-09-25").realizedGainEur, (500 - 200) + (2 - 1), "conversion gain + gain on the SOL paid as fee");
  near(byDay.get("2026-09-25").feesEur, 2, "fee expense");
  near(byDay.get("2026-09-24").feesEur, 2, "0.01 SOL lost on the transfer at 200 EUR");
  near(T.dayNetEur(byDay.get("2026-09-25")), 301 - 2, "net = gain - fee");
});

test("bank receipts with a revenue lane are revenue with VAT from the rules; owner money and opening balances never touch profit", () => {
  const movements = [
    { id: "1", kind: "bank_receipt", occurredAt: "2026-09-25T12:00:00.000Z", in: { asset: "EUR", amount: "1210" }, valueEur: 1210, revenueLane: "sponsorships" },
    { id: "2", kind: "owner_contribution", occurredAt: "2026-09-25T12:00:00.000Z", in: { asset: "EUR", amount: "5000" }, valueEur: 5000 },
    { id: "3", kind: "opening_balance", occurredAt: "2026-09-25T12:00:00.000Z", in: { asset: "EUR", amount: "100" }, valueEur: 100 },
  ];
  const d = T.treasuryByDay({ movements, rules: rules(), usdPerEur: () => 1.1 }).get("2026-09-25");
  near(d.otherRevenueEur, 1210, "revenue");
  near(d.otherVatEur, 210, "21% included");
  near(T.dayNetEur(d), 1000, "only the receipt minus its VAT");
});

// ------------------------------------------------------------------ cash

test("cash per account: opening + in - out - fees, and tax paid from or refunded to an account", () => {
  const movements = [
    { kind: "opening_balance", toAccountId: "3", in: { asset: "EUR", amount: "1000" } },
    { kind: "transfer_internal", fromAccountId: "1", toAccountId: "2", out: { asset: "SOL", amount: "10" }, in: { asset: "SOL", amount: "10" }, fee: { asset: "SOL", amount: "0.001" } },
    { kind: "conversion", fromAccountId: "2", toAccountId: "2", out: { asset: "SOL", amount: "10" }, in: { asset: "EUR", amount: "1500" }, fee: { asset: "EUR", amount: "3" } },
    { kind: "transfer_internal", fromAccountId: "2", toAccountId: "3", out: { asset: "EUR", amount: "1490" }, in: { asset: "EUR", amount: "1490" } },
    { kind: "bank_payment", fromAccountId: "3", out: { asset: "EUR", amount: "45" } },
    { kind: "bank_payment", fromAccountId: "3", out: { asset: "EUR", amount: "999" }, deletedAt: "2026-09-30" },
  ];
  const items = [{ kind: "payment", accountId: "3", amountEur: 400 }, { kind: "refund", accountId: "3", amountEur: 15 }, { kind: "payment", accountId: null, amountEur: 50 }];
  const cash = T.cashPerAccount(movements, items);
  near(cash.get("1").get("SOL"), -10.001, "multisig: only what was recorded leaving (the chain balance is read separately)");
  near(cash.get("2").get("SOL"), 0, "exchange SOL");
  near(cash.get("2").get("EUR"), 7, "exchange EUR: 1500 - 3 fee - 1490");
  near(cash.get("3").get("EUR"), 1000 + 1490 - 45 - 400 + 15, "bank");
  const accounts = [{ id: "2", name: "Kraken", kind: "exchange" }, { id: "3", name: "Bunq", kind: "bank" }, { id: "1", name: "Vault", kind: "multisig" }];
  const off = T.offChainCashEur(accounts, cash, 1.1);
  near(off.eur, 7 + 2060, "bank + exchange fiat; the multisig is not off-chain cash");
});

test("a cost paid from the bank is no longer open for the multisig (one-off any time, recurring in its month)", () => {
  const movements = [{ kind: "bank_payment", costId: "5", occurredAt: "2026-09-03T12:00:00.000Z" }, { kind: "bank_payment", costId: "6", occurredAt: "2026-09-10T12:00:00.000Z", deletedAt: "x" }];
  assert.equal(T.bankPaidOccurrence({ costId: "5", recurring: "none", month: "2026-08" }, movements), true);
  assert.equal(T.bankPaidOccurrence({ costId: "5", recurring: "monthly", month: "2026-09" }, movements), true);
  assert.equal(T.bankPaidOccurrence({ costId: "5", recurring: "monthly", month: "2026-10" }, movements), false);
  assert.equal(T.bankPaidOccurrence({ costId: "6", recurring: "none", month: "2026-09" }, movements), false, "deleted payment");
});

// ------------------------------------------------------------------ tax calendar

test("VAT: per quarter, due the last day of the next month; a filed return replaces the estimate; payments release the reserve", () => {
  assert.equal(C.quarterOf("2026-08-14"), "2026-Q3");
  assert.equal(C.vatDueOn("2026-Q3"), "2026-10-31");
  assert.equal(C.vatDueOn("2026-Q4"), "2027-01-31");
  assert.equal(C.vatDueOn("2026-11"), "2026-12-31");
  const base = { today: "2026-11-05", rules: rules(), vatByPeriod: { "2026-Q2": 120, "2026-Q3": 300, "2026-Q4": 50 } };
  const none = C.taxObligations(base);
  near(none.held.vatEur, 470, "nothing recorded: every reserve held");
  const q3 = none.obligations.find((o) => o.key === "vat:2026-Q3");
  assert.equal(q3.status, "overdue");
  assert.equal(q3.amountEur, 300);
  assert.ok(!none.obligations.some((o) => o.key === "vat:2026-Q4"), "the running quarter is not an obligation yet");
  const items = [
    { id: "1", taxType: "vat", period: "2026-Q3", kind: "return_filed", amountEur: 280, doneOn: "2026-10-20" },
    { id: "2", taxType: "vat", period: "2026-Q3", kind: "payment", amountEur: 280, doneOn: "2026-10-28" },
    { id: "3", taxType: "vat", period: "2026-Q2", kind: "payment", amountEur: 100, doneOn: "2026-07-30" },
    { id: "4", taxType: "vat", period: "2026-Q2", kind: "payment", amountEur: 999, doneOn: "2026-07-30", deletedAt: "2026-08-01" },
  ];
  const out = C.taxObligations({ ...base, items });
  assert.equal(out.obligations.find((o) => o.key === "vat:2026-Q3").status, "paid");
  const q2 = out.obligations.find((o) => o.key === "vat:2026-Q2");
  assert.equal(q2.status, "overdue", "paid 100 of 120 without a return");
  near(out.held.vatEur, 0 + 20 + 50, "Q3 released in full (return 280 paid), Q2 20 left, Q4 running");
  const row = out.held.byPeriod.find((p) => p.period === "2026-Q3");
  near(row.releasedEur, 300, "the 20 the return came in under the reserve is released too");
  // Overpaying never raises what can be divided.
  near(C.taxObligations({ ...base, items: [{ id: "9", taxType: "vat", period: "2026-Q2", kind: "payment", amountEur: 500, doneOn: "2026-07-01" }] }).held.vatEur, 350, "no negative hold");
});

test("VPB: provisional assessment in monthly instalments to 31 December; ask before 1 May; return 5 months after the year", () => {
  const parts = C.vpbInstalments({ year: 2026, dated: "2026-02-15", amountEur: 1000 });
  assert.equal(parts.length, 10, "dated 15 February: March to December");
  assert.equal(parts[0].dueOn, "2026-03-31");
  assert.equal(parts[9].dueOn, "2026-12-31");
  near(parts.reduce((s, p) => s + p.amountEur, 0), 1000, "instalments add up");
  assert.equal(C.vpbInstalments({ year: 2026, dated: "2026-11-10", amountEur: 300 })[0].dueOn, "2026-12-22", "less than 2 whole months: one payment within 6 weeks");
  assert.equal(C.vpbInstalments({ year: 2025, dated: "2026-03-10", amountEur: 300, dueOn: "2026-05-01" })[0].dueOn, "2026-05-01", "after the year: the date on the assessment");

  const cal = C.taxObligations({ today: "2026-10-05", rules: rules(), vpbYears: [{ year: 2025, reserveEur: 500 }, { year: 2026, reserveEur: 4000 }] });
  const req = cal.obligations.find((o) => o.key === "vpb:2026:request");
  assert.equal(req.dueOn, "2027-04-30");
  const ret25 = cal.obligations.find((o) => o.key === "vpb:2025:return");
  assert.equal(ret25.dueOn, "2026-06-01");
  assert.equal(ret25.status, "overdue");
  assert.ok(!cal.obligations.some((o) => o.key === "vpb:2026:return"), "the running year has no return yet");
  near(cal.held.vpbEur, 4500, "all VPB held");

  const items = [
    { id: "1", taxType: "vpb", period: "2026", kind: "provisional_assessment", amountEur: 1200, doneOn: "2026-06-10" },
    { id: "2", taxType: "vpb", period: "2026", kind: "payment", amountEur: 400, doneOn: "2026-08-30" },
    { id: "3", taxType: "vpb", period: "2025", kind: "assessment_final", amountEur: 300, doneOn: "2026-09-01", dueOn: "2026-11-01" },
  ];
  const paid = C.taxObligations({ today: "2026-10-05", rules: rules(), vpbYears: [{ year: 2025, reserveEur: 500 }, { year: 2026, reserveEur: 4000 }], items });
  const inst = paid.obligations.filter((o) => o.kind === "provisional_instalment").sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  assert.equal(inst.length, 6, "dated 10 June: July to December");
  assert.deepEqual(inst.slice(0, 4).map((o) => o.status), ["paid", "paid", "overdue", "open"], "200 a month, 400 paid by 5 October: September is overdue");
  near(paid.held.vpbEur, (4000 - 400) + 300, "2026 reserve minus paid; 2025 final assessment replaces its reserve");
  assert.ok(paid.obligations.some((o) => o.key === "vpb:2025:final" && o.dueOn === "2026-11-01"));
  assert.ok(!paid.obligations.some((o) => o.key === "vpb:2026:request"), "a provisional assessment exists");
});

test("dividend tax: return and payment 1 month after the distribution is made available; US exemption notice in the same month", () => {
  const records = [
    { id: "11", week: "2026-W39", status: "paid", availableOn: "2026-09-30", totalWithholdingEur: 150, shares: [{ entityType: "natural_person", grossEur: 1000, withholdingEur: 150 }, { entityType: "us_corporation", grossEur: 500, withholdingEur: 0 }] },
    { id: "12", week: "2026-W38", status: "cancelled", availableOn: "2026-09-20", totalWithholdingEur: 999, shares: [] },
  ];
  const cal = C.taxObligations({ today: "2026-10-05", rules: rules(), records });
  const ret = cal.obligations.find((o) => o.key === "dividend:11:return");
  assert.equal(ret.dueOn, "2026-10-30");
  assert.equal(ret.amountEur, 150);
  assert.equal(ret.status, "open");
  assert.equal(cal.obligations.find((o) => o.key === "dividend:11:notice").dueOn, "2026-10-30");
  near(cal.held.dividendTaxEur, 150, "withheld, not paid");
  assert.equal(cal.next.key.startsWith("dividend:11"), true, "the next deadline");
  const items = [
    { id: "1", taxType: "dividend_tax", period: "2026-W39", kind: "return_filed", amountEur: 150, doneOn: "2026-10-10", distributionId: "11" },
    { id: "2", taxType: "dividend_tax", period: "2026-W39", kind: "payment", amountEur: 150, doneOn: "2026-10-10", distributionId: "11" },
    { id: "3", taxType: "dividend_tax", period: "2026-W39", kind: "notification_filed", amountEur: 0, doneOn: "2026-10-10", distributionId: "11" },
  ];
  const done = C.taxObligations({ today: "2026-10-12", rules: rules(), records, items });
  assert.equal(done.obligations.find((o) => o.key === "dividend:11:return").status, "paid");
  assert.equal(done.obligations.find((o) => o.key === "dividend:11:notice").status, "paid");
  near(done.held.dividendTaxEur, 0, "released");
  assert.equal(done.next, null);
});

test("tax item validation: period per type, done date required and not in the future, links only where they fit", () => {
  const v = (b) => C.validateTaxItemInput(b, { today: "2026-10-05" });
  assert.equal(v({ taxType: "vat", period: "2026-Q3", kind: "payment", amountEur: 10, doneOn: "2026-10-01" }).amountEur, 10);
  assert.throws(() => v({ taxType: "vat", period: "2026", kind: "payment", doneOn: "2026-10-01" }), /quarter/);
  assert.throws(() => v({ taxType: "vpb", period: "2026", kind: "payment", doneOn: "2026-10-09" }), /future/);
  assert.throws(() => v({ taxType: "vpb", period: "2026", kind: "payment" }), /doneOn is required/);
  assert.throws(() => v({ taxType: "vpb", period: "2026", kind: "payment", amountEur: -1, doneOn: "2026-10-01" }), /0 or more/);
  assert.throws(() => C.checkMergedTaxItem({ taxType: "vat", kind: "notification_filed" }), /only for dividend/);
  assert.throws(() => C.checkMergedTaxItem({ taxType: "vat", kind: "return_filed", accountId: "3" }), /payment or refund/);
  assert.throws(() => C.validateTaxItemInput({ period: "2027" }, { partial: true }), /cannot change/);
});

// ------------------------------------------------------------------ weekly decision

const SHARES = { shares: [{ id: "a", name: "Patrick", entity: "Dutch holding BV", entityType: "dutch_holding_bv", bps: 5000, evmAddress: "", solanaAddress: "" }, { id: "b", name: "Sven", entity: "Dutch holding BV", entityType: "dutch_holding_bv", bps: 3000, evmAddress: "", solanaAddress: "" }, { id: "c", name: "Dough", entity: "US corporation", entityType: "us_corporation", bps: 2000, evmAddress: "", solanaAddress: "" }] };
const chain = (usd) => ({ chainId: 101, chain: "solana", asset: "SOL", decimals: 9, multisigAddress: SQUADS, multisigUsd: usd, multisigRaw: String(Math.round((usd / 200) * 1e9)), priceUsd: 200 });
function noVat() {
  const r = rules();
  for (const lane of Object.values(r.vat.lanes)) Object.assign(lane, { treatment: "exempt", rate: 0, taxableShare: 0 });
  return r;
}

test("available to divide: tax paid releases the reserve; bank cash covers what the multisig would hold; without payments nothing changes", () => {
  const model = W.computeWeeks({ today: "2026-10-04", fromDate: "2026-09-21", days: { "2026-09-22": { totalUsd: 10000, lanes: [{ laneId: "bonding-route:101", amountUsd: 10000 }] } }, usdPerEur: () => 1, rules: noVat() });
  const args = { model, chains: [chain(3000)], openCostsUsd: 100, usdPerEurNow: 1, settings: SHARES, rules: noVat(), today: "2026-10-04" };
  const before = W.decideWeek(args);
  near(before.cashCapEur, 3000 - 100 - 1900, "every reserve held (old behaviour)");
  const same = W.decideWeek({ ...args, held: { vpbEur: 1900, vatEur: 0, dividendTaxEur: 0 } });
  near(same.cashCapEur, before.cashCapEur, "no payments: identical");
  const afterPay = W.decideWeek({ ...args, held: { vpbEur: 900, vatEur: 0, dividendTaxEur: 0 } });
  near(afterPay.cashCapEur, 3000 - 100 - 900, "1,000 VPB paid: released");
  near(afterPay.reserves.releasedByPaymentsEur, 1000, "release shown");
  near(afterPay.availableEur, 2000, "capped by cash");
  const bank = W.decideWeek({ ...args, held: { vpbEur: 900, vatEur: 0, dividendTaxEur: 0 }, offChainCashEur: 600 });
  near(bank.cashCapEur, 3000 - (100 + 900 - 600), "the bank pays 600 of the costs and tax");
  near(bank.coveredOffChainEur, 600, "covered");
  const rich = W.decideWeek({ ...args, offChainCashEur: 50000 });
  near(rich.cashCapEur, 3000, "the bank cannot make the multisig hold more than it has; it is never added to it");
  near(rich.availableEur, 3000, "only the multisig is divided");
});

test("treasury in the weekly profit: a realized gain raises profit and the VPB reserve; a closed month keeps its snapshot", () => {
  const byDay = new Map([["2026-09-23", { realizedGainEur: 500, feesEur: 10, otherRevenueEur: 0, otherVatEur: 0, otherRevenueUsd: 0 }]]);
  const base = { today: "2026-10-04", fromDate: "2026-09-21", days: { "2026-09-22": { totalUsd: 10000, lanes: [{ laneId: "bonding-route:101", amountUsd: 10000 }] } }, usdPerEur: () => 1, rules: noVat() };
  const plain = W.computeWeeks(base).weeks.find((w) => w.week === "2026-W39");
  const withGain = W.computeWeeks({ ...base, treasuryByDay: byDay }).weeks.find((w) => w.week === "2026-W39");
  near(withGain.profitEur - plain.profitEur, 490, "gain - fee");
  near(withGain.vpbEur - plain.vpbEur, 490 * 0.19, "taxed at the marginal rate");
  near(W.weekView(withGain).realizedGainEur, 500, "shown in the week");
});

// ------------------------------------------------------------------ handler

const fakeFx = { rate: async (date) => ({ usdPerEur: 1.1, date: date || "2026-10-02", source: "ECB test" }) };
const fakePrices = { spot: async (asset) => (asset === "SOL" ? { priceUsd: 220, source: "spot test" } : null), hourly: async () => new Map(), spotTable: async () => [], valueEvents: async () => ({ amountUsd: 0 }) };

function setup({ treasuryInstalled = true, multisigUsd = 5500, unmatched } = {}) {
  const db = createFakeAccountingDb({ treasuryInstalled });
  // 55 SOL of fee revenue on 22 September, 11,000 USD = 10,000 EUR: 181.82 EUR per SOL.
  const dayRows = { "2026-09-22": { totalUsd: 11000, lanes: [{ laneId: "dbc-referral:101", lane: "DBC referral", asset: "SOL", nativeAmount: "55", amountUsd: 11000 }] } };
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
    balances: async () => ({ chains: [{ ...chain(multisigUsd), operator: { address: OPERATOR, status: "ok", amount: "1", amountUsd: 220 } }], operatorUsd: 220, errors: [] }),
    unmatchedOutflows: unmatched,
  });
  async function call(method, path, { principal = MANAGER, body, query = {} } = {}) {
    let statusCode = 200;
    let payload;
    const res = { headersSent: false, setHeader() {}, status(code) { statusCode = code; return this; }, json(value) { payload = value; this.headersSent = true; return this; }, send() { this.headersSent = true; return this; } };
    await handler({ method, path, url: path, query, body, dashboardPrincipal: principal, headers: {} }, res);
    return { status: statusCode, body: payload };
  }
  return { db, call };
}

test("routes: treasury and tax are accounting paths; tax-reserves and tax-rules still are", () => {
  for (const p of ["/api/admin/finance/treasury", "/api/admin/finance/treasury/movements/3", "/api/admin/finance/tax", "/api/admin/finance/tax/items/2", "/api/admin/finance/tax-reserves", "/api/admin/finance/tax-rules"]) assert.equal(isFinanceAccountingPath(p), true, p);
  assert.equal(isFinanceAccountingPath("/api/admin/finance/taxes"), false);
});

test("handler: accounts, movements and tax items are audit logged; gains, cash, open costs and the weekly cap follow", async () => {
  const { call, db } = setup();
  // finance.view reads, cannot write.
  assert.equal((await call("POST", "/api/admin/finance/treasury/accounts", { principal: VIEWER, body: { name: "x", kind: "exchange", currency: "EUR" } })).status, 403);
  const before = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const capBefore = before.body.decision.cashCapEur;

  const add = async (body) => {
    const out = await call("POST", "/api/admin/finance/treasury/accounts", { body });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    return out.body.account.id;
  };
  const vault = await add({ name: "Squads vault Solana", kind: "multisig", chainId: 101, address: SQUADS, currency: "SOL" });
  const kraken = await add({ name: "Kraken", kind: "exchange", currency: "EUR" });
  const bunq = await add({ name: "Bunq", kind: "bank", iban: "NL91ABNA0417164300", currency: "EUR" });
  assert.equal((await call("POST", "/api/admin/finance/treasury/accounts", { body: { name: "kraken", kind: "exchange", currency: "EUR" } })).status, 409, "names are unique");
  const costRes = await call("POST", "/api/admin/finance/costs", { body: { incurredOn: "2026-09-27", category: "rpc_infra", vendor: "Chainstack", amount: "49.5", currency: "EUR" } });
  assert.equal(costRes.status, 201, JSON.stringify(costRes.body));
  const costId = costRes.body.cost.id;

  const move = async (body, status = 201) => {
    const out = await call("POST", "/api/admin/finance/treasury/movements", { body });
    assert.equal(out.status, status, JSON.stringify(out.body));
    return out.body;
  };
  await move({ kind: "transfer_internal", occurredAt: "2026-09-24T10:00:00Z", fromAccountId: vault, toAccountId: kraken, assetOut: "SOL", amountOut: "10", assetIn: "SOL", amountIn: "10", valueEur: "1900", txHash: SIG("a") });
  const conv = await move({ kind: "conversion", occurredAt: "2026-09-25T10:00:00Z", fromAccountId: kraken, toAccountId: kraken, assetOut: "SOL", amountOut: "10", assetIn: "EUR", amountIn: "2200", feeAsset: "EUR", feeAmount: "5" });
  assert.equal(conv.movement.valueEur, 2200);
  assert.equal(conv.movement.valueSource, "EUR amount");
  assert.equal(conv.movement.feeEur, 5);
  await move({ kind: "transfer_internal", occurredAt: "2026-09-26T10:00:00Z", fromAccountId: kraken, toAccountId: bunq, assetOut: "EUR", amountOut: "2190", assetIn: "EUR", amountIn: "2190" });
  await move({ kind: "bank_payment", occurredAt: "2026-09-27T10:00:00Z", fromAccountId: bunq, assetOut: "EUR", amountOut: "49.5", costId });
  await move({ kind: "transfer_internal", occurredAt: "2026-09-28T10:00:00Z", fromAccountId: vault, toAccountId: kraken, assetOut: "SOL", amountOut: "1", assetIn: "SOL", amountIn: "1", valueEur: "190", txHash: SIG("a") }, 409);
  // A movement priced at the time: no price for that hour and none set by hand.
  const nopx = await move({ kind: "fee", occurredAt: "2026-09-26T10:00:00Z", fromAccountId: kraken, assetOut: "BNB", amountOut: "0.1" }, 400);
  assert.match(nopx.error, /No BNB price/);
  // Closed months cannot get movements.
  db.state.closes.set("2026-08-01", { month: "2026-08-01", status: "closed", snapshot: { revenue: { totalUsd: 0 }, costs: { totalUsd: 0, occurrences: [] }, profitUsd: 0 } });
  await move({ kind: "fee", occurredAt: "2026-08-20", fromAccountId: bunq, assetOut: "EUR", amountOut: "1" }, 409);

  const tr = await call("GET", "/api/admin/finance/treasury", { principal: VIEWER });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  assert.equal(tr.body.canManage, false);
  const gain = 2200 - 10 * (10000 / 55);
  near(tr.body.realized.totalEur, gain, "FIFO gain on the 10 SOL sold");
  assert.equal(tr.body.realized.method, "fifo");
  const bank = tr.body.accounts.find((a) => a.id === bunq);
  assert.equal(bank.ibanMasked, "NL** **** **** **** 4300");
  near(bank.recorded.find((l) => l.asset === "EUR").amount, 2190 - 49.5, "bank cash");
  near(tr.body.accounts.find((a) => a.id === kraken).recorded.find((l) => l.asset === "EUR").amount, 5, "exchange cash");
  assert.equal(tr.body.accounts.find((a) => a.id === vault).chainBalance.source, "fee-routing read (chain, now)");
  assert.deepEqual(tr.body.suggestedAccounts.map((s) => s.kind), ["operator_wallet"], "the vault is set up; the operator wallet is suggested");
  near(tr.body.holdings.find((h) => h.asset === "SOL").amount, 45, "55 earned - 10 sold");
  near(tr.body.offChain.eur, 2140.5 + 5, "bank + exchange EUR");
  assert.equal(tr.body.warnings.length, 0, JSON.stringify(tr.body.warnings));

  const after = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  const w39 = after.body.weeks.find((w) => w.week === "2026-W39");
  near(w39.realizedGainEur, gain, "gain in the week");
  near(w39.treasuryEur, gain - 5, "gain - exchange fee");
  near(after.body.decision.openCostsEur, 0, "the cost was paid from the bank: not open for the multisig");
  near(after.body.treasury.offChainCashEur, 2145.5, "off-chain cash in the weekly view");

  // VPB paid from the bank releases its reserve; the bank balance drops by the same amount.
  const vpbHeld = after.body.decision.reserves.vpbEur;
  const pay = await call("POST", "/api/admin/finance/tax/items", { body: { taxType: "vpb", period: "2026", kind: "payment", amountEur: 1000, doneOn: "2026-10-01", accountId: bunq, reference: "VA 2026" } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal((await call("POST", "/api/admin/finance/tax/items", { body: { taxType: "vat", period: "2026-Q3", kind: "payment", amountEur: 1, doneOn: "2026-10-01", accountId: vault } })).status, 400, "tax is paid from a bank or exchange account");
  const paid = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  near(paid.body.decision.reserves.vpbEur, vpbHeld - 1000, "VPB held drops by the payment");
  near(paid.body.decision.reserves.releasedByPaymentsEur, 1000, "release shown");
  near(paid.body.treasury.offChainCashEur, 1145.5, "the bank paid it");
  near(paid.body.decision.cashCapEur, after.body.decision.cashCapEur, "tax paid from the bank: the reserve and the bank cash drop together, the multisig cap stays");
  assert.ok(after.body.decision.cashCapEur > capBefore, "money in the bank covers reserves the multisig held before");

  const tax = await call("GET", "/api/admin/finance/tax", { principal: VIEWER });
  assert.equal(tax.status, 200, JSON.stringify(tax.body));
  assert.equal(tax.body.items.length, 1);
  assert.ok(tax.body.obligations.some((o) => o.key === "vpb:2026:request"));
  assert.equal(tax.body.canManage, false);

  // Corrections and deletes are logged; the closed-month guard applies to a delete too.
  const id = tax.body.items[0].id;
  assert.equal((await call("PATCH", `/api/admin/finance/tax/items/${id}`, { body: { amountEur: 900 } })).status, 200);
  assert.equal((await call("DELETE", `/api/admin/finance/tax/items/${id}`)).status, 200);
  const actions = db.state.audit.map((a) => a.action);
  for (const action of ["account.create", "movement.create", "tax_item.create", "tax_item.update", "tax_item.delete"]) assert.ok(actions.includes(action), action);
  assert.ok(db.state.audit.filter((a) => a.action === "movement.create").every((a) => a.actorEmail === "manager@example.com" && a.after));
  const mv = db.state.movements[0].id;
  assert.equal((await call("DELETE", `/api/admin/finance/treasury/movements/${mv}`)).status, 200);
  assert.ok(db.state.audit.some((a) => a.action === "movement.delete" && a.before?.id === mv));
  const csv = await call("GET", "/api/admin/finance/exports/treasury-movements", { principal: VIEWER, query: { from: "2026-09", to: "2026-10" } });
  assert.equal(csv.status, 200);
  const archived = await call("PATCH", `/api/admin/finance/treasury/accounts/${kraken}`, { body: { archived: true } });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.account.archivedAt);
});

test("handler: before the migration the views work and writes answer 503 with the file to apply", async () => {
  const { call } = setup({ treasuryInstalled: false });
  const weekly = await call("GET", "/api/admin/finance/weekly", { principal: VIEWER });
  assert.equal(weekly.status, 200, JSON.stringify(weekly.body));
  assert.equal(weekly.body.treasury.installed, false);
  const tax = await call("GET", "/api/admin/finance/tax", { principal: VIEWER });
  assert.equal(tax.status, 200);
  assert.match(tax.body.migration, /20261005_000002_finance_treasury_tax\.sql/);
  const tr = await call("GET", "/api/admin/finance/treasury", { principal: VIEWER });
  assert.equal(tr.body.installed, false);
  const write = await call("POST", "/api/admin/finance/treasury/accounts", { body: { name: "Bunq", kind: "bank", currency: "EUR" } });
  assert.equal(write.status, 503);
  assert.equal(write.body.code, "FINANCE_TREASURY_NOT_INSTALLED");
  assert.equal((await call("POST", "/api/admin/finance/tax/items", { body: { taxType: "vpb", period: "2026", kind: "payment", amountEur: 1, doneOn: "2026-10-01" } })).status, 503);
});

// ------------------------------------------------------------------ unmatched outflows

test("unmatched outflows: recorded hashes and gas-sized moves are left out; a move to one of our accounts is prefilled as a transfer", async () => {
  const accounts = [
    { id: "1", name: "Vault", kind: "multisig", chainId: 101, address: SQUADS },
    { id: "2", name: "Operator", kind: "operator_wallet", chainId: 101, address: OPERATOR },
    { id: "3", name: "Safe BNB", kind: "multisig", chainId: 56, address: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7" },
    { id: "4", name: "Bunq", kind: "bank" },
  ];
  const solana = async (a) => (a.id === "1"
    ? { source: "test rpc", rows: [{ txHash: SIG("b"), at: "2026-10-01T00:00:00.000Z", raw: "2000000000", to: OPERATOR }, { txHash: SIG("c"), at: "2026-10-02T00:00:00.000Z", raw: "5000", to: null }, { txHash: SIG("d"), at: "2026-10-03T00:00:00.000Z", raw: "1000000000", to: "So1anaExchangeDeposit1111111111111111111111" }] }
    : { source: "test rpc", rows: [{ txHash: SIG("e"), at: "2026-10-03T00:00:00.000Z", raw: "3000000000", to: SQUADS }] });
  const out = await D.unmatchedOutflows({ accounts, movements: [{ txHash: SIG("e"), fromAccountId: "2" }], sinceMs: 0, nowMs: NOW + 1, readers: { solana, bnb: async () => { throw new Error("Set ETHERSCAN_API_KEY"); } } });
  assert.deepEqual(out.unmatched.map((u) => u.txHash), [SIG("d"), SIG("b")], "newest first; the recorded one and the 5,000-lamport fee are left out");
  const internal = out.unmatched.find((u) => u.txHash === SIG("b"));
  assert.equal(internal.amount, "2");
  assert.equal(internal.prefill.kind, "transfer_internal");
  assert.equal(internal.prefill.toAccountId, "2");
  assert.equal(out.unmatched.find((u) => u.txHash === SIG("d")).toAccountId, null);
  const bnb = out.wallets.find((w) => w.accountId === "3");
  assert.equal(bnb.status, "unavailable");
  assert.match(bnb.error, /ETHERSCAN_API_KEY/);
  assert.equal(out.wallets.length, 3, "only multisig and operator wallets are read");
});

test("handler: GET treasury/unmatched passes the accounts and recorded movements to the reader", async () => {
  let seen = null;
  const { call } = setup({ unmatched: async (args) => { seen = args; return { wallets: [], unmatched: [], note: "n" }; } });
  const out = await call("GET", "/api/admin/finance/treasury/unmatched", { principal: VIEWER, query: { days: "14" } });
  assert.equal(out.status, 200);
  assert.equal(out.body.days, 14);
  assert.equal(seen.sinceMs, NOW - 14 * 86_400_000);
  assert.equal((await call("GET", "/api/admin/finance/treasury/unmatched", { principal: VIEWER, query: { days: "999" } })).status, 400);
});

test("rules: the new calendar and crypto cost rules are data with source, date and confidence, and validate", () => {
  const r = rules();
  assert.equal(r.calendar.vatPeriod.period, "quarter");
  assert.match(r.calendar.vatPeriod.source, /^https:\/\/www\.belastingdienst\.nl/);
  assert.equal(r.vpb.cryptoCostMethod.method, "fifo");
  assert.equal(r.vpb.cryptoCostMethod.confidence, "medium");
  const rows = R.rulesTable(r);
  for (const key of ["vpb.cryptoCost", "cal.vat", "cal.vpbProvisional", "cal.vpbReturn", "cal.firstPeriod"]) assert.ok(rows.some((x) => x.key === key && x.source && x.checkedOn), key);
  assert.throws(() => R.validateTaxRuleSet({ ...r, vpb: { ...r.vpb, cryptoCostMethod: { ...r.vpb.cryptoCostMethod, method: "hifo" } } }), /fifo, lifo or average/);
  assert.equal(R.validateTaxRuleSet({ ...r, vpb: { ...r.vpb, cryptoCostMethod: { ...r.vpb.cryptoCostMethod, method: "lifo" } } }).vpb.cryptoCostMethod.method, "lifo");
  // A rule set saved before these rules existed gets the defaults.
  const old = structuredClone(r);
  delete old.calendar;
  delete old.vpb.cryptoCostMethod;
  const eff = R.effectiveTaxRuleSet(old);
  assert.equal(eff.calendar.vpbReturn.dueMonthsAfterYear, 5);
  assert.equal(eff.vpb.cryptoCostMethod.method, "fifo");
});

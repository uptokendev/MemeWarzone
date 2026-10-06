// Year-end package (B8): one financial year in EUR for the corporate income
// tax return (VPB) and the annual accounts. Profit and loss, balance sheet at
// 31 December, tax summary, supporting schedules, warnings. Pure functions;
// the handler (admin/financeAccounting.js) reads the inputs (the weekly model,
// the treasury, the tax items, the distributions, prices) and serves JSON,
// one CSV per schedule, or one ZIP with a README.
//
// Where the numbers come from (one source each, so the totals reconcile):
//   revenue, VAT, costs, realized gains, fees   the weekly model's segments
//       (financeAccountingWeekly.computeWeeks): the same daily revenue lanes
//       as Summary / Revenue / Close (financeRevenueLanes.js), each day at its
//       ECB rate, closed months corrected to their close snapshot.
//   write-down of held crypto     FIFO lots at the balance date against the
//       market value then (rules.yearEnd.writeDown, art. 2:387 BW): the result
//       carries the change in the write-down since the last year end.
//   VPB                           brackets of the year, after loss carry-forward.
//   balance sheet                 EUR cash from the recorded movements, crypto
//       from the lots (cost or lower market), liabilities from the costs, tax
//       items and distributions. Equity rolls forward from the results. What
//       cannot be explained shows as a difference, never forced to zero.
// Unknown stays unknown: a value that could not be read is null and listed.

import { COST_CATEGORIES, COST_CATEGORY_LABELS, round2, roundUsd } from "./financeAccountingCosts.js";
import { bracketTax } from "./financeAccountingTax.js";
import { taxableAfterLoss } from "./financeAccountingWeekly.js";
import { addMonthsToDate, rulesTable, vatLaneOf, vpbYear } from "./financeTaxRules.js";
import { cashPerAccount, lotAsset, paidOccurrence, runLots, splitAssetKey, ACCOUNT_KIND_LABELS } from "./financeTreasury.js";
import { vatByPeriodFrom, vatDueOn, vatPeriodBounds } from "./financeTaxCalendar.js";
import { vatReturnsByPeriod } from "./financeVat.js";
import { toCsv } from "./financeAccountingCsv.js";
import { buildZip } from "./financeZip.js";

export const YEAR_END_SCHEMA = "finance-year-end-v1";
const EPS = 1e-9;
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : round2(v) || 0); // never -0
const sumOrNull = (list) => (list.some((v) => v == null || !Number.isFinite(v)) ? null : list.reduce((s, v) => s + v, 0));
const DIST_COUNTED = ["approved", "paid"];

/** The balance date of a year: 31 December, or today while the year runs (provisional). */
export function balanceDate(year, today) {
  const end = `${year}-12-31`;
  return end <= today ? { asOf: end, provisional: false } : { asOf: today, provisional: true };
}

/** When a distribution was declared (decided), for the year it belongs to. */
export function declaredOn(record) {
  return (record.decidedAt ? String(record.decidedAt).slice(0, 10) : null) || record.availableOn || (record.createdAt ? String(record.createdAt).slice(0, 10) : null);
}

/** Lots in and out up to a date (inclusive), run through the method. */
export function lotsAt(lotInputs, date, method) {
  const keep = (e) => e.date <= date;
  return runLots({ acquisitions: (lotInputs?.acquisitions || []).filter(keep), disposals: (lotInputs?.disposals || []).filter(keep), method });
}

/**
 * Holdings at a date valued at cost or lower market value, per asset.
 * @param {(key:string, amount:number, date:string) => Promise<{eur:number|null, usd?:number|null, source:string}>} valueAt
 */
export async function valuedHoldings(lotInputs, date, method, valueAt) {
  const lots = lotsAt(lotInputs, date, method);
  const rows = [];
  for (const [key, h] of Object.entries(lots.holdings).sort(([a], [b]) => a.localeCompare(b))) {
    const m = await valueAt(key, h.amount, date).catch((error) => ({ eur: null, source: `price read failed: ${String(error?.message || error).slice(0, 120)}` }));
    const market = m?.eur == null || !Number.isFinite(m.eur) ? null : m.eur;
    const { asset, address } = splitAssetKey(key);
    rows.push({
      key,
      asset,
      address,
      amount: h.amount,
      costEur: h.costEur,
      marketEur: market,
      writeDownEur: market == null ? null : Math.max(0, h.costEur - market),
      bookEur: market == null ? null : Math.min(h.costEur, market),
      marketSource: m?.source || "no price",
      openLots: h.openLots || [],
    });
  }
  return { rows, uncovered: lots.uncovered, disposals: lots.disposals, writeDownEur: sumOrNull(rows.map((r) => r.writeDownEur)) };
}

/** VPB on a taxable amount with each bracket's part. */
export function vpbBrackets(taxable, brackets) {
  const out = [];
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo == null ? Infinity : b.upTo;
    const base = taxable > lower ? Math.min(taxable, upper) - lower : 0;
    out.push({ fromEur: lower, upToEur: b.upTo, rate: b.rate, baseEur: r2(Math.max(0, base)), taxEur: r2(Math.max(0, base) * b.rate) });
    lower = upper;
  }
  return out;
}

/**
 * Result before and after VPB per year, from the first year with activity up
 * to `year`: operating profit (weekly model) minus the change in the
 * write-down, then the loss carried forward and the brackets.
 * @param {Array<{year:number, profitEur:number}>} modelYears
 * @param {Map<number, number|null>} writeDownByYear  write-down at each year end (null = unknown)
 */
export function vpbChain({ modelYears, year, writeDownByYear, rules, vpbOverride = null }) {
  const lossRule = rules.vpb.lossCarryForward;
  const years = [...new Set([...modelYears.map((y) => y.year), year])].filter((y) => y <= year).sort((a, b) => a - b);
  const out = [];
  let pool = 0;
  let previousWd = 0;
  for (const y of years) {
    const profit = modelYears.find((m) => m.year === y)?.profitEur ?? 0;
    const wd = writeDownByYear.has(y) ? writeDownByYear.get(y) : 0;
    const change = wd == null || previousWd == null ? null : wd - previousWd;
    const before = change == null ? null : profit - change;
    const brackets = vpbYear(rules, y, vpbOverride);
    let row;
    if (before == null || pool == null) {
      row = { year: y, operatingResultEur: r2(profit), writeDownEur: r2(wd), writeDownChangeEur: r2(change), resultBeforeTaxEur: null, lossCarriedInEur: r2(pool), lossUsedEur: null, taxableEur: null, vpbEur: null, resultAfterTaxEur: null, lossCarriedOutEur: null, brackets: brackets.brackets, bracketsSource: brackets.source, bracketsFallback: brackets.fallback ? brackets.fallbackFrom : null };
      pool = null;
    } else {
      const taxable = taxableAfterLoss(before, pool, lossRule);
      const used = before > 0 ? before - taxable : 0;
      const vpb = bracketTax(taxable, brackets.brackets);
      const outPool = Math.max(0, pool - used + Math.max(0, -before));
      row = { year: y, operatingResultEur: r2(profit), writeDownEur: r2(wd), writeDownChangeEur: r2(change), resultBeforeTaxEur: r2(before), lossCarriedInEur: r2(pool), lossUsedEur: r2(used), taxableEur: r2(taxable), vpbEur: r2(vpb), resultAfterTaxEur: r2(before - vpb), lossCarriedOutEur: r2(outPool), brackets: brackets.brackets, bracketsSource: brackets.source, bracketsFallback: brackets.fallback ? brackets.fallbackFrom : null, bracketLines: vpbBrackets(taxable, brackets.brackets) };
      pool = outPool;
    }
    out.push(row);
    previousWd = wd;
  }
  return out;
}

/** Revenue of the year per revenue lane (gross EUR at each day's rate), VAT per lane from the segments. */
export function revenueByLane({ revDays, year, today, usdPerEur, segments }) {
  const lanes = new Map();
  const unpricedDays = [];
  for (const [date, day] of Object.entries(revDays || {})) {
    if (date.slice(0, 4) !== String(year) || date > today) continue;
    const rate = usdPerEur(date);
    if (!(rate > 0)) continue;
    for (const l of day.lanes || []) {
      const key = l.laneId || "unknown";
      const row = lanes.get(key) || { laneId: key, lane: l.lane || null, source: l.source || null, chainId: l.chainId ?? null, chain: l.chain || null, asset: l.asset || null, vatLane: vatLaneOf(key), nativeAmount: 0, grossUsd: 0, grossEur: 0, unpricedDays: 0 };
      if (l.amountUsd == null) { row.unpricedDays += 1; unpricedDays.push(date); } else {
        row.grossUsd += l.amountUsd;
        row.grossEur += l.amountUsd / rate;
      }
      row.nativeAmount += Number(l.nativeAmount) || 0;
      lanes.set(key, row);
    }
  }
  const vatByVatLane = {};
  for (const s of segments) for (const [k, v] of Object.entries(s.vatByLane || {})) vatByVatLane[k] = (vatByVatLane[k] || 0) + v;
  const grossByVatLane = {};
  for (const row of lanes.values()) grossByVatLane[row.vatLane] = (grossByVatLane[row.vatLane] || 0) + row.grossEur;
  const rows = [...lanes.values()].sort((a, b) => b.grossEur - a.grossEur).map((row) => {
    const share = grossByVatLane[row.vatLane] > 0 ? row.grossEur / grossByVatLane[row.vatLane] : 0;
    const vat = (vatByVatLane[row.vatLane] || 0) * share;
    return { ...row, vatEur: vat, netEur: row.grossEur - vat };
  });
  return { rows, vatByVatLane, unpricedDays: [...new Set(unpricedDays)] };
}

/** Costs of the year per category in EUR, split over segments exactly as the weekly model does. */
export function costsByCategory({ segments, costsByMonth, usdPerEur }) {
  const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const rate = (d) => { const r = usdPerEur(d); return Number.isFinite(r) && r > 0 ? r : null; };
  const out = Object.fromEntries(COST_CATEGORIES.map((c) => [c, { usd: 0, eur: 0 }]));
  for (const seg of segments) {
    for (const o of costsByMonth.get(seg.month) || []) {
      const share = o.recurring && o.recurring !== "none" ? seg.days / daysInMonth(seg.month) : (o.date >= seg.start && o.date <= seg.end ? 1 : 0);
      if (!share) continue;
      const r = Number(o.eurUsdRate) > 0 ? Number(o.eurUsdRate) : rate(o.date) ?? rate(seg.end);
      const c = out[o.category] || (out[o.category] = { usd: 0, eur: 0 });
      c.usd += o.amountUsd * share;
      c.eur += r ? (o.amountUsd * share) / r : 0;
    }
  }
  return out;
}

function itemsOf(items, taxType, period) {
  return (items || []).filter((t) => !t.deletedAt && t.taxType === taxType && t.period === period);
}

function paidBy(list, date) {
  const upTo = list.filter((t) => t.doneOn && t.doneOn <= date);
  return upTo.filter((t) => t.kind === "payment").reduce((s, t) => s + Number(t.amountEur), 0) - upTo.filter((t) => t.kind === "refund").reduce((s, t) => s + Number(t.amountEur), 0);
}

function latestOf(list, kind) {
  return list.filter((t) => t.kind === kind).sort((a, b) => (a.doneOn < b.doneOn ? 1 : a.doneOn > b.doneOn ? -1 : Number(b.id) - Number(a.id)))[0] || null;
}

/**
 * The whole year-end view (JSON): P&L, balance sheet, tax summary,
 * reconciliation, warnings, assumptions and the rules used.
 * @param {object} input  see the handler (financeAccounting.js getYearEnd) for each field
 */
export async function buildYearEnd(input) {
  const { year, today, rules, vpbOverride = null, entity, model, revDays, usdPerEur, costsByMonth, closeMonths = new Map(), closes = new Map(), costs = [], treasury, records = [], taxCal, valueAt, latestUsdPerEur = null, payouts = null, chainBalances = null, unmatched = null, notes = [] } = input;
  const { asOf, provisional } = balanceDate(year, today);
  const warnings = [];
  const warn = (area, text, level = "warning") => warnings.push({ level, area, text });
  const yearSegs = model.segments.filter((s) => s.year === year && s.start <= today);
  const ye = rules.yearEnd;
  const method = treasury.method || rules.vpb.cryptoCostMethod.method || "fifo";
  const rateAsOf = usdPerEur(asOf) ?? latestUsdPerEur;

  // ------------------------------------------------------------ write-down per year end
  const firstYear = Math.min(year, ...model.years.map((y) => y.year));
  const writeDownByYear = new Map();
  const holdingsByYear = new Map();
  for (let y = firstYear; y <= year; y += 1) {
    const end = balanceDate(y, today).asOf;
    const v = await valuedHoldings(treasury.lotInputs, end, method, valueAt);
    holdingsByYear.set(y, v);
    writeDownByYear.set(y, v.writeDownEur);
  }
  const holdings = holdingsByYear.get(year);
  const chain = vpbChain({ modelYears: model.years, year, writeDownByYear, rules, vpbOverride });
  const thisYear = chain.find((c) => c.year === year);
  const prior = chain.filter((c) => c.year < year);

  // ------------------------------------------------------------ profit and loss
  const sumSeg = (k) => yearSegs.reduce((s, x) => s + (x[k] || 0), 0);
  const lanes = revenueByLane({ revDays, year, today, usdPerEur, segments: yearSegs });
  const grossEur = sumSeg("revenueEur");
  const vatEur = sumSeg("vatEur");
  const laneGross = lanes.rows.reduce((s, r) => s + r.grossEur, 0);
  const laneVat = lanes.rows.reduce((s, r) => s + r.vatEur, 0);
  const adjustment = { grossEur: grossEur - laneGross, vatEur: vatEur - laneVat, usd: sumSeg("closeAdjustmentUsd") };
  const bank = { grossEur: sumSeg("otherRevenueEur"), vatEur: sumSeg("otherVatEur") };
  const netRevenueEur = grossEur - vatEur + bank.grossEur - bank.vatEur;
  const cats = costsByCategory({ segments: yearSegs, costsByMonth, usdPerEur });
  const costsEur = sumSeg("costsEur");
  const realizedGainEur = sumSeg("realizedGainEur");
  const feesEur = sumSeg("treasuryFeesEur");
  const operatingEur = sumSeg("profitEur");
  const check = netRevenueEur - costsEur + realizedGainEur - feesEur;
  if (Math.abs(check - operatingEur) > 0.05) warn("pnl", `The profit and loss lines add up to EUR ${check.toFixed(2)}, the weekly model says EUR ${operatingEur.toFixed(2)}.`);
  const reserveDuringYear = model.years.find((y) => y.year === year)?.reserveEur ?? 0;

  const pnl = {
    currency: "EUR",
    period: { from: `${year}-01-01`, to: asOf },
    revenue: {
      lanes: lanes.rows.map((r) => ({ laneId: r.laneId, label: r.source || r.laneId, chainId: r.chainId, chain: r.chain, asset: r.asset, vatLane: r.vatLane, nativeAmount: r.nativeAmount, grossUsd: r2(r.grossUsd), grossEur: r2(r.grossEur), vatEur: r2(r.vatEur), netEur: r2(r.netEur), unpricedDays: r.unpricedDays })),
      closedMonthAdjustment: { grossUsd: r2(adjustment.usd), grossEur: r2(adjustment.grossEur), vatEur: r2(adjustment.vatEur), netEur: r2(adjustment.grossEur - adjustment.vatEur), note: "Difference between the close snapshot of a closed month and the live daily revenue of that month, booked on the month's last days (the snapshot is the truth)." },
      bankReceipts: { grossEur: r2(bank.grossEur), vatEur: r2(bank.vatEur), netEur: r2(bank.grossEur - bank.vatEur), note: "Revenue received in the bank (treasury movements with a revenue lane)." },
      grossEur: r2(grossEur + bank.grossEur),
      vatEur: r2(vatEur + bank.vatEur),
      netEur: r2(netRevenueEur),
      grossUsd: r2(sumSeg("revenueUsd")),
    },
    costs: {
      categories: COST_CATEGORIES.filter((c) => cats[c]?.eur || cats[c]?.usd).map((c) => ({ category: c, label: COST_CATEGORY_LABELS[c] || c, usd: r2(cats[c].usd), eur: r2(cats[c].eur) })),
      totalEur: r2(costsEur),
      totalUsd: r2(sumSeg("costsUsd")),
    },
    realizedGainEur: r2(realizedGainEur),
    feesEur: r2(feesEur),
    operatingResultEur: r2(operatingEur),
    writeDown: {
      label: "Year-end adjustment: held crypto written down to the lower market value (art. 2:387 BW)",
      atYearEndEur: r2(thisYear.writeDownEur),
      atLastYearEndEur: prior.length ? prior[prior.length - 1].writeDownEur : 0,
      resultEffectEur: thisYear.writeDownChangeEur == null ? null : r2(-thisYear.writeDownChangeEur),
      rule: ye?.writeDown?.condition || null,
      provisional,
    },
    resultBeforeTaxEur: thisYear.resultBeforeTaxEur,
    vpb: {
      taxableProfitEur: thisYear.taxableEur,
      lossCarriedInEur: thisYear.lossCarriedInEur,
      lossUsedEur: thisYear.lossUsedEur,
      lossCarriedOutEur: thisYear.lossCarriedOutEur,
      brackets: thisYear.bracketLines || vpbBrackets(0, thisYear.brackets).map((b) => ({ ...b, baseEur: null, taxEur: null })),
      vpbEur: thisYear.vpbEur,
      bracketsSource: thisYear.bracketsSource,
      reservedDuringYearEur: r2(reserveDuringYear),
      note: "The reserve during the year leaves the write-down out (it is only made at the balance date); the year-end VPB includes it.",
    },
    resultAfterTaxEur: thisYear.resultAfterTaxEur,
  };
  if (thisYear.bracketsFallback) warn("tax", `No corporate tax brackets for ${year} in the rules; the ${thisYear.bracketsFallback} brackets are used.`);
  if (lanes.unpricedDays.length) warn("revenue", `Some revenue could not be priced in USD on ${lanes.unpricedDays.slice(0, 10).join(", ")}${lanes.unpricedDays.length > 10 ? " and more" : ""}: it is not in the totals.`);
  if (thisYear.writeDownEur == null) {
    const missing = holdings.rows.filter((h) => h.marketEur == null).map((h) => h.asset);
    warn("write-down", `No market value for ${missing.join(", ") || "a held asset"} at ${asOf}: the write-down, the result before tax and the VPB stay unknown until it is priced.`);
  }
  for (const p of prior) if (p.writeDownEur == null) warn("write-down", `The write-down at the end of ${p.year} is unknown (no market value), so the later years' results stay unknown.`);

  // ------------------------------------------------------------ balance sheet
  const movements = (treasury.movements || []).filter((m) => !m.deletedAt && m.occurredAt.slice(0, 10) <= asOf);
  const taxItems = (treasury.taxItems || []).filter((t) => !t.deletedAt);
  const taxItemsAsOf = taxItems.filter((t) => t.doneOn && t.doneOn <= asOf);
  const cash = cashPerAccount(movements, taxItemsAsOf);
  const accounts = (treasury.accounts || []);
  const perAccount = [];
  let eurCash = 0;
  for (const a of accounts) {
    const lines = [];
    for (const [key, amount] of cash.get(String(a.id)) || []) {
      if (Math.abs(amount) < 1e-12) continue;
      const { asset, address } = splitAssetKey(key);
      if (asset === "EUR" && !address) eurCash += amount;
      lines.push({ asset, address, amount: roundUsd(amount), eur: asset === "EUR" && !address ? r2(amount) : null, inBooksAs: asset === "EUR" && !address ? "cash (EUR)" : "crypto and currency at cost or lower market (FIFO lots, all accounts together)" });
    }
    const chainNow = provisional && chainBalances ? walletChainBalance(a, chainBalances) : null;
    perAccount.push({ id: a.id, name: a.name, kind: a.kind, kindLabel: ACCOUNT_KIND_LABELS[a.kind] || a.kind, chainId: a.chainId, address: a.address, archived: Boolean(a.archivedAt), recorded: lines, chainNow });
    for (const l of lines) if (l.asset === "EUR" && l.amount < -0.005) warn("cash", `${a.name} is below zero in EUR at ${asOf} (${l.amount}): an opening balance or a receipt is missing.`);
  }
  const crypto = holdings.rows.map((h) => ({ asset: h.asset, address: h.address, amount: h.amount, costEur: r2(h.costEur), marketEur: r2(h.marketEur), bookEur: r2(h.bookEur), writeDownEur: r2(h.writeDownEur), marketSource: h.marketSource, lots: h.openLots.length }));
  const cryptoBook = sumOrNull(holdings.rows.map((h) => h.bookEur));

  // Off-chain revenue (lanes in USD, e.g. Home placements) is not a crypto lot: a receivable until a bank receipt is recorded.
  let offChainRevenueEur = 0;
  for (const [date, day] of Object.entries(revDays || {})) {
    if (date > asOf) continue;
    const rate = usdPerEur(date);
    // Not a crypto lot (revenueAcquisitions skips these): counted in USD or another unit off-chain.
    for (const l of day.lanes || []) {
      const lot = lotAsset(l.asset);
      if (l.amountUsd != null && rate > 0 && (!lot || lot === "USD")) offChainRevenueEur += l.amountUsd / rate;
    }
  }
  const plainReceiptsEur = movements.filter((m) => m.kind === "bank_receipt" && !m.revenueLane).reduce((s, m) => s + Number(m.valueEur || 0), 0);
  const offChainReceivable = Math.max(0, offChainRevenueEur - plainReceiptsEur);

  // Unpaid costs: occurrences dated up to the balance date in EUR or USD with no bank or crypto payment linked.
  const paidMovements = movements;
  const unpaid = [];
  for (const [month, list] of costsByMonth) {
    if (month > asOf.slice(0, 7)) continue;
    for (const o of list) {
      if (o.date > asOf) continue;
      const asset = lotAsset(o.currency);
      if (asset && asset !== "USD") continue; // paid in crypto: the lots took it out
      if (paidOccurrence(o, paidMovements)) continue;
      const r = Number(o.eurUsdRate) > 0 ? Number(o.eurUsdRate) : usdPerEur(o.date);
      unpaid.push({ date: o.date, costId: o.costId, vendor: o.vendor, category: o.category, amount: o.amount, currency: o.currency, amountUsd: o.amountUsd, eur: r ? o.amountUsd / r : null });
    }
  }
  const unpaidEur = sumOrNull(unpaid.map((u) => u.eur));
  if (unpaid.length) warn("costs", `${unpaid.length} cost(s) up to ${asOf} have no payment recorded (EUR ${unpaidEur == null ? "unknown" : unpaidEur.toFixed(2)}): they are a debt on the balance sheet. If a founder paid one privately, it is a debt to that founder; record the payment on the Treasury page.`);

  // VAT: per period up to the balance date, the filed return (else the reserve) minus what was paid by then.
  const vatPeriod = rules.calendar.vatPeriod.period;
  const vatReserved = vatByPeriodFrom(model.segments.filter((s) => s.start <= asOf), vatPeriod);
  const vatPeriods = [...new Set([...Object.keys(vatReserved), ...taxItems.filter((t) => t.taxType === "vat").map((t) => t.period)])].filter((p) => vatPeriodBounds(p).start <= asOf).sort();
  let vatPayable = 0;
  const vatLines = [];
  for (const p of vatPeriods) {
    const list = itemsOf(taxItems, "vat", p);
    const filed = latestOf(list, "return_filed");
    const due = filed ? Number(filed.amountEur) : vatReserved[p] || 0;
    const paid = paidBy(list, asOf);
    vatPayable += due - paid;
    vatLines.push({ period: p, dueEur: r2(due), basis: filed ? `return filed ${filed.doneOn}` : "VAT reserved (estimate)", paidByBalanceDateEur: r2(paid), openEur: r2(due - paid) });
  }

  // VPB: per year up to this one, the final assessment (else the year-end VPB) minus what was paid by then.
  let vpbPayable = 0;
  let vpbUnknown = false;
  const vpbLines = [];
  const vpbYears = [...new Set([...chain.map((c) => String(c.year)), ...taxItems.filter((t) => t.taxType === "vpb").map((t) => t.period)])].filter((p) => Number(p) <= year).sort();
  for (const p of vpbYears) {
    const list = itemsOf(taxItems, "vpb", p);
    const final = latestOf(list, "assessment_final");
    const computed = chain.find((c) => String(c.year) === p)?.vpbEur ?? null;
    const due = final ? Number(final.amountEur) : computed;
    const paid = paidBy(list, asOf);
    if (due == null) vpbUnknown = true;
    else vpbPayable += due - paid;
    vpbLines.push({ year: Number(p), dueEur: r2(due), basis: final ? `final assessment ${final.doneOn}` : "computed on the year-end result", paidByBalanceDateEur: r2(paid), openEur: due == null ? null : r2(due - paid) });
  }

  // Dividend tax and distributions.
  const counted = records.filter((r) => DIST_COUNTED.includes(r.status) && declaredOn(r) && declaredOn(r) <= asOf);
  let divTaxPayable = 0;
  let distPayable = 0;
  const divLines = [];
  for (const r of counted) {
    const list = itemsOf(taxItems, "dividend_tax", r.week);
    const withheld = Number(r.totalWithholdingEur || 0);
    const paidItems = paidBy(list, asOf);
    const paid = paidItems > 0 ? paidItems : r.dividendTaxPaidOn && r.dividendTaxPaidOn <= asOf ? withheld : 0;
    divTaxPayable += Math.max(0, withheld - paid);
    const unpaidNet = r.status === "approved" || (r.availableOn && r.availableOn > asOf) ? Number(r.totalNetEur || 0) : 0;
    distPayable += unpaidNet;
    divLines.push({ week: r.week, declaredOn: declaredOn(r), status: r.status, grossEur: r2(Number(r.totalGrossEur || 0)), withheldEur: r2(withheld), dividendTaxPaidEur: r2(paid), netUnpaidEur: r2(unpaidNet) });
  }

  // Owner loans and contributions; opening balances recorded.
  const eurValue = (m) => Number(m.valueEur || 0);
  const ownerLoans = movements.filter((m) => m.kind === "owner_loan").reduce((s, m) => s + (m.toAccountId ? eurValue(m) : -eurValue(m)), 0);
  const before = (m) => m.occurredAt.slice(0, 10) < `${year}-01-01`;
  const contributionsBefore = movements.filter((m) => m.kind === "owner_contribution" && before(m)).reduce((s, m) => s + eurValue(m), 0);
  const contributionsYear = movements.filter((m) => m.kind === "owner_contribution" && !before(m)).reduce((s, m) => s + eurValue(m), 0);
  const openingBefore = movements.filter((m) => m.kind === "opening_balance" && before(m)).reduce((s, m) => s + eurValue(m), 0);
  const openingYear = movements.filter((m) => m.kind === "opening_balance" && !before(m)).reduce((s, m) => s + eurValue(m), 0);
  const distBefore = records.filter((r) => DIST_COUNTED.includes(r.status) && declaredOn(r) && declaredOn(r) < `${year}-01-01`).reduce((s, r) => s + Number(r.totalGrossEur || 0), 0);
  const distYear = records.filter((r) => DIST_COUNTED.includes(r.status) && declaredOn(r) && declaredOn(r) >= `${year}-01-01` && declaredOn(r) <= asOf).reduce((s, r) => s + Number(r.totalGrossEur || 0), 0);
  const priorResults = sumOrNull(prior.map((p) => p.resultAfterTaxEur));
  const openingEquity = priorResults == null ? null : priorResults - distBefore + contributionsBefore + openingBefore;
  const closingEquity = openingEquity == null || thisYear.resultAfterTaxEur == null ? null : openingEquity + contributionsYear + openingYear + thisYear.resultAfterTaxEur - distYear;

  const receivables = [];
  if (offChainReceivable > 0.005) receivables.push({ key: "off_chain_revenue", label: "Off-chain revenue not matched to a bank receipt (e.g. Home placements)", eur: r2(offChainReceivable) });
  if (vatPayable < -0.005) receivables.push({ key: "vat_refundable", label: "VAT paid above what is due", eur: r2(-vatPayable) });
  if (!vpbUnknown && vpbPayable < -0.005) receivables.push({ key: "vpb_prepaid", label: "Corporate tax paid in advance", eur: r2(-vpbPayable) });
  const liabilities = [
    { key: "unpaid_costs", label: "Costs not yet paid (no payment recorded)", eur: r2(unpaidEur) },
    { key: "vat_payable", label: "VAT payable", eur: r2(Math.max(0, vatPayable)) },
    { key: "vpb_payable", label: "Corporate income tax (VPB) payable", eur: vpbUnknown ? null : r2(Math.max(0, vpbPayable)) },
    { key: "dividend_tax_payable", label: "Dividend tax withheld, not yet paid", eur: r2(divTaxPayable) },
    { key: "distributions_payable", label: "Distributions approved, not yet paid (net)", eur: r2(distPayable) },
    { key: "owner_loans", label: "Loans from shareholders", eur: r2(ownerLoans) },
  ];
  const assetsTotal = sumOrNull([eurCash, cryptoBook, ...receivables.map((x) => x.eur)]);
  const liabilitiesTotal = sumOrNull(liabilities.map((x) => x.eur));
  const difference = assetsTotal == null || liabilitiesTotal == null || closingEquity == null ? null : assetsTotal - liabilitiesTotal - closingEquity;
  if (difference == null) warn("balance", "The balance check is unknown: an amount on it could not be valued.");
  else if (Math.abs(difference) > 1) warn("balance", `Assets minus liabilities differ from the equity roll-forward by EUR ${difference.toFixed(2)}. Usual causes: money moved that is not recorded on the Treasury page (opening balances, conversions, payments from or to private accounts), or revenue still in a vault that was spent.`);

  const owedUsers = userFundsNote(payouts, { provisional, rateNow: latestUsdPerEur, rule: ye?.userFunds });
  if (owedUsers.shortfalls.length) warn("user funds", `Vault coverage is short or unknown for: ${owedUsers.shortfalls.join(", ")}. A shortfall the BV must make good would be a liability; check before signing the accounts.`);

  const balance = {
    asOf,
    provisional,
    currency: "EUR",
    usdPerEur: rateAsOf,
    assets: {
      cashEur: r2(eurCash),
      crypto,
      cryptoBookEur: r2(cryptoBook),
      cryptoCostEur: r2(holdings.rows.reduce((s, h) => s + h.costEur, 0)),
      receivables,
      totalEur: r2(assetsTotal),
    },
    liabilities: { lines: liabilities, totalEur: r2(liabilitiesTotal), vat: vatLines, vpb: vpbLines, dividends: divLines, unpaidCosts: unpaid.map((u) => ({ ...u, eur: r2(u.eur) })) },
    equity: {
      openingEur: r2(openingEquity),
      openingParts: { priorResultsAfterTaxEur: r2(priorResults), priorDistributionsEur: r2(distBefore), contributionsEur: r2(contributionsBefore), openingBalancesEur: r2(openingBefore) },
      contributionsEur: r2(contributionsYear),
      openingBalancesRecordedEur: r2(openingYear),
      resultEur: thisYear.resultAfterTaxEur,
      distributionsDeclaredEur: r2(distYear),
      closingEur: r2(closingEquity),
      note: "Opening balances recorded on the Treasury page have their counterpart in equity (money the BV held before its books started). Owner contributions are equity; owner loans are a liability.",
    },
    check: { assetsMinusLiabilitiesEur: r2(assetsTotal == null || liabilitiesTotal == null ? null : assetsTotal - liabilitiesTotal), equityEur: r2(closingEquity), differenceEur: r2(difference), balanced: difference == null ? null : Math.abs(difference) <= 1 },
    accounts: perAccount,
    offBalance: { userFunds: owedUsers },
    chainCheck: provisional ? chainCheck(holdings.rows, chainBalances) : null,
  };
  if (!accounts.length) warn("treasury", "No accounts are recorded on the Treasury page: cash per account is empty and only crypto from revenue (the lots) is on the balance sheet. Add the bank, exchange, multisig and operator wallets with their opening balances.");
  if (!movements.some((m) => m.kind === "opening_balance")) warn("treasury", "No opening balances are recorded: anything the BV held before its first recorded revenue is missing from the balance sheet and from the FIFO cost.");
  for (const u of holdings.uncovered.filter((x) => x.date.slice(0, 4) === String(year))) warn("treasury", `${roundUsd(u.amount)} ${u.asset} left on ${u.date} (${u.ref}) without a recorded cost: counted at its proceeds (no gain, no loss). An opening balance is missing.`);
  if (balance.chainCheck?.lines.some((l) => l.differenceAmount != null && Math.abs(l.differenceAmount) > 1e-6)) warn("treasury", "The FIFO lots and the balances on chain now do not agree for every coin (see the chain check): money left our wallets that is not recorded, or came in from outside the revenue lanes.", "info");
  if (unmatched?.unmatched?.length) warn("treasury", `${unmatched.unmatched.length} outflow(s) from our wallets since ${year}-01-01 are not recorded as a movement or cost (Treasury page, Unmatched).`);
  else if (unmatched?.note) warn("treasury", `Unmatched outflows: ${unmatched.note}`, "info");

  // ------------------------------------------------------------ tax summary
  const vatQuarters = vatReturnsByPeriod(yearSegs, vatPeriod).map((r) => {
    const list = itemsOf(taxItems, "vat", r.period);
    const filed = latestOf(list, "return_filed");
    const paid = paidBy(list, "9999-12-31");
    const ob = (taxCal?.obligations || []).find((o) => o.key === `vat:${r.period}`);
    const computed = r.nl.vatDueEur;
    return {
      period: r.period,
      ...vatPeriodBounds(r.period),
      dueOn: vatDueOn(r.period, rules.calendar.vatPeriod.dueMonthsAfterPeriod),
      computedEur: computed,
      r1a: r.nl.r1a,
      r3b: r.nl.r3b,
      icp: r.nl.icp,
      notReported: r.nl.notReported,
      ossEur: r.oss.vatDueEur,
      filedEur: filed ? Number(filed.amountEur) : null,
      filedOn: filed?.doneOn || null,
      paidEur: r2(paid),
      differenceFiledVsComputedEur: filed ? r2(Number(filed.amountEur) - computed) : null,
      status: ob?.status || (vatPeriodBounds(r.period).end >= today ? "running" : "open"),
    };
  });
  const dividends = records.filter((r) => DIST_COUNTED.includes(r.status) && (declaredOn(r) || "").slice(0, 4) === String(year)).map((r) => {
    const ob = (taxCal?.obligations || []).find((o) => o.key === `dividend:${r.id}:return`);
    return { id: r.id, week: r.week, status: r.status, declaredOn: declaredOn(r), availableOn: r.availableOn, grossEur: r2(Number(r.totalGrossEur || 0)), withheldEur: r2(Number(r.totalWithholdingEur || 0)), netEur: r2(Number(r.totalNetEur || 0)), dueOn: ob?.dueOn || r.dividendTaxDueOn || null, filedOn: r.dividendTaxReturnFiledOn || null, paidOn: r.dividendTaxPaidOn || null, taxStatus: ob?.status || (Number(r.totalWithholdingEur || 0) > 0 ? "open" : "nothing withheld") };
  });
  const relevant = (o) => (o.taxType === "vat" && String(o.period).startsWith(String(year))) || (o.taxType === "vpb" && (o.period === String(year) || o.period === String(year - 1) && o.kind === "return")) || (o.taxType === "dividend_tax" && String(o.period).startsWith(String(year)));
  const deadlines = [...(taxCal?.obligations || []).filter(relevant).map((o) => ({ key: o.key, title: o.title, dueOn: o.dueOn, amountEur: o.amountEur, amountBasis: o.amountBasis, status: o.status, source: o.source })), ...annualDeadlines(year, today, rules)];
  if (!deadlines.some((d) => d.key === `vpb:${year}:return`)) {
    const ret = rules.calendar.vpbReturn;
    const dueOn = addMonthsToDate(`${year + 1}-01-01`, ret.dueMonthsAfterYear);
    deadlines.push({ key: `vpb:${year}:return`, title: `Corporate tax return ${year}`, dueOn, amountEur: thisYear.vpbEur, amountBasis: "Computed on the year-end result", status: provisional ? "not yet due" : dueOn < today ? "overdue" : "open", source: ret.source });
  }
  deadlines.sort((a, b) => String(a.dueOn || "9999").localeCompare(String(b.dueOn || "9999")));
  const tax = {
    vpb: { years: chain.map(({ brackets, bracketLines, ...rest }) => rest), year: { ...pnl.vpb, resultBeforeTaxEur: thisYear.resultBeforeTaxEur, resultAfterTaxEur: thisYear.resultAfterTaxEur }, lossRule: rules.vpb.lossCarryForward.condition, lossSource: rules.vpb.lossCarryForward.source },
    vat: { period: vatPeriod, quarters: vatQuarters, totalComputedEur: r2(vatQuarters.reduce((s, q) => s + q.computedEur, 0)), totalPaidEur: r2(vatQuarters.reduce((s, q) => s + q.paidEur, 0)) },
    dividends,
    deadlines,
  };
  for (const q of vatQuarters) if (q.status === "overdue") warn("tax", `VAT ${q.period} was due ${q.dueOn} and is not recorded as filed and paid.`);
  for (const d of deadlines) if (d.status === "overdue" && !d.key.startsWith("vat:")) warn("tax", `${d.title}: due ${d.dueOn}, not recorded as done.`);

  // ------------------------------------------------------------ reconciliation and closes
  const monthsOfYear = [...closeMonths.entries()].filter(([m]) => m.startsWith(String(year)));
  const recon = monthsOfYear.map(([month, m]) => {
    const segs = yearSegs.filter((s) => s.month === month);
    const yRev = segs.reduce((s, x) => s + x.revenueUsd, 0);
    const yCost = segs.reduce((s, x) => s + x.costsUsd, 0);
    const revDiff = m.revenueUsd == null ? null : yRev - m.revenueUsd;
    const costDiff = m.costsUsd == null ? null : yCost - m.costsUsd;
    return { month, status: m.status, closeRevenueUsd: r2(m.revenueUsd), yearEndRevenueUsd: r2(yRev), revenueDiffUsd: r2(revDiff), closeCostsUsd: r2(m.costsUsd), yearEndCostsUsd: r2(yCost), costsDiffUsd: r2(costDiff), reconciled: revDiff == null || costDiff == null ? null : Math.abs(revDiff) <= 0.05 && Math.abs(costDiff) <= 0.05 };
  });
  const closeRevenue = sumOrNull(monthsOfYear.map(([, m]) => m.revenueUsd));
  const closeCosts = sumOrNull(monthsOfYear.map(([, m]) => m.costsUsd));
  const reconciliation = {
    rule: "Revenue and costs in USD per month must equal the Monthly Close (closed months: their snapshot; open months: live), which reads the same revenue lanes as Summary and Revenue. EUR amounts use each day's ECB rate here, the Close converts at the month-end rate, so EUR can differ by the rate only.",
    months: recon,
    totals: { closeRevenueUsd: r2(closeRevenue), yearEndRevenueUsd: r2(sumSeg("revenueUsd")), closeCostsUsd: r2(closeCosts), yearEndCostsUsd: r2(sumSeg("costsUsd")), reconciled: closeRevenue == null || closeCosts == null ? null : Math.abs(closeRevenue - sumSeg("revenueUsd")) <= 0.05 * Math.max(1, recon.length) && Math.abs(closeCosts - sumSeg("costsUsd")) <= 0.05 * Math.max(1, recon.length) },
  };
  for (const r of recon) if (r.reconciled === false) warn("reconciliation", `${r.month}: year-end revenue USD ${r.yearEndRevenueUsd} vs Close ${r.closeRevenueUsd}, costs ${r.yearEndCostsUsd} vs ${r.closeCostsUsd}.`);
  const nowMonth = today.slice(0, 7);
  const notClosed = monthsOfYear.filter(([m, v]) => v.status !== "closed" && m < nowMonth && ((v.revenueUsd ?? 1) !== 0 || (v.costsUsd ?? 0) !== 0)).map(([m]) => m);
  if (notClosed.length) warn("close", `Months with activity not closed yet: ${notClosed.join(", ")}. Their figures are live and can still change.`);
  const closeRows = monthsOfYear.map(([month, m]) => ({ month, status: m.status, closedBy: closes.get(month)?.closedBy || null, closedAt: closes.get(month)?.closedAt || null, revenueUsd: r2(m.revenueUsd), costsUsd: r2(m.costsUsd) }));

  // ------------------------------------------------------------ rules, assumptions, notes
  const table = rulesTable(rules);
  for (const r of table) if (r.needsConfirmation) warn("rules", `Rule with low confidence (needs confirmation): ${r.label} (${r.value}).`, "info");
  if (rules.storedInvalid) warn("rules", "The saved tax rules no longer validate: the researched defaults are used.");
  if (provisional) warn("year", `${year} has not ended: this is a provisional package up to ${asOf}. The write-down uses today's prices, not those of 31 December.`, "info");
  if (entity?.inFormation) warn("entity", "The BV is in formation (not registered yet). The books are kept as if it is registered; see the BV-in-formation note in the README.", "info");
  for (const n of notes) warn("source", n, "info");
  for (const w of model.warnings || []) if (/\d{4}/.test(w) && w.includes(String(year))) warn("source", w, "info");

  return {
    schemaVersion: YEAR_END_SCHEMA,
    year,
    asOf,
    provisional,
    today,
    currency: "EUR",
    entity: entity ? { status: entity.status, label: entity.label, inFormation: entity.inFormation, registeredOn: entity.registeredOn, note: ye?.bvInFormation?.condition || null } : null,
    method: { cost: method.toUpperCase(), lowerOfCostOrMarket: rules.vpb.cryptoCostMethod.lowerOfCostOrMarket, writeDown: ye?.writeDown?.perAsset === false ? "per lot requested; computed per asset" : "per asset" },
    pnl,
    balance,
    tax,
    reconciliation,
    closes: closeRows,
    warnings,
    assumptions: assumptions({ rules, provisional, year }),
    rules: table.map((r) => ({ key: r.key, label: r.label, value: r.value, source: r.source, checkedOn: r.checkedOn, confidence: r.confidence })),
    _lots: { holdings: holdings.rows, disposals: holdings.disposals.filter((d) => d.date.slice(0, 4) === String(year)), acquisitions: (treasury.lotInputs?.acquisitions || []).filter((a) => a.date.slice(0, 4) === String(year) && a.date <= asOf) },
  };
}

function walletChainBalance(account, chains) {
  if (!account.address) return null;
  const c = chains.find((x) => x.chainId === account.chainId);
  if (!c) return null;
  const same = (a) => a && (account.chainId === 101 ? a === account.address : String(a).toLowerCase() === account.address.toLowerCase());
  if (same(c.multisigAddress)) return { asset: c.asset, amount: c.multisigAmount ?? null, usd: c.multisigUsd ?? null };
  if (same(c.operator?.address)) return { asset: c.asset, amount: c.operator.amount ?? null, usd: c.operator.amountUsd ?? null };
  if (same(c.protocolVault?.address)) return { asset: c.asset, amount: c.protocolVault.amount ?? null, usd: c.protocolVault.amountUsd ?? null };
  return null;
}

/** Lots per native coin against what our wallets hold on chain now (multisig + operator + protocol vault). */
function chainCheck(rows, chains) {
  if (!chains) return { lines: [], note: "The chain balances could not be read." };
  const lines = [];
  for (const asset of [...new Set(chains.map((c) => c.asset))]) {
    const onChain = chains.filter((c) => c.asset === asset);
    const parts = onChain.flatMap((c) => [c.multisigAmount, c.operator?.amount, c.protocolVault?.amount]);
    const chainAmount = parts.some((p) => p == null) ? null : parts.reduce((s, p) => s + Number(p), 0);
    const lot = rows.find((r) => r.key === asset);
    const books = lot ? lot.amount : 0;
    lines.push({ asset, booksAmount: books, chainAmount, differenceAmount: chainAmount == null ? null : chainAmount - books });
  }
  return { lines, note: "Books = FIFO lots (fee revenue in, recorded movements out). Chain = multisig + operator wallet + protocol vault now, native coin only." };
}

/** User funds held in the protocol vaults: off the balance sheet, with what is owed and the coverage. */
function userFundsNote(payouts, { provisional, rateNow, rule }) {
  const base = { onBalanceSheet: Boolean(rule?.onBalanceSheet), rule: rule?.condition || null, source: rule?.source || null, shortfalls: [] };
  if (!payouts) return { ...base, owedUsd: null, owedEur: null, types: [], note: "The payouts read is not available." };
  if (payouts.error) return { ...base, owedUsd: null, owedEur: null, types: [], note: payouts.error };
  const types = [];
  for (const section of payouts.networks || []) {
    if (section.status !== "ok") {
      types.push({ chainId: section.chainId, chain: section.chain, type: "read failed", owedUsd: null, coverage: "unknown" });
      base.shortfalls.push(`${section.chain} (read failed)`);
      continue;
    }
    for (const t of section.data?.types || []) {
      if (t.id === "operator_fill") continue;
      const owed = t.owed?.known ? t.owed.total : null;
      const coverage = t.coverage?.status ?? null;
      types.push({ chainId: section.chainId, chain: section.chain, type: t.id, label: t.label, asset: t.asset, owedNative: owed?.amount ?? null, owedUsd: owed?.amountUsd ?? null, coverage });
      if (coverage === "short" || (coverage === "unknown" && !(owed?.amountUsd === 0))) base.shortfalls.push(`${section.chain} ${t.label} (${coverage})`);
    }
  }
  const owedUsd = payouts.totals?.owed?.amountUsd ?? null;
  return { ...base, owedUsd: r2(owedUsd), owedEur: owedUsd != null && rateNow > 0 ? r2(owedUsd / rateNow) : null, types, note: provisional ? "Owed now (the Payouts page)." : "Owed now (the Payouts page); the read model has no figure at 31 December, so this is today's amount." };
}

/** Annual accounts deadlines for a book year (art. 2:210 and 2:394 BW, KVK). */
export function annualDeadlines(year, today, rules) {
  const a = rules.yearEnd?.annualAccounts;
  if (!a) return [];
  const start = `${year + 1}-01-01`;
  const lastDay = (date) => { const [y, m] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); };
  const prepare = lastDay(addMonthsToDate(start, a.prepareMonths));
  const prepareExt = lastDay(addMonthsToDate(start, a.prepareMonths + a.extensionMonths));
  const fileNoExt = `${year + 1}-08-08`;
  const fileMax = lastDay(addMonthsToDate(start, a.fileWithinMonths));
  const status = (d) => (today > `${year}-12-31` ? (d < today ? "overdue" : "open") : "not yet due");
  return [
    { key: `accounts:${year}:prepare`, title: `Annual accounts ${year}: board prepares them (5 months; up to 5 more if the shareholders extend)`, dueOn: prepare, amountEur: null, amountBasis: `Extended at most to ${prepareExt}`, status: status(prepare), source: a.source },
    { key: `accounts:${year}:file`, title: `Annual accounts ${year}: file with the KVK (8 days after adoption; last day without extension)`, dueOn: fileNoExt, amountEur: null, amountBasis: `With the full extension at the latest ${fileMax}`, status: status(fileNoExt), source: a.source },
  ];
}

function assumptions({ rules, provisional, year }) {
  const ye = rules.yearEnd || {};
  return [
    { key: "currency", text: "Books in EUR. Fees are revenue at their EUR value on the day they are earned (event-hour USD price, ECB USD/EUR rate of that day).", source: rules.vpb.profitBasis.source },
    { key: "fifo", text: `Cost of crypto that leaves: ${String(rules.vpb.cryptoCostMethod.method).toUpperCase()} per asset across all BV accounts.`, source: rules.vpb.cryptoCostMethod.source },
    { key: "write_down", text: ye.writeDown?.condition || "Held crypto at cost or lower market value at the balance date.", source: ye.writeDown?.source },
    { key: "user_funds", text: ye.userFunds?.condition || "Money owed to users is off the balance sheet.", source: ye.userFunds?.source },
    { key: "loss", text: rules.vpb.lossCarryForward.condition, source: rules.vpb.lossCarryForward.source },
    { key: "vat", text: rules.vat.condition, source: rules.vat.source },
    { key: "bv_in_formation", text: ye.bvInFormation?.condition || "", source: ye.bvInFormation?.source },
    { key: "unpaid_costs", text: "A cost in EUR or USD without a bank or crypto payment linked to it is a debt at the balance date. Costs in SOL, BNB or ETH were paid from the lots." },
    { key: "off_chain_revenue", text: "Revenue counted in USD off-chain (Home placements) is a receivable until a bank receipt without a revenue lane covers it." },
    { key: "usd_cash", text: "USD and stablecoins are held in lots like crypto (cost or lower market value at the ECB rate), not revalued upward." },
    ...(provisional ? [{ key: "provisional", text: `${year} has not ended: the balance date is today and the write-down uses today's prices.` }] : []),
  ];
}

// ------------------------------------------------------------------ schedules (CSV) and package

const col = (key, label = key) => ({ key, label });

/**
 * Every schedule of the package: name (file), title, what it is, columns, rows.
 * @param {object} view    buildYearEnd output
 * @param {object} extra   rows read by the handler: revenueEvents, costs, movements, closeSummaries, records, taxItems (+ notes)
 */
export function yearEndSchedules(view, extra = {}) {
  const y = view.year;
  const p = view.pnl;
  const pnlRows = [
    ...p.revenue.lanes.map((l) => ({ section: "Revenue", line: `${l.label} (${l.chain || ""}, ${l.laneId})`, grossEur: l.grossEur, vatEur: l.vatEur, eur: l.netEur, note: `VAT lane ${l.vatLane}` })),
    { section: "Revenue", line: "Closed-month snapshot adjustment", grossEur: p.revenue.closedMonthAdjustment.grossEur, vatEur: p.revenue.closedMonthAdjustment.vatEur, eur: p.revenue.closedMonthAdjustment.netEur, note: p.revenue.closedMonthAdjustment.note },
    { section: "Revenue", line: "Revenue received in the bank", grossEur: p.revenue.bankReceipts.grossEur, vatEur: p.revenue.bankReceipts.vatEur, eur: p.revenue.bankReceipts.netEur, note: p.revenue.bankReceipts.note },
    { section: "Revenue", line: "Net revenue (excluding VAT)", grossEur: p.revenue.grossEur, vatEur: p.revenue.vatEur, eur: p.revenue.netEur, note: "" },
    ...p.costs.categories.map((c) => ({ section: "Costs", line: c.label, eur: c.eur == null ? null : -c.eur, note: `USD ${c.usd}` })),
    { section: "Costs", line: "Total costs", eur: p.costs.totalEur == null ? null : -p.costs.totalEur, note: "" },
    { section: "Treasury", line: "Realized gains and losses on crypto (FIFO)", eur: p.realizedGainEur, note: "" },
    { section: "Treasury", line: "Exchange and network fees", eur: p.feesEur == null ? null : -p.feesEur, note: "" },
    { section: "Result", line: "Operating result", eur: p.operatingResultEur, note: "" },
    { section: "Year-end adjustment", line: p.writeDown.label, eur: p.writeDown.resultEffectEur, note: `Write-down at year end ${p.writeDown.atYearEndEur ?? "unknown"}, at the last year end ${p.writeDown.atLastYearEndEur ?? "unknown"}` },
    { section: "Result", line: "Result before tax", eur: p.resultBeforeTaxEur, note: "" },
    ...p.vpb.brackets.map((b) => ({ section: "Tax", line: `VPB ${Math.round(b.rate * 1000) / 10}% on ${b.fromEur}${b.upToEur == null ? "+" : `-${b.upToEur}`}`, grossEur: b.baseEur, eur: b.taxEur == null ? null : -b.taxEur, note: "base in the gross column" })),
    { section: "Tax", line: "Corporate income tax (VPB)", eur: p.vpb.vpbEur == null ? null : -p.vpb.vpbEur, note: `Taxable ${p.vpb.taxableProfitEur ?? "unknown"} after loss used ${p.vpb.lossUsedEur ?? "unknown"}` },
    { section: "Result", line: "Result after tax", eur: p.resultAfterTaxEur, note: "" },
  ];
  const b = view.balance;
  const balanceRows = [
    { side: "Assets", line: "Cash in EUR (bank and exchange accounts)", eur: b.assets.cashEur, note: "" },
    ...b.assets.crypto.map((c) => ({ side: "Assets", line: `${c.asset}${c.address ? ` (${c.address})` : ""}: ${c.amount}`, eur: c.bookEur, note: `cost ${c.costEur}, market ${c.marketEur ?? "unknown"} (${c.marketSource}), write-down ${c.writeDownEur ?? "unknown"}` })),
    ...b.assets.receivables.map((r) => ({ side: "Assets", line: r.label, eur: r.eur, note: "" })),
    { side: "Assets", line: "Total assets", eur: b.assets.totalEur, note: "" },
    ...b.liabilities.lines.map((l) => ({ side: "Liabilities", line: l.label, eur: l.eur, note: "" })),
    { side: "Liabilities", line: "Total liabilities", eur: b.liabilities.totalEur, note: "" },
    { side: "Equity", line: `Equity at 1 January ${y}`, eur: b.equity.openingEur, note: "" },
    { side: "Equity", line: "Owner contributions", eur: b.equity.contributionsEur, note: "" },
    { side: "Equity", line: "Opening balances recorded this year", eur: b.equity.openingBalancesRecordedEur, note: "" },
    { side: "Equity", line: "Result after tax", eur: b.equity.resultEur, note: "" },
    { side: "Equity", line: "Distributions declared", eur: b.equity.distributionsDeclaredEur == null ? null : -b.equity.distributionsDeclaredEur, note: "" },
    { side: "Equity", line: `Equity at ${b.asOf}`, eur: b.equity.closingEur, note: "" },
    { side: "Check", line: "Assets - liabilities - equity", eur: b.check.differenceEur, note: b.check.balanced === false ? "Not balanced: see the warnings" : "" },
    { side: "Off balance sheet", line: "Owed to users (prizes, rewards, creator fees), held in the protocol vaults", eur: b.offBalance.userFunds.owedEur, note: b.offBalance.userFunds.note },
  ];
  const t = view.tax;
  const taxRows = [
    ...t.vpb.years.map((v) => ({ tax: "VPB", period: String(v.year), computedEur: v.vpbEur, filedEur: null, paidEur: null, status: "", note: `result before tax ${v.resultBeforeTaxEur ?? "unknown"}, loss in ${v.lossCarriedInEur ?? "unknown"}, used ${v.lossUsedEur ?? "unknown"}, out ${v.lossCarriedOutEur ?? "unknown"}, taxable ${v.taxableEur ?? "unknown"}` })),
    ...t.vat.quarters.map((q) => ({ tax: "VAT", period: q.period, computedEur: q.computedEur, filedEur: q.filedEur, paidEur: q.paidEur, status: q.status, note: `1a base ${q.r1a.baseEur} VAT ${q.r1a.vatEur}; 3b base ${q.r3b.baseEur}; OSS ${q.ossEur}; due ${q.dueOn}` })),
    ...t.dividends.map((d) => ({ tax: "Dividend tax", period: d.week, computedEur: d.withheldEur, filedEur: null, paidEur: null, status: d.taxStatus, note: `gross ${d.grossEur}, net ${d.netEur}, due ${d.dueOn || ""}` })),
  ];
  const revenueEvents = extra.revenueEvents || [];
  const lots = view._lots || { holdings: [], disposals: [], acquisitions: [] };
  const lotRows = [
    ...lots.acquisitions.map((a) => ({ date: a.date, direction: "in", asset: a.asset, amount: a.amount, eur: r2(a.eur), costEur: r2(a.eur), gainEur: null, kind: a.source?.startsWith("revenue") ? "fee revenue" : "movement", reference: a.source })),
    ...lots.disposals.map((d) => ({ date: d.date, direction: "out", asset: d.asset, amount: d.amount, eur: r2(d.proceedsEur), costEur: r2(d.costEur), gainEur: r2(d.gainEur), kind: d.kind, reference: d.ref, uncoveredAmount: d.uncoveredAmount || null })),
  ].sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : a.direction === "in" ? -1 : 1));
  const holdingRows = lots.holdings.flatMap((h) => (h.openLots.length ? h.openLots : [{ date: null, amount: h.amount, costEur: h.costEur }]).map((l) => ({ asset: h.asset, address: h.address, lotDate: l.date, amount: l.amount, costEur: r2(l.costEur), assetAmount: h.amount, assetCostEur: r2(h.costEur), assetMarketEur: r2(h.marketEur), assetBookEur: r2(h.bookEur), marketSource: h.marketSource })));
  const cashRows = b.accounts.flatMap((a) => (a.recorded.length ? a.recorded : [{ asset: "", amount: 0, eur: null, inBooksAs: "nothing recorded" }]).map((l) => ({ account: a.name, kind: a.kindLabel, chainId: a.chainId, address: a.address, asset: l.asset, tokenAddress: l.address || "", amount: l.amount, eur: l.eur, inBooksAs: l.inBooksAs, chainNowAmount: a.chainNow?.amount ?? null, chainNowUsd: a.chainNow?.usd ?? null })));
  const schedules = [
    { name: "01-profit-and-loss.csv", title: "Profit and loss", what: `Revenue per lane (gross, VAT, net), costs per category, realized crypto gains, fees, the year-end write-down, result before tax, VPB per bracket and result after tax, in EUR, ${y}-01-01 to ${view.asOf}.`, columns: [col("section"), col("line"), col("grossEur", "gross_eur"), col("vatEur", "vat_eur"), col("eur", "amount_eur"), col("note")], rows: pnlRows },
    { name: "02-balance-sheet.csv", title: "Balance sheet", what: `Assets, liabilities and equity at ${view.asOf} in EUR, the balance check, and the money owed to users that is kept off the balance sheet.`, columns: [col("side"), col("line"), col("eur", "amount_eur"), col("note")], rows: balanceRows },
    { name: "03-tax-summary.csv", title: "Tax summary", what: "VPB per year (result, loss carry-forward, taxable profit, tax), VAT per quarter (computed vs filed vs paid, return boxes), dividend tax per distribution.", columns: [col("tax"), col("period"), col("computedEur", "computed_eur"), col("filedEur", "filed_eur"), col("paidEur", "paid_eur"), col("status"), col("note")], rows: taxRows },
    { name: "04-deadlines.csv", title: "Deadlines", what: "Every tax and annual-accounts deadline for the year with its status.", columns: [col("dueOn", "due_on"), col("title"), col("amountEur", "amount_eur"), col("amountBasis", "amount_basis"), col("status"), col("source")], rows: t.deadlines },
    { name: "05-revenue-by-lane.csv", title: "Revenue by lane", what: "Each revenue lane over the year: native amount, USD, EUR gross, VAT and net.", columns: [col("laneId", "lane_id"), col("label"), col("chainId", "chain_id"), col("chain"), col("asset"), col("vatLane", "vat_lane"), col("nativeAmount", "native_amount"), col("grossUsd", "gross_usd"), col("grossEur", "gross_eur"), col("vatEur", "vat_eur"), col("netEur", "net_eur"), col("unpricedDays", "unpriced_days")], rows: p.revenue.lanes },
    { name: "06-revenue-events.csv", title: "Revenue events", what: "Every revenue event of the year with its transaction hash, price and rate (same filters as the Revenue page).", columns: extra.revenueEventColumns || [], rows: revenueEvents },
    { name: "07-costs.csv", title: "Costs", what: "Every cost occurrence of the year with its rate, EUR amount and evidence link (attachment_url).", columns: extra.costColumns || [], rows: extra.costs || [] },
    { name: "08-unpaid-costs.csv", title: "Unpaid costs", what: `Costs dated up to ${view.asOf} without a payment recorded (a debt at the balance date).`, columns: [col("date"), col("costId", "cost_id"), col("vendor"), col("category"), col("amount"), col("currency"), col("amountUsd", "amount_usd"), col("eur", "amount_eur")], rows: b.liabilities.unpaidCosts },
    { name: "09-treasury-movements.csv", title: "Treasury movements", what: "Every recorded movement of the year with its EUR value, fee and realized gain.", columns: extra.movementColumns || [], rows: extra.movements || [] },
    { name: "10-fifo-lot-movements.csv", title: "FIFO lot movements", what: "Every lot in (fee revenue per day and lane, opening balances, conversions in) and out (conversions, fees, crypto costs, distributions) of the year, with cost and realized gain.", columns: [col("date"), col("direction"), col("asset"), col("amount"), col("eur", "value_eur"), col("costEur", "cost_eur"), col("gainEur", "gain_eur"), col("kind"), col("reference"), col("uncoveredAmount", "uncovered_amount")], rows: lotRows },
    { name: "11-holdings-at-balance-date.csv", title: "Holdings at the balance date", what: `Open FIFO lots at ${view.asOf} per asset, with the asset's cost, market value and book value (cost or lower market).`, columns: [col("asset"), col("address"), col("lotDate", "lot_date"), col("amount"), col("costEur", "lot_cost_eur"), col("assetAmount", "asset_amount"), col("assetCostEur", "asset_cost_eur"), col("assetMarketEur", "asset_market_eur"), col("assetBookEur", "asset_book_eur"), col("marketSource", "market_source")], rows: holdingRows },
    { name: "12-cash-per-account.csv", title: "Cash per account", what: `What each recorded account held at ${view.asOf} from the movements${view.provisional ? ", with the chain balance now for wallets" : ""}.`, columns: [col("account"), col("kind"), col("chainId", "chain_id"), col("address"), col("asset"), col("tokenAddress", "token_address"), col("amount"), col("eur", "eur"), col("inBooksAs", "in_books_as"), col("chainNowAmount", "chain_now_amount"), col("chainNowUsd", "chain_now_usd")], rows: cashRows },
    { name: "13-distributions.csv", title: "Distributions", what: "Every recorded distribution with its status, gross, withholding and net.", columns: [col("week"), col("status"), col("declaredOn", "declared_on"), col("availableOn", "available_on"), col("totalGrossEur", "gross_eur"), col("totalWithholdingEur", "withholding_eur"), col("totalNetEur", "net_eur"), col("dividendTaxDueOn", "dividend_tax_due_on"), col("dividendTaxReturnFiledOn", "dividend_tax_filed_on"), col("dividendTaxPaidOn", "dividend_tax_paid_on"), col("txHashes", "tx_hashes")], rows: (extra.records || []).map((r) => ({ ...r, declaredOn: declaredOn(r), txHashes: Object.entries(r.txHashes || {}).map(([c, h]) => `${c}:${h}`).join(" ") })) },
    { name: "14-tax-items.csv", title: "Tax items", what: "Every return, assessment, payment, refund and notification recorded.", columns: [col("taxType", "tax_type"), col("period"), col("kind"), col("amountEur", "amount_eur"), col("dueOn", "due_on"), col("doneOn", "done_on"), col("accountId", "account_id"), col("distributionId", "distribution_id"), col("reference"), col("note"), col("createdBy", "created_by")], rows: (extra.taxItems || []).filter((x) => !x.deletedAt) },
    { name: "15-month-closes.csv", title: "Month-close snapshots", what: "Each month of the year: closed (frozen snapshot) or open (live), with revenue, costs, profit, tax reserve and the rates at close.", columns: extra.closeColumns || [], rows: extra.closeSummaries || [] },
    { name: "16-reconciliation.csv", title: "Reconciliation with the Monthly Close", what: view.reconciliation.rule, columns: [col("month"), col("status"), col("closeRevenueUsd", "close_revenue_usd"), col("yearEndRevenueUsd", "year_end_revenue_usd"), col("revenueDiffUsd", "revenue_diff_usd"), col("closeCostsUsd", "close_costs_usd"), col("yearEndCostsUsd", "year_end_costs_usd"), col("costsDiffUsd", "costs_diff_usd"), col("reconciled")], rows: view.reconciliation.months },
    { name: "17-warnings-and-assumptions.csv", title: "Warnings and assumptions", what: "Open warnings (missing records, months not closed, low-confidence rules, unknowns) and the assumptions this package rests on.", columns: [col("type"), col("level"), col("area"), col("text"), col("source")], rows: [...view.warnings.map((w) => ({ type: "warning", ...w })), ...view.assumptions.map((a) => ({ type: "assumption", level: "", area: a.key, text: a.text, source: a.source || "" }))] },
    { name: "18-rules.csv", title: "Rules used", what: "Every tax and accounting rule with its value, source, the date it was checked and its confidence.", columns: [col("key"), col("label"), col("value"), col("source"), col("checkedOn", "checked_on"), col("confidence")], rows: view.rules },
  ];
  return schedules;
}

/** README.txt for the package: what each file is, the rules with sources, the BV-in-formation note. */
export function yearEndReadme(view, schedules, { generatedAt, generatedBy = null } = {}) {
  const lines = [];
  const eur = (v) => (v == null ? "unknown" : `EUR ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  lines.push(`MemeWarzone BV - year-end package ${view.year}`);
  lines.push("=".repeat(48));
  lines.push("");
  lines.push(`Period: ${view.year}-01-01 to ${view.asOf}${view.provisional ? " (PROVISIONAL: the year has not ended)" : ""}`);
  lines.push(`Generated: ${generatedAt}${generatedBy ? ` by ${generatedBy}` : ""} from the Command Center (Finance > Year end).`);
  lines.push("Currency: EUR. Every amount that could not be read or valued is left empty (unknown), never 0, and is listed under warnings.");
  lines.push("");
  lines.push("Key figures");
  lines.push("-----------");
  lines.push(`Net revenue (excl. VAT): ${eur(view.pnl.revenue.netEur)}`);
  lines.push(`Costs: ${eur(view.pnl.costs.totalEur)}`);
  lines.push(`Realized crypto gains/losses (FIFO): ${eur(view.pnl.realizedGainEur)}; fees: ${eur(view.pnl.feesEur)}`);
  lines.push(`Year-end write-down to lower market value (result effect): ${eur(view.pnl.writeDown.resultEffectEur)}`);
  lines.push(`Result before tax: ${eur(view.pnl.resultBeforeTaxEur)}`);
  lines.push(`Corporate income tax (VPB): ${eur(view.pnl.vpb.vpbEur)} on taxable ${eur(view.pnl.vpb.taxableProfitEur)}`);
  lines.push(`Result after tax: ${eur(view.pnl.resultAfterTaxEur)}`);
  lines.push(`Total assets at ${view.asOf}: ${eur(view.balance.assets.totalEur)}; liabilities ${eur(view.balance.liabilities.totalEur)}; equity ${eur(view.balance.equity.closingEur)}; balance check difference ${eur(view.balance.check.differenceEur)}`);
  lines.push(`Owed to users, off the balance sheet: ${eur(view.balance.offBalance.userFunds.owedEur)}`);
  lines.push("");
  lines.push("Files");
  lines.push("-----");
  lines.push("year-end.json  The whole package as data (the same figures as the dashboard page).");
  for (const s of schedules) lines.push(`${s.name}  ${s.title}: ${s.what} (${s.rows.length} rows)`);
  lines.push("");
  lines.push("How the figures are made");
  lines.push("------------------------");
  for (const a of view.assumptions) lines.push(wrap(`- ${a.text}${a.source ? ` [${a.source}]` : ""}`));
  lines.push(wrap(`- Reconciliation: ${view.reconciliation.rule}`));
  lines.push("");
  lines.push("BV in formation");
  lines.push("---------------");
  lines.push(wrap(view.entity?.inFormation
    ? `Status: ${view.entity.label}. ${view.entity.note || ""}`
    : `Status: ${view.entity?.label || "unknown"}${view.entity?.registeredOn ? `, registered on ${view.entity.registeredOn}` : ""}. ${view.entity?.note || ""}`));
  lines.push("");
  lines.push("Rules used (value, source, checked on, confidence)");
  lines.push("--------------------------------------------------");
  for (const r of view.rules) lines.push(wrap(`- ${r.label}: ${r.value}. Source: ${r.source || "none"}; checked ${r.checkedOn || "n/a"}; confidence ${r.confidence}${r.confidence === "low" ? " (NEEDS CONFIRMATION)" : ""}.`));
  lines.push("");
  lines.push(`Open warnings (${view.warnings.length})`);
  lines.push("-------------");
  for (const w of view.warnings) lines.push(wrap(`- [${w.level}] ${w.area}: ${w.text}`));
  lines.push("");
  lines.push("These rules were researched from official sources without a tax adviser (founder decision 2026-10-05). They can be changed on the Tax & Reserves page; every change is logged.");
  return `${lines.join("\r\n")}\r\n`;
}

function wrap(text, width = 100) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width && line) { out.push(line); line = `  ${w}`; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join("\r\n");
}

/** One schedule as CSV text. */
export function scheduleCsv(schedule) {
  return toCsv(schedule.columns, schedule.rows);
}

/** The ZIP: README.txt, year-end.json and every schedule as CSV. */
export function yearEndZip(view, schedules, { generatedAt, generatedBy = null, date = new Date() } = {}) {
  const { _lots, ...json } = view;
  const folder = `mwz-year-end-${view.year}`;
  return buildZip([
    { name: `${folder}/README.txt`, data: yearEndReadme(view, schedules, { generatedAt, generatedBy }) },
    { name: `${folder}/year-end.json`, data: `${JSON.stringify(json, null, 2)}\n` },
    ...schedules.map((s) => ({ name: `${folder}/${s.name}`, data: scheduleCsv(s) })),
  ], { date });
}


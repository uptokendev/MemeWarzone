// Weekly distribution view: what can be divided between the shareholders each
// week, and what each one receives after tax. Pure functions; the handler
// (admin/financeAccounting.js) reads the inputs.
//
// Weeks: ISO weeks, Monday to Sunday, with UTC day boundaries. UTC, not
// Europe/Amsterdam, because the monthly close and its revenue months are UTC
// (financeAccountingSources.js); with the same day boundary every week splits
// cleanly at a month end and the weeks of a month add up to that month. In
// Amsterdam terms a week runs Monday 01:00 (winter) or 02:00 (summer) to the
// same time the next Monday. A week that crosses a month end is split into one
// segment per month; a week that crosses a year end is split per year, so the
// corporate tax of each year stays on its own year.
//
// Per segment, in EUR (the BV's book currency; USD alongside):
//   revenue    fees at the event-hour USD price, converted per day at the ECB rate
//   VAT        per revenue lane from the rules: fee * rate / (1 + rate) * taxable share
//   costs      one-off costs on their date; a recurring cost spread evenly over
//              the days of the month it falls in (so the month total is unchanged)
//   profit     revenue - VAT - costs + treasury (realized gains on crypto -
//              fees + revenue received in the bank - its VAT;
//              financeTreasury.js)
//   VPB        marginal: tax(year-to-date taxable profit after the segment)
//              - tax(year-to-date taxable profit before it), with that year's
//              brackets. A loss releases reserve. A year that ends with a loss
//              carries it forward (no time limit; in full up to EUR 1m taxable
//              profit, 50% above). Carry-back refunds are not counted.
// Per week:
//   profit after tax = profit - VPB
//   carry-over in    = what earlier complete weeks earned and was not distributed
//   distributable    = max(0, carry-over in + profit after tax) (before cash)
//   carry-over out   = carry-over in + profit after tax - distributed (approved or paid)
// Decision (the last complete week):
//   available = min(entitlement, cash in the multisig - open costs - reserves held
//               - distributions approved but not yet paid)
//   reserves held = VPB + VAT + dividend tax still to pay: each reserve minus
//               what was paid (financeTaxCalendar.js; a filed return or final
//               assessment replaces the estimate). Without tax items recorded,
//               every reserve since the start stays held.
//   off-chain cash (EUR, USD and stablecoins on the bank and exchange
//               accounts) covers reserves and open costs first: the multisig
//               only holds what the bank cannot pay. Only the multisig is divided.

import { round2, roundUsd } from "./financeAccountingCosts.js";
import { bracketTax } from "./financeAccountingTax.js";
import { addMonthsToDate, vatLaneOf, vpbYear, withholdingFor, DEFAULT_TAX_RULES } from "./financeTaxRules.js";
import { computeDistribution } from "./financeAccountingDistributions.js";
import { dayNetEur } from "./financeTreasury.js";

const DAY_MS = 86_400_000;
export const WEEK_RULE = "ISO weeks, Monday to Sunday, UTC days (the same day boundary as the monthly close; in Amsterdam a week starts Monday 01:00 in winter, 02:00 in summer). A week across a month or year end is split by date.";
export const COUNTED_STATUSES = Object.freeze(["approved", "paid"]);

const dayMs = (date) => Date.parse(`${date}T00:00:00.000Z`);
export const addDays = (date, n) => new Date(dayMs(date) + n * DAY_MS).toISOString().slice(0, 10);
const monthOfDate = (date) => date.slice(0, 7);
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const floorCents = (v) => Math.floor(v * 100 + 1e-6) / 100;

/** Monday (YYYY-MM-DD) of the ISO week holding `date`. */
export function mondayOf(date) {
  const dow = (new Date(dayMs(date)).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(date, -dow);
}

/** ISO week key "2026-W40" of a date. */
export function isoWeekKey(date) {
  const monday = mondayOf(date);
  const thursday = addDays(monday, 3);
  const year = Number(thursday.slice(0, 4));
  const firstThursday = (() => {
    const jan4 = `${year}-01-04`;
    return addDays(mondayOf(jan4), 3);
  })();
  const week = Math.round((dayMs(thursday) - dayMs(firstThursday)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of an ISO week key. */
export function weekMonday(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const monday = addDays(mondayOf(`${m[1]}-01-04`), (Number(m[2]) - 1) * 7);
  return isoWeekKey(monday) === key ? monday : null;
}

/** Week + month segments covering [fromDate, toDate], whole weeks. */
export function weekSegments(fromDate, toDate) {
  const out = [];
  for (let monday = mondayOf(fromDate); monday <= toDate; monday = addDays(monday, 7)) {
    const sunday = addDays(monday, 6);
    const week = isoWeekKey(monday);
    let start = monday;
    while (start <= sunday) {
      const month = monthOfDate(start);
      const monthLast = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
      const end = monthLast < sunday ? monthLast : sunday;
      out.push({ week, weekStart: monday, weekEnd: sunday, month, year: Number(month.slice(0, 4)), start, end, days: Math.round((dayMs(end) - dayMs(start)) / DAY_MS) + 1 });
      start = addDays(end, 1);
    }
  }
  return out;
}

/** Taxable profit after a loss carried forward: full offset up to the cap, a share above it. */
export function taxableAfterLoss(profit, lossPool, rule = DEFAULT_TAX_RULES.vpb.lossCarryForward) {
  if (!(profit > 0)) return 0;
  if (!(lossPool > 0)) return profit;
  const cap = rule.fullOffsetUpToEur;
  const room = Math.min(profit, cap) + rule.excessOffsetShare * Math.max(0, profit - cap);
  return profit - Math.min(lossPool, room);
}

function vatOfLanes(lanes, rules, usdPerEur) {
  let vatEur = 0;
  const byLane = {};
  for (const lane of lanes || []) {
    if (lane.amountUsd == null) continue;
    const key = vatLaneOf(lane.laneId);
    const r = rules.vat.lanes[key] || rules.vat.lanes.other;
    const eur = lane.amountUsd / usdPerEur;
    const vat = r.treatment === "exempt" || r.treatment === "outside_scope" ? 0 : (eur * r.rate) / (1 + r.rate) * r.taxableShare;
    vatEur += vat;
    byLane[key] = (byLane[key] || 0) + vat;
  }
  return { vatEur, byLane };
}

/**
 * @param {object} input
 * @param {string} input.today                 YYYY-MM-DD (UTC)
 * @param {string} input.fromDate              first day to cover (its whole week is shown)
 * @param {Record<string,{totalUsd:number|null,lanes:object[]}>} input.days   revenue per UTC day
 * @param {(date:string)=>number|null} input.usdPerEur   ECB USD per EUR for a date
 * @param {Map<string, object[]>} input.costsByMonth   cost occurrences per month (closed months: the snapshot's)
 * @param {Map<string, {status:string, revenueUsd:number|null, costsUsd:number|null}>} input.months  the monthly close figures
 * @param {object} input.rules                 effective tax rule set
 * @param {object|null} [input.vpbOverride]    brackets saved on the old Tax & Reserves form
 * @param {object[]} [input.records]           recorded distributions
 * @param {Map<string, object>} [input.treasuryByDay]  financeTreasury.treasuryByDay (closed months: from the snapshot)
 */
export function computeWeeks({ today, fromDate, days = {}, usdPerEur, costsByMonth = new Map(), months = new Map(), rules, vpbOverride = null, records = [], treasuryByDay = new Map() }) {
  const warnings = [];
  const segments = weekSegments(fromDate, today);
  const rate = (date) => {
    const r = usdPerEur(date);
    return Number.isFinite(r) && r > 0 ? r : null;
  };
  const unpriced = [];

  // 1. Revenue, VAT and costs per segment.
  for (const seg of segments) {
    let revenueUsd = 0;
    let revenueEur = 0;
    let vatEur = 0;
    const vatByLane = {};
    for (let d = seg.start; d <= seg.end && d <= today; d = addDays(d, 1)) {
      const day = days[d];
      if (!day) continue;
      const r = rate(d);
      if (r == null) { warnings.push(`No EUR rate for ${d}.`); continue; }
      if (day.totalUsd == null) unpriced.push(d);
      const usd = (day.lanes || []).reduce((s, l) => s + (l.amountUsd ?? 0), 0);
      revenueUsd += usd;
      revenueEur += usd / r;
      const vat = vatOfLanes(day.lanes, rules, r);
      vatEur += vat.vatEur;
      for (const [k, v] of Object.entries(vat.byLane)) vatByLane[k] = (vatByLane[k] || 0) + v;
    }
    let costsUsd = 0;
    let costsEur = 0;
    for (const o of costsByMonth.get(seg.month) || []) {
      const share = o.recurring && o.recurring !== "none" ? seg.days / daysInMonth(seg.month) : (o.date >= seg.start && o.date <= seg.end ? 1 : 0);
      if (!share) continue;
      const r = Number(o.eurUsdRate) > 0 ? Number(o.eurUsdRate) : rate(o.date) ?? rate(seg.end);
      costsUsd += o.amountUsd * share;
      costsEur += r ? (o.amountUsd * share) / r : 0;
    }
    let treasuryEur = 0;
    let realizedGainEur = 0;
    let treasuryFeesEur = 0;
    let otherRevenueEur = 0;
    let otherVatEur = 0;
    for (const [d, t] of treasuryByDay) {
      if (d < seg.start || d > seg.end || d > today) continue;
      treasuryEur += dayNetEur(t);
      realizedGainEur += t.realizedGainEur;
      treasuryFeesEur += t.feesEur;
      otherRevenueEur += t.otherRevenueEur;
      otherVatEur += t.otherVatEur;
    }
    Object.assign(seg, { revenueUsd, revenueEur, vatEur, vatByLane, costsUsd, costsEur, closeAdjustmentUsd: 0, treasuryEur, realizedGainEur, treasuryFeesEur, otherRevenueEur, otherVatEur });
  }
  if (unpriced.length) warnings.push(`Some revenue could not be priced in USD on ${[...new Set(unpriced)].slice(0, 10).join(", ")}; it is counted as 0 there.`);

  // 2. Closed months: the snapshot is the truth. Book the difference between the
  //    snapshot revenue and the live days on the month's last segment.
  for (const [month, m] of months) {
    if (m.status !== "closed" || m.revenueUsd == null) continue;
    const segs = segments.filter((s) => s.month === month);
    if (!segs.length) continue;
    const live = segs.reduce((s, x) => s + x.revenueUsd, 0);
    const diff = m.revenueUsd - live;
    if (Math.abs(diff) < 0.005) continue;
    const last = segs[segs.length - 1];
    const r = rate(last.end);
    const vatRatio = live > 0 ? segs.reduce((s, x) => s + x.vatEur, 0) / segs.reduce((s, x) => s + x.revenueEur, 0) : 0;
    last.closeAdjustmentUsd = diff;
    last.revenueUsd += diff;
    if (r) {
      last.revenueEur += diff / r;
      last.vatEur += (diff / r) * vatRatio;
    }
  }

  // 3. Corporate tax per segment, year by year, with loss carry-forward.
  const lossRule = rules.vpb.lossCarryForward;
  let year = null;
  let ytd = 0;
  let pool = 0;
  let yearReserve = 0;
  const yearSummaries = [];
  const closeYear = () => {
    if (year == null) return;
    const used = ytd > 0 ? ytd - taxableAfterLoss(ytd, pool, lossRule) : 0;
    yearSummaries.push({ year, profitEur: round2(ytd), lossUsedEur: round2(used), lossCarriedInEur: round2(pool), reserveEur: round2(yearReserve), lossCarriedOutEur: round2(Math.max(0, pool - used + Math.max(0, -ytd))) });
    pool = Math.max(0, pool - used + Math.max(0, -ytd));
  };
  for (const seg of segments) {
    if (seg.year !== year) {
      closeYear();
      year = seg.year;
      ytd = 0;
      yearReserve = 0;
    }
    const brackets = vpbYear(rules, seg.year, vpbOverride);
    if (brackets.fallback) warnings.push(`No corporate tax brackets for ${seg.year}; the ${brackets.fallbackFrom} brackets are used.`);
    seg.profitEur = seg.revenueEur - seg.vatEur - seg.costsEur + seg.treasuryEur;
    seg.profitUsd = seg.revenueUsd - seg.costsUsd - seg.vatEur * (rate(seg.end) || 0) + seg.treasuryEur * (rate(seg.end) || 0);
    const before = bracketTax(taxableAfterLoss(ytd, pool, lossRule), brackets.brackets);
    ytd += seg.profitEur;
    const after = bracketTax(taxableAfterLoss(ytd, pool, lossRule), brackets.brackets);
    seg.vpbEur = after - before;
    seg.ytdProfitEur = ytd;
    seg.lossPoolEur = pool;
    yearReserve += seg.vpbEur;
  }
  closeYear();

  // 4. Weeks: sum the segments, then the carry-over over complete weeks.
  const distributedByWeek = new Map();
  for (const rec of records) {
    if (!COUNTED_STATUSES.includes(rec.status)) continue;
    distributedByWeek.set(rec.week, (distributedByWeek.get(rec.week) || 0) + Number(rec.totalGrossEur || 0));
  }
  const weeks = [];
  const byWeek = new Map();
  for (const seg of segments) {
    let w = byWeek.get(seg.week);
    if (!w) {
      w = { week: seg.week, start: seg.weekStart, end: seg.weekEnd, status: seg.weekEnd < today ? "complete" : "in_progress", segments: [], revenueUsd: 0, revenueEur: 0, vatEur: 0, costsUsd: 0, costsEur: 0, profitEur: 0, profitUsd: 0, vpbEur: 0, closeAdjustmentUsd: 0, treasuryEur: 0, realizedGainEur: 0, treasuryFeesEur: 0, otherRevenueEur: 0, otherVatEur: 0 };
      byWeek.set(seg.week, w);
      weeks.push(w);
    }
    w.segments.push(seg);
    for (const k of ["revenueUsd", "revenueEur", "vatEur", "costsUsd", "costsEur", "profitEur", "profitUsd", "vpbEur", "closeAdjustmentUsd", "treasuryEur", "realizedGainEur", "treasuryFeesEur", "otherRevenueEur", "otherVatEur"]) w[k] += seg[k];
  }
  let carry = 0;
  for (const w of weeks) {
    w.profitAfterTaxEur = w.profitEur - w.vpbEur;
    w.carryInEur = carry;
    w.distributedEur = distributedByWeek.get(w.week) || 0;
    if (w.status === "complete") {
      w.entitlementEur = carry + w.profitAfterTaxEur;
      w.distributableEur = Math.max(0, w.entitlementEur - w.distributedEur);
      carry = w.entitlementEur - w.distributedEur;
    } else {
      w.entitlementEur = null;
      w.distributableEur = null;
    }
    w.carryOutEur = w.status === "complete" ? carry : null;
  }

  const sum = (key) => segments.reduce((s, x) => s + x[key], 0);
  return { segments, weeks, years: yearSummaries, totals: { vpbEur: yearSummaries.reduce((s, y) => s + Math.max(0, y.reserveEur), 0), vatEur: sum("vatEur") + sum("otherVatEur"), realizedGainEur: sum("realizedGainEur") }, warnings: [...new Set(warnings)] };
}

/** Weeks vs the monthly close, per month: revenue and costs (USD) must match. */
export function reconcileMonths(model, months, today) {
  const out = [];
  for (const [month, m] of months) {
    const segs = model.segments.filter((s) => s.month === month);
    if (!segs.length) continue;
    const weeksRevenueUsd = segs.reduce((s, x) => s + x.revenueUsd, 0);
    const weeksCostsUsd = segs.reduce((s, x) => s + x.costsUsd, 0);
    const complete = segs[segs.length - 1].end === `${month}-${String(daysInMonth(month)).padStart(2, "0")}` && month < today.slice(0, 7);
    const revenueDiff = m.revenueUsd == null ? null : round2(weeksRevenueUsd - m.revenueUsd);
    const costsDiff = m.costsUsd == null ? null : round2(weeksCostsUsd - m.costsUsd);
    out.push({
      month,
      status: m.status,
      complete,
      weeks: [...new Set(segs.map((s) => s.week))],
      weeksRevenueUsd: round2(weeksRevenueUsd),
      monthRevenueUsd: m.revenueUsd == null ? null : round2(m.revenueUsd),
      revenueDiffUsd: revenueDiff,
      weeksCostsUsd: round2(weeksCostsUsd),
      monthCostsUsd: m.costsUsd == null ? null : round2(m.costsUsd),
      costsDiffUsd: costsDiff,
      reconciled: complete ? Math.abs(revenueDiff ?? 1) <= 0.05 && Math.abs(costsDiff ?? 1) <= 0.05 : null,
    });
  }
  return out;
}

/**
 * What can be divided now (through the last complete week) and what each
 * shareholder receives. Cash is what the multisig holds now.
 * @param {object} input
 * @param {object} input.model         computeWeeks output
 * @param {object[]} input.chains      currentBalances().chains (multisig per chain)
 * @param {number|null} input.openCostsUsd
 * @param {number|null} input.usdPerEurNow
 * @param {object} input.settings      effective distribution settings
 * @param {object} input.rules         effective tax rule set
 * @param {object[]} input.records     recorded distributions
 * @param {string} input.today
 * @param {number|null} [input.operatorUsd]   the buffer (never distributed), for the liquidity check
 * @param {number} [input.monthlyCostsUsd]   recurring costs per month, for the liquidity check
 * @param {{vpbEur:number, vatEur:number, dividendTaxEur:number}|null} [input.held]  tax still to pay (financeTaxCalendar); null = every reserve held
 * @param {number} [input.offChainCashEur]  fiat and stablecoins on bank and exchange accounts
 */
export function decideWeek({ model, chains = [], openCostsUsd, usdPerEurNow, settings, rules, records = [], today, operatorUsd = null, monthlyCostsUsd = 0, held = null, offChainCashEur = 0 }) {
  const blockers = [];
  const decision = [...model.weeks].reverse().find((w) => w.status === "complete") || null;
  if (!decision) blockers.push("No complete week yet.");
  if (!(usdPerEurNow > 0)) blockers.push("No EUR rate for today.");
  const multisigKnown = chains.length > 0 && chains.every((c) => c.multisigUsd != null && c.multisigRaw != null);
  if (!multisigKnown) blockers.push("The multisig balance could not be read on every chain.");
  if (openCostsUsd == null) blockers.push("Open costs could not be read.");

  // Reserves the multisig must keep.
  const withheldUnpaidEur = records.filter((r) => COUNTED_STATUSES.includes(r.status) && !r.dividendTaxPaidOn).reduce((s, r) => s + Number(r.totalWithholdingEur || 0), 0);
  const approvedUnpaidEur = records.filter((r) => r.status === "approved").reduce((s, r) => s + Number(r.totalNetEur || 0), 0);
  const reserved = { vpbEur: round2(model.totals.vpbEur), vatEur: round2(model.totals.vatEur), dividendTaxEur: round2(withheldUnpaidEur) };
  const reserves = held
    ? { vpbEur: round2(held.vpbEur), vatEur: round2(held.vatEur), dividendTaxEur: round2(held.dividendTaxEur), approvedNotPaidEur: round2(approvedUnpaidEur) }
    : { ...reserved, approvedNotPaidEur: round2(approvedUnpaidEur) };
  reserves.reservedEur = reserved;
  reserves.releasedByPaymentsEur = round2(reserved.vpbEur + reserved.vatEur + reserved.dividendTaxEur - (reserves.vpbEur + reserves.vatEur + reserves.dividendTaxEur));
  const reservesHeldEur = reserves.vpbEur + reserves.vatEur + reserves.dividendTaxEur;
  const offChainEur = Math.max(0, Number(offChainCashEur) || 0);

  const multisigUsd = multisigKnown ? chains.reduce((s, c) => s + c.multisigUsd, 0) : null;
  const multisigEur = multisigUsd != null && usdPerEurNow > 0 ? multisigUsd / usdPerEurNow : null;
  const openCostsEur = openCostsUsd != null && usdPerEurNow > 0 ? openCostsUsd / usdPerEurNow : null;
  // Bank and exchange cash pays reserves and open costs first; the multisig holds the rest.
  const mustHoldEur = openCostsEur != null ? openCostsEur + reservesHeldEur + reserves.approvedNotPaidEur : null;
  const coveredOffChainEur = mustHoldEur != null ? Math.min(offChainEur, mustHoldEur) : 0;
  const cashCapEur = multisigEur != null && mustHoldEur != null ? multisigEur - (mustHoldEur - coveredOffChainEur) : null;
  const alreadyThisWeek = decision ? records.filter((r) => r.week === decision.week && r.status !== "cancelled") : [];
  const entitlementEur = decision ? decision.distributableEur : null;

  let availableEur = null;
  let cappedBy = null;
  if (!blockers.length) {
    const cap = Math.max(0, cashCapEur);
    availableEur = floorCents(Math.max(0, Math.min(entitlementEur, cap)));
    cappedBy = entitlementEur <= 0 ? "profit" : cap < entitlementEur ? "cash" : "profit";
  }
  const carryOverEur = availableEur == null ? null : Math.max(0, entitlementEur - availableEur);
  const availableUsd = availableEur == null ? null : floorCents(availableEur * usdPerEurNow);

  // Per shareholder: withholding from the rules (or the override), per chain from the multisig.
  const resolved = settings.shares.map((share) => ({ share, w: withholdingFor(share, rules) }));
  const perChain = availableUsd == null
    ? null
    : computeDistribution({ chains, taxReserveUsd: 0, openCostsUsd: 0, settings: { shares: resolved.map(({ share, w }) => ({ ...share, withholdingPct: Math.round(w.rate * 10000) / 100 })) }, distributableUsdOverride: availableUsd });
  const shares = resolved.map(({ share, w }, i) => {
    const grossEur = availableEur == null ? null : floorCents((availableEur * share.bps) / 10000);
    const withholdingEur = grossEur == null ? null : floorCents(grossEur * w.rate);
    const usd = perChain?.shares?.[i];
    return {
      id: share.id,
      name: share.name,
      entity: share.entity,
      entityType: w.entityType,
      entityLabel: w.entityLabel,
      bps: share.bps,
      percent: share.bps / 100,
      grossEur,
      withholdingRate: w.rate,
      withholdingEur,
      netEur: grossEur == null ? null : round2(grossEur - withholdingEur),
      grossUsd: usd?.amountUsd ?? null,
      withholdingUsd: usd?.withholdingUsd ?? null,
      netUsd: usd?.netUsd ?? null,
      perChain: usd?.perChain ?? [],
      withholding: { reason: w.reason, condition: w.condition, source: w.source, checkedOn: w.checkedOn, confidence: w.confidence, needsConfirmation: w.needsConfirmation, override: w.override, ruleRate: w.ruleRate, fallbackRate: w.fallbackRate },
      evmAddress: share.evmAddress,
      solanaAddress: share.solanaAddress,
    };
  });
  const totalWithholdingEur = round2(shares.reduce((s, x) => s + (x.withholdingEur || 0), 0));

  // Distribution test (art. 2:216 BW) inputs and the obligations a payout triggers.
  const freeReservesEur = decision ? decision.entitlementEur : null;
  const cashAfterUsd = multisigUsd != null && availableUsd != null ? multisigUsd - availableUsd : null;
  const liquidAfterEur = cashAfterUsd != null ? (cashAfterUsd + (operatorUsd || 0)) / usdPerEurNow + offChainEur - reservesHeldEur - (openCostsEur || 0) - reserves.approvedNotPaidEur : null;
  const monthlyCostsEur = usdPerEurNow > 0 ? monthlyCostsUsd / usdPerEurNow : 0;
  const filing = rules.filing;
  const payoutDate = today;
  const dueOn = addMonthsToDate(payoutDate, filing.returnDueMonths || 1);
  const usExempt = shares.some((s) => s.entityType === "us_corporation" && s.withholdingRate === 0 && (s.grossEur || 0) > 0);
  const obligations = [
    { key: "shareholder_resolution", text: "Shareholder resolution to distribute this amount (general meeting, or in writing with every shareholder's agreement, art. 2:216 lid 1 and 2:238 BW)." },
    { key: "board_approval", text: "Board approval of the resolution after the liquidity test, dated and signed (art. 2:216 lid 2 BW)." },
    totalWithholdingEur > 0
      ? { key: "dividend_tax_return", text: `Dividend tax return and payment of EUR ${totalWithholdingEur.toFixed(2)} by ${dueOn} (1 month after the dividend is made available, if paid on ${payoutDate}).`, dueOn, amountEur: totalWithholdingEur }
      : { key: "dividend_tax_return", text: "No dividend tax to withhold. No return needed for the Dutch holdings exempt under art. 4 lid 1, unless the Belastingdienst asks for one.", dueOn: null, amountEur: 0 },
    ...(usExempt ? [{ key: "us_exemption_notice", text: `Notification (opgaaf) of the exemption for the US corporation by ${dueOn} (art. 4 lid 11; a missed notice can bring a fine of up to EUR ${(filing.maxFineEur || 5278).toLocaleString("en-US")}). Keep its IRS Form 6166 and beneficial-owner statement.`, dueOn }] : []),
  ];
  const checklist = {
    balanceTest: {
      freeReservesEstimateEur: freeReservesEur == null ? null : round2(freeReservesEur),
      proposedEur: availableEur,
      passesOnEstimate: availableEur == null || freeReservesEur == null ? null : availableEur <= freeReservesEur + 0.005,
      note: "Estimate: profit after tax reserves since the start minus what was already distributed. The real test uses the BV's equity minus the reserves required by law or the articles (usually none for a small BV); confirm from the balance sheet.",
    },
    liquidityTest: {
      cashAfterPayoutUsd: cashAfterUsd == null ? null : round2(cashAfterUsd),
      bufferUsd: operatorUsd == null ? null : round2(operatorUsd),
      reservesHeldEur: round2(reservesHeldEur),
      openCostsEur: openCostsEur == null ? null : round2(openCostsEur),
      liquidAfterEur: liquidAfterEur == null ? null : round2(liquidAfterEur),
      monthlyCostsEur: round2(monthlyCostsEur),
      monthsOfCosts: liquidAfterEur != null && monthlyCostsEur > 0 ? Math.floor((liquidAfterEur / monthlyCostsEur) * 10) / 10 : null,
      note: "The board confirms the BV can keep paying its debts as they fall due after this payment, usually looking about 12 months ahead. Crypto prices can move fast: check the value of the multisig on the day.",
    },
  };

  let why;
  if (blockers.length) why = blockers.join(" ");
  else if (availableEur === 0 && entitlementEur <= 0) why = "Nothing to divide: profit after tax reserves since the last distribution is zero or negative.";
  else if (cappedBy === "cash") why = `Profit after tax reserves allows EUR ${round2(entitlementEur).toFixed(2)}, but the multisig holds only EUR ${round2(Math.max(0, cashCapEur)).toFixed(2)} after reserves and open costs; EUR ${round2(carryOverEur).toFixed(2)} carries over.`;
  else why = `Profit after tax reserves through ${decision.week}, plus carry-over, is EUR ${round2(entitlementEur).toFixed(2)}; the multisig covers it after reserves and open costs.`;

  return {
    week: decision?.week ?? null,
    weekStart: decision?.start ?? null,
    weekEnd: decision?.end ?? null,
    alreadyRecorded: alreadyThisWeek.map((r) => ({ id: r.id, status: r.status, totalGrossEur: r.totalGrossEur })),
    entitlementEur: entitlementEur == null ? null : round2(entitlementEur),
    multisigUsd: multisigUsd == null ? null : round2(multisigUsd),
    multisigEur: multisigEur == null ? null : round2(multisigEur),
    openCostsEur: openCostsEur == null ? null : round2(openCostsEur),
    reserves,
    offChainCashEur: round2(offChainEur),
    coveredOffChainEur: round2(coveredOffChainEur),
    cashCapEur: cashCapEur == null ? null : round2(cashCapEur),
    availableEur,
    availableUsd,
    cappedBy,
    carryOverEur: carryOverEur == null ? null : round2(carryOverEur),
    usdPerEur: usdPerEurNow ?? null,
    shares,
    totalWithholdingEur,
    checklist,
    obligations,
    why,
    blockers,
    distribution: perChain,
  };
}

/** Rounds a computeWeeks week for the API. */
export function weekView(w) {
  const r = (v) => (v == null ? null : round2(v));
  return {
    week: w.week,
    start: w.start,
    end: w.end,
    status: w.status,
    segments: w.segments.map((s) => ({ month: s.month, start: s.start, end: s.end, days: s.days, revenueUsd: r(s.revenueUsd), revenueEur: r(s.revenueEur), vatEur: r(s.vatEur), costsUsd: r(s.costsUsd), costsEur: r(s.costsEur), treasuryEur: r(s.treasuryEur), profitEur: r(s.profitEur), vpbEur: r(s.vpbEur), ytdProfitEur: r(s.ytdProfitEur), closeAdjustmentUsd: r(s.closeAdjustmentUsd) })),
    revenueEur: r(w.revenueEur),
    revenueUsd: r(w.revenueUsd),
    vatEur: r(w.vatEur),
    costsEur: r(w.costsEur),
    costsUsd: r(w.costsUsd),
    treasuryEur: r(w.treasuryEur),
    realizedGainEur: r(w.realizedGainEur),
    treasuryFeesEur: r(w.treasuryFeesEur),
    otherRevenueEur: r(w.otherRevenueEur),
    otherVatEur: r(w.otherVatEur),
    profitEur: r(w.profitEur),
    profitUsd: roundUsd(w.profitUsd) == null ? null : r(w.profitUsd),
    vpbEur: r(w.vpbEur),
    profitAfterTaxEur: r(w.profitAfterTaxEur),
    carryInEur: r(w.carryInEur),
    distributedEur: r(w.distributedEur),
    entitlementEur: r(w.entitlementEur),
    distributableEur: r(w.distributableEur),
    carryOutEur: r(w.carryOutEur),
    closeAdjustmentUsd: r(w.closeAdjustmentUsd),
  };
}

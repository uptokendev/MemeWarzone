// Tax items (returns, assessments, payments, refunds, notifications) and the
// obligations computed from the books: VAT per quarter, corporate tax (VPB) per
// year with its provisional instalments, dividend tax per paid distribution.
// Pure functions; the handler reads finance_tax_items and the weekly model.
//
// Reserve release (what the multisig still has to hold for tax):
//   VAT, per period:  held = max(0, (filed return amount, else the VAT reserved) - (paid - refunded))
//   VPB, per year:    held = max(0, (final assessment, else the VPB reserved) - (paid - refunded))
//   dividend tax, per distribution: held = max(0, withheld - paid)
// A return or final assessment replaces the estimate; a payment above it does
// not raise what can be divided (no negative hold).

import { FinanceInputError, isValidDate, round2 } from "./financeAccountingCosts.js";
import { addMonthsToDate } from "./financeTaxRules.js";

export const TAX_TYPES = Object.freeze(["vpb", "vat", "dividend_tax"]);
export const TAX_TYPE_LABELS = Object.freeze({ vpb: "Corporate income tax (VPB)", vat: "VAT (btw)", dividend_tax: "Dividend tax" });
export const TAX_ITEM_KINDS = Object.freeze(["provisional_assessment", "return_filed", "payment", "refund", "assessment_final", "notification_filed"]);
export const TAX_ITEM_KIND_LABELS = Object.freeze({
  provisional_assessment: "Provisional assessment received",
  return_filed: "Return filed",
  payment: "Payment",
  refund: "Refund received",
  assessment_final: "Final assessment received",
  notification_filed: "Notification filed (US exemption)",
});
export const UPCOMING_DAYS = 90;
const DAY_MS = 86_400_000;

const PERIOD = {
  vpb: /^\d{4}$/,
  vat: /^\d{4}-(Q[1-4]|0[1-9]|1[0-2])$/,
  dividend_tax: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/,
};
const FIELDS = ["taxType", "period", "kind", "amountEur", "dueOn", "doneOn", "accountId", "distributionId", "reference", "note"];

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const monthEndOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m: 1-12

/** Validates a tax item create (partial = false) or update (partial = true; type and period cannot change). */
export function validateTaxItemInput(body, { partial = false, today } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the tax item as a JSON object.");
  const unknown = Object.keys(body).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new FinanceInputError(`Unknown field: ${unknown[0]}.`, unknown[0]);
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const out = {};
  if (partial && (has("taxType") || has("period"))) throw new FinanceInputError("taxType and period cannot change; delete the item and record it again.", has("taxType") ? "taxType" : "period");
  if (!partial) {
    if (!TAX_TYPES.includes(body.taxType)) throw new FinanceInputError("taxType must be vpb, vat or dividend_tax.", "taxType");
    out.taxType = body.taxType;
    out.period = String(body.period || "").trim();
    if (!PERIOD[out.taxType].test(out.period)) throw new FinanceInputError({ vpb: "period must be a year (2026).", vat: "period must be a quarter (2026-Q3) or a month (2026-09).", dividend_tax: "period must be the distribution's ISO week (2026-W40)." }[out.taxType], "period");
  }
  if (!partial || has("kind")) {
    if (!TAX_ITEM_KINDS.includes(body.kind)) throw new FinanceInputError(`kind must be one of: ${TAX_ITEM_KINDS.join(", ")}.`, "kind");
    out.kind = body.kind;
  }
  if (!partial || has("amountEur")) {
    const n = Number(body.amountEur ?? 0);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new FinanceInputError("amountEur must be an amount in EUR of 0 or more.", "amountEur");
    out.amountEur = round2(n);
  }
  const date = (key, { required = false, notAfterToday = false } = {}) => {
    const v = body[key];
    if (v == null || v === "") {
      if (required) throw new FinanceInputError(`${key} is required (YYYY-MM-DD).`, key);
      return null;
    }
    if (!isValidDate(String(v))) throw new FinanceInputError(`${key} must be a date (YYYY-MM-DD).`, key);
    if (String(v) < "2024-01-01") throw new FinanceInputError(`${key} is before 2024-01-01.`, key);
    if (notAfterToday && today && String(v) > today) throw new FinanceInputError(`${key} is in the future.`, key);
    return String(v);
  };
  if (!partial || has("doneOn")) out.doneOn = date("doneOn", { required: true, notAfterToday: true });
  if (!partial || has("dueOn")) out.dueOn = date("dueOn");
  for (const key of ["accountId", "distributionId"]) {
    if (!partial || has(key)) {
      const v = body[key];
      if (v == null || v === "") out[key] = null;
      else if (!/^[1-9]\d{0,17}$/.test(String(v))) throw new FinanceInputError(`${key} must be an id.`, key);
      else out[key] = String(v);
    }
  }
  for (const [key, max] of [["reference", 120], ["note", 1000]]) {
    if (!partial || has(key)) {
      const v = body[key] == null ? "" : String(body[key]).trim();
      if (v.length > max) throw new FinanceInputError(`${key} is longer than ${max} characters.`, key);
      out[key] = v;
    }
  }
  if (partial && !Object.keys(out).length) throw new FinanceInputError("Nothing to change.");
  return out;
}

/** Checks an item as it will be stored (after merging an update). */
export function checkMergedTaxItem(item) {
  if (item.kind === "notification_filed" && item.taxType !== "dividend_tax") throw new FinanceInputError("A notification is only for dividend tax.", "kind");
  if (item.distributionId && item.taxType !== "dividend_tax") throw new FinanceInputError("distributionId is only for dividend tax.", "distributionId");
  if (item.accountId && item.kind !== "payment" && item.kind !== "refund") throw new FinanceInputError("accountId (paid from / refunded to) is only for a payment or refund.", "accountId");
  if (item.taxType === "vpb" && item.kind === "notification_filed") throw new FinanceInputError("No notification for corporate tax.", "kind");
}

// ------------------------------------------------------------------ periods

/** Quarter key of a date: 2026-08-14 -> 2026-Q3. */
export function quarterOf(date) {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

/** First and last day of a VAT period (2026-Q3 or 2026-09). */
export function vatPeriodBounds(period) {
  const y = Number(period.slice(0, 4));
  const q = /Q([1-4])$/.exec(period);
  if (q) {
    const first = (Number(q[1]) - 1) * 3 + 1;
    return { start: `${y}-${String(first).padStart(2, "0")}-01`, end: monthEndOf(y, first + 2) };
  }
  const m = Number(period.slice(5, 7));
  return { start: `${period}-01`, end: monthEndOf(y, m) };
}

/** VAT due: the last day of the month(s) after the period ends. */
export function vatDueOn(period, dueMonthsAfterPeriod = 1) {
  const { end } = vatPeriodBounds(period);
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7)) + dueMonthsAfterPeriod;
  return monthEndOf(y + Math.floor((m - 1) / 12), ((m - 1) % 12) + 1);
}

/**
 * Instalments of a provisional VPB assessment dated `dated` for `year`: one per
 * whole month left in the year after the month of the date, due at each
 * month end, all by 31 December. Less than 2 whole months left: one payment
 * within `shortWeeks` weeks. Dated after the year: one payment by `dueOn` (the
 * date printed on the assessment) or 2 months after the date.
 */
export function vpbInstalments({ year, dated, amountEur, dueOn = null, shortWeeks = 6 }) {
  const y = Number(dated.slice(0, 4));
  const month = Number(dated.slice(5, 7));
  if (y > year) return [{ n: 1, of: 1, dueOn: dueOn || addMonthsToDate(dated, 2), amountEur: round2(amountEur) }];
  if (y < year) return [{ n: 1, of: 1, dueOn: dueOn || `${year}-12-31`, amountEur: round2(amountEur) }];
  const left = 12 - month;
  if (left < 2) return [{ n: 1, of: 1, dueOn: dueOn || addDays(dated, shortWeeks * 7), amountEur: round2(amountEur) }];
  const each = Math.floor((amountEur / left) * 100) / 100;
  return Array.from({ length: left }, (_, i) => ({ n: i + 1, of: left, dueOn: monthEndOf(year, month + 1 + i), amountEur: i === left - 1 ? round2(amountEur - each * (left - 1)) : each }));
}

// ------------------------------------------------------------------ items per period

function itemsFor(items, taxType, period, distributionId = null) {
  return items.filter((t) => !t.deletedAt && t.taxType === taxType && t.period === period && (distributionId == null || !t.distributionId || String(t.distributionId) === String(distributionId)));
}

function latest(list, kind) {
  return list.filter((t) => t.kind === kind).sort((a, b) => (a.doneOn < b.doneOn ? 1 : a.doneOn > b.doneOn ? -1 : Number(b.id) - Number(a.id)))[0] || null;
}

function paidNet(list) {
  return round2(list.filter((t) => t.kind === "payment").reduce((s, t) => s + Number(t.amountEur), 0) - list.filter((t) => t.kind === "refund").reduce((s, t) => s + Number(t.amountEur), 0));
}

function statusOf({ filed, paidEnough, dueOn, today, needsFiling = true }) {
  if ((filed || !needsFiling) && paidEnough) return "paid";
  if (dueOn && dueOn < today) return "overdue";
  if (filed) return "filed";
  return "open";
}

// ------------------------------------------------------------------ obligations

/**
 * @param {object} input
 * @param {string} input.today
 * @param {object} input.rules            effective tax rule set
 * @param {Record<string, number>} input.vatByPeriod   VAT reserved per VAT period (EUR)
 * @param {Array<{year:number, reserveEur:number}>} input.vpbYears   VPB reserved per year (EUR)
 * @param {object[]} input.items          finance_tax_items (live and deleted)
 * @param {object[]} [input.records]      finance_distributions
 * @param {string|null} [input.firstActivityOn]
 */
export function taxObligations({ today, rules, vatByPeriod = {}, vpbYears = [], items = [], records = [], firstActivityOn = null }) {
  const cal = rules.calendar;
  const firstOn = cal.firstPeriodOn?.date || firstActivityOn || null;
  const obligations = [];
  const held = { vatEur: 0, vpbEur: 0, dividendTaxEur: 0, byPeriod: [] };
  const live = items.filter((t) => !t.deletedAt);

  // VAT
  const vatSource = { source: cal.vatPeriod.source, checkedOn: cal.vatPeriod.checkedOn, rule: cal.vatPeriod.condition };
  const vatPeriods = new Set([...Object.keys(vatByPeriod), ...live.filter((t) => t.taxType === "vat").map((t) => t.period)]);
  for (const period of [...vatPeriods].sort()) {
    const reserved = round2(vatByPeriod[period] || 0);
    const list = itemsFor(live, "vat", period);
    const filed = latest(list, "return_filed");
    const paid = paidNet(list);
    const dueAmount = filed ? Number(filed.amountEur) : reserved;
    const h = round2(Math.max(0, dueAmount - paid));
    held.vatEur += h;
    held.byPeriod.push({ taxType: "vat", period, reservedEur: reserved, filedEur: filed ? Number(filed.amountEur) : null, paidEur: paid, heldEur: h, releasedEur: round2(reserved - h) });
    const { start, end } = vatPeriodBounds(period);
    if (firstOn && end < firstOn) continue;
    if (end >= today && !list.length) continue; // the period is still running
    const dueOn = vatDueOn(period, cal.vatPeriod.dueMonthsAfterPeriod);
    obligations.push({
      key: `vat:${period}`, taxType: "vat", period, kind: "return_and_payment",
      title: `VAT return and payment ${period} (${start} to ${end})`,
      amountEur: round2(dueAmount), amountBasis: filed ? `Return filed on ${filed.doneOn}` : "VAT reserved on taxable revenue lanes in the period (estimate)",
      paidEur: paid, dueOn, filedOn: filed?.doneOn || null,
      status: statusOf({ filed: Boolean(filed), paidEnough: paid >= dueAmount - 0.005, dueOn, today }),
      ...vatSource,
    });
  }

  // VPB
  const prov = cal.vpbProvisional;
  const ret = cal.vpbReturn;
  const vpbList = new Map(vpbYears.map((y) => [String(y.year), Math.max(0, Number(y.reserveEur) || 0)]));
  for (const t of live.filter((x) => x.taxType === "vpb")) if (!vpbList.has(t.period)) vpbList.set(t.period, 0);
  const thisYear = Number(today.slice(0, 4));
  for (const [yearKey, reserve] of [...vpbList.entries()].sort()) {
    const year = Number(yearKey);
    const list = itemsFor(live, "vpb", yearKey);
    const final = latest(list, "assessment_final");
    const provisional = latest(list, "provisional_assessment");
    const filed = latest(list, "return_filed");
    const paid = paidNet(list);
    const basis = final ? Number(final.amountEur) : round2(reserve);
    const h = round2(Math.max(0, basis - paid));
    held.vpbEur += h;
    held.byPeriod.push({ taxType: "vpb", period: yearKey, reservedEur: round2(reserve), filedEur: final ? Number(final.amountEur) : null, paidEur: paid, heldEur: h, releasedEur: round2(reserve - h) });
    if (firstOn && `${year}-12-31` < firstOn) continue;
    const src = { source: prov.source, checkedOn: prov.checkedOn, rule: prov.condition };
    if (provisional) {
      const parts = vpbInstalments({ year, dated: provisional.doneOn, amountEur: Number(provisional.amountEur), dueOn: provisional.dueOn, shortWeeks: prov.shortRemainderWeeks });
      let cumulative = 0;
      for (const p of parts) {
        cumulative += p.amountEur;
        obligations.push({
          key: `vpb:${yearKey}:provisional:${p.n}`, taxType: "vpb", period: yearKey, kind: "provisional_instalment",
          title: parts.length > 1 ? `Corporate tax ${yearKey}: provisional instalment ${p.n} of ${p.of}` : `Corporate tax ${yearKey}: provisional assessment payment`,
          amountEur: p.amountEur, amountBasis: `Provisional assessment of EUR ${Number(provisional.amountEur).toFixed(2)} dated ${provisional.doneOn}${provisional.reference ? ` (${provisional.reference})` : ""}`,
          paidEur: round2(Math.min(p.amountEur, Math.max(0, paid - (cumulative - p.amountEur)))), dueOn: p.dueOn, filedOn: null,
          status: statusOf({ filed: false, paidEnough: paid >= cumulative - 0.005, dueOn: p.dueOn, today, needsFiling: false }), ...src,
        });
      }
    } else if (year <= thisYear && reserve > 0) {
      const dueOn = `${year + 1}-${prov.requestBeforeMonthDay}`;
      const before = addDays(dueOn, -1);
      obligations.push({
        key: `vpb:${yearKey}:request`, taxType: "vpb", period: yearKey, kind: "request_provisional",
        title: `Corporate tax ${yearKey}: ask for a provisional assessment (no tax interest if asked by ${before})`,
        amountEur: round2(reserve), amountBasis: "Corporate tax reserved for the year (estimate)", paidEur: paid, dueOn: before, filedOn: null,
        status: final || filed ? "filed" : before < today ? "overdue" : "open", optional: true, ...src,
      });
    }
    if (year < thisYear || filed || final) {
      const dueOn = addMonthsToDate(`${year + 1}-01-01`, ret.dueMonthsAfterYear);
      obligations.push({
        key: `vpb:${yearKey}:return`, taxType: "vpb", period: yearKey, kind: "return",
        title: `Corporate tax return ${yearKey}`,
        amountEur: round2(basis), amountBasis: final ? `Final assessment dated ${final.doneOn}` : filed ? `Return filed on ${filed.doneOn}; reserve until the final assessment` : "Corporate tax reserved for the year (estimate)",
        paidEur: paid, dueOn, filedOn: filed?.doneOn || null,
        status: final && paid >= basis - 0.005 ? "paid" : filed ? "filed" : dueOn < today ? "overdue" : "open",
        source: ret.source, checkedOn: ret.checkedOn, rule: ret.condition,
      });
    }
    if (final && final.dueOn && paid < basis - 0.005) {
      obligations.push({
        key: `vpb:${yearKey}:final`, taxType: "vpb", period: yearKey, kind: "final_payment",
        title: `Corporate tax ${yearKey}: pay the final assessment`, amountEur: round2(basis - paid), amountBasis: `Final assessment EUR ${basis.toFixed(2)} minus EUR ${paid.toFixed(2)} paid`,
        paidEur: paid, dueOn: final.dueOn, filedOn: final.doneOn, status: final.dueOn < today ? "overdue" : "open", source: ret.source, checkedOn: ret.checkedOn, rule: "Pay by the due date printed on the assessment.",
      });
    }
  }

  // Dividend tax, per distribution approved or paid.
  const filing = rules.filing;
  for (const r of records) {
    if (r.status !== "paid" && r.status !== "approved") continue;
    const list = itemsFor(live, "dividend_tax", r.week, r.id);
    const withheld = Number(r.totalWithholdingEur || 0);
    const paidItems = paidNet(list);
    const paid = paidItems > 0 ? paidItems : r.dividendTaxPaidOn ? withheld : 0;
    const filed = latest(list, "return_filed");
    const filedOn = filed?.doneOn || r.dividendTaxReturnFiledOn || null;
    const h = round2(Math.max(0, withheld - paid));
    held.dividendTaxEur += h;
    held.byPeriod.push({ taxType: "dividend_tax", period: r.week, reservedEur: withheld, filedEur: filed ? Number(filed.amountEur) : null, paidEur: round2(paid), heldEur: h, releasedEur: round2(withheld - h) });
    const base = r.availableOn || null;
    const dueOn = base ? addMonthsToDate(base, filing.returnDueMonths || 1) : r.dividendTaxDueOn;
    const src = { source: filing.source, checkedOn: filing.checkedOn, rule: filing.condition };
    if (withheld > 0) {
      obligations.push({
        key: `dividend:${r.id}:return`, taxType: "dividend_tax", period: r.week, distributionId: r.id, kind: "return_and_payment",
        title: `Dividend tax return and payment, distribution ${r.week}${base ? ` (made available ${base})` : ""}`,
        amountEur: withheld, amountBasis: "Dividend tax withheld on the distribution", paidEur: round2(paid), dueOn, filedOn,
        status: r.status === "approved" && !base ? "open" : statusOf({ filed: Boolean(filedOn), paidEnough: paid >= withheld - 0.005, dueOn, today }), ...src,
      });
    }
    const usExempt = (r.shares || []).some((s) => s.entityType === "us_corporation" && Number(s.withholdingEur || 0) === 0 && Number(s.grossEur || 0) > 0);
    if (usExempt && filing.notifyForForeignExemption) {
      const notified = latest(list, "notification_filed");
      const notifiedOn = notified?.doneOn || r.dividendTaxReturnFiledOn || null;
      obligations.push({
        key: `dividend:${r.id}:notice`, taxType: "dividend_tax", period: r.week, distributionId: r.id, kind: "us_exemption_notice",
        title: `Notification of the exemption for the US corporation, distribution ${r.week}`,
        amountEur: 0, amountBasis: `No tax; a missed notice can bring a fine of up to EUR ${(filing.maxFineEur || 5278).toLocaleString("en-US")}`, paidEur: 0, dueOn, filedOn: notifiedOn,
        status: notifiedOn ? "paid" : dueOn && dueOn < today ? "overdue" : "open", ...src,
      });
    }
  }

  const rank = { overdue: 0, open: 1, filed: 2, paid: 3 };
  obligations.sort((a, b) => (rank[a.status] - rank[b.status]) || String(a.dueOn || "9999").localeCompare(String(b.dueOn || "9999")));
  const horizon = addDays(today, UPCOMING_DAYS);
  const upcoming = obligations.filter((o) => o.status !== "paid" && o.dueOn && o.dueOn <= horizon).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const next = upcoming.find((o) => o.dueOn >= today) || upcoming[0] || null;
  return {
    obligations,
    upcoming,
    next,
    held: { vatEur: round2(held.vatEur), vpbEur: round2(held.vpbEur), dividendTaxEur: round2(held.dividendTaxEur), byPeriod: held.byPeriod },
    firstPeriodOn: firstOn,
  };
}

/** VAT reserved per VAT period from the weekly model's segments (fee revenue VAT + VAT in bank receipts). */
export function vatByPeriodFrom(segments, period = "quarter") {
  const out = {};
  const key = (date) => (period === "month" ? date.slice(0, 7) : quarterOf(date));
  for (const s of segments) out[key(s.start)] = (out[key(s.start)] || 0) + (s.vatEur || 0) + (s.otherVatEur || 0);
  for (const k of Object.keys(out)) out[k] = round2(out[k]);
  return out;
}

export const RESERVE_RELEASE_RULE = "Tax paid releases its reserve. VAT per period: held = (the filed return, else the VAT reserved) - (paid - refunded). Corporate tax per year: held = (the final assessment, else the reserve) - (paid - refunded). Dividend tax per distribution: held = withheld - paid. Never below zero.";

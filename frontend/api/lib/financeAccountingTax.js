// Tax reserve: a configurable bracket list, not hardcoded law. The default is
// the Dutch corporate income tax (vennootschapsbelasting) brackets in force
// for 2024-2026 (19% up to EUR 200,000 taxable profit, 25.8% above). The page
// labels them "Default rates; no adviser has confirmed these yet" and finance.manage
// can replace them. This is a reserve estimate, not tax advice.
//
// Method: profit is accumulated per calendar year. For month m, with the
// year-to-date profit P(m) and the rate r(m) (USD per 1 unit of the bracket
// currency), tax(m) = brackets(P(m) / r) * r. The month's reserve is
// tax(P(m)) - tax(P(m-1)), both at the same rate, so a loss month gives a
// negative reserve (it releases part of what was reserved). A negative year
// to date gives zero tax. No loss carry-over between years.

import { FinanceInputError, roundUsd } from "./financeAccountingCosts.js";

export const DEFAULT_TAX_RESERVE_RULES = Object.freeze({
  name: "Dutch corporate income tax (vennootschapsbelasting), 2024-2026 brackets",
  currency: "EUR",
  basis: "calendar_year_profit",
  brackets: Object.freeze([
    Object.freeze({ upTo: 200000, rate: 0.19 }),
    Object.freeze({ upTo: null, rate: 0.258 }),
  ]),
  note: "Default rates; no adviser has confirmed these yet. Estimate for a reserve, not tax advice.",
});

/** Validates rules from the settings form. Brackets ascending, the last one open ended. */
export function validateTaxRules(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the tax rules as a JSON object.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 160) throw new FinanceInputError("name is required (at most 160 characters).", "name");
  if (!["EUR", "USD"].includes(body.currency)) throw new FinanceInputError("currency must be EUR or USD.", "currency");
  const note = body.note == null ? "" : String(body.note).trim();
  if (note.length > 500) throw new FinanceInputError("note is longer than 500 characters.", "note");
  if (!Array.isArray(body.brackets) || body.brackets.length < 1 || body.brackets.length > 10) {
    throw new FinanceInputError("brackets must list 1 to 10 brackets.", "brackets");
  }
  let previous = 0;
  const brackets = body.brackets.map((bracket, index) => {
    const last = index === body.brackets.length - 1;
    const rate = Number(bracket?.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new FinanceInputError(`Bracket ${index + 1}: rate must be between 0 and 1 (0.19 = 19%).`, "brackets");
    if (last) {
      if (bracket?.upTo != null && bracket?.upTo !== "") throw new FinanceInputError("The last bracket has no upper limit (upTo empty).", "brackets");
      return { upTo: null, rate };
    }
    const upTo = Number(bracket?.upTo);
    if (!Number.isFinite(upTo) || upTo <= previous || upTo > 1e12) throw new FinanceInputError(`Bracket ${index + 1}: upTo must be higher than the bracket before it.`, "brackets");
    previous = upTo;
    return { upTo, rate };
  });
  return { name, currency: body.currency, basis: "calendar_year_profit", brackets, note };
}

/** Rules in use: stored rules or the default, with isDefault. */
export function effectiveTaxRules(stored) {
  if (stored && typeof stored === "object") {
    try {
      return { ...validateTaxRules(stored), isDefault: false };
    } catch {
      // A stored value that no longer validates falls back to the default, flagged.
      return { ...structuredClone(DEFAULT_TAX_RESERVE_RULES), isDefault: true, storedInvalid: true };
    }
  }
  return { ...structuredClone(DEFAULT_TAX_RESERVE_RULES), isDefault: true };
}

/** Tax on a taxable amount (in the bracket currency). Zero or negative profit: zero. */
export function bracketTax(profit, brackets) {
  if (!Number.isFinite(profit) || profit <= 0) return 0;
  let tax = 0;
  let lower = 0;
  for (const bracket of brackets) {
    const upper = bracket.upTo == null ? Infinity : bracket.upTo;
    if (profit <= lower) break;
    tax += (Math.min(profit, upper) - lower) * bracket.rate;
    lower = upper;
  }
  return tax;
}

/** Tax in USD on a USD profit, with r = USD per 1 unit of the bracket currency. */
export function taxUsd(profitUsd, rules, usdPerUnit) {
  const r = rules.currency === "USD" ? 1 : usdPerUnit;
  if (!Number.isFinite(r) || r <= 0) return null;
  return bracketTax(profitUsd / r, rules.brackets) * r;
}

/**
 * Reserve per month for one calendar year, in month order.
 * @param {Array<{month:string, profitUsd:number|null, usdPerEur:number|null, frozenReserveUsd?:number|null}>} months
 *   frozenReserveUsd: a closed month's reserve from its snapshot; used as is.
 */
export function taxReserveSchedule(months, rules) {
  let ytdProfit = 0;
  let ytdReserve = 0;
  let broken = false;
  const rows = months.map((m) => {
    const before = ytdProfit;
    if (m.profitUsd == null || broken) {
      broken = true;
      return { month: m.month, profitUsd: m.profitUsd, ytdProfitUsd: null, reserveUsd: null, ytdReserveUsd: null, frozen: m.frozenReserveUsd != null };
    }
    ytdProfit += m.profitUsd;
    let reserve;
    if (m.frozenReserveUsd != null) {
      reserve = m.frozenReserveUsd;
    } else {
      const now = taxUsd(ytdProfit, rules, m.usdPerEur);
      const prev = taxUsd(before, rules, m.usdPerEur);
      reserve = now == null || prev == null ? null : now - prev;
    }
    if (reserve == null) {
      broken = true;
      return { month: m.month, profitUsd: m.profitUsd, ytdProfitUsd: roundUsd(ytdProfit), reserveUsd: null, ytdReserveUsd: null, frozen: false };
    }
    ytdReserve += reserve;
    return { month: m.month, profitUsd: roundUsd(m.profitUsd), ytdProfitUsd: roundUsd(ytdProfit), reserveUsd: roundUsd(reserve), ytdReserveUsd: roundUsd(ytdReserve), frozen: m.frozenReserveUsd != null };
  });
  return { rows, ytdProfitUsd: broken ? null : roundUsd(ytdProfit), ytdReserveUsd: broken ? null : roundUsd(ytdReserve) };
}

/** What changed between two saved tax rule sets, in plain lines. `before` null = the defaults were in use. */
export function describeTaxChange(before, after) {
  const fmt = (rules) => (rules?.brackets || []).map((b) => `${Math.round(Number(b.rate) * 10000) / 100}%${b.upTo == null ? " above" : ` up to ${rules.currency || "EUR"} ${Number(b.upTo).toLocaleString("en-US")}`}`).join(", ");
  const lines = [];
  const prevText = before ? fmt(before) : "defaults";
  const nextText = fmt(after);
  if (prevText !== nextText) lines.push(`Brackets: ${prevText || "none"} -> ${nextText || "none"}`);
  if ((before?.name || "") !== (after?.name || "") && after?.name) lines.push(`Name: ${after.name}`);
  return lines.length ? lines : ["Saved without changes"];
}

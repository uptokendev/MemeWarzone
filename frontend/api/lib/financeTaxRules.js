// Dutch tax and distribution rules as data (founder 2026-10-05: "All rules,
// regulations and laws are findable on the web. For now we do not need an
// advisor ... If something needs to change we can do it afterwards.").
//
// Every rule carries its value, the condition it depends on, the official
// source it was read from, the date it was checked and a confidence level
// (high / medium / low). The page shows "Based on <source>, checked <date>"
// and marks every low-confidence rule "needs confirmation". finance.manage can
// change any value afterwards (PUT /api/admin/finance/tax-rules, audit logged).
// These are rules for a reserve and a distribution plan, not a tax filing.

import { FinanceInputError } from "./financeAccountingCosts.js";

export const RULES_CHECKED_ON = "2026-10-05";
export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);
export const ENTITY_TYPES = Object.freeze(["dutch_holding_bv", "us_corporation", "natural_person", "other"]);
export const ENTITY_TYPE_LABELS = Object.freeze({
  dutch_holding_bv: "Dutch holding BV",
  us_corporation: "US corporation",
  natural_person: "Natural person",
  other: "Other entity",
});

// VAT lanes: every revenue lane id (financeRevenueLanes.js) maps to one.
export const VAT_LANES = Object.freeze(["trading_fees", "graduation_fees", "upvotes", "arena_boosts", "battle_entries", "sponsorships", "home_placements", "dbc_referral", "other"]);
const LANE_ID_PREFIX = Object.freeze([
  ["bonding-route:", "trading_fees"],
  ["graduation-fee:", "graduation_fees"],
  ["upvotes:", "upvotes"],
  ["arena-boosts:", "arena_boosts"],
  ["arena-entries:", "battle_entries"],
  ["sponsorships:", "sponsorships"],
  ["home-placements:", "home_placements"],
  ["dbc-referral:", "dbc_referral"],
]);

/** The VAT lane of a revenue lane id ("bonding-route:101" -> trading_fees). */
export function vatLaneOf(laneId) {
  const id = String(laneId || "");
  return LANE_ID_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1] || "other";
}

const SRC = Object.freeze({
  vpbRates: "https://www.kvk.nl/geldzaken/vennootschapsbelasting/",
  vpbRates2026: "https://www.sra.nl/nieuws/004501/2025/09/nieuwe-belastingtarieven--kortingen-en-faciliteiten-2026",
  vpbLoss: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/vennootschapsbelasting/verrekenen_van_verliezen/verrekenen_van_verliezen",
  vpbInstalments: "https://www.belastingdienst.nl/wps/wcm/connect/nl/betalenenontvangen/content/in-termijnen-betalen",
  crypto: "https://www.kvk.nl/geldzaken/belasting-betalen-over-cryptos/",
  divLaw: "https://wetten.overheid.nl/BWBR0002515",
  divReturn: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/dividendbelasting/als_u_dividend_uitkeert/dividendbelasting-aangifte-betalen",
  divForeign: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/dividendbelasting/als_u_dividend_uitkeert/deelnemingsdividend-uitkeren-aan-aandeelhouder-buiten-nederland",
  divLob: "https://kennisgroepen.belastingdienst.nl/publicaties/kg02420254-inhoudingsvrijstelling-van-toepassing-wanneer-geen-recht-op-verdragsvoordelen-voor-het-dividend/",
  divNotify: "https://kennisgroepen.belastingdienst.nl/publicaties/kg02420237-inhoudingsvrijstelling-en-notificatieplicht/",
  treatyText: "https://wetten.overheid.nl/BWBV0002040",
  conditional: "https://zoek.officielebekendmakingen.nl/stcrt-2026-24065.pdf",
  bw216: "https://wetten.overheid.nl/BWBR0003045",
  vatB2c: "https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/afstandsverkopen-zoals-e-commerce-en-diensten-voor-particulieren-in-andere-eu-landen/diensten-aan-particulieren-binnen-eu/",
  hedqvist: "https://curia.europa.eu/juris/liste.jsf?num=C-264/14",
  participation: "https://wetten.overheid.nl/BWBR0002672",
  irc245a: "https://www.law.cornell.edu/uscode/text/26/245A",
});

const rule = (value, source, confidence, extra = {}) => ({ ...value, source, checkedOn: RULES_CHECKED_ON, confidence, ...extra });

// VAT conclusion (research 2026-10-05): every lane is most likely a taxable
// electronically supplied service. Users are anonymous wallets, so their
// country cannot be shown; the Belastingdienst may then treat the supply as
// Dutch. The cautious reserve is 21% of the fee as VAT included (21/121)
// on every lane except the Meteora referral (a business customer outside NL).
// The reserve stays in the multisig and can be released once location data or
// a ruling says otherwise.
export const DEFAULT_TAX_RULES = Object.freeze({
  version: 1,
  checkedOn: RULES_CHECKED_ON,
  note: "Researched from official sources on the web (no adviser). Any value can be changed afterwards on this page; every change is logged.",
  vpb: {
    years: {
      2025: rule({ brackets: [{ upTo: 200000, rate: 0.19 }, { upTo: null, rate: 0.258 }], condition: "Taxable profit of the calendar year (book year = calendar year), in EUR." }, SRC.vpbRates, "high"),
      2026: rule({ brackets: [{ upTo: 200000, rate: 0.19 }, { upTo: null, rate: 0.258 }], condition: "Taxable profit of the calendar year (book year = calendar year), in EUR. Unchanged from 2025." }, SRC.vpbRates2026, "high"),
    },
    lossCarryForward: rule({ fullOffsetUpToEur: 1000000, excessOffsetShare: 0.5, carryBackYears: 1, condition: "A loss is set off against later profits without a time limit (losses from 2022 on): in full up to EUR 1,000,000 taxable profit per year, and 50% of the profit above that (art. 20 Wet Vpb). A loss can also go back 1 year for a refund; this view does not count that refund in the reserve." }, SRC.vpbLoss, "high"),
    profitBasis: rule({ condition: "Crypto received as a fee is revenue at its EUR value on the day it is received (sound business practice). Held crypto stays on the books at cost or lower market value; a price rise is taxed only when the crypto is sold. Crypto is not treated as money, so there is no day-rate revaluation. Costs made for the business are deductible. This view books fees at the event-hour price and does not tax unrealised gains." }, SRC.crypto, "medium"),
    payment: rule({ belastingrente2026: 0.05, condition: "A provisional assessment (voorlopige aanslag) received during the year can be paid in monthly instalments, all paid by 31 December. The return is due 5 months after the book year ends (1 June), with a standard 5-month extension on request. Tax interest (belastingrente) for corporate tax is 5% from 2026; it runs from 1 July after the year unless the return is filed before 1 June or a provisional assessment is requested before 1 May. The reserve here stays in the multisig until it is paid." }, SRC.vpbInstalments, "high"),
  },
  dividendTax: rule({ rate: 0.15, condition: "Withheld by the BV on every dividend (including interim dividends) unless an exemption applies (art. 5 Wet op de dividendbelasting 1965)." }, SRC.divLaw, "high"),
  withholding: {
    dutch_holding_bv: rule({ exemptMinBps: 500, rateIfExempt: 0, rateOtherwise: 0.15, basis: "Exempt under art. 4 lid 1 Wet op de dividendbelasting 1965", condition: "The holding is a Dutch-resident company for which the participation exemption applies (at least 5% of the paid-up capital, shares part of its business) or a fiscal unity. No return is needed when this exemption covers the whole dividend, unless the Belastingdienst asks for one." }, SRC.divLaw, "high"),
    us_corporation: rule({ exemptMinBps: 500, rateIfExempt: 0, treatyMinBps: 1000, treatyRate: 0.05, rateOtherwise: 0.15, basis: "Exempt under art. 4 lid 2 Wet op de dividendbelasting 1965 (company in a treaty state with a dividend article)", condition: "The US corporation holds at least 5%, would qualify for the participation exemption if it were Dutch, is the beneficial owner, does not hold the shares mainly to avoid tax in an artificial arrangement, and is not comparable to a Dutch fiscal investment institution (art. 4 lid 2-4). The Belastingdienst knowledge group confirms this applies even if the treaty's limitation on benefits article would deny treaty benefits. The facts (substance of the US corporation) still need checking. If the exemption is refused: treaty rate 5% (company with at least 10% of the voting power, art. 10 NL-US treaty)." }, SRC.divLob, "medium"),
    natural_person: rule({ rate: 0.15, basis: "Standard rate", condition: "No exemption for individuals." }, SRC.divLaw, "high"),
    other: rule({ rate: 0.15, basis: "Standard rate until an exemption is shown", condition: "Check the entity and its residence country." }, SRC.divLaw, "low"),
  },
  conditionalWithholding: rule({ appliesToUs: false, condition: "The conditional withholding tax on dividends (from 2024) applies only to shareholders in low-tax jurisdictions on the Dutch list. The United States is not on the 2026 list (US Virgin Islands, American Samoa and Guam are)." }, SRC.conditional, "high"),
  filing: rule({ returnDueMonths: 1, returnWhenOnlyDutchExempt: false, notifyForForeignExemption: true, maxFineEur: 5278, condition: "Dividend tax withheld: file the return and pay within 1 month after the dividend is made available. Only Dutch holdings exempt under art. 4 lid 1: no return, unless the Belastingdienst asks. Foreign shareholder exempt under art. 4 lid 2 (the US corporation): an opgaaf (notification) is due within the same month (art. 4 lid 11); missing it does not cancel the exemption but can bring a fine of up to EUR 5,278. Keep: shareholder register, the resolutions, proof of US residence (IRS Form 6166), a beneficial-owner statement and evidence of the US corporation's substance." }, SRC.divNotify, "high"),
  distributionLaw: rule({ condition: "Art. 2:216 BW: the general meeting decides (unless the articles say otherwise); only free equity above statutory and article reserves can be paid out (balance test); the board must approve and refuses if it knows or should foresee the BV cannot keep paying its due debts after the payment (liquidity test). Directors are jointly liable for the shortfall if they knew or should have foreseen it; a shareholder who knew or should have known must repay. Interim distributions are allowed. There is no legal minimum interval, so weekly is possible if each payment has its own shareholder resolution (in writing is fine, art. 2:238) and a dated board approval with the liquidity test (usually looking about 12 months ahead)." }, SRC.bw216, "high"),
  vat: {
    standardRate: 0.21,
    condition: "Digital services to consumers in the EU are taxed where the consumer lives (Dutch VAT while cross-border EU consumer sales stay under EUR 10,000 a year, then OSS); consumers outside the EU: outside Dutch VAT; businesses: where the business is (reverse charge abroad, 21% for Dutch businesses). Users are anonymous wallets, so their country cannot be shown and the Belastingdienst may treat the supply as Dutch.",
    source: SRC.vatB2c,
    checkedOn: RULES_CHECKED_ON,
    confidence: "low",
    lanes: {
      trading_fees: rule({ treatment: "taxable", rate: 0.21, taxableShare: 1, reason: "Most likely a taxable electronically supplied service. The exemption for currency exchange (CJEU C-264/14 Hedqvist) needs a token used as a means of payment; memecoins are speculative tokens. No Dutch or EU guidance on launchpad fees exists. 21% reserved on the full fee because user location is unknown." }, SRC.hedqvist, "low"),
      graduation_fees: rule({ treatment: "taxable", rate: 0.21, taxableShare: 1, reason: "Part of the trading flow; same as trading fees." }, SRC.hedqvist, "low"),
      upvotes: rule({ treatment: "taxable", rate: 0.21, taxableShare: 1, reason: "Paid visibility (electronically supplied service). User location unknown, so 21% reserved." }, SRC.vatB2c, "low"),
      arena_boosts: rule({ treatment: "taxable", rate: 0.21, taxableShare: 1, reason: "Paid visibility in the arena (electronically supplied service). User location unknown, so 21% reserved." }, SRC.vatB2c, "low"),
      battle_entries: rule({ treatment: "uncertain", rate: 0.21, taxableShare: 1, reason: "Our cut of battle stakes: a service fee (taxable) or part of a game of chance. 21% reserved until confirmed." }, SRC.vatB2c, "low"),
      sponsorships: rule({ treatment: "taxable", rate: 0.21, taxableShare: 1, reason: "Advertising, mostly for businesses: reverse charge (no Dutch VAT) for EU businesses, outside scope outside the EU, 21% for Dutch businesses. Without the sponsor's VAT number and address, 21% reserved." }, SRC.vatB2c, "medium"),
      home_placements: rule({ treatment: "taxable", rate: 0.21, taxableShare: 1, reason: "Paid Home placement (advertising). Same as sponsorships." }, SRC.vatB2c, "medium"),
      dbc_referral: rule({ treatment: "outside_scope", rate: 0, taxableShare: 0, reason: "Referral fee paid by Meteora, a business outside the Netherlands: taxed where the customer is, so no Dutch VAT." }, SRC.vatB2c, "medium"),
      other: rule({ treatment: "uncertain", rate: 0.21, taxableShare: 1, reason: "Unknown lane: 21% reserved." }, SRC.vatB2c, "low"),
    },
  },
  holdingSide: {
    dutch_holding_bv: rule({ condition: "A Dutch holding BV with at least 5% receives the dividend tax-free under the participation exemption (art. 13 Wet Vpb 1969). Box 2 at personal level is out of scope here." }, SRC.participation, "high"),
    us_corporation: rule({ condition: "A US C corporation owning at least 10% can deduct 100% of the foreign-source part of the dividend (IRC 245A; shares held more than 365 days in the 731-day window). No foreign tax credit on a 245A dividend; if 245A does not apply, Dutch tax withheld can be credited (IRC 901). The BV is not a CFC (US owners hold 20%); PFIC could matter if the BV holds large passive crypto balances." }, SRC.irc245a, "medium"),
  },
});

// ------------------------------------------------------------------ validation

const MAX_TEXT = 1200;

/** Walks `body` along the default's shape: numbers stay numbers in range, text stays text, unknown keys are dropped. */
function conform(schema, value, path) {
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) throw new FinanceInputError(`${path} must be a list.`, path);
    return value;
  }
  if (schema && typeof schema === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinanceInputError(`${path} must be an object.`, path);
    const out = {};
    for (const key of Object.keys(schema)) {
      out[key] = key in value ? conform(schema[key], value[key], `${path}.${key}`) : structuredClone(schema[key]);
    }
    return out;
  }
  if (typeof schema === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new FinanceInputError(`${path} must be a number of 0 or more.`, path);
    if (/rate|Share$/i.test(path.split(".").pop()) && n > 1) throw new FinanceInputError(`${path} is a fraction between 0 and 1 (0.15 = 15%).`, path);
    return n;
  }
  if (typeof schema === "boolean") return value === true;
  if (typeof schema === "string") {
    const text = String(value ?? "").trim();
    if (text.length > MAX_TEXT) throw new FinanceInputError(`${path} is longer than ${MAX_TEXT} characters.`, path);
    if (path.endsWith(".confidence") && !CONFIDENCE.includes(text)) throw new FinanceInputError(`${path} must be high, medium or low.`, path);
    if (path.endsWith(".treatment") && !["exempt", "taxable", "outside_scope", "uncertain"].includes(text)) throw new FinanceInputError(`${path} must be exempt, taxable, outside_scope or uncertain.`, path);
    if (path.endsWith(".source") && text && !/^https:\/\//.test(text)) throw new FinanceInputError(`${path} must be an https link.`, path);
    if (path.endsWith("checkedOn") && text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new FinanceInputError(`${path} must be a date (YYYY-MM-DD).`, path);
    return text;
  }
  return value;
}

function checkBrackets(brackets, path) {
  if (!Array.isArray(brackets) || brackets.length < 1 || brackets.length > 10) throw new FinanceInputError(`${path} must list 1 to 10 brackets.`, path);
  let previous = 0;
  return brackets.map((b, i) => {
    const last = i === brackets.length - 1;
    const rate = Number(b?.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new FinanceInputError(`${path} bracket ${i + 1}: rate must be between 0 and 1.`, path);
    if (last) {
      if (b?.upTo != null && b?.upTo !== "") throw new FinanceInputError(`${path}: the last bracket has no upper limit.`, path);
      return { upTo: null, rate };
    }
    const upTo = Number(b?.upTo);
    if (!Number.isFinite(upTo) || upTo <= previous) throw new FinanceInputError(`${path} bracket ${i + 1}: upTo must be higher than the bracket before it.`, path);
    previous = upTo;
    return { upTo, rate };
  });
}

/** Validates a full or partial rule set from the settings form; missing parts keep the default. */
export function validateTaxRuleSet(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the rules as a JSON object.");
  const out = conform(DEFAULT_TAX_RULES, body, "rules");
  // Years are open ended: any year 2024-2100 may carry its own brackets.
  const years = {};
  const sourceYears = body.vpb?.years && typeof body.vpb.years === "object" ? body.vpb.years : DEFAULT_TAX_RULES.vpb.years;
  for (const [year, value] of Object.entries(sourceYears)) {
    if (!/^\d{4}$/.test(year) || Number(year) < 2024 || Number(year) > 2100) throw new FinanceInputError(`vpb.years.${year} is not a year.`, "vpb");
    const base = DEFAULT_TAX_RULES.vpb.years[year] || DEFAULT_TAX_RULES.vpb.years[2026];
    const merged = conform({ ...base, brackets: [] }, { ...base, ...value }, `rules.vpb.years.${year}`);
    years[year] = { ...merged, brackets: checkBrackets(value?.brackets ?? base.brackets, `vpb.years.${year}`) };
  }
  if (!Object.keys(years).length) throw new FinanceInputError("vpb.years needs at least one year.", "vpb");
  out.vpb.years = years;
  return out;
}

/** Rules in use: stored (validated) or the defaults, with isDefault. */
export function effectiveTaxRuleSet(stored) {
  if (stored && typeof stored === "object") {
    try {
      return { ...validateTaxRuleSet(stored), isDefault: false };
    } catch {
      return { ...structuredClone(DEFAULT_TAX_RULES), isDefault: true, storedInvalid: true };
    }
  }
  return { ...structuredClone(DEFAULT_TAX_RULES), isDefault: true };
}

/**
 * VPB brackets for a year: that year's, else the latest earlier year's (flagged
 * `fallback`), else the earliest year's. `override` = brackets saved on the
 * old tax-reserve form; they win for every year when present.
 */
export function vpbYear(rules, year, override = null) {
  if (override?.brackets?.length) return { year, brackets: override.brackets, source: "Saved on the Tax & Reserves form", checkedOn: null, confidence: "medium", fallback: false, override: true };
  const years = rules?.vpb?.years || DEFAULT_TAX_RULES.vpb.years;
  if (years[year]) return { year, ...years[year], fallback: false };
  const known = Object.keys(years).map(Number).sort((a, b) => a - b);
  const earlier = known.filter((y) => y < year).pop();
  const pick = earlier ?? known[0];
  return { year, ...years[pick], fallback: true, fallbackFrom: pick };
}

/** Infers the entity type from the free-text legal entity of older settings. */
export function inferEntityType(entity) {
  const text = String(entity || "").toLowerCase();
  if (/\b(us|usa|united states|american)\b/.test(text) && /(corp|inc|llc|company)/.test(text)) return "us_corporation";
  if (/(dutch|nederland|netherlands)/.test(text) && /(holding|\bbv\b|b\.v\.)/.test(text)) return "dutch_holding_bv";
  if (/(person|individual|natuurlijk)/.test(text)) return "natural_person";
  return "other";
}

/**
 * Withholding for one shareholder from the rules: rate (0..1), the reason in
 * plain words, the rule's source and confidence, and the fallback (treaty)
 * rate where one exists. A per-shareholder override (withholdingOverride true
 * with withholdingPct) wins and says so.
 */
export function withholdingFor(share, rules) {
  const type = ENTITY_TYPES.includes(share.entityType) ? share.entityType : inferEntityType(share.entity);
  const w = rules?.withholding?.[type] || DEFAULT_TAX_RULES.withholding[type];
  const pct = (r) => `${Math.round(r * 10000) / 100}%`;
  let result;
  if (type === "dutch_holding_bv" || type === "us_corporation") {
    const exempt = share.bps >= w.exemptMinBps;
    if (exempt) {
      result = { rate: w.rateIfExempt, reason: `${w.basis}: holds ${share.bps / 100}% (at least ${w.exemptMinBps / 100}%).` };
      if (type === "us_corporation") result.fallbackRate = share.bps >= w.treatyMinBps ? w.treatyRate : w.rateOtherwise;
    } else if (type === "us_corporation" && share.bps >= w.treatyMinBps) {
      result = { rate: w.treatyRate, reason: `NL-US treaty rate ${pct(w.treatyRate)} (holds ${share.bps / 100}%).` };
    } else {
      result = { rate: w.rateOtherwise, reason: `Holds ${share.bps / 100}%, below the ${w.exemptMinBps / 100}% needed for the exemption: ${pct(w.rateOtherwise)}.` };
    }
  } else {
    result = { rate: w.rate, reason: `${w.basis}: ${pct(w.rate)}.` };
  }
  const base = { entityType: type, entityLabel: ENTITY_TYPE_LABELS[type], condition: w.condition, source: w.source, checkedOn: w.checkedOn, confidence: w.confidence, needsConfirmation: w.confidence === "low" };
  if (share.withholdingOverride === true && Number.isFinite(Number(share.withholdingPct))) {
    const rate = Number(share.withholdingPct) / 100;
    return { ...base, rate, override: true, ruleRate: result.rate, reason: `Set by hand to ${pct(rate)} (the rules give ${pct(result.rate)}: ${result.reason})`, fallbackRate: result.fallbackRate ?? null };
  }
  return { ...base, rate: result.rate, override: false, ruleRate: result.rate, reason: result.reason, fallbackRate: result.fallbackRate ?? null };
}

/** Adds months to a date (YYYY-MM-DD), clamped to the month end: the dividend tax return due date. */
export function addMonthsToDate(date, months) {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Flat list of rules for the page: what, value, condition, source, checked, confidence. */
export function rulesTable(rules) {
  const pct = (r) => `${Math.round(r * 10000) / 100}%`;
  const rows = [];
  const push = (key, label, value, r) => rows.push({ key, label, value, condition: r.condition || r.reason || "", source: r.source, checkedOn: r.checkedOn, confidence: r.confidence, needsConfirmation: r.confidence === "low" });
  for (const [year, y] of Object.entries(rules.vpb.years)) push(`vpb.${year}`, `Corporate income tax ${year}`, y.brackets.map((b) => `${pct(b.rate)}${b.upTo == null ? " above" : ` up to EUR ${b.upTo.toLocaleString("en-US")}`}`).join(", "), y);
  const l = rules.vpb.lossCarryForward;
  push("vpb.loss", "Loss carry-forward", `Unlimited in time; full up to EUR ${l.fullOffsetUpToEur.toLocaleString("en-US")}, ${pct(l.excessOffsetShare)} above`, l);
  push("vpb.basis", "Profit of a BV paid in crypto", "EUR value at receipt; held crypto at cost", rules.vpb.profitBasis);
  push("vpb.payment", "When corporate tax is paid", "Provisional assessment, monthly instalments", rules.vpb.payment);
  push("div.rate", "Dividend withholding tax", pct(rules.dividendTax.rate), rules.dividendTax);
  for (const type of ENTITY_TYPES) {
    const w = rules.withholding[type];
    const value = w.rateIfExempt != null ? `${pct(w.rateIfExempt)} if at least ${w.exemptMinBps / 100}%${w.treatyRate != null ? `; treaty ${pct(w.treatyRate)} otherwise` : ""}` : pct(w.rate);
    push(`withholding.${type}`, `Withholding: ${ENTITY_TYPE_LABELS[type]}`, value, w);
  }
  push("div.conditional", "Conditional withholding tax", rules.conditionalWithholding.appliesToUs ? "Applies to the US" : "Does not apply to the US", rules.conditionalWithholding);
  push("div.filing", "Dividend tax return", `Within ${rules.filing.returnDueMonths} month after the dividend is made available; notification for the US exemption${rules.filing.returnWhenOnlyDutchExempt ? "; also when only Dutch holdings are paid" : ""}`, rules.filing);
  push("bw.216", "Distribution test (art. 2:216 BW)", "Balance test + board liquidity test, per distribution", rules.distributionLaw);
  for (const lane of VAT_LANES) {
    const v = rules.vat.lanes[lane];
    push(`vat.${lane}`, `VAT: ${lane.replaceAll("_", " ")}`, v.treatment === "exempt" || v.treatment === "outside_scope" ? `${v.treatment.replace("_", " ")} (0%)` : `${pct(v.rate)} on ${pct(v.taxableShare)} of the fee (${v.treatment})`, v);
  }
  for (const type of ["dutch_holding_bv", "us_corporation"]) push(`holding.${type}`, `On the shareholder's side: ${ENTITY_TYPE_LABELS[type]}`, "Informational", rules.holdingSide[type]);
  return rows;
}

/** What changed between two rule sets, in plain lines (rules table values). */
export function describeTaxRuleChange(before, after) {
  const prev = new Map(rulesTable(effectiveTaxRuleSet(before)).map((r) => [r.key, r]));
  const lines = [];
  for (const row of rulesTable(effectiveTaxRuleSet(after))) {
    const old = prev.get(row.key);
    if (!old) { lines.push(`${row.label}: ${row.value}`); continue; }
    if (old.value !== row.value) lines.push(`${row.label}: ${old.value} -> ${row.value}`);
    if (old.confidence !== row.confidence) lines.push(`${row.label} confidence: ${old.confidence} -> ${row.confidence}`);
    if (old.source !== row.source) lines.push(`${row.label} source: ${row.source}`);
  }
  return lines.length ? lines : ["Saved without changes"];
}

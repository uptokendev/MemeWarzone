// Costs entered in the Command Center: validation, USD conversion at entry,
// recurring expansion and totals. Pure functions plus the conversion, which
// takes the price module and the EUR source as arguments.
//
// Recurring costs are stored once and expanded when read (not generated as
// monthly rows). Why: there is no scheduler to run, nothing can be generated
// twice or missed, ending or correcting a subscription is one edit, and a
// closed month is not affected because its costs are frozen in the close
// snapshot. Each occurrence uses the amount and the rate fixed at entry.

export const COST_CATEGORIES = Object.freeze(["servers", "rpc_infra", "salaries_contractors", "marketing", "legal_accounting", "tools_software", "other"]);
export const COST_CATEGORY_LABELS = Object.freeze({
  servers: "Servers",
  rpc_infra: "RPC / infra",
  salaries_contractors: "Salaries / contractors",
  marketing: "Marketing",
  legal_accounting: "Legal / accounting",
  tools_software: "Tools / software",
  other: "Other",
});
export const COST_CURRENCIES = Object.freeze(["USD", "EUR", "SOL", "BNB", "ETH"]);
export const COST_RECURRING = Object.freeze(["none", "monthly", "yearly"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const AMOUNT_PATTERN = /^\d{1,13}(\.\d{1,18})?$/;
const MIN_DATE = "2024-01-01";
const DAY_MS = 86_400_000;

export class FinanceInputError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "FinanceInputError";
    this.field = field;
  }
}

export function roundUsd(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

export function round2(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export function todayIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function isValidDate(text) {
  if (typeof text !== "string" || !DATE_PATTERN.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export function isValidMonth(text) {
  return typeof text === "string" && MONTH_PATTERN.test(text);
}

export function monthOf(date) {
  return String(date).slice(0, 7);
}

export function addMonths(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to && out.length < 240; m = addMonths(m, 1)) out.push(m);
  return out;
}

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthStart(month) {
  return `${month}-01`;
}

export function monthEnd(month) {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

function text(value, field, { max, min = 0, required = false }) {
  if (value == null || value === "") {
    if (required) throw new FinanceInputError(`${field} is required.`, field);
    return "";
  }
  if (typeof value !== "string") throw new FinanceInputError(`${field} must be text.`, field);
  const trimmed = value.trim();
  if (trimmed.length < min || (required && !trimmed)) throw new FinanceInputError(`${field} is required.`, field);
  if (trimmed.length > max) throw new FinanceInputError(`${field} is longer than ${max} characters.`, field);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) throw new FinanceInputError(`${field} contains control characters.`, field);
  return trimmed;
}

function amountText(value, field = "amount") {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string" || !AMOUNT_PATTERN.test(raw.trim())) {
    throw new FinanceInputError(`${field} must be a positive number with at most 18 decimals.`, field);
  }
  const normalized = raw.trim().replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (!(Number(normalized) > 0)) throw new FinanceInputError(`${field} must be greater than zero.`, field);
  return normalized;
}

function dateField(value, field, nowMs) {
  if (!isValidDate(value)) throw new FinanceInputError(`${field} must be a date (YYYY-MM-DD).`, field);
  if (value < MIN_DATE) throw new FinanceInputError(`${field} is before ${MIN_DATE}.`, field);
  const limit = new Date(nowMs + 366 * DAY_MS).toISOString().slice(0, 10);
  if (value > limit) throw new FinanceInputError(`${field} is more than a year ahead.`, field);
  return value;
}

function enumField(value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new FinanceInputError(`${field} must be one of: ${allowed.join(", ")}.`, field);
  }
  return value;
}

function attachmentField(value) {
  if (value == null || value === "") return null;
  const url = text(value, "attachmentUrl", { max: 500 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new FinanceInputError("attachmentUrl must be an https link.", "attachmentUrl");
  }
  if (parsed.protocol !== "https:" || !url.startsWith("https://")) throw new FinanceInputError("attachmentUrl must be an https link.", "attachmentUrl");
  return url;
}

function manualRateField(value) {
  if (value == null || value === "") return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) throw new FinanceInputError("fxRate must be a positive number (USD per 1 unit).", "fxRate");
  return rate;
}

const FIELDS = ["incurredOn", "category", "vendor", "description", "amount", "currency", "recurring", "recurringUntil", "attachmentUrl", "fxRate"];

/**
 * Validates a create (partial = false) or update (partial = true) body.
 * Returns only the fields that were given, normalized.
 */
export function validateCostInput(body, { partial = false, nowMs = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the cost as a JSON object.");
  const unknown = Object.keys(body).filter((key) => !FIELDS.includes(key));
  if (unknown.length) throw new FinanceInputError(`Unknown field: ${unknown[0]}.`, unknown[0]);
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const out = {};
  if (!partial || has("incurredOn")) out.incurredOn = dateField(body.incurredOn, "incurredOn", nowMs);
  if (!partial || has("category")) out.category = enumField(body.category, COST_CATEGORIES, "category");
  if (!partial || has("vendor")) out.vendor = text(body.vendor, "vendor", { max: 120, min: 1, required: true });
  if (!partial || has("description")) out.description = text(body.description, "description", { max: 500 });
  if (!partial || has("amount")) out.amount = amountText(body.amount);
  if (!partial || has("currency")) out.currency = enumField(body.currency ?? (partial ? undefined : "USD"), COST_CURRENCIES, "currency");
  if (!partial || has("recurring")) out.recurring = enumField(body.recurring ?? (partial ? undefined : "none"), COST_RECURRING, "recurring");
  if (has("recurringUntil")) out.recurringUntil = body.recurringUntil == null || body.recurringUntil === "" ? null : dateField(body.recurringUntil, "recurringUntil", nowMs + 50 * 366 * DAY_MS);
  else if (!partial) out.recurringUntil = null;
  if (!partial || has("attachmentUrl")) out.attachmentUrl = attachmentField(body.attachmentUrl);
  if (has("fxRate")) out.fxRate = manualRateField(body.fxRate);
  if (partial && Object.keys(out).length === 0) throw new FinanceInputError("Nothing to change.");
  return out;
}

/** Checks the cost as it will be stored (after merging an update). */
export function checkMergedCost(cost) {
  if (cost.recurring === "none" && cost.recurringUntil) throw new FinanceInputError("recurringUntil only applies to a recurring cost.", "recurringUntil");
  if (cost.recurringUntil && cost.recurringUntil < cost.incurredOn) throw new FinanceInputError("recurringUntil is before incurredOn.", "recurringUntil");
  if (cost.currency === "USD" && cost.fxRate != null && cost.fxRate !== 1) throw new FinanceInputError("A USD cost has rate 1.", "fxRate");
}

const NOON_OFFSET_MS = 12 * 3_600_000;

/**
 * USD for a cost at entry. USD: rate 1. EUR: ECB reference rate for the date.
 * SOL/BNB/ETH: Binance 1h close at 12:00 UTC on the date when it is in the
 * past, spot otherwise. A manual rate wins. eur_usd_rate is read for every
 * currency (best effort) so EUR can be shown in exports.
 */
export async function quoteCost({ amount, currency, incurredOn, manualRate = null, actorEmail = "", prices, fx, nowMs = Date.now() }) {
  const native = Number(amount);
  const eur = await fx.rate(incurredOn).catch(() => null);
  let rate = null;
  let source = null;
  let at = null;
  if (currency === "USD") {
    rate = 1;
    source = "USD";
  } else if (manualRate != null) {
    rate = manualRate;
    source = `manual rate entered by ${actorEmail || "a finance manager"}`;
    at = new Date(nowMs).toISOString();
  } else if (currency === "EUR") {
    if (eur) {
      rate = eur.usdPerEur;
      source = eur.source;
      at = eur.date ? `${eur.date}T00:00:00.000Z` : null;
    }
  } else {
    const noon = Date.parse(`${incurredOn}T00:00:00Z`) + NOON_OFFSET_MS;
    if (noon + 3_600_000 <= nowMs && typeof prices.hourly === "function") {
      const closes = await prices.hourly(currency, [noon]).catch(() => new Map());
      const close = closes.get(noon);
      if (close) {
        rate = close;
        source = `Binance ${currency}USDT 1h close at ${incurredOn} 12:00 UTC`;
        at = new Date(noon).toISOString();
      }
    }
    if (rate == null) {
      const spot = await prices.spot(currency).catch(() => null);
      if (spot?.priceUsd) {
        rate = spot.priceUsd;
        source = `${spot.source} at entry`;
        at = spot.at || new Date(nowMs).toISOString();
      }
    }
  }
  if (rate == null) {
    throw new FinanceInputError(`No ${currency}/USD rate is available right now. Enter the rate by hand (fxRate, USD per 1 ${currency}).`, "fxRate");
  }
  return {
    amountUsd: roundUsd(native * rate),
    fxRate: rate,
    fxSource: source,
    fxAt: at,
    eurUsdRate: eur?.usdPerEur ?? null,
    eurUsdDate: eur?.date ?? null,
  };
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // pg returns DATE as a local-midnight Date; rebuild the calendar date.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function decimalOut(value) {
  if (value == null) return null;
  const textValue = String(value);
  return textValue.includes(".") ? textValue.replace(/0+$/, "").replace(/\.$/, "") : textValue;
}

/** DB row -> API shape. */
export function costFromRow(row) {
  return {
    id: String(row.id),
    incurredOn: dateOnly(row.incurred_on),
    category: row.category,
    vendor: row.vendor,
    description: row.description || "",
    amount: decimalOut(row.amount),
    currency: row.currency,
    amountUsd: Number(row.amount_usd),
    fxRate: Number(row.fx_rate),
    fxSource: row.fx_source,
    fxAt: iso(row.fx_at),
    eurUsdRate: row.eur_usd_rate == null ? null : Number(row.eur_usd_rate),
    eurUsdDate: dateOnly(row.eur_usd_date),
    recurring: row.recurring,
    recurringUntil: dateOnly(row.recurring_until),
    attachmentUrl: row.attachment_url || null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by || null,
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by || null,
  };
}

function occurrenceDate(month, day) {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

/**
 * Occurrences of a cost within [fromMonth, toMonth]. A one-off cost has one
 * occurrence on its date. Monthly: every month from incurredOn, same day
 * (clamped to the month's last day). Yearly: the same month every year.
 * recurringUntil ends it (inclusive); onOrBefore (a date) drops later ones.
 */
export function expandCost(cost, fromMonth, toMonth, { onOrBefore = null } = {}) {
  if (cost.deletedAt) return [];
  const base = {
    costId: cost.id,
    category: cost.category,
    vendor: cost.vendor,
    description: cost.description,
    amount: cost.amount,
    currency: cost.currency,
    amountUsd: cost.amountUsd,
    fxRate: cost.fxRate,
    fxSource: cost.fxSource,
    eurUsdRate: cost.eurUsdRate,
    recurring: cost.recurring,
  };
  const keep = (date) => date >= monthStart(fromMonth) && date <= monthEnd(toMonth)
    && (!cost.recurringUntil || date <= cost.recurringUntil)
    && (!onOrBefore || date <= onOrBefore);
  if (cost.recurring === "none") return keep(cost.incurredOn) ? [{ ...base, date: cost.incurredOn, month: monthOf(cost.incurredOn) }] : [];
  const day = Number(cost.incurredOn.slice(8, 10));
  const startMonth = monthOf(cost.incurredOn);
  const step = cost.recurring === "yearly" ? 12 : 1;
  const out = [];
  let month = startMonth;
  if (month < fromMonth) {
    const behind = monthRange(startMonth, addMonths(fromMonth, -1)).length;
    month = addMonths(startMonth, Math.ceil(behind / step) * step);
  }
  for (; month <= toMonth && out.length < 600; month = addMonths(month, step)) {
    const date = occurrenceDate(month, day);
    if (keep(date)) out.push({ ...base, date, month });
  }
  return out;
}

/** Totals of occurrences: USD overall, per category and per month. */
export function costTotals(occurrences, months = []) {
  const byCategory = Object.fromEntries(COST_CATEGORIES.map((c) => [c, 0]));
  const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
  let total = 0;
  for (const o of occurrences) {
    total += o.amountUsd;
    byCategory[o.category] = (byCategory[o.category] || 0) + o.amountUsd;
    byMonth[o.month] = (byMonth[o.month] || 0) + o.amountUsd;
  }
  const r = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, roundUsd(v)]));
  return { totalUsd: roundUsd(total), byCategory: r(byCategory), byMonth: r(byMonth), count: occurrences.length };
}

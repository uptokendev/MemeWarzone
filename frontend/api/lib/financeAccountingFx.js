// USD/EUR for the accounting pages. There was no EUR source in the repo, so
// this reads the ECB euro foreign exchange reference rates (public, no key):
// https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml holds the
// last ~90 business days, newest first, as USD per 1 EUR. Read with a plain
// GET at most every 6 hours; every rate read is kept in finance_fx_daily
// (financePriceStore.js), so a new API process reads the table instead of the
// ECB and the history grows past the file's 90 days. A date without a rate (weekend, ECB
// holiday) uses the latest earlier business day; a date older than the file
// uses the oldest rate in it and says so. FINANCE_EUR_USD_RATE overrides
// everything (operator setting, e.g. when the ECB cannot be reached).
//
// The rate used is stored on every cost row (fx_rate, fx_source, eur_usd_rate)
// so a figure never changes after entry.

import { createFxStore } from "./financePriceStore.js";

const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const CACHE_TTL_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 6000;

/** Parses the ECB XML into [{date:'YYYY-MM-DD', usdPerEur:number}] newest first. */
export function parseEcbUsdRates(xml) {
  const out = [];
  const text = String(xml || "");
  const dayPattern = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>([\s\S]*?)<\/Cube>/g;
  let match;
  while ((match = dayPattern.exec(text)) !== null) {
    const usd = /<Cube\s+currency=["']USD["']\s+rate=["']([0-9.]+)["']/.exec(match[2]);
    const rate = usd ? Number(usd[1]) : NaN;
    if (Number.isFinite(rate) && rate > 0) out.push({ date: match[1], usdPerEur: rate });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** The rate for a date from parsed rows (newest first): that day, else the latest earlier day. */
export function pickRate(rows, date) {
  if (!rows.length) return null;
  if (!date) return { ...rows[0], exact: true, beforeRange: false };
  const hit = rows.find((row) => row.date <= date);
  if (hit) return { ...hit, exact: hit.date === date, beforeRange: false };
  return { ...rows[rows.length - 1], exact: false, beforeRange: true };
}

function overrideRate(env) {
  const raw = String(env.FINANCE_EUR_USD_RATE ?? "").trim();
  if (!raw) return null;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 && rate < 10 ? rate : null;
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.nowMs]
 * @param {Record<string,string>} [options.env]
 */
/** Stored rows and fetched rows together, one per date (the fetched rate wins), newest first. */
export function mergeRates(stored, fetched) {
  const byDate = new Map();
  for (const row of stored || []) byDate.set(row.date, row);
  for (const row of fetched || []) byDate.set(row.date, row);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * @param {{load: Function, save: Function}} [options.store]  finance_fx_daily (financePriceStore.js):
 *        rates fetched within 6 hours are read from it instead of the ECB, and every fetched file is kept,
 *        so the history grows past the ECB's 90 days.
 */
export function createEurUsdSource({ fetchImpl = fetch, nowMs = () => Date.now(), env = process.env, store = null } = {}) {
  let cache = null;
  let pending = null;

  async function load() {
    if (cache && nowMs() - cache.at < CACHE_TTL_MS) return cache.rows;
    pending ||= loadFresh().finally(() => { pending = null; });
    return pending;
  }

  async function loadFresh() {
    const stored = store ? await store.load().catch(() => null) : null;
    if (stored?.rows?.length && nowMs() - stored.fetchedAt < CACHE_TTL_MS) {
      cache = { at: stored.fetchedAt, rows: stored.rows };
      return stored.rows;
    }
    const fallback = () => cache?.rows || stored?.rows || [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(ECB_URL, { method: "GET", signal: controller.signal, headers: { accept: "application/xml,text/xml" } });
      if (!res.ok) return fallback();
      const fetched = parseEcbUsdRates(await res.text());
      if (!fetched.length) return fallback();
      const rows = mergeRates(stored?.rows, fetched);
      cache = { at: nowMs(), rows };
      if (store) await store.save(fetched).catch(() => undefined);
      return rows;
    } catch {
      return fallback();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * USD per 1 EUR for a date (YYYY-MM-DD) or the latest.
   * @returns {Promise<{usdPerEur:number, date:string|null, source:string}|null>}
   */
  async function rate(date = null) {
    const fixed = overrideRate(env);
    if (fixed) return { usdPerEur: fixed, date: null, source: "env FINANCE_EUR_USD_RATE (operator override)" };
    const picked = pickRate(await load(), date);
    if (!picked) return null;
    let source = `ECB euro reference rate ${picked.date}`;
    if (picked.beforeRange) source += ` (oldest rate available; ${date} is older than the ECB 90-day file)`;
    else if (!picked.exact && date) source += ` (latest business day on or before ${date})`;
    return { usdPerEur: picked.usdPerEur, date: picked.date, source };
  }

  return { rate };
}

let defaultSource = null;
export function defaultEurUsdSource() {
  defaultSource ||= createEurUsdSource({ store: createFxStore() });
  return defaultSource;
}

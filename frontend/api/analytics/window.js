// Request window for the admin analytics routes: from / to / app, the overview series granularity
// and the time zone its daily buckets use.
//
// Rules:
//   * from and to are ISO instants; to defaults to now, from to 7 days before to (also when unparseable).
//   * The window may span at most MAX_WINDOW_DAYS (366) days; longer, or from after to, is a 400.
//     A small DST allowance is added, so 366 whole local days always fit.
//   * Series granularity: `granularity=hour|day` when given, otherwise hour for windows up to
//     7 days and day beyond. Hourly is refused above MAX_HOURLY_DAYS (31 days, about 750 points).
//   * Daily buckets are calendar days in `tz` (an IANA zone name, e.g. Europe/Amsterdam), so they
//     line up with the whole local days the dashboard selects. Missing or unknown tz means UTC.

export const MAX_WINDOW_DAYS = 366;
export const MAX_HOURLY_DAYS = 31;
export const HOURLY_DEFAULT_MAX_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A local-day window crosses at most two DST changes in a year; allow up to 2 extra hours.
const DST_ALLOWANCE_MS = 2 * HOUR_MS;

export class AnalyticsWindowError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnalyticsWindowError";
    this.status = 400;
  }
}

// An unparseable value falls back to the default, as before the range cap existed.
function parseInstant(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** IANA zone name if the runtime knows it, otherwise "UTC". */
export function normalizeTimeZone(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw)) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "hour" or "day" for the overview series. */
export function seriesGranularity(fromIso, toIso, requested) {
  const spanMs = new Date(toIso).getTime() - new Date(fromIso).getTime();
  const wanted = String(requested ?? "").trim().toLowerCase();
  if (wanted === "hour") {
    if (spanMs > MAX_HOURLY_DAYS * DAY_MS + DST_ALLOWANCE_MS) {
      throw new AnalyticsWindowError(`Hourly series are limited to ${MAX_HOURLY_DAYS} days. Use granularity=day.`);
    }
    return "hour";
  }
  if (wanted === "day") return "day";
  if (wanted) throw new AnalyticsWindowError("granularity must be hour or day.");
  return spanMs <= HOURLY_DEFAULT_MAX_DAYS * DAY_MS ? "hour" : "day";
}

/**
 * Parse the window from req.query. Throws AnalyticsWindowError (status 400) for a bad window.
 * Returns { from, to, app, granularity, timeZone }.
 */
export function parseWindow(query = {}, nowMs = Date.now()) {
  const to = parseInstant(String(query.to || "").trim()) || new Date(nowMs);
  const from = parseInstant(String(query.from || "").trim()) || new Date(to.getTime() - 7 * DAY_MS);
  const app = String(query.app || "public").trim() || "public";
  if (from.getTime() > to.getTime()) throw new AnalyticsWindowError("from must be before to.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS + DST_ALLOWANCE_MS) {
    throw new AnalyticsWindowError(`The date range is limited to ${MAX_WINDOW_DAYS} days.`);
  }
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return {
    from: fromIso,
    to: toIso,
    app,
    granularity: seriesGranularity(fromIso, toIso, query.granularity),
    timeZone: normalizeTimeZone(query.tz),
  };
}

// Short in-process cache for the admin analytics GET routes.
//
// The dashboard sends from/to with millisecond precision (now minus 24h / 7d / 30d), so an exact key
// would almost never repeat. The key rounds from/to down to the TTL step; a hit can therefore be up to
// one TTL old, which is what a 60 s cache means anyway. The echoed from/to/app fields are rewritten to
// the request's own values so the response shape stays identical.

export const ANALYTICS_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

function bucketIso(value, stepMs) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return String(value ?? "");
  return String(Math.floor(t / stepMs) * stepMs);
}

export function analyticsCacheKey({ route, from, to, app, extra = {} }, stepMs = ANALYTICS_CACHE_TTL_MS) {
  const parts = [route, bucketIso(from, stepMs), bucketIso(to, stepMs), app];
  for (const key of Object.keys(extra).sort()) parts.push(`${key}=${extra[key] ?? ""}`);
  return parts.join("|");
}

export function createAnalyticsCache({ ttlMs = ANALYTICS_CACHE_TTL_MS, maxEntries = MAX_ENTRIES, now = () => Date.now() } = {}) {
  const entries = new Map();
  const inflight = new Map();

  function get(key) {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (now() - hit.at >= ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  function set(key, value) {
    entries.set(key, { at: now(), value });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  /** Returns the cached value, or runs load() once per key (concurrent callers share the promise). */
  async function wrap(key, load) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const value = await load();
        set(key, value);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  return { get, set, wrap, clear: () => entries.clear(), size: () => entries.size };
}

/** Copy of a cached payload with the request's own from/to/app echoed back (only where the payload has them). */
export function withRequestWindow(payload, { from, to, app }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out = { ...payload };
  if ("from" in out) out.from = from;
  if ("to" in out) out.to = to;
  if ("app" in out) out.app = app;
  return out;
}

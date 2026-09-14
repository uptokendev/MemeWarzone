import { isIP } from "node:net";

const COUNTRY_RE = /^[A-Z]{2}$/;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const geoCache = new Map();

function firstHeader(req, names) {
  for (const name of names) {
    const value = String(req.headers?.[name] || "").trim();
    if (value) return value;
  }
  return "";
}

export function trustedGeoContext(req) {
  const rawCountry = firstHeader(req, [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
  ]).toUpperCase();
  const country = COUNTRY_RE.test(rawCountry) && !["XX", "T1"].includes(rawCountry) ? rawCountry : undefined;
  const region = firstHeader(req, ["x-vercel-ip-country-region", "cf-region", "x-region-code"]);
  return {
    country,
    region: region ? String(region).slice(0, 120) : undefined,
    source: country ? "edge" : undefined,
  };
}

export function isPublicClientIp(ip) {
  const value = String(ip || "").trim().replace(/^::ffff:/, "");
  const version = isIP(value);
  if (!version) return false;

  if (version === 4) {
    const octets = value.split(".").map(Number);
    const [a, b] = octets;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
    return true;
  }

  const lower = value.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(lower)) return false;
  return true;
}

export function parseGeoLookupPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.success !== true) return {};
  const rawCountry = String(payload.country_code || "").trim().toUpperCase();
  const country = COUNTRY_RE.test(rawCountry) && !["XX", "T1"].includes(rawCountry) ? rawCountry : undefined;
  const rawRegion = String(payload.region_code || "").trim();
  return {
    country,
    region: rawRegion ? rawRegion.slice(0, 120) : undefined,
    source: country ? "geoip" : undefined,
  };
}

function cacheGet(ip) {
  const hit = geoCache.get(ip);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    geoCache.delete(ip);
    return null;
  }
  return hit.geo;
}

function cacheSet(ip, geo) {
  if (geoCache.size >= CACHE_MAX) {
    const first = geoCache.keys().next().value;
    if (first) geoCache.delete(first);
  }
  geoCache.set(ip, { at: Date.now(), geo });
}

export async function resolveGeoContext(req, clientIp, fetchImpl = globalThis.fetch) {
  const trusted = trustedGeoContext(req);
  if (trusted.country) return trusted;

  const ip = String(clientIp || "").trim().replace(/^::ffff:/, "");
  if (!isPublicClientIp(ip) || typeof fetchImpl !== "function") return trusted;

  const cached = cacheGet(ip);
  if (cached) return cached;

  try {
    const response = await fetchImpl(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,region_code`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(800),
    });
    if (!response?.ok) return trusted;
    const geo = parseGeoLookupPayload(await response.json());
    if (geo.country) cacheSet(ip, geo);
    return geo.country ? geo : trusted;
  } catch {
    return trusted;
  }
}

// Link previews for feed posts: GET /api/link-preview?url=https://... -> { ok, url, domain, title, description, image, siteName }.
// The app shows the first link in a post as a card (title, image, domain), like X.
//
// Safety: the API fetches a URL a user typed, so every hop is checked before it is fetched: http(s) only, no
// credentials in the URL, the host must resolve to public addresses only (assertPublicImageUrl / isPrivateAddress
// from lib/hudShareCardSvg.mjs, re-checked on every redirect, at most 4 hops), 6 s timeout, HTML only, at most
// 512 KB read. Only https images are returned (the app is https). Results are cached (6 h, misses 30 min), and
// uncached fetches are limited per IP and in total.
import { assertPublicImageUrl } from "./lib/hudShareCardSvg.mjs";

const MAX_URL = 2048;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 6000;
const HIT_TTL_MS = 6 * 3600_000;
const MISS_TTL_MS = 30 * 60_000;
const CACHE_CAP = 3000;
const PER_IP_PER_MINUTE = 30;
const MAX_IN_FLIGHT = 8;
const USER_AGENT = "Mozilla/5.0 (compatible; MemeWarzoneBot/1.0; +https://app.memewar.zone/about) facebookexternalhit/1.1";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10) || 32);
    return ENTITIES[k] ?? m;
  });
}

const clean = (s, n) => {
  const t = decodeEntities(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Normalizes a user URL: http(s) only, no fragment. Returns null when unusable. */
export function normalizePreviewUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > MAX_URL) return null;
  // A scheme other than http(s) (ftp:, javascript:, data:) is refused; a bare "example.com/x" gets https://.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  return u.toString();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

/** Title, description, image and site name from an HTML head (Open Graph, then Twitter, then plain tags). */
export function parsePreview(html, pageUrl) {
  const head = String(html || "").slice(0, MAX_BYTES);
  const metas = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], "property") || attr(m[0], "name") || "").toLowerCase();
    const content = attr(m[0], "content");
    if (key && content != null && !(key in metas)) metas[key] = content;
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  let image = metas["og:image:secure_url"] || metas["og:image"] || metas["og:image:url"] || metas["twitter:image"] || metas["twitter:image:src"] || "";
  try {
    image = image ? new URL(decodeEntities(image).trim(), pageUrl).toString() : "";
  } catch {
    image = "";
  }
  if (!image.startsWith("https://")) image = "";
  const domain = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  return {
    title: clean(metas["og:title"] || metas["twitter:title"] || titleTag, 200),
    description: clean(metas["og:description"] || metas["twitter:description"] || metas.description, 300),
    image: image || null,
    siteName: clean(metas["og:site_name"], 80) || null,
    domain,
  };
}

async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return (await response.text()).slice(0, MAX_BYTES);
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    // already closed
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").slice(0, MAX_BYTES);
}

/** Fetches a page with the public-address check on every hop. */
export async function fetchPreviewHtml(startUrl, { fetchImpl = fetch, check = assertPublicImageUrl } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let target = startUrl;
    for (let hop = 0; hop < 4; hop += 1) {
      await check(target);
      const response = await fetchImpl(target, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "accept-language": "en" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        target = new URL(location, target).toString();
        continue;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      const type = String(response.headers.get("content-type") || "").toLowerCase();
      if (!type.includes("text/html") && !type.includes("application/xhtml")) throw new Error("not html");
      return { html: await readCapped(response), finalUrl: target };
    }
    throw new Error("too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"]);

/**
 * YouTube watch pages are over 1 MB with the og tags past our read cap, so YouTube links use its oEmbed endpoint
 * (small JSON: title, channel, thumbnail). Returns null for other hosts or when oEmbed has nothing.
 */
export async function youTubePreview(url, { fetchImpl = fetch, check = assertPublicImageUrl } = {}) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  await check(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, { signal: controller.signal, redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "application/json" } });
    if (!response.ok) return null;
    const j = JSON.parse((await response.text()).slice(0, 64 * 1024));
    const title = clean(j?.title, 200);
    const image = typeof j?.thumbnail_url === "string" && j.thumbnail_url.startsWith("https://") ? j.thumbnail_url : null;
    if (!title && !image) return null;
    return { ok: true, url, title, description: clean(j?.author_name, 120), image, siteName: "YouTube", domain: "youtube.com" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createLinkPreview({ fetchImpl = fetch, check = assertPublicImageUrl, now = () => Date.now(), log = console } = {}) {
  const cache = new Map();
  const minute = new Map();
  const inflight = new Map();
  let running = 0;

  function cached(url) {
    const hit = cache.get(url);
    if (!hit) return null;
    if (hit.exp <= now()) {
      cache.delete(url);
      return null;
    }
    return hit.value;
  }

  function store(url, value) {
    cache.set(url, { value, exp: now() + (value.ok ? HIT_TTL_MS : MISS_TTL_MS) });
    while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
  }

  function allow(ip) {
    const t = now();
    const e = minute.get(ip);
    if (!e || t - e.start >= 60_000) {
      minute.set(ip, { start: t, count: 1 });
      if (minute.size > 50_000) for (const [k, v] of minute) if (t - v.start >= 60_000) minute.delete(k);
      return true;
    }
    if (e.count >= PER_IP_PER_MINUTE) return false;
    e.count += 1;
    return true;
  }

  async function resolve(url) {
    try {
      const yt = await youTubePreview(url, { fetchImpl, check });
      if (yt) {
        store(url, yt);
        return yt;
      }
      const { html, finalUrl } = await fetchPreviewHtml(url, { fetchImpl, check });
      const p = parsePreview(html, finalUrl);
      const value = p.title || p.image ? { ok: true, url, ...p } : { ok: false, url, domain: p.domain };
      store(url, value);
      return value;
    } catch (err) {
      const value = { ok: false, url, domain: (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })() };
      store(url, value);
      if (!/private|not public|credentials|must be http|abort/i.test(String(err?.message || ""))) log.info?.(`[link-preview] ${url}: ${err?.message || err}`);
      return value;
    }
  }

  return async function linkPreviewHandler(req, res) {
    const url = normalizePreviewUrl(req.query?.url);
    if (!url) return res.status(400).json({ ok: false, error: "Bad url" });
    const hit = cached(url);
    if (hit) {
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json(hit);
    }
    const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = (forwarded || req.ip || req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
    if (!allow(ip) || (running >= MAX_IN_FLIGHT && !inflight.has(url))) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(429).json({ ok: false, error: "Too many previews, try again shortly" });
    }
    let job = inflight.get(url);
    if (!job) {
      running += 1;
      job = resolve(url).finally(() => {
        running -= 1;
        inflight.delete(url);
      });
      inflight.set(url, job);
    }
    const value = await job;
    res.setHeader("Cache-Control", value.ok ? "public, max-age=3600" : "public, max-age=600");
    return res.status(200).json(value);
  };
}

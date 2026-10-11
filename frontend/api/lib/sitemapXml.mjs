// Pure sitemap XML builders. No I/O.
import { APP_ORIGIN } from "../../shared/seoRoutes.mjs";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const DECL = '<?xml version="1.0" encoding="UTF-8"?>';
export const MAX_URLS_PER_SITEMAP = 50000;

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Origin for sitemap URLs: env APP_PUBLIC_ORIGIN (trimmed, no trailing slash) or APP_ORIGIN. */
export function sitemapOrigin() {
  const raw = String(process.env.APP_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+$/.test(raw) ? raw : APP_ORIGIN;
}

/** Absolute URL for an app path, using sitemapOrigin(). */
export function absoluteLoc(path) {
  const p = String(path ?? "");
  return `${sitemapOrigin()}${p.startsWith("/") ? p : `/${p}`}`;
}

function formatLastmod(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString().slice(0, 10);
}

/** @param {{ loc: string, lastmod?: Date|string }[]} entries */
export function urlsetXml(entries) {
  const out = [];
  for (const entry of entries || []) {
    const loc = entry && typeof entry.loc === "string" ? entry.loc.trim() : "";
    if (!loc) continue;
    const lastmod = formatLastmod(entry.lastmod);
    out.push(`<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`);
  }
  return `${DECL}\n<urlset xmlns="${NS}">\n${out.join("\n")}\n</urlset>\n`;
}

/** @param {string[]} names child sitemap names (without .xml) */
export function sitemapIndexXml(names, origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  const items = (names || []).map((n) => `<sitemap><loc>${esc(`${base}/sitemaps/${n}.xml`)}</loc></sitemap>`);
  return `${DECL}\n<sitemapindex xmlns="${NS}">\n${items.join("\n")}\n</sitemapindex>\n`;
}

/**
 * Split entries into arrays of at most `size` (default 50,000, the protocol limit).
 * Naming: chunk 0 is served as `coins.xml`, chunk 1 as `coins-2.xml`, chunk 2 as `coins-3.xml`, ...
 * See chunkName().
 */
export function chunkEntries(entries, size = MAX_URLS_PER_SITEMAP) {
  const list = entries || [];
  const step = Number.isInteger(size) && size > 0 ? size : MAX_URLS_PER_SITEMAP;
  const chunks = [];
  for (let i = 0; i < list.length; i += step) chunks.push(list.slice(i, i + step));
  return chunks;
}

/** chunkName("coins", 0) -> "coins"; chunkName("coins", 1) -> "coins-2". */
export function chunkName(name, index) {
  return index <= 0 ? name : `${name}-${index + 1}`;
}

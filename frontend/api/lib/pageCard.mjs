// Share cards (1200x630 JPEG) for the content pages: /about, the comparison pages, /faq, /faq/<topic> and
// /faq/<answer>. Same look as the coin story card (api/story.js): Bungee and Barlow Condensed, dark field,
// orange accents, the MemeWarzone art on the right and the page's own title on the left.
//   GET /api/og/page.jpg?path=/faq/battle-boosts
// The renderer (api/seoRender.js) links it as og:image with ?v=<content hash>, so a changed page gets a new URL
// and X / Telegram / Discord fetch the new card. Unknown paths answer 404.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ABOUT_CHAINS, ABOUT_PATH, ABOUT_TITLE } from "../../shared/aboutContent.mjs";
import { COMPARE_PAGES } from "../../shared/comparePages.mjs";
import { HELP_ARTICLES, HELP_PATH, helpHead } from "../../shared/helpContent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ["Bungee-Regular.ttf", "BarlowCondensed-Bold.ttf", "BarlowCondensed-SemiBold.ttf"].map((f) => path.join(here, "..", "assets", "fonts", f));
const ART_FILE = path.join(here, "..", "..", "public", "assets", "memewarzone.png");
const LOGO_FILE = path.join(here, "..", "..", "public", "assets", "navbar-logo.png");
export const PAGE_CARD_ROUTE = "/api/og/page.jpg";
const W = 1200;
const H = 630;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Greedy word wrap by an estimated character width; the last line gets an ellipsis when text is cut. */
export function wrap(text, maxChars, maxLines) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (next.length <= maxChars || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = words[i];
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur);
    i = words.length;
  }
  if (i < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.length > maxChars - 1 ? last.slice(0, maxChars - 1).replace(/\s+\S*$/, "") : last}...`;
  }
  return lines;
}

const firstSentence = (s) => {
  const t = String(s || "").trim();
  const m = t.match(/^(.+?[.?!])(\s|$)/);
  return m ? m[1] : t;
};

/** What the card says for a path, or null when the path has no card. */
export function pageCardSpec(rawPath) {
  const p = String(rawPath || "").split("?")[0].replace(/\/+$/, "") || "/";
  if (p === ABOUT_PATH) {
    return { eyebrow: "ABOUT", title: ABOUT_TITLE, subtitle: "Memecoin launchpad and battle arena. Launch, trade, graduate and battle.", chips: ABOUT_CHAINS, footer: "app.memewar.zone/about" };
  }
  const compare = COMPARE_PAGES.find((c) => c.path === p);
  if (compare) {
    return { eyebrow: "LAUNCHPAD COMPARISON", title: compare.title, subtitle: "Chains, fees, creator earnings, graduation and battles side by side.", chips: [`Checked ${compare.checkedOn}`], footer: `app.memewar.zone${compare.path}` };
  }
  if (p === HELP_PATH) {
    return { eyebrow: "SUPPORT", title: "Help Center", subtitle: `${HELP_ARTICLES.length} answers about wallets, launching, trading, battles, leagues, rewards, fees and safety.`, chips: [], footer: "app.memewar.zone/faq" };
  }
  if (p.startsWith(`${HELP_PATH}/`)) {
    const head = helpHead(p.slice(HELP_PATH.length + 1));
    if (!head) return null;
    if (head.kind === "topic") {
      return { eyebrow: "HELP CENTER", title: head.topic.label, subtitle: head.topic.description, chips: [], footer: `app.memewar.zone${p}` };
    }
    return { eyebrow: `HELP CENTER · ${head.topic.label.toUpperCase()}`, title: head.article.q, subtitle: firstSentence(head.article.a?.[0]), chips: [], footer: `app.memewar.zone${p}`, question: true };
  }
  return null;
}

/** Short content hash, used as ?v= so a changed card gets a new URL. */
export function pageCardVersion(spec) {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 10);
}

export function pageCardUrl(rawPath, apiOrigin = "https://api.memewar.zone") {
  const spec = pageCardSpec(rawPath);
  if (!spec) return null;
  const p = String(rawPath || "").split("?")[0].replace(/\/+$/, "") || "/";
  return `${String(apiOrigin).replace(/\/+$/, "")}${PAGE_CARD_ROUTE}?path=${encodeURIComponent(p)}&v=${pageCardVersion(spec)}`;
}

/** The card as SVG. `art` and `logo` are data URIs (or null to leave them out). */
export function pageCardSvg(spec, { art = null, logo = null } = {}) {
  // Titles: Bungee for short page names, Barlow Condensed Bold for questions (narrower, fits more words).
  const long = spec.question || spec.title.length > 22;
  const titleFont = long ? "Barlow Condensed" : "Bungee";
  const titleWeight = long ? "700" : "400";
  let size = long ? 68 : 72;
  let lines = wrap(long ? spec.title : spec.title.toUpperCase(), Math.floor(620 / (size * (long ? 0.45 : 0.72))), 3);
  if (lines.length === 3) {
    size = long ? 58 : 60;
    lines = wrap(long ? spec.title : spec.title.toUpperCase(), Math.floor(620 / (size * (long ? 0.45 : 0.72))), 3);
  }
  const titleTop = 238;
  const lineH = size * 1.02;
  const subTop = titleTop + (lines.length - 1) * lineH + 62;
  const sub = wrap(spec.subtitle, 46, lines.length >= 3 ? 1 : 2);
  const chipsY = subTop + sub.length * 38 + 26;
  let chipX = 70;
  const chips = (spec.chips || []).slice(0, 3).map((c) => {
    const w = Math.round(c.length * 11.5 + 36);
    const out = `<rect x="${chipX}" y="${chipsY}" width="${w}" height="40" rx="20" fill="#2a1609" stroke="#7a3a0c" stroke-width="2"/>
  <text x="${chipX + w / 2}" y="${chipsY + 27}" text-anchor="middle" font-family="Barlow Condensed" font-weight="700" font-size="21" letter-spacing="1" fill="#ffb27a">${esc(c.toUpperCase())}</text>`;
    chipX += w + 12;
    return out;
  });
  const eyebrowW = Math.round(spec.eyebrow.length * 11.4 + 54);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0a0908" stop-opacity="1"/>
      <stop offset="0.5" stop-color="#0a0908" stop-opacity="0.92"/>
      <stop offset="0.72" stop-color="#0a0908" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#0a0908" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.18" cy="0.55" r="0.6">
      <stop offset="0" stop-color="#f06a1a" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#f06a1a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0a0908"/>
  ${art ? `<image x="520" y="0" width="680" height="${H}" preserveAspectRatio="xMidYMid slice" xlink:href="${art}"/>` : ""}
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="#f06a1a"/>
  ${logo ? `<image x="64" y="52" width="300" height="55" preserveAspectRatio="xMinYMid meet" xlink:href="${logo}"/>` : `<text x="70" y="96" font-family="Bungee" font-size="40" fill="#f2c14e">MEMEWARZONE</text>`}
  <rect x="70" y="${titleTop - 112}" width="${eyebrowW}" height="38" rx="8" fill="#2a1609" stroke="#7a3a0c" stroke-width="2"/>
  <circle cx="92" cy="${titleTop - 93}" r="6" fill="#f06a1a"/>
  <text x="108" y="${titleTop - 85}" font-family="Barlow Condensed" font-weight="700" font-size="21" letter-spacing="2" fill="#ffb27a">${esc(spec.eyebrow)}</text>
  ${lines.map((l, i) => `<text x="68" y="${titleTop + i * lineH}" font-family="${titleFont}" font-weight="${titleWeight}" font-size="${size}" fill="#f4f1e8">${esc(l)}</text>`).join("\n  ")}
  ${sub.map((l, i) => `<text x="70" y="${subTop + i * 38}" font-family="Barlow Condensed" font-weight="600" font-size="31" fill="#c9ced4">${esc(l)}</text>`).join("\n  ")}
  ${chips.join("\n  ")}
  <text x="70" y="${H - 44}" font-family="Barlow Condensed" font-weight="700" font-size="24" letter-spacing="1" fill="#8d949c">${esc(spec.footer)}</text>
</svg>`;
}

/**
 * Renderer with cached art, fonts and finished cards (LRU by path + version). Only content paths render, so the
 * cache is bounded by the number of pages.
 */
export function createPageCardRenderer({ cap = 400 } = {}) {
  const cache = new Map();
  let assets = null;

  async function loadAssets() {
    if (assets) return assets;
    const sharp = (await import("sharp")).default;
    const art = fs.existsSync(ART_FILE)
      ? `data:image/jpeg;base64,${(await sharp(ART_FILE).resize(680, 630, { fit: "cover", position: "centre" }).jpeg({ quality: 82 }).toBuffer()).toString("base64")}`
      : null;
    const logo = fs.existsSync(LOGO_FILE)
      ? `data:image/png;base64,${(await sharp(LOGO_FILE).resize(600).png().toBuffer()).toString("base64")}`
      : null;
    assets = { art, logo, sharp, fonts: FONT_FILES.filter((f) => fs.existsSync(f)) };
    return assets;
  }

  async function render(rawPath) {
    const spec = pageCardSpec(rawPath);
    if (!spec) return null;
    const key = `${rawPath}|${pageCardVersion(spec)}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const a = await loadAssets();
    const { Resvg } = await import("@resvg/resvg-js");
    const png = new Resvg(pageCardSvg(spec, a), {
      fitTo: { mode: "width", value: W },
      font: { fontFiles: a.fonts, loadSystemFonts: false, defaultFontFamily: "Barlow Condensed" },
    }).render().asPng();
    const jpg = await a.sharp(png).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    cache.set(key, jpg);
    while (cache.size > cap) cache.delete(cache.keys().next().value);
    return jpg;
  }

  return async function pageCardHandler(req, res) {
    const p = String(req.query?.path ?? new URL(req.url || "/", "http://x").searchParams.get("path") ?? "");
    const jpg = p ? await render(p) : null;
    if (!jpg) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "public, max-age=300");
      return res.end("No share card for this path");
    }
    res.statusCode = 200;
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", "public, max-age=86400, s-maxage=86400");
    return res.end(jpg);
  };
}

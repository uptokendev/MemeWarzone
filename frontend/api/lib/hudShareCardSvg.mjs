import net from "node:net";
import { lookup } from "node:dns/promises";
/**
 * Shared HUD share-card SVG used by Prepare Mode and Token Details.
 * Pixel-font chrome stays identical; callers only swap the metric row.
 */

import { getQuery } from "../../server/http.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function absoluteUrl(base, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // Keep share-card image resolution in parity with the browser media helper.
  // Prepare Mode can store IPFS/Arweave URIs (and bare IPFS CIDs), which render
  // in the browser but previously got dropped by the server-side share-card renderer.
  if (raw.startsWith("ipfs://")) {
    let path = raw.slice("ipfs://".length);
    if (path.startsWith("ipfs/")) path = path.slice("ipfs/".length);
    return `https://cloudflare-ipfs.com/ipfs/${path}`;
  }
  if (raw.startsWith("ipfs/")) {
    return `https://cloudflare-ipfs.com/ipfs/${raw.slice("ipfs/".length)}`;
  }
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44,}$/.test(raw) || /^b[a-z2-7]{20,}$/i.test(raw)) {
    return `https://cloudflare-ipfs.com/ipfs/${raw}`;
  }
  if (raw.startsWith("ar://")) {
    return `https://arweave.net/${raw.slice("ar://".length)}`;
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;

  const cleanBase = String(base || "").replace(/\/+$/, "");
  if (raw.startsWith("/")) return cleanBase ? `${cleanBase}${raw}` : raw;

  // Some storage/CDN values are persisted as naked relative paths. The browser
  // resolves those against the app origin; do the same on the server.
  return cleanBase ? `${cleanBase}/${raw.replace(/^\/+/, "")}` : raw;
}

export function clampText(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function splitName(name, maxChars = 14) {
  const clean = String(name || "CAMPAIGN NAME").trim().toUpperCase();
  if (clean.length <= maxChars) return [clean, ""];
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [clean.slice(0, maxChars), clean.slice(maxChars, maxChars * 2)];
  const first = [];
  const second = [];
  let count = 0;
  for (const word of words) {
    if (count + word.length <= maxChars || first.length === 0) {
      first.push(word);
      count += word.length + 1;
    } else {
      second.push(word);
    }
  }
  return [first.join(" "), second.join(" ")];
}

function safeNumberText(value, fallback = "0") {
  const raw = String(value ?? "").trim();
  return raw || fallback;
}

function setNoStoreHeaders(res) {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.setHeader("surrogate-control", "no-store");
}

export function getRequestBaseUrl(req) {
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || "";
  if (host) {
    const proto = req?.headers?.["x-forwarded-proto"] || "https";
    return `${proto}://${host}`;
  }

  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  return /^https?:\/\//i.test(envUrl) ? envUrl.replace(/\/+$/, "") : "";
}

export function publicAssetUrl(req, path) {
  const base = getRequestBaseUrl(req);
  if (!base) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeImageSrc(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\//i.test(raw)) return raw;
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

// The token share card renders a logo URL supplied by the browser, so the server must never be
// usable as a proxy into private networks (cloud metadata, Coolify-internal services, localhost).
// Every hop -- the first URL and each redirect -- must be http(s), carry no credentials, and resolve
// only to public addresses. DNS is re-checked per hop; a rebinding race remains theoretically
// possible and is bounded by the image-only content-type check and the size cap.
function ipv4Private(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateAddress(address) {
  const ip = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind === 6) {
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Private(mapped[1]);
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return true;
}

export async function assertPublicImageUrl(value, resolve = (host) => lookup(host, { all: true })) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("image url must be http(s)");
  if (url.username || url.password) throw new Error("image url must not carry credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) {
    throw new Error("image host is not public");
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await resolve(host);
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("image host resolves to a private address");
  }
  return url;
}

async function fetchImageResponse(clean) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      let target = clean;
      for (let hop = 0; hop < 4; hop += 1) {
        await assertPublicImageUrl(target);
        const response = await fetch(target, {
          signal: controller.signal,
          redirect: "manual",
          headers: {
            // resvg 0.34 reliably decodes PNG/JPEG/GIF. Prefer those when the
            // upstream CDN supports content negotiation instead of asking for WebP/AVIF.
            accept: "image/png,image/jpeg,image/gif,image/svg+xml;q=0.9,*/*;q=0.1",
            "user-agent": "MemeWarzone-ShareCard/1.0",
          },
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          target = new URL(location, target).toString();
          continue;
        }
        clearTimeout(timer);
        if (response.ok) return response;
        lastError = new Error(`image fetch failed (${response.status})`);
        break;
      }
      clearTimeout(timer);
      if (!lastError) lastError = new Error("image fetch: too many redirects");
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (/private|not public|credentials|must be http/.test(String(err?.message || ""))) break;
    }
  }
  throw lastError || new Error("image fetch failed");
}

export async function embedShareCardImage(src) {
  const clean = normalizeImageSrc(src);
  if (!clean) return "";
  if (/^data:image\//i.test(clean)) return clean;
  try {
    const response = await fetchImageResponse(clean);
    const contentType = String(response.headers.get("content-type") || "image/png")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!/^image\//i.test(contentType)) return "";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 2_500_000) return "";

    // @resvg/resvg-js@2.6.2 uses resvg 0.34, whose raster decoder supports
    // PNG/JPEG/GIF but not WebP/AVIF. Returning an unsupported data URI creates
    // a valid share-card PNG with a mysteriously blank token image, so fail
    // explicitly to the ticker fallback instead of silently embedding it.
    if (contentType === "image/webp" || contentType === "image/avif") {
      console.warn(`[hud-share-card] unsupported raster format from ${clean}: ${contentType}`);
      return "";
    }

    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn("[hud-share-card] failed to embed logo", err?.message || err);
    return "";
  }
}

const GLYPHS = {
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "00000", "01100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "%": ["11001", "11010", "00100", "01000", "10011", "01011", "00000"],
  "@": ["01110", "10001", "10111", "10101", "10111", "10000", "01110"],
  "#": ["01010", "11111", "01010", "01010", "11111", "01010", "01010"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "'": ["01100", "01100", "01000", "00000", "00000", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
};

function normalizePixelText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9 .,:/\-_@$%#!?'()+]/g, " ");
}

function pixelText(value, x, y, options = {}) {
  const text = normalizePixelText(value);
  const scale = options.scale ?? 4;
  const color = options.color ?? "#10f58a";
  const opacity = options.opacity ?? 1;
  const spacing = options.spacing ?? scale;
  const maxChars = options.maxChars ?? text.length;
  const anchor = options.anchor || "start";
  const clipped = text.slice(0, maxChars);
  const charWidth = 5 * scale + spacing;
  const totalWidth = clipped.length > 0 ? clipped.length * charWidth - spacing : 0;
  const startX = anchor === "middle" ? x - totalWidth / 2 : anchor === "end" ? x - totalWidth : x;
  const rects = [];

  [...clipped].forEach((char, index) => {
    const glyph = GLYPHS[char] || GLYPHS[" "];
    const gx = startX + index * charWidth;
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((cell, colIndex) => {
        if (cell !== "1") return;
        rects.push(`<rect x="${gx + colIndex * scale}" y="${y + rowIndex * scale}" width="${scale}" height="${scale}" fill="${color}" opacity="${opacity}"/>`);
      });
    });
  });

  return `<g>${rects.join("")}</g>`;
}

function wrapPixelLines(value, maxChars, maxLines = 2) {
  const words = normalizePixelText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word.slice(0, maxChars);
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : [""];
}

export function presentHudShareMetrics(data = {}) {
  if (Array.isArray(data.metrics) && data.metrics.length) {
    return data.metrics.slice(0, 3).map((row) => ({
      label: String(row?.label || "").trim().toUpperCase() || "STAT",
      value: safeNumberText(row?.value, "—"),
      maxChars: Number(row?.maxChars) || 10,
    }));
  }
  return [
    { label: "SOLDIERS FOLLOWS", value: safeNumberText(data.recruits, "0"), maxChars: 8 },
    { label: "HEAT", value: safeNumberText(data.heat, "0%"), maxChars: 8 },
    { label: "BUILT BY", value: String(data.creator || "@MEMEWARZONE").trim().toUpperCase(), maxChars: 18 },
  ];
}

export function hudShareCardSvg(data, logoDataUrl = "", brandLogoDataUrl = "") {
  const name = String(data.name || "CAMPAIGN NAME").trim().toUpperCase();
  const ticker = String(data.ticker || "MWZ").replace(/^\$+/, "").trim().toUpperCase().slice(0, 12);
  const chain = String(data.chain || "BNB CHAIN").trim().toUpperCase();
  const status = String(data.status || "DRAFT").trim().toUpperCase();
  const metrics = presentHudShareMetrics(data);
  const rightLabel = String(data.right?.label || "ARM NOTIFICATION").trim().toUpperCase();
  const link = clampText(data.right?.value || data.link || `memewar.zone/d/${ticker.toLowerCase()}`, 34);
  const description = clampText(data.description || "The launchpad that turns every drop into a war.", 72);

  const [line1, line2] = splitName(name, 14);
  const titleScale = line1.length > 12 || line2.length > 12 ? 8 : 9;
  const titleY1 = line2 ? 182 : 210;
  const titleY2 = line2 ? 252 : 0;
  const descLines = wrapPixelLines(description, 54, 2);

  const logoBlock = logoDataUrl
    ? `<image href="${esc(logoDataUrl)}" x="55" y="176" width="148" height="148" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice"/>
       <circle cx="129" cy="250" r="74" stroke="#28ff93" stroke-opacity="0.55" stroke-width="2" fill="none"/>`
    : `<circle cx="129" cy="250" r="74" fill="url(#orb)"/>
       <circle cx="129" cy="250" r="74" stroke="#28ff93" stroke-opacity="0.35"/>
       ${pixelText(ticker, 129, 232, { scale: 7, color: "#ffffff", anchor: "middle" })}`;

  const brandLogoBlock = brandLogoDataUrl
    ? `<image href="${esc(brandLogoDataUrl)}" x="55" y="46" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1002" height="531" viewBox="0 0 1002 531" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1002" y2="531" gradientUnits="userSpaceOnUse">
      <stop stop-color="#06170d"/><stop offset="0.48" stop-color="#030907"/><stop offset="1" stop-color="#130804"/>
    </linearGradient>
    <radialGradient id="orb" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(129 249) rotate(90) scale(76)">
      <stop stop-color="#20ff90"/><stop offset="0.55" stop-color="#04954d"/><stop offset="1" stop-color="#012913"/>
    </radialGradient>
    <radialGradient id="orbGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(129 249) rotate(90) scale(130)">
      <stop stop-color="#00ff88" stop-opacity="0.45"/><stop offset="1" stop-color="#00ff88" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="33" height="33" patternUnits="userSpaceOnUse"><path d="M33 0H0V33" stroke="#13ff82" stroke-opacity="0.055"/></pattern>
    <filter id="greenGlow" x="-80" y="30" width="420" height="430" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="0" stdDeviation="18" flood-color="#00ff88" flood-opacity="0.35"/></filter>
    <filter id="textGlow" x="0" y="0" width="1002" height="531" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#10f58a" flood-opacity="0.55"/></filter>
    <clipPath id="logoClip"><circle cx="129" cy="250" r="74"/></clipPath>
  </defs>

  <rect width="1002" height="531" fill="url(#bg)"/><rect width="1002" height="531" fill="url(#grid)"/><rect width="1002" height="531" fill="url(#orbGlow)" opacity="0.65"/>
  <rect x="0" y="0" width="1002" height="10" fill="#070707"/>
  ${Array.from({ length: 44 }).map((_, i) => `<path d="M${i * 24} 0H${i * 24 + 12}L${i * 24 + 2} 10H${i * 24 - 10}L${i * 24} 0Z" fill="#7b421c" fill-opacity="0.52"/>`).join("")}
  <rect x="0" y="521" width="1002" height="10" fill="#070707"/>
  ${Array.from({ length: 44 }).map((_, i) => `<path d="M${i * 24} 521H${i * 24 + 12}L${i * 24 + 2} 531H${i * 24 - 10}L${i * 24} 521Z" fill="#7b421c" fill-opacity="0.52"/>`).join("")}
  <rect x="53" y="57" width="895" height="355" stroke="#1cff8f" stroke-opacity="0.08"/><line x1="53" y1="412" x2="949" y2="412" stroke="#13ff82" stroke-opacity="0.32"/>

  ${brandLogoBlock}
  <g transform="translate(780 55)"><rect width="168" height="28" rx="14" fill="#2b1508" stroke="#f68b2b" stroke-opacity="0.65"/><circle cx="15" cy="14" r="3" fill="#10f58a"/></g>
  <g filter="url(#textGlow)">${pixelText(status, 864, 62, { scale: 2, color: "#f39b3d", maxChars: 12, anchor: "middle" })}</g>

  <g filter="url(#greenGlow)">${logoBlock}</g>
  <g filter="url(#textGlow)">
    ${pixelText(`// $${ticker} - ${chain}`, 235, 150, { scale: 2.2, color: "#10f58a", maxChars: 36 })}
    ${pixelText(line1, 235, titleY1, { scale: titleScale, color: "#dfffee", maxChars: 16 })}
    ${line2 ? pixelText(line2, 235, titleY2, { scale: titleScale, color: "#65ffad", maxChars: 16 }) : ""}
    ${descLines.map((line, index) => pixelText(line, 235, 328 + index * 18, { scale: 2.4, color: "#d9d2ca", maxChars: 56 })).join("")}

    ${pixelText(metrics[0]?.label || "STAT", 54, 438, { scale: 1.55, color: "#4d8066", maxChars: 18 })}
    ${pixelText(metrics[0]?.value || "—", 54, 460, { scale: 2.8, color: "#10f58a", maxChars: metrics[0]?.maxChars || 10 })}
    ${pixelText(metrics[1]?.label || "STAT", 215, 438, { scale: 1.55, color: "#4d8066", maxChars: 18 })}
    ${pixelText(metrics[1]?.value || "—", 215, 460, { scale: 2.8, color: "#10f58a", maxChars: metrics[1]?.maxChars || 10 })}
    ${pixelText(metrics[2]?.label || "STAT", 335, 438, { scale: 1.55, color: "#4d8066", maxChars: 18 })}
    ${pixelText(metrics[2]?.value || "—", 335, 461, { scale: 2.05, color: "#e9e3db", maxChars: metrics[2]?.maxChars || 18 })}
    ${pixelText(rightLabel, 790, 439, { scale: 1.6, color: "#4d8066", anchor: "middle", maxChars: 18 })}
    ${pixelText(link, 790, 461, { scale: 1.55, color: "#10f58a", maxChars: 34, anchor: "middle" })}
  </g>
</svg>`;
}

export async function renderHudShareCardPng(svg) {
  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: 1002 },
    background: "rgba(0,0,0,0)",
  });
  return Buffer.from(renderer.render().asPng());
}

export async function sendHudShareCardPng(req, res, svg, ticker, forceDownload = false) {
  const png = await renderHudShareCardPng(svg);
  const q = getQuery(req);
  const filename = `memewarzone-${String(ticker || "draft").toLowerCase()}-share-card.png`;
  const download = forceDownload || String(q.download || "") === "1";
  res.statusCode = 200;
  res.setHeader("content-type", "image/png");
  res.setHeader("content-length", String(png.length));
  // Downloads stay uncached; crawler cards use short public cache (slug or query card).
  if (download) {
    setNoStoreHeaders(res);
  } else {
    res.setHeader("cache-control", "public, max-age=120, s-maxage=300");
  }
  res.setHeader(
    "content-disposition",
    download ? `attachment; filename="${filename}"` : `inline; filename="${filename}"`,
  );
  // Allow social platforms to fetch the PNG even when site-wide CORP is same-origin.
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  res.end(png);
}

export async function respondHudShareCard(req, res, { svg, ticker, format = "png", download = false }) {
  if (String(format || "png").toLowerCase() === "svg") {
    res.statusCode = 200;
    res.setHeader("content-type", "image/svg+xml; charset=utf-8");
    res.setHeader("cache-control", download ? "no-store" : "public, max-age=120, s-maxage=300");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(svg);
    return;
  }
  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", download ? "no-store" : "public, max-age=120, s-maxage=300");
    res.end();
    return;
  }
  return sendHudShareCardPng(req, res, svg, ticker, download === true);
}

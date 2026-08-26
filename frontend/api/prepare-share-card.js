import { pool } from "../server/db.js";
import { getQuery, json } from "../server/http.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteUrl(base, value) {
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

function shortWallet(value) {
  const v = String(value || "");
  if (!v) return "Unknown";
  if (v.startsWith("@")) return v;
  return v.length > 10 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
}

/**
 * Short crawler-friendly share cards: load draft by slug so og:image URLs stay short.
 * Query params still override when provided (PrepareBase "Copy PNG link").
 */
async function resolveShareCardQuery(req) {
  const q = getQuery(req);
  const slug = String(q.slug || "").trim();
  if (!slug || !pool) return q;

  try {
    const draftRes = await pool.query(
      `select id, chain_id, slug, name, ticker, description, logo_url, status, visibility, creator_wallet
         from public.campaign_drafts
        where lower(slug) = lower($1)
        limit 1`,
      [slug],
    );
    const draft = draftRes.rows[0];
    if (!draft) return q;

    const isPrivate = String(draft.visibility || "").toLowerCase() === "private";
    const appBase = String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "");

    if (isPrivate) {
      return {
        ...q,
        name: q.name || "MemeWarzone",
        ticker: q.ticker || "MWZ",
        chain: q.chain || "BNB CHAIN",
        status: q.status || "PRIVATE",
        recruits: q.recruits || "0",
        heat: q.heat || "0%",
        creator: q.creator || "CLASSIFIED",
        link: q.link || `${appBase.replace(/^https?:\/\//i, "")}/prepare/${draft.slug}`,
        description: q.description || "Private dossier",
      };
    }

    const creator = String(draft.creator_wallet || "").trim();
    const solanaCreator = creator.length >= 32 && !creator.startsWith("0x");
    const commentAuthorNeq = solanaCreator
      ? "(wallet_address <> $2 and lower(wallet_address) <> lower($2))"
      : "lower(wallet_address) <> lower($2)";

    const [promoRes, metricsRes, followRes, nonCreatorCommentRes, reactionRes] = await Promise.all([
      pool
        .query(
          `select mission_statement, creator_note, share_message from public.campaign_draft_promotion where draft_id = $1 limit 1`,
          [draft.id],
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(`select * from public.campaign_draft_metrics where draft_id = $1 limit 1`, [draft.id])
        .catch(() => ({ rows: [] })),
      pool
        .query(`select count(*)::int as count from public.campaign_draft_follows where draft_id = $1`, [draft.id])
        .catch(() => ({ rows: [{ count: 0 }] })),
      pool
        .query(
          `select count(*)::int as count
             from public.campaign_draft_comments
            where draft_id = $1
              and moderation_status = 'visible'
              and ${commentAuthorNeq}`,
          [draft.id, creator],
        )
        .catch(() => ({ rows: [{ count: 0 }] })),
      pool
        .query(
          `select coalesce(sum(reaction_count), 0)::int as count
             from public.campaign_draft_comments
            where draft_id = $1
              and moderation_status = 'visible'`,
          [draft.id],
        )
        .catch(() => ({ rows: [{ count: 0 }] })),
    ]);
    const promotion = promoRes.rows[0] || {};
    const metrics = metricsRes.rows[0] || {};
    const views = Number(metrics?.views || 0);
    const follows = Number(followRes.rows[0]?.count || 0);
    const comments = Number(nonCreatorCommentRes.rows[0]?.count || 0);
    const reactions = Number(reactionRes.rows[0]?.count || 0);
    const shares = Number(metrics?.shares || 0);
    const signedActions = Number(metrics?.signed_actions ?? metrics?.signedActions ?? 0);
    const rankingScore =
      follows * 10 +
      comments * 5 +
      reactions * 3 +
      shares * 4 +
      signedActions * 7 +
      Math.min(views, 2500) * 0.35;
    const heat = Math.max(0, Math.min(100, Math.round((rankingScore / 2200) * 100)));
    const chain =
      Number(draft.chain_id) === 101 || Number(draft.chain_id) === 102 ? "SOLANA" : "BNB CHAIN";
    const description =
      String(draft.description || promotion.mission_statement || promotion.creator_note || "").trim() ||
      "The launchpad that turns every drop into a war.";
    const logo = absoluteUrl(appBase, draft.logo_url || "");

    return {
      ...q,
      name: q.name || draft.name || "Campaign",
      ticker: q.ticker || draft.ticker || "TOKEN",
      chain: q.chain || chain,
      status: q.status || String(draft.status || "draft").replace(/_/g, " ").toUpperCase(),
      recruits: q.recruits || String(follows),
      heat: q.heat || `${heat}%`,
      creator: q.creator || shortWallet(draft.creator_wallet || ""),
      link: q.link || `${appBase.replace(/^https?:\/\//i, "")}/prepare/${draft.slug}`,
      description: q.description || description.slice(0, 280),
      logo: q.logo || q.logoUrl || logo,
      logoUrl: q.logoUrl || q.logo || logo,
    };
  } catch (err) {
    console.warn("[prepare-share-card] slug resolve failed", err?.message || err);
    return q;
  }
}

function clampText(value, max) {
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

function getRequestBaseUrl(req) {
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || "";
  if (host) {
    const proto = req?.headers?.["x-forwarded-proto"] || "https";
    return `${proto}://${host}`;
  }

  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  return /^https?:\/\//i.test(envUrl) ? envUrl.replace(/\/+$/, "") : "";
}

function publicAssetUrl(req, path) {
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

async function fetchImageResponse(clean) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(clean, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          // resvg 0.34 reliably decodes PNG/JPEG/GIF. Prefer those when the
          // upstream CDN supports content negotiation instead of asking for WebP/AVIF.
          accept: "image/png,image/jpeg,image/gif,image/svg+xml;q=0.9,*/*;q=0.1",
          "user-agent": "MemeWarzone-ShareCard/1.0",
        },
      });
      clearTimeout(timer);
      if (response.ok) return response;
      lastError = new Error(`image fetch failed (${response.status})`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError || new Error("image fetch failed");
}

async function imageToDataUrl(src) {
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
      console.warn(`[prepare-share-card] unsupported raster format from ${clean}: ${contentType}`);
      return "";
    }

    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn("[prepare-share-card] failed to embed logo", err?.message || err);
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

function svgCard(data, logoDataUrl = "", brandLogoDataUrl = "") {
  const name = String(data.name || "CAMPAIGN NAME").trim().toUpperCase();
  const ticker = String(data.ticker || "MWZ").replace(/^\$+/, "").trim().toUpperCase().slice(0, 12);
  const chain = String(data.chain || "BNB CHAIN").trim().toUpperCase();
  const status = String(data.status || "DRAFT").trim().toUpperCase();
  const recruits = safeNumberText(data.recruits, "0");
  const heat = safeNumberText(data.heat, "0%");
  const creator = String(data.creator || "@MEMEWARZONE").trim().toUpperCase();
  const link = clampText(data.link || `memewar.zone/d/${ticker.toLowerCase()}`, 34);
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

    ${pixelText("SOLDIERS FOLLOWS", 54, 438, { scale: 1.55, color: "#4d8066" })}
    ${pixelText(recruits, 54, 460, { scale: 2.8, color: "#10f58a", maxChars: 8 })}
    ${pixelText("HEAT", 215, 438, { scale: 1.55, color: "#4d8066" })}
    ${pixelText(heat, 215, 460, { scale: 2.8, color: "#10f58a", maxChars: 8 })}
    ${pixelText("BUILT BY", 335, 438, { scale: 1.55, color: "#4d8066" })}
    ${pixelText(creator, 335, 461, { scale: 2.05, color: "#e9e3db", maxChars: 18 })}
    ${pixelText("ARM NOTIFICATION", 790, 439, { scale: 1.6, color: "#4d8066", anchor: "middle" })}
    ${pixelText(link, 790, 461, { scale: 1.55, color: "#10f58a", maxChars: 34, anchor: "middle" })}
  </g>
</svg>`;
}

async function renderPng(svg) {
  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: 1002 },
    background: "rgba(0,0,0,0)",
  });
  return Buffer.from(renderer.render().asPng());
}

async function sendPng(req, res, svg, ticker) {
  const png = await renderPng(svg);
  const q = getQuery(req);
  const filename = `memewarzone-${String(ticker || "draft").toLowerCase()}-share-card.png`;
  const forceDownload = String(q.download || "") === "1";
  res.statusCode = 200;
  res.setHeader("content-type", "image/png");
  res.setHeader("content-length", String(png.length));
  // Downloads stay uncached; crawler cards use short public cache (slug or query card).
  if (forceDownload) {
    setNoStoreHeaders(res);
  } else {
    res.setHeader("cache-control", "public, max-age=120, s-maxage=300");
  }
  res.setHeader(
    "content-disposition",
    forceDownload ? `attachment; filename="${filename}"` : `inline; filename="${filename}"`,
  );
  // Allow social platforms to fetch the PNG even when site-wide CORP is same-origin.
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  res.end(png);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Method not allowed" });
  }
  try {
    const q = await resolveShareCardQuery(req);
    const logoDataUrl = await imageToDataUrl(q.logoUrl || q.logo || "");
    // Prefer app-hosted brand logo; Railway host may not serve /assets.
    const brandFallback =
      q.brandLogo ||
      q.brand ||
      `${String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "")}/assets/logo.png` ||
      publicAssetUrl(req, "/assets/logo.png");
    const brandLogoDataUrl = await imageToDataUrl(brandFallback);
    const svg = svgCard(q, logoDataUrl, brandLogoDataUrl);
    if (String(q.format || "png").toLowerCase() === "svg") {
      res.statusCode = 200;
      res.setHeader("content-type", "image/svg+xml; charset=utf-8");
      // Short-lived public cache so X/Twitter can re-fetch reliably.
      res.setHeader("cache-control", "public, max-age=120, s-maxage=300");
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(svg);
      return;
    }
    if (req.method === "HEAD") {
      // Cheap HEAD for crawlers that probe before downloading the PNG.
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.setHeader("cache-control", "public, max-age=120, s-maxage=300");
      res.end();
      return;
    }
    return sendPng(req, res, svg, q.ticker || "draft");
  } catch (err) {
    console.error("[prepare-share-card]", err);
    return json(res, 500, { error: "Failed to render share card" });
  }
}

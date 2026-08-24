import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getQuery, json } from "../server/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let logoBase64 = "";

async function getLogoBase64() {
  if (logoBase64) return logoBase64;
  try {
    const logoPath = path.join(__dirname, "../public/images/mw.png");
    console.log("[discord-notification-image] Loading local logo from", logoPath);
    const data = await fs.readFile(logoPath);
    logoBase64 = `data:image/png;base64,${data.toString("base64")}`;
    console.log("[discord-notification-image] Successfully loaded local logo");
  } catch (err) {
    console.error("Failed to load mw.png", err);
    logoBase64 = ""; // fallback
  }
  return logoBase64;
}

async function fetchImageBase64(url, fallback = "") {
  if (!url) {
    console.log("[discord-notification-image] No tokenUrl provided, skipping image fetch");
    return fallback;
  }
  try {
    console.log("[discord-notification-image] Fetching external image:", url);
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      console.log("[discord-notification-image] Fetch failed with status:", res.status, url);
      return fallback;
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get("content-type") || "image/png";
    console.log(`[discord-notification-image] Successfully fetched image: ${url} (${buffer.length} bytes, ${contentType})`);
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.error("[discord-notification-image] Failed to fetch image", url, err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampText(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

// ---------------------------------------------------------------------------
// MemeWarzone Pixel Font Engine
// ---------------------------------------------------------------------------

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
  ">": ["00000", "10000", "01000", "00100", "01000", "10000", "00000"],
};

function normalizePixelText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9 .,:/\-_@$%#!?'()+>]/g, " ");
}

function getPixelTextWidth(value, scale = 4, spacing = null) {
  const text = normalizePixelText(value);
  const actualSpacing = spacing ?? scale;
  const charWidth = 5 * scale + actualSpacing;
  return text.length > 0 ? text.length * charWidth - actualSpacing : 0;
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

function getChainColors(chain) {
  const c = String(chain || "BNB").toUpperCase();
  if (c === "SOL" || c === "SOLANA") {
    return { text: "#000000", bg: "url(#solGradient)", stroke: "url(#solGradient)", isGradient: true, glow: "#9945FF" };
  }
  if (c === "BNB" || c === "BSC") return { text: "#f0b90b", bg: "#292005", stroke: "#f0b90b", glow: "#f0b90b" };
  return { text: "#10f58a", bg: "#132a1e", stroke: "#10f58a", glow: "#10f58a" };
}

function renderChainPill(chain, x, y, scale = 3) {
  const chainText = String(chain || "BNB").toUpperCase();
  const { text, bg, stroke, isGradient } = getChainColors(chainText);
  const textWidth = getPixelTextWidth(chainText, scale);
  const paddingX = 16;
  const paddingY = 8;
  const charHeight = 7 * scale;
  const totalWidth = textWidth + paddingX * 2;
  const totalHeight = charHeight + paddingY * 2;
  const startX = x - totalWidth / 2;
  const startY = y - paddingY;

  return `
    <rect x="${startX}" y="${startY}" width="${totalWidth}" height="${totalHeight}" rx="12" fill="${bg}" stroke="${stroke}" stroke-opacity="${isGradient ? "1" : "0.3"}"/>
    ${pixelText(chainText, x, y, { scale, color: text, anchor: "middle" })}
  `;
}

function renderCampaignLabel(name, ticker, x, y, scale = 4, anchor = "middle", color = "#ffffff") {
  const n = String(name || "").trim();
  const t = String(ticker || "").trim();
  
  // Render name and ticker on separate lines
  if (n && t && n.toLowerCase() !== t.toLowerCase()) {
    return `
      ${pixelText(n, x, y, { scale, color, anchor })}
      ${pixelText(`$${t}`, x, y + (7 * scale) + 10, { scale: Math.max(2, scale - 1), color: "#aaaaaa", anchor })}
    `;
  }
  return pixelText(`$${t || n}`, x, y, { scale, color, anchor });
}

// ---------------------------------------------------------------------------
// Layout Designs
// ---------------------------------------------------------------------------

async function getBaseSvg(content, options = {}) {
  const primaryGlow = options.primaryGlow || "#10f58a";
  const secondaryGlow = options.secondaryGlow || "#00ff88";
  const backdropImg = options.backdropImage || await getLogoBase64();
  const smallLogo = await getLogoBase64();
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1002" height="531" viewBox="0 0 1002 531" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1002" y2="531" gradientUnits="userSpaceOnUse">
      <stop stop-color="#06170d"/><stop offset="0.48" stop-color="#030907"/><stop offset="1" stop-color="#130804"/>
    </linearGradient>
    <linearGradient id="solGradient" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/>
    </linearGradient>
    <radialGradient id="orbGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(501 265) rotate(90) scale(200)">
      <stop stop-color="${secondaryGlow}" stop-opacity="0.35"/><stop offset="1" stop-color="${secondaryGlow}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="33" height="33" patternUnits="userSpaceOnUse"><path d="M33 0H0V33" stroke="${primaryGlow}" stroke-opacity="0.055"/></pattern>
    <filter id="textGlow" x="-20%" y="-20%" width="140%" height="140%">
      <!-- Dense, soft black glow for readability -->
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000000" flood-opacity="0.95"/>
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#000000" flood-opacity="0.85"/>
      <feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#000000" flood-opacity="0.75"/>
    </filter>
    <clipPath id="circleClip" clipPathUnits="objectBoundingBox">
      <circle cx="0.5" cy="0.5" r="0.5"/>
    </clipPath>
  </defs>

  <rect width="1002" height="531" fill="url(#bg)"/>
  ${backdropImg ? `<g opacity="0.65"><image x="251" y="15" width="500" height="500" href="${backdropImg}" clip-path="url(#circleClip)" preserveAspectRatio="xMidYMid slice" /></g>` : ""}
  <rect width="1002" height="531" fill="url(#grid)"/>
  <rect width="1002" height="531" fill="url(#orbGlow)" opacity="0.65"/>
  <rect x="0" y="0" width="1002" height="10" fill="#070707"/>
  ${Array.from({ length: 44 }).map((_, i) => `<path d="M${i * 24} 0H${i * 24 + 12}L${i * 24 + 2} 10H${i * 24 - 10}L${i * 24} 0Z" fill="#7b421c" fill-opacity="0.52"/>`).join("")}
  <rect x="0" y="521" width="1002" height="10" fill="#070707"/>
  ${Array.from({ length: 44 }).map((_, i) => `<path d="M${i * 24} 521H${i * 24 + 12}L${i * 24 + 2} 531H${i * 24 - 10}L${i * 24} 521Z" fill="#7b421c" fill-opacity="0.52"/>`).join("")}
  
  ${smallLogo ? `<image x="40" y="40" width="80" height="80" href="${smallLogo}" />` : ""}

  <g filter="url(#textGlow)">
    ${content}
  </g>
</svg>`;
}

async function buildLaunchDigest(payload) {
  const { launches = [], chain = "BNB" } = payload;
  
  let listItems = "";
  for (let i = 0; i < Math.min(launches.length, 5); i++) {
    const l = launches[i];
    const yCenter = 230 + i * 50;
    
    listItems += `${pixelText(`> ${clampText(l.name || l.campaign || "Token", 15)}`, 200, yCenter - 10, { scale: 4, color: "#dfffee", anchor: "start" })}
                  ${pixelText(`${Math.round(l.progressPct || 0)}%`, 800, yCenter - 10, { scale: 4, color: "#10f58a", anchor: "end" })}`;
  }

  const colors = getChainColors(chain);
  return await getBaseSvg(`
    ${pixelText("LAUNCH DIGEST", 501, 80, { scale: 7, color: "#10f58a", anchor: "middle" })}
    ${renderChainPill(chain, 501, 150, 3)}
    ${listItems}
  `, { primaryGlow: colors.glow, secondaryGlow: colors.glow });
}

async function buildUserJoined(payload) {
  const { username = "New User", avatarUrl } = payload;
  const avatarImg = await fetchImageBase64(avatarUrl);
  
  const usernameText = `@${clampText(username, 15)}`;
  const textScale = 5;
  const textWidth = getPixelTextWidth(usernameText, textScale);
  
  const avatarSize = 90;
  const gap = 25;
  const totalWidth = avatarSize + gap + textWidth;
  const startX = 501 - (totalWidth / 2);
  
  const avatarX = startX;
  const avatarY = 270;
  const textX = startX + avatarSize + gap;
  // Character height is 7 * scale. Align text vertically to the center of the avatar.
  const textY = avatarY + (avatarSize / 2) - ((7 * textScale) / 2);

  let content = `
    ${pixelText("NEW RECRUIT", 501, 160, { scale: 8, color: "#10f58a", anchor: "middle" })}
    
    ${avatarImg ? `<image x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" href="${avatarImg}" clip-path="url(#circleClip)" preserveAspectRatio="xMidYMid slice" />` : ""}
    ${pixelText(usernameText, textX, textY, { scale: textScale, color: "#dfffee", anchor: "start" })}
  `;

  return await getBaseSvg(content, { primaryGlow: "#10f58a", secondaryGlow: "#10f58a" });
}

async function buildTrendingDigest(payload) {
  const { sections = [], chain = "BNB" } = payload;
  let content = `
    ${pixelText("TRENDING DIGEST", 501, 70, { scale: 7, color: "#00eeff", anchor: "middle" })}
    ${renderChainPill(chain, 501, 130, 3)}
  `;

  let yOffset = 180;
  for (const sec of sections.slice(0, 2)) {
    content += pixelText(`// ${sec.title}`, 200, yOffset, { scale: 3, color: "#00eeff", anchor: "start" });
    yOffset += 40;
    for (const l of (sec.items || []).slice(0, 3)) {
      content += `${pixelText(`> ${clampText(l.name || l.campaign || "Token", 15)}`, 230, yOffset, { scale: 3, color: "#dfffee", anchor: "start" })}
                  ${pixelText(`${Math.round(l.progressPct || 0)}%`, 800, yOffset, { scale: 3, color: "#00eeff", anchor: "end" })}`;
      yOffset += 40;
    }
    yOffset += 10;
  }

  return await getBaseSvg(content, { primaryGlow: "#00eeff", secondaryGlow: "#0088ff" });
}

async function buildProgressThresholdAlert(payload) {
  const { campaign = "", name = "", chain = "BNB", threshold = 0, tokenUrl } = payload;
  const tokenImg = await fetchImageBase64(tokenUrl);
  
  return await getBaseSvg(`
    ${pixelText("NEAR GRADUATION", 501, 110, { scale: 7, color: "#ff4400", anchor: "middle" })}
    
    ${renderChainPill(chain, 501, 190, 3)}
    ${renderCampaignLabel(name, campaign, 501, 280, 6, "middle", "#ffffff")}
    ${pixelText(`${Math.round(threshold)}% PROGRESS`, 501, 390, { scale: 5, color: "#ff4400", anchor: "middle" })}
  `, { primaryGlow: "#ff4400", secondaryGlow: "#ff0000", backdropImage: tokenImg });
}

async function buildCampaignMilestone(payload) {
  const { campaign = "", name = "", chain = "BNB", milestone = 0, tokenUrl } = payload;
  const tokenImg = await fetchImageBase64(tokenUrl);

  const colors = getChainColors(chain);
  return await getBaseSvg(`
    ${pixelText("MILESTONE REACHED", 501, 110, { scale: 7, color: "#10f58a", anchor: "middle" })}
    
    ${renderChainPill(chain, 501, 190, 3)}
    ${renderCampaignLabel(name, campaign, 501, 280, 6, "middle", "#ffffff")}
    ${pixelText(`${Math.round(milestone)}% PROGRESS`, 501, 390, { scale: 5, color: "#10f58a", anchor: "middle" })}
  `, { backdropImage: tokenImg, primaryGlow: colors.glow, secondaryGlow: colors.glow });
}

async function buildGraduationAlert(payload) {
  const { campaign = "", name = "", chain = "BNB", creatorReward, tokenUrl } = payload;
  const tokenImg = await fetchImageBase64(tokenUrl);

  const colors = getChainColors(chain);
  return await getBaseSvg(`
    ${pixelText("GRADUATION ALERT", 501, 110, { scale: 8, color: "#f39b3d", anchor: "middle" })}
    
    ${renderChainPill(chain, 501, 200, 3)}
    ${renderCampaignLabel(name, campaign, 501, 290, 6, "middle", "#ffffff")}
    ${creatorReward ? pixelText(`REWARD: ${creatorReward}`, 501, 400, { scale: 5, color: "#10f58a", anchor: "middle" }) : ""}
  `, { backdropImage: tokenImg, primaryGlow: colors.glow, secondaryGlow: colors.glow });
}

async function buildDailyRecap(payload) {
  const { date = "", references = [] } = payload;
  let content = `
    ${pixelText("DAILY RECAP", 501, 80, { scale: 7, color: "#ffffff", anchor: "middle" })}
    ${pixelText(`DATE: ${date}`, 501, 140, { scale: 3, color: "#aaaaaa", anchor: "middle" })}
  `;

  let yOffset = 210;
  references.slice(0, 6).forEach((ref) => {
    content += pixelText(`- ${clampText(ref.summary || "", 45)}`, 100, yOffset, { scale: 3, color: "#dfffee" });
    yOffset += 45;
  });

  return await getBaseSvg(content, { primaryGlow: "#ffffff", secondaryGlow: "#aaaaaa" });
}

// ---------------------------------------------------------------------------
// Render & Handler
// ---------------------------------------------------------------------------

async function renderPng(svg) {
  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: 1002 },
    background: "rgba(0,0,0,0)",
  });
  return Buffer.from(renderer.render().asPng());
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    if (typeof json === "function") return json(res, 405, { error: "Method not allowed" });
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const payload = req.method === "POST" ? req.body : (typeof getQuery === "function" ? getQuery(req) : req.query);
    const type = payload.type || payload.event_type;
    console.log(`[discord-notification-image] Generating SVG for event type: ${type}`, JSON.stringify(payload));

    let svg = "";
    switch (type) {
      case "campaign.launch_digest_ready":
        svg = await buildLaunchDigest(payload);
        break;
      case "campaign.trending_digest_ready":
        svg = await buildTrendingDigest(payload);
        break;
      case "campaign.progress_threshold_reached":
        svg = await buildProgressThresholdAlert(payload);
        break;
      case "campaign.milestone_reached":
        svg = await buildCampaignMilestone(payload);
        break;
      case "campaign.graduated":
        svg = await buildGraduationAlert(payload);
        break;
      case "platform.daily_recap_ready":
        svg = await buildDailyRecap(payload);
        break;
      case "user.joined":
        svg = await buildUserJoined(payload);
        break;
      default:
        svg = await getBaseSvg(pixelText("NOTIFICATION", 501, 250, { scale: 7, color: "#ffffff", anchor: "middle" }));
    }

    const png = await renderPng(svg);

    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("content-length", String(png.length));
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.end(png);
  } catch (err) {
    console.error("[discord-notification-image]", err);
    if (typeof json === "function") return json(res, 500, { error: "Failed to render image" });
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Failed to render image" }));
  }
}

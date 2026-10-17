/**
 * Story Mode routes (2026-09-28).
 *   GET  /api/story?chainId=&token=              the story (contract: shared/storyContract.mjs)
 *   GET  /api/story/card/:chainId/:token.png     1200x630 share card
 *   GET  /s/:chainId/:token                      share link: Open Graph tags for crawlers, then the app
 *   POST /api/story/profile                      the verified owner saves the short story + full-story boxes
 *
 * Stories are cached per coin for 5 minutes (one build at a time per coin). A story that fails the
 * contract is never served. Writes are strict wallet-signed actions by the coin's verified owner.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../server/db.js";
import { getQuery, json, readJson } from "../server/http.js";
import { STORY_FULL_SECTIONS, STORY_SHORT_MAX } from "../shared/storyContract.mjs";
import { buildStory } from "./lib/storyBuilder.mjs";
import { storyFacts } from "./lib/storyFacts.js";
import { logoAssets } from "./lib/storyImages.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { activeBlockForPublic } from "./lib/blockedCoins.js";

const TTL_MS = 5 * 60_000;
const cache = new Map();
const inflight = new Map();
const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILES = ["Bungee-Regular.ttf", "BarlowCondensed-Bold.ttf", "BarlowCondensed-SemiBold.ttf"].map((f) => path.join(here, "assets", "fonts", f));

const isSolana = (chainId) => Number(chainId) === 101;
const ident = (chainId, token) => {
  const t = String(token || "").trim();
  if (isSolana(chainId)) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) ? t : "";
  return /^0x[a-fA-F0-9]{40}$/.test(t) ? t.toLowerCase() : "";
};
const appBase = () => String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "");

export async function loadStory(chainId, token, { fresh = false } = {}) {
  // A blocked coin (Command Center -> Abuse, hide or remove) has no story, no card and no share preview.
  if (await activeBlockForPublic(pool, chainId, token)) return null;
  const key = `${chainId}:${token}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.story;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const facts = await storyFacts(chainId, token);
    if (!facts) return null;
    const { story, problems } = buildStory(facts);
    if (problems.length) {
      console.warn("[api/story] story failed the contract", key, problems);
      return null;
    }
    cache.set(key, { at: Date.now(), story });
    return story;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function handleStory(req, res) {
  const q = getQuery(req);
  const chainId = Number(q.chainId || 0);
  const token = ident(chainId, q.token || q.tokenAddress);
  if (!chainId || !token) return json(res, 400, { error: "chainId and token are required", code: "STORY_IDENTITY_REQUIRED" });
  const story = await loadStory(chainId, token);
  if (!story) return json(res, 404, { error: "No story for this coin", code: "STORY_UNAVAILABLE" });
  res.setHeader("cache-control", "public, max-age=60, s-maxage=120");
  return json(res, 200, story);
}

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Title size so the name fits the card's text column (Bungee is wide: ~0.72em per glyph). */
function titleSize(name) {
  return Math.max(44, Math.min(104, Math.floor(620 / (Math.max(4, name.length) * 0.72))));
}

export function cardSvg(story, logoDataUri) {
  const c = story.coin;
  const hook = story.share.text.replace(/\s*Watch the story\.?$/, "");
  const words = hook.split(/\s+/);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= 38) lines[lines.length - 1] = `${last} ${w}`;
    else if (lines.length < 3) lines.push(w);
  }
  const size = titleSize(c.name);
  const nameLines = c.name.length > 13 && c.name.includes(" ") ? [c.name.slice(0, c.name.lastIndexOf(" ", 13) > 0 ? c.name.lastIndexOf(" ", 13) : c.name.indexOf(" ")), c.name.slice((c.name.lastIndexOf(" ", 13) > 0 ? c.name.lastIndexOf(" ", 13) : c.name.indexOf(" ")) + 1)] : [c.name];
  const nameSize = nameLines.length > 1 ? Math.min(size * 1.4, 96) : size;
  const nameY0 = 250 - (nameLines.length - 1) * nameSize * 0.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="30%" cy="55%" r="65%"><stop offset="0" stop-color="${esc(c.accent2)}" stop-opacity=".75"/><stop offset=".6" stop-color="#07060b" stop-opacity="1"/></radialGradient>
    <clipPath id="art"><rect x="70" y="95" width="440" height="440" rx="36"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#07060b"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="62" y="87" width="456" height="456" rx="42" fill="none" stroke="${esc(c.accent)}" stroke-width="5"/>
  ${logoDataUri ? `<image x="70" y="95" width="440" height="440" clip-path="url(#art)" preserveAspectRatio="xMidYMid slice" xlink:href="${logoDataUri}"/>` : `<rect x="70" y="95" width="440" height="440" rx="36" fill="${esc(c.accent2)}"/>`}
  <rect x="570" y="96" width="330" height="40" rx="6" fill="#f06a1a" fill-opacity=".14" stroke="#f06a1a" stroke-opacity=".7"/>
  <circle cx="592" cy="116" r="6" fill="#f06a1a"/>
  <text x="608" y="123" font-family="Barlow Condensed" font-weight="700" font-size="21" letter-spacing="2" fill="#ffb27a">MEMEWARZONE STORY</text>
  ${nameLines.map((line, i) => `<text x="570" y="${nameY0 + i * nameSize * 0.98}" font-family="Bungee" font-size="${nameSize}" fill="#eeece2">${esc(line.toUpperCase())}</text>`).join("\n  ")}
  <text x="572" y="${nameY0 + (nameLines.length - 1) * nameSize * 0.98 + 48}" font-family="Barlow Condensed" font-weight="700" font-size="30" letter-spacing="3" fill="${esc(c.accent)}">$${esc(c.ticker)} · ${esc(c.chainLabel.toUpperCase())}</text>
  ${lines.map((line, i) => `<text x="572" y="${412 + i * 40}" font-family="Barlow Condensed" font-weight="600" font-size="34" fill="#eeece2">${esc(line)}</text>`).join("\n  ")}
  <rect x="570" y="518" width="296" height="60" rx="30" fill="${esc(c.accent)}"/>
  <text x="718" y="557" text-anchor="middle" font-family="Bungee" font-size="24" fill="#0a0908">▶ WATCH THE STORY</text>
</svg>`;
}

async function handleCard(req, res, chainId, file) {
  const token = ident(chainId, String(file || "").replace(/\.png$/i, ""));
  if (!token) return json(res, 400, { error: "Bad token" });
  const story = await loadStory(chainId, token);
  if (!story) return json(res, 404, { error: "No story for this coin", code: "STORY_UNAVAILABLE" });
  const assets = await logoAssets(story.coin.logoUrl);
  const logo = assets.png ? `data:image/png;base64,${assets.png.toString("base64")}` : null;
  const { Resvg } = await import("@resvg/resvg-js");
  const png = new Resvg(cardSvg(story, logo), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontFiles: FONT_FILES.filter((f) => fs.existsSync(f)), loadSystemFonts: false, defaultFontFamily: "Barlow Condensed" },
  }).render().asPng();
  res.statusCode = 200;
  res.setHeader("content-type", "image/png");
  res.setHeader("cache-control", "public, max-age=600, s-maxage=600");
  res.end(png);
}

export async function handleSharePage(req, res) {
  const chainId = Number(req.params?.chainId || 0);
  const token = ident(chainId, req.params?.token);
  // Blocked coin: 404 with the plain MemeWarzone preview, no coin card, and no link to its story.
  const blocked = token ? await activeBlockForPublic(pool, chainId, token) : null;
  const target = token && !blocked ? `${appBase()}/story/${chainId}/${token}` : appBase();
  const story = token && !blocked ? await loadStory(chainId, token).catch(() => null) : null;
  const title = story ? `${story.coin.name} ($${story.coin.ticker}) · MemeWarzone story` : "MemeWarzone";
  const description = story ? story.share.text : "Launch. Trade. Compete. Earn.";
  const image = story ? story.share.imageUrl : `${appBase()}/og-image.png`;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(target)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="MemeWarzone">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(story ? story.share.url : target)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:secure_url" content="${esc(image)}">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@memewarzone">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head><body style="background:#07060b;color:#eeece2;font-family:sans-serif">
<p><a href="${esc(target)}" style="color:#ffb27a">Open the story</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`;
  res.statusCode = blocked ? 404 : 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=120, s-maxage=300");
  res.end(req.method === "HEAD" ? undefined : html);
}

/** The wallet allowed to write a coin's story text: the verified owner of an import, or a launch's creator. */
async function storyOwner(chainId, token) {
  const match = isSolana(chainId) ? "token_address = $2" : "lower(token_address) = lower($2)";
  const imp = (await pool.query(`select token_address, project_owner_wallet, ownership_status from public.arena_token_imports where chain_id = $1 and ${match} limit 1`, [chainId, token])).rows[0];
  if (imp) return imp.ownership_status === "ownership_verified" && imp.project_owner_wallet ? { wallet: String(imp.project_owner_wallet), token: String(imp.token_address), origin: "imported" } : null;
  const camp = (await pool.query(
    `select token_address, campaign_address, creator_address from public.campaigns where chain_id = $1 and (${isSolana(chainId) ? "token_address = $2 or campaign_address = $2" : "lower(token_address) = lower($2) or lower(campaign_address) = lower($2)"}) limit 1`,
    [chainId, token],
  )).rows[0];
  return camp?.creator_address ? { wallet: String(camp.creator_address), token: String(camp.token_address || camp.campaign_address), origin: "launched" } : null;
}

async function handleProfileWrite(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId || 0);
  const token = ident(chainId, body.token);
  if (!chainId || !token) return json(res, 400, { error: "chainId and token are required", code: "STORY_IDENTITY_REQUIRED" });
  const owner = await storyOwner(chainId, token);
  if (!owner) return json(res, 403, { error: "Only the verified owner of this coin can edit its story.", code: "STORY_NOT_OWNER" });
  const verified = await requireWalletActionAuth({
    res, pool, auth: body.auth, expectedWallet: owner.wallet, chainId, action: "story_profile_update",
    routeLabel: "story/profile", extraLines: [`Token: ${owner.token}`], strict: true,
  });
  if (!verified) return;

  const shortStory = String(body.shortStory ?? "").trim();
  if (shortStory.length > STORY_SHORT_MAX) return json(res, 400, { error: `The short story can be at most ${STORY_SHORT_MAX} characters.`, code: "STORY_SHORT_TOO_LONG" });
  if (owner.origin === "launched" && shortStory) return json(res, 400, { error: "Launched coins tell their short story on the promotion page.", code: "STORY_SHORT_IMPORTS_ONLY" });
  const sections = {};
  for (const def of STORY_FULL_SECTIONS) {
    const text = String(body.sections?.[def.key] ?? "").trim();
    if (text.length > def.max) return json(res, 400, { error: `"${def.heading}" can be at most ${def.max} characters.`, code: "STORY_SECTION_TOO_LONG", key: def.key });
    if (text) sections[def.key] = text;
  }
  await pool.query(
    `insert into public.token_story_profiles (chain_id, token_address, short_story, sections, updated_by, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, now())
     on conflict (chain_id, token_address) do update set short_story = excluded.short_story, sections = excluded.sections,
       updated_by = excluded.updated_by, updated_at = now()`,
    [chainId, owner.token, shortStory || null, JSON.stringify(sections), verified.walletAddress],
  );
  const story = await loadStory(chainId, owner.token, { fresh: true });
  return json(res, 200, { ok: true, story });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const p = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && p === "/story") return await handleStory(req, res);
    const card = p.match(/^\/story\/card\/(\d+)\/([^/]+)$/);
    if (method === "GET" && card) return await handleCard(req, res, Number(card[1]), decodeURIComponent(card[2]));
    if (method === "POST" && p === "/story/profile") return await handleProfileWrite(req, res);
    return json(res, 404, { error: `Unknown story route: ${p}` });
  } catch (error) {
    console.error("[api/story]", error);
    return json(res, 503, { error: "Story unavailable", detail: String(error?.message || error) });
  }
}

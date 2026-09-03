/**
 * Social crawler landing HTML for focused Battle Wall pages.
 * X/Twitter (and similar) do not execute SPA JS — they need server-rendered
 * og:/twitter: meta tags with an absolute share-card image URL.
 */
import { badMethod, getQuery, json } from "../server/http.js";
import { loadPublicBattleSharePayload } from "./lib/publicBattleSharePayload.mjs";
import { presentBattleShareCard } from "../src/lib/arena/battleShareCardPresentation.mjs";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ogHtml({ title, description, pageUrl, imageUrl, siteName = "MemeWarzone" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${esc(siteName)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:image" content="${esc(imageUrl)}" />
  <meta property="og:image:secure_url" content="${esc(imageUrl)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(title)}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@memewarzone" />
  <meta name="twitter:creator" content="@memewarzone" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(imageUrl)}" />
  <meta name="twitter:image:src" content="${esc(imageUrl)}" />
  <meta name="twitter:image:alt" content="${esc(title)}" />
  <!-- No meta-refresh: some crawlers (incl. X) re-fetch the target as a browser and drop OG tags. -->
</head>
<body style="background:#050505;color:#f5f5f5;font-family:system-ui,sans-serif;padding:2rem;">
  <p><a href="${esc(pageUrl)}" style="color:#f06a1a;">${esc(title)}</a></p>
  <p><img src="${esc(imageUrl)}" alt="${esc(title)}" width="1200" height="630" style="max-width:100%;height:auto;border:1px solid #333;" /></p>
</body>
</html>`;
}

function routeBattleId(req) {
  const q = getQuery(req);
  const fromQuery = String(q.battleId || q.id || "").trim();
  if (fromQuery) return fromQuery;
  const path = String(req.path || req.url || "");
  const match = path.match(/\/battle-og\/([^/?#]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return String(match[1] || "");
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return badMethod(res);

  try {
    const battleId = routeBattleId(req);
    if (!battleId) return json(res, 400, { error: "Missing battle id" });

    const payload = await loadPublicBattleSharePayload(battleId);
    if (!payload?.battle) return json(res, 404, { error: "Battle not found" });

    const appBase = String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "");
    const card = presentBattleShareCard(payload.battle, payload.metrics, {
      origin: appBase,
      requested: true,
      loaded: true,
    });
    // Canonical public page is /warzone/battles/:battleId from presentBattleShareCard.
    const pageUrl = `${appBase}${card.canonicalPath}`;
    const imageUrl = `${appBase}/api/battle-share-card?battleId=${encodeURIComponent(card.battleId)}&v=1`;
    const html = ogHtml({
      title: card.shareTitle,
      description: card.shareText,
      pageUrl,
      imageUrl,
    });

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60, s-maxage=120");
    res.setHeader("x-mwz-og", "battle");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(html);
  } catch (error) {
    console.error("[api/battle-og]", error);
    return json(res, 500, { error: "Failed to build battle OG page" });
  }
}

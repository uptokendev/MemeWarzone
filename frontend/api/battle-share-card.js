import { getQuery, json } from "../server/http.js";
import { loadPublicBattleSharePayload } from "./lib/publicBattleSharePayload.mjs";
import { presentBattleShareCard } from "../src/lib/arena/battleShareCardPresentation.mjs";
import { absoluteUrl, battleHudShareCardSvg, embedShareCardImage, renderHudShareCardPng } from "./lib/hudShareCardSvg.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Method not allowed" });
  }
  try {
    const q = getQuery(req);
    const battleId = String(q.battleId || q.id || "").trim();
    if (!battleId) return json(res, 400, { error: "Missing battle id" });

    const payload = await loadPublicBattleSharePayload(battleId);
    if (!payload?.battle) return json(res, 404, { error: "Battle not found" });

    const appBase = String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "");
    // embedShareCardImage is the token card's fetcher: public-address guard, size cap, and WebP/AVIF
    // (which resvg cannot draw) fall back to the ticker instead of a blank circle.
    const [leftImageDataUrl, rightImageDataUrl, brandLogoDataUrl] = await Promise.all([
      embedShareCardImage(absoluteUrl(appBase, payload.battle.participants?.[0]?.imageUrl)),
      embedShareCardImage(absoluteUrl(appBase, payload.battle.participants?.[1]?.imageUrl)),
      embedShareCardImage(`${appBase}/assets/logo.png`),
    ]);
    const card = presentBattleShareCard(payload.battle, payload.metrics, {
      origin: appBase,
      requested: true,
      loaded: true,
      votes: payload.votes,
      leftImageDataUrl,
      rightImageDataUrl,
      brandLogoDataUrl,
    });
    const svg = battleHudShareCardSvg({ ...card, brandLogo: card.brandLogo });

    if (String(q.format || "png").toLowerCase() === "svg") {
      res.statusCode = 200;
      res.setHeader("content-type", "image/svg+xml; charset=utf-8");
      res.setHeader("cache-control", "public, max-age=60, s-maxage=120");
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
      res.setHeader("cache-control", "public, max-age=60, s-maxage=120");
      res.end();
      return;
    }

    const png = await renderHudShareCardPng(svg);
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("content-length", String(png.length));
    // Short cache: the card carries a live score.
    res.setHeader("cache-control", "public, max-age=20, s-maxage=20");
    res.setHeader("cross-origin-resource-policy", "cross-origin");
    res.setHeader("content-disposition", `inline; filename="memewarzone-battle-${card.battleId}.png"`);
    res.setHeader("x-mwz-share-card", "battle");
    res.end(png);
  } catch (error) {
    console.error("[api/battle-share-card]", error);
    return json(res, 500, { error: "Failed to render battle share card" });
  }
}

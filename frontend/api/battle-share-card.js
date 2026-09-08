import { getQuery, json } from "../server/http.js";
import { loadPublicBattleSharePayload } from "./lib/publicBattleSharePayload.mjs";
import { battleShareCardSvg, presentBattleShareCard } from "../src/lib/arena/battleShareCardPresentation.mjs";

function absoluteUrl(base, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("ipfs://")) {
    let path = raw.slice("ipfs://".length);
    if (path.startsWith("ipfs/")) path = path.slice("ipfs/".length);
    return `https://cloudflare-ipfs.com/ipfs/${path}`;
  }
  if (raw.startsWith("ar://")) return `https://arweave.net/${raw.slice("ar://".length)}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  const cleanBase = String(base || "").replace(/\/+$/, "");
  if (raw.startsWith("/")) return cleanBase ? `${cleanBase}${raw}` : raw;
  return cleanBase ? `${cleanBase}/${raw.replace(/^\/+/, "")}` : raw;
}

async function imageToDataUrl(url) {
  const clean = String(url || "").trim();
  if (!clean) return "";
  if (clean.startsWith("data:image/")) return clean;
  try {
    const response = await fetch(clean, {
      headers: { "user-agent": "MemeWarzone-BattleShareCard/1.0" },
      redirect: "follow",
    });
    if (!response.ok) return "";
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim();
    if (contentType && !/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(contentType)) return "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const mime = contentType || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.warn("[battle-share-card] failed to embed image", error?.message || error);
    return "";
  }
}

async function renderPng(svg) {
  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "#050505",
  });
  return Buffer.from(renderer.render().asPng());
}

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
    const leftImageDataUrl = await imageToDataUrl(absoluteUrl(appBase, payload.battle.participants?.[0]?.imageUrl));
    const rightImageDataUrl = await imageToDataUrl(absoluteUrl(appBase, payload.battle.participants?.[1]?.imageUrl));
    const brandLogoDataUrl = await imageToDataUrl(`${appBase}/assets/logo.png`);
    const card = presentBattleShareCard(payload.battle, payload.metrics, {
      origin: appBase,
      requested: true,
      loaded: true,
      leftImageDataUrl,
      rightImageDataUrl,
      brandLogoDataUrl,
    });
    const svg = battleShareCardSvg(card);

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

    const png = await renderPng(svg);
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("content-length", String(png.length));
    res.setHeader("cache-control", "public, max-age=60, s-maxage=120");
    res.setHeader("cross-origin-resource-policy", "cross-origin");
    res.setHeader("content-disposition", `inline; filename="memewarzone-battle-${card.battleId}.png"`);
    res.setHeader("x-mwz-share-card", "battle");
    res.end(png);
  } catch (error) {
    console.error("[api/battle-share-card]", error);
    return json(res, 500, { error: "Failed to render battle share card" });
  }
}

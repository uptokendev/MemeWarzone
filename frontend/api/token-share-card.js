import { getQuery, json, readJson } from "../server/http.js";
import {
  embedShareCardImage,
  hudShareCardSvg,
  presentHudShareMetrics,
  publicAssetUrl,
  respondHudShareCard,
} from "./lib/hudShareCardSvg.mjs";

const MAX_SNAPSHOT_CHARS = 2_800_000;

function pick(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function tokenSharePayload(source = {}) {
  const ticker = pick(source, "ticker", "symbol").replace(/^\$+/, "");
  const snapshot = pick(source, "logoDataUrl", "snapshot", "logoSnapshot");
  const logoUrl = pick(source, "logoUrl", "logo", "image");
  return {
    name: pick(source, "name") || "TOKEN",
    ticker: ticker || "MWZ",
    chain: pick(source, "chain") || "BNB CHAIN",
    status: pick(source, "status") || "LIVE",
    description: pick(source, "description") || "Live market snapshot from MemeWarzone.",
    link: pick(source, "link", "pageUrl") || "app.memewar.zone",
    logoDataUrl: snapshot && snapshot.length <= MAX_SNAPSHOT_CHARS ? snapshot : "",
    logoUrl,
    metrics: [
      { label: "MCAP", value: pick(source, "mcap", "marketCap") || "—", maxChars: 10 },
      { label: "HOLDERS", value: pick(source, "holders") || "—", maxChars: 10 },
      { label: "VOLUME", value: pick(source, "volume") || "—", maxChars: 10 },
    ],
    right: { label: "TOKEN PAGE", value: pick(source, "link", "pageUrl") || "app.memewar.zone" },
    format: pick(source, "format") || "png",
    download: pick(source, "download") === "1" || source?.download === true,
  };
}

export { tokenSharePayload, presentHudShareMetrics };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }
  try {
    const body = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
    const payload = tokenSharePayload({ ...getQuery(req), ...body });
    const logoDataUrl =
      payload.logoDataUrl && /^data:image\//i.test(payload.logoDataUrl)
        ? payload.logoDataUrl
        : await embedShareCardImage(payload.logoUrl);
    const brandFallback =
      `${String(process.env.PUBLIC_APP_URL || "https://app.memewar.zone").replace(/\/+$/, "")}/assets/logo.png` ||
      publicAssetUrl(req, "/assets/logo.png");
    const brandLogoDataUrl = await embedShareCardImage(brandFallback);
    const svg = hudShareCardSvg(payload, logoDataUrl, brandLogoDataUrl);
    return respondHudShareCard(req, res, {
      svg,
      ticker: payload.ticker,
      format: payload.format,
      download: payload.download,
    });
  } catch (err) {
    console.error("[token-share-card]", err);
    return json(res, 500, { error: "Failed to render share card" });
  }
}

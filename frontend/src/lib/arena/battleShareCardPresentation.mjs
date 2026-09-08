import { warzoneTokenInitials } from "./warzoneChrome.mjs";
import { DATA_DELAY_LABEL, presentBattleWallModule } from "./battleWallPresentation.mjs";
import { presentBattleShare } from "./battleSharePresentation.mjs";

export const BATTLE_SHARE_CARD_WIDTH = 1200;
export const BATTLE_SHARE_CARD_HEIGHT = 630;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clipText(value, max = 18) {
  const raw = String(value || "").trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

export function presentBattleShareCard(battle, metrics, options = {}) {
  const share = presentBattleShare(battle, metrics, options);
  const presented = presentBattleWallModule(battle, metrics, options);
  const delayed = share.dataDelayed === true;
  const upcoming = share.state === "upcoming";
  const scoreCaption = delayed || upcoming ? null : share.scoreCaption;
  const leftImage = String(options.leftImageDataUrl || battle?.participants?.[0]?.imageUrl || "").trim() || null;
  const rightImage = String(options.rightImageDataUrl || battle?.participants?.[1]?.imageUrl || "").trim() || null;
  const brandLogo = String(options.brandLogoDataUrl || "").trim() || null;
  const stateLabel =
    delayed ? DATA_DELAY_LABEL : share.state === "finished" ? "FINISHED" : share.state === "upcoming" ? "DEPLOYING" : "LIVE";

  return {
    width: BATTLE_SHARE_CARD_WIDTH,
    height: BATTLE_SHARE_CARD_HEIGHT,
    battleId: share.battleId,
    canonicalPath: share.canonicalPath,
    canonicalUrl: share.canonicalUrl,
    shareTitle: share.shareTitle,
    shareText: share.shareText,
    leftTicker: share.leftTicker,
    rightTicker: share.rightTicker,
    leftInitials: warzoneTokenInitials(share.leftTicker, battle?.participants?.[0]?.tokenName),
    rightInitials: warzoneTokenInitials(share.rightTicker, battle?.participants?.[1]?.tokenName),
    leftImage,
    rightImage,
    brandLogo,
    state: share.state,
    stateLabel,
    scoreKind: share.scoreKind,
    scoreCaption,
    leftPointsLabel: delayed || upcoming ? null : share.leftPointsLabel,
    rightPointsLabel: delayed || upcoming ? null : share.rightPointsLabel,
    dataDelayed: delayed,
    winnerLabel: share.winnerLabel,
    brand: "MEMEWARZONE",
    urlLabel: String(share.canonicalUrl || share.canonicalPath || "").replace(/^https?:\/\//, ""),
    leftArtBleed: Boolean(leftImage),
    rightArtBleed: Boolean(rightImage),
    presentedTab: presented.tab,
  };
}

function artBlock({ image, initials, x, y, bleed }) {
  const size = 188;
  const clipId = `clip-${x}-${y}`;
  const bleedImage = image && bleed
    ? `<image href="${esc(image)}" x="${x - 36}" y="${y - 36}" width="${size + 72}" height="${size + 72}" opacity="0.18" preserveAspectRatio="xMidYMid slice"/>`
    : "";
  const portrait = image
    ? `<image href="${esc(image)}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#0a0c0c"/>
       <text x="${x + size / 2}" y="${y + size / 2 + 16}" text-anchor="middle" fill="#f06a1a" font-size="42" font-family="ui-monospace, monospace">${esc(initials)}</text>`;
  return `
    ${bleedImage}
    <defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${size}" height="${size}"/></clipPath></defs>
    ${portrait}
    <rect x="${x}" y="${y}" width="${size}" height="${size}" fill="url(#artReadability)" />
    <rect x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="rgba(178,174,160,0.34)" />
  `;
}

export function battleShareCardSvg(card) {
  const width = Number(card?.width || BATTLE_SHARE_CARD_WIDTH);
  const height = Number(card?.height || BATTLE_SHARE_CARD_HEIGHT);
  const leftTicker = clipText(card?.leftTicker || "$TOKEN", 14);
  const rightTicker = clipText(card?.rightTicker || "$TOKEN", 14);
  const scoreLine =
    card?.dataDelayed
      ? DATA_DELAY_LABEL
      : card?.leftPointsLabel && card?.rightPointsLabel
        ? `${card.leftPointsLabel}  ${card.scoreCaption || "POINTS"}  ${card.rightPointsLabel}`
        : card?.stateLabel || "BATTLE";
  const brandLogo = card?.brandLogo
    ? `<image href="${esc(card.brandLogo)}" x="48" y="36" width="56" height="56" preserveAspectRatio="xMidYMid meet"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${width}" y2="${height}" gradientUnits="userSpaceOnUse">
      <stop stop-color="#070808"/><stop offset="0.55" stop-color="#050505"/><stop offset="1" stop-color="#120804"/>
    </linearGradient>
    <linearGradient id="artReadability" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#000000" stop-opacity="0.08"/><stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="36" y="28" width="${width - 72}" height="${height - 56}" fill="rgba(4,6,6,0.44)" stroke="rgba(178,174,160,0.34)"/>
  ${brandLogo}
  <text x="${card?.brandLogo ? 118 : 56}" y="72" fill="#f5f1ea" font-size="28" font-family="ui-monospace, monospace" letter-spacing="6">${esc(card?.brand || "MEMEWARZONE")}</text>
  <text x="${width - 56}" y="72" text-anchor="end" fill="#f06a1a" font-size="22" font-family="ui-monospace, monospace" letter-spacing="4">${esc(card?.stateLabel || "LIVE")}</text>

  ${artBlock({ image: card?.leftImage, initials: card?.leftInitials || "MWZ", x: 92, y: 148, bleed: card?.leftArtBleed })}
  ${artBlock({ image: card?.rightImage, initials: card?.rightInitials || "MWZ", x: 920, y: 148, bleed: card?.rightArtBleed })}

  <g transform="translate(540 188)">
    <circle cx="60" cy="60" r="54" fill="none" stroke="#f06a1a" stroke-opacity="0.4" stroke-width="2"/>
    <circle cx="60" cy="60" r="28" fill="none" stroke="#f06a1a" stroke-opacity="0.35" stroke-width="1.5"/>
    <path d="M60 2 v16 M60 102 v16 M2 60 h16 M102 60 h16" stroke="#f06a1a" stroke-opacity="0.45" stroke-width="2"/>
    <text x="8" y="44" fill="#f06a1a" font-size="64" font-family="ui-monospace, monospace">V</text>
    <text x="68" y="108" fill="#f06a1a" font-size="64" font-family="ui-monospace, monospace">S</text>
  </g>

  <text x="186" y="372" text-anchor="middle" fill="#f5f1ea" font-size="30" font-family="ui-monospace, monospace">${esc(leftTicker)}</text>
  <text x="1014" y="372" text-anchor="middle" fill="#f5f1ea" font-size="30" font-family="ui-monospace, monospace">${esc(rightTicker)}</text>
  <text x="600" y="468" text-anchor="middle" fill="#d9d2ca" font-size="26" font-family="ui-monospace, monospace">${esc(scoreLine)}</text>
  <text x="600" y="548" text-anchor="middle" fill="#8c877c" font-size="18" font-family="ui-monospace, monospace">${esc(card?.urlLabel || "")}</text>
</svg>`;
}

export function battleShareCardImagePath(battleId) {
  const id = String(battleId || "").trim();
  if (!id) return "/api/battle-share-card";
  return `/api/battle-share-card?battleId=${encodeURIComponent(id)}`;
}

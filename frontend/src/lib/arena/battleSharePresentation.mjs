import { tickerFor } from "./arenaMatchRowPresentation.mjs";
import { DATA_DELAY_LABEL, presentBattleWallModule, battleWallHref } from "./battleWallPresentation.mjs";

function identityKey(value, chainId) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return Number(chainId) === 101 || Number(chainId) === 102 ? raw : raw.toLowerCase();
}

function asTicker(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return `$${raw.replace(/^\$/, "")}`;
}

export function battleShareAbsoluteUrl(canonicalPath, origin) {
  const path = String(canonicalPath || "").trim() || "/warzone/battles";
  const base = String(origin || "").replace(/\/$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function battleShareXIntentUrl(shareText, canonicalUrl) {
  const text = [String(shareText || "").trim(), String(canonicalUrl || "").trim()].filter(Boolean).join(" ");
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

function authoritativeWinnerTicker(battle) {
  const chainId = Number(battle?.chainId ?? battle?.chain_id ?? 0);
  const winnerToken = String(battle?.winnerToken || battle?.moneyWinnerToken || "").trim();
  if (!winnerToken) return null;
  const key = identityKey(winnerToken, chainId);
  const participant = (Array.isArray(battle?.participants) ? battle.participants : []).find((item) =>
    [item?.tokenId, item?.tokenAddress, item?.campaignAddress].some((value) => identityKey(value, chainId) === key),
  );
  return asTicker(participant?.symbol || participant?.tokenName);
}

export function presentBattleShare(battle, metrics, options = {}) {
  const presented = presentBattleWallModule(battle, metrics, options);
  const battleId = String(presented.battleId || battle?.id || "").trim();
  const canonicalPath = battleWallHref(battleId);
  const origin = String(options.origin || "").replace(/\/$/, "");
  const canonicalUrl = battleShareAbsoluteUrl(canonicalPath, origin);
  const leftTicker = presented.leftTicker || tickerFor(battle, 0);
  const rightTicker = presented.rightTicker || tickerFor(battle, 1);
  const tab = presented.tab || "live";
  const delayed = presented.scoreKind === "delay" || presented.statusLabel === DATA_DELAY_LABEL;
  const scoreKind = delayed ? "delay" : presented.scoreKind || "none";
  const winnerLabel = tab === "finished" ? authoritativeWinnerTicker(battle) : null;
  const tournament = presented.type === "tournament";
  const venue = tournament ? "a MemeWarzone tournament" : "MemeWarzone";

  let shareText = `${leftTicker} vs ${rightTicker} is live in ${venue}.`;
  if (tab === "upcoming") shareText = `${leftTicker} vs ${rightTicker} is deploying in ${venue}.`;
  if (tab === "finished") {
    const loserLabel =
      winnerLabel && winnerLabel === leftTicker ? rightTicker : winnerLabel && winnerLabel === rightTicker ? leftTicker : null;
    shareText =
      winnerLabel && loserLabel
        ? `${winnerLabel} defeated ${loserLabel} in ${venue}.`
        : `${leftTicker} vs ${rightTicker} is finished in ${venue}.`;
  }
  if (delayed) {
    shareText = `${shareText.replace(/\.\s*$/, "")}. ${DATA_DELAY_LABEL}.`;
  } else if (scoreKind === "battle_points" && presented.leftPointsLabel && presented.rightPointsLabel) {
    shareText = `${shareText.replace(/\.\s*$/, "")}. ${presented.leftPointsLabel}–${presented.rightPointsLabel} Battle Points.`;
  }

  const shareTitle = `${leftTicker} vs ${rightTicker} — MemeWarzone`;

  return {
    battleId,
    canonicalPath,
    canonicalUrl,
    state: tab,
    leftTicker,
    rightTicker,
    winnerLabel,
    scoreKind,
    scoreCaption: delayed ? null : presented.scoreCaption || null,
    leftPointsLabel: delayed ? null : presented.leftPointsLabel || null,
    rightPointsLabel: delayed ? null : presented.rightPointsLabel || null,
    dataDelayed: delayed,
    tournament,
    shareTitle,
    shareText,
    xIntentUrl: battleShareXIntentUrl(shareText, canonicalUrl),
  };
}

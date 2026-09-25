import { tickerFor } from "./arenaMatchRowPresentation.mjs";
import { DATA_DELAY_LABEL, presentBattleWallModule, battleWallHref } from "./battleWallPresentation.mjs";

const X_HANDLE = "@memewarzone";

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
  const where = tournament ? `in a ${X_HANDLE} tournament` : `on ${X_HANDLE}`;

  // Vote Battles score on confirmed votes (Free Vote 1, Boost 2): the caller passes the same tally the
  // card's VOTES box shows. Metrics battles keep their Battle Points.
  const voteBattle = String(battle?.battleMode || battle?.battle_mode || "").toLowerCase() === "vote" && !tournament;
  const votes = voteBattle && options.votes ? options.votes : null;
  let leftPointsLabel = delayed ? null : presented.leftPointsLabel || null;
  let rightPointsLabel = delayed ? null : presented.rightPointsLabel || null;
  let scoreCaption = delayed ? null : presented.scoreCaption || null;
  let effectiveScoreKind = scoreKind;
  if (votes && !delayed && tab !== "upcoming") {
    leftPointsLabel = String(Math.max(0, Number(votes.leftPoints) || 0));
    rightPointsLabel = String(Math.max(0, Number(votes.rightPoints) || 0));
    scoreCaption = "Votes";
    effectiveScoreKind = "vote";
  }
  const scored = !delayed && (effectiveScoreKind === "battle_points" || effectiveScoreKind === "vote") && leftPointsLabel && rightPointsLabel;
  const leftScore = scored ? Number(leftPointsLabel) : NaN;
  const rightScore = scored ? Number(rightPointsLabel) : NaN;
  let leaderIndex = null;
  if (winnerLabel && winnerLabel === leftTicker) leaderIndex = 0;
  else if (winnerLabel && winnerLabel === rightTicker) leaderIndex = 1;
  else if (tab !== "finished" && Number.isFinite(leftScore) && Number.isFinite(rightScore) && leftScore !== rightScore) {
    leaderIndex = leftScore > rightScore ? 0 : 1;
  }
  const unit = effectiveScoreKind === "vote" ? "in votes" : "Battle Points";
  const high = leaderIndex === 1 ? rightPointsLabel : leftPointsLabel;
  const low = leaderIndex === 1 ? leftPointsLabel : rightPointsLabel;
  const leaderTicker = leaderIndex === 0 ? leftTicker : leaderIndex === 1 ? rightTicker : null;
  const trailerTicker = leaderIndex === 0 ? rightTicker : leaderIndex === 1 ? leftTicker : null;

  let shareText;
  if (tab === "upcoming") {
    shareText = `🚨 ${leftTicker} vs ${rightTicker} is deploying ${where}. Rally your army, the war starts soon ⚔️`;
  } else if (tab === "finished") {
    shareText = winnerLabel && trailerTicker
      ? `🏆 ${winnerLabel} crushed ${trailerTicker} ${where}!${scored ? ` Final: ${high}–${low} ${unit}.` : ""} Who's next? ⚔️`
      : `⚔️ ${leftTicker} vs ${rightTicker} is over ${where}. See how the war ended.`;
  } else {
    const head = `⚔️ ${leftTicker} vs ${rightTicker} is LIVE ${where}!`;
    const cta = effectiveScoreKind === "vote"
      ? "Pick your side: vote free and boost your army before the clock runs out 🔥"
      : "Pick your side and push your coin to victory 🔥";
    if (delayed) shareText = `${head} ${DATA_DELAY_LABEL}. ${cta}`;
    else if (scored && leaderTicker) shareText = `${head} ${leaderTicker} leads ${high}–${low} ${unit}. ${cta}`;
    else if (scored) shareText = `${head} Dead even at ${leftPointsLabel}–${rightPointsLabel} ${unit}. ${cta}`;
    else shareText = `${head} ${cta}`;
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
    scoreKind: effectiveScoreKind,
    scoreCaption,
    leftPointsLabel,
    rightPointsLabel,
    leaderIndex,
    dataDelayed: delayed,
    tournament,
    shareTitle,
    shareText,
    xIntentUrl: battleShareXIntentUrl(shareText, canonicalUrl),
  };
}

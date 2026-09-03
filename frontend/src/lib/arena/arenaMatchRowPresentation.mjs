export const FEED_METRICS_LIMIT = 12;
export const BATTLE_POINTS_MODE = "battle_points_v2";
export const LEGACY_SETTLEMENT_MODE = "v1_mcap_pct_change";
export const DATA_DELAY_LABEL = "DATA DELAY";
export const POINTS_UNAVAILABLE_LABEL = "BATTLE POINTS UNAVAILABLE";

function feedLane(state) {
  const value = String(state || "").toLowerCase();
  if (value === "live") return "live";
  if (value === "finished" || value === "completed" || value === "settled") return "finished";
  return "waiting";
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatFeedPoints(value) {
  const amount = finiteNumber(value);
  if (amount == null) return null;
  return amount.toFixed(1);
}

export function tickerFor(battle, index) {
  const participant = battle?.participants?.[index];
  if (!participant) return "TBD";
  const symbol = String(participant.symbol || "").trim();
  if (symbol && symbol !== "TBD") return `$${symbol.replace(/^\$/, "")}`;
  return String(participant.tokenName || "Unknown");
}

export function listHintsBattlePoints(battle) {
  const scoring = String(battle?.settlementScoringVersion || "").toLowerCase();
  if (scoring.includes("battle_points")) return true;
  const version = Number(battle?.settlementVersion ?? battle?.settlement_version);
  return Number.isFinite(version) && version >= 2;
}

export function battleNeedsFeedMetrics(battle) {
  const lane = feedLane(battle?.state);
  if (lane === "waiting") return false;
  if (lane === "live") return true;
  return listHintsBattlePoints(battle);
}

export function selectFeedMetricBattleIds(battles, limit = FEED_METRICS_LIMIT) {
  const cap = Math.max(0, Math.min(Number(limit) || FEED_METRICS_LIMIT, FEED_METRICS_LIMIT));
  const ids = [];
  const seen = new Set();
  for (const battle of Array.isArray(battles) ? battles : []) {
    if (ids.length >= cap) break;
    const id = String(battle?.id || "").trim();
    if (!id || seen.has(id) || !battleNeedsFeedMetrics(battle)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function pickSidePoints(metrics, side) {
  const final = finiteNumber(metrics?.finalBattlePoints?.[side]);
  if (final != null) return final;
  return finiteNumber(metrics?.sides?.[side]?.points?.total);
}

function legacyPresentation(battle, base) {
  const left = finiteNumber(battle?.participants?.[0]?.score) ?? 0;
  const right = finiteNumber(battle?.participants?.[1]?.score) ?? 0;
  let leaderIndex = null;
  if (battle?.leaderSide === "left") leaderIndex = 0;
  else if (battle?.leaderSide === "right") leaderIndex = 1;
  else {
    const flagged = Array.isArray(battle?.participants)
      ? battle.participants.findIndex((participant) => participant?.isLeading === true)
      : -1;
    if (flagged === 0 || flagged === 1) leaderIndex = flagged;
  }
  const gap = Math.abs(left - right);
  return {
    ...base,
    scoreKind: "legacy",
    scoreCaption: "Score",
    leftPointsLabel: formatFeedPoints(left),
    rightPointsLabel: formatFeedPoints(right),
    leaderIndex,
    gapLabel: gap > 0 ? `Gap ${formatFeedPoints(gap)}` : null,
    statusLabel: null,
  };
}

export function presentArenaMatchRow(battle, metrics, options = {}) {
  const lane = feedLane(battle?.state);
  const battleId = String(battle?.id || "").trim();
  const base = {
    battleId,
    lane,
    href: battleId ? `/battle/${encodeURIComponent(battleId)}` : "/battle/",
    leftTicker: tickerFor(battle, 0),
    rightTicker: tickerFor(battle, 1),
  };

  if (lane === "waiting") {
    return {
      ...base,
      scoreKind: "none",
      scoreCaption: null,
      leftPointsLabel: null,
      rightPointsLabel: null,
      leaderIndex: null,
      gapLabel: null,
      statusLabel: null,
    };
  }

  const requested = options.requested === true;
  const loaded = options.loaded === true;

  if (requested && !loaded) {
    return {
      ...base,
      scoreKind: "pending",
      scoreCaption: null,
      leftPointsLabel: null,
      rightPointsLabel: null,
      leaderIndex: null,
      gapLabel: null,
      statusLabel: null,
    };
  }

  const settlementMode = String(metrics?.settlementMode || "");
  if (settlementMode === BATTLE_POINTS_MODE) {
    const healthy = metrics?.dataHealth?.healthy === true;
    const leftReady = metrics?.sides?.left?.pointsReady === true;
    const rightReady = metrics?.sides?.right?.pointsReady === true;
    if (!healthy) {
      return {
        ...base,
        scoreKind: "delay",
        scoreCaption: "Battle points",
        leftPointsLabel: null,
        rightPointsLabel: null,
        leaderIndex: null,
        gapLabel: null,
        statusLabel: DATA_DELAY_LABEL,
      };
    }
    if (!leftReady || !rightReady) {
      return {
        ...base,
        scoreKind: "unavailable",
        scoreCaption: "Battle points",
        leftPointsLabel: null,
        rightPointsLabel: null,
        leaderIndex: null,
        gapLabel: null,
        statusLabel: POINTS_UNAVAILABLE_LABEL,
      };
    }
    const left = pickSidePoints(metrics, "left") ?? 0;
    const right = pickSidePoints(metrics, "right") ?? 0;
    const leaderIndex = metrics?.leaderSide === "left" ? 0 : metrics?.leaderSide === "right" ? 1 : null;
    const gap = finiteNumber(metrics?.pointDifference);
    const pointGap = gap != null ? Math.abs(gap) : Math.abs(left - right);
    return {
      ...base,
      scoreKind: "battle_points",
      scoreCaption: "Battle points",
      leftPointsLabel: formatFeedPoints(left),
      rightPointsLabel: formatFeedPoints(right),
      leaderIndex,
      gapLabel: pointGap > 0 ? `Gap ${formatFeedPoints(pointGap)}` : null,
      statusLabel: null,
    };
  }

  if (settlementMode === LEGACY_SETTLEMENT_MODE) {
    return legacyPresentation(battle, base);
  }

  if (listHintsBattlePoints(battle)) {
    return {
      ...base,
      scoreKind: "unavailable",
      scoreCaption: "Battle points",
      leftPointsLabel: null,
      rightPointsLabel: null,
      leaderIndex: null,
      gapLabel: null,
      statusLabel: POINTS_UNAVAILABLE_LABEL,
    };
  }

  return legacyPresentation(battle, base);
}

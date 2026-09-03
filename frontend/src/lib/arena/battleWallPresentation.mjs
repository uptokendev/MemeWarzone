import {
  DATA_DELAY_LABEL,
  POINTS_UNAVAILABLE_LABEL,
  presentArenaMatchRow,
  tickerFor,
} from "./arenaMatchRowPresentation.mjs";

export { DATA_DELAY_LABEL, POINTS_UNAVAILABLE_LABEL };

export function wallTabForBattle(battle) {
  const state = String(battle?.state || "").toLowerCase();
  if (state === "live") return "live";
  if (state === "matched") return "upcoming";
  if (state === "finished" || state === "completed" || state === "settled") return "finished";
  return null;
}

export function collectWallBattles(feed, tab) {
  const live = Array.isArray(feed?.liveBattles) ? feed.liveBattles : [];
  const queue = Array.isArray(feed?.openForBattleQueue) ? feed.openForBattleQueue : [];
  const archived = Array.isArray(feed?.archivedBattles)
    ? feed.archivedBattles.map((entry) => entry?.battle).filter(Boolean)
    : [];
  return [...live, ...queue, ...archived].filter((battle) => wallTabForBattle(battle) === tab);
}

export function battleWallType(battle) {
  if (battle?.tournamentId || String(battle?.source || "") === "tournament") return "tournament";
  if (String(battle?.source || "") === "challenge") return "manual";
  return "auto_deploy";
}

export function battleWallTypeLabel(type) {
  if (type === "manual") return "Manual / Challenge";
  if (type === "tournament") return "Tournament";
  return "AUTO DEPLOY / Queue";
}

export function battleWallChainGroup(chainId) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "solana";
  if (id === 4663 || id === 46630) return "robinhood";
  return "bnb";
}

export function battleWallClassification(battle) {
  const ranked = String(battle?.rankedMode || "").toLowerCase();
  const classification = String(battle?.matchClassification || "").toLowerCase();
  if (ranked === "open_war" || classification === "open_war") return "OPEN WAR";
  if (ranked === "competitive" || classification === "perfect" || classification === "strong" || classification === "competitive") {
    return "RANKED";
  }
  return null;
}

export function battleSearchText(battle) {
  const parts = [];
  for (const index of [0, 1]) {
    const participant = battle?.participants?.[index] || {};
    parts.push(participant.symbol, participant.tokenName, participant.tokenId);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function validBattlePointGap(presented) {
  if (!presented || presented.scoreKind !== "battle_points") return null;
  if (presented.gapLabel) {
    const labeled = Number(String(presented.gapLabel).replace(/[^0-9.]+/g, ""));
    if (Number.isFinite(labeled)) return labeled;
  }
  const left = Number(presented.leftPointsLabel);
  const right = Number(presented.rightPointsLabel);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(left - right);
}

export function presentBattleWallModule(battle, metrics, options = {}) {
  const tab = wallTabForBattle(battle);
  const presented = presentArenaMatchRow(battle, metrics, options);
  const type = battleWallType(battle);
  return {
    ...presented,
    tab,
    type,
    typeLabel: battleWallTypeLabel(type),
    classification: battleWallClassification(battle),
    chainGroup: battleWallChainGroup(battle?.chainId ?? battle?.chain_id),
    pointGap: validBattlePointGap(presented),
    leftTicker: tickerFor(battle, 0),
    rightTicker: tickerFor(battle, 1),
    stakeNative: Number(battle?.stakeNative ?? battle?.stake_native) || 0,
    durationHours: Number(battle?.durationHours ?? battle?.duration_hours) || 0,
    nativeSymbol: String(battle?.nativeSymbol || ""),
    tournamentId: battle?.tournamentId || battle?.tournament_id || null,
  };
}

export function filterWallBattles(battles, filters = {}) {
  const chain = String(filters.chain || "all").toLowerCase();
  const type = String(filters.type || "all").toLowerCase();
  const search = String(filters.search || "").trim().toLowerCase();
  return (Array.isArray(battles) ? battles : []).filter((battle) => {
    if (chain !== "all" && battleWallChainGroup(battle?.chainId ?? battle?.chain_id) !== chain) return false;
    if (type !== "all" && battleWallType(battle) !== type) return false;
    if (search && !battleSearchText(battle).includes(search)) return false;
    return true;
  });
}

export function sortWallBattles(battles, sort, presentations = new Map()) {
  const mode = String(sort || "default").toLowerCase();
  const rows = [...(Array.isArray(battles) ? battles : [])];
  if (mode === "ending_soon") {
    return rows.sort((left, right) => {
      const leftEnd = Date.parse(left?.endsAt || "") || Number.POSITIVE_INFINITY;
      const rightEnd = Date.parse(right?.endsAt || "") || Number.POSITIVE_INFINITY;
      return leftEnd - rightEnd;
    });
  }
  if (mode === "newest") {
    return rows.sort((left, right) => {
      const leftAt = Date.parse(left?.startedAt || left?.updatedAt || "") || 0;
      const rightAt = Date.parse(right?.startedAt || right?.updatedAt || "") || 0;
      return rightAt - leftAt;
    });
  }
  if (mode === "closest_fight") {
    return rows.sort((left, right) => {
      const leftGap = presentations.get(left?.id)?.pointGap;
      const rightGap = presentations.get(right?.id)?.pointGap;
      const leftValid = Number.isFinite(leftGap);
      const rightValid = Number.isFinite(rightGap);
      if (leftValid && rightValid) return leftGap - rightGap;
      if (leftValid) return -1;
      if (rightValid) return 1;
      return 0;
    });
  }
  return rows;
}

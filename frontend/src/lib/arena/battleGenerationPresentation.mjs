export const BATTLE_POINTS_V2_MAXES = Object.freeze({
  marketCap: 50,
  holders: 30,
  volume: 20,
});

export const BATTLE_POINTS_V3_MAXES = Object.freeze({
  marketCap: 45,
  holders: 27,
  volume: 18,
});

const SCORE_GENERATIONS = Object.freeze({
  mcap_pct_change: {
    id: "mcap_pct_change",
    label: "Battle scoring V1",
    detail: "MCAP percentage-change score",
    maxes: null,
    boostMax: 0,
  },
  v1_mcap_pct_change: {
    id: "mcap_pct_change",
    label: "Battle scoring V1",
    detail: "MCAP percentage-change score",
    maxes: null,
    boostMax: 0,
  },
  battle_points_v2: {
    id: "battle_points_v2",
    label: "Battle Points V2",
    detail: "50 MCAP / 30 Holders / 20 Eligible Volume",
    maxes: BATTLE_POINTS_V2_MAXES,
    boostMax: 0,
  },
  battle_points_v3: {
    id: "battle_points_v3",
    label: "Battle Points V3",
    detail: "45 MCAP / 27 Holders / 18 Eligible Volume / 10 Battle Boost",
    maxes: BATTLE_POINTS_V3_MAXES,
    boostMax: 10,
  },
});

const POOL_GENERATIONS = Object.freeze({
  war_pool_v1: {
    id: "war_pool_v1",
    label: "WarPool V1 (Historical)",
    detail: "85% Prize / 10% Post-Grad League / 5% Protocol",
  },
  war_pool_v2: {
    id: "war_pool_v2",
    label: "Competition Pool V2",
    detail: "75% Prize / 20% Post-Grad League / 5% Protocol",
  },
  competition_pool_v2: {
    id: "war_pool_v2",
    label: "Competition Pool V2",
    detail: "75% Prize / 20% Post-Grad League / 5% Protocol",
  },
});

function explicitScoringGeneration(metrics = {}) {
  const persisted = String(metrics?.settlementScoringVersion || "").trim();
  if (persisted) return persisted;
  return String(metrics?.scoringVersion || "").trim() || null;
}

function explicitPoolGeneration(battle = {}) {
  return String(battle?.poolGeneration || battle?.pool_generation || "").trim() || null;
}

export function presentBattleGeneration(battle = {}, metrics = {}) {
  const scoringRaw = explicitScoringGeneration(metrics);
  const scoring = scoringRaw ? SCORE_GENERATIONS[scoringRaw] || null : null;
  const poolRaw = explicitPoolGeneration(battle);
  const pool = poolRaw ? POOL_GENERATIONS[poolRaw] || null : null;

  return {
    scoringRaw,
    scoring,
    poolRaw,
    pool,
    showScoreBreakdown: scoring?.id === "battle_points_v2" || scoring?.id === "battle_points_v3",
    scoreMaxes: scoring?.maxes || null,
    boostPending: null,
  };
}

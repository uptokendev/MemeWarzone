import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";
import { buildPublicBattleMetricsSnapshot, readPublicBattleMetricsSnapshot } from "./lib/arenaBattleRealtime.js";
import { arenaSettlementMode } from "./lib/arenaSettlementMode.js";

function safeBattleId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : "";
}

function routeBattleId(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const match = path.match(/^\/arena\/battle-metrics\/([^/]+)$/);
  return match ? safeBattleId(decodeURIComponent(match[1])) : "";
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function changePct(start, current) {
  const a = finite(start);
  const b = finite(current);
  if (!(a > 0) || b === null) return null;
  return ((b - a) / a) * 100;
}

function generationNumber(version) {
  if (version === "battle_points_v3") return 3;
  if (version === "battle_points_v2") return 2;
  return null;
}

function resultSide(metricsRow, v3Row, version) {
  const v3 = version === "battle_points_v3";
  const mcapPoints = finite(v3 ? v3Row?.mcap_points : metricsRow?.mcap_points);
  const holderPoints = finite(v3 ? v3Row?.holder_points : metricsRow?.holder_points);
  const volumePoints = finite(v3 ? v3Row?.volume_points : metricsRow?.volume_points);
  const totalPoints = finite(v3 ? v3Row?.total_points : metricsRow?.battle_points);
  return {
    side: String(metricsRow?.side || ""),
    tokenId: metricsRow?.token_id || null,
    totalPoints,
    mcap: {
      points: mcapPoints,
      maxPoints: v3 ? 45 : 50,
      start: finite(metricsRow?.start_mcap_usd),
      current: finite(metricsRow?.current_mcap_usd),
      changePct: changePct(metricsRow?.start_mcap_usd, metricsRow?.current_mcap_usd),
    },
    holders: {
      points: holderPoints,
      maxPoints: v3 ? 27 : 30,
      start: finite(metricsRow?.start_holders),
      current: finite(metricsRow?.current_holders),
      changePct: changePct(metricsRow?.start_holders, metricsRow?.current_holders),
    },
    volume: {
      points: volumePoints,
      maxPoints: v3 ? 18 : 20,
      rawUsd: finite(metricsRow?.volume_raw_usd),
      excludedUsd: finite(metricsRow?.volume_excluded_usd),
      eligibleUsd: finite(metricsRow?.eligible_battle_volume_usd),
    },
    boost: {
      points: v3 ? finite(v3Row?.boost_points) : null,
      maxPoints: v3 ? 10 : 0,
      confirmedUnits: v3 && v3Row?.boost_units != null ? Number(v3Row.boost_units) : 0,
      curveVersion: v3 ? (v3Row?.boost_curve_version || metricsRow?.curve_version || null) : null,
    },
    evidence: {
      baselineTimestamp: metricsRow?.baseline_timestamp || null,
      baselineMarketDataUpdatedAt: metricsRow?.baseline_market_data_updated_at || null,
      marketDataUpdatedAt: metricsRow?.market_data_updated_at || null,
      metricsUpdatedAt: metricsRow?.metrics_updated_at || null,
      eligibleVolumeEvidence: "arena_battle_volume_audit",
    },
  };
}

async function authoritativeResult(battle) {
  const metrics = (await pool.query(
    `select * from public.arena_battle_metrics where battle_id = $1 order by side asc`,
    [String(battle.id)],
  )).rows || [];
  if (metrics.length !== 2) return null;
  const versions = [...new Set(metrics.map((row) => String(row.scoring_generation || row.scoring_version || "")))];
  if (versions.length !== 1) return null;
  const scoringVersion = versions[0];
  const v3Rows = scoringVersion === "battle_points_v3"
    ? (await pool.query(`select * from public.arena_battle_points_v3 where battle_id = $1 order by side asc`, [String(battle.id)])).rows || []
    : [];
  const v3BySide = new Map(v3Rows.map((row) => [String(row.side), row]));
  const bySide = new Map(metrics.map((row) => [String(row.side), row]));
  const left = resultSide(bySide.get("left"), v3BySide.get("left"), scoringVersion);
  const right = resultSide(bySide.get("right"), v3BySide.get("right"), scoringVersion);
  const reasons = [];
  for (const side of [bySide.get("left"), bySide.get("right")]) {
    if (!side) reasons.push("battle_metrics_missing");
    else {
      if (side.baseline_healthy !== true) reasons.push(`${side.side}_baseline_unhealthy`);
      if (side.data_healthy !== true) reasons.push(`${side.side}_market_data_unhealthy`);
    }
  }
  if (scoringVersion === "battle_points_v3" && v3Rows.length !== 2) reasons.push("v3_result_evidence_incomplete");
  if (left.totalPoints === null || right.totalPoints === null) reasons.push("final_points_unavailable");
  const healthy = reasons.length === 0;
  return {
    scoringVersion,
    scoringGeneration: generationNumber(scoringVersion),
    sides: { left, right },
    dataHealth: { healthy, status: healthy ? "healthy" : "unhealthy", reasons },
    battleResult: {
      state: String(battle.state || ""),
      result: battle.mwl_result || null,
      draw: battle.mwl_draw === true,
      winnerToken: battle.mwl_winner_token || null,
    },
    moneyResult: {
      winnerToken: battle.money_winner_token || battle.winner_token || null,
      tieBreak: battle.money_tie_break || null,
      tieBreakUsed: battle.settlement_tie_break_used === true,
    },
  };
}

export default async function handler(req, res) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return badMethod(res);
  const battleId = routeBattleId(req);
  if (!battleId) return json(res, 400, { ok: false, error: "Invalid battle id" });

  const result = await pool.query(
    `select id, chain_id, state, challenger_token, defender_token, started_at, ends_at,
            money_winner_token, winner_token, money_tie_break, settlement_tie_break_used,
            mwl_result, mwl_draw, mwl_winner_token,
            settlement_version, settlement_scoring_version,
            challenger_battle_points, defender_battle_points,
            settlement_metrics_updated_at, settled_at, finished_at, updated_at
       from public.arena_battles
      where id = $1
      limit 1`,
    [battleId],
  );
  const battle = result.rows[0];
  if (!battle) return json(res, 404, { ok: false, error: "Battle not found" });

  let metrics = await readPublicBattleMetricsSnapshot(battle).catch((error) => {
    console.warn("[api/arenaBattleMetrics] metrics read failed", battleId, error?.message || error);
    return null;
  });
  if (!metrics) {
    metrics = buildPublicBattleMetricsSnapshot(battle, []);
    metrics.dataHealth = {
      healthy: false,
      status: "data_delay",
      reasons: ["battle_metrics_missing"],
    };
  }

  const frozenResult = await authoritativeResult(battle).catch((error) => {
    console.warn("[api/arenaBattleMetrics] authoritative result read failed", battleId, error?.message || error);
    return null;
  });
  const settlementMode = arenaSettlementMode(battle);
  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ok: true,
    battleId,
    state: String(battle.state || ""),
    settlementMode,
    settlementVersion: battle.settlement_version ?? null,
    settlementScoringVersion: battle.settlement_scoring_version || null,
    scoringVersion: frozenResult?.scoringVersion || battle.settlement_scoring_version || null,
    scoringGeneration: frozenResult?.scoringGeneration ?? null,
    moneyTieBreak: battle.money_tie_break || null,
    tieBreakUsed: battle.settlement_tie_break_used === true,
    finalBattlePoints: {
      left: battle.challenger_battle_points == null ? null : Number(battle.challenger_battle_points),
      right: battle.defender_battle_points == null ? null : Number(battle.defender_battle_points),
    },
    authoritativeResult: frozenResult,
    settlementMetricsUpdatedAt: battle.settlement_metrics_updated_at || null,
    metrics,
    updatedAt: battle.updated_at || metrics.metricsUpdatedAt || new Date().toISOString(),
  });
}

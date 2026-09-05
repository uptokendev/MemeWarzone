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

export default async function handler(req, res) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return badMethod(res);
  const battleId = routeBattleId(req);
  if (!battleId) return json(res, 400, { ok: false, error: "Invalid battle id" });

  const result = await pool.query(
    `select id, chain_id, state, challenger_token, defender_token, started_at, ends_at,
            money_winner_token, winner_token, money_tie_break, settlement_tie_break_used,
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

  const settlementMode = arenaSettlementMode(battle);
  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ok: true,
    battleId,
    state: String(battle.state || ""),
    settlementMode,
    settlementVersion: battle.settlement_version ?? null,
    settlementScoringVersion: battle.settlement_scoring_version || null,
    moneyTieBreak: battle.money_tie_break || null,
    tieBreakUsed: battle.settlement_tie_break_used === true,
    finalBattlePoints: {
      left: battle.challenger_battle_points == null ? null : Number(battle.challenger_battle_points),
      right: battle.defender_battle_points == null ? null : Number(battle.defender_battle_points),
    },
    settlementMetricsUpdatedAt: battle.settlement_metrics_updated_at || null,
    metrics,
    updatedAt: battle.updated_at || metrics.metricsUpdatedAt || new Date().toISOString(),
  });
}

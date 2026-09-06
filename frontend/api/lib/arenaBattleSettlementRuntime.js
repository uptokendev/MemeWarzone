import { pool } from "../../server/db.js";
import { BATTLE_POINTS_V2, BATTLE_POINTS_V3 } from "./arenaBattlePointsConfig.js";
import { settleBattlePointsV2ById } from "./arenaBattleSettlementV2Service.js";
import { settleBattlePointsV3ById } from "./arenaBattleSettlementV3Service.js";

const MAX_DUE_PER_PASS = 50;

export async function loadDueNormalBattleLocks(deps = {}) {
  const query = deps.query || ((text, params) => pool.query(text, params));
  const result = await query(
    `select b.id,
            min(coalesce(m.scoring_generation, m.scoring_version)) as scoring_generation,
            max(coalesce(m.scoring_generation, m.scoring_version)) as scoring_generation_max,
            count(m.*)::int as metric_rows
       from public.arena_battles b
       left join public.arena_battle_metrics m on m.battle_id = b.id
      where b.state = 'live'
        and coalesce(b.battle_mode, 'normal') = 'normal'
        and b.source <> 'tournament'
        and b.ends_at is not null
        and b.ends_at <= now()
      group by b.id, b.ends_at
      order by b.ends_at asc
      limit $1`,
    [Math.max(1, Number(deps.limit || MAX_DUE_PER_PASS))],
  );
  return result.rows || [];
}

export function classifySettlementGeneration(row) {
  if (!row || Number(row.metric_rows || 0) !== 2) return { supported: false, reason: "baseline_incomplete", scoringGeneration: null };
  const min = String(row.scoring_generation || "");
  const max = String(row.scoring_generation_max || "");
  if (!min || min !== max) return { supported: false, reason: "scoring_generation_lock_mismatch", scoringGeneration: null };
  if (min === BATTLE_POINTS_V3) return { supported: true, scoringGeneration: BATTLE_POINTS_V3, version: 3 };
  if (min === BATTLE_POINTS_V2) return { supported: true, scoringGeneration: BATTLE_POINTS_V2, version: 2 };
  return { supported: false, reason: "unsupported_scoring_generation", scoringGeneration: min || null };
}

export async function settleDueNormalBattles(deps = {}) {
  const rows = await loadDueNormalBattleLocks(deps);
  const results = [];
  for (const row of rows) {
    const lock = classifySettlementGeneration(row);
    if (!lock.supported) {
      results.push({ battleId: String(row.id), settled: false, reason: lock.reason, scoringGeneration: lock.scoringGeneration });
      continue;
    }
    try {
      const settlement = lock.version === 3
        ? await settleBattlePointsV3ById(row.id, deps)
        : await settleBattlePointsV2ById(row.id, { ...deps, force: true });
      results.push({ battleId: String(row.id), scoringGeneration: lock.scoringGeneration, ...settlement });
    } catch (error) {
      results.push({
        battleId: String(row.id),
        scoringGeneration: lock.scoringGeneration,
        settled: false,
        reason: "settlement_runtime_error",
        error: String(error?.message || error),
      });
    }
  }
  return results;
}

export async function activateNormalBattleSettlementOnRead(req, deps = {}) {
  const method = String(req?.method || "GET").toUpperCase();
  const path = String(req?.path || new URL(req?.url || "/", "http://localhost").pathname);
  if (method !== "GET" || !/^\/arena\/battles(?:\/[^/]+)?$/.test(path)) return [];
  return settleDueNormalBattles(deps);
}

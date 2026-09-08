import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";
import { requireInternalAuth } from "./lib/apiAuth.js";
import {
  BATTLE_POINTS_V3,
  BATTLE_POINTS_V3_BOOST_CURVE,
  BATTLE_POINTS_V3_CONFIG,
} from "./lib/arenaBattlePointsConfig.js";

function pathOf(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function routeBattleId(req) {
  const match = pathOf(req).match(/^\/arena\/battles\/([^/]+)\/v3-scoring-lock$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function exactCurveLock(lock) {
  const params = lock?.boost_curve_parameters || {};
  return Boolean(
    lock
    && lock.scoring_version === BATTLE_POINTS_V3
    && lock.boost_curve_version === BATTLE_POINTS_V3_BOOST_CURVE
    && Number(params.maxPoints) === 10
    && Number(params.halfSaturationUnits) === 100
    && Number(params.unitUsdMicros) === 1_000_000
  );
}

async function seedProjectionRows(client, battle) {
  const config = BATTLE_POINTS_V3_CONFIG;
  const parameters = JSON.stringify(config.boost.curveParameters);
  for (const [side, tokenId] of [["left", battle.challenger_token], ["right", battle.defender_token]]) {
    if (!tokenId) throw new Error(`Cannot lock V3 without ${side} token identity`);
    const row = (await client.query(
      `insert into public.arena_battle_points_v3 (
         battle_id, token_id, side,
         mcap_weight, holder_weight, volume_weight, boost_weight,
         boost_curve_version, boost_curve_parameters,
         boost_units, boost_gross_native_raw, boost_pool_native_raw, boost_protocol_native_raw,
         boost_points, total_points
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,0,0,0,0,null,null)
       on conflict (battle_id, side) do nothing
       returning battle_id, side, boost_curve_version, boost_curve_parameters`,
      [
        String(battle.id), String(tokenId), side,
        config.mcap.weight, config.holders.weight, config.volume.weight, config.boost.weight,
        BATTLE_POINTS_V3_BOOST_CURVE, parameters,
      ],
    )).rows[0] || (await client.query(
      `select battle_id, side, boost_curve_version, boost_curve_parameters
         from public.arena_battle_points_v3 where battle_id=$1 and side=$2`,
      [String(battle.id), side],
    )).rows[0];
    if (!exactCurveLock({
      scoring_version: BATTLE_POINTS_V3,
      boost_curve_version: row?.boost_curve_version,
      boost_curve_parameters: row?.boost_curve_parameters,
    })) throw new Error(`Existing ${side} V3 projection uses an incompatible Boost curve`);
  }
}

export async function lockBattlePointsV3(battleId, deps = {}) {
  const db = deps.pool || pool;
  const client = await db.connect();
  try {
    await client.query("begin");
    const battle = (await client.query(
      `select id, state, source, battle_mode, competition_generation, challenger_token, defender_token
         from public.arena_battles
        where id = $1
        for update`,
      [String(battleId)],
    )).rows[0];
    if (!battle) {
      await client.query("rollback");
      return { ok: false, status: 404, reason: "battle_not_found" };
    }
    if (!["waiting", "challenged", "matched"].includes(String(battle.state))) {
      await client.query("rollback");
      return { ok: false, status: 409, reason: "v3_lock_requires_pre_live_battle" };
    }
    if (String(battle.battle_mode || "normal") !== "normal" || String(battle.source || "") === "tournament") {
      await client.query("rollback");
      return { ok: false, status: 409, reason: "v3_lock_requires_normal_battle" };
    }
    if (String(battle.competition_generation || "") !== "arena_competition_v2") {
      await client.query("rollback");
      return { ok: false, status: 409, reason: "v3_lock_requires_current_competition_generation" };
    }
    if (!battle.challenger_token || !battle.defender_token) {
      await client.query("rollback");
      return { ok: false, status: 409, reason: "v3_lock_requires_both_combatants" };
    }

    const parameters = JSON.stringify(BATTLE_POINTS_V3_CONFIG.boost.curveParameters);
    const inserted = (await client.query(
      `insert into public.arena_battle_scoring_locks (
         battle_id, scoring_version, boost_curve_version, boost_curve_parameters
       ) values ($1,$2,$3,$4::jsonb)
       on conflict (battle_id) do nothing
       returning battle_id, scoring_version, boost_curve_version, boost_curve_parameters, locked_at`,
      [String(battleId), BATTLE_POINTS_V3, BATTLE_POINTS_V3_BOOST_CURVE, parameters],
    )).rows[0];
    const lock = inserted || (await client.query(
      `select battle_id, scoring_version, boost_curve_version, boost_curve_parameters, locked_at
         from public.arena_battle_scoring_locks where battle_id = $1`,
      [String(battleId)],
    )).rows[0];
    if (!exactCurveLock(lock)) {
      await client.query("rollback");
      return { ok: false, status: 409, reason: "battle_has_incompatible_scoring_lock" };
    }

    await seedProjectionRows(client, battle);
    await client.query("commit");
    return { ok: true, status: inserted ? 201 : 200, idempotent: !inserted, battle, lock };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  if (String(req.method || "POST").toUpperCase() !== "POST") return badMethod(res);
  const battleId = routeBattleId(req);
  if (!battleId) return json(res, 404, { ok: false, error: "Unknown V3 scoring lock route" });
  const internal = await requireInternalAuth(req, res, { routeLabel: "arena_battle_points_v3_lock" });
  if (!internal) return;
  try {
    const result = await lockBattlePointsV3(battleId);
    if (!result.ok) return json(res, result.status, { ok: false, error: result.reason, code: result.reason.toUpperCase() });
    return json(res, result.status, {
      ok: true,
      idempotent: result.idempotent,
      battleId: result.lock.battle_id,
      scoringVersion: result.lock.scoring_version,
      boostCurveVersion: result.lock.boost_curve_version,
      boostCurveParameters: result.lock.boost_curve_parameters,
      lockedAt: result.lock.locked_at,
    });
  } catch (error) {
    console.error("[api/arenaBattlePointsV3Admin]", error);
    return json(res, 503, { ok: false, error: "Failed to lock Battle Points V3", detail: String(error?.message || error) });
  }
}

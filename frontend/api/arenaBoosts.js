import { ZeroHash } from "ethers";

import { pool } from "../server/db.js";
import { badMethod, isAddress, json, readJson } from "../server/http.js";
import { requireInternalAuth } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { battlePoolId } from "./lib/arenaWarPoolEscrow.js";
import {
  DEFAULT_QUOTE_TTL_SECONDS,
  randomBoostNonce,
  readBoostPricingConfig,
  serializeSignedBoostQuote,
  signBoostQuote,
} from "./lib/arenaBoostQuote.mjs";
import {
  boostSummary,
  resolveBattleSide,
  serializeBoostSummary,
  validateConfirmedBoost,
} from "./lib/arenaBoostRuntime.mjs";

function safeBattleId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : "";
}

function routeInfo(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  if (path === "/arena/boosts/quote") return { action: "quote", battleId: "" };
  if (path === "/arena/boosts/confirm") return { action: "confirm", battleId: "" };
  const match = path.match(/^\/arena\/boosts\/([^/]+)$/);
  return match ? { action: "read", battleId: safeBattleId(decodeURIComponent(match[1])) } : { action: "unknown", battleId: "" };
}

function safeTxHash(value) {
  const txHash = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(txHash) ? txHash : "";
}

function safeLogIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

function safeConfirmedAt(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeBoostUnits(value) {
  try {
    const units = BigInt(String(value));
    return units > 0n && units <= 1_000_000n ? units : null;
  } catch {
    return null;
  }
}

function quoteTtlSeconds() {
  const raw = Number(process.env.ARENA_BOOST_QUOTE_TTL_SECONDS || DEFAULT_QUOTE_TTL_SECONDS);
  return Number.isInteger(raw) && raw >= 30 && raw <= 600 ? raw : DEFAULT_QUOTE_TTL_SECONDS;
}

function actionShape(row) {
  if (!row) return null;
  return {
    id: row.id == null ? null : String(row.id),
    chainId: Number(row.chain_id),
    battleId: String(row.battle_id),
    tournamentId: row.tournament_id || null,
    matchId: row.match_id || null,
    roundNumber: Number(row.round_number),
    phase: String(row.phase),
    side: String(row.side),
    wallet: String(row.wallet),
    actionType: String(row.action_type),
    boostUnits: String(row.boost_units ?? 0),
    grossNativeRaw: String(row.gross_native_raw ?? 0),
    poolNativeRaw: String(row.pool_native_raw ?? 0),
    protocolNativeRaw: String(row.protocol_native_raw ?? 0),
    txHash: row.tx_hash || null,
    logIndex: row.log_index == null ? null : Number(row.log_index),
    confirmedAt: row.confirmed_at || null,
  };
}

async function battleForBoost(battleId) {
  const result = await pool.query(
    `select id, chain_id, state, battle_mode, source, tournament_id, competition_generation, contest_scoring_version, participants
       from public.arena_battles
      where id = $1
      limit 1`,
    [battleId],
  );
  return result.rows[0] || null;
}

function validateNormalV2Battle(battle, chainId, targetToken) {
  if (!battle) return { status: 404, error: "Battle not found" };
  if (Number(battle.chain_id) !== chainId) return { status: 409, error: "Boost chain does not match battle chain" };
  if (String(battle.state) !== "live") return { status: 409, error: "Boost is only available for a live Battle" };
  if (String(battle.battle_mode || "normal") !== "normal" || String(battle.source || "") === "tournament") {
    return { status: 409, error: "This endpoint only supports Normal Battle Boosts" };
  }
  if (String(battle.competition_generation || "") !== "arena_competition_v2") {
    return { status: 409, error: "Battle is not using Arena competition V2 money rails" };
  }
  const side = resolveBattleSide(battle.participants, targetToken);
  if (!side) return { status: 409, error: "Boost target is not a Battle combatant" };
  return { side };
}

async function readBattleBoosts(res, battleId) {
  if (!battleId) return json(res, 400, { ok: false, error: "Invalid battle id" });
  const battle = await battleForBoost(battleId);
  if (!battle) return json(res, 404, { ok: false, error: "Battle not found" });

  const [actionsResult, scoringResult] = await Promise.all([
    pool.query(
      `select side, boost_units, gross_native_raw, pool_native_raw, protocol_native_raw
         from public.arena_contest_actions
        where battle_id = $1
          and action_type = 'boost'
          and phase = 'regulation'
          and confirmed_at is not null
        order by id asc`,
      [battleId],
    ),
    pool.query(
      `select battle_id, token_id, side, scoring_version, mcap_weight, holder_weight, volume_weight, boost_weight,
              boost_curve_version, boost_curve_parameters, boost_units, boost_gross_native_raw,
              boost_pool_native_raw, boost_protocol_native_raw, boost_points, mcap_points, holder_points,
              volume_points, total_points, metrics_updated_at, updated_at
         from public.arena_battle_points_v3
        where battle_id = $1
        order by case side when 'left' then 0 else 1 end`,
      [battleId],
    ),
  ]);

  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ok: true,
    battleId,
    chainId: Number(battle.chain_id),
    state: String(battle.state || ""),
    battleMode: String(battle.battle_mode || "normal"),
    competitionGeneration: battle.competition_generation || null,
    contestScoringVersion: battle.contest_scoring_version || null,
    summary: serializeBoostSummary(boostSummary(actionsResult.rows)),
    battlePointsV3: scoringResult.rows.map((row) => ({
      battleId: String(row.battle_id),
      tokenId: String(row.token_id),
      side: String(row.side),
      scoringVersion: String(row.scoring_version),
      weights: {
        mcap: Number(row.mcap_weight),
        holders: Number(row.holder_weight),
        volume: Number(row.volume_weight),
        boost: Number(row.boost_weight),
      },
      boostCurveVersion: String(row.boost_curve_version),
      boostCurveParameters: row.boost_curve_parameters || {},
      boostUnits: String(row.boost_units ?? 0),
      boostGrossNativeRaw: String(row.boost_gross_native_raw ?? 0),
      boostPoolNativeRaw: String(row.boost_pool_native_raw ?? 0),
      boostProtocolNativeRaw: String(row.boost_protocol_native_raw ?? 0),
      boostPoints: row.boost_points == null ? null : Number(row.boost_points),
      mcapPoints: row.mcap_points == null ? null : Number(row.mcap_points),
      holderPoints: row.holder_points == null ? null : Number(row.holder_points),
      volumePoints: row.volume_points == null ? null : Number(row.volume_points),
      totalPoints: row.total_points == null ? null : Number(row.total_points),
      metricsUpdatedAt: row.metrics_updated_at || null,
      updatedAt: row.updated_at || null,
    })),
    scoringActive: false,
    scoringReason: "boost_curve_founder_pending",
    updatedAt: new Date().toISOString(),
  });
}

async function createBattleBoostQuote(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId);
  const battleId = safeBattleId(body.battleId);
  const wallet = String(body.wallet || body.auth?.walletAddress || "").trim().toLowerCase();
  const targetToken = String(body.targetToken || "").trim().toLowerCase();
  const boostUnits = safeBoostUnits(body.boostUnits);

  if (!Number.isInteger(chainId) || chainId <= 0 || chainId === 101 || chainId === 102) {
    return json(res, 400, { ok: false, error: "Battle Boost quotes currently require an active EVM money path" });
  }
  if (!battleId || !isAddress(wallet) || !isAddress(targetToken) || !boostUnits) {
    return json(res, 400, { ok: false, error: "Invalid Battle Boost quote request" });
  }

  const battle = await battleForBoost(battleId);
  const battleCheck = validateNormalV2Battle(battle, chainId, targetToken);
  if (battleCheck.error) return json(res, battleCheck.status, { ok: false, error: battleCheck.error });

  const auth = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth,
    expectedWallet: wallet,
    chainId,
    action: "arena_battle_boost_quote",
    extraLines: [`Battle: ${battleId}`, `Target: ${targetToken}`, `Boost Units: ${boostUnits.toString()}`],
    routeLabel: "arena_battle_boost_quote",
  });
  if (!auth) return;
  if (auth.legacy) {
    return json(res, 401, {
      ok: false,
      error: "Battle Boost quotes require signed wallet authentication",
      code: "BOOST_QUOTE_SIGNATURE_REQUIRED",
    });
  }

  let config;
  try {
    config = readBoostPricingConfig(chainId);
  } catch (error) {
    console.error("[api/arenaBoosts] quote pricing unavailable", error?.message || error);
    return json(res, 503, { ok: false, error: "Battle Boost pricing is unavailable" });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + quoteTtlSeconds();
    const signed = await signBoostQuote(config, {
      poolId: battlePoolId(battleId),
      matchId: ZeroHash,
      roundNumber: 0,
      booster: wallet,
      sideToken: targetToken,
      boostUnits,
      nonce: randomBoostNonce(),
      deadline,
    });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      ok: true,
      battleId,
      side: battleCheck.side,
      usdPerBoostMicros: "1000000",
      quote: serializeSignedBoostQuote(signed),
      expiresAt: new Date(deadline * 1000).toISOString(),
    });
  } catch (error) {
    console.error("[api/arenaBoosts] quote signing failed", error);
    return json(res, 503, { ok: false, error: "Battle Boost quote could not be created" });
  }
}

async function confirmBattleBoost(req, res) {
  if (!requireInternalAuth(req, res, { routeLabel: "arena_boost_confirm" })) return;
  const body = await readJson(req);
  const chainId = Number(body.chainId);
  const battleId = safeBattleId(body.battleId);
  const txHash = safeTxHash(body.txHash);
  const logIndex = safeLogIndex(body.logIndex);
  const targetToken = String(body.targetToken || "").trim().toLowerCase();
  const wallet = String(body.wallet || "").trim().toLowerCase();
  const confirmedAt = safeConfirmedAt(body.confirmedAt);

  if (!Number.isInteger(chainId) || chainId <= 0 || chainId === 101 || chainId === 102) {
    return json(res, 400, { ok: false, error: "Confirmed Battle Boost ingestion currently requires an active EVM money path" });
  }
  if (!battleId || !txHash || logIndex == null || !isAddress(targetToken) || !isAddress(wallet) || !confirmedAt) {
    return json(res, 400, { ok: false, error: "Invalid confirmed Boost event identity" });
  }

  let split;
  try {
    split = validateConfirmedBoost({
      boostUnits: body.boostUnits,
      grossNativeRaw: body.grossNativeRaw,
      poolNativeRaw: body.poolNativeRaw,
      protocolNativeRaw: body.protocolNativeRaw,
    });
  } catch (error) {
    return json(res, 400, { ok: false, error: error?.message || "Invalid Boost split" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const battleResult = await client.query(
      `select id, chain_id, state, battle_mode, source, tournament_id, competition_generation, contest_scoring_version, participants
         from public.arena_battles
        where id = $1
        for update`,
      [battleId],
    );
    const battle = battleResult.rows[0];
    const battleCheck = validateNormalV2Battle(battle, chainId, targetToken);
    if (battleCheck.error) {
      await client.query("ROLLBACK");
      return json(res, battleCheck.status, { ok: false, error: battleCheck.error });
    }

    const insertResult = await client.query(
      `insert into public.arena_contest_actions (
         chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet,
         action_type, boost_units, points, gross_native_raw, pool_native_raw, protocol_native_raw,
         tx_hash, log_index, signature_reference, confirmed_at
       ) values ($1, null, $2, null, 1, 'regulation', null, $3, $4, 'boost', $5, 0, $6, $7, $8, $9, $10, null, $11)
       on conflict (chain_id, tx_hash, log_index) where tx_hash is not null and log_index is not null
       do nothing
       returning *`,
      [
        chainId,
        battleId,
        battleCheck.side,
        wallet,
        split.boostUnits.toString(),
        split.gross.toString(),
        split.pool.toString(),
        split.protocol.toString(),
        txHash,
        logIndex,
        confirmedAt,
      ],
    );

    if (!insertResult.rows[0]) {
      const existingResult = await client.query(
        `select * from public.arena_contest_actions where chain_id = $1 and tx_hash = $2 and log_index = $3 limit 1`,
        [chainId, txHash, logIndex],
      );
      const existing = existingResult.rows[0];
      const sameEvent =
        existing &&
        String(existing.battle_id) === battleId &&
        String(existing.side) === battleCheck.side &&
        String(existing.wallet).toLowerCase() === wallet &&
        String(existing.boost_units) === split.boostUnits.toString() &&
        String(existing.gross_native_raw) === split.gross.toString() &&
        String(existing.pool_native_raw) === split.pool.toString() &&
        String(existing.protocol_native_raw) === split.protocol.toString();
      await client.query("ROLLBACK");
      if (!sameEvent) return json(res, 409, { ok: false, error: "Transaction log is already bound to another contest action" });
      return json(res, 200, { ok: true, confirmed: true, idempotent: true, action: actionShape(existing) });
    }

    const currentScore = await client.query(
      `select token_id from public.arena_battle_points_v3 where battle_id = $1 and side = $2 for update`,
      [battleId, battleCheck.side],
    );
    if (currentScore.rows[0] && String(currentScore.rows[0].token_id).toLowerCase() !== targetToken) {
      throw new Error("Battle Points V3 side token changed after Boost confirmation");
    }

    await client.query(
      `insert into public.arena_battle_points_v3 (
         battle_id, token_id, side, boost_units, boost_gross_native_raw, boost_pool_native_raw, boost_protocol_native_raw
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (battle_id, side) do update set
         boost_units = public.arena_battle_points_v3.boost_units + excluded.boost_units,
         boost_gross_native_raw = public.arena_battle_points_v3.boost_gross_native_raw + excluded.boost_gross_native_raw,
         boost_pool_native_raw = public.arena_battle_points_v3.boost_pool_native_raw + excluded.boost_pool_native_raw,
         boost_protocol_native_raw = public.arena_battle_points_v3.boost_protocol_native_raw + excluded.boost_protocol_native_raw,
         metrics_updated_at = now(),
         updated_at = now()`,
      [
        battleId,
        targetToken,
        battleCheck.side,
        split.boostUnits.toString(),
        split.gross.toString(),
        split.pool.toString(),
        split.protocol.toString(),
      ],
    );

    await client.query("COMMIT");
    const summaryResult = await pool.query(
      `select side, boost_units, gross_native_raw, pool_native_raw, protocol_native_raw
         from public.arena_contest_actions
        where battle_id = $1 and action_type = 'boost' and phase = 'regulation' and confirmed_at is not null`,
      [battleId],
    );
    return json(res, 201, {
      ok: true,
      confirmed: true,
      idempotent: false,
      action: actionShape(insertResult.rows[0]),
      summary: serializeBoostSummary(boostSummary(summaryResult.rows)),
      battlePointsV3: {
        scoringVersion: "battle_points_v3",
        boostCurveVersion: "founder_pending",
        boostPoints: null,
        scoringActive: false,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[api/arenaBoosts] confirm failed", error);
    return json(res, 500, { ok: false, error: "Failed to confirm Battle Boost" });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const route = routeInfo(req);
  const method = String(req.method || "GET").toUpperCase();
  if (route.action === "read") {
    if (method !== "GET") return badMethod(res);
    return readBattleBoosts(res, route.battleId);
  }
  if (route.action === "quote") {
    if (method !== "POST") return badMethod(res);
    return createBattleBoostQuote(req, res);
  }
  if (route.action === "confirm") {
    if (method !== "POST") return badMethod(res);
    return confirmBattleBoost(req, res);
  }
  return json(res, 404, { ok: false, error: "Unknown Arena Boost route" });
}

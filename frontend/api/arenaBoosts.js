import { ZeroHash } from "ethers";

import { pool } from "../server/db.js";
import { badMethod, isAddress, json, readJson } from "../server/http.js";
import { requireInternalAuth } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import { verifyBattleBoostPayment } from "./lib/arenaBoostChainVerification.mjs";
import { BATTLE_POINTS_V3_CONFIG } from "./lib/arenaBattlePointsConfig.js";
import { calculateBattlePointsV3Boost } from "./lib/arenaBattlePointsV3.js";
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
  exactBattlePointsV3Lock,
  projectBattlePointsV3Row,
  resolveBattlePointsV3Authority,
  resolveBattlePointsV3BoostSaleStatus,
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

function chainProofShape(proof) {
  if (!proof) return null;
  return {
    treasuryAddress: proof.treasuryAddress,
    txHash: proof.txHash,
    logIndex: proof.logIndex,
    blockNumber: proof.blockNumber,
    pricingVersion: String(proof.pricingVersion),
    oracleTimestamp: String(proof.oracleTimestamp),
    nonce: String(proof.nonce),
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

function weightsShape() {
  return {
    mcap: BATTLE_POINTS_V3_CONFIG.mcap.weight,
    holders: BATTLE_POINTS_V3_CONFIG.holders.weight,
    volume: BATTLE_POINTS_V3_CONFIG.volume.weight,
    boost: BATTLE_POINTS_V3_CONFIG.boost.weight,
  };
}

function projectionShape(row, projected) {
  return {
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
    boostPoints: projected?.boostPoints == null ? null : Number(projected.boostPoints),
    mcapPoints: row.mcap_points == null ? null : Number(row.mcap_points),
    holderPoints: row.holder_points == null ? null : Number(row.holder_points),
    volumePoints: row.volume_points == null ? null : Number(row.volume_points),
    totalPoints: projected?.totalPoints == null ? null : Number(projected.totalPoints),
    dataHealth: projected?.dataHealth || null,
    scoringReady: projected?.scoringReady === true,
    projectionReason: projected?.reason || null,
    metricsUpdatedAt: row.metrics_updated_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function loadBattlePointsV3Runtime(battle, db = pool) {
  if (!battle?.id) {
    return {
      exactLock: false,
      lock: null,
      rows: [],
      projections: [],
      saleStatus: { active: false, reason: "historical_scoring_generation" },
      authority: { active: false, reason: "historical_scoring_generation" },
    };
  }

  const [lockResult, scoringResult, metricsResult] = await Promise.all([
    db.query(
      `select battle_id, scoring_version, boost_curve_version, boost_curve_parameters, locked_at
         from public.arena_battle_scoring_locks
        where battle_id = $1
        limit 1`,
      [String(battle.id)],
    ),
    db.query(
      `select battle_id, token_id, side, scoring_version, mcap_weight, holder_weight, volume_weight, boost_weight,
              boost_curve_version, boost_curve_parameters, boost_units, boost_gross_native_raw,
              boost_pool_native_raw, boost_protocol_native_raw, boost_points, mcap_points, holder_points,
              volume_points, total_points, metrics_updated_at, updated_at
         from public.arena_battle_points_v3
        where battle_id = $1
        order by case side when 'left' then 0 else 1 end`,
      [String(battle.id)],
    ),
    db.query(
      `select battle_id, side, data_healthy, data_lag_seconds, market_data_updated_at, metrics_updated_at
         from public.arena_battle_metrics
        where battle_id = $1`,
      [String(battle.id)],
    ),
  ]);

  const lock = lockResult.rows[0] || null;
  const exactLock = exactBattlePointsV3Lock(lock);
  const metricsBySide = new Map((metricsResult.rows || []).map((row) => [String(row.side), row]));
  const projectedEntries = exactLock
    ? (scoringResult.rows || []).map((row) => {
        const projected = projectBattlePointsV3Row(row, metricsBySide.get(String(row.side)) || null);
        return { side: String(row.side), row, ...projected };
      })
    : [];
  const saleStatus = resolveBattlePointsV3BoostSaleStatus({ battle, lock, projections: projectedEntries, env: process.env });
  const authority = resolveBattlePointsV3Authority({ battle, lock, projections: projectedEntries, env: process.env });
  return {
    exactLock,
    lock,
    rows: exactLock ? projectedEntries.map((entry) => projectionShape(entry.row, entry)) : [],
    projections: projectedEntries,
    saleStatus,
    authority,
  };
}

async function readBattleBoosts(res, battleId) {
  if (!battleId) return json(res, 400, { ok: false, error: "Invalid battle id" });
  const battle = await battleForBoost(battleId);
  if (!battle) return json(res, 404, { ok: false, error: "Battle not found" });

  const [actionsResult, runtime] = await Promise.all([
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
    loadBattlePointsV3Runtime(battle),
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
    scoringVersion: runtime.exactLock ? runtime.lock.scoring_version : battle.contest_scoring_version || null,
    weights: runtime.exactLock ? weightsShape() : null,
    boostCurveVersion: runtime.exactLock ? runtime.lock.boost_curve_version : null,
    boostCurveParameters: runtime.exactLock ? runtime.lock.boost_curve_parameters : null,
    summary: serializeBoostSummary(boostSummary(actionsResult.rows)),
    battlePointsV3: runtime.rows,
    scoringActive: runtime.authority.active === true,
    scoringReason: runtime.authority.reason,
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

  const runtime = await loadBattlePointsV3Runtime(battle);
  if (!runtime.saleStatus.active) {
    return json(res, 409, {
      ok: false,
      error: "Battle Boost scoring is not active for this Battle generation",
      code: "BATTLE_BOOST_V3_INACTIVE",
      scoringReason: runtime.saleStatus.reason,
    });
  }

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
      scoringVersion: runtime.lock.scoring_version,
      boostCurveVersion: runtime.lock.boost_curve_version,
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

  if (!Number.isInteger(chainId) || chainId <= 0 || chainId === 101 || chainId === 102) {
    return json(res, 400, { ok: false, error: "Confirmed Battle Boost ingestion currently requires an active EVM money path" });
  }
  if (!battleId || !txHash || logIndex == null || !isAddress(targetToken) || !isAddress(wallet)) {
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

  let chainProof;
  try {
    const provider = await getServerReadProvider(chainId);
    chainProof = await verifyBattleBoostPayment({
      provider,
      chainId,
      txHash,
      logIndex,
      battleId,
      wallet,
      targetToken,
      boostUnits: split.boostUnits,
      grossNativeRaw: split.gross,
    });
  } catch (error) {
    console.error("[api/arenaBoosts] on-chain payment verification failed", error?.message || error);
    return json(res, 409, {
      ok: false,
      error: "Battle Boost payment could not be verified on-chain",
      code: "BOOST_PAYMENT_UNVERIFIED",
    });
  }

  const confirmedAt = chainProof.confirmedAt || safeConfirmedAt(body.confirmedAt);
  if (!confirmedAt) {
    return json(res, 409, {
      ok: false,
      error: "Battle Boost confirmation time could not be verified",
      code: "BOOST_CONFIRMATION_TIME_UNVERIFIED",
    });
  }

  const client = await pool.connect();
  let battle = null;
  try {
    await client.query("BEGIN");
    const battleResult = await client.query(
      `select id, chain_id, state, battle_mode, source, tournament_id, competition_generation, contest_scoring_version, participants
         from public.arena_battles
        where id = $1
        for update`,
      [battleId],
    );
    battle = battleResult.rows[0];
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
      const runtime = await loadBattlePointsV3Runtime(battle);
      return json(res, 200, {
        ok: true,
        confirmed: true,
        idempotent: true,
        action: actionShape(existing),
        chainProof: chainProofShape(chainProof),
        scoringActive: runtime.authority.active === true,
        scoringReason: runtime.authority.reason,
      });
    }

    const lock = (await client.query(
      `select battle_id, scoring_version, boost_curve_version, boost_curve_parameters, locked_at
         from public.arena_battle_scoring_locks
        where battle_id = $1`,
      [battleId],
    )).rows[0] || null;

    if (exactBattlePointsV3Lock(lock)) {
      const currentScore = (await client.query(
        `select battle_id, token_id, side, scoring_version, mcap_weight, holder_weight, volume_weight, boost_weight,
                boost_curve_version, boost_curve_parameters, boost_units, boost_gross_native_raw,
                boost_pool_native_raw, boost_protocol_native_raw, boost_points, mcap_points, holder_points,
                volume_points, total_points, metrics_updated_at, updated_at
           from public.arena_battle_points_v3
          where battle_id = $1 and side = $2
          for update`,
        [battleId, battleCheck.side],
      )).rows[0] || null;
      if (!currentScore) throw new Error("Battle Points V3 projection is missing for locked Battle");
      if (String(currentScore.token_id).toLowerCase() !== targetToken) {
        throw new Error("Battle Points V3 side token changed after Boost confirmation");
      }
      const projectionCheck = projectBattlePointsV3Row(currentScore, null);
      if (!projectionCheck.projectionValid) throw new Error("Battle Points V3 projection is incompatible with immutable scoring lock");

      const nextBoostUnits = BigInt(String(currentScore.boost_units ?? 0)) + split.boostUnits;
      const nextBoostPoints = calculateBattlePointsV3Boost(nextBoostUnits);
      await client.query(
        `update public.arena_battle_points_v3 set
           boost_units = $3,
           boost_gross_native_raw = boost_gross_native_raw + $4,
           boost_pool_native_raw = boost_pool_native_raw + $5,
           boost_protocol_native_raw = boost_protocol_native_raw + $6,
           boost_points = $7,
           total_points = null,
           updated_at = now()
         where battle_id = $1 and side = $2`,
        [
          battleId,
          battleCheck.side,
          nextBoostUnits.toString(),
          split.gross.toString(),
          split.pool.toString(),
          split.protocol.toString(),
          nextBoostPoints,
        ],
      );
    }

    await client.query("COMMIT");
    const [summaryResult, runtime] = await Promise.all([
      pool.query(
        `select side, boost_units, gross_native_raw, pool_native_raw, protocol_native_raw
           from public.arena_contest_actions
          where battle_id = $1 and action_type = 'boost' and phase = 'regulation' and confirmed_at is not null`,
        [battleId],
      ),
      loadBattlePointsV3Runtime(battle),
    ]);
    return json(res, 201, {
      ok: true,
      confirmed: true,
      idempotent: false,
      action: actionShape(insertResult.rows[0]),
      chainProof: chainProofShape(chainProof),
      summary: serializeBoostSummary(boostSummary(summaryResult.rows)),
      scoringVersion: runtime.exactLock ? runtime.lock.scoring_version : battle.contest_scoring_version || null,
      boostCurveVersion: runtime.exactLock ? runtime.lock.boost_curve_version : null,
      boostCurveParameters: runtime.exactLock ? runtime.lock.boost_curve_parameters : null,
      battlePointsV3: runtime.rows,
      scoringActive: runtime.authority.active === true,
      scoringReason: runtime.authority.reason,
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

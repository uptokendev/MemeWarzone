import { ZeroHash } from "ethers";

import { pool } from "../server/db.js";
import { badMethod, isAddress, json, readJson } from "../server/http.js";
import { requireInternalAuth } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { getServerReadProvider } from "./lib/getServerReadProvider.js";
import {
  battleBoostTreasuryV2Address,
  decodeBattleBoostLog,
  expectedBattleBoostPoolId,
  verifyBattleBoostPayment,
} from "./lib/arenaBoostChainVerification.mjs";
import { BATTLE_POINTS_V3_CONFIG } from "./lib/arenaBattlePointsConfig.js";
import { calculateBattlePointsV3Boost } from "./lib/arenaBattlePointsV3.js";
import { battlePoolId } from "./lib/arenaWarPoolEscrow.js";
import { VOTE_BATTLE_BOOST_POINTS_PER_UNIT, isStandaloneVoteBattle, voteBattleRegulationOpen } from "./lib/arenaBattleMode.js";
import {
  DEFAULT_QUOTE_TTL_SECONDS,
  randomBoostNonce,
  resolveBoostPricingConfig,
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
  expectedBoostSplit,
  validateConfirmedBoost,
} from "./lib/arenaBoostRuntime.mjs";
import {
  boostRulesShape,
  boostWindowClosed,
  clampedQuoteDeadlineSeconds,
  evmWalletBoostUnitsUsed,
  insertEvmBoostReservation,
  lockWalletBoostCap,
  readEvmBoostNonceUsed,
  solanaWalletBoostUnitsUsed,
  walletBoostCapExceeded,
} from "./lib/arenaBoostRules.js";

function safeBattleId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : "";
}

function routeInfo(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  if (path === "/arena/boosts/quote") return { action: "quote", battleId: "" };
  if (path === "/arena/boosts/confirm") return { action: "confirm", battleId: "" };
  if (path === "/arena/boosts/evm-payment") return { action: "evm-payment", battleId: "" };
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
    `select id, chain_id, state, battle_mode, source, tournament_id, competition_generation, contest_scoring_version, participants,
            started_at, ends_at, duration_hours
       from public.arena_battles
      where id = $1
      limit 1`,
    [battleId],
  );
  return result.rows[0] || null;
}

// Normal battles and standalone Vote Battles share this route: same pool,
// same on-chain boost, different scoring (Vote Battles: 1 pt per unit in
// arena_contest_actions, no Battle Points V3 projection).
function validateNormalV2Battle(battle, chainId, targetToken) {
  if (!battle) return { status: 404, error: "Battle not found" };
  if (Number(battle.chain_id) !== chainId) return { status: 409, error: "Boost chain does not match battle chain" };
  if (String(battle.state) !== "live") return { status: 409, error: "Boost is only available for a live Battle" };
  const voteBattle = isStandaloneVoteBattle(battle);
  if (!voteBattle && (String(battle.battle_mode || "normal") !== "normal" || String(battle.source || "") === "tournament")) {
    return { status: 409, error: "This endpoint only supports Normal Battle Boosts" };
  }
  if (String(battle.competition_generation || "") !== "arena_competition_v2") {
    return { status: 409, error: "Battle is not using Arena competition V2 money rails" };
  }
  const side = resolveBattleSide(battle.participants, targetToken);
  if (!side) return { status: 409, error: "Boost target is not a Battle combatant" };
  return { side, voteBattle };
}

async function voteBattleBoostWindow(battle) {
  if (!voteBattleRegulationOpen(battle)) {
    return { status: 409, error: "Vote Battle regulation has ended", code: "VOTE_BATTLE_REGULATION_ENDED" };
  }
  const salvo = (await pool.query(`select battle_id from public.arena_vote_tiebreaks where battle_id = $1 limit 1`, [String(battle.id)])).rows[0];
  if (salvo) return { status: 409, error: "Boost is disabled during Final Salvo", code: "FINAL_SALVO_BOOST_DISABLED" };
  return null;
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

function readNonceUsedOn(chainId) {
  let provider = null;
  return async ({ treasuryAddress, wallet, nonce }) => {
    provider = provider || (await getServerReadProvider(chainId));
    return readEvmBoostNonceUsed({ provider, treasuryAddress, wallet, nonce });
  };
}

/** Boost units this wallet already holds or has open in the battle; null when no valid wallet is given. */
async function walletBoostUnitsFor(battle, rawWallet) {
  const chainId = Number(battle.chain_id);
  const wallet = String(rawWallet || "").trim();
  if (!wallet) return null;
  if (chainId === 101 || chainId === 102) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return null;
    return solanaWalletBoostUnitsUsed(pool, { chainId, battleId: String(battle.id), wallet });
  }
  if (!isAddress(wallet)) return null;
  return evmWalletBoostUnitsUsed(pool, { chainId, battleId: String(battle.id), wallet: wallet.toLowerCase(), readNonceUsed: readNonceUsedOn(chainId) });
}

async function readBattleBoosts(req, res, battleId) {
  if (!battleId) return json(res, 400, { ok: false, error: "Invalid battle id" });
  const battle = await battleForBoost(battleId);
  if (!battle) return json(res, 404, { ok: false, error: "Battle not found" });

  const walletParam = new URL(req.url, "http://localhost").searchParams.get("wallet");
  const [actionsResult, runtime, walletBoostUnits] = await Promise.all([
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
    walletBoostUnitsFor(battle, walletParam).catch((error) => {
      console.warn("[api/arenaBoosts] wallet Boost count unavailable", error?.message || error);
      return null;
    }),
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
    pointsPerBoost: isStandaloneVoteBattle(battle) ? VOTE_BATTLE_BOOST_POINTS_PER_UNIT : null,
    boostRules: boostRulesShape(battle),
    walletBoostUnits: walletBoostUnits == null ? null : walletBoostUnits.toString(),
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

  const windowClosed = boostWindowClosed(battle);
  if (windowClosed) {
    const { status, ...body } = windowClosed;
    return json(res, status, { ok: false, ...body });
  }

  let runtime = null;
  if (battleCheck.voteBattle) {
    const closed = await voteBattleBoostWindow(battle);
    if (closed) return json(res, closed.status, { ok: false, error: closed.error, code: closed.code });
  } else {
    runtime = await loadBattlePointsV3Runtime(battle);
    if (!runtime.saleStatus.active) {
      return json(res, 409, {
        ok: false,
        error: "Battle Boost scoring is not active for this Battle generation",
        code: "BATTLE_BOOST_V3_INACTIVE",
        scoringReason: runtime.saleStatus.reason,
      });
    }
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
    config = await resolveBoostPricingConfig(chainId);
  } catch (error) {
    console.error("[api/arenaBoosts] quote pricing unavailable", error?.message || error);
    return json(res, 503, { ok: false, error: "Battle Boost pricing is unavailable" });
  }

  // Cap check, signature and reservation in one transaction under a per-wallet lock, so two quote
  // requests cannot both pass the cap (arenaBoostRules.js).
  const client = await pool.connect();
  let signed;
  let deadline;
  try {
    await client.query("BEGIN");
    await lockWalletBoostCap(client, { chainId, battleId, wallet });
    const used = await evmWalletBoostUnitsUsed(client, { chainId, battleId, wallet, readNonceUsed: readNonceUsedOn(chainId) });
    const capped = walletBoostCapExceeded(used, boostUnits);
    if (capped) {
      await client.query("ROLLBACK");
      const { status, ...rest } = capped;
      return json(res, status, { ok: false, ...rest });
    }
    const now = Math.floor(Date.now() / 1000);
    deadline = clampedQuoteDeadlineSeconds(battle, now, quoteTtlSeconds());
    if (deadline === null) {
      await client.query("ROLLBACK");
      const { status, ...rest } = boostWindowClosed(battle, Number.POSITIVE_INFINITY);
      return json(res, status, { ok: false, ...rest });
    }
    const nonce = randomBoostNonce();
    signed = await signBoostQuote(config, {
      poolId: battlePoolId(battleId),
      matchId: ZeroHash,
      roundNumber: 0,
      booster: wallet,
      sideToken: targetToken,
      boostUnits,
      nonce,
      deadline,
    });
    await insertEvmBoostReservation(client, {
      chainId, battleId, wallet, side: battleCheck.side, boostUnits,
      treasuryAddress: config.treasuryAddress, nonce, deadlineSeconds: deadline,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[api/arenaBoosts] quote signing failed", error);
    return json(res, 503, { ok: false, error: "Battle Boost quote could not be created" });
  } finally {
    client.release();
  }

  try {
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      ok: true,
      battleId,
      side: battleCheck.side,
      usdPerBoostMicros: "1000000",
      scoringVersion: runtime ? runtime.lock.scoring_version : String(battle.contest_scoring_version || "vote_tournament_v1"),
      boostCurveVersion: runtime ? runtime.lock.boost_curve_version : null,
      voteBattle: Boolean(battleCheck.voteBattle),
      pointsPerBoost: battleCheck.voteBattle ? VOTE_BATTLE_BOOST_POINTS_PER_UNIT : null,
      boostRules: boostRulesShape(battle),
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
  const result = await recordBattleBoostPayment(await readJson(req));
  return json(res, result.status, result.body);
}

function reply(status, body) {
  return { status, body };
}

/** The quote reservation that this payment used: paid, and its points are recorded. */
async function markReservationRecorded(db, { chainId, wallet, nonce, txHash, logIndex }) {
  await db.query(
    `update public.arena_boost_quote_reservations
        set status = 'paid', resolved_at = coalesce(resolved_at, now()), tx_hash = $4, log_index = $5,
            recorded_at = now(), record_note = null
      where chain_id = $1 and wallet = $2 and nonce = $3 and recorded_at is null`,
    [Number(chainId), String(wallet).toLowerCase(), String(nonce), txHash, logIndex],
  );
}

/**
 * Records every BattleBoosted event for `battleId` in one transaction. The browser calls this after its
 * Boost transaction confirms; all fields come from the chain event. 202 while the receipt is not
 * available yet (the realtime worker records it later either way).
 */
export async function recordBattleBoostTransaction({ chainId: rawChainId, battleId: rawBattleId, txHash: rawTxHash, provider = null }) {
  const chainId = Number(rawChainId);
  const battleId = safeBattleId(rawBattleId);
  const txHash = safeTxHash(rawTxHash);
  if (!Number.isInteger(chainId) || chainId <= 0 || chainId === 101 || chainId === 102 || !battleId || !txHash) {
    return reply(400, { ok: false, error: "Invalid Battle Boost payment report" });
  }
  let receipt;
  let treasuryAddress;
  let rpc;
  try {
    treasuryAddress = battleBoostTreasuryV2Address(chainId);
    rpc = provider || (await getServerReadProvider(chainId));
    receipt = await rpc.getTransactionReceipt(txHash);
  } catch (error) {
    console.error("[api/arenaBoosts] payment report receipt read failed", error?.message || error);
    return reply(503, { ok: false, error: "Battle Boost transaction could not be read" });
  }
  if (!receipt) return reply(202, { ok: true, pending: true });
  if (Number(receipt.status) !== 1) return reply(409, { ok: false, error: "Battle Boost transaction did not succeed", code: "BOOST_TX_FAILED" });

  const poolId = expectedBattleBoostPoolId(battleId).toLowerCase();
  const results = [];
  for (const log of receipt.logs || []) {
    let event;
    try { event = decodeBattleBoostLog(log, { treasuryAddress }); } catch { continue; }
    if (event.poolId.toLowerCase() !== poolId) continue;
    const split = expectedBoostSplit(event.grossNativeRaw);
    results.push(await recordBattleBoostPayment({
      chainId,
      battleId,
      txHash,
      logIndex: Number(log.index ?? log.logIndex),
      wallet: event.booster.toLowerCase(),
      targetToken: event.sideToken.toLowerCase(),
      boostUnits: event.boostUnits.toString(),
      grossNativeRaw: split.gross.toString(),
      poolNativeRaw: split.pool.toString(),
      protocolNativeRaw: split.protocol.toString(),
    }, { provider: rpc }));
  }
  if (!results.length) return reply(404, { ok: false, error: "No Battle Boost for this battle in that transaction", code: "BOOST_EVENT_NOT_FOUND" });
  const failed = results.find((result) => result.status >= 400);
  return failed || results[results.length - 1];
}

/**
 * Verifies one BattleBoosted event on chain and records its points. Shared by the internal confirm
 * route, the browser's evm-payment report and the realtime worker (arenaEvmBoostReconcile.js); every
 * field is checked against the chain event, so a caller can only record a real payment.
 */
export async function recordBattleBoostPayment(body, { provider: givenProvider = null } = {}) {
  const chainId = Number(body.chainId);
  const battleId = safeBattleId(body.battleId);
  const txHash = safeTxHash(body.txHash);
  const logIndex = safeLogIndex(body.logIndex);
  const targetToken = String(body.targetToken || "").trim().toLowerCase();
  const wallet = String(body.wallet || "").trim().toLowerCase();

  if (!Number.isInteger(chainId) || chainId <= 0 || chainId === 101 || chainId === 102) {
    return reply(400, { ok: false, error: "Confirmed Battle Boost ingestion currently requires an active EVM money path" });
  }
  if (!battleId || !txHash || logIndex == null || !isAddress(targetToken) || !isAddress(wallet)) {
    return reply(400, { ok: false, error: "Invalid confirmed Boost event identity" });
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
    return reply(400, { ok: false, error: error?.message || "Invalid Boost split" });
  }

  let chainProof;
  try {
    const provider = givenProvider || (await getServerReadProvider(chainId));
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
    return reply(409, {
      ok: false,
      error: "Battle Boost payment could not be verified on-chain",
      code: "BOOST_PAYMENT_UNVERIFIED",
    });
  }

  const confirmedAt = chainProof.confirmedAt || safeConfirmedAt(body.confirmedAt);
  if (!confirmedAt) {
    return reply(409, {
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
      return reply(battleCheck.status, { ok: false, error: battleCheck.error });
    }

    const insertResult = await client.query(
      `insert into public.arena_contest_actions (
         chain_id, tournament_id, battle_id, match_id, round_number, phase, salvo_index, side, wallet,
         action_type, boost_units, points, gross_native_raw, pool_native_raw, protocol_native_raw,
         tx_hash, log_index, signature_reference, confirmed_at
       ) values ($1, null, $2, null, 1, 'regulation', null, $3, $4, 'boost', $5, $12, $6, $7, $8, $9, $10, null, $11)
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
        // Vote Battles score boosts directly (1 pt per unit); normal battles
        // score through the Battle Points V3 projection below.
        battleCheck.voteBattle ? (split.boostUnits * BigInt(VOTE_BATTLE_BOOST_POINTS_PER_UNIT)).toString() : 0,
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
      if (!sameEvent) return reply(409, { ok: false, error: "Transaction log is already bound to another contest action" });
      await markReservationRecorded(pool, { chainId, wallet, nonce: chainProof.nonce, txHash, logIndex });
      const runtime = await loadBattlePointsV3Runtime(battle);
      return reply(200, {
        ok: true,
        confirmed: true,
        idempotent: true,
        action: actionShape(existing),
        chainProof: chainProofShape(chainProof),
        scoringActive: runtime.authority.active === true,
        scoringReason: runtime.authority.reason,
      });
    }

    await markReservationRecorded(client, { chainId, wallet, nonce: chainProof.nonce, txHash, logIndex });

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
    return reply(201, {
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
    return reply(500, { ok: false, error: "Failed to confirm Battle Boost" });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const route = routeInfo(req);
  const method = String(req.method || "GET").toUpperCase();
  if (route.action === "read") {
    if (method !== "GET") return badMethod(res);
    return readBattleBoosts(req, res, route.battleId);
  }
  if (route.action === "quote") {
    if (method !== "POST") return badMethod(res);
    return createBattleBoostQuote(req, res);
  }
  if (route.action === "confirm") {
    if (method !== "POST") return badMethod(res);
    return confirmBattleBoost(req, res);
  }
  if (route.action === "evm-payment") {
    if (method !== "POST") return badMethod(res);
    const body = await readJson(req);
    const result = await recordBattleBoostTransaction({ chainId: body.chainId, battleId: body.battleId, txHash: body.txHash });
    return json(res, result.status, result.body);
  }
  return json(res, 404, { ok: false, error: "Unknown Arena Boost route" });
}

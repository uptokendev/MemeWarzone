import Ably from "ably";

import { loadBattleMetrics, loadBattleWindowTrades, loadVolumeContext, refreshCombatantVolumeAndPoints } from "./arenaBattleMetrics.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";

const DEFAULT_REFRESH_MS = 15_000;
const MIN_REFRESH_MS = 5_000;
const MAX_LIVE_BATTLES_PER_TICK = 50;

let workerTimer = null;
let workerRunning = false;
let ablyRest = null;
let dbPoolPromise = null;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function cleanEnv(value) {
  return String(value ?? "")
    .trim()
    .replace(/^[']|[']$/g, "")
    .replace(/^[\"]|[\"]$/g, "");
}

function resolveAblyApiKey() {
  const raw = cleanEnv(process.env.ABLY_API_KEY);
  const keyName = cleanEnv(process.env.ABLY_API_KEY_NAME || process.env.ABLY_KEY_NAME);
  const keySecret = cleanEnv(
    process.env.ABLY_API_KEY_SECRET ||
      process.env.ABLY_KEY_SECRET ||
      process.env.ABLY_API_SECRET ||
      process.env.ABLY_SECRET,
  );
  if (raw.includes(":")) return raw;
  if (raw && keySecret) return `${raw}:${keySecret}`;
  if (keyName && keySecret) return `${keyName}:${keySecret}`;
  return "";
}

async function getDbPool() {
  if (!dbPoolPromise) {
    dbPoolPromise = import("../../server/db.js").then((module) => module.pool);
  }
  return dbPoolPromise;
}

function getAblyRest() {
  if (ablyRest) return ablyRest;
  const key = resolveAblyApiKey();
  if (!key) return null;
  ablyRest = new Ably.Rest({ key });
  return ablyRest;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function safeBattleId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : "";
}

export function arenaBattleChannelName(battleId) {
  const id = safeBattleId(battleId);
  if (!id) throw new Error("Invalid Arena battle id for realtime channel");
  return `arena:battle:${id}`;
}

function sidePublic(row) {
  if (!row) return null;
  const pointsReady = finiteNumber(row.battle_points) !== null;
  return {
    side: String(row.side || ""),
    tokenId: String(row.token_id || ""),
    scoringVersion: String(row.scoring_version || "battle_points_v2"),
    pointsReady,
    baseline: {
      marketCapUsd: finiteNumber(row.start_mcap_usd),
      holders: finiteNumber(row.start_holders),
      liquidityUsd: finiteNumber(row.start_liquidity_usd),
      timestamp: iso(row.baseline_timestamp),
      marketDataUpdatedAt: iso(row.baseline_market_data_updated_at),
      healthy: row.baseline_healthy === true,
      dataSource: row.baseline_data_source || null,
    },
    current: {
      marketCapUsd: finiteNumber(row.current_mcap_usd),
      holders: finiteNumber(row.current_holders),
      liquidityUsd: finiteNumber(row.current_liquidity_usd),
      marketDataUpdatedAt: iso(row.market_data_updated_at),
      dataLagSeconds: finiteNumber(row.data_lag_seconds),
      healthy: row.data_healthy === true,
      dataSource: row.data_source || null,
    },
    eligibleBattleVolumeUsd: Math.max(0, finiteNumber(row.eligible_battle_volume_usd) || 0),
    points: {
      marketCap: Math.max(0, finiteNumber(row.mcap_points) || 0),
      holders: Math.max(0, finiteNumber(row.holder_points) || 0),
      volume: Math.max(0, finiteNumber(row.volume_points) || 0),
      total: Math.max(0, finiteNumber(row.battle_points) || 0),
    },
    metricsUpdatedAt: iso(row.metrics_updated_at || row.updated_at),
  };
}

function leaderFromSides(left, right) {
  if (left?.pointsReady !== true || right?.pointsReady !== true) return null;
  const leftPoints = finiteNumber(left?.points?.total);
  const rightPoints = finiteNumber(right?.points?.total);
  if (leftPoints === null || rightPoints === null) return null;
  if (Math.abs(leftPoints - rightPoints) < 1e-9) return "tied";
  return leftPoints > rightPoints ? "left" : "right";
}

export function buildPublicBattleMetricsSnapshot(battleRow, metricRows = []) {
  const bySide = new Map((metricRows || []).map((row) => [String(row.side), sidePublic(row)]));
  const left = bySide.get("left") || null;
  const right = bySide.get("right") || null;
  const sides = { left, right };
  const healthReasons = [];
  if (!left) healthReasons.push("left_metrics_missing");
  if (!right) healthReasons.push("right_metrics_missing");
  if (left && left.current.healthy !== true) healthReasons.push("left_market_data_unhealthy");
  if (right && right.current.healthy !== true) healthReasons.push("right_market_data_unhealthy");
  if (left && left.pointsReady !== true) healthReasons.push("left_points_pending");
  if (right && right.pointsReady !== true) healthReasons.push("right_points_pending");
  const healthy = healthReasons.length === 0;
  const pointsReady = left?.pointsReady === true && right?.pointsReady === true;
  const leftPoints = finiteNumber(left?.points?.total);
  const rightPoints = finiteNumber(right?.points?.total);
  const metricsUpdatedAt = [left?.metricsUpdatedAt, right?.metricsUpdatedAt]
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    battleId: String(battleRow?.id || ""),
    chainId: Number(battleRow?.chain_id ?? battleRow?.chainId ?? 0) || 0,
    state: String(battleRow?.state || ""),
    scoringVersion: left?.scoringVersion || right?.scoringVersion || "battle_points_v2",
    settlementMode: "v1_mcap_pct_change",
    leaderSide: leaderFromSides(left, right),
    pointDifference: pointsReady && leftPoints !== null && rightPoints !== null ? Math.abs(leftPoints - rightPoints) : null,
    metricsUpdatedAt,
    dataHealth: {
      healthy,
      status: healthy ? "healthy" : "data_delay",
      reasons: healthReasons,
    },
    sides,
  };
}

export function decorateBattleWithMetrics(battle, metrics) {
  if (!battle || !metrics) return battle;
  const participants = Array.isArray(battle.participants) ? battle.participants.map((entry) => ({ ...entry })) : [];
  const sideRows = [metrics.sides?.left, metrics.sides?.right];
  for (let index = 0; index < Math.min(2, participants.length); index += 1) {
    const side = sideRows[index];
    if (!side) continue;
    participants[index] = {
      ...participants[index],
      battlePoints: side.points.total,
      mcapPoints: side.points.marketCap,
      holderPoints: side.points.holders,
      volumePoints: side.points.volume,
      battleVolumeUsd: side.eligibleBattleVolumeUsd,
      marketCapUsd: side.current.marketCapUsd ?? participants[index].marketCapUsd,
      holderCount: side.current.holders ?? participants[index].holderCount,
      liquidityUsd: side.current.liquidityUsd ?? participants[index].liquidityUsd,
      marketDataHealthy: side.current.healthy,
      marketDataUpdatedAt: side.current.marketDataUpdatedAt,
    };
  }
  return {
    ...battle,
    participants,
    battlePointsPreview: metrics,
    battlePointsLeaderSide: metrics.leaderSide,
    battlePointsDifference: metrics.pointDifference,
    battlePointsDataHealth: metrics.dataHealth,
    battlePointsUpdatedAt: metrics.metricsUpdatedAt,
  };
}

export async function readPublicBattleMetricsSnapshot(battleRow, deps = {}) {
  if (!battleRow?.id) return null;
  let query = deps.query;
  if (!query) {
    const db = await getDbPool();
    query = (text, params) => db.query(text, params);
  }
  const metrics = await loadBattleMetrics(String(battleRow.id), { query });
  if (!metrics.length) return null;
  return buildPublicBattleMetricsSnapshot(battleRow, metrics);
}

async function refreshCombatant({ battleRow, metricsRow, query, now }) {
  const chainId = Number(battleRow.chain_id);
  const snapshot = await getArenaMarketSnapshot(chainId, metricsRow.token_id, { query, nowMs: now.getTime() });
  const liveAt = metricsRow.baseline_timestamp || battleRow.started_at;
  const battleEndMs = battleRow.ends_at ? Date.parse(battleRow.ends_at) : NaN;
  const finishAt = Number.isFinite(battleEndMs) && battleEndMs < now.getTime()
    ? new Date(battleEndMs).toISOString()
    : now.toISOString();
  const trades = await loadBattleWindowTrades({
    chainId,
    campaignAddress: snapshot.campaignAddress,
    tokenAddress: snapshot.tokenAddress || metricsRow.token_id,
    liveAt,
    finishAt,
  }, { query });
  const volumeContext = await loadVolumeContext(
    chainId,
    snapshot,
    trades.map((trade) => trade.wallet),
    { query },
  );
  return refreshCombatantVolumeAndPoints({
    row: battleRow,
    metricsRow,
    snapshot,
    trades,
    volumeContext,
    now,
  }, { query });
}

async function publishEvent(battleId, name, payload) {
  const rest = getAblyRest();
  if (!rest) return { published: false, reason: "ably_not_configured" };
  try {
    const channel = rest.channels.get(arenaBattleChannelName(battleId));
    await channel.publish(name, payload);
    return { published: true };
  } catch (error) {
    console.warn("[arena-battle-realtime] publish failed", name, battleId, error?.message || error);
    return { published: false, reason: "publish_failed" };
  }
}

export async function publishBattleMetricsSnapshot(snapshot, previousSnapshot = null) {
  if (!snapshot?.battleId) return { published: false, reason: "snapshot_missing" };
  const common = {
    battleId: snapshot.battleId,
    chainId: snapshot.chainId,
    scoringVersion: snapshot.scoringVersion,
    metricsUpdatedAt: snapshot.metricsUpdatedAt,
    dataHealth: snapshot.dataHealth,
  };
  const metricsResult = await publishEvent(snapshot.battleId, "arena_battle_metrics_patch", {
    ...common,
    sides: snapshot.sides,
  });
  const pointsResult = await publishEvent(snapshot.battleId, "arena_battle_points_patch", {
    ...common,
    leaderSide: snapshot.leaderSide,
    pointDifference: snapshot.pointDifference,
    left: snapshot.sides?.left?.points || null,
    right: snapshot.sides?.right?.points || null,
  });
  const previousLeader = previousSnapshot?.leaderSide || null;
  if (previousLeader && snapshot.leaderSide && previousLeader !== snapshot.leaderSide) {
    await publishEvent(snapshot.battleId, "arena_battle_lead_changed", {
      ...common,
      from: previousLeader,
      to: snapshot.leaderSide,
      pointDifference: snapshot.pointDifference,
    });
  }
  return {
    published: metricsResult.published === true || pointsResult.published === true,
    reason: metricsResult.published === true || pointsResult.published === true ? null : metricsResult.reason || pointsResult.reason || "publish_failed",
  };
}

export async function publishBattleFinished(battleRow, battle, metrics = null) {
  if (!battleRow?.id) return { published: false, reason: "battle_missing" };
  const publicMetrics = metrics || await readPublicBattleMetricsSnapshot(battleRow).catch(() => null);
  return publishEvent(battleRow.id, "arena_battle_finished", {
    battleId: String(battleRow.id),
    chainId: Number(battleRow.chain_id),
    state: "finished",
    settlementMode: "v1_mcap_pct_change",
    winnerToken: battle?.moneyWinnerToken || battle?.winnerToken || battleRow.money_winner_token || battleRow.winner_token || null,
    settledAt: battle?.settlementAt || battleRow.settled_at || battleRow.finished_at || new Date().toISOString(),
    battlePointsPreview: publicMetrics,
  });
}

async function refreshBattleWithClient(client, battleId, now = new Date()) {
  const query = (text, params) => client.query(text, params);
  await client.query("begin");
  try {
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(hashtext($1)) as locked`,
      [`arena-battle-realtime:${battleId}`],
    );
    if (lock.rows[0]?.locked !== true) {
      await client.query("rollback");
      return { refreshed: false, reason: "locked" };
    }
    const battleResult = await client.query(
      `select id, chain_id, state, challenger_token, defender_token, started_at, ends_at,
              money_winner_token, winner_token, settled_at, finished_at
         from public.arena_battles
        where id = $1
        limit 1`,
      [battleId],
    );
    const battleRow = battleResult.rows[0];
    if (!battleRow || battleRow.state !== "live") {
      await client.query("commit");
      return { refreshed: false, reason: battleRow ? "not_live" : "missing" };
    }
    const beforeRows = await loadBattleMetrics(battleId, { query });
    if (beforeRows.length !== 2) {
      await client.query("rollback");
      return { refreshed: false, reason: "baseline_incomplete" };
    }
    const previousSnapshot = buildPublicBattleMetricsSnapshot(battleRow, beforeRows);
    for (const metricsRow of beforeRows) {
      await refreshCombatant({ battleRow, metricsRow, query, now });
    }
    const afterRows = await loadBattleMetrics(battleId, { query });
    const snapshot = buildPublicBattleMetricsSnapshot(battleRow, afterRows);
    await client.query("commit");
    return { refreshed: true, snapshot, previousSnapshot, battleRow };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function refreshLiveBattleMetrics(battleId, options = {}) {
  const id = safeBattleId(battleId);
  if (!id) return { refreshed: false, reason: "invalid_battle_id" };
  const db = await getDbPool();
  const client = await db.connect();
  try {
    const result = await refreshBattleWithClient(client, id, options.now || new Date());
    if (result.refreshed && options.publish !== false) {
      await publishBattleMetricsSnapshot(result.snapshot, result.previousSnapshot);
    }
    return result;
  } finally {
    client.release();
  }
}

export async function refreshAllLiveBattleMetrics(options = {}) {
  const limit = Math.max(1, Math.min(MAX_LIVE_BATTLES_PER_TICK, Number(options.limit) || MAX_LIVE_BATTLES_PER_TICK));
  const db = await getDbPool();
  const rows = await db.query(
    `select b.id
       from public.arena_battles b
       left join lateral (
         select min(m.metrics_updated_at) as oldest_metrics_updated_at
           from public.arena_battle_metrics m
          where m.battle_id = b.id
       ) refreshed on true
      where b.state = 'live'
      order by coalesce(refreshed.oldest_metrics_updated_at, b.started_at, b.created_at) asc
      limit $1`,
    [limit],
  );
  const results = [];
  for (const row of rows.rows || []) {
    try {
      results.push(await refreshLiveBattleMetrics(row.id, { publish: options.publish !== false }));
    } catch (error) {
      console.warn("[arena-battle-realtime] refresh failed", row.id, error?.message || error);
      results.push({ refreshed: false, reason: "refresh_failed", battleId: row.id });
    }
  }
  return results;
}

export function startArenaBattleRealtimeWorker() {
  if (!truthy(process.env.ARENA_BATTLE_REALTIME_ENABLED)) {
    return { started: false, reason: "disabled" };
  }
  if (workerTimer) return { started: false, reason: "already_started" };
  const configured = Number(process.env.ARENA_BATTLE_REALTIME_REFRESH_MS || DEFAULT_REFRESH_MS);
  const intervalMs = Math.max(MIN_REFRESH_MS, Number.isFinite(configured) ? configured : DEFAULT_REFRESH_MS);
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await refreshAllLiveBattleMetrics();
    } catch (error) {
      console.warn("[arena-battle-realtime] worker tick failed", error?.message || error);
    } finally {
      workerRunning = false;
    }
  };
  workerTimer = setInterval(() => void tick(), intervalMs);
  workerTimer.unref?.();
  void tick();
  console.log(`[arena-battle-realtime] worker started intervalMs=${intervalMs}`);
  return { started: true, intervalMs };
}

export function stopArenaBattleRealtimeWorker() {
  if (!workerTimer) return false;
  clearInterval(workerTimer);
  workerTimer = null;
  return true;
}

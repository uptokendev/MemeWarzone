import { BATTLE_POINTS_CONFIG, BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";
import {
  loadBattleMetrics,
  loadBattleWindowTrades,
  loadVolumeContext,
  refreshCombatantVolumeAndPoints,
} from "./arenaBattleMetrics.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";

export const FINAL_SCORE_REASON = Object.freeze({
  OK: "ok",
  BATTLE_MISSING: "battle_missing",
  CLOSE_TIME_MISSING: "battle_close_time_missing",
  BASELINE_INCOMPLETE: "baseline_incomplete",
  SCORING_VERSION_MISMATCH: "scoring_version_mismatch",
  PRE_CLOSE_MARKET_DATA_MISSING: "pre_close_market_data_missing",
  FINAL_SCORE_UNHEALTHY: "final_score_unhealthy",
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sideMap(rows) {
  return new Map((rows || []).map((row) => [String(row.side || ""), row]));
}

function metricFallbackSnapshot(identitySnapshot, metricsRow, closeMs) {
  const updatedMs = timestampMs(metricsRow?.market_data_updated_at);
  if (updatedMs === null || updatedMs > closeMs) return null;
  const lagSeconds = Math.max(0, (closeMs - updatedMs) / 1000);
  const fresh = lagSeconds <= BATTLE_POINTS_CONFIG.staleSeconds;
  if (metricsRow?.data_healthy !== true || !fresh) return null;

  return {
    ...identitySnapshot,
    marketCapUsd: finite(metricsRow.current_mcap_usd),
    holders: finite(metricsRow.current_holders),
    liquidityUsd: finite(metricsRow.current_liquidity_usd),
    updatedAt: new Date(updatedMs).toISOString(),
    dataLagSeconds: lagSeconds,
    dataSource: metricsRow.data_source || identitySnapshot?.dataSource || "arena_persisted_pre_close",
    healthy: true,
    reason: null,
    reasons: [],
  };
}

/**
 * Select a market state that was actually accepted by the server no later than
 * battle close. Latest shared-market state is preferred only when its source
 * timestamp is at/before close; otherwise the last healthy persisted Battle
 * metric may be used if it is still inside the normal freshness window.
 */
export function selectPreCloseMarketSnapshot(identitySnapshot, metricsRow, closeAt) {
  const closeMs = timestampMs(closeAt);
  if (closeMs === null) return null;

  const liveUpdatedMs = timestampMs(identitySnapshot?.updatedAt);
  if (identitySnapshot?.healthy === true && liveUpdatedMs !== null && liveUpdatedMs <= closeMs) {
    const lagSeconds = Math.max(0, (closeMs - liveUpdatedMs) / 1000);
    if (lagSeconds <= BATTLE_POINTS_CONFIG.staleSeconds) {
      return {
        ...identitySnapshot,
        dataLagSeconds: lagSeconds,
        healthy: true,
        reason: null,
        reasons: [],
      };
    }
  }

  return metricFallbackSnapshot(identitySnapshot, metricsRow, closeMs);
}

function publicSide(metricsRow, scored) {
  return {
    side: String(metricsRow.side),
    tokenId: String(metricsRow.token_id),
    scoringVersion: String(scored.scoringVersion || metricsRow.scoring_version || BATTLE_POINTS_V2),
    totalPoints: scored.totalPoints,
    mcap: scored.mcap,
    holders: scored.holders,
    volume: scored.volume,
    components: scored.components,
    performance: scored.performance,
    dataHealth: scored.dataHealth,
    marketDataUpdatedAt: scored.marketDataUpdatedAt,
  };
}

export async function reconcileBattlePointsAtClose(battleRow, deps = {}) {
  if (!battleRow?.id) return { ok: false, reason: FINAL_SCORE_REASON.BATTLE_MISSING };
  const query = deps.query;
  if (typeof query !== "function") throw new Error("reconcileBattlePointsAtClose requires a transactional query function");

  const closeMs = timestampMs(battleRow.ends_at || battleRow.endsAt);
  if (closeMs === null) return { ok: false, reason: FINAL_SCORE_REASON.CLOSE_TIME_MISSING };
  const closeAt = new Date(closeMs).toISOString();
  const chainId = Number(battleRow.chain_id ?? battleRow.chainId);
  const metricsRows = await loadBattleMetrics(String(battleRow.id), { query });
  const bySide = sideMap(metricsRows);
  if (!bySide.get("left") || !bySide.get("right") || metricsRows.length !== 2) {
    return { ok: false, reason: FINAL_SCORE_REASON.BASELINE_INCOMPLETE };
  }
  if (metricsRows.some((row) => String(row.scoring_version || "") !== BATTLE_POINTS_V2)) {
    return { ok: false, reason: FINAL_SCORE_REASON.SCORING_VERSION_MISMATCH };
  }

  const finalSides = {};
  for (const side of ["left", "right"]) {
    const metricsRow = bySide.get(side);
    const identitySnapshot = await (deps.getSnapshot || getArenaMarketSnapshot)(
      chainId,
      metricsRow.token_id,
      { query, nowMs: closeMs },
    );
    const snapshot = selectPreCloseMarketSnapshot(identitySnapshot, metricsRow, closeAt);
    if (!snapshot) {
      return {
        ok: false,
        reason: FINAL_SCORE_REASON.PRE_CLOSE_MARKET_DATA_MISSING,
        side,
      };
    }

    const liveAt = metricsRow.baseline_timestamp || battleRow.started_at;
    const trades = await loadBattleWindowTrades({
      chainId,
      campaignAddress: identitySnapshot?.campaignAddress || null,
      tokenAddress: identitySnapshot?.tokenAddress || metricsRow.token_id,
      liveAt,
      finishAt: closeAt,
    }, { query, nativeUsd: deps.nativeUsd, resolveNativeUsd: deps.resolveNativeUsd });
    const volumeContext = await loadVolumeContext(
      chainId,
      identitySnapshot || snapshot,
      trades.map((trade) => trade.wallet),
      { query },
    );
    const refreshed = await refreshCombatantVolumeAndPoints({
      row: battleRow,
      metricsRow,
      snapshot,
      trades,
      volumeContext,
      now: new Date(closeMs),
    }, { query });
    if (refreshed.scored?.dataHealth?.healthy !== true) {
      return {
        ok: false,
        reason: FINAL_SCORE_REASON.FINAL_SCORE_UNHEALTHY,
        side,
        dataHealth: refreshed.scored?.dataHealth || null,
      };
    }
    finalSides[side] = publicSide(metricsRow, refreshed.scored);
  }

  const persisted = await loadBattleMetrics(String(battleRow.id), { query });
  const metricsUpdatedAt = persisted
    .map((row) => timestampMs(row.metrics_updated_at || row.updated_at))
    .filter((value) => value !== null)
    .sort((a, b) => b - a)[0] ?? null;

  return {
    ok: true,
    reason: FINAL_SCORE_REASON.OK,
    battleId: String(battleRow.id),
    chainId,
    closeAt,
    metricsUpdatedAt: metricsUpdatedAt === null ? null : new Date(metricsUpdatedAt).toISOString(),
    sides: finalSides,
  };
}

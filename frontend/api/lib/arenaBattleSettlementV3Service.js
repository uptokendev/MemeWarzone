import { pool } from "../../server/db.js";
import { battleLeagueEligibility } from "./arenaBattleCompetition.js";
import {
  BATTLE_POINTS_V3,
  BATTLE_POINTS_V3_BOOST_CURVE,
  BATTLE_POINTS_V3_CONFIG,
} from "./arenaBattlePointsConfig.js";
import { calculateCanonicalBattlePoints } from "./arenaBattlePointsCanonical.js";
import { selectPreCloseMarketSnapshot } from "./arenaBattleFinalScore.js";
import {
  loadBattleMetrics,
  loadBattleWindowTrades,
  loadVolumeContext,
  replaceBattleVolumeAudit,
} from "./arenaBattleMetrics.js";
import { computeEligibleBattleVolume, volumeAuditRows } from "./arenaBattleVolume.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";
import { battleSettlementPatch, decorateSettledParticipants } from "./arenaBattleSettle.js";
import { decideBattlePointsV3Settlement } from "./arenaBattleSettleV3.js";
import { recordFinishedBattle } from "./arenaLeagueScore.js";
import { notifyBattleWinnerConfirmed } from "./arenaLifecycleNotifications.js";

const SETTLE_COLUMNS = `id, chain_id, state, source, battle_mode, competition_generation,
  challenger_token, defender_token, tournament_id, participants, started_at, ends_at,
  created_at, updated_at`;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampMs(value) {
  if (!value) return null;
  const n = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function exactMetricLock(row) {
  return Boolean(
    row
    && String(row.scoring_version || "") === BATTLE_POINTS_V3
    && String(row.scoring_generation || "") === BATTLE_POINTS_V3
    && String(row.curve_version || "") === BATTLE_POINTS_V3_BOOST_CURVE
  );
}

function canonicalCurveParameters() {
  return {
    maxPoints: BATTLE_POINTS_V3_CONFIG.boost.curveParameters.maxPoints,
    halfSaturationUnits: BATTLE_POINTS_V3_CONFIG.boost.curveParameters.halfSaturationUnits,
    unitUsdMicros: BATTLE_POINTS_V3_CONFIG.boost.curveParameters.unitUsdMicros,
  };
}

function evidenceFrom(metricsRow, snapshot, volume) {
  return {
    baseline: {
      startMcapUsd: metricsRow.start_mcap_usd,
      startHolders: metricsRow.start_holders,
      startLiquidityUsd: metricsRow.start_liquidity_usd,
      baselineTimestamp: metricsRow.baseline_timestamp,
      marketDataUpdatedAt: metricsRow.baseline_market_data_updated_at,
    },
    current: {
      marketCapUsd: snapshot?.marketCapUsd,
      holders: snapshot?.holders ?? snapshot?.holderCount ?? null,
      liquidityUsd: snapshot?.liquidityUsd,
      updatedAt: snapshot?.updatedAt,
      healthy: snapshot?.healthy,
      dataLagSeconds: snapshot?.dataLagSeconds,
      reason: snapshot?.reason,
      reasons: snapshot?.reasons,
    },
    eligibleVolume: {
      usd: volume.eligibleUsd,
      rawUsd: volume.rawUsd,
      excludedUsd: volume.excludedUsd,
      cappedUsd: volume.cappedUsd,
      clusters: volume.clusters,
    },
  };
}

async function loadConfirmedBoostAuthority(client, battleId) {
  const result = await client.query(
    `select side, coalesce(sum(boost_units), 0)::text as boost_units,
            coalesce(sum(gross_native_raw), 0)::text as gross_native_raw,
            coalesce(sum(pool_native_raw), 0)::text as pool_native_raw,
            coalesce(sum(protocol_native_raw), 0)::text as protocol_native_raw
       from public.arena_contest_actions
      where battle_id = $1
        and action_type = 'boost'
        and phase = 'regulation'
        and confirmed_at is not null
      group by side`,
    [String(battleId)],
  );
  const bySide = new Map((result.rows || []).map((row) => [String(row.side), row]));
  const normalize = (side) => {
    const row = bySide.get(side) || {};
    const units = Number(row.boost_units || 0);
    if (!Number.isSafeInteger(units) || units < 0) throw new Error("confirmed_boost_authority_invalid");
    return {
      units,
      grossNativeRaw: String(row.gross_native_raw || "0"),
      poolNativeRaw: String(row.pool_native_raw || "0"),
      protocolNativeRaw: String(row.protocol_native_raw || "0"),
    };
  };
  return { left: normalize("left"), right: normalize("right") };
}

async function persistFinalSide(client, battleId, metricsRow, snapshot, volume, scored, boost) {
  const audit = volumeAuditRows({
    battleId: String(battleId),
    tokenId: String(metricsRow.token_id),
    side: String(metricsRow.side),
    result: volume,
  });
  await replaceBattleVolumeAudit({
    battleId: String(battleId),
    tokenId: String(metricsRow.token_id),
    rows: audit,
  }, { query: (text, params) => client.query(text, params) });

  await client.query(
    `update public.arena_battle_metrics set
        current_mcap_usd = $3,
        current_holders = $4,
        current_liquidity_usd = $5,
        market_data_updated_at = $6,
        data_lag_seconds = $7,
        data_source = $8,
        data_healthy = $9,
        eligible_battle_volume_usd = $10,
        volume_raw_usd = $11,
        volume_excluded_usd = $12,
        volume_capped_usd = $13,
        mcap_points = $14,
        holder_points = $15,
        volume_points = $16,
        battle_points = $17,
        metrics_updated_at = now()
      where battle_id = $1 and side = $2`,
    [
      String(battleId), String(metricsRow.side), finite(snapshot?.marketCapUsd),
      finite(snapshot?.holders ?? snapshot?.holderCount), finite(snapshot?.liquidityUsd),
      snapshot?.updatedAt || null, finite(snapshot?.dataLagSeconds), snapshot?.dataSource || metricsRow.data_source || null,
      scored.dataHealth?.healthy === true, volume.eligibleUsd, volume.rawUsd, volume.excludedUsd, volume.cappedUsd,
      scored.mcap?.points ?? null, scored.holders?.points ?? null, scored.volume?.points ?? null, scored.totalPoints,
    ],
  );

  await client.query(
    `insert into public.arena_battle_points_v3 (
        battle_id, token_id, side, scoring_version,
        mcap_weight, holder_weight, volume_weight, boost_weight,
        boost_curve_version, boost_curve_parameters,
        boost_units, boost_gross_native_raw, boost_pool_native_raw, boost_protocol_native_raw,
        boost_points, mcap_points, holder_points, volume_points, total_points, metrics_updated_at
      ) values ($1,$2,$3,'battle_points_v3',45,27,18,10,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
      on conflict (battle_id, side) do update set
        boost_units = excluded.boost_units,
        boost_gross_native_raw = excluded.boost_gross_native_raw,
        boost_pool_native_raw = excluded.boost_pool_native_raw,
        boost_protocol_native_raw = excluded.boost_protocol_native_raw,
        boost_points = excluded.boost_points,
        mcap_points = excluded.mcap_points,
        holder_points = excluded.holder_points,
        volume_points = excluded.volume_points,
        total_points = excluded.total_points,
        metrics_updated_at = now()`,
    [
      String(battleId), String(metricsRow.token_id), String(metricsRow.side),
      BATTLE_POINTS_V3_BOOST_CURVE, JSON.stringify(canonicalCurveParameters()),
      boost.units, boost.grossNativeRaw, boost.poolNativeRaw, boost.protocolNativeRaw,
      scored.boost?.points ?? null, scored.mcap?.points ?? null, scored.holders?.points ?? null,
      scored.volume?.points ?? null, scored.totalPoints,
    ],
  );
}

async function scoreSideAtClose({ current, metricsRow, closeMs, boost, client, deps }) {
  const query = (text, params) => client.query(text, params);
  const chainId = Number(current.chain_id);
  const identitySnapshot = await (deps.getSnapshot || getArenaMarketSnapshot)(chainId, metricsRow.token_id, { query, nowMs: closeMs });
  const closeAt = new Date(closeMs).toISOString();
  const snapshot = selectPreCloseMarketSnapshot(identitySnapshot, metricsRow, closeAt);
  if (!snapshot) return { ok: false, reason: "pre_close_market_data_missing" };

  const liveAt = metricsRow.baseline_timestamp || current.started_at;
  const trades = await loadBattleWindowTrades({
    chainId,
    campaignAddress: identitySnapshot?.campaignAddress || null,
    tokenAddress: identitySnapshot?.tokenAddress || metricsRow.token_id,
    liveAt,
    finishAt: closeAt,
  }, { query, nativeUsd: deps.nativeUsd, resolveNativeUsd: deps.resolveNativeUsd });
  const volumeContext = await loadVolumeContext(chainId, identitySnapshot || snapshot, trades.map((trade) => trade.wallet), { query });
  const volume = computeEligibleBattleVolume({ trades, liveAt, finishAt: closeAt, ...volumeContext });
  const evidence = evidenceFrom(metricsRow, snapshot, volume);
  const scored = calculateCanonicalBattlePoints({
    scoringVersion: String(metricsRow.scoring_generation),
    ...evidence,
    confirmedBoostUnits: boost.units,
    now: closeMs,
  });
  if (scored.settleable !== true || scored.dataHealth?.healthy !== true) {
    return { ok: false, reason: scored.dataHealth?.reason || "final_score_unhealthy", dataHealth: scored.dataHealth };
  }
  await persistFinalSide(client, current.id, metricsRow, snapshot, volume, scored, boost);
  return { ok: true, scored, snapshot, volume, closeAt };
}

// Compatibility export for diagnostics only. Settlement itself never consults this flag.
export function battlePointsV3SettlementRuntimeEnabled() {
  return true;
}

export async function settleBattlePointsV3ById(battleId, deps = {}) {
  const db = deps.pool || pool;
  const client = await db.connect();
  try {
    await client.query("begin");
    const locked = await client.query(
      `select ${SETTLE_COLUMNS}
         from public.arena_battles b
        where b.id = $1
          and b.state = 'live'
          and coalesce(b.battle_mode, 'normal') = 'normal'
          and b.source <> 'tournament'
          and b.ends_at is not null
          and b.ends_at <= now()
        for update`,
      [String(battleId)],
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query("commit");
      return { settled: false, reason: "not_due_already_settled_or_not_normal" };
    }

    const metricsRows = await loadBattleMetrics(String(battleId), { query: (text, params) => client.query(text, params) });
    const bySide = new Map(metricsRows.map((row) => [String(row.side), row]));
    if (metricsRows.length !== 2 || !bySide.get("left") || !bySide.get("right")) {
      await client.query("rollback");
      return { settled: false, reason: "baseline_incomplete", dataDelay: true };
    }
    if (!metricsRows.every(exactMetricLock)) {
      await client.query("rollback");
      return { settled: false, reason: "missing_or_incompatible_v3_scoring_lock", dataDelay: true };
    }

    const closeMs = timestampMs(current.ends_at);
    if (closeMs === null) {
      await client.query("rollback");
      return { settled: false, reason: "battle_close_time_missing", dataDelay: true };
    }

    let boosts;
    try {
      boosts = await loadConfirmedBoostAuthority(client, battleId);
    } catch (error) {
      await client.query("rollback");
      return { settled: false, reason: "confirmed_boost_authority_unavailable", dataDelay: true, error: String(error?.message || error) };
    }

    const left = await scoreSideAtClose({ current, metricsRow: bySide.get("left"), closeMs, boost: boosts.left, client, deps });
    if (!left.ok) {
      await client.query("rollback");
      return { settled: false, reason: left.reason, dataDelay: true, side: "left", dataHealth: left.dataHealth || null };
    }
    const right = await scoreSideAtClose({ current, metricsRow: bySide.get("right"), closeMs, boost: boosts.right, client, deps });
    if (!right.ok) {
      await client.query("rollback");
      return { settled: false, reason: right.reason, dataDelay: true, side: "right", dataHealth: right.dataHealth || null };
    }

    const decision = decideBattlePointsV3Settlement({
      leftToken: current.challenger_token,
      rightToken: current.defender_token,
      leftScored: left.scored,
      rightScored: right.scored,
    });
    if (!decision.ok) {
      await client.query("rollback");
      return { settled: false, reason: decision.reason, dataDelay: true };
    }

    const participants = decorateSettledParticipants(current.participants, decision);
    const league = battleLeagueEligibility({ ...current, participants });
    if (league.eligible) {
      await recordFinishedBattle({
        ...current,
        mwlDraw: decision.mwlDraw,
        mwlWinnerToken: decision.mwlWinnerToken,
        mwlResult: decision.mwlResult,
        participants,
      }, client);
    }

    const settledAt = new Date().toISOString();
    const metricsUpdatedAt = [left.snapshot?.updatedAt, right.snapshot?.updatedAt].filter(Boolean).sort().at(-1) || settledAt;
    const write = battleSettlementPatch(decision, { nowIso: settledAt, participants, metricsUpdatedAt });
    const result = await client.query(
      `update public.arena_battles set
          state = 'finished', winner_token = $2, money_winner_token = $3, money_tie_break = $4,
          mwl_result = $5, mwl_draw = $6, mwl_winner_token = $7,
          challenger_end_mcap_usd = $8, defender_end_mcap_usd = $9,
          challenger_pct_change = $10, defender_pct_change = $11,
          settlement_version = $12, settlement_scoring_version = $13,
          challenger_battle_points = $14, defender_battle_points = $15,
          challenger_mcap_points = $16, defender_mcap_points = $17,
          challenger_holder_points = $18, defender_holder_points = $19,
          challenger_volume_points = $20, defender_volume_points = $21,
          settlement_metrics_updated_at = $22::timestamptz,
          settlement_tie_break_used = $23, settled_at = $24::timestamptz,
          finished_at = $24::timestamptz, participants = $25::jsonb, updated_at = now()
        where id = $1 and state = 'live'
        returning id, chain_id, state, source, challenger_token, defender_token, tournament_id,
                  participants, winner_token, money_winner_token, money_tie_break,
                  mwl_result, mwl_draw, mwl_winner_token, settlement_version,
                  settlement_scoring_version, challenger_battle_points, defender_battle_points,
                  settlement_metrics_updated_at, settlement_tie_break_used,
                  settled_at, finished_at, updated_at`,
      [
        current.id, write.patch.winner_token, write.patch.money_winner_token, write.patch.money_tie_break,
        write.patch.mwl_result, write.patch.mwl_draw, write.patch.mwl_winner_token,
        write.patch.challenger_end_mcap_usd, write.patch.defender_end_mcap_usd,
        write.patch.challenger_pct_change, write.patch.defender_pct_change,
        write.patch.settlement_version, write.patch.settlement_scoring_version,
        write.patch.challenger_battle_points, write.patch.defender_battle_points,
        write.patch.challenger_mcap_points, write.patch.defender_mcap_points,
        write.patch.challenger_holder_points, write.patch.defender_holder_points,
        write.patch.challenger_volume_points, write.patch.defender_volume_points,
        write.patch.settlement_metrics_updated_at, write.patch.settlement_tie_break_used,
        write.patch.settled_at, JSON.stringify(write.patch.participants || []),
      ],
    );
    const finished = result.rows[0] || null;
    if (!finished) {
      await client.query("rollback");
      return { settled: false, reason: "settlement_write_lost_race" };
    }
    await client.query("commit");
    await notifyBattleWinnerConfirmed(db, finished);
    return {
      settled: true,
      reason: "ok",
      battle: finished,
      decision,
      league,
      scoringLock: { scoringVersion: BATTLE_POINTS_V3, scoringGeneration: 3, curveVersion: BATTLE_POINTS_V3_BOOST_CURVE },
      sides: { left: left.scored, right: right.scored },
      boostAuthority: boosts,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

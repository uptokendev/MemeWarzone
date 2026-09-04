#!/usr/bin/env node

import { pool } from "../server/db.js";
import { publishBattleFinished, startArenaBattleRealtimeWorker, stopArenaBattleRealtimeWorker } from "../api/lib/arenaBattleRealtime.js";
import { battlePointsV2SettlementEnabled, settleBattlePointsV2ById } from "../api/lib/arenaBattleSettlementV2Service.js";
import { battlePointsV3SettlementRuntimeEnabled, settleBattlePointsV3ById } from "../api/lib/arenaBattleSettlementV3Service.js";
import { advanceDueFinalSalvo, finalizeDueVoteTournamentBattle, voteTournamentRuntimeEnabled } from "../api/lib/arenaVoteTournamentFinalizationService.js";
import { advanceTournamentFromBattle } from "../api/arenaTournaments.js";

const settlementV2Enabled = battlePointsV2SettlementEnabled();
const settlementV3Enabled = battlePointsV3SettlementRuntimeEnabled();
const voteRuntimeEnabled = voteTournamentRuntimeEnabled();
const started = startArenaBattleRealtimeWorker();
if (!started.started && !settlementV2Enabled && !settlementV3Enabled && !voteRuntimeEnabled) {
  console.log(`[arena-battle-realtime-worker] not started: ${started.reason || "unknown"}`);
  process.exit(0);
}
if (started.started) console.log(`[arena-battle-realtime-worker] realtime active intervalMs=${started.intervalMs}`);
if (settlementV2Enabled) console.log("[arena-battle-realtime-worker] Battle Points V2 settlement active");
if (settlementV3Enabled) console.log("[arena-battle-realtime-worker] Battle Points V3 settlement active for explicitly locked Battles");
if (voteRuntimeEnabled) console.log("[arena-battle-realtime-worker] Vote Tournament + Final Salvo runtime active");

const finishedScanMs = Math.max(5_000, Number(process.env.ARENA_BATTLE_FINISHED_SCAN_MS || 5_000));
const settlementScanMs = Math.max(5_000, Number(process.env.ARENA_BATTLE_SETTLEMENT_SCAN_MS || 5_000));
const voteScanMs = Math.max(1_000, Number(process.env.ARENA_VOTE_TOURNAMENT_SCAN_MS || 2_000));
const finishedPublished = new Map();
let finishedScanRunning = false;
let settlementScanRunning = false;
let voteScanRunning = false;

async function publishVoteTournamentWinner(result) {
  if (!result?.battle || !result?.winnerToken) return;
  await advanceTournamentFromBattle(result.battle).catch((error) => console.warn("[arena-battle-realtime-worker] Vote Tournament bracket advance failed", result.battle.id, error?.message || error));
  const published = await publishBattleFinished(result.battle, null).catch((error) => {
    console.warn("[arena-battle-realtime-worker] Vote Tournament finished publish failed", result.battle.id, error?.message || error);
    return { published: false };
  });
  if (published?.published) finishedPublished.set(`${result.battle.id}:${String(result.battle?.settled_at || result.battle?.finished_at || "")}`, Date.now());
}

async function processVoteTournamentRuntime() {
  if (!voteRuntimeEnabled || voteScanRunning) return;
  voteScanRunning = true;
  try {
    const dueRegulation = await pool.query(
      `select b.id from public.arena_battles b
       left join public.arena_vote_tiebreaks t on t.battle_id=b.id
       where b.state='live' and b.source='tournament' and b.battle_mode='vote'
         and b.ends_at is not null and b.ends_at<=now() and t.battle_id is null
       order by b.ends_at asc limit 50`,
    );
    for (const row of dueRegulation.rows || []) {
      try {
        const result = await finalizeDueVoteTournamentBattle(pool, row.id);
        if (result?.settled && result?.winnerToken) await publishVoteTournamentWinner(result);
      } catch (error) { console.warn("[arena-battle-realtime-worker] Vote Tournament regulation finalization failed", row.id, error?.message || error); }
    }
    const dueShots = await pool.query(
      `select battle_id from public.arena_vote_tiebreaks
       where state in ('salvo','sudden_death') and shot_ends_at is not null and shot_ends_at<=now()
       order by shot_ends_at asc limit 50`,
    );
    for (const row of dueShots.rows || []) {
      try {
        const result = await advanceDueFinalSalvo(pool, row.battle_id);
        if (result?.resolved && result?.winnerToken) await publishVoteTournamentWinner(result);
      } catch (error) { console.warn("[arena-battle-realtime-worker] Final Salvo advancement failed", row.battle_id, error?.message || error); }
    }
  } catch (error) { console.warn("[arena-battle-realtime-worker] Vote Tournament scan failed", error?.message || error); }
  finally { voteScanRunning = false; }
}

async function settleDueBattlePoints() {
  if ((!settlementV2Enabled && !settlementV3Enabled) || settlementScanRunning) return;
  settlementScanRunning = true;
  try {
    if (settlementV3Enabled) {
      const dueV3 = await pool.query(
        `select b.id from public.arena_battles b
         join public.arena_battle_scoring_locks l on l.battle_id=b.id
         where b.state='live' and coalesce(b.battle_mode,'normal')='normal' and b.source<>'tournament'
           and b.ends_at is not null and b.ends_at<=now()
           and l.scoring_version='battle_points_v3' and l.boost_curve_version='boost_hyperbolic_100_v1'
         order by b.ends_at asc limit 50`,
      );
      for (const row of dueV3.rows || []) {
        try {
          const settled = await settleBattlePointsV3ById(row.id);
          if (!settled?.settled) {
            if (settled?.dataDelay) console.warn("[arena-battle-realtime-worker] V3 settlement DATA DELAY", row.id, settled.reason, settled.side || "");
            continue;
          }
          const published = await publishBattleFinished(settled.battle, null).catch(() => ({ published: false }));
          if (published?.published) finishedPublished.set(`${row.id}:${String(settled.battle?.settled_at || settled.battle?.finished_at || "")}`, Date.now());
        } catch (error) { console.warn("[arena-battle-realtime-worker] V3 settlement failed", row.id, error?.message || error); }
      }
    }
    if (settlementV2Enabled) {
      const dueV2 = await pool.query(
        `select b.id from public.arena_battles b
         where b.state='live' and coalesce(b.battle_mode,'normal')<>'vote'
           and b.ends_at is not null and b.ends_at<=now()
           and not exists (select 1 from public.arena_battle_scoring_locks l where l.battle_id=b.id and l.scoring_version='battle_points_v3')
         order by b.ends_at asc limit 50`,
      );
      for (const row of dueV2.rows || []) {
        try {
          const settled = await settleBattlePointsV2ById(row.id);
          if (!settled?.settled) {
            if (settled?.dataDelay) console.warn("[arena-battle-realtime-worker] V2 settlement DATA DELAY", row.id, settled.reason, settled.side || "");
            continue;
          }
          const published = await publishBattleFinished(settled.battle, null).catch(() => ({ published: false }));
          if (published?.published) finishedPublished.set(`${row.id}:${String(settled.battle?.settled_at || settled.battle?.finished_at || "")}`, Date.now());
        } catch (error) { console.warn("[arena-battle-realtime-worker] V2 settlement failed", row.id, error?.message || error); }
      }
    }
  } catch (error) { console.warn("[arena-battle-realtime-worker] settlement scan failed", error?.message || error); }
  finally { settlementScanRunning = false; }
}

async function publishRecentlyFinishedBattles() {
  if (finishedScanRunning) return;
  finishedScanRunning = true;
  try {
    const result = await pool.query(
      `select id,chain_id,state,money_winner_token,winner_token,settlement_version,settlement_scoring_version,
              challenger_battle_points,defender_battle_points,money_tie_break,settlement_tie_break_used,
              settled_at,finished_at,updated_at
       from public.arena_battles
       where state='finished' and coalesce(settled_at,finished_at,updated_at)>=now()-interval '10 minutes'
       order by coalesce(settled_at,finished_at,updated_at) asc limit 100`,
    );
    for (const row of result.rows || []) {
      const settledAt = String(row.settled_at || row.finished_at || row.updated_at || "");
      const key = `${row.id}:${settledAt}`;
      if (finishedPublished.has(key)) continue;
      const published = await publishBattleFinished(row, null).catch(() => ({ published: false }));
      if (published?.published) finishedPublished.set(key, Date.now());
    }
    const cutoff = Date.now() - 15 * 60_000;
    for (const [key, publishedAt] of finishedPublished) if (publishedAt < cutoff) finishedPublished.delete(key);
  } catch (error) { console.warn("[arena-battle-realtime-worker] finished scan failed", error?.message || error); }
  finally { finishedScanRunning = false; }
}

const finishedTimer = setInterval(() => void publishRecentlyFinishedBattles(), finishedScanMs); finishedTimer.unref?.(); void publishRecentlyFinishedBattles();
const settlementTimer = setInterval(() => void settleDueBattlePoints(), settlementScanMs); settlementTimer.unref?.(); void settleDueBattlePoints();
const voteTimer = setInterval(() => void processVoteTournamentRuntime(), voteScanMs); voteTimer.unref?.(); void processVoteTournamentRuntime();
const keepAlive = setInterval(() => {}, 60_000);

async function shutdown(signal) {
  console.log(`[arena-battle-realtime-worker] shutting down on ${signal}`);
  clearInterval(keepAlive); clearInterval(finishedTimer); clearInterval(settlementTimer); clearInterval(voteTimer);
  stopArenaBattleRealtimeWorker();
  try { await pool.end(); } catch {}
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(signal));

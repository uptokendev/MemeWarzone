#!/usr/bin/env node

import { pool } from "../server/db.js";
import { publishBattleFinished, startArenaBattleRealtimeWorker, stopArenaBattleRealtimeWorker } from "../api/lib/arenaBattleRealtime.js";
import { settleDueNormalBattles } from "../api/lib/arenaBattleSettlementRuntime.js";
import { advanceDueFinalSalvo, finalizeDueVoteTournamentBattle, voteTournamentRuntimeEnabled } from "../api/lib/arenaVoteTournamentFinalizationService.js";
import { advanceTournamentFromBattle } from "../api/arenaTournaments.js";
import { IMPORT_FEED_INTERVAL_MS, refreshImportMarketStats } from "../api/lib/arenaImportMarketFeed.js";
import { closeEndedChampionships, rolloverEndedMwlSeasons } from "../api/lib/arenaMwlRollover.js";
import { crankLeagueShares, leagueCrankMode, sweepMwlEpochs } from "../api/lib/arenaEvmLeagueCrank.js";
import { harvestLpFees, lpHarvestMode } from "../api/lib/evmLpHarvestCrank.js";
import { runMwlPayouts } from "../api/lib/arenaMwlPayouts.js";

// Vote Battles (challenge, queue and tournament) settle only through this runtime, so it defaults
// on: with ARENA_VOTE_TOURNAMENT_RUNTIME unset no Vote Battle ever finished. Set it to false to stop it.
const voteRuntimeEnabled = voteTournamentRuntimeEnabled({ ARENA_VOTE_TOURNAMENT_RUNTIME: process.env.ARENA_VOTE_TOURNAMENT_RUNTIME ?? "true" });
const started = startArenaBattleRealtimeWorker();
if (!started.started && !voteRuntimeEnabled) {
  console.log(`[arena-battle-realtime-worker] realtime polling disabled: ${started.reason || "unknown"}; authoritative Normal Battle settlement worker remains active`);
}
if (started.started) console.log(`[arena-battle-realtime-worker] realtime active intervalMs=${started.intervalMs}`);
console.log("[arena-battle-realtime-worker] immutable Normal Battle settlement dispatcher active");
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
  // A standalone Vote Battle (queue / challenge) has no bracket to advance.
  if (String(result.battle.source || "") === "tournament") {
    await advanceTournamentFromBattle(result.battle).catch((error) => console.warn("[arena-battle-realtime-worker] Vote Tournament bracket advance failed", result.battle.id, error?.message || error));
  }
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
       where b.state='live' and b.battle_mode='vote'
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
  if (settlementScanRunning) return;
  settlementScanRunning = true;
  try {
    const outcomes = await settleDueNormalBattles({ pool });
    for (const outcome of outcomes) {
      if (!outcome?.settled) {
        if (outcome?.reason && outcome.reason !== "not_due_already_settled_or_not_normal" && outcome.reason !== "not_due_already_settled_or_not_v2_locked") {
          console.warn("[arena-battle-realtime-worker] authoritative settlement pending", outcome.battleId, outcome.scoringGeneration || "unknown", outcome.reason, outcome.side || "");
        }
        continue;
      }
      const battle = outcome.battle;
      if (!battle?.id) continue;
      const published = await publishBattleFinished(battle, null).catch(() => ({ published: false }));
      if (published?.published) finishedPublished.set(`${battle.id}:${String(battle?.settled_at || battle?.finished_at || "")}`, Date.now());
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
// Market data for imported tokens (metrics Battles need it). On unless explicitly disabled; a failed
// pass only logs -- it cannot touch settlement, which runs on its own timer.
const importFeedEnabled = !/^(0|false|no|off)$/i.test(String(process.env.ARENA_IMPORT_MARKET_FEED_ENABLED ?? "").trim());
let importFeedRunning = false;
async function refreshImportMarkets() {
  if (!importFeedEnabled || importFeedRunning) return;
  importFeedRunning = true;
  try {
    const summary = await refreshImportMarketStats({ pool });
    if (summary.errors.length) console.warn("[arena-battle-realtime-worker] import market feed partial", summary.errors.join("; "));
  } catch (error) { console.warn("[arena-battle-realtime-worker] import market feed failed", error?.message || error); }
  finally { importFeedRunning = false; }
}
if (importFeedEnabled) console.log(`[arena-battle-realtime-worker] import market feed active intervalMs=${IMPORT_FEED_INTERVAL_MS}`);
const importFeedTimer = setInterval(() => void refreshImportMarkets(), IMPORT_FEED_INTERVAL_MS); importFeedTimer.unref?.(); void refreshImportMarkets();
// Major War League month rollover. Nothing else closes a month: until this runs, battle settlement
// refuses to score into the ended month (MWL_ROLLOVER_PENDING) and retries. On unless disabled.
const mwlRolloverEnabled = !/^(0|false|no|off)$/i.test(String(process.env.ARENA_MWL_ROLLOVER_ENABLED ?? "").trim());
const mwlRolloverMs = Math.max(15_000, Number(process.env.ARENA_MWL_ROLLOVER_SCAN_MS || 60_000));
let mwlRolloverRunning = false;
const championshipCloseLogged = new Map();
async function rolloverMwl() {
  if (!mwlRolloverEnabled || mwlRolloverRunning) return;
  mwlRolloverRunning = true;
  try {
    for (const outcome of await rolloverEndedMwlSeasons({ pool })) {
      if (outcome.finalized) {
        console.log(`[arena-battle-realtime-worker] MWL rollover finalized ${outcome.seasonId} winner=${outcome.winner || "none"} opened=${outcome.openedSeasonId || "none"} treasuryRecorded=${outcome.treasuryRecorded}`);
      } else {
        console.warn(`[arena-battle-realtime-worker] MWL rollover pending ${outcome.seasonId}: ${outcome.reason}`);
      }
    }
    // Quarters close after their months. A blocked quarter is logged when its reason changes, not every minute.
    for (const outcome of await closeEndedChampionships({ pool })) {
      const said = championshipCloseLogged.get(outcome.epochId);
      const now = outcome.closed ? "closed" : outcome.reason;
      if (said === now) continue;
      championshipCloseLogged.set(outcome.epochId, now);
      if (outcome.closed) console.log(`[arena-battle-realtime-worker] Quarterly Championship closed ${outcome.epochId}`);
      else console.warn(`[arena-battle-realtime-worker] Quarterly Championship ${outcome.epochId} not closed: ${outcome.reason}`);
    }
  } catch (error) { console.warn("[arena-battle-realtime-worker] MWL rollover scan failed", error?.message || error); }
  finally { mwlRolloverRunning = false; }
}
if (mwlRolloverEnabled) console.log(`[arena-battle-realtime-worker] MWL month rollover active intervalMs=${mwlRolloverMs}`);
const mwlRolloverTimer = setInterval(() => void rolloverMwl(), mwlRolloverMs); mwlRolloverTimer.unref?.(); void rolloverMwl();
// BNB / Robinhood war pools: resolve finished pools, then claimProtocol + claimLeague (arenaEvmLeagueCrank.js).
// Off unless ARENA_EVM_LEAGUE_CRANK=dry|send. One instance only.
const leagueCrank = leagueCrankMode();
const leagueCrankMs = Math.max(60_000, Number(process.env.ARENA_EVM_LEAGUE_CRANK_SCAN_MS || 300_000));
const leagueCrankTerminal = new Set();
let leagueCrankRunning = false;
async function crankLeague() {
  if (leagueCrank === "off" || leagueCrankRunning) return;
  leagueCrankRunning = true;
  try {
    const outcomes = [
      ...(await crankLeagueShares({ db: pool, mode: leagueCrank, terminal: leagueCrankTerminal })),
      // Then move ended MWL months / quarters from PostGradLeagueTreasuryV2 into the MWL vaults.
      ...(await sweepMwlEpochs({ db: pool, mode: leagueCrank })),
    ];
    for (const o of outcomes) {
      const line = `[arena-battle-realtime-worker] war pool crank ${o.step || ""} ${o.status} chain=${o.chainId} ${o.kind || ""} ${o.subject} pool=${o.poolId}${o.amountWei ? ` wei=${o.amountWei}` : ""}${o.month ? ` month=${o.month} quarter=${o.quarter}` : ""}${o.key ? ` epoch=${o.key}` : ""}${o.winner ? ` winner=${o.winner}` : ""}${o.txHash ? ` tx=${o.txHash}` : ""}${o.reason ? ` ${o.reason}` : ""}`;
      if (o.status === "sent" || o.status === "dry-run") console.log(line); else console.warn(line);
    }
  } catch (error) { console.warn("[arena-battle-realtime-worker] league crank pass failed", error?.message || error); }
  finally { leagueCrankRunning = false; }
}
if (leagueCrank !== "off") console.log(`[arena-battle-realtime-worker] EVM league crank active mode=${leagueCrank} intervalMs=${leagueCrankMs}`);
const leagueCrankTimer = setInterval(() => void crankLeague(), leagueCrankMs); leagueCrankTimer.unref?.(); void crankLeague();
// BNB / Robinhood LP fees of graduated coins: locker.harvest(pool), 80% creator / 20% protocol
// (evmLpHarvestCrank.js). Off unless EVM_LP_HARVEST=dry|send. One instance only.
const lpHarvest = lpHarvestMode();
const lpHarvestMs = Math.max(5 * 60_000, Number(process.env.EVM_LP_HARVEST_SCAN_MS || 3_600_000));
const lpHarvestSkip = new Map();
let lpHarvestRunning = false;
async function runLpHarvest() {
  if (lpHarvest === "off" || lpHarvestRunning) return;
  lpHarvestRunning = true;
  try {
    for (const o of await harvestLpFees({ db: pool, mode: lpHarvest, skip: lpHarvestSkip })) {
      const line = `[arena-battle-realtime-worker] lp harvest ${o.step} ${o.status} chain=${o.chainId} ${o.symbol || ""} pool=${o.pool}${o.amount0 ? ` amount0=${o.amount0} amount1=${o.amount1}` : ""}${o.token ? ` token=${o.token} amount=${o.amount}` : ""}${o.txHash ? ` tx=${o.txHash}` : ""}${o.reason ? ` ${o.reason}` : ""}`;
      if (o.status === "sent" || o.status === "dry-run") console.log(line); else console.warn(line);
    }
  } catch (error) { console.warn("[arena-battle-realtime-worker] lp harvest pass failed", error?.message || error); }
  finally { lpHarvestRunning = false; }
}
if (lpHarvest !== "off") console.log(`[arena-battle-realtime-worker] EVM LP harvest active mode=${lpHarvest} intervalMs=${lpHarvestMs}`);
const lpHarvestTimer = setInterval(() => void runLpHarvest(), lpHarvestMs); lpHarvestTimer.unref?.(); void runLpHarvest();
// Major War League payouts: every finished MWL month and closed Quarterly Championship is split
// poker-style into league_epoch_winners (arenaMwlPayouts.js). Off unless ARENA_MWL_PAYOUTS=on:
// it must not run before migration 20261002_000002 and the share-ledger backfill are applied.
const mwlPayoutsOn = /^(1|true|on|yes)$/i.test(String(process.env.ARENA_MWL_PAYOUTS || "").trim());
const mwlPayoutsMs = Math.max(60_000, Number(process.env.ARENA_MWL_PAYOUTS_SCAN_MS || 600_000));
let mwlPayoutsRunning = false;
async function payMwl() {
  if (!mwlPayoutsOn || mwlPayoutsRunning) return;
  mwlPayoutsRunning = true;
  try {
    for (const o of await runMwlPayouts({ pool })) {
      const line = `[arena-battle-realtime-worker] MWL payout ${o.period} ${o.key} chain=${o.chainId} ${o.status} pot=${o.pot ?? ""} paid=${o.paid ?? ""} winners=${o.winners ?? ""}${o.reason ? ` ${o.reason}` : ""}`;
      if (o.status === "failed") console.warn(line); else console.log(line);
    }
  } catch (error) { console.warn("[arena-battle-realtime-worker] MWL payout pass failed", error?.message || error); }
  finally { mwlPayoutsRunning = false; }
}
if (mwlPayoutsOn) console.log(`[arena-battle-realtime-worker] MWL payouts active intervalMs=${mwlPayoutsMs}`);
const mwlPayoutsTimer = setInterval(() => void payMwl(), mwlPayoutsMs); mwlPayoutsTimer.unref?.(); void payMwl();
const keepAlive = setInterval(() => {}, 60_000);

async function shutdown(signal) {
  console.log(`[arena-battle-realtime-worker] shutting down on ${signal}`);
  clearInterval(keepAlive); clearInterval(finishedTimer); clearInterval(settlementTimer); clearInterval(voteTimer); clearInterval(importFeedTimer); clearInterval(mwlRolloverTimer); clearInterval(leagueCrankTimer); clearInterval(lpHarvestTimer); clearInterval(mwlPayoutsTimer);
  stopArenaBattleRealtimeWorker();
  try { await pool.end(); } catch {}
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(signal));

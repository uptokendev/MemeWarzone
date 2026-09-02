#!/usr/bin/env node

import { pool } from "../server/db.js";
import {
  publishBattleFinished,
  startArenaBattleRealtimeWorker,
  stopArenaBattleRealtimeWorker,
} from "../api/lib/arenaBattleRealtime.js";

const started = startArenaBattleRealtimeWorker();
if (!started.started) {
  console.log(`[arena-battle-realtime-worker] not started: ${started.reason || "unknown"}`);
  process.exit(0);
}

console.log(`[arena-battle-realtime-worker] active intervalMs=${started.intervalMs}`);

const finishedScanMs = Math.max(5_000, Number(process.env.ARENA_BATTLE_FINISHED_SCAN_MS || 5_000));
const finishedPublished = new Map();
let finishedScanRunning = false;

async function publishRecentlyFinishedBattles() {
  if (finishedScanRunning) return;
  finishedScanRunning = true;
  try {
    // Settlement owns the state transition. This worker only observes rows that
    // are already committed as finished, then emits a reconnect-safe hint.
    const result = await pool.query(
      `select id, chain_id, state, money_winner_token, winner_token, settlement_version,
              settled_at, finished_at, updated_at
         from public.arena_battles
        where state = 'finished'
          and coalesce(settled_at, finished_at, updated_at) >= now() - interval '10 minutes'
        order by coalesce(settled_at, finished_at, updated_at) asc
        limit 100`,
    );
    for (const row of result.rows || []) {
      const settledAt = String(row.settled_at || row.finished_at || row.updated_at || "");
      const key = `${row.id}:${settledAt}`;
      if (finishedPublished.has(key)) continue;
      const published = await publishBattleFinished(row, null).catch((error) => {
        console.warn("[arena-battle-realtime-worker] finished publish failed", row.id, error?.message || error);
        return { published: false };
      });
      if (published?.published) finishedPublished.set(key, Date.now());
    }
    const cutoff = Date.now() - 15 * 60_000;
    for (const [key, publishedAt] of finishedPublished) {
      if (publishedAt < cutoff) finishedPublished.delete(key);
    }
  } catch (error) {
    console.warn("[arena-battle-realtime-worker] finished scan failed", error?.message || error);
  } finally {
    finishedScanRunning = false;
  }
}

const finishedTimer = setInterval(() => void publishRecentlyFinishedBattles(), finishedScanMs);
finishedTimer.unref?.();
void publishRecentlyFinishedBattles();

// The coordinator timers are unref'd when embedded in another process. This
// standalone Railway worker keeps one lightweight ref alive explicitly.
const keepAlive = setInterval(() => {}, 60_000);

async function shutdown(signal) {
  console.log(`[arena-battle-realtime-worker] shutting down on ${signal}`);
  clearInterval(keepAlive);
  clearInterval(finishedTimer);
  stopArenaBattleRealtimeWorker();
  try {
    await pool.end();
  } catch {
    // Best-effort shutdown only.
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal));
}

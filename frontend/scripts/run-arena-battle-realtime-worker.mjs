#!/usr/bin/env node

import { pool } from "../server/db.js";
import {
  startArenaBattleRealtimeWorker,
  stopArenaBattleRealtimeWorker,
} from "../api/lib/arenaBattleRealtime.js";

const started = startArenaBattleRealtimeWorker();
if (!started.started) {
  console.log(`[arena-battle-realtime-worker] not started: ${started.reason || "unknown"}`);
  process.exit(0);
}

console.log(`[arena-battle-realtime-worker] active intervalMs=${started.intervalMs}`);

// The coordinator timer is unref'd when it is embedded in another process.
// This standalone Railway worker keeps one lightweight ref alive explicitly.
const keepAlive = setInterval(() => {}, 60_000);

async function shutdown(signal) {
  console.log(`[arena-battle-realtime-worker] shutting down on ${signal}`);
  clearInterval(keepAlive);
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

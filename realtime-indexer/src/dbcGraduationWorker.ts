/**
 * DBC graduation keeper loop. Dry-run unless DBC_GRADUATION_SEND is on.
 * Websocket: onAccountChange per not-yet-done pool of ours (not the whole DBC program).
 * LP claims run on their own hourly schedule.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import {
  listWatchPools,
  runDbcGraduationOnce,
  runDbcLpClaimsOnce,
} from "./dbc/dbcGraduationKeeper.js";
import { loadInlineOrFileKeypair } from "./dbcFeeRoutingWorker.js";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function enabled(): boolean {
  return truthy(process.env.DBC_GRADUATION_ENABLED);
}

function sendEnabled(): boolean {
  return truthy(process.env.DBC_GRADUATION_SEND);
}

function rpcUrl(): string {
  return String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || "").trim();
}

function intervalMs(): number {
  return Math.max(3_000, Number(process.env.DBC_GRADUATION_INTERVAL_MS || 8_000));
}

function lpIntervalMs(): number {
  return Math.max(60_000, Number(process.env.DBC_LP_CLAIM_INTERVAL_MS || 3_600_000));
}

function loadCollector(): Keypair | null {
  const raw = String(process.env.DBC_FEE_COLLECTOR_SECRET || process.env.DBC_FEE_COLLECTOR_KEYPAIR || "").trim();
  if (!raw) return null;
  return loadInlineOrFileKeypair(raw);
}

let started = false;
let running = false;
let lpRunning = false;

export function startDbcGraduationWorker() {
  if (started) return;
  started = true;
  if (!enabled()) {
    console.log("[dbc-grad] disabled (set DBC_GRADUATION_ENABLED=true)");
    return;
  }
  const collector = (() => {
    try {
      return loadCollector();
    } catch (error) {
      console.warn("[dbc-grad] collector key unreadable", error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  const url = rpcUrl();
  if (!collector || !url) {
    console.warn("[dbc-grad] worker disabled (set DBC_FEE_COLLECTOR_SECRET and SOLANA_RPC_HTTP)");
    return;
  }
  const connection = new Connection(url, "confirmed");
  const ms = intervalMs();
  const lpMs = lpIntervalMs();
  const watches = new Map<string, number>();
  console.log("[dbc-grad] enabled", {
    send: sendEnabled(),
    intervalMs: ms,
    lpIntervalMs: lpMs,
    collector: collector.publicKey.toBase58(),
  });

  const syncWatches = async () => {
    let want: string[] = [];
    try {
      want = await listWatchPools(pool);
    } catch (error) {
      console.warn("[dbc-grad] watch list failed", error instanceof Error ? error.message : String(error));
      return;
    }
    const wantSet = new Set(want);
    for (const [addr, id] of watches) {
      if (wantSet.has(addr)) continue;
      try {
        await connection.removeAccountChangeListener(id);
      } catch (error) {
        console.warn("[dbc-grad] unsubscribe failed", addr, error instanceof Error ? error.message : String(error));
      }
      watches.delete(addr);
    }
    for (const addr of wantSet) {
      if (watches.has(addr)) continue;
      try {
        const id = connection.onAccountChange(
          new PublicKey(addr),
          () => {
            void tick("websocket");
          },
          "confirmed",
        );
        watches.set(addr, id);
      } catch (error) {
        console.warn("[dbc-grad] subscribe failed", addr, error instanceof Error ? error.message : String(error));
      }
    }
  };

  const tick = async (reason: string) => {
    if (running) return;
    running = true;
    try {
      const result = await runDbcGraduationOnce({
        db: pool,
        connection,
        collector,
        send: sendEnabled(),
      });
      console.log("[dbc-grad] pass", {
        reason,
        pending: result.pending,
        advanced: result.advanced.map((row) => ({
          pool: row.pool,
          step: row.step,
          skipped: row.skipped,
          signature: row.signature,
        })),
      });
      await syncWatches();
    } catch (error) {
      console.error("[dbc-grad] loop failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  const lpTick = async (reason: string) => {
    if (lpRunning) return;
    lpRunning = true;
    try {
      const result = await runDbcLpClaimsOnce({
        db: pool,
        connection,
        collector,
        send: sendEnabled(),
      });
      console.log("[dbc-grad] lp pass", {
        reason,
        pending: result.pending,
        advanced: result.advanced.map((row) => ({
          pool: row.pool,
          skipped: row.skipped,
          signature: row.signature,
          owed: row.owed,
        })),
      });
    } catch (error) {
      console.error("[dbc-grad] lp loop failed", error instanceof Error ? error.message : String(error));
    } finally {
      lpRunning = false;
    }
  };

  const initial = setTimeout(() => {
    void syncWatches().then(() => tick("start"));
  }, 8_000);
  initial.unref?.();
  const timer = setInterval(() => void tick("scan"), ms);
  timer.unref?.();
  const lpTimer = setInterval(() => void lpTick("hourly"), lpMs);
  lpTimer.unref?.();
}

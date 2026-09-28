/**
 * DBC graduation keeper loop. Dry-run unless DBC_GRADUATION_SEND is on.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { bs58Encode } from "./dbc/dbcFeePending.js";
import {
  DBC_PROGRAM_ID,
  runDbcGraduationOnce,
  VIRTUAL_POOL_DISCRIMINATOR,
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

function loadCollector(): Keypair | null {
  const raw = String(process.env.DBC_FEE_COLLECTOR_SECRET || process.env.DBC_FEE_COLLECTOR_KEYPAIR || "").trim();
  if (!raw) return null;
  return loadInlineOrFileKeypair(raw);
}

let started = false;
let running = false;

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
  console.log("[dbc-grad] enabled", {
    send: sendEnabled(),
    intervalMs: ms,
    collector: collector.publicKey.toBase58(),
  });

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
    } catch (error) {
      console.error("[dbc-grad] loop failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  try {
    connection.onProgramAccountChange(
      new PublicKey(DBC_PROGRAM_ID),
      () => {
        void tick("websocket");
      },
      {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: bs58Encode(VIRTUAL_POOL_DISCRIMINATOR) } }],
      } as any,
    );
    console.log("[dbc-grad] websocket subscribed to VirtualPool writes");
  } catch (error) {
    console.warn("[dbc-grad] websocket subscribe failed; scan-only", error instanceof Error ? error.message : String(error));
  }

  const initial = setTimeout(() => void tick("start"), 8_000);
  initial.unref?.();
  const timer = setInterval(() => void tick("scan"), ms);
  timer.unref?.();
}

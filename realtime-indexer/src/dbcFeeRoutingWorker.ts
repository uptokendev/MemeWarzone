/**
 * Accrue, claim, route DBC collector fees. Dry-run unless DBC_FEE_ROUTING_SEND is on.
 */
import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { accrueDbcFees } from "./dbc/dbcFeeAccruals.js";
import { claimDuePools, resolvePendingClaims } from "./dbc/dbcFeeClaimer.js";
import { CollectorShortError, resolvePendingRoutes, routeClaimedAccruals } from "./dbc/dbcFeeRouter.js";
import { sweepReferralToProtocol } from "./dbc/dbcReferralSweep.js";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function enabled(): boolean {
  return truthy(process.env.DBC_FEE_ROUTING_ENABLED);
}

function sendEnabled(): boolean {
  return truthy(process.env.DBC_FEE_ROUTING_SEND);
}

function rpcUrl(): string {
  return String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || "").trim();
}

function intervalMs(): number {
  return Math.max(15_000, Number(process.env.DBC_FEE_ROUTING_INTERVAL_MS || 3_600_000));
}

function claimMinLamports(): bigint {
  try {
    const parsed = BigInt(String(process.env.DBC_FEE_CLAIM_MIN_LAMPORTS || "1000000"));
    return parsed > 0n ? parsed : 1n;
  } catch {
    return 1_000_000n;
  }
}

export function loadInlineOrFileKeypair(raw: string): Keypair {
  const value = String(raw || "").trim();
  if (!value) throw new Error("empty keypair");
  const parsed = value.startsWith("[") || value.startsWith("{")
    ? JSON.parse(value)
    : JSON.parse(fs.readFileSync(value, "utf8"));
  const secret = Array.isArray(parsed) ? parsed : parsed.secretKey;
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadCollector(): Keypair | null {
  const raw = String(process.env.DBC_FEE_COLLECTOR_SECRET || process.env.DBC_FEE_COLLECTOR_KEYPAIR || "").trim();
  if (!raw) return null;
  return loadInlineOrFileKeypair(raw);
}

function loadReferralOwner(): Keypair | null {
  const raw = String(process.env.DBC_REFERRAL_OWNER_SECRET || process.env.DBC_REFERRAL_OWNER_KEYPAIR || "").trim();
  if (!raw) return null;
  return loadInlineOrFileKeypair(raw);
}

export async function runDbcFeeRoutingOnce(opts: {
  db?: typeof pool;
  connection?: Connection;
  collector?: Keypair;
  referralOwner?: Keypair | null;
  send?: boolean;
  claimMinLamports?: bigint;
  route?: boolean;
  sweep?: boolean;
} = {}) {
  const db = opts.db || pool;
  const send = opts.send ?? sendEnabled();
  const accrued = await accrueDbcFees(db);
  const url = rpcUrl();
  const collector = opts.collector || loadCollector();
  if (!collector || !url) {
    return { accrued, claimed: [], routed: null, swept: null, reason: "no-collector-or-rpc" };
  }
  const connection = opts.connection || new Connection(url, "confirmed");
  const claimed = await claimDuePools({
    db,
    connection,
    collector,
    send,
    minLamports: opts.claimMinLamports ?? claimMinLamports(),
  });
  if (send) await resolvePendingClaims({ db, connection });
  let routed = null;
  if (opts.route !== false) {
    try {
      routed = await routeClaimedAccruals({ db, connection, collector, send });
      if (send) await resolvePendingRoutes({ db, connection });
    } catch (error) {
      if (error instanceof CollectorShortError) {
        console.error("[dbc-fee] collector short; not routing", { have: error.have.toString(), need: error.need.toString() });
        routed = { totals: null, signature: null, destinations: [], skipped: "collector-short" };
      } else {
        throw error;
      }
    }
  }
  let swept = null;
  const referralOwner = opts.referralOwner === undefined ? loadReferralOwner() : opts.referralOwner;
  const referralAta = String(process.env.DBC_REFERRAL_TOKEN_ACCOUNT || "").trim();
  if (opts.sweep !== false && referralOwner && referralAta) {
    swept = await sweepReferralToProtocol({
      db,
      connection,
      collector,
      referralOwner,
      referralTokenAccount: referralAta,
      send,
    });
  }
  return { accrued, claimed, routed, swept };
}

let started = false;
let running = false;

export function startDbcFeeRoutingWorker() {
  if (started) return;
  started = true;
  if (!enabled()) {
    console.log("[dbc-fee] disabled (set DBC_FEE_ROUTING_ENABLED=true)");
    return;
  }
  const collector = (() => {
    try {
      return loadCollector();
    } catch (error) {
      console.warn("[dbc-fee] collector key unreadable", error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  const url = rpcUrl();
  if (!collector || !url) {
    console.warn("[dbc-fee] worker disabled (set DBC_FEE_COLLECTOR_SECRET and SOLANA_RPC_HTTP)");
    return;
  }
  const ms = intervalMs();
  console.log("[dbc-fee] enabled", { send: sendEnabled(), intervalMs: ms, collector: collector.publicKey.toBase58() });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDbcFeeRoutingOnce({ collector });
      console.log("[dbc-fee] pass", {
        accrued: result.accrued,
        claimed: (result.claimed || []).map((row) => ({
          pool: row.pool,
          claimed: row.claimed.toString(),
          blocked: row.blocked,
          signature: row.signature,
        })),
        routed: result.routed?.signature || result.routed?.skipped || null,
        swept: result.swept?.signature || result.swept?.skipped || null,
      });
    } catch (error) {
      console.error("[dbc-fee] loop failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), 12_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), ms);
  timer.unref?.();
}

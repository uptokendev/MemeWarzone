/**
 * Import swap fee worker (Solana): pays the coin creator's half of the 1% import fee, expires what
 * nobody claimed within 90 days and sweeps our half to the protocol wallet. Logic and safety rules:
 * importCreatorFees.ts. Off unless IMPORT_FEE_WORKER_ENABLED; a dry run (logs what it would send)
 * unless IMPORT_FEE_PAYOUT_SEND. The key (IMPORT_FEE_COLLECTOR_SECRET, inline JSON or a file path)
 * must match SOLANA_IMPORT_FEE_COLLECTOR when that is set here too.
 */
import { Connection, type Keypair } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { loadInlineOrFileKeypair } from "./dbcFeeRoutingWorker.js";
import { importFeeSettings, runImportCreatorFeePass } from "./importCreatorFees.js";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

let started = false;
let running = false;

export function startImportCreatorFeeWorker() {
  if (started) return;
  started = true;
  if (!truthy(process.env.IMPORT_FEE_WORKER_ENABLED)) {
    console.log("[import-fees] disabled (set IMPORT_FEE_WORKER_ENABLED=true)");
    return;
  }
  const raw = String(process.env.IMPORT_FEE_COLLECTOR_SECRET || "").trim();
  const url = String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim();
  if (!raw || !url) {
    console.warn("[import-fees] worker disabled (needs IMPORT_FEE_COLLECTOR_SECRET and SOLANA_RPC_HTTP)");
    return;
  }
  let collector: Keypair;
  try {
    collector = loadInlineOrFileKeypair(raw);
  } catch (error) {
    console.warn("[import-fees] collector key unreadable", error instanceof Error ? error.message : String(error));
    return;
  }
  const expected = String(process.env.SOLANA_IMPORT_FEE_COLLECTOR || "").trim();
  if (expected && expected !== collector.publicKey.toBase58()) {
    console.error("[import-fees] IMPORT_FEE_COLLECTOR_SECRET does not match SOLANA_IMPORT_FEE_COLLECTOR; worker off", { key: collector.publicKey.toBase58(), expected });
    return;
  }
  const connection = new Connection(url, "confirmed");
  const send = truthy(process.env.IMPORT_FEE_PAYOUT_SEND);
  const settings = importFeeSettings();
  const intervalMs = Math.max(30_000, Number(process.env.IMPORT_FEE_WORKER_INTERVAL_MS || 60_000));
  console.log("[import-fees] enabled", {
    send,
    intervalMs,
    collector: collector.publicKey.toBase58(),
    protocolOwner: settings.protocolOwner,
    minPayoutLamports: settings.minPayoutLamports.toString(),
    maxPayoutLamports: settings.maxPayoutLamports.toString(),
    dailyPayoutCapLamports: settings.dailyPayoutCapLamports.toString(),
  });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runImportCreatorFeePass({ db: pool, connection, collector, send, settings });
      if (result.payouts.length || result.partnerPayouts.length || result.consolidated.length || result.sweep || result.expired || result.skipped.length || result.resolved?.landed || result.resolved?.reset) {
        console.log("[import-fees] pass", JSON.stringify(result));
      }
    } catch (error) {
      console.error("[import-fees] pass failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), 20_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

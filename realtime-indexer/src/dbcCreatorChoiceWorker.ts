/**
 * DBC step 5b worker: the creator-fee choice of platform coins.
 * Every minute: publish/reveal week secrets, take a due holder snapshot, run due buybacks, resolve
 * pending sends. From Monday 00:05 UTC: the previous week's split transfers and holder deposit (the
 * airdrop runner at 00:15 adds the holder leaves to its batch). Dry run unless DBC_CREATOR_CHOICE_SEND.
 */
import { Connection, Keypair } from "@solana/web3.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { loadInlineOrFileKeypair } from "./dbcFeeRoutingWorker.js";
import {
  ensureWeekSecrets,
  resolvePendingPayouts,
  runDueBuybacks,
  runWeeklyPayouts,
  takeDueSnapshots,
} from "./dbc/dbcCreatorPayouts.js";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

/** Wallets whose balances never count as holders, besides each coin's creator. */
export function excludedHolderWallets(collector: Keypair | null): Set<string> {
  const out = new Set<string>();
  if (collector) out.add(collector.publicKey.toBase58());
  for (const name of ["DBC_REFERRAL_OWNER_SECRET", "DBC_REFERRAL_OWNER_KEYPAIR"]) {
    const raw = String(process.env[name] || "").trim();
    if (!raw) continue;
    try {
      out.add(loadInlineOrFileKeypair(raw).publicKey.toBase58());
    } catch {
      // unreadable key: the fee worker reports it
    }
  }
  for (const wallet of String(process.env.DBC_HOLDER_EXCLUDED_WALLETS || "").split(",")) {
    if (wallet.trim()) out.add(wallet.trim());
  }
  return out;
}

/** The weekly run may start once the new week is five minutes old. */
export function weeklyRunDue(now: Date): boolean {
  const day = now.getUTCDay();
  const minutesIntoWeek = ((day + 6) % 7) * 1440 + now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutesIntoWeek >= 5;
}

export async function runCreatorChoiceOnce(input: {
  db?: typeof pool;
  connection: Connection;
  collector: Keypair;
  masterSecret: string;
  send: boolean;
  now?: Date;
}) {
  const db = input.db || pool;
  const now = input.now || new Date();
  await ensureWeekSecrets(db, input.masterSecret, now);
  if (input.send) await resolvePendingPayouts(db, input.connection);
  const snapshots = await takeDueSnapshots({
    db, connection: input.connection, masterSecret: input.masterSecret, excluded: excludedHolderWallets(input.collector), now,
  });
  const buybacks = await runDueBuybacks({
    db, connection: input.connection, collector: input.collector, masterSecret: input.masterSecret, send: input.send, now,
  });
  const weekly = weeklyRunDue(now)
    ? await runWeeklyPayouts({ db, connection: input.connection, collector: input.collector, send: input.send, now })
    : null;
  return { snapshots, buybacks, weekly };
}

let started = false;
let running = false;

export function startDbcCreatorChoiceWorker() {
  if (started) return;
  started = true;
  if (!truthy(process.env.DBC_CREATOR_CHOICE_ENABLED)) {
    console.log("[dbc-5b] disabled (set DBC_CREATOR_CHOICE_ENABLED=true)");
    return;
  }
  const masterSecret = String(process.env.DBC_BUYBACK_SEED_SECRET || "").trim();
  const rawCollector = String(process.env.DBC_FEE_COLLECTOR_SECRET || process.env.DBC_FEE_COLLECTOR_KEYPAIR || "").trim();
  const url = String(ENV.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_URL || "").trim();
  if (!masterSecret || !rawCollector || !url) {
    console.warn("[dbc-5b] worker disabled (needs DBC_BUYBACK_SEED_SECRET, DBC_FEE_COLLECTOR_SECRET and SOLANA_RPC_HTTP)");
    return;
  }
  let collector: Keypair;
  try {
    collector = loadInlineOrFileKeypair(rawCollector);
  } catch (error) {
    console.warn("[dbc-5b] collector key unreadable", error instanceof Error ? error.message : String(error));
    return;
  }
  const connection = new Connection(url, "confirmed");
  const send = truthy(process.env.DBC_CREATOR_CHOICE_SEND);
  const intervalMs = Math.max(30_000, Number(process.env.DBC_CREATOR_CHOICE_INTERVAL_MS || 60_000));
  console.log("[dbc-5b] enabled", { send, intervalMs, collector: collector.publicKey.toBase58() });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runCreatorChoiceOnce({ connection, collector, masterSecret, send });
      if (result.snapshots || result.buybacks.length || result.weekly) console.log("[dbc-5b] pass", JSON.stringify(result));
    } catch (error) {
      console.error("[dbc-5b] pass failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), 15_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

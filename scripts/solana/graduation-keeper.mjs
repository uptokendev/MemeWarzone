#!/usr/bin/env node
/**
 * Solana auto-graduation keeper -- the bot every launchpad runs (pump.fun's migrator, Meteora's DBC
 * migration keepers). No Solana program runs by itself: when a bonding curve closes, somebody has to
 * send the graduation transaction. Ours must be sent by GlobalConfig.treasury_operator with a
 * route-signer signature, so the bot is ours and holds that key.
 *
 *   node scripts/solana/graduation-keeper.mjs            # dry run: scans, prints plans, sends nothing
 *   node scripts/solana/graduation-keeper.mjs --send     # graduates every closed curve it finds
 *   ... --watch [--interval-ms 8000]                     # keep going
 *
 * Instant: a websocket subscription on every Campaign account of the launchpad program fires on the
 * very transaction that closes a curve, and graduation starts right away. The scan below is the
 * safety net (socket down, missed event, keeper restart) and runs every --interval-ms.
 *
 * Every pass: all chain-101 campaigns in the DB that are not graduated -> read on chain in batches ->
 * each closed, ungraduated curve bound to SOL goes to scripts/solana/graduate-campaign.mjs (one
 * transaction: begin_graduation -> Meteora pool + locked LP -> confirm_graduation), with the live SOL
 * price and a fresh per-graduation lookup table. A campaign bound to another quote is reported and
 * left alone (the quote operator is separate). Failures back off per campaign; one never blocks the
 * rest. Idempotent: an already-graduated campaign is skipped by the operator itself.
 *
 * Env: DATABASE_URL, SOLANA_RPC_URL, SOLANA_TREASURY_OPERATOR_KEYPAIR and SOLANA_ROUTE_SIGNER_KEYPAIR
 * (paths or inline JSON arrays), PG_SSL_ALLOW_SELF_SIGNED=1. Program id defaults to mainnet.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";

import { resolveSolanaCampaignGraduationQuote } from "../../frontend/api/lib/solanaCampaignGraduationQuote.js";
import { resolveSolUsdPrice } from "../../frontend/api/lib/solUsdPrice.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { decodeCampaign } = require_("../../tests/solana/decode-campaign.cjs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SEND = flag("--send");
const WATCH = flag("--watch");
const INTERVAL_MS = Math.max(3_000, Number(opt("--interval-ms", process.env.GRADUATION_KEEPER_INTERVAL_MS || 8_000)));
const PROGRAM_ID = String(process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt").trim();
const IDL = String(process.env.SOLANA_LAUNCHPAD_IDL || path.join(here, "idl", "memewarzone_solana.json")).trim();
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    console.error(`[graduation-keeper] ${name} is required`);
    process.exit(2);
  }
  return value;
}

const rpcUrl = required("SOLANA_RPC_URL");
const dbUrl = required("DATABASE_URL");
if (SEND) {
  required("SOLANA_TREASURY_OPERATOR_KEYPAIR");
  required("SOLANA_ROUTE_SIGNER_KEYPAIR");
}
const connection = new Connection(rpcUrl, "confirmed");
const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: process.env.PG_SSL_ALLOW_SELF_SIGNED !== "1" },
  max: 3,
});

const failures = new Map(); // campaign -> { count, retryAt }
const inFlight = new Set();

async function candidateCampaigns() {
  const result = await pool.query(
    `select campaign_address
       from public.campaigns
      where chain_id = 101 and campaign_address is not null and graduated_at_chain is null`,
  );
  return result.rows.map((r) => String(r.campaign_address)).filter(Boolean);
}

async function readCurves(addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const keys = chunk.map((a) => {
      try { return new PublicKey(a); } catch { return null; }
    });
    const infos = await connection.getMultipleAccountsInfo(keys.filter(Boolean), "confirmed");
    let j = 0;
    for (let k = 0; k < chunk.length; k += 1) {
      if (!keys[k]) continue;
      const info = infos[j++];
      if (!info || info.owner.toBase58() !== PROGRAM_ID) continue;
      try {
        const campaign = decodeCampaign(info.data);
        out.push({ address: chunk[k], curveClosed: campaign.curveClosed, graduated: campaign.graduated });
      } catch {
        // not a campaign account layout this keeper knows
      }
    }
  }
  return out;
}

async function solPriceMicros() {
  const px = await resolveSolUsdPrice().catch(() => null);
  const price = Number(px?.price ?? px);
  return price > 0 ? String(Math.round(price * 1_000_000)) : null;
}

function runOperator(campaign, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "graduate-campaign.mjs"), campaign], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; process.stdout.write(`[graduate ${campaign.slice(0, 6)}] ${d}`); });
    child.stderr.on("data", (d) => { output += d; process.stderr.write(`[graduate ${campaign.slice(0, 6)}] ${d}`); });
    child.on("close", (code) => resolve({ code, output }));
    child.on("error", (error) => resolve({ code: 1, output: String(error?.message || error) }));
  });
}

/** Graduate one closed curve now. Returns "graduated" | "planned" | "blocked" | "waiting" | "failed" | "busy". */
async function graduateOne(campaign, source) {
  if (inFlight.has(campaign)) return "busy";
  const failure = failures.get(campaign);
  if (failure && failure.retryAt > Date.now()) return "waiting";
  inFlight.add(campaign);
  try {
    const binding = await resolveSolanaCampaignGraduationQuote(pool, { chainId: 101, campaignAddress: campaign }).catch((e) => ({ error: e }));
    if (binding?.error) {
      console.warn(`[graduation-keeper] ${campaign}: quote binding unreadable: ${binding.error?.message || binding.error}`);
      return "blocked";
    }
    if (!binding.native) {
      console.warn(`[graduation-keeper] ${campaign}: bound to ${binding.symbol || binding.quoteMint || "a non-SOL quote"}; needs the quote operator, not graduating here`);
      return "blocked";
    }
    const price = await solPriceMicros();
    if (!price) {
      console.warn(`[graduation-keeper] ${campaign}: no live SOL price; retrying`);
      return "waiting";
    }
    console.log(`[graduation-keeper] ${campaign}: curve closed (${source}) -> graduating${SEND ? "" : " (dry run)"}`);
    const result = await runOperator(campaign, {
      SOLANA_LAUNCHPAD_PROGRAM_ID: PROGRAM_ID,
      SOLANA_LAUNCHPAD_IDL: IDL,
      SOLANA_GRADUATION_ORACLE_PRICE_USD_MICROS: price,
      SOLANA_GRADUATION_ALT_MODE: "per-graduation",
      SOLANA_GRADUATION_QUOTE_PROFILE: "native",
      SOLANA_GRADUATION_SEND: SEND ? "true" : "",
    });
    if (result.code === 0 && /"status":\s*"(graduated|already-graduated)"/.test(result.output)) {
      failures.delete(campaign);
      console.log(`[graduation-keeper] GRADUATED ${campaign}`);
      return "graduated";
    }
    if (result.code === 0 && !SEND) return "planned";
    const count = (failure?.count || 0) + 1;
    const wait = BACKOFF_MS[Math.min(count - 1, BACKOFF_MS.length - 1)];
    failures.set(campaign, { count, retryAt: Date.now() + wait });
    console.error(`[graduation-keeper] ${campaign}: operator failed (attempt ${count}), retry in ${wait / 1000}s`);
    return "failed";
  } finally {
    inFlight.delete(campaign);
  }
}

async function pass() {
  const started = Date.now();
  const addresses = await candidateCampaigns();
  const curves = await readCurves(addresses);
  const due = curves.filter((c) => c.curveClosed && !c.graduated);
  const summary = { scanned: curves.length, due: due.length, graduated: 0, planned: 0, waiting: 0, blocked: 0, failed: 0, busy: 0 };
  for (const curve of due) {
    const outcome = await graduateOne(curve.address, "scan");
    summary[outcome] = (summary[outcome] || 0) + 1;
  }
  console.log(`[graduation-keeper] pass ${JSON.stringify(summary)} in ${Date.now() - started}ms${SEND ? "" : " (dry run)"}`);
  return summary;
}

/** Instant trigger: every Campaign account write of the launchpad program, filtered by discriminator. */
const CAMPAIGN_DISCRIMINATOR = crypto.createHash("sha256").update("account:Campaign").digest().subarray(0, 8);
function subscribe() {
  const id = connection.onProgramAccountChange(
    new PublicKey(PROGRAM_ID),
    (keyed) => {
      try {
        const campaign = decodeCampaign(keyed.accountInfo.data);
        if (campaign.curveClosed && !campaign.graduated) {
          void graduateOne(keyed.accountId.toBase58(), "websocket");
        }
      } catch {
        // not a decodable campaign write
      }
    },
    { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(CAMPAIGN_DISCRIMINATOR) } }] },
  );
  console.log(`[graduation-keeper] websocket subscribed to campaign writes (id ${id})`);
  return id;
}

let stopping = false;
let wake = null;
let subscriptionId = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    wake?.();
  });
}

console.log(`[graduation-keeper] program ${PROGRAM_ID} ${SEND ? "SENDING" : "dry run"} ${WATCH ? `every ${INTERVAL_MS}ms + websocket` : "single pass"}`);
if (WATCH) subscriptionId = subscribe();
do {
  try {
    await pass();
  } catch (error) {
    console.error(`[graduation-keeper] pass failed: ${error?.message || error}`);
  }
  if (!WATCH || stopping) break;
  await new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, INTERVAL_MS);
  });
} while (!stopping);
// The websocket keeps the event loop alive; a stop (Coolify redeploy = SIGTERM) must still exit.
// An in-flight graduation is a child process that finishes on its own; the operator is idempotent.
if (subscriptionId !== null) await connection.removeProgramAccountChangeListener(subscriptionId).catch(() => {});
await pool.end().catch(() => {});
console.log("[graduation-keeper] stopped");
process.exit(0);

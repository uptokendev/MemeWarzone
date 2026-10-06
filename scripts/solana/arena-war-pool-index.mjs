#!/usr/bin/env node
// Arena war pool chain indexer: every stake, support, buy-in and boost deposit and every prize,
// protocol, MWL and refund claim of every arena pool, read from the chain into
// arena_war_pool_deposits / arena_war_pool_claims (frontend/api/lib/arenaWarPoolChainIndex.js).
//
// Read-only on chain; never signs or sends. Writes only those two tables and
// arena_war_pool_index_cursors, and only without --dry-run.
//
//   node scripts/solana/arena-war-pool-index.mjs [--chain 101] [--dry-run] [--all-history]
//        [--limit 500] [--watch] [--interval-ms 60000]
//   node scripts/solana/arena-war-pool-index.mjs --chain 56 --from-block <deploy block> [--treasury 0x..]
//        [--block-span 5000] [--confirmations 12] [--dry-run]
//
// --dry-run       read and decode everything, write nothing; each query runs in BEGIN READ ONLY ... ROLLBACK.
// --all-history   ignore the per-pool cursors and re-read every pool from its first transaction
//                 (the backfill; rows are idempotent, so a re-run changes nothing).
// --watch         keep running, one pass every --interval-ms (default 60 s).
//
// Env: DATABASE_URL, PG_SSL_ALLOW_SELF_SIGNED=1 (pooler), SOLANA_RPC_URL (mainnet for chain 101;
// a devnet URL is refused), EVM: ARENA_WAR_POOL_INDEX_RPC_<chainId> or BSC_RPC_HTTP_<chainId> /
// ROBINHOOD_RPC_HTTP_<chainId>, and ARENA_WAR_POOL_TREASURY_V2_ADDRESS_<chainId> (or --treasury).

import { pathToFileURL } from "node:url";

import {
  indexEvmArena,
  indexSolanaArena,
  isSolanaArenaChain,
  jsonRpc,
  loadIndexSubjects,
} from "../../frontend/api/lib/arenaWarPoolChainIndex.js";

function argValue(argv, flag) {
  return argv.includes(flag) ? String(argv[argv.indexOf(flag) + 1] || "") : "";
}

function csv(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function solanaRpcUrls(chainId, env = process.env) {
  const urls = [];
  for (const name of ["SOLANA_MAINNET_RPC_HTTP", "SOLANA_MAINNET_RPC_URL", "SOLANA_RPC_URL", "SOLANA_RPC_HTTP", "SOLANA_RPC"]) {
    for (const url of csv(env[name])) {
      const devnet = /devnet|testnet/i.test(url);
      if (Number(chainId) === 101 ? !devnet : devnet) urls.push(url);
    }
  }
  if (Number(chainId) === 101) urls.push("https://api.mainnet-beta.solana.com");
  return [...new Set(urls)];
}

export function evmRpcUrls(chainId, env = process.env) {
  const id = Number(chainId);
  return [...new Set([
    ...csv(env[`ARENA_WAR_POOL_INDEX_RPC_${id}`]),
    ...csv(env[`BSC_RPC_HTTP_${id}`]),
    ...csv(env[`ROBINHOOD_RPC_HTTP_${id}`]),
    ...csv(env[`VITE_PUBLIC_RPC_${id}`]),
  ])];
}

async function openDb({ dryRun }) {
  const { default: pg } = await import("pg");
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const allowSelfSigned = String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() === "1";
  const pool = new pg.Pool({
    connectionString: allowSelfSigned ? url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "") : url,
    ssl: local ? false : { rejectUnauthorized: !allowSelfSigned },
    max: 2,
  });
  if (!dryRun) return { db: pool, close: () => pool.end() };
  // Dry run: every query in its own read-only transaction, always rolled back (no session SET).
  const db = {
    async query(text, params) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        return await client.query(text, params);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    },
  };
  return { db, close: () => pool.end() };
}

function printable(summary) {
  return JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export async function runIndexPass({ db, chainId, dryRun, allHistory, limit, fromBlock, treasury, blockSpan, confirmations, env = process.env, logger = console }) {
  const subjects = await loadIndexSubjects(db, chainId, limit);
  if (isSolanaArenaChain(chainId)) {
    const urls = solanaRpcUrls(chainId, env);
    if (!urls.length) throw new Error(`no Solana RPC URL for chain ${chainId}`);
    // The public mainnet endpoint allows a few calls a second; a private RPC needs no pacing.
    const publicOnly = urls.every((u) => /api\.mainnet-beta\.solana\.com/.test(u));
    const minIntervalMs = Number(env.ARENA_WAR_POOL_INDEX_RPC_DELAY_MS) || (publicOnly ? 600 : 0);
    return indexSolanaArena({ db, rpc: jsonRpc({ urls, minIntervalMs }), chainId, subjects, dryRun, ignoreCursor: allHistory, logger });
  }
  const urls = evmRpcUrls(chainId, env);
  if (!urls.length) throw new Error(`no EVM RPC URL for chain ${chainId} (ARENA_WAR_POOL_INDEX_RPC_${chainId})`);
  return indexEvmArena({
    db,
    rpc: jsonRpc({ urls }),
    chainId,
    treasury: treasury || env[`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${Number(chainId)}`] || "",
    subjects,
    fromBlock,
    blockSpan,
    confirmations,
    dryRun,
    ignoreCursor: allHistory,
    logger,
  });
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("See the header of scripts/solana/arena-war-pool-index.mjs for usage.");
    process.exit(0);
  }
  const options = {
    chainId: Number(argValue(argv, "--chain")) || 101,
    dryRun: argv.includes("--dry-run"),
    allHistory: argv.includes("--all-history"),
    limit: Number(argValue(argv, "--limit")) || 500,
    fromBlock: argValue(argv, "--from-block") === "" ? undefined : Number(argValue(argv, "--from-block")),
    treasury: argValue(argv, "--treasury"),
    blockSpan: Number(argValue(argv, "--block-span")) || 5000,
    confirmations: argValue(argv, "--confirmations") === "" ? 12 : Number(argValue(argv, "--confirmations")),
  };
  const watch = argv.includes("--watch");
  const intervalMs = Math.max(10_000, Number(argValue(argv, "--interval-ms")) || 60_000);
  const { db, close } = await openDb(options);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
  let exitCode = 0;
  try {
    do {
      try {
        const summary = await runIndexPass({ db, ...options });
        const { rows, ...rest } = summary;
        console.log(printable({ ...rest, rowCount: rows.length, ...(options.dryRun ? { rows } : {}) }));
      } catch (error) {
        console.error(`[arena-war-pool-index] pass failed: ${String(error?.message || error)}`);
        exitCode = 1;
      }
      if (watch && !stopping) await new Promise((r) => setTimeout(r, intervalMs));
    } while (watch && !stopping);
  } finally {
    await close();
  }
  process.exit(exitCode);
}

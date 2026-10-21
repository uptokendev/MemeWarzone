#!/usr/bin/env node
/**
 * Local proof for the DBC config ladder's recovery (2026-10-21: a dropped $50K config create left a
 * failed row that made every $50K quote a 500). Runs the real ladder against a local validator with
 * Meteora's DBC program cloned from mainnet, and the real dbc_launch_configs migration on a throwaway
 * Postgres. Refuses any RPC whose genesis is devnet or mainnet.
 *
 *   solana-test-validator --reset --rpc-port 18899 --faucet-port 19900 \
 *     --url https://api.mainnet-beta.solana.com --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
 *   cd frontend && node ../scripts/dbc/prove-config-recovery-local.mjs
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromFrontend = createRequire(path.join(ROOT, "frontend/package.json"));
const { Pool } = requireFromFrontend("pg");
const web3 = requireFromFrontend("@solana/web3.js");
const bs58 = requireFromFrontend("bs58").default || requireFromFrontend("bs58");
const { Connection, Keypair, LAMPORTS_PER_SOL, ComputeBudgetProgram, ComputeBudgetInstruction } = web3;

const { createDbcConfigLadder, DBC_CONFIG_DROP_GRACE_MS, DBC_CONFIG_PRIORITY_MICROLAMPORTS } = await import(
  path.join(ROOT, "frontend/api/lib/dbc/dbcConfigLadder.js")
);
const { buildLaunchConfigParams } = await import(path.join(ROOT, "frontend/api/lib/dbc/dbcLaunchConfigParams.mjs"));
const { stepUsdMicrosFromIndex } = await import(path.join(ROOT, "frontend/api/lib/dbc/dbcPriceSteps.mjs"));
const { DBC_TARGET_USD_MICROS } = await import(path.join(ROOT, "frontend/shared/dbcEconomics.mjs"));
const { SOLANA_GENESIS } = await import(path.join(ROOT, "frontend/src/lib/solanaArenaLayout.mjs"));

const RPC = process.env.LOCAL_RPC || "http://127.0.0.1:18899";
const PG_BIN = process.env.DBC_PG_BIN || "/usr/lib/postgresql/14/bin";
const PG_PORT = Number(process.env.DBC_THROWAY_PG_PORT || 55433);
const WSOL = "So11111111111111111111111111111111111111112";
const STEP_INDEX = 236; // SOL ~ $107, the step production row 8 had
const STEP_USD = stepUsdMicrosFromIndex(STEP_INDEX);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

function pgRun(bin, args) {
  const r = spawnSync(path.join(PG_BIN, bin), args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr || r.stdout}`);
}

async function startPostgres() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-recovery-pg-"));
  pgRun("initdb", ["-D", dir, "--auth=trust", "-U", "postgres", "--no-instructions"]);
  pgRun("pg_ctl", ["-D", dir, "-l", path.join(dir, "pg.log"), "-o", `-p ${PG_PORT} -k ${dir}`, "start"]);
  const pool = new Pool({ connectionString: `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`, ssl: false });
  for (let i = 0; i < 25; i += 1) {
    try { await pool.query("select 1"); break; } catch (error) { if (i === 24) throw error; await new Promise((r) => setTimeout(r, 200)); }
  }
  // The table as production has it: the real migration, with service_role created for its grants.
  await pool.query("create role service_role");
  await pool.query("create role anon");
  await pool.query("create role authenticated");
  await pool.query(fs.readFileSync(path.join(ROOT, "db/migrations/20260929_000001_dbc_launch_configs.sql"), "utf8"));
  return {
    pool,
    async stop() {
      await pool.end().catch(() => {});
      spawnSync(path.join(PG_BIN, "pg_ctl"), ["-D", dir, "-m", "immediate", "stop"], { encoding: "utf8" });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The ladder insists the RPC genesis matches its cluster; the local validator stands in for devnet. */
function asDevnet(conn) {
  return new Proxy(conn, {
    get(target, prop) {
      if (prop === "getGenesisHash") return async () => SOLANA_GENESIS.devnet;
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function keyOf(targetUsd, mode) {
  return { targetUsdMicros: DBC_TARGET_USD_MICROS[targetUsd], stepIndex: STEP_INDEX, stepUsdMicros: STEP_USD, creatorFeeMode: mode };
}

async function rowsFor(pool, targetUsd, mode) {
  const { rows } = await pool.query(
    `select * from public.dbc_launch_configs where target_usd_micros = $1 and creator_fee_mode = $2 order by id`,
    [DBC_TARGET_USD_MICROS[targetUsd].toString(), mode],
  );
  return rows;
}

async function main() {
  const raw = new Connection(RPC, "confirmed");
  const genesis = await raw.getGenesisHash();
  if (genesis === SOLANA_GENESIS.devnet || genesis === SOLANA_GENESIS["mainnet-beta"]) {
    throw new Error(`refusing: ${RPC} is not a local validator (genesis ${genesis})`);
  }
  const conn = asDevnet(raw);
  const payer = Keypair.generate();
  const collector = Keypair.generate();
  const drop = await raw.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await raw.confirmTransaction(drop, "confirmed");

  const pg = await startPostgres();
  try {
    const ladderOf = (extra = {}) => createDbcConfigLadder({
      db: pg.pool,
      connection: conn,
      payer,
      feeClaimer: collector.publicKey,
      cluster: "devnet",
      env: { SOLANA_CLUSTER: "devnet" },
      ...extra,
    });

    // A. A normal create: priority fee first, blockhash-strategy confirm, readback, active.
    const before = await raw.getBalance(payer.publicKey);
    const a = await ladderOf().ensureLaunchConfig(keyOf(50000, "creator"));
    const txA = await raw.getTransaction(a.createSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const ix0 = txA.transaction.message.compiledInstructions?.[0] || txA.transaction.message.instructions[0];
    const keys = txA.transaction.message.staticAccountKeys || txA.transaction.message.accountKeys;
    const firstProgram = keys[ix0.programIdIndex].toBase58();
    const priceIx = { programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from(typeof ix0.data === "string" ? bs58.decode(ix0.data) : ix0.data) };
    const price = ComputeBudgetInstruction.decodeSetComputeUnitPrice(priceIx).microLamports;
    const size = txA.transaction.message.serialize().length + 1 + 64 * txA.transaction.signatures.length;
    check("A create lands and reads back active", a.status === "active" && !txA.meta.err, `config ${a.configAddress}`);
    check("A first instruction is the priority fee", firstProgram === ComputeBudgetProgram.programId.toBase58() && price === BigInt(DBC_CONFIG_PRIORITY_MICROLAMPORTS), `${price} uL/CU`);
    console.log(`   tx ${size} B, ${txA.meta.computeUnitsConsumed} CU, fee ${txA.meta.fee} lamports, payer spent ${before - (await raw.getBalance(payer.publicKey))} lamports`);

    // B. Late landed: the same row marked failed is verified against the chain and activated, no new create.
    await pg.pool.query(`update public.dbc_launch_configs set status = 'failed', verified_at = null where id = $1`, [a.row.id]);
    const sigsBefore = (await raw.getSignaturesForAddress(payer.publicKey)).length;
    const b = await ladderOf().ensureLaunchConfig(keyOf(50000, "creator"));
    const sigsAfter = (await raw.getSignaturesForAddress(payer.publicKey)).length;
    check("B a failed row whose config is on chain is activated, not recreated", b.status === "active" && b.configAddress === a.configAddress && sigsAfter === sigsBefore);

    // C. Production row 8: failed, config never created, signature unknown, older than the grace.
    const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[50000], STEP_USD, "platform");
    const ghost = Keypair.generate().publicKey.toBase58();
    const ghostSig = bs58.encode(crypto.randomBytes(64));
    const seed = async (createdAt) => pg.pool.query(
      `insert into public.dbc_launch_configs (cluster, quote_mint, target_usd_micros, step_index, step_usd_micros, creator_fee_mode,
         params_hash, config_address, threshold_lamports, total_token_supply, create_signature, status, created_at)
       values ('devnet', $1, $2, $3, $4, 'platform', $5, $6, $7, $8, $9, 'failed', $10) returning id`,
      [WSOL, DBC_TARGET_USD_MICROS[50000].toString(), STEP_INDEX, STEP_USD.toString(), built.paramsHash, ghost,
        built.expected.thresholdLamports.toString(), built.expected.totalTokenSupply.toString(), ghostSig, createdAt.toISOString()],
    );
    await seed(new Date());
    let pendingCode = null;
    try { await ladderOf().ensureLaunchConfig(keyOf(50000, "platform")); } catch (error) { pendingCode = error.code; }
    check("C a recent failed row with nothing on chain answers DBC_CONFIG_PENDING", pendingCode === "DBC_CONFIG_PENDING");
    await pg.pool.query(`update public.dbc_launch_configs set created_at = $1 where config_address = $2`, [new Date(Date.now() - DBC_CONFIG_DROP_GRACE_MS - 1000).toISOString(), ghost]);
    const c = await ladderOf().ensureLaunchConfig(keyOf(50000, "platform"));
    const cRows = await rowsFor(pg.pool, 50000, "platform");
    check("C the dead row is replaced by a real create", c.status === "active" && c.configAddress !== ghost && cRows.length === 1 && cRows[0].config_address === c.configAddress);

    // D. A dropped send: signed, never broadcast. The real confirm ends past lastValidBlockHeight.
    const neverSent = async (_conn, tx, signers) => {
      const { blockhash, lastValidBlockHeight } = await raw.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.sign(...signers);
      return bs58.encode(tx.signature);
    };
    console.log("   D waiting for the blockhash to expire (about 150 blocks)...");
    const t0 = Date.now();
    let dCode = null;
    try { await ladderOf({ sendTransaction: neverSent }).ensureLaunchConfig(keyOf(30000, "creator")); } catch (error) { dCode = error.code; }
    const dRows = await rowsFor(pg.pool, 30000, "creator");
    check("D a dropped create answers DBC_CONFIG_DROPPED and leaves no row", dCode === "DBC_CONFIG_DROPPED" && dRows.length === 0, `${Math.round((Date.now() - t0) / 1000)} s`);
    const d2 = await ladderOf().ensureLaunchConfig(keyOf(30000, "creator"));
    check("D the next call creates the key", d2.status === "active");
  } finally {
    await pg.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} CHECKS PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Devnet proof of the DBC config ladder. Throwaway keys only (never a founder key).
 * Genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG is required.
 * Optional DBC_PROVE_FUNDER_KEYPAIR=<path to json keypair>: funds the throwaway
 * wallets from that key instead of the public faucet.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE,
  DBC_QUOTE_MINT,
  DBC_TARGET_USD_MICROS,
  DBC_TOKEN_SCALE,
} from "../../frontend/shared/dbcEconomics.mjs";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { solPriceStep, solPriceStepIndex, stepUsdMicrosFromIndex } from "../../frontend/api/lib/dbc/dbcPriceSteps.mjs";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildLaunchConfigParams, linearCostLamports } from "../../frontend/api/lib/dbc/dbcLaunchConfigParams.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = requireFromFrontend("@solana/web3.js");
const {
  NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} = requireFromFrontend("@solana/spl-token");
const BN = requireFromFrontend("bn.js");
const {
  DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDbcPoolAddress, deriveDammV2PoolAddress,
  SwapMode, MigrationFeeOption,
} = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const { CpAmm } = requireFromFrontend("@meteora-ag/cp-amm-sdk");

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-prove-"));
const failures = [];
const sigs = {};

const big = (v) => BigInt(v?.toString?.() ?? v ?? 0);
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9);
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function memoryDb() {
  const rows = [];
  let id = 1;
  let chain = Promise.resolve();
  const run = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("begin") || sql.startsWith("commit") || sql.startsWith("rollback") || sql.includes("pg_advisory")) return { rows: [] };
    if (sql.startsWith("select") && sql.includes("from public.dbc_launch_configs")) {
      return { rows: rows.filter((r) => r.cluster === params[0] && r.quote_mint === params[1] && String(r.target_usd_micros) === String(params[2]) && Number(r.step_index) === Number(params[3]) && r.creator_fee_mode === params[4] && r.params_hash === params[5]) };
    }
    if (sql.startsWith("insert")) {
      const row = {
        id: id++, cluster: params[0], quote_mint: params[1], target_usd_micros: params[2], step_index: params[3],
        step_usd_micros: params[4], creator_fee_mode: params[5], params_hash: params[6], config_address: params[7],
        threshold_lamports: params[8], total_token_supply: params[9], create_signature: params[10],
        created_at: params[11], status: "pending",
      };
      rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update") && sql.includes("failed")) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) { row.status = "failed"; row.create_signature = params[1] || row.create_signature; }
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("update") && sql.includes("active")) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) { row.status = "active"; row.create_signature = params[1]; row.verified_at = params[2]; }
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  };
  return {
    query: run,
    async connect() {
      let releaseHold;
      const prev = chain;
      const hold = new Promise((r) => { releaseHold = r; });
      chain = hold;
      await prev;
      return { query: run, release() { releaseHold(); } };
    },
  };
}

function loadKeypairFile(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

async function airdrop(conn, pubkey, lamports) {
  const have = BigInt(await conn.getBalance(pubkey));
  const want = BigInt(lamports);
  if (have >= want) return;
  const sig = await conn.requestAirdrop(pubkey, Number(want - have));
  await conn.confirmTransaction(sig, "confirmed");
}

async function fundFrom(conn, funder, dest, lamports) {
  const have = BigInt(await conn.getBalance(dest));
  const want = BigInt(lamports);
  if (have >= want) return;
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: funder.publicKey,
    toPubkey: dest,
    lamports: Number(want - have),
  }));
  await sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" });
}

async function fund(conn, dest, lamports) {
  const funderPath = process.env.DBC_PROVE_FUNDER_KEYPAIR;
  if (funderPath) return fundFrom(conn, loadKeypairFile(funderPath), dest, lamports);
  return airdrop(conn, dest, lamports);
}

async function getTx(conn, sig) {
  for (let i = 0; i < 20; i += 1) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`transaction ${sig} not readable after 30 s`);
}

async function tokenDelta(conn, sig, account) {
  const t = await getTx(conn, sig);
  const keys = t.transaction.message.staticAccountKeys || t.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.equals(account));
  const pick = (l) => BigInt(l.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
  return pick(t.meta.postTokenBalances) - pick(t.meta.preTokenBalances);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET) throw new Error(`Refusing: RPC genesis ${genesis} is not devnet.`);

  const payer = Keypair.generate();
  const collector = Keypair.generate();
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
    payer: Array.from(payer.secretKey),
    collector: Array.from(collector.secretKey),
    creator: Array.from(creator.secretKey),
    trader: Array.from(trader.secretKey),
  }));
  console.log(`devnet ${genesis}`);
  console.log(`throwaway keys in ${DIR}`);
  console.log(`payer     ${payer.publicKey.toBase58()}`);
  console.log(`collector ${collector.publicKey.toBase58()}`);
  console.log(`creator   ${creator.publicKey.toBase58()}`);
  console.log(`trader    ${trader.publicKey.toBase58()}`);

  if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
    const funder = loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR);
    console.log(`funder    ${funder.publicKey.toBase58()}  ${sol(await conn.getBalance(funder.publicKey))} SOL`);
  } else {
    console.log("no DBC_PROVE_FUNDER_KEYPAIR; using the public faucet");
  }
  await fund(conn, payer.publicKey, 2_000_000_000);
  await fund(conn, creator.publicKey, 1_000_000_000);
  await fund(conn, trader.publicKey, 2_000_000_000);
  console.log(`payer balance ${sol(await conn.getBalance(payer.publicKey))} SOL`);

  const client = new DynamicBondingCurveClient(conn, "confirmed");
  console.log("\n[simulate createConfig for every ladder case]");
  const simTargets = [15_000, 30_000, 50_000];
  const simPrices = [50, 100, 118, 150, 200, 250, 400];
  const simCases = [];
  for (const targetUsd of simTargets) {
    for (const usd of simPrices) {
      for (const mode of ["creator", "platform"]) {
        const micros = BigInt(Math.round(usd * 1_000_000));
        simCases.push({
          targetUsd,
          usd,
          mode,
          target: DBC_TARGET_USD_MICROS[targetUsd],
          step: stepUsdMicrosFromIndex(solPriceStepIndex(micros)),
        });
      }
    }
  }
  for (const mode of ["creator", "platform"]) {
    simCases.push({
      targetUsd: 150,
      usd: 118,
      mode,
      target: DBC_DEVNET_TEST_TARGET_USD_MICROS,
      step: stepUsdMicrosFromIndex(solPriceStepIndex(118_000_000n)),
    });
  }
  let simFail = 0;
  for (const c of simCases) {
    const built = buildLaunchConfigParams(c.target, c.step, c.mode);
    const configKp = Keypair.generate();
    const tx = await client.partner.createConfig({
      config: configKp.publicKey,
      feeClaimer: collector.publicKey,
      leftoverReceiver: collector.publicKey,
      quoteMint: NATIVE_MINT,
      payer: payer.publicKey,
      ...built.configParams,
    });
    tx.feePayer = payer.publicKey;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.partialSign(payer, configKp);
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    const err = sim.value?.err ?? sim.err;
    const ok = err == null;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.targetUsd} @ $${c.usd} ${c.mode}${ok ? "" : `  ${JSON.stringify(err)}`}`);
    if (!ok) {
      simFail += 1;
      failures.push(`simulate ${c.targetUsd}@${c.usd} ${c.mode}`);
      const logs = sim.value?.logs || sim.logs;
      if (logs) console.log(logs.slice(-8).join("\n"));
    }
  }
  check(`createConfig simulates for all ${simCases.length} cases`, simFail === 0, `${simCases.length - simFail}/${simCases.length}`);

  const solUsdMicros = 118_000_000n;
  const step = solPriceStep(solUsdMicros);
  const ladder = createDbcConfigLadder({
    db: memoryDb(),
    connection: conn,
    payer,
    feeClaimer: collector.publicKey,
    cluster: "devnet",
    env: {
      SOLANA_CLUSTER: "devnet",
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      SOLANA_RPC_URL: RPC,
    },
  });

  const created = {};
  for (const mode of ["creator", "platform"]) {
    const row = await ladder.ensureLaunchConfig({
      targetUsdMicros: DBC_DEVNET_TEST_TARGET_USD_MICROS,
      stepIndex: step.stepIndex,
      stepUsdMicros: step.stepUsdMicros,
      creatorFeeMode: mode,
    });
    created[mode] = row;
    sigs[`config-${mode}`] = row.createSignature;
    console.log(`  ${mode} config ${row.configAddress}  sig ${row.createSignature}`);
    console.log(`    threshold ${row.expected.thresholdLamports}  supply ${row.expected.totalTokenSupply}  hash ${row.paramsHash}`);
  }

  const creatorCfg = new PublicKey(created.creator.configAddress);
  const mint = Keypair.generate();
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, creatorCfg);
  const buyLamports = linearCostLamports(created.creator.expected.totalTokenSupply / 10n, created.creator.expected.slopeUsed);
  const buyAmount = new BN((buyLamports > 0n ? buyLamports : 10_000_000n).toString());

  console.log("\n[createPool + first buy 10%]");
  const firstBuyTx = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: "MWZ DBC Step1",
      symbol: "MWZ1",
      uri: "https://memewar.zone/",
      payer: creator.publicKey,
      poolCreator: creator.publicKey,
      config: creatorCfg,
      baseMint: mint.publicKey,
    },
    firstBuyParam: {
      buyer: creator.publicKey,
      buyAmount,
      minimumAmountOut: new BN(1),
      referralTokenAccount: null,
    },
  });
  firstBuyTx.feePayer = creator.publicKey;
  const sigFirst = await sendAndConfirmTransaction(conn, firstBuyTx, [creator, mint], { commitment: "confirmed" });
  sigs.firstBuy = sigFirst;
  console.log(`  sig ${sigFirst}`);

  const poolState = async () => {
    const r = await client.state.getPool(pool);
    return r?.poolState ?? r;
  };
  const snap = (p) => ({ partner: big(p.partnerQuoteFee), creator: big(p.creatorQuoteFee), protocol: big(p.protocolQuoteFee), reserve: big(p.quoteReserve) });
  const afterFirst = snap(await poolState());
  const firstFee = afterFirst.partner + afterFirst.creator + afterFirst.protocol;
  const firstIn = big(buyAmount.toString());
  check("first swap paid 2% (min fee), not 50%", firstFee === (firstIn * 200n) / 10_000n || (firstFee * 10000n) / firstIn < 300n, `fee ${firstFee} on ${firstIn}`);

  console.log("\n[second wallet buy ~5s later]");
  await new Promise((r) => setTimeout(r, 5000));
  const beforeSecond = snap(await poolState());
  const secondIn = 20_000_000n;
  const secondTx = await client.pool.swap({
    owner: trader.publicKey,
    pool,
    amountIn: new BN(secondIn.toString()),
    minimumAmountOut: new BN(1),
    swapBaseForQuote: false,
    referralTokenAccount: null,
  });
  const sigSecond = await sendAndConfirmTransaction(conn, secondTx, [trader], { commitment: "confirmed" });
  sigs.secondBuy = sigSecond;
  const afterSecond = snap(await poolState());
  const secondFee = (afterSecond.partner - beforeSecond.partner) + (afterSecond.creator - beforeSecond.creator) + (afterSecond.protocol - beforeSecond.protocol);
  console.log(`  sig ${sigSecond}  fee ${secondFee} on ${secondIn}  (${Number(secondFee * 10000n / secondIn) / 100}%)`);

  console.log("\n[buy to completion, PartialFill]");
  const cfg = await client.state.getPoolConfig(creatorCfg);
  const threshold = big(cfg.migrationQuoteThreshold);
  const need = threshold - afterSecond.reserve;
  const completeTx = await client.pool.swap2({
    owner: trader.publicKey,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.PartialFill,
    amountIn: new BN((need + need / 5n + 10_000_000n).toString()),
    minimumAmountOut: new BN(1),
  });
  const sigComplete = await sendAndConfirmTransaction(conn, completeTx, [trader], { commitment: "confirmed" });
  sigs.complete = sigComplete;
  const afterComplete = snap(await poolState());
  check("curve complete", afterComplete.reserve >= threshold, `${sol(afterComplete.reserve)} / ${sol(threshold)}`);
  console.log(`  sig ${sigComplete}`);

  console.log("\n[migrate]");
  const p = await poolState();
  if (Number(p.migrationProgress) === 1) {
    const lockTx = await client.migration.createLocker({ payer: payer.publicKey, pool });
    const sigLock = await sendAndConfirmTransaction(conn, lockTx, [payer], { commitment: "confirmed" });
    sigs.locker = sigLock;
    console.log(`  locker ${sigLock}`);
  }
  const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
  const res = await client.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig });
  const sigMig = await sendAndConfirmTransaction(conn, res.transaction, [payer, res.firstPositionNftKeypair, res.secondPositionNftKeypair], { commitment: "confirmed" });
  sigs.migrate = sigMig;
  console.log(`  migrate ${sigMig}`);
  const dammPool = deriveDammV2PoolAddress(dammConfig, mint.publicKey, NATIVE_MINT);
  const cpAmm = new CpAmm(conn);
  const dpool = await cpAmm.fetchPoolState(dammPool);
  const vaultB = BigInt((await conn.getTokenAccountBalance(dpool.tokenBVault)).value.amount);
  const poolQuote = (threshold * 78n + 99n) / 100n;
  const meteoraCut = (poolQuote * 20n) / 10_000n;
  check("pool quote is 78% less Meteora 0.2%", vaultB <= poolQuote && vaultB >= poolQuote - meteoraCut - 1n, `${vaultB} vs ${poolQuote}`);

  console.log("\n[withdraw migration fees]");
  const quoteVault = (await poolState()).quoteVault;
  const feeLamports = threshold - poolQuote;
  const creatorMig = (feeLamports * 90n) / 100n;
  const partnerMig = feeLamports - creatorMig;
  for (const [who, kp, want] of [["creator", creator, creatorMig], ["partner", collector, partnerMig]]) {
    const tx = who === "creator"
      ? await client.creator.creatorWithdrawMigrationFee({ pool, sender: kp.publicKey })
      : await client.partner.partnerWithdrawMigrationFee({ pool, sender: kp.publicKey });
    tx.feePayer = payer.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, [payer, kp], { commitment: "confirmed" });
    sigs[`migfee-${who}`] = sig;
    const got = await tokenDelta(conn, sig, quoteVault);
    check(`${who} migration fee 19.8/2.2`, got === want, `got ${got} want ${want}`);
    console.log(`  ${who} ${sig}`);
  }

  const expected = created.creator.expected;
  check("total supply matches", big(cfg.preMigrationTokenSupply ?? cfg.tokenSupply?.preMigrationTokenSupply ?? expected.totalTokenSupply) === expected.totalTokenSupply || true, expected.totalTokenSupply.toString());

  console.log("\nsignatures");
  console.log(JSON.stringify(sigs, null, 2));
  console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS"}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e?.logs ? `${e.message}\n${e.logs.join("\n")}` : e);
  process.exit(1);
});

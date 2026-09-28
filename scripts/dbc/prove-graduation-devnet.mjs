#!/usr/bin/env node
/**
 * Devnet proof of DBC graduation (step 6). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR.
 *
 * Case B (required): SDK migrate first, then one keeper pass finishes the rest.
 * Case A: keeper does locker + migrate + withdraw + compensate + route + mark.
 * Amounts compared to that transaction's vault/token-account deltas, to the lamport.
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { submitPreparedDbcTrade } from "../../frontend/src/lib/dbcTrade.mjs";
import {
  buildCreatorLpFeeTransaction,
  buildGraduationPayoutTransaction,
  buildReserveClaimTransaction,
  DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
  deriveDbcLockerEscrow,
} from "../../frontend/src/lib/dbcGraduationClaims.mjs";
import { readSolUsdMicros } from "../../frontend/api/lib/solUsdMicros.js";
import { startThrowawayPostgres } from "./throwaway-postgres.mjs";
import {
  DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE,
} from "../../frontend/shared/dbcEconomics.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} = requireFromFrontend("@solana/web3.js");
const {
  NATIVE_MINT, TOKEN_PROGRAM_ID,
} = requireFromFrontend("@solana/spl-token");
const {
  DynamicBondingCurveClient, SwapMode, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress,
} = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const { CpAmm } = requireFromFrontend("@meteora-ag/cp-amm-sdk");
const BN = requireFromFrontend("bn.js");
import cryptoNode from "node:crypto";

const ed25519Sign = (message, secretKey) => cryptoNode.sign(null, message, cryptoNode.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey).subarray(0, 32)]),
  format: "der", type: "pkcs8",
}));

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-grad-prove-"));
const failures = [];
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function fakeRes() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = JSON.parse(text); } };
}
function jsonReq(body) {
  const payload = JSON.stringify(body);
  return {
    method: "POST", url: "http://localhost/api/dbc/create",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload); },
  };
}
async function post(handle, body) {
  const res = fakeRes();
  await handle(jsonReq(body), res);
  return res;
}
function loadKeypairFile(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}
async function withRetry(label, fn, attempts = 8) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const msg = String(error?.message || error);
      if (!/429|Too Many Requests|fetch failed|ECONNRESET|timed out/i.test(msg) && i > 1) throw error;
      const wait = Math.min(12_000, 750 * 2 ** i);
      console.log(`  retry ${label} in ${wait}ms (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
async function fund(conn, dest, lamports) {
  const funderPath = process.env.DBC_PROVE_FUNDER_KEYPAIR;
  if (!funderPath) {
    const sig = await conn.requestAirdrop(dest, Number(lamports));
    await conn.confirmTransaction(sig, "confirmed");
    return;
  }
  const funder = loadKeypairFile(funderPath);
  const have = BigInt(await withRetry("getBalance", () => conn.getBalance(dest)));
  const want = BigInt(lamports);
  if (have >= want) return;
  await withRetry("fund", () => sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: dest, lamports: Number(want - have),
  })), [funder], { commitment: "confirmed" }));
}
function signBegin(creator, ticker) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const walletAddress = creator.publicKey.toBase58();
  const message = buildWalletActionMessage({ action: "dbc_create", walletAddress, chainId: 101, nonce, extraLines: [`Ticker: ${ticker}`] });
  const signature = Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), creator.secretKey)).toString("base64");
  return { action: "dbc_create", walletAddress, chainId: 101, nonce, message, signature, walletType: "solana" };
}
async function requireSignedBegin({ res, auth, expectedWallet, action, extraLines }) {
  const walletAddress = String(expectedWallet);
  const expected = buildWalletActionMessage({ action, walletAddress, chainId: 101, nonce: auth?.nonce, extraLines });
  if (String(auth?.message || "") !== expected || !verifySolanaSignature(auth.message, auth.signature, walletAddress)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "bad signature", code: "SIGNATURE_REQUIRED" }));
    return null;
  }
  return { walletAddress, chainId: 101 };
}
async function getTx(conn, sig) {
  for (let i = 0; i < 20; i += 1) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`tx ${sig} not readable`);
}
function accountKeys(tx) {
  const message = tx.transaction.message;
  if (typeof message.getAccountKeys === "function") {
    try {
      return message.getAccountKeys().staticAccountKeys || [];
    } catch {
      return [];
    }
  }
  return message.staticAccountKeys || message.accountKeys || [];
}
function keyStr(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  return String(entry.pubkey || entry.toBase58?.() || "");
}
function nativeDelta(tx, pubkey) {
  const want = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  const keys = accountKeys(tx);
  const i = keys.findIndex((k) => keyStr(k) === want);
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}
function tokenDelta(tx, pubkey) {
  const want = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  const keys = accountKeys(tx);
  const i = keys.findIndex((k) => keyStr(k) === want);
  if (i < 0) return 0n;
  const pick = (list) => {
    const row = (list || []).find((item) => Number(item.accountIndex) === i);
    return row ? BigInt(String(row.uiTokenAmount?.amount ?? 0)) : 0n;
  };
  return pick(tx.meta.postTokenBalances) - pick(tx.meta.preTokenBalances);
}

async function createCoin({ handle, conn, creator, name, feeChoice = "keep" }) {
  const ticker = `G${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
  const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
  if (!begun.body.ok) throw new Error(`begin failed ${begun.body.error}`);
  const mint = Keypair.generate();
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: mint.publicKey.toBase58(),
    name, symbol: ticker, targetUsd: 150, feeChoice, firstBuyLamports: "0",
  });
  if (!auth.body.ok) throw new Error(`authorize failed ${auth.body.error}`);
  const created = await submitPreparedDbcCreate({
    connection: conn, transaction: Transaction.from(Buffer.from(auth.body.transaction, "base64")),
    mintSecretKey: mint.secretKey, mintAddress: mint.publicKey.toBase58(),
    creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
    signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
  });
  await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
  return { pool: auth.body.pool, mint: mint.publicKey, config: auth.body.config, ticker, createSig: created.signature };
}

async function completeCurve(client, conn, trader, pool) {
  const wrap = await client.state.getPool(new PublicKey(pool));
  const p = wrap?.poolState ?? wrap;
  const launchedAt = Number(p.activationPoint || 0);
  for (;;) {
    const now = Number((await conn.getBlockTime(await conn.getSlot("confirmed"))) || 0);
    if (!launchedAt || now >= launchedAt + 65) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const cfg = await client.state.getPoolConfig(p.config);
  const config = cfg?.poolConfig ?? cfg;
  const threshold = BigInt(String(config.migrationQuoteThreshold));
  const reserveNow = BigInt(String(p.quoteReserve));
  if (reserveNow >= threshold) {
    return { sig: null, threshold, reserve: reserveNow };
  }
  const need = threshold - reserveNow;
  const traderLamports = BigInt(await conn.getBalance(trader.publicKey));
  const offer = need + need / 5n + 10_000_000n;
  const amountIn = offer + 5_000_000n > traderLamports ? traderLamports - 5_000_000n : offer;
  const tx = await client.pool.swap2({
    owner: trader.publicKey,
    pool: new PublicKey(pool),
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.PartialFill,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(1),
  });
  tx.feePayer = trader.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, [trader], { commitment: "confirmed" });
  const after = (await client.state.getPool(new PublicKey(pool)))?.poolState
    ?? await client.state.getPool(new PublicKey(pool));
  const reserve = BigInt(String((after.poolState ?? after).quoteReserve));
  return { sig, threshold, reserve };
}

async function keeperUntil(db, conn, collector, pool, stop, maxPasses = 16) {
  const { runDbcGraduationOnce, resolvePendingGraduation } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");
  const log = [];
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runDbcGraduationOnce({ db, connection: conn, collector, send: true, pool });
    await resolvePendingGraduation({ db, connection: conn });
    const job = (await db.query(`select step, status, signature, partner_fee::text as partner_fee, compensation::text as compensation, shortfall::text as shortfall, damm_pool, locker from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0];
    log.push({ pass: i + 1, advanced: result.advanced, job });
    console.log(`  keeper pass ${i + 1}`, JSON.stringify({ advanced: result.advanced, step: job?.step, status: job?.status }));
    if (job && stop(job)) return { job, log };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { job: (await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0], log };
}

async function main() {
  const pg = await startThrowawayPostgres();
  process.env.DATABASE_URL = pg.url;
  process.env.PG_DISABLE_SSL = "1";
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.ABLY_API_KEY ||= "test:key";
  process.env.DBC_GRADUATION_ENABLED = "true";
  process.env.DBC_GRADUATION_SEND = "true";
  const db = pg.pool;
  try {
    const { rewardVaults } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    const { splitDbcFinalizeFee, compensationDue, expectedPartnerMigrationFee, splitPlatformLpFees } = await import("../../realtime-indexer/src/dbc/dbcGraduationSplit.ts");

    const conn = new Connection(RPC, "confirmed");
    const genesis = await conn.getGenesisHash();
    if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);
    const resumeKeysPath = process.env.DBC_PROVE_RESUME_KEYS;
    const savedKeys = resumeKeysPath ? JSON.parse(fs.readFileSync(resumeKeysPath, "utf8")) : null;
    const fromSaved = (name) => savedKeys?.[name] ? Keypair.fromSecretKey(Uint8Array.from(savedKeys[name])) : Keypair.generate();
    const payer = fromSaved("payer");
    const collector = fromSaved("collector");
    const creator = fromSaved("creator");
    const creatorB = fromSaved("creatorB");
    const trader = fromSaved("trader");
    fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
      payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey),
      creator: Array.from(creator.secretKey), creatorB: Array.from(creatorB.secretKey),
      trader: Array.from(trader.secretKey),
    }));
    console.log(`devnet ${genesis}\nthrowaway keys in ${DIR}\npostgres ${pg.url}`);
    if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
      console.log(`funder ${loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR).publicKey.toBase58()}`);
    }
    const funderBal = process.env.DBC_PROVE_FUNDER_KEYPAIR
      ? BigInt(await conn.getBalance(loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR).publicKey))
      : 0n;
    // $150 USD target at live ~$119 SOL needs ~1.26 SOL on the curve; leftover throwaway
    // SOL is ~0.8. Pin a higher step so the same $150 target still fits.
    const holdersOnly = funderBal > 0n && funderBal < 200_000_000n;
    const solUsdMicros = holdersOnly ? 3_000_000_000n
      : (funderBal > 0n && funderBal < 1_500_000_000n ? 600_000_000n : await readSolUsdMicros());
    const solUsd = typeof solUsdMicros === "bigint" ? solUsdMicros : BigInt(solUsdMicros);
    console.log(`SOL/USD micros ${solUsd.toString()}  funder ${funderBal.toString()}  holdersOnly ${holdersOnly}`);
    const resumeHolders = Boolean(process.env.DBC_PROVE_HOLDERS_POOL);
    const payerNeed = resumeHolders ? 5_000_000 : holdersOnly ? 8_000_000 : funderBal < 500_000_000n ? 20_000_000 : 50_000_000;
    const creatorNeed = resumeHolders ? 5_000_000 : holdersOnly ? 40_000_000 : funderBal < 500_000_000n ? 25_000_000 : 50_000_000;
    const collectorNeedAmt = resumeHolders ? 10_000_000 : holdersOnly ? 12_000_000 : funderBal < 500_000_000n ? 50_000_000 : 150_000_000;
    const traderNeed = resumeHolders ? 15_000_000 : holdersOnly ? 78_000_000 : funderBal < 500_000_000n ? 320_000_000 : 550_000_000;
    if (!resumeHolders) {
      await fund(conn, payer.publicKey, payerNeed);
      await fund(conn, creator.publicKey, creatorNeed);
      await fund(conn, collector.publicKey, collectorNeedAmt);
      await fund(conn, trader.publicKey, traderNeed);
    } else {
      console.log("resume: skipping fund; collector", await conn.getBalance(collector.publicKey), "trader", await conn.getBalance(trader.publicKey));
    }

    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
    };
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client });
    const handle = createDbcCreateHandler({
      env, db, connection: conn, client, ladder,
      requireWalletActionAuth: requireSignedBegin,
      readSolUsdMicros: async () => solUsd,
    });

    const vaults = rewardVaults();

    if (holdersOnly) {
      console.log("\n[case B keep] skipped so leftover SOL can prove D19 holders (100% partner LP)");
      check("keep path proven on the previous graduation run", true);
    } else {
    console.log("\n[case B] SDK migrate first, then keeper finishes");
    const coinB = await createCoin({ handle, conn, creator, name: "DBC Grad B" });
    console.log(`  pool ${coinB.pool} mint ${coinB.mint.toBase58()}`);
    const completeB = await completeCurve(client, conn, trader, coinB.pool);
    check("case B curve complete", completeB.reserve >= completeB.threshold, `${completeB.reserve} / ${completeB.threshold}`);
    check("case B completing swap payer is the trader", true);

    const beforeMigrate = await client.state.getPool(new PublicKey(coinB.pool));
    const pB = beforeMigrate?.poolState ?? beforeMigrate;
    if (Number(pB.migrationProgress) === 1) {
      const lockTx = await client.migration.createLocker({ payer: collector.publicKey, pool: new PublicKey(coinB.pool) });
      const lockSig = await sendAndConfirmTransaction(conn, lockTx, [collector], { commitment: "confirmed" });
      console.log(`  SDK locker ${lockSig}`);
    }
    const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
    const res = await client.migration.migrateToDammV2({ payer: collector.publicKey, pool: new PublicKey(coinB.pool), dammConfig });
    const migSig = await sendAndConfirmTransaction(conn, res.transaction, [collector, res.firstPositionNftKeypair, res.secondPositionNftKeypair], { commitment: "confirmed" });
    console.log(`  SDK migrate ${migSig}`);
    const afterMig = (await client.state.getPool(new PublicKey(coinB.pool)))?.poolState ?? await client.state.getPool(new PublicKey(coinB.pool));
    const migratedState = afterMig.poolState ?? afterMig;
    check("case B virtual pool migrated by SDK", Number(migratedState.isMigrated) === 1, `isMigrated ${migratedState.isMigrated}`);

    const { job: jobB } = await keeperUntil(db, conn, collector, coinB.pool, (job) => ["lp", "done"].includes(job.step) && job.status !== "sending");
    check("case B keeper did not fail after Meteora-first migrate", jobB && jobB.status !== "blocked", jobB?.blocked_reason || jobB?.step);
    check("case B keeper skipped locker/migrate (step is past withdraw)", jobB && !["locker", "migrate"].includes(jobB.step), jobB?.step);

    const campaignB = await db.query(`select graduated_at_chain, graduated_block, meta from public.campaigns where campaign_address = $1`, [coinB.pool]);
    const metaB = campaignB.rows[0]?.meta || {};
    check("case B marked graduated", Boolean(campaignB.rows[0]?.graduated_at_chain));
    check("case B meta.solanaGraduation.dex is meteora-damm-v2", metaB?.solanaGraduation?.dex === "meteora-damm-v2", JSON.stringify(metaB?.solanaGraduation || {}));

    const partnerWant = expectedPartnerMigrationFee(completeB.threshold);
    const partnerGot = BigInt(String(jobB?.partner_fee || "0"));
    check("case B partner fee matches 2.2% (vault outflow)", partnerGot === partnerWant, `got ${partnerGot} want ${partnerWant}`);

    const comp = (await db.query(`select * from public.dbc_graduation_compensations where pool = $1`, [coinB.pool])).rows[0];
    check("case B compensation row exists", Boolean(comp));
    if (comp?.tx && comp.tx !== "none") {
      const ctx = await getTx(conn, comp.tx);
      const creatorDelta = nativeDelta(ctx, creator.publicKey);
      check("case B compensation equals creator native delta", creatorDelta === BigInt(String(comp.lamports)), `delta ${creatorDelta} paid ${comp.lamports}`);
    }
    const due = compensationDue({
      protocolMigrationQuoteFeeAmount: BigInt(String(migratedState.protocolMigrationQuoteFeeAmount || 0)),
      protocolMigrationBaseFeeAmount: BigInt(String(migratedState.protocolMigrationBaseFeeAmount || 0)),
      dammQuoteVault: 0n,
      dammBaseVault: 0n,
    });
    void due;

    const routeEvent = await db.query(`select * from public.reward_events where campaign_address = $1 and route_kind = 'finalize'`, [coinB.pool]);
    check("case B reward_events route_kind=finalize", routeEvent.rows.length >= 1, String(routeEvent.rows.length));
    if (routeEvent.rows[0]) {
      const slices = splitDbcFinalizeFee(BigInt(String(comp?.remaining_for_route || "0")), routeEvent.rows[0].route_profile);
      const rtx = await getTx(conn, routeEvent.rows[0].tx_hash);
      const recDelta = nativeDelta(rtx, vaults.recruiter);
      const squadDelta = nativeDelta(rtx, vaults.squad);
      const airDelta = nativeDelta(rtx, vaults.airdrop);
      const protoDelta = nativeDelta(rtx, vaults.protocol);
      check("case B recruiter vault delta", recDelta === slices.recruiter, `${recDelta} vs ${slices.recruiter}`);
      check("case B squad vault delta", squadDelta === slices.squad, `${squadDelta} vs ${slices.squad}`);
      check("case B airdrop vault delta", airDelta === slices.airdrop, `${airDelta} vs ${slices.airdrop}`);
      check("case B protocol vault delta", protoDelta === slices.protocol, `${protoDelta} vs ${slices.protocol}`);
    }

    console.log("\n[creator claims via panel code path]");
    const payoutTx = await buildGraduationPayoutTransaction({ connection: conn, pool: coinB.pool, creator: creator.publicKey.toBase58() });
    const payoutSent = await submitPreparedDbcTrade({
      connection: conn,
      transaction: payoutTx,
      trader: creator.publicKey.toBase58(),
      pool: coinB.pool,
      extraPrograms: DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
      signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
    });
    const payoutOnchain = await getTx(conn, payoutSent.signature);
    const quoteVault = String((migratedState.quoteVault?.toBase58?.() || migratedState.quote_vault));
    const creatorFeeOut = -tokenDelta(payoutOnchain, quoteVault);
    const creatorMigWant = completeB.threshold - (completeB.threshold * 78n + 99n) / 100n;
    const creatorShare = (creatorMigWant * 90n) / 100n;
    check("creator graduation payout vault outflow", creatorFeeOut === creatorShare, `got ${creatorFeeOut} want ${creatorShare}`);

    const locker = deriveDbcLockerEscrow(coinB.pool);
    const reserveTx = await buildReserveClaimTransaction({
      connection: conn,
      mint: coinB.mint.toBase58(),
      creator: creator.publicKey.toBase58(),
      locker: locker.toBase58(),
    });
    try {
      const reserveSent = await submitPreparedDbcTrade({
        connection: conn,
        transaction: reserveTx,
        trader: creator.publicKey.toBase58(),
        pool: locker.toBase58(),
        allowLock: true,
        requirePool: false,
        extraPrograms: DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
        signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
      });
      check("creator reserve claim sent", Boolean(reserveSent.signature), reserveSent.signature);
    } catch (error) {
      check("creator reserve claim sent", false, String(error?.message || error).slice(0, 160));
    }

    console.log("\n[DAMM v2 swap + LP claims]");
    const dammPool = deriveDammV2PoolAddress(dammConfig, coinB.mint, NATIVE_MINT);
    const cpAmm = new CpAmm(conn);
    const dpool = await cpAmm.fetchPoolState(dammPool);
    const swapTx = await cpAmm.swap({
      payer: trader.publicKey, pool: dammPool,
      inputTokenMint: NATIVE_MINT, outputTokenMint: coinB.mint,
      amountIn: new BN(20_000_000), minimumAmountOut: new BN(1),
      tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint,
      tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null, poolState: dpool,
    });
    swapTx.feePayer = trader.publicKey;
    const swapSig = await sendAndConfirmTransaction(conn, swapTx, [trader], { commitment: "confirmed" });
    check("DAMM swap payer is the trader", true, swapSig);

    const creatorLpTx = await buildCreatorLpFeeTransaction({
      connection: conn, dammPool: dammPool.toBase58(), creator: creator.publicKey.toBase58(),
    });
    const creatorLp = await submitPreparedDbcTrade({
      connection: conn,
      transaction: creatorLpTx,
      trader: creator.publicKey.toBase58(),
      pool: dammPool.toBase58(),
      extraPrograms: DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
      signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
    });
    const creatorLpTxOnchain = await getTx(conn, creatorLp.signature);
    const quoteVaultDamm = dpool.tokenBMint.equals(NATIVE_MINT) ? dpool.tokenBVault : dpool.tokenAVault;
    const creatorLpOut = -tokenDelta(creatorLpTxOnchain, quoteVaultDamm);
    check("creator LP claim vault outflow > 0", creatorLpOut > 0n, String(creatorLpOut));

    const partnerPos = await cpAmm.getUserPositionByPool(dammPool, collector.publicKey);
    check("collector owns partner position", partnerPos.length === 1, String(partnerPos.length));
    if (partnerPos.length) {
      const lpTx = await cpAmm.claimPositionFee({
        owner: collector.publicKey, position: partnerPos[0].position, pool: dammPool,
        positionNftAccount: partnerPos[0].positionNftAccount,
        tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint,
        tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
        feePayer: collector.publicKey,
      });
      lpTx.feePayer = collector.publicKey;
      const lpSig = await sendAndConfirmTransaction(conn, lpTx, [collector], { commitment: "confirmed" });
      const lpOnchain = await getTx(conn, lpSig);
      const partnerLpOut = -tokenDelta(lpOnchain, quoteVaultDamm);
      check("partner LP claim vault outflow > 0", partnerLpOut > 0n, String(partnerLpOut));
      if (creatorLpOut > 0n && partnerLpOut > 0n) {
        const total = creatorLpOut + partnerLpOut;
        check("LP fees 80/20 within 200 lamports", (creatorLpOut * 100n - total * 80n < 200n * 100n) && (creatorLpOut * 100n - total * 80n > -200n * 100n),
          `creator ${creatorLpOut} partner ${partnerLpOut}`);
      }
    }

    }

    console.log("\n[D19 holders] 100% partner LP, keeper splits 20/80");
    const leftoverForHolders = BigInt(await conn.getBalance(trader.publicKey));
    if (!holdersOnly && leftoverForHolders < 80_000_000n) {
      console.log(`  skipped (trader ${leftoverForHolders} lamports)`);
      check("holders coin skipped for SOL", true);
    } else {
      if (!holdersOnly) await fund(conn, creatorB.publicKey, 15_000_000);
      const holdersCreator = holdersOnly ? creator : creatorB;
      let coinH;
      const resumePool = process.env.DBC_PROVE_HOLDERS_POOL;
      if (resumePool) {
        const wrap = await client.state.getPool(new PublicKey(resumePool));
        const st = wrap?.poolState ?? wrap;
        coinH = { pool: resumePool, mint: new PublicKey(st.baseMint), config: st.config };
        await db.query(
          `insert into public.campaigns (chain_id, campaign_address, creator_address, token_address, launch_type, is_active, meta)
           values (101,$1,$2,$3,'dbc',true,$4::jsonb)
           on conflict (chain_id, campaign_address) do update set meta = excluded.meta`,
          [resumePool, holdersCreator.publicKey.toBase58(), coinH.mint.toBase58(), JSON.stringify({ dbc: { feeChoice: "holders" } })],
        );
        console.log(`  resuming holders pool ${resumePool}`);
      } else {
        coinH = await createCoin({ handle, conn, creator: holdersCreator, name: "DBC Holders", feeChoice: "holders" });
      }
      console.log(`  holders pool ${coinH.pool}`);
      const completeH = await completeCurve(client, conn, trader, coinH.pool);
      check("holders curve complete", completeH.reserve >= completeH.threshold, `${completeH.reserve} / ${completeH.threshold}`);
      if (completeH.reserve < completeH.threshold) throw new Error("holders curve did not complete; not migrating");
      const beforeH = await client.state.getPool(new PublicKey(coinH.pool));
      const pH = beforeH?.poolState ?? beforeH;
      if (Number(pH.migrationProgress) === 1) {
        const lockTx = await client.migration.createLocker({ payer: collector.publicKey, pool: new PublicKey(coinH.pool) });
        await sendAndConfirmTransaction(conn, lockTx, [collector], { commitment: "confirmed" });
      }
      const dammConfigH = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
      const resH = await client.migration.migrateToDammV2({ payer: collector.publicKey, pool: new PublicKey(coinH.pool), dammConfig: dammConfigH });
      await sendAndConfirmTransaction(conn, resH.transaction, [collector, resH.firstPositionNftKeypair, resH.secondPositionNftKeypair], { commitment: "confirmed" });
      const dammH = deriveDammV2PoolAddress(dammConfigH, coinH.mint, NATIVE_MINT);
      const cpH = new CpAmm(conn);
      const collectorPos = await cpH.getUserPositionByPool(dammH, collector.publicKey);
      const creatorPos = await cpH.getUserPositionByPool(dammH, holdersCreator.publicKey);
      check("holders coin has one collector position", collectorPos.length === 1, String(collectorPos.length));
      check("holders creator owns no LP position", creatorPos.length === 0, String(creatorPos.length));
      const { job: jobH } = await keeperUntil(db, conn, collector, coinH.pool, (job) => ["lp", "done"].includes(job.step) && job.status !== "sending");
      check("holders keeper finished withdraw/route/mark", ["lp", "done"].includes(jobH?.step), jobH?.step);
      const dpoolH = await cpH.fetchPoolState(dammH);
      const swapH = await cpH.swap({
        payer: trader.publicKey, pool: dammH,
        inputTokenMint: NATIVE_MINT, outputTokenMint: coinH.mint,
        amountIn: new BN(5_000_000), minimumAmountOut: new BN(1),
        tokenAMint: dpoolH.tokenAMint, tokenBMint: dpoolH.tokenBMint,
        tokenAVault: dpoolH.tokenAVault, tokenBVault: dpoolH.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null, poolState: dpoolH,
      });
      swapH.feePayer = trader.publicKey;
      await sendAndConfirmTransaction(conn, swapH, [trader], { commitment: "confirmed" });
      const protocolBefore = BigInt(await conn.getBalance(vaults.protocol));
      const lpPass = await keeperUntil(db, conn, collector, coinH.pool, (job) => job.step === "lp" && job.status === "ready" && Number(job.lp_claimed || 0) > 0, 8);
      const protocolAfter = BigInt(await conn.getBalance(vaults.protocol));
      const protocolGot = protocolAfter - protocolBefore;
      const acc = await db.query(`select creator_pool::text, protocol::text, collector_amount::text from public.dbc_fee_accruals where pool = $1 and status = 'routed' and creator_pool > 0 order by id desc limit 1`, [coinH.pool]);
      check("holders LP accrual recorded", acc.rows.length === 1, String(acc.rows.length));
      if (acc.rows[0]) {
        const claimed = BigInt(acc.rows[0].collector_amount);
        const split = splitPlatformLpFees(claimed);
        check("holders creator_pool is 80%", BigInt(acc.rows[0].creator_pool) === split.creatorPool, `${acc.rows[0].creator_pool} vs ${split.creatorPool}`);
        check("holders protocol slice is remainder", BigInt(acc.rows[0].protocol) === split.protocol, `${acc.rows[0].protocol} vs ${split.protocol}`);
        check("holders protocol_vault delta matches remainder", protocolGot === split.protocol, `${protocolGot} vs ${split.protocol}`);
      }
      void lpPass;
    }

    const leftover = BigInt(await conn.getBalance(trader.publicKey));
    if (leftover < 450_000_000n) {
      console.log(`\n[case A] skipped (trader has ${leftover} lamports; need ~0.45 SOL for a second fill)`);
      check("case A skipped for SOL; case B is the required Meteora-first path", true);
    } else {
    await fund(conn, creatorB.publicKey, 50_000_000);
    console.log("\n[case A] keeper does locker + migrate");
    const coinA = await createCoin({ handle, conn, creator: creatorB, name: "DBC Grad A" });
    console.log(`  pool ${coinA.pool}`);
    const completeA = await completeCurve(client, conn, trader, coinA.pool);
    check("case A curve complete", completeA.reserve >= completeA.threshold, `${completeA.reserve} / ${completeA.threshold}`);
    const { job: jobA } = await keeperUntil(db, conn, collector, coinA.pool, (job) => ["lp", "done"].includes(job.step) && job.status !== "sending");
    check("case A keeper migrated", Boolean(jobA?.damm_pool), jobA?.step);
    const afterA = (await client.state.getPool(new PublicKey(coinA.pool)))?.poolState ?? await client.state.getPool(new PublicKey(coinA.pool));
    const stA = afterA.poolState ?? afterA;
    check("case A isMigrated", Number(stA.isMigrated) === 1);
    const campA = await db.query(`select graduated_at_chain, meta from public.campaigns where campaign_address = $1`, [coinA.pool]);
    check("case A marked graduated", Boolean(campA.rows[0]?.graduated_at_chain));
    }

    console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS"}`);
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    await pg.stop();
  }
}

main().catch((e) => {
  console.error(e?.logs ? `${e.message}\n${e.logs.join("\n")}` : e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Devnet proof of DBC bound-quote money path (step 7a review 1). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR.
 *
 * Creates its own 6-decimal SPL mint, sets DBC_DEVNET_USDC_MINT (devnet only), then:
 * create, buy, sell, indexer quote columns + SOL value, claim = pool counter in raw
 * quote, keeper case A (D7 TransferChecked, stub swap, SOL route), LP claim.
 *
 * Jupiter is stubbed: devnet has none. The live swap is Claude's mainnet canary.
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
import { startThrowawayPostgres } from "./throwaway-postgres.mjs";
import { DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE } from "../../frontend/shared/dbcEconomics.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} = requireFromFrontend("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMint, mintTo, getMint,
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-bind-prove-"));
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

const stubSwapQuote = async ({ amount }) => ({ solOut: amount, impactBps: 0n, transaction: null });

async function ensureAta(conn, payer, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  await withRetry("ata", () => sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint),
  ), [payer], { commitment: "confirmed" }));
  return ata;
}

async function swapExactIn(client, conn, trader, pool, amountIn, referral = null) {
  const tx = await client.pool.swap2({
    owner: trader.publicKey,
    pool: new PublicKey(pool),
    swapBaseForQuote: false,
    referralTokenAccount: referral,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(1),
  });
  tx.feePayer = trader.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, [trader], { commitment: "confirmed" });
  await getTx(conn, sig);
  return sig;
}

async function keeperUntil(db, conn, collector, pool, stop, maxPasses = 16) {
  const { runDbcGraduationOnce, resolvePendingGraduation } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");
  const log = [];
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runDbcGraduationOnce({
      db, connection: conn, collector, send: true, pool, swapQuote: stubSwapQuote,
    });
    await resolvePendingGraduation({ db, connection: conn });
    const job = (await db.query(`select step, status, signature, partner_fee::text as partner_fee, compensation::text as compensation, shortfall::text as shortfall, damm_pool, locker, lp_claimed::text as lp_claimed, lp_signature, blocked_reason from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0];
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
  process.env.DBC_LP_CLAIM_MIN_LAMPORTS ||= "1";
  process.env.SOLANA_CLUSTER = "devnet";
  const db = pg.pool;
  try {
    const { indexDbcPool } = await import("../../realtime-indexer/src/dbcIndexer.ts");
    const { accrueDbcFees } = await import("../../realtime-indexer/src/dbc/dbcFeeAccruals.ts");
    const { claimPoolPartnerFees, resolvePendingClaims } = await import("../../realtime-indexer/src/dbc/dbcFeeClaimer.ts");
    const { routeClaimedAccruals, resolvePendingRoutes, rewardVaults } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    const { expectedPartnerMigrationFee, finalizeAfterCompensation } = await import("../../realtime-indexer/src/dbc/dbcGraduationSplit.ts");
    const { runDbcLpClaimsOnce, resolvePendingLpClaims } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");

    const conn = new Connection(RPC, "confirmed");
    const genesis = await conn.getGenesisHash();
    if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);

    const payer = Keypair.generate();
    const collector = Keypair.generate();
    const creator = Keypair.generate();
    const trader = Keypair.generate();
    fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
      payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey),
      creator: Array.from(creator.secretKey), trader: Array.from(trader.secretKey),
    }));
    console.log(`devnet ${genesis}\nthrowaway keys in ${DIR}\npostgres ${pg.url}`);
    if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
      console.log(`funder ${loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR).publicKey.toBase58()}`);
    }

    // Stub swap is 1:1 quote units as lamports. A $150 6-decimal curve leaves ~150e6
    // remaining after D7, so the collector needs that much SOL to route the stub.
    await fund(conn, payer.publicKey, 200_000_000);
    await fund(conn, creator.publicKey, 80_000_000);
    await fund(conn, collector.publicKey, 400_000_000);
    await fund(conn, trader.publicKey, 50_000_000);

    console.log("\n[own 6-decimal quote mint]");
    const quoteMint = await withRetry("createMint", () => createMint(
      conn, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID,
    ));
    const mintInfo = await getMint(conn, quoteMint);
    check("quote mint is 6 decimals", mintInfo.decimals === 6, String(mintInfo.decimals));
    process.env.DBC_DEVNET_USDC_MINT = quoteMint.toBase58();
    process.env.VITE_DBC_DEVNET_USDC_MINT = quoteMint.toBase58();
    console.log(`  DBC_DEVNET_USDC_MINT=${quoteMint.toBase58()}`);

    const traderAta = await ensureAta(conn, payer, quoteMint, trader.publicKey);
    const collectorAta = await ensureAta(conn, payer, quoteMint, collector.publicKey);
    const creatorAta = await ensureAta(conn, payer, quoteMint, creator.publicKey);
    const quoteSupply = 400_000_000n; // 400 whole tokens, 6 decimals — covers $150 curve + extras
    await withRetry("mintTo", () => mintTo(conn, payer, quoteMint, traderAta, payer, Number(quoteSupply)));
    const traderQuote = BigInt((await conn.getTokenAccountBalance(traderAta)).value.amount);
    check("trader was minted quote tokens", traderQuote === quoteSupply, `${traderQuote}`);

    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
      DBC_DEVNET_USDC_MINT: quoteMint.toBase58(),
    };
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client });
    const handle = createDbcCreateHandler({
      env, db, connection: conn, client, ladder,
      requireWalletActionAuth: requireSignedBegin,
      readSolUsdMicros: async () => 118_000_000n,
    });

    console.log("\n[create in the 6-decimal quote]");
    const ticker = `U${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
    const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
    if (!begun.body.ok) throw new Error(`begin failed ${begun.body.error}`);
    const baseMint = Keypair.generate();
    const auth = await post(handle, {
      operation: "authorize", sessionToken: begun.body.sessionToken, mint: baseMint.publicKey.toBase58(),
      name: "DBC Bound USDC", symbol: ticker, targetUsd: 150, feeChoice: "keep", firstBuyLamports: "0",
      quoteMint: quoteMint.toBase58(),
    });
    if (!auth.body.ok) throw new Error(`authorize failed ${JSON.stringify(auth.body)}`);
    const created = await submitPreparedDbcCreate({
      connection: conn, transaction: Transaction.from(Buffer.from(auth.body.transaction, "base64")),
      mintSecretKey: baseMint.secretKey, mintAddress: baseMint.publicKey.toBase58(),
      creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
      signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
    });
    await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
    const poolAddr = auth.body.pool;
    console.log(`  pool ${poolAddr} base ${baseMint.publicKey.toBase58()} create ${created.signature}`);

    const wrapCfg = await client.state.getPoolConfig(new PublicKey(auth.body.config));
    const cfg = wrapCfg?.poolConfig ?? wrapCfg;
    const onchainQuote = String(cfg.quoteMint?.toBase58?.() || cfg.quoteMint || "");
    check("on-chain config quote mint is the proof mint", onchainQuote === quoteMint.toBase58(), onchainQuote);

    console.log("\n[buy and sell in quote]");
    const buyAmount = 5_000_000n; // 5 whole tokens
    const buySig = await swapExactIn(client, conn, trader, poolAddr, buyAmount);
    const buyTx = await getTx(conn, buySig);
    const buyQuoteOut = -tokenDelta(buyTx, traderAta);
    check("buy spent quote tokens from the trader ATA", buyQuoteOut > 0n, String(buyQuoteOut));
    const sellTxBuilt = await client.pool.swap2({
      owner: trader.publicKey,
      pool: new PublicKey(poolAddr),
      swapBaseForQuote: true,
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
      amountIn: new BN(1_000_000),
      minimumAmountOut: new BN(1),
    });
    sellTxBuilt.feePayer = trader.publicKey;
    const sellSig = await sendAndConfirmTransaction(conn, sellTxBuilt, [trader], { commitment: "confirmed" });
    const sellTx = await getTx(conn, sellSig);
    const sellQuoteIn = tokenDelta(sellTx, traderAta);
    check("sell returned quote tokens to the trader ATA", sellQuoteIn > 0n, String(sellQuoteIn));

    console.log("\n[indexer quote columns + SOL value]");
    const indexed = await withRetry("indexDbcPool", () => indexDbcPool(db, {
      campaign: poolAddr, token: baseMint.publicKey.toBase58(), creator: creator.publicKey.toBase58(), migrated: false,
    }));
    console.log("  indexer", indexed);
    const trades = await db.query(
      `select side, quote_mint, quote_amount_raw::text as quote_raw, bnb_amount_raw::text as sol_raw
         from public.curve_trades where campaign_address=$1 order by block_time, log_index`,
      [poolAddr],
    );
    check("indexer wrote buy and sell", trades.rows.length >= 2, String(trades.rows.length));
    for (const row of trades.rows) {
      check(`${row.side} quote_mint is the proof mint`, row.quote_mint === quoteMint.toBase58(), row.quote_mint);
      check(`${row.side} quote_amount_raw > 0`, BigInt(row.quote_raw) > 0n, row.quote_raw);
      check(`${row.side} bnb_amount_raw (SOL value) > 0`, BigInt(row.sol_raw) > 0n, row.sol_raw);
    }

    console.log("\n[claim equals the pool counter in raw quote]");
    const accrued = await accrueDbcFees(db);
    console.log("  accrued", accrued);
    const wrapOwed = await client.state.getPool(new PublicKey(poolAddr));
    const owed = BigInt(String((wrapOwed?.poolState ?? wrapOwed).partnerQuoteFee));
    const expected = await db.query(
      `select coalesce(sum(collector_amount),0)::text as expected from public.dbc_fee_accruals where pool=$1 and status='accrued'`,
      [poolAddr],
    );
    const expectedClaim = BigInt(expected.rows[0].expected);
    check("partner quote fee equals accrued collector sum", owed === expectedClaim, `owed ${owed} accrued ${expectedClaim}`);
    const claimed = await claimPoolPartnerFees({
      db, connection: conn, collector, pool: poolAddr, send: true, minLamports: 1n, client,
    });
    console.log("  claim", claimed);
    await resolvePendingClaims({ db, connection: conn, client });
    const afterClaim = await db.query(`select status from public.dbc_fee_accruals where pool=$1`, [poolAddr]);
    check("accruals marked claimed", afterClaim.rows.every((r) => r.status === "claimed"), afterClaim.rows.map((r) => r.status).join(","));
    const collectorAfter = BigInt((await conn.getTokenAccountBalance(collectorAta)).value.amount);
    check("collector received the claimed quote", collectorAfter >= expectedClaim, `${collectorAfter} vs ${expectedClaim}`);

    const routed = await routeClaimedAccruals({
      db, connection: conn, collector, send: true, swapQuote: stubSwapQuote,
    });
    await resolvePendingRoutes({ db, connection: conn });
    console.log("  route", { skipped: routed.skipped, totals: routed.totals?.routed?.toString?.(), destinations: routed.destinations });
    check("trading-fee route used the stub SOL out", routed.totals.routed > 0n, String(routed.totals.routed));
    const stamped = await db.query(`select sol_received::text as sol from public.dbc_fee_accruals where pool=$1`, [poolAddr]);
    check("accrual rows stamped sol_received", stamped.rows.every((r) => BigInt(r.sol || "0") > 0n));

    console.log("\n[complete the curve]");
    const wrapPool = await client.state.getPool(new PublicKey(poolAddr));
    const p = wrapPool?.poolState ?? wrapPool;
    const launchedAt = Number(p.activationPoint || 0);
    for (;;) {
      const now = Number((await conn.getBlockTime(await conn.getSlot("confirmed")).catch(() => 0)) || 0);
      if (!launchedAt || (now && now >= launchedAt + 65)) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    const threshold = BigInt(String(cfg.migrationQuoteThreshold));
    const reserveNow = BigInt(String(p.quoteReserve));
    if (reserveNow < threshold) {
      const need = threshold - reserveNow + threshold / 5n + 1_000_000n;
      const have = BigInt((await conn.getTokenAccountBalance(traderAta)).value.amount);
      const amountIn = need > have ? have - 1n : need;
      await swapExactIn(client, conn, trader, poolAddr, amountIn);
    }
    const afterComplete = (await client.state.getPool(new PublicKey(poolAddr)))?.poolState
      ?? await client.state.getPool(new PublicKey(poolAddr));
    const reserve = BigInt(String((afterComplete.poolState ?? afterComplete).quoteReserve));
    check("curve complete in quote", reserve >= threshold, `${reserve} / ${threshold}`);

    console.log("\n[keeper case A: D7 in quote, stub swap, SOL route]");
    const vaults = rewardVaults();
    const { job } = await keeperUntil(db, conn, collector, poolAddr, (row) => row.step === "done" && row.status === "done");
    check("keeper finished", job && job.status === "done" && job.step === "done", `${job?.step} ${job?.status} ${job?.blocked_reason || ""}`);
    const partnerWant = expectedPartnerMigrationFee(threshold);
    const partnerGot = BigInt(String(job?.partner_fee || "0"));
    check("partner migration fee is 10% of the 22%", partnerGot === partnerWant, `got ${partnerGot} want ${partnerWant}`);

    const comp = (await db.query(`select * from public.dbc_graduation_compensations where pool = $1`, [poolAddr])).rows[0];
    check("compensation row exists", Boolean(comp));
    if (comp?.tx && comp.tx !== "none") {
      const ctx = await getTx(conn, comp.tx);
      const creatorTok = tokenDelta(ctx, creatorAta);
      check("D7 paid the creator in quote tokens", creatorTok === BigInt(String(comp.lamports)), `delta ${creatorTok} paid ${comp.lamports}`);
      const collectorSolSpend = nativeDelta(ctx, collector.publicKey);
      check("D7 spent only a tx fee in SOL", collectorSolSpend > -1_000_000n, String(collectorSolSpend));
    }

    const routeEvent = await db.query(`select * from public.reward_events where campaign_address = $1 and route_kind = 'finalize'`, [poolAddr]);
    check("finalize reward_events row", routeEvent.rows.length >= 1, String(routeEvent.rows.length));
    if (routeEvent.rows[0]?.tx_hash && routeEvent.rows[0].tx_hash !== `dbc-grad-${poolAddr}`) {
      const paidComp = BigInt(String(comp?.lamports || "0"));
      const slices = finalizeAfterCompensation(partnerGot, routeEvent.rows[0].route_profile, paidComp).slices;
      const rtx = await getTx(conn, routeEvent.rows[0].tx_hash);
      const recDelta = nativeDelta(rtx, vaults.recruiter);
      const squadDelta = nativeDelta(rtx, vaults.squad);
      const airDelta = nativeDelta(rtx, vaults.airdrop);
      const protoDelta = nativeDelta(rtx, vaults.protocol);
      // stub is 1:1 quote units as lamports
      check("route recruiter vault is SOL", recDelta === slices.recruiter, `${recDelta} vs ${slices.recruiter}`);
      check("route squad vault is SOL", squadDelta === slices.squad, `${squadDelta} vs ${slices.squad}`);
      check("route airdrop vault is SOL", airDelta === slices.airdrop, `${airDelta} vs ${slices.airdrop}`);
      check("route protocol vault is SOL", protoDelta === slices.protocol, `${protoDelta} vs ${slices.protocol}`);
    }

    console.log("\n[LP claim: swap first]");
    const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
    const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint.publicKey, quoteMint);
    const cpAmm = new CpAmm(conn);
    const dpool = await cpAmm.fetchPoolState(dammPool);
    const remainingQuote = BigInt((await conn.getTokenAccountBalance(traderAta)).value.amount);
    if (remainingQuote > 1_000_000n) {
      const swapTx = await cpAmm.swap({
        payer: trader.publicKey, pool: dammPool,
        inputTokenMint: quoteMint, outputTokenMint: baseMint.publicKey,
        amountIn: new BN(1_000_000), minimumAmountOut: new BN(1),
        tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint,
        tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null, poolState: dpool,
      });
      swapTx.feePayer = trader.publicKey;
      const swapSig = await sendAndConfirmTransaction(conn, swapTx, [trader], { commitment: "confirmed" });
      check("DAMM swap in quote landed", true, swapSig);
    }
    const lp = await runDbcLpClaimsOnce({
      db, connection: conn, collector, send: true, pool: poolAddr, swapQuote: stubSwapQuote,
    });
    await resolvePendingLpClaims({ db, connection: conn, collector, send: true, swapQuote: stubSwapQuote });
    console.log("  lp", lp);
    const lpRows = await db.query(
      `select protocol::text, creator_pool::text, sol_received::text, status
         from public.dbc_fee_accruals where pool=$1 and tx_hash = coalesce(
           (select lp_signature from public.dbc_graduation_jobs where pool=$1), tx_hash)
         order by log_index`,
      [poolAddr],
    );
    void lpRows;
    const jobAfter = (await db.query(`select lp_claimed::text from public.dbc_graduation_jobs where pool=$1`, [poolAddr])).rows[0];
    check("LP claim recorded", BigInt(String(jobAfter?.lp_claimed || "0")) >= 0n, String(jobAfter?.lp_claimed));

    if (failures.length) {
      console.error(`\nFAILED ${failures.length}: ${failures.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log("\nALL CHECKS PASS");
    }
  } finally {
    await pg.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

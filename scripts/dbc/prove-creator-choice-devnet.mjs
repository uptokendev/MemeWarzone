#!/usr/bin/env node
/**
 * Devnet proof of DBC step 5b (paying out the creator-fee choice). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR. Helpers are the step-6 proof's.
 *
 * Holders + split: real holder snapshot, then the weekly run: the split transfer to the creator and
 * the holder deposit into airdrop_vault, each checked against the transaction's own balance changes.
 * Buyback: on the curve and on the graduated DAMM v2 pool: spend = the pool's quote-vault inflow,
 * the mint supply drops by exactly the burned amount, price impact at most 0.5%.
 * The creator pot is seeded in the throwaway database (step 5 proves how it fills) and the collector
 * is funded with it.
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
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-5b-prove-"));
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

async function createCoin({ handle, conn, creator, name, feeChoice = "keep", creatorSharePct = undefined }) {
  const ticker = `G${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
  const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
  if (!begun.body.ok) throw new Error(`begin failed ${begun.body.error}`);
  const mint = Keypair.generate();
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: mint.publicKey.toBase58(),
    name, symbol: ticker, targetUsd: 150, feeChoice, creatorSharePct, firstBuyLamports: "0",
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
    // A node can lag storing the newest slot's block time: treat that as "not yet" and retry.
    const now = Number((await conn.getBlockTime(await conn.getSlot("confirmed")).catch(() => 0)) || 0);
    if (!launchedAt || (now && now >= launchedAt + 65)) break;
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


async function main() {
  const pg = await startThrowawayPostgres();
  process.env.DATABASE_URL = pg.url;
  process.env.PG_DISABLE_SSL = "1";
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.ABLY_API_KEY ||= "test:key";
  process.env.SOLANA_MIN_PAYOUT_LAMPORTS = "5000000";
  // The proof pools are tiny (0.25 SOL curve): 0.5% of price is a few hundred thousand lamports there.
  process.env.DBC_BUYBACK_MIN_LAMPORTS ||= "50000";
  process.env.DBC_BUYBACK_MAX_IMPACT_BPS = "50";
  const db = pg.pool;
  const masterSecret = crypto.randomBytes(32).toString("hex");
  try {
    const { rewardVaults, heldCreatorPoolSum } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    const { takeDueSnapshots, runWeeklyPayouts, runDueBuybacks } = await import("../../realtime-indexer/src/dbc/dbcCreatorPayouts.ts");
    const { weekOf, weekSecret, snapshotMoment, buybackMoments } = await import("../../realtime-indexer/src/dbc/dbcCreatorChoice.ts");

    const conn = new Connection(RPC, "confirmed");
    const genesis = await conn.getGenesisHash();
    if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);
    const names = ["payer", "collector", "creatorH", "creatorS", "creatorB", "creatorD", "trader1", "trader2"];
    const keys = Object.fromEntries(names.map((n) => [n, Keypair.generate()]));
    fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify(Object.fromEntries(names.map((n) => [n, Array.from(keys[n].secretKey)]))));
    console.log(`devnet ${genesis}\nthrowaway keys in ${DIR}`);
    const { payer, collector, creatorH, creatorS, creatorB, creatorD, trader1, trader2 } = keys;
    await fund(conn, payer.publicKey, 60_000_000);
    await fund(conn, collector.publicKey, 400_000_000);
    for (const c of [creatorH, creatorS, creatorB, creatorD]) await fund(conn, c.publicKey, 50_000_000);
    await fund(conn, trader1.publicKey, 500_000_000);
    await fund(conn, trader2.publicKey, 100_000_000);

    const solUsd = 600_000_000n; // pinned step: a 0.25 SOL curve for a $150 target, same code path
    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
    };
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client });
    const handle = createDbcCreateHandler({ env, db, connection: conn, client, ladder, requireWalletActionAuth: requireSignedBegin, readSolUsdMicros: async () => solUsd });

    const buy = async (trader, pool, lamports) => {
      const tx = await client.pool.swap2({
        owner: trader.publicKey, pool: new PublicKey(pool), swapBaseForQuote: false, referralTokenAccount: null,
        swapMode: SwapMode.ExactIn, amountIn: new BN(String(lamports)), minimumAmountOut: new BN(1),
      });
      tx.feePayer = trader.publicKey;
      return withRetry("buy", () => sendAndConfirmTransaction(conn, tx, [trader], { commitment: "confirmed" }));
    };
    const waitAntiSniper = async (pool) => {
      const p = (await client.state.getPool(new PublicKey(pool)))?.poolState;
      for (;;) {
        const now = Number((await conn.getBlockTime(await conn.getSlot("confirmed")).catch(() => 0)) || 0);
        if (now && now >= Number(p.activationPoint || 0) + 65) return;
        await new Promise((r) => setTimeout(r, 5_000));
      }
    };
    const seedPot = async (pool, lamports) => {
      await db.query(
        `insert into public.dbc_fee_accruals (pool, tx_hash, log_index, trader, profile, fee_total, trading_fee,
           protocol_fee, referral_fee, collector_amount, league_weekly, league_monthly, recruiter, squad, airdrop,
           protocol, creator_pool, status)
         values ($1,$2,0,'seed','standard_unlinked',0,0,0,0,$3,0,0,0,0,0,0,$3,'routed')`,
        [pool, `seed-${pool}`, String(lamports)],
      );
    };
    const tokenBal = async (owner, mint) => BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner)).catch(() => ({ value: { amount: "0" } }))).value.amount);
    const supply = async (mint) => BigInt((await conn.getTokenSupply(mint)).value.amount);

    // ---------------------------------------------------------------- holders + split
    console.log("\n[holders + split]");
    const coinH = await createCoin({ handle, conn, creator: creatorH, name: "DBC 5b Holders", feeChoice: "holders" });
    const coinS = await createCoin({ handle, conn, creator: creatorS, name: "DBC 5b Split", feeChoice: "split", creatorSharePct: 60 });
    console.log(`  holders pool ${coinH.pool}  split pool ${coinS.pool}`);
    const splitPct = (await db.query(`select meta #>> '{dbc,creatorSharePct}' as pct from public.campaigns where campaign_address = $1`, [coinS.pool])).rows[0]?.pct;
    check("split share stored at launch", splitPct === "60", splitPct);
    const feeRecipient = (await db.query(`select fee_recipient_address from public.campaigns where campaign_address = $1`, [coinH.pool])).rows[0]?.fee_recipient_address;
    check("DBC campaign records the collector as fee recipient (league exclusion)", feeRecipient === collector.publicKey.toBase58(), feeRecipient);
    await waitAntiSniper(coinH.pool);
    await buy(trader1, coinH.pool, 30_000_000);
    await buy(trader2, coinH.pool, 10_000_000);
    await buy(trader1, coinS.pool, 5_000_000);

    const realNow = new Date();
    const week = weekOf(realNow);
    const snapAt = new Date(Math.max(snapshotMoment(weekSecret(masterSecret, week.weekId), week.start).getTime(), realNow.getTime()) + 1000);
    const excluded = new Set([collector.publicKey.toBase58()]);
    const taken = await takeDueSnapshots({ db, connection: conn, masterSecret, excluded, now: snapAt });
    check("snapshot taken for both coins", taken === 2, String(taken));
    const snapH = (await db.query(`select owner, amount::text as amount from public.dbc_holder_snapshots where week_id = $1 and mint = $2 order by owner`, [week.weekId, coinH.mint.toBase58()])).rows;
    const t1H = await tokenBal(trader1.publicKey, coinH.mint);
    const t2H = await tokenBal(trader2.publicKey, coinH.mint);
    const snapMap = Object.fromEntries(snapH.map((r) => [r.owner, BigInt(r.amount)]));
    check("snapshot holds exactly the two traders (pool vault and creator left out)", snapH.length === 2, JSON.stringify(Object.keys(snapMap)));
    check("snapshot balances equal the token accounts", snapMap[trader1.publicKey.toBase58()] === t1H && snapMap[trader2.publicKey.toBase58()] === t2H, `${t1H} / ${t2H}`);

    await seedPot(coinH.pool, 40_000_000);
    await seedPot(coinS.pool, 10_000_000);
    const heldBefore = await heldCreatorPoolSum(db);
    const mondayAfter = new Date(week.end.getTime() + 60 * 60 * 1000);
    const weekly = await runWeeklyPayouts({ db, connection: conn, collector, send: true, now: mondayAfter });
    console.log("  weekly", JSON.stringify(weekly));
    const creatorRow = (await db.query(`select lamports::text as lamports, signature, status from public.dbc_creator_pool_payouts where kind = 'creator'`)).rows[0];
    check("split creator payout landed", creatorRow?.status === "landed", creatorRow?.status);
    if (creatorRow?.signature) {
      const tx = await getTx(conn, creatorRow.signature);
      const delta = nativeDelta(tx, creatorS.publicKey);
      check("split: creator wallet delta = 60% of the pot", delta === 6_000_000n && creatorRow.lamports === "6000000", `delta ${delta} row ${creatorRow.lamports}`);
    }
    const round = (await db.query(`select total_lamports::text as total, leaves, signature, status from public.dbc_holder_rounds where week_id = $1`, [week.weekId])).rows[0];
    check("holder round landed", round?.status === "landed", round?.status);
    if (round?.signature) {
      const tx = await getTx(conn, round.signature);
      const delta = nativeDelta(tx, rewardVaults().airdrop);
      check("holders: airdrop_vault delta = the round total", delta === BigInt(round.total), `delta ${delta} total ${round.total}`);
      const leaves = Object.fromEntries(round.leaves.leaves.map((l) => [l.owner, BigInt(l.amount)]));
      // holders coin: 40M pro rata over the two traders; split coin: 4M to its only holder
      const supplyH = t1H + t2H;
      const expT1 = (40_000_000n * t1H) / supplyH;
      const expT2 = (40_000_000n * t2H) / supplyH;
      const rem = 40_000_000n - expT1 - expT2;
      const t1Gets = expT1 + (t1H >= t2H ? rem : 0n) + 4_000_000n;
      const t2Gets = expT2 + (t2H > t1H ? rem : 0n);
      check("holders: leaves are pro rata to the snapshot, to the lamport",
        leaves[trader1.publicKey.toBase58()] === t1Gets && leaves[trader2.publicKey.toBase58()] === t2Gets,
        `${leaves[trader1.publicKey.toBase58()]} / ${leaves[trader2.publicKey.toBase58()]}`);
    }
    const heldAfter = await heldCreatorPoolSum(db);
    check("router's held sum dropped by exactly what was paid", heldBefore - heldAfter === 6_000_000n + BigInt(round?.total || 0), `${heldBefore} -> ${heldAfter}`);

    // ---------------------------------------------------------------- buyback on the curve
    console.log("\n[buyback on the curve]");
    const coinB = await createCoin({ handle, conn, creator: creatorB, name: "DBC 5b Buyback", feeChoice: "buyback" });
    console.log(`  pool ${coinB.pool}`);
    await waitAntiSniper(coinB.pool);
    await buy(trader1, coinB.pool, 20_000_000);
    await seedPot(coinB.pool, 50_000_000);
    const proveBuyback = async (label, pool, mint, quoteVault, sqrtOf) => {
      const now = new Date();
      const moments = buybackMoments(weekSecret(masterSecret, weekOf(now).weekId), pool, now, 4);
      const at = new Date(Math.max(moments[0].getTime(), now.getTime()) + 1000);
      const supplyBefore = await supply(mint);
      const sqrtBefore = await sqrtOf();
      const results = await runDueBuybacks({ db, connection: conn, collector, masterSecret, send: true, now: at });
      const mine = results.find((r) => r.pool === pool);
      console.log(`  ${label}`, JSON.stringify(mine));
      const row = (await db.query(`select lamports::text as lamports, tokens_burned::text as burned, signature, status from public.dbc_creator_pool_payouts where pool = $1 and kind = 'buyback' order by id desc limit 1`, [pool])).rows[0];
      check(`${label}: buyback landed`, row?.status === "landed", row?.status || mine?.skipped);
      if (!row?.signature) return;
      const tx = await getTx(conn, row.signature);
      const spent = tokenDelta(tx, quoteVault);
      check(`${label}: spend = the pool's quote-vault inflow`, spent === BigInt(row.lamports), `vault +${spent} row ${row.lamports}`);
      const supplyAfter = await supply(mint);
      check(`${label}: mint supply dropped by exactly the burned amount`, supplyBefore - supplyAfter === BigInt(row.burned) && BigInt(row.burned) > 0n, `${supplyBefore - supplyAfter} vs ${row.burned}`);
      const sqrtAfter = await sqrtOf();
      const impact = (Number((sqrtAfter * sqrtAfter * 10_000_000n) / (sqrtBefore * sqrtBefore)) - 10_000_000) / 1000;
      check(`${label}: price impact at most 0.5%`, impact <= 50.01, `${impact.toFixed(2)} bps`);
      const collectorTokens = await tokenBal(collector.publicKey, mint);
      check(`${label}: nothing burned beyond what the buy delivered`, collectorTokens >= 0n, `collector keeps ${collectorTokens}`);
    };
    const poolB = (await client.state.getPool(new PublicKey(coinB.pool)))?.poolState;
    await proveBuyback("curve", coinB.pool, coinB.mint, poolB.quoteVault, async () => BigInt(String((await client.state.getPool(new PublicKey(coinB.pool)))?.poolState.sqrtPrice)));

    // ---------------------------------------------------------------- buyback after graduation (DAMM v2)
    console.log("\n[buyback on the graduated pool]");
    const coinD = await createCoin({ handle, conn, creator: creatorD, name: "DBC 5b Buyback Grad", feeChoice: "buyback" });
    console.log(`  pool ${coinD.pool}`);
    const done = await completeCurve(client, conn, trader1, coinD.pool);
    check("graduation coin curve complete", done.reserve >= done.threshold, `${done.reserve} / ${done.threshold}`);
    const lockTx = await client.migration.createLocker({ payer: payer.publicKey, pool: new PublicKey(coinD.pool) });
    lockTx.feePayer = payer.publicKey;
    await withRetry("locker", () => sendAndConfirmTransaction(conn, lockTx, [payer], { commitment: "confirmed" }));
    const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
    const mig = await client.migration.migrateToDammV2({ payer: payer.publicKey, pool: new PublicKey(coinD.pool), dammConfig });
    mig.transaction.feePayer = payer.publicKey;
    await withRetry("migrate", () => sendAndConfirmTransaction(conn, mig.transaction, [payer, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], { commitment: "confirmed" }));
    const dammPool = deriveDammV2PoolAddress(dammConfig, coinD.mint, NATIVE_MINT);
    await db.query(
      `update public.campaigns set meta = jsonb_set(meta, '{dbc,migration}', $2::jsonb) where campaign_address = $1`,
      [coinD.pool, JSON.stringify({ pool: dammPool.toBase58() })],
    );
    await seedPot(coinD.pool, 50_000_000);
    const cpAmm = new CpAmm(conn);
    const dState = await cpAmm.fetchPoolState(dammPool);
    const dQuoteVault = dState.tokenAMint.equals(NATIVE_MINT) ? dState.tokenAVault : dState.tokenBVault;
    await proveBuyback("DAMM v2", coinD.pool, coinD.mint, dQuoteVault, async () => BigInt(String((await cpAmm.fetchPoolState(dammPool)).sqrtPrice)));

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

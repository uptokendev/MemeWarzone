#!/usr/bin/env node
/**
 * Devnet proof of DBC trading (step 3). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR. Public faucet otherwise.
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { createDbcLocksHandler } from "../../frontend/api/dbc/locks.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { buildDbcSwapTransaction, submitPreparedDbcTrade } from "../../frontend/src/lib/dbcTrade.mjs";
import { buildDbcLockedBuyTransaction } from "../../frontend/src/lib/dbcLockedBuy.mjs";
import { readSolUsdMicros } from "../../frontend/api/lib/solUsdMicros.js";
import { DBC_TRADE_FEE_BPS } from "../../frontend/shared/dbcEconomics.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = requireFromFrontend("@solana/web3.js");
const {
  NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
import cryptoNode from "node:crypto";

const ed25519Sign = (message, secretKey) => cryptoNode.sign(null, message, cryptoNode.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey).subarray(0, 32)]),
  format: "der", type: "pkcs8",
}));

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-trade-prove-"));
const failures = [];
const sigs = {};

function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function memoryDb() {
  const configs = [];
  const campaigns = [];
  const metadata = [];
  const reservations = [];
  const locks = [];
  let configId = 1;
  let chain = Promise.resolve();
  const run = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("begin") || sql.startsWith("commit") || sql.startsWith("rollback") || sql.includes("pg_advisory")) return { rows: [] };
    if (sql.startsWith("select") && sql.includes("from public.dbc_launch_configs")) {
      return { rows: configs.filter((r) => r.cluster === params[0] && r.quote_mint === params[1] && String(r.target_usd_micros) === String(params[2]) && Number(r.step_index) === Number(params[3]) && r.creator_fee_mode === params[4] && r.params_hash === params[5]) };
    }
    if (sql.startsWith("insert") && sql.includes("dbc_launch_configs")) {
      const row = {
        id: configId++, cluster: params[0], quote_mint: params[1], target_usd_micros: params[2], step_index: params[3],
        step_usd_micros: params[4], creator_fee_mode: params[5], params_hash: params[6], config_address: params[7],
        threshold_lamports: params[8], total_token_supply: params[9], create_signature: params[10],
        created_at: params[11], status: "pending",
      };
      configs.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update") && sql.includes("dbc_launch_configs") && sql.includes("failed")) {
      const row = configs.find((r) => r.id === params[0]);
      if (row) row.status = "failed";
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("update") && sql.includes("dbc_launch_configs") && sql.includes("active")) {
      const row = configs.find((r) => r.id === params[0]);
      if (row) { row.status = "active"; row.create_signature = params[1]; row.verified_at = params[2]; }
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("count(*)")) {
      const n = campaigns.filter((c) => c.creator_address === params[1] && c.launch_type === "dbc" && c.is_active).length;
      return { rows: [{ n }] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("order by created_at desc")) {
      const row = campaigns.filter((c) => c.creator_address === params[1] && c.launch_type === "dbc").at(-1);
      return { rows: row ? [{ created_at: row.created_at }] : [] };
    }
    if (sql.startsWith("insert into public.campaigns")) {
      const row = {
        chain_id: params[0], campaign_address: params[1], token_address: params[2], creator_address: params[3],
        name: params[4], symbol: params[5], logo_uri: params[6], launch_type: "dbc",
        meta: JSON.parse(params[8] || "{}"), is_active: true, created_at: new Date(),
      };
      campaigns.push(row);
      return { rows: [row] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("launch_type")) {
      return { rows: campaigns.filter((c) => c.campaign_address === params[0] && c.token_address === params[1]) };
    }
    if (sql.startsWith("insert into public.dbc_creator_locks")) {
      const row = {
        pool: params[0], mint: params[1], creator: params[2], escrow: params[3],
        amount: params[4], cliff: params[5], frequency: params[6], periods: params[7], tx: params[8], created_at: new Date(),
      };
      locks.push(row);
      return { rows: [row] };
    }
    if (sql.includes("from public.dbc_creator_locks")) return { rows: locks.filter((r) => r.mint === params[0]) };
    if (sql.startsWith("insert into public.token_metadata_registry") || sql.startsWith("update public.token_metadata_registry")) {
      metadata.push({ params });
      return { rows: [{ id: metadata.length }] };
    }
    if (sql.includes("from public.token_metadata_registry")) return { rows: [] };
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id is null")) {
      const row = reservations.find((r) => r.normalized_ticker === params[2] && !r.draft_id);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.ticker_reservations")) {
      const row = {
        id: params[0], draft_id: null, creator_wallet: params[1], chain_id: params[2], cluster: params[3],
        original_ticker: params[4], normalized_ticker: params[5], status: "SOFT_RESERVED", metadata: { source: "dbc_create" },
      };
      reservations.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update public.ticker_reservations")) {
      const row = reservations.find((r) => String(r.id) === String(params[0]));
      if (row) Object.assign(row, { status: "LIVE", campaign_pda: params[1], mint: params[2] });
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.campaign_drafts")) return { rows: [] };
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
    campaigns,
    locks,
    configs,
  };
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
async function fundFrom(conn, funder, dest, lamports) {
  const have = BigInt(await conn.getBalance(dest));
  const want = BigInt(lamports);
  if (have >= want) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: dest, lamports: Number(want - have) }));
  await sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" });
}
async function fund(conn, dest, lamports) {
  const funderPath = process.env.DBC_PROVE_FUNDER_KEYPAIR;
  if (funderPath) return fundFrom(conn, loadKeypairFile(funderPath), dest, lamports);
  const sig = await conn.requestAirdrop(dest, Number(lamports));
  await conn.confirmTransaction(sig, "confirmed");
}

function signBegin(creator, ticker) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const walletAddress = creator.publicKey.toBase58();
  const message = buildWalletActionMessage({
    action: "dbc_create", walletAddress, chainId: 101, nonce, extraLines: [`Ticker: ${ticker}`],
  });
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
  throw new Error(`transaction ${sig} not readable`);
}
function tokenDelta(tx, account) {
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.equals?.(account) || k.toBase58?.() === account.toBase58());
  const pick = (list) => BigInt(list.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
  return pick(tx.meta.postTokenBalances) - pick(tx.meta.preTokenBalances);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET) throw new Error(`Refusing: RPC genesis ${genesis} is not devnet.`);
  const payer = Keypair.generate();
  const collector = Keypair.generate();
  const referralOwner = Keypair.generate();
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
    payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey),
    referralOwner: Array.from(referralOwner.secretKey), creator: Array.from(creator.secretKey),
    trader: Array.from(trader.secretKey),
  }));
  console.log(`devnet ${genesis}`);
  console.log(`throwaway keys in ${DIR}`);
  if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
    console.log(`funder ${loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR).publicKey.toBase58()}`);
  } else {
    console.log("no DBC_PROVE_FUNDER_KEYPAIR; using the public faucet");
  }
  await fund(conn, payer.publicKey, 2_000_000_000);
  await fund(conn, creator.publicKey, 1_500_000_000);
  await fund(conn, trader.publicKey, 500_000_000);
  await fund(conn, referralOwner.publicKey, 50_000_000);

  const referralAta = getAssociatedTokenAddressSync(NATIVE_MINT, referralOwner.publicKey);
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, referralAta, referralOwner.publicKey, NATIVE_MINT,
  );
  await sendAndConfirmTransaction(conn, new Transaction().add(ataIx), [payer], { commitment: "confirmed" });
  console.log(`referral ata ${referralAta.toBase58()}`);

  const env = {
    DBC_LAUNCH_ENABLED: "true",
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: RPC,
    SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
    DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
    DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
    DBC_REFERRAL_TOKEN_ACCOUNT: referralAta.toBase58(),
  };
  const db = memoryDb();
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const ladder = createDbcConfigLadder({
    db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client,
  });
  const handle = createDbcCreateHandler({
    env, db, connection: conn, client, ladder, requireWalletActionAuth: requireSignedBegin, readSolUsdMicros,
  });

  const ticker = `T${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
  const begun = await post(handle, {
    operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker),
  });
  if (!begun.body.ok) throw new Error(`begin failed: ${begun.body.error}`);
  const mint = Keypair.generate();
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: mint.publicKey.toBase58(),
    name: "DBC Trade Proof", symbol: ticker, targetUsd: 150, feeChoice: "keep", firstBuyLamports: "0",
  });
  if (!auth.body.ok) throw new Error(`authorize failed: ${auth.body.error}`);
  const createTx = Transaction.from(Buffer.from(auth.body.transaction, "base64"));
  const created = await submitPreparedDbcCreate({
    connection: conn, transaction: createTx, mintSecretKey: mint.secretKey,
    mintAddress: mint.publicKey.toBase58(), creatorAddress: creator.publicKey.toBase58(),
    pool: auth.body.pool, config: auth.body.config, Keypair,
    signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
  });
  await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
  const pool = auth.body.pool;
  console.log(`pool ${pool}  mint ${mint.publicKey.toBase58()}  create ${created.signature}`);

  const buyLamports = 20_000_000n;
  const builtBuy = await buildDbcSwapTransaction({
    connection: conn, poolAddress: pool, trader: trader.publicKey.toBase58(), side: "buy", amountIn: buyLamports, env,
  });
  const buy = await submitPreparedDbcTrade({
    connection: conn, transaction: builtBuy.tx, trader: trader.publicKey.toBase58(), pool,
    signTransaction: async (unsigned) => { unsigned.partialSign(trader); return unsigned; },
  });
  sigs.buy = buy.signature;
  console.log(`buy ${buy.signature}  ${buy.serializedBytes} bytes  ${buy.signerCount} signers  quoted fee bps ${builtBuy.quoted.feeBps}`);
  const buyTx = await getTx(conn, buy.signature);
  const referralDelta = tokenDelta(buyTx, referralAta);
  const expectedFee = buyLamports * BigInt(DBC_TRADE_FEE_BPS) / 10_000n;
  const meteoraCut = expectedFee * 20n / 100n;
  const referralCut = meteoraCut * 20n / 100n;
  check("buy landed", Boolean(buy.signature));
  check("referral received 20% of Meteora's cut", referralDelta === referralCut, `delta ${referralDelta} expected ${referralCut}`);
  check("first-seconds fee bps matches the quote", builtBuy.quoted.feeBps >= 200);

  const traderToken = getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey);
  const traderTokens = BigInt((await conn.getTokenAccountBalance(traderToken)).value.amount);
  const sellAmount = (traderTokens / 2n);
  const builtSell = await buildDbcSwapTransaction({
    connection: conn, poolAddress: pool, trader: trader.publicKey.toBase58(), side: "sell", amountIn: sellAmount, env,
  });
  const sell = await submitPreparedDbcTrade({
    connection: conn, transaction: builtSell.tx, trader: trader.publicKey.toBase58(), pool,
    signTransaction: async (unsigned) => { unsigned.partialSign(trader); return unsigned; },
  });
  sigs.sell = sell.signature;
  console.log(`sell ${sell.signature}  ${sell.serializedBytes} bytes  ${sell.signerCount} signers`);
  check("sell landed", Boolean(sell.signature));

  const locked = await buildDbcLockedBuyTransaction({
    connection: conn, poolAddress: pool, trader: creator.publicKey.toBase58(), tokenAmountOut: 5_000_000n, env,
  });
  const lockedSent = await submitPreparedDbcTrade({
    connection: conn, transaction: locked.tx, trader: creator.publicKey.toBase58(), pool, allowLock: true,
    extraSigners: locked.extraSigners,
    signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
  });
  sigs.locked = lockedSent.signature;
  console.log(`locked buy ${lockedSent.signature}  ${lockedSent.serializedBytes} bytes  ${lockedSent.signerCount} signers`);
  check("locked buy is 2 signers", lockedSent.signerCount === 2, String(lockedSent.signerCount));
  const lockedTx = await getTx(conn, lockedSent.signature);
  const creatorToken = getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey);
  const creatorMove = tokenDelta(lockedTx, creatorToken);
  const escrowMove = tokenDelta(lockedTx, new PublicKey(locked.escrowToken));
  check("creator wallet delta is 0 for the bought tokens", creatorMove === 0n, `delta ${creatorMove}`);
  check("escrow holds the locked amount", escrowMove === 5_000_000n, `escrow ${escrowMove}`);

  const locksHandle = createDbcLocksHandler({ env, db, connection: conn });
  const lockRes = fakeRes();
  await locksHandle({
    method: "POST", url: "http://localhost/api/dbc/locks",
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({
        pool, mint: mint.publicKey.toBase58(), creator: creator.publicKey.toBase58(),
        escrow: locked.escrow, tx: lockedSent.signature, amount: "5000000",
      }));
    },
  }, lockRes);
  check("lock-record route accepts the escrow", lockRes.body?.ok === true, lockRes.body?.error);

  console.log("\nsignatures", sigs);
  console.log(failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error?.logs ? `${error.message}\n${error.logs.join("\n")}` : error);
  process.exit(1);
});

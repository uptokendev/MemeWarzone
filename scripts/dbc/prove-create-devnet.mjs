#!/usr/bin/env node
/**
 * Devnet proof of DBC create (step 2). Throwaway keys only (never a founder key).
 * Genesis EtWTRABZaYq6iMfeYk... is required.
 * Optional DBC_PROVE_FUNDER_KEYPAIR=<path to json keypair>.
 *
 * Builds and signs the create transaction the same way dbcCreateSubmit.ts does:
 * fresh blockhash, simulate, mint partialSign, creator sign, sendRaw, confirm
 * against that blockhash / lastValidBlockHeight.
 */
import { createRequire } from "node:module";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { DBC_DEVNET_TEST_TARGET_USD_MICROS, DBC_PROGRAM_ID, DBC_TRADE_FEE_BPS } from "../../frontend/shared/dbcEconomics.mjs";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { readSolUsdMicros } from "../../frontend/api/lib/solUsdMicros.js";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = requireFromFrontend("@solana/web3.js");
const nacl = requireFromFrontend("tweetnacl");
const { DynamicBondingCurveClient } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-create-prove-"));
const failures = [];
const sigs = {};

const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9);
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function memoryDb() {
  const configs = [];
  const campaigns = [];
  const metadata = [];
  const reservations = [];
  const drafts = [];
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
    if (sql.startsWith("insert into public.token_metadata_registry") || sql.startsWith("update public.token_metadata_registry")) {
      metadata.push({ params });
      return { rows: [{ id: metadata.length }] };
    }
    if (sql.includes("from public.token_metadata_registry")) return { rows: [] };
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id is null")) {
      const row = reservations.find((r) => r.normalized_ticker === params[2] && !r.draft_id);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id::text")) {
      const row = reservations.find((r) => String(r.draft_id) === String(params[0]));
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
    if (sql.includes("from public.campaign_drafts") && sql.includes("where id::text")) {
      return { rows: drafts.filter((d) => String(d.id) === String(params[0])) };
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
    campaigns,
    metadata,
    reservations,
    drafts,
    configs,
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.body = JSON.parse(text); },
  };
}

function jsonReq(body) {
  const payload = JSON.stringify(body);
  return {
    method: "POST",
    url: "http://localhost/api/dbc/create",
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

function signBegin(creator, ticker) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const walletAddress = creator.publicKey.toBase58();
  const message = buildWalletActionMessage({
    action: "dbc_create",
    walletAddress,
    chainId: 101,
    nonce,
    extraLines: [`Ticker: ${ticker}`],
  });
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(message, "utf8"), creator.secretKey)).toString("base64");
  return { action: "dbc_create", walletAddress, chainId: 101, nonce, message, signature, walletType: "solana" };
}

async function requireSignedBegin({ res, auth, expectedWallet, action, extraLines }) {
  const walletAddress = String(expectedWallet);
  const expected = buildWalletActionMessage({
    action,
    walletAddress,
    chainId: 101,
    nonce: auth?.nonce,
    extraLines,
  });
  if (String(auth?.message || "") !== expected) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "message mismatch", code: "SIGNATURE_REQUIRED" }));
    return null;
  }
  if (!verifySolanaSignature(auth.message, auth.signature, walletAddress)) {
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
  throw new Error(`transaction ${sig} not readable after 30 s`);
}

function nativeDelta(tx, pubkey) {
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.equals(pubkey) || k.toBase58?.() === pubkey.toBase58());
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET) throw new Error(`Refusing: RPC genesis ${genesis} is not devnet.`);

  const payer = Keypair.generate();
  const collector = Keypair.generate();
  const creatorA = Keypair.generate();
  const creatorB = Keypair.generate();
  const creatorC = Keypair.generate();
  fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
    payer: Array.from(payer.secretKey),
    collector: Array.from(collector.secretKey),
    creatorA: Array.from(creatorA.secretKey),
    creatorB: Array.from(creatorB.secretKey),
    creatorC: Array.from(creatorC.secretKey),
  }));
  console.log(`devnet ${genesis}`);
  console.log(`throwaway keys in ${DIR}`);
  console.log(`payer     ${payer.publicKey.toBase58()}`);
  console.log(`collector ${collector.publicKey.toBase58()}`);
  console.log(`creatorA  ${creatorA.publicKey.toBase58()}`);
  console.log(`creatorB  ${creatorB.publicKey.toBase58()}`);
  console.log(`creatorC  ${creatorC.publicKey.toBase58()}`);
  if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
    const funder = loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR);
    console.log(`funder    ${funder.publicKey.toBase58()}  ${sol(await conn.getBalance(funder.publicKey))} SOL`);
  } else {
    console.log("no DBC_PROVE_FUNDER_KEYPAIR; using the public faucet");
  }
  await fund(conn, payer.publicKey, 2_000_000_000);
  await fund(conn, creatorA.publicKey, 1_500_000_000);
  await fund(conn, creatorB.publicKey, 1_500_000_000);
  await fund(conn, creatorC.publicKey, 500_000_000);
  console.log(`payer balance ${sol(await conn.getBalance(payer.publicKey))} SOL`);

  const env = {
    DBC_LAUNCH_ENABLED: "true",
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: RPC,
    SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
    DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
    DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
  };
  const db = memoryDb();
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const ladder = createDbcConfigLadder({
    db,
    env,
    cluster: "devnet",
    connection: conn,
    payer,
    feeClaimer: collector.publicKey,
    client,
  });
  const handle = createDbcCreateHandler({
    env,
    db,
    connection: conn,
    client,
    ladder,
    requireWalletActionAuth: requireSignedBegin,
    readSolUsdMicros,
  });

  async function launch({ creator, ticker, name, firstBuyLamports }) {
    const begun = await post(handle, {
      operation: "begin",
      creatorWallet: creator.publicKey.toBase58(),
      ticker,
      auth: signBegin(creator, ticker),
    });
    if (!begun.body.ok) throw new Error(`begin failed: ${begun.body.error} [${begun.body.code}]`);
    const mint = Keypair.generate();
    const auth = await post(handle, {
      operation: "authorize",
      sessionToken: begun.body.sessionToken,
      mint: mint.publicKey.toBase58(),
      name,
      symbol: ticker,
      description: "dbc step-2 proof",
      targetUsd: 150,
      feeChoice: "keep",
      firstBuyLamports: String(firstBuyLamports),
    });
    if (!auth.body.ok) return { auth, mint };
    const tx = Transaction.from(Buffer.from(auth.body.transaction, "base64"));
    const compiled = tx.compileMessage();
    console.log(`  authorize ${ticker}: ${Buffer.from(auth.body.transaction, "base64").length} bytes, compiled signers ${compiled.header.numRequiredSignatures}`);
    const sent = await submitPreparedDbcCreate({
      connection: conn,
      transaction: tx,
      mintSecretKey: mint.secretKey,
      mintAddress: mint.publicKey.toBase58(),
      creatorAddress: creator.publicKey.toBase58(),
      pool: auth.body.pool,
      config: auth.body.config,
      Keypair,
      signTransaction: async (unsigned) => {
        unsigned.partialSign(creator);
        return unsigned;
      },
    });
    const fin = await post(handle, {
      operation: "finalize",
      finalizeToken: auth.body.finalizeToken,
      signature: sent.signature,
    });
    return { auth, mint, sent, fin };
  }

  console.log("\n[a] create without a first buy");
  const none = await launch({ creator: creatorA, ticker: "PROOFA", name: "Proof A", firstBuyLamports: 0 });
  check("create without first buy landed", Boolean(none.sent?.signature), none.sent?.signature);
  check("compiled 2 signers", none.sent?.signerCount === 2, String(none.sent?.signerCount));
  check("finalize registered the campaign", none.fin?.body?.ok === true && db.campaigns.some((c) => c.token_address === none.mint.publicKey.toBase58()));
  check("metadata row written", db.metadata.length >= 1);
  sigs.noBuy = none.sent?.signature;
  if (none.sent) console.log(`  bytes ${none.sent.serializedBytes}  blockhash ${none.sent.blockhash.slice(0, 8)}…  lastValid ${none.sent.lastValidBlockHeight}`);

  console.log("\n[b] create with a first buy under 10% (must pay 2%)");
  const buyLamports = 20_000_000n;
  const quoted = await post(handle, {
    operation: "quote-first-buy",
    targetUsd: 150,
    feeChoice: "keep",
    firstBuyLamports: buyLamports.toString(),
  });
  check("0.02 SOL first buy is under the 10% cap", quoted.body.ok === true && quoted.body.exceedsCap === false, `bps=${quoted.body.bps}`);
  const withBuy = await launch({ creator: creatorB, ticker: "PROOFB", name: "Proof B", firstBuyLamports: buyLamports });
  check("create with first buy landed", Boolean(withBuy.sent?.signature), withBuy.sent?.signature);
  check("compiled 2 signers (with first buy)", withBuy.sent?.signerCount === 2, String(withBuy.sent?.signerCount));
  sigs.withBuy = withBuy.sent?.signature;
  if (withBuy.sent) {
    const t = await getTx(conn, withBuy.sent.signature);
    const creatorDelta = nativeDelta(t, creatorB.publicKey);
    const expectedFee = buyLamports * BigInt(DBC_TRADE_FEE_BPS) / 10_000n;
    const poolInfo = await client.state.getPool(new PublicKey(withBuy.auth.body.pool));
    const state = poolInfo?.poolState ?? poolInfo;
    const quoteReserve = BigInt(state.quoteReserve?.toString?.() || state.quote_reserve || 0);
    const afterFee = buyLamports - expectedFee;
    check(
      "pool quote reserve is the first buy after the 2% min fee",
      quoteReserve >= afterFee - 10n && quoteReserve <= buyLamports,
      `reserve=${quoteReserve} afterFee=${afterFee} buy=${buyLamports}`,
    );
    console.log(`  bytes ${withBuy.sent.serializedBytes}  creator SOL delta ${creatorDelta}  reserve ${quoteReserve}  2% of buy ${expectedFee}`);
  }

  console.log("\n[c] first buy over 10% is refused");
  const over = await launch({ creator: creatorC, ticker: "PROOFC", name: "Proof C", firstBuyLamports: 50_000_000_000n });
  check("over-cap first buy refused", over.auth.body.code === "DBC_FIRST_BUY_CAP", over.auth.body.code);

  console.log("\n[finalize refuses a pool made with another config or creator]");
  const otherHandle = createDbcCreateHandler({
    env,
    db: memoryDb(),
    connection: conn,
    client,
    ladder,
    requireWalletActionAuth: requireSignedBegin,
    readSolUsdMicros,
    readPool: async () => ({
      config: collector.publicKey,
      creator: collector.publicKey,
      poolCreator: collector.publicKey,
      baseMint: collector.publicKey,
    }),
    poolOwner: async () => DBC_PROGRAM_ID,
  });
  const mismatchBegin = await post(otherHandle, {
    operation: "begin",
    creatorWallet: creatorC.publicKey.toBase58(),
    ticker: "PROOFD",
    auth: signBegin(creatorC, "PROOFD"),
  });
  const mismatchMint = Keypair.generate();
  const mismatchAuth = await post(otherHandle, {
    operation: "authorize",
    sessionToken: mismatchBegin.body.sessionToken,
    mint: mismatchMint.publicKey.toBase58(),
    name: "Proof D",
    symbol: "PROOFD",
    targetUsd: 150,
    feeChoice: "keep",
    firstBuyLamports: "0",
  });
  const mismatchFin = await post(otherHandle, {
    operation: "finalize",
    finalizeToken: mismatchAuth.body.finalizeToken,
    signature: "nope",
  });
  check("finalize refuses a different config", mismatchFin.body.code === "DBC_POOL_CONFIG", mismatchFin.body.code);

  console.log("\n[scheduled draft is refused before its time]");
  db.drafts.push({
    id: "draft-lock",
    creator_wallet: creatorC.publicKey.toBase58(),
    ticker: "LOCKME",
    name: "Lock",
    launch_type: "dbc",
    status: "scheduled",
    scheduled_launch_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  db.reservations.push({
    id: "res-lock",
    draft_id: "draft-lock",
    creator_wallet: creatorC.publicKey.toBase58(),
    normalized_ticker: "LOCKME",
    chain_id: 101,
    cluster: "devnet",
    status: "SOFT_RESERVED",
    metadata: { source: "dbc_create" },
  });
  const locked = await post(handle, {
    operation: "begin",
    creatorWallet: creatorC.publicKey.toBase58(),
    ticker: "LOCKME",
    draftId: "draft-lock",
    auth: signBegin(creatorC, "LOCKME"),
  });
  check("scheduled draft refused before the time", locked.body.code === "DBC_SCHEDULED_LOCKED", locked.body.code);

  console.log("\nsignatures", sigs);
  if (failures.length) {
    console.error(`FAILED ${failures.length}: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

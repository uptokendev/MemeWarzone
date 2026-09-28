#!/usr/bin/env node
/**
 * Devnet proof of DBC indexer (step 4). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR.
 *
 * Creates a $150 coin through step 2's handler, does two buys and a sell from
 * another wallet, runs one dbcIndexer pass against an in-memory DB, and prints
 * the rows next to the transactions' own balance changes.
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
import { readSolUsdMicros } from "../../frontend/api/lib/solUsdMicros.js";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = requireFromFrontend("@solana/web3.js");
const { NATIVE_MINT, getAssociatedTokenAddressSync } = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient, SwapMode } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const BN = requireFromFrontend("bn.js");
import cryptoNode from "node:crypto";

const ed25519Sign = (message, secretKey) => cryptoNode.sign(null, message, cryptoNode.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey).subarray(0, 32)]),
  format: "der", type: "pkcs8",
}));

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-indexer-prove-"));
const failures = [];

function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function memoryDb() {
  const configs = [];
  const campaigns = [];
  const reservations = [];
  const trades = [];
  const activity = [];
  const candles = [];
  const stats = [];
  const state = [];
  let configId = 1;
  let chain = Promise.resolve();
  const run = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("begin") || sql.startsWith("commit") || sql.startsWith("rollback") || sql.includes("pg_advisory")) return { rows: [] };
    if (sql.startsWith("select") && sql.includes("from public.dbc_launch_configs")) {
      return { rows: configs.filter((r) => r.cluster === params[0] && r.quote_mint === params[1] && String(r.target_usd_micros) === String(params[2]) && Number(r.step_index) === Number(params[3]) && r.creator_fee_mode === params[4] && r.params_hash === params[5]) };
    }
    if (sql.startsWith("insert") && sql.includes("dbc_launch_configs")) {
      const row = { id: configId++, cluster: params[0], quote_mint: params[1], target_usd_micros: params[2], step_index: params[3], step_usd_micros: params[4], creator_fee_mode: params[5], params_hash: params[6], config_address: params[7], threshold_lamports: params[8], total_token_supply: params[9], create_signature: params[10], created_at: params[11], status: "pending" };
      configs.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update") && sql.includes("dbc_launch_configs") && sql.includes("failed")) {
      const row = configs.find((r) => r.id === params[0]); if (row) row.status = "failed"; return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("update") && sql.includes("dbc_launch_configs") && sql.includes("active")) {
      const row = configs.find((r) => r.id === params[0]); if (row) { row.status = "active"; row.create_signature = params[1]; } return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("count(*)")) return { rows: [{ n: campaigns.filter((c) => c.creator_address === params[1] && c.is_active).length }] };
    if (sql.includes("from public.campaigns") && sql.includes("order by created_at desc") && sql.includes("creator_address")) {
      const row = campaigns.filter((c) => c.creator_address === params[1]).at(-1);
      return { rows: row ? [{ created_at: row.created_at }] : [] };
    }
    if (sql.startsWith("insert into public.campaigns")) {
      const row = { chain_id: params[0], campaign_address: params[1], token_address: params[2], creator_address: params[3], name: params[4], symbol: params[5], logo_uri: params[6], launch_type: "dbc", meta: JSON.parse(params[8] || "{}"), is_active: true, created_at: new Date() };
      campaigns.push(row);
      return { rows: [row] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("launch_type")) {
      return { rows: campaigns.map((c) => ({ campaign_address: c.campaign_address, token_address: c.token_address, creator_address: c.creator_address, graduated_pool: "", dbc_migrated_pool: "" })) };
    }
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id is null")) {
      const row = reservations.find((r) => r.normalized_ticker === params[2]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.ticker_reservations")) {
      const row = { id: params[0], creator_wallet: params[1], chain_id: params[2], cluster: params[3], original_ticker: params[4], normalized_ticker: params[5], status: "SOFT_RESERVED", metadata: { source: "dbc_create" } };
      reservations.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update public.ticker_reservations")) {
      const row = reservations.find((r) => String(r.id) === String(params[0]));
      if (row) Object.assign(row, { status: "LIVE" });
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.token_metadata_registry")) return { rows: [] };
    if (sql.startsWith("insert into public.token_metadata_registry") || sql.startsWith("update public.token_metadata_registry")) return { rows: [{ id: 1 }] };
    if (sql.includes("from public.campaign_drafts")) return { rows: [] };
    if (sql.includes("from public.indexer_state")) {
      const row = state.find((s) => s.cursor === params[1]);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.indexer_state")) {
      const existing = state.find((s) => s.cursor === params[1]);
      if (existing) existing.last_indexed_block = Math.max(existing.last_indexed_block, Number(params[2]));
      else state.push({ chain_id: params[0], cursor: params[1], last_indexed_block: Number(params[2]) });
      return { rows: [] };
    }
    if (sql.startsWith("insert into public.curve_trades")) {
      const row = {
        chain_id: params[0], campaign_address: params[1], tx_hash: params[2], log_index: params[3],
        block_number: params[4], block_time: params[5], side: params[6], wallet: params[7],
        token_amount_raw: params[8], bnb_amount_raw: params[9], token_amount: params[10],
        bnb_amount: params[11], price_bnb: params[12], venue: params[13],
      };
      if (trades.some((t) => t.tx_hash === row.tx_hash && t.log_index === row.log_index)) return { rowCount: 0, rows: [] };
      trades.push(row);
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes("from public.curve_trades") && sql.includes("order by block_number desc")) {
      const latest = trades.filter((t) => t.campaign_address === params[1]).at(-1);
      return { rows: latest ? [latest] : [] };
    }
    if (sql.includes("from public.curve_trades") && sql.includes("sum")) {
      const vol = trades.filter((t) => t.campaign_address === params[1]).reduce((s, t) => s + Number(t.bnb_amount || 0), 0);
      return { rows: [{ vol24h: vol }] };
    }
    if (sql.startsWith("insert into public.activity_events")) { activity.push(params); return { rows: [] }; }
    if (sql.startsWith("insert into public.token_candles")) { candles.push(params); return { rows: [{ o: params[4], h: params[4], l: params[4], c: params[4], volume_bnb: params[5], trades_count: 1 }] }; }
    if (sql.startsWith("insert into public.token_stats")) { stats.push(params); return { rows: [] }; }
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
    trades,
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
async function fund(conn, dest, lamports) {
  const funderPath = process.env.DBC_PROVE_FUNDER_KEYPAIR;
  if (funderPath) {
    const funder = loadKeypairFile(funderPath);
    const have = BigInt(await conn.getBalance(dest));
    const want = BigInt(lamports);
    if (have >= want) return;
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
      fromPubkey: funder.publicKey, toPubkey: dest, lamports: Number(want - have),
    })), [funder], { commitment: "confirmed" });
    return;
  }
  const sig = await conn.requestAirdrop(dest, Number(lamports));
  await conn.confirmTransaction(sig, "confirmed");
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
function nativeDelta(tx, pubkey) {
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.equals?.(pubkey) || k.toBase58?.() === pubkey.toBase58());
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}
function tokenDelta(tx, account) {
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.equals?.(account) || k.toBase58?.() === account.toBase58());
  const pick = (list) => BigInt(list.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
  return pick(tx.meta.postTokenBalances) - pick(tx.meta.preTokenBalances);
}

async function swapExactIn(client, conn, owner, pool, amountIn, sell) {
  const tx = await client.pool.swap2({
    owner: owner.publicKey,
    pool: new PublicKey(pool),
    swapBaseForQuote: Boolean(sell),
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(1),
  });
  tx.feePayer = owner.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, [owner], { commitment: "confirmed" });
  return sig;
}

async function main() {
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.ABLY_API_KEY ||= "test:key";
  process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
  const { indexDbcPool } = await import("../../realtime-indexer/src/dbcIndexer.ts");
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);
  const payer = Keypair.generate();
  const collector = Keypair.generate();
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
    payer: Array.from(payer.secretKey), creator: Array.from(creator.secretKey), trader: Array.from(trader.secretKey),
  }));
  console.log(`devnet ${genesis}\nthrowaway keys in ${DIR}`);
  if (!process.env.DBC_PROVE_FUNDER_KEYPAIR) console.log("no DBC_PROVE_FUNDER_KEYPAIR; using the public faucet");
  await fund(conn, payer.publicKey, 2_000_000_000);
  await fund(conn, creator.publicKey, 1_200_000_000);
  await fund(conn, trader.publicKey, 400_000_000);

  const env = {
    DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
    SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
    DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
    DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
  };
  const db = memoryDb();
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const ladder = createDbcConfigLadder({ db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client });
  const handle = createDbcCreateHandler({ env, db, connection: conn, client, ladder, requireWalletActionAuth: requireSignedBegin, readSolUsdMicros });
  const ticker = `I${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
  const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
  if (!begun.body.ok) throw new Error(`begin failed ${begun.body.error}`);
  const mint = Keypair.generate();
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: mint.publicKey.toBase58(),
    name: "DBC Indexer Proof", symbol: ticker, targetUsd: 150, feeChoice: "keep", firstBuyLamports: "0",
  });
  if (!auth.body.ok) throw new Error(`authorize failed ${auth.body.error}`);
  const created = await submitPreparedDbcCreate({
    connection: conn, transaction: Transaction.from(Buffer.from(auth.body.transaction, "base64")),
    mintSecretKey: mint.secretKey, mintAddress: mint.publicKey.toBase58(),
    creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
    signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
  });
  await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
  const poolAddr = auth.body.pool;
  console.log(`pool ${poolAddr} mint ${mint.publicKey.toBase58()}`);

  const buy1 = 20_000_000n;
  const buy2 = 15_000_000n;
  const sigBuy1 = await swapExactIn(client, conn, trader, poolAddr, buy1, false);
  const sigBuy2 = await swapExactIn(client, conn, trader, poolAddr, buy2, false);
  const traderToken = getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey);
  const tokens = BigInt((await conn.getTokenAccountBalance(traderToken)).value.amount);
  const sellAmt = tokens / 4n;
  const sigSell = await swapExactIn(client, conn, trader, poolAddr, sellAmt, true);
  console.log(`buy1 ${sigBuy1}\nbuy2 ${sigBuy2}\nsell ${sigSell}`);

  const result = await indexDbcPool(db, {
    campaign: poolAddr, token: mint.publicKey.toBase58(), creator: creator.publicKey.toBase58(), migrated: false,
  });
  console.log("indexer pass", result);
  const rows = db.trades;
  console.log("rows", rows.map((r) => ({ side: r.side, sol: r.bnb_amount_raw, tokens: r.token_amount_raw, wallet: r.wallet, tx: r.tx_hash, venue: r.venue, log: r.log_index })));

  // Every indexed number must equal what moved on chain in that transaction. No referral on these
  // swaps, so the whole SOL leg (fee included) moves through the pool's quote vault.
  const poolState = (await client.state.getPool(new PublicKey(poolAddr)))?.poolState;
  const pState = poolState;
  const quoteVault = pState.quoteVault;
  const baseVault = pState.baseVault;
  for (const [label, sig, side] of [["buy1", sigBuy1, "buy"], ["buy2", sigBuy2, "buy"], ["sell", sigSell, "sell"]]) {
    const tx = await getTx(conn, sig);
    const row = rows.find((r) => r.tx_hash === sig);
    check(`${label} indexed`, Boolean(row), row?.bnb_amount_raw);
    if (!row) continue;
    check(`${label} venue is dbc`, row.venue === "dbc");
    check(`${label} log_index < 20000`, Number(row.log_index) < 20_000);
    check(`${label} side`, row.side === side, row.side);
    check(`${label} wallet is the trader`, row.wallet === trader.publicKey.toBase58(), row.wallet);
    const sol = BigInt(row.bnb_amount_raw);
    const tok = BigInt(row.token_amount_raw);
    const qv = tokenDelta(tx, quoteVault);
    const bv = tokenDelta(tx, baseVault);
    const tt = tokenDelta(tx, traderToken);
    if (side === "buy") {
      check(`${label} SOL in (fee incl.) = quote vault in`, sol === qv, `indexed ${sol} vault ${qv}`);
      check(`${label} tokens = base vault out`, tok === -bv, `indexed ${tok} vault ${bv}`);
      check(`${label} tokens = trader received`, tok === tt, `indexed ${tok} trader ${tt}`);
    } else {
      check(`${label} SOL out (after fee) = quote vault out`, sol === -qv, `indexed ${sol} vault ${qv}`);
      check(`${label} tokens = base vault in`, tok === bv, `indexed ${tok} vault ${bv}`);
      check(`${label} tokens = trader sent`, tok === -tt, `indexed ${tok} trader ${tt}`);
    }
  }
  check("two buys and a sell were written", rows.filter((r) => r.side === "buy").length >= 2 && rows.some((r) => r.side === "sell"));
  console.log(failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

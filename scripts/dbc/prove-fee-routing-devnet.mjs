#!/usr/bin/env node
/**
 * Devnet proof of DBC fee routing (step 5). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR.
 *
 * Creates a $150 coin, trades from a linked / OG / unlinked wallet, indexes,
 * accrues, claims and routes. Vault balance changes in the routing transaction
 * must equal the slices to the lamport. Fees come from EvtSwap2, never a fixed 2%.
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
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-fee-prove-"));
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
  const accruals = [];
  const rewards = [];
  const epochs = [];
  const recruiters = [];
  const links = [];
  const state = [];
  let configId = 1;
  let epochId = 1;
  let recruiterId = 1;
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
      const row = configs.find((r) => r.id === params[0]); if (row) row.status = "active"; return { rows: row ? [row] : [] };
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
      return { rows: campaigns.map((c) => ({ campaign_address: c.campaign_address, token_address: c.token_address, creator_address: c.creator_address, graduated_pool: "", dbc_migrated_pool: "", meta: c.meta })) };
    }
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id is null")) {
      const row = reservations.find((r) => r.normalized_ticker === params[2]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.ticker_reservations")) {
      const row = { id: params[0], creator_wallet: params[1], chain_id: params[2], cluster: params[3], original_ticker: params[4], normalized_ticker: params[5], status: "SOFT_RESERVED" };
      reservations.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update public.ticker_reservations")) {
      const row = reservations.find((r) => String(r.id) === String(params[0]));
      if (row) row.status = "LIVE";
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
    if (sql.includes("from public.curve_trades") && sql.includes("left join public.activity_events")) {
      const out = trades.filter((t) => t.venue === "dbc" && !accruals.some((a) => a.tx_hash === t.tx_hash && a.log_index === t.log_index)).map((t) => ({
        ...t,
        activity_meta: activity.find((a) => a.tx_hash === t.tx_hash && a.log_index === t.log_index)?.meta || null,
        campaign_meta: campaigns.find((c) => c.campaign_address === t.campaign_address)?.meta || {},
      }));
      return { rows: out.slice(0, Number(params[1] || 500)) };
    }
    if (sql.includes("from public.curve_trades") && sql.includes("order by block_number desc")) {
      const latest = trades.filter((t) => t.campaign_address === params[1]).at(-1);
      return { rows: latest ? [latest] : [] };
    }
    if (sql.includes("from public.curve_trades") && sql.includes("sum")) {
      return { rows: [{ vol24h: 0 }] };
    }
    if (sql.startsWith("insert into public.activity_events")) {
      activity.push({ tx_hash: params[2], log_index: params[3], meta: JSON.parse(params[13] || "{}") });
      return { rows: [] };
    }
    if (sql.startsWith("insert into public.token_candles")) return { rows: [{ o: params[4], h: params[4], l: params[4], c: params[4], volume_bnb: params[5], trades_count: 1 }] };
    if (sql.startsWith("insert into public.token_stats")) return { rows: [] };
    if (sql.startsWith("insert into public.epochs")) {
      const row = {
        id: epochId++,
        chain_id: params[0],
        epoch_type: "weekly",
        start_at: params[1],
        end_at: params[2],
        status: params[3],
        created_at: new Date(),
        finalized_at: null,
      };
      epochs.push(row);
      return { rows: [row] };
    }
    if (sql.includes("from public.wallet_recruiter_links")) {
      const wallet = params[0];
      const at = params[1] instanceof Date ? params[1] : new Date(params[1]);
      const match = links
        .filter((l) => l.wallet_address === wallet)
        .sort((a, b) => {
          const aActive = a.is_active && a.linked_at <= at && (a.detached_at == null || a.detached_at > at) ? 1 : 0;
          const bActive = b.is_active && b.linked_at <= at && (b.detached_at == null || b.detached_at > at) ? 1 : 0;
          return bActive - aActive || b.linked_at - a.linked_at;
        })[0];
      if (!match) return { rows: [] };
      const rec = recruiters.find((r) => r.id === match.recruiter_id);
      return { rows: rec ? [{ is_og: rec.is_og }] : [] };
    }
    if (sql.startsWith("insert into public.dbc_fee_accruals")) {
      const row = {
        pool: params[0], tx_hash: params[1], log_index: params[2], trader: params[3], profile: params[4],
        fee_total: params[5], trading_fee: params[6], protocol_fee: params[7], referral_fee: params[8],
        collector_amount: params[9], league_weekly: params[10], league_monthly: params[11],
        recruiter: params[12], squad: params[13], airdrop: params[14], protocol: params[15],
        creator_pool: params[16], status: "accrued",
      };
      if (accruals.some((a) => a.tx_hash === row.tx_hash && a.log_index === row.log_index)) return { rows: [] };
      accruals.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("insert into public.reward_events")) {
      rewards.push({ tx_hash: params[1], log_index: params[2], profile: params[9], raw: params[15] });
      return { rows: [] };
    }
    if (sql.includes("from public.dbc_fee_accruals") && sql.includes("sum(collector_amount)") && sql.includes("group by pool")) {
      const min = BigInt(String(params[0] || "0"));
      const byPool = new Map();
      for (const row of accruals.filter((a) => a.status === "accrued")) {
        byPool.set(row.pool, (byPool.get(row.pool) || 0n) + BigInt(row.collector_amount));
      }
      return { rows: [...byPool.entries()].filter(([, v]) => v >= min).map(([pool, expected]) => ({ pool, expected: expected.toString() })) };
    }
    if (sql.includes("from public.dbc_fee_accruals") && sql.includes("sum(collector_amount)")) {
      const pool = params[0];
      const expected = accruals.filter((a) => a.pool === pool && a.status === "accrued").reduce((s, a) => s + BigInt(a.collector_amount), 0n);
      return { rows: [{ expected: expected.toString() }] };
    }
    if (sql.includes("from public.dbc_fee_accruals") && sql.includes("status = 'blocked'")) {
      return { rows: accruals.filter((a) => a.status === "blocked"), rowCount: accruals.filter((a) => a.status === "blocked").length };
    }
    if (sql.includes("from public.dbc_fee_accruals") && sql.includes("status = 'claimed'")) {
      return { rows: accruals.filter((a) => a.status === "claimed") };
    }
    if (sql.startsWith("update public.dbc_fee_accruals") && sql.includes("'blocked'")) {
      for (const row of accruals.filter((a) => a.pool === params[0] && a.status === "accrued")) {
        row.status = "blocked"; row.claim_signature = params[1];
      }
      return { rows: [] };
    }
    if (sql.startsWith("update public.dbc_fee_accruals") && sql.includes("'routed'")) {
      for (const row of accruals.filter((a) => a.status === "claimed")) {
        row.status = "routed"; row.route_signature = params[0];
      }
      return { rows: [] };
    }
    if (sql.startsWith("update public.dbc_fee_accruals") && sql.includes("'claimed'")) {
      for (const row of accruals.filter((a) => a.pool === params[0] && a.status === "accrued")) {
        row.status = "claimed"; row.claim_signature = params[1];
      }
      return { rows: [] };
    }
    if (sql.startsWith("insert into public.recruiters")) {
      const row = { id: recruiterId++, is_og: params[0], wallet_address: params[1] };
      recruiters.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("insert into public.wallet_recruiter_links")) {
      links.push({ wallet_address: params[0], recruiter_id: params[1], is_active: true, linked_at: params[2], detached_at: null });
      return { rows: [] };
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
    campaigns, trades, activity, accruals, rewards, recruiters, links,
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
function nativeDelta(tx, pubkey) {
  const want = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  const message = tx.transaction.message;
  const keys = (typeof message.getAccountKeys === "function"
    ? message.getAccountKeys().staticAccountKeys
    : null) || message.staticAccountKeys || message.accountKeys || [];
  const keyStr = (entry) => (typeof entry === "string" ? entry : String(entry?.pubkey || entry?.toBase58?.() || ""));
  const i = keys.findIndex((k) => keyStr(k) === want);
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}
async function swapExactIn(client, conn, owner, pool, amountIn) {
  const tx = await client.pool.swap2({
    owner: owner.publicKey, pool: new PublicKey(pool), swapBaseForQuote: false,
    referralTokenAccount: null, swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(1),
  });
  tx.feePayer = owner.publicKey;
  let sig = null;
  for (let i = 0; i < 8; i += 1) {
    try {
      sig = await conn.sendTransaction(tx, [owner], { skipPreflight: false });
      break;
    } catch (error) {
      if (error?.signature) { sig = error.signature; break; }
      const msg = String(error?.message || error);
      if (!/429|Too Many Requests|fetch failed|timed out/i.test(msg)) throw error;
      const wait = Math.min(12_000, 750 * 2 ** i);
      console.log(`  retry swap-send in ${wait}ms (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (!sig) throw new Error("swap send failed");
  await getTx(conn, sig);
  return sig;
}

async function main() {
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.ABLY_API_KEY ||= "test:key";
  process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
  const { indexDbcPool, decodeEvtSwap2FromTransaction, swapPayerFromTransaction } = await import("../../realtime-indexer/src/dbcIndexer.ts");
  const { accrueDbcFees } = await import("../../realtime-indexer/src/dbc/dbcFeeAccruals.ts");
  const { claimPoolPartnerFees, quoteVaultOutflow } = await import("../../realtime-indexer/src/dbc/dbcFeeClaimer.ts");
  const { routeClaimedAccruals, rewardVaults, nativeDelta: routeDelta } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
  const { splitDbcCollectorFee } = await import("../../realtime-indexer/src/dbc/dbcFeeSplit.ts");

  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);
  const payer = Keypair.generate();
  const collector = Keypair.generate();
  const creator = Keypair.generate();
  const linked = Keypair.generate();
  const og = Keypair.generate();
  const unlinked = Keypair.generate();
  fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
    payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey),
    creator: Array.from(creator.secretKey), linked: Array.from(linked.secretKey),
    og: Array.from(og.secretKey), unlinked: Array.from(unlinked.secretKey),
  }));
  console.log(`devnet ${genesis}\nthrowaway keys in ${DIR}`);
  if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
    console.log(`funder ${loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR).publicKey.toBase58()}`);
  } else {
    console.log("no DBC_PROVE_FUNDER_KEYPAIR; using the public faucet");
  }
  await fund(conn, payer.publicKey, 120_000_000);
  await fund(conn, creator.publicKey, 180_000_000);
  await fund(conn, collector.publicKey, 40_000_000);
  await fund(conn, linked.publicKey, 35_000_000);
  await fund(conn, og.publicKey, 35_000_000);
  await fund(conn, unlinked.publicKey, 35_000_000);

  const env = {
    DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
    SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
    DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
    DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
  };
  const db = memoryDb();
  const now = new Date();
  await db.query("insert into public.recruiters", [false, "linked-rec"]);
  await db.query("insert into public.recruiters", [true, "og-rec"]);
  await db.query("insert into public.wallet_recruiter_links", [linked.publicKey.toBase58(), db.recruiters[0].id, now]);
  await db.query("insert into public.wallet_recruiter_links", [og.publicKey.toBase58(), db.recruiters[1].id, now]);

  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const ladder = createDbcConfigLadder({ db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client });
  const handle = createDbcCreateHandler({ env, db, connection: conn, client, ladder, requireWalletActionAuth: requireSignedBegin, readSolUsdMicros });
  const ticker = `F${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
  const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
  if (!begun.body.ok) throw new Error(`begin failed ${begun.body.error}`);
  const mint = Keypair.generate();
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: mint.publicKey.toBase58(),
    name: "DBC Fee Proof", symbol: ticker, targetUsd: 150, feeChoice: "keep", firstBuyLamports: "0",
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
  console.log(`pool ${poolAddr} mint ${mint.publicKey.toBase58()} create ${created.signature}`);

  const buyLamports = 20_000_000n;
  const sigLinked = await swapExactIn(client, conn, linked, poolAddr, buyLamports);
  const sigOg = await swapExactIn(client, conn, og, poolAddr, buyLamports);
  const sigUnlinked = await swapExactIn(client, conn, unlinked, poolAddr, buyLamports);
  console.log(`linked ${sigLinked}\nog ${sigOg}\nunlinked ${sigUnlinked}`);

  const indexed = await indexDbcPool(db, {
    campaign: poolAddr, token: mint.publicKey.toBase58(), creator: creator.publicKey.toBase58(), migrated: false,
  });
  console.log("indexer", indexed);
  check("indexer wrote three trades", db.trades.length === 3, String(db.trades.length));

  for (const [label, sig, wallet, profile] of [
    ["linked", sigLinked, linked.publicKey.toBase58(), "standard_linked"],
    ["og", sigOg, og.publicKey.toBase58(), "og_linked"],
    ["unlinked", sigUnlinked, unlinked.publicKey.toBase58(), "standard_unlinked"],
  ]) {
    const tx = await getTx(conn, sig);
    const events = decodeEvtSwap2FromTransaction(tx);
    check(`${label} EvtSwap2 present`, events.length === 1, String(events.length));
    const payer = swapPayerFromTransaction(tx);
    check(`${label} swap payer is the trader`, payer === wallet, payer);
    const event = events[0];
    const F = event.tradingFee + event.protocolFee + event.referralFee;
    console.log(`  ${label} F=${F.toString()} trading=${event.tradingFee.toString()} protocol=${event.protocolFee.toString()} referral=${event.referralFee.toString()}`);
    check(`${label} F is the EvtSwap2 sum, not a hardcoded 2% of 20M`, F === event.tradingFee + event.protocolFee + event.referralFee && F !== 400_000n);
    check(`${label} trading fee is 80% of F from the event`, event.tradingFee === (F * 80n) / 100n);
  }

  const accrued = await accrueDbcFees(db);
  console.log("accrued", accrued);
  check("three accruals", db.accruals.length === 3, String(db.accruals.length));
  check("linked profile", db.accruals.find((a) => a.trader === linked.publicKey.toBase58())?.profile === "standard_linked");
  check("OG profile", db.accruals.find((a) => a.trader === og.publicKey.toBase58())?.profile === "og_linked");
  check("unlinked profile", db.accruals.find((a) => a.trader === unlinked.publicKey.toBase58())?.profile === "standard_unlinked");
  for (const row of db.accruals) {
    const meta = db.activity.find((a) => a.tx_hash === row.tx_hash && a.log_index === row.log_index)?.meta || {};
    const expected = splitDbcCollectorFee({
      tradingFee: BigInt(String(meta.trading_fee || "0")),
      protocolFee: BigInt(String(meta.protocol_fee || "0")),
      referralFee: BigInt(String(meta.referral_fee || "0")),
      mode: "creator",
      profile: row.profile,
    });
    check(
      `${row.profile} collector_amount matches split of EvtSwap2`,
      BigInt(row.collector_amount) === expected.collectorAmount
        && BigInt(row.league_weekly) === expected.leagueWeekly
        && BigInt(row.recruiter) === expected.recruiter
        && BigInt(row.airdrop) === expected.airdrop
        && BigInt(row.protocol) === expected.protocol,
      `got collector ${row.collector_amount} expected ${expected.collectorAmount.toString()}`,
    );
  }

  const wrap = await client.state.getPool(new PublicKey(poolAddr));
  const state = wrap?.poolState ?? wrap;
  const quoteVault = state.quoteVault.toBase58();
  const owed = BigInt(state.partnerQuoteFee.toString());
  const expectedCollector = db.accruals.reduce((s, a) => s + BigInt(a.collector_amount), 0n);
  check("partner fee counter equals sum of collector amounts", owed === expectedCollector, `owed ${owed} expected ${expectedCollector}`);

  const claimed = await claimPoolPartnerFees({
    db, connection: conn, collector, pool: poolAddr, send: true, minLamports: 1n, client,
  });
  console.log("claim", { ...claimed, claimed: claimed.claimed.toString(), counterDrop: claimed.counterDrop.toString(), expected: claimed.expected.toString() });
  check("claim not blocked", claimed.blocked === false, claimed.reason);
  check("claimed equals quote vault outflow and expected collector", claimed.claimed === claimed.expected && claimed.claimed === claimed.counterDrop, `claimed ${claimed.claimed} expected ${claimed.expected} counter ${claimed.counterDrop}`);

  const vaults = rewardVaults();
  const routed = await routeClaimedAccruals({ db, connection: conn, collector, send: true });
  console.log("route", routed.signature, routed.destinations.map((d) => `${d.seed} ${d.lamports.toString()}`).join(", "));
  check("route sent", Boolean(routed.signature), routed.skipped);
  const routeTx = await getTx(conn, routed.signature);
  for (const dest of routed.destinations) {
    const moved = nativeDelta(routeTx, dest.to);
    check(`${dest.seed} vault +${dest.lamports.toString()}`, moved === dest.lamports, `moved ${moved} expected ${dest.lamports}`);
  }
  const expectedWeekly = db.accruals.reduce((s, a) => s + BigInt(a.league_weekly), 0n);
  const expectedMonthly = db.accruals.reduce((s, a) => s + BigInt(a.league_monthly), 0n);
  const expectedRecruiter = db.accruals.reduce((s, a) => s + BigInt(a.recruiter), 0n);
  const expectedSquad = db.accruals.reduce((s, a) => s + BigInt(a.squad), 0n);
  const expectedAirdrop = db.accruals.reduce((s, a) => s + BigInt(a.airdrop), 0n);
  const expectedProtocol = db.accruals.reduce((s, a) => s + BigInt(a.protocol), 0n);
  check("weekly vault total", nativeDelta(routeTx, vaults.leagueWeekly.toBase58()) === expectedWeekly, `${expectedWeekly}`);
  check("monthly vault total", nativeDelta(routeTx, vaults.leagueMonthly.toBase58()) === expectedMonthly, `${expectedMonthly}`);
  check("recruiter vault total", nativeDelta(routeTx, vaults.recruiter.toBase58()) === expectedRecruiter, `${expectedRecruiter}`);
  check("squad vault total", nativeDelta(routeTx, vaults.squad.toBase58()) === expectedSquad, `${expectedSquad}`);
  check("airdrop vault total", nativeDelta(routeTx, vaults.airdrop.toBase58()) === expectedAirdrop, `${expectedAirdrop}`);
  check("protocol vault total", nativeDelta(routeTx, vaults.protocol.toBase58()) === expectedProtocol, `${expectedProtocol}`);
  check("OG recruiter slice > linked recruiter slice", expectedRecruiter > 0n);
  check("unlinked airdrop slice > 0", expectedAirdrop > 0n);
  check("accruals marked routed", db.accruals.every((a) => a.status === "routed"));

  console.log(failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error?.logs ? `${error.message}\n${error.logs.join("\n")}` : error);
  process.exit(1);
});

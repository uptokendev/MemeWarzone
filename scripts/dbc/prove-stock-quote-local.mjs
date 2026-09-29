#!/usr/bin/env node
/**
 * DBC step 7b proof: a coin paired with NVDAx, on a local validator carrying mainnet's DBC, DAMM v2,
 * Token-2022, Metaplex and locker programs, the NVDAx mint and Meteora's badges for it. Run through
 * scripts/dbc/rehearse-stock-quote-local.sh, which loads that state; throwaway keys only.
 *
 * Every step runs the production code: the create API (stock price step read from the cloned mint
 * plus Jupiter's live price, config ladder, pool build), the browser trade builder and its program
 * guard, the indexer and market stats, the fee claimer, the referral sweep, the graduation keeper and
 * the creator claims. Jupiter swaps of NVDAx to SOL are stubbed: the validator has no Jupiter.
 *
 * The one stand-in: the config ladder refuses any RPC whose genesis is not mainnet-beta, so its
 * connection answers getGenesisHash with mainnet's. Everything else talks to the validator.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { readStockQuoteState } from "../../frontend/api/lib/dbc/dbcStockQuote.mjs";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { buildDbcSwapTransaction, submitPreparedDbcTrade } from "../../frontend/src/lib/dbcTrade.mjs";
import { buildCreatorLpFeeTransaction, buildGraduationPayoutTransaction, loadCreatorRewards } from "../../frontend/src/lib/dbcGraduationClaims.mjs";
import { readOwnerMintBalanceRaw, readQuoteUiMultiplier, readStockPowers } from "../../frontend/src/lib/dbcQuoteMultiplier.mjs";
import { NVDAX_MINT, findQuote, quoteUiToRaw, thresholdQuoteRaw } from "../../frontend/shared/dbcQuotes.mjs";
import { DBC_TARGET_USD_MICROS } from "../../frontend/shared/dbcEconomics.mjs";
import { startThrowawayPostgres } from "./throwaway-postgres.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = requireFromFrontend("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createThawAccountInstruction, createPauseInstruction, createResumeInstruction,
  getAccount, getMint,
} = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient, SwapMode } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const { CpAmm, getTokenProgram } = requireFromFrontend("@meteora-ag/cp-amm-sdk");
const BN = requireFromFrontend("bn.js");

const RPC = process.env.DBC_LOCAL_RPC || "http://127.0.0.1:18899";
const WORK = process.env.MWZ_DBC_7B_WORK || fs.mkdtempSync("/tmp/mwz-dbc-7b-proof-");
const MAINNET = SOLANA_GENESIS["mainnet-beta"];
const failures = [];
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const ed25519Sign = (message, secretKey) => crypto.sign(null, message, crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey).subarray(0, 32)]),
  format: "der", type: "pkcs8",
}));
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
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} not readable`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubSwapQuote = async ({ amount }) => ({ solOut: amount / 10n, impactBps: 0n, transaction: null });

async function airdrop(conn, to, sol) {
  const sig = await conn.requestAirdrop(to, sol * 1_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
}
async function t22Balance(conn, owner) {
  return readOwnerMintBalanceRaw(conn, owner.toBase58?.() || String(owner), NVDAX_MINT);
}
async function sendTx(conn, tx, signers) {
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

/** Market-stats tables the shared throwaway schema leaves out; the view mirrors production's curve branch. */
async function marketStatsFixture(db) {
  const cols = ["market_stage", "last_price_bnb", "market_cap_bnb", "liquidity_bnb", "bonding_reserve_bnb", "volume_5m_bnb", "volume_1h_bnb",
    "volume_4h_bnb", "volume_24h_bnb", "buy_volume_24h_bnb", "sell_volume_24h_bnb", "bonding_volume_24h_bnb", "dex_volume_24h_bnb", "trades_24h",
    "buys_24h", "sells_24h", "holders", "post_burn_total_supply_raw", "supply_basis", "last_trade_block", "last_trade_at", "data_lag_seconds",
    "updated_at", "quote_token_address", "quote_asset_type", "last_price_quote", "dex_volume_24h_quote", "volume_24h_usd", "market_cap_usd",
    "liquidity_usd", "last_price_usd", "reference_price_usd", "reference_price_updated_at", "valuation_source", "valuation_healthy", "valuation_error"];
  await db.query(`alter table public.token_stats add column if not exists sold_tokens numeric`);
  await db.query(`create table if not exists public.market_stats (chain_id integer not null, campaign_address text not null, ${cols.map((c) => `${c} text`).join(", ")}, primary key (chain_id, campaign_address))`);
  await db.query(`create table if not exists public.dex_trades (chain_id integer, campaign_address text, status text, price_quote numeric, block_number bigint, log_index integer, side text, token_amount_raw numeric, transaction_from text, sender_address text, recipient_address text)`);
  await db.query(`create or replace view public.market_trades_v as
    select t.chain_id as "chainId", t.campaign_address as "campaignAddress", 'confirmed'::text as status, t.block_time as "blockTime",
           t.block_number as "blockNumber", t.log_index as "logIndex", t.bnb_amount_raw::text as "nativeAmountRaw",
           t.bnb_amount_raw::text as "quoteAmountRaw", 'WRAPPED_NATIVE'::text as "quoteAssetType", null::numeric as "volumeUsd",
           t.side, 'bonding'::text as source
      from public.curve_trades t`);
}

async function keeperUntil(db, conn, collector, pool, stop, maxPasses = 20) {
  const { runDbcGraduationOnce, resolvePendingGraduation } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runDbcGraduationOnce({ db, connection: conn, collector, send: true, pool, swapQuote: stubSwapQuote });
    await resolvePendingGraduation({ db, connection: conn });
    const job = (await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0];
    console.log(`  keeper pass ${i + 1}`, JSON.stringify({ advanced: result.advanced, step: job?.step, status: job?.status, blocked: job?.blocked_reason || null }));
    if (job && stop(job, result)) return { job, result };
    await sleep(600);
  }
  return { job: (await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0], result: null };
}

async function main() {
  const pg = await startThrowawayPostgres();
  process.env.DATABASE_URL = pg.url;
  process.env.PG_DISABLE_SSL = "1";
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.SOLANA_MAINNET_RPC_URL = RPC; // market stats read the validator
  process.env.ABLY_API_KEY ||= "test:key";
  process.env.DBC_GRADUATION_ENABLED = "true";
  process.env.DBC_GRADUATION_SEND = "true";
  process.env.DBC_LP_CLAIM_MIN_LAMPORTS ||= "1";
  process.env.SOLANA_CLUSTER = "mainnet-beta";
  process.env.SOLANA_GRADUATION_SOL_USD_MICROS = "200000000";
  const db = pg.pool;
  try {
    await marketStatsFixture(db);
    const { indexDbcPool, loadDbcPools, quoteRawToSolLamports } = await import("../../realtime-indexer/src/dbcIndexer.ts");
    const { refreshSolanaMarketStats } = await import("../../realtime-indexer/src/solanaMarketStats.ts");
    const { accrueDbcFees } = await import("../../realtime-indexer/src/dbc/dbcFeeAccruals.ts");
    const { claimPoolPartnerFees, resolvePendingClaims } = await import("../../realtime-indexer/src/dbc/dbcFeeClaimer.ts");
    const { sweepReferralToProtocol } = await import("../../realtime-indexer/src/dbc/dbcReferralSweep.ts");
    const { runDbcLpClaimsOnce, resolvePendingLpClaims } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");

    const conn = new Connection(RPC, "confirmed");
    const ladderConn = new Proxy(conn, {
      get(target, prop) {
        if (prop === "getGenesisHash") return async () => MAINNET;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.NVDAX_AUTHORITY_KEYPAIR, "utf8"))));
    const payer = Keypair.generate();
    const collector = Keypair.generate();
    const creator = Keypair.generate();
    const trader = Keypair.generate();
    const referralOwner = Keypair.generate();
    fs.writeFileSync(path.join(WORK, "keys.json"), JSON.stringify({
      payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey), creator: Array.from(creator.secretKey),
      trader: Array.from(trader.secretKey), referralOwner: Array.from(referralOwner.secretKey),
    }));
    console.log(`local validator ${RPC}\nkeys in ${WORK}\npostgres ${pg.url}`);
    for (const k of [authority, payer, collector, creator, trader, referralOwner]) await airdrop(conn, k.publicKey, 50);
    // The treasury's vault PDAs hold SOL on mainnet; on a fresh validator they must exist before a
    // route or sweep sends them a few lamports.
    const { rewardVaults } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    for (const vault of Object.values(rewardVaults())) await airdrop(conn, vault, 1);
    // DBC's and DAMM v2's pool authorities are system accounts that hold SOL on mainnet (68 and 175 SOL
    // read 2026-09-29); DBC's pays the locker escrow's rent at graduation.
    for (const program of ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"]) {
      await airdrop(conn, PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey(program))[0], 5);
    }

    const nvdax = new PublicKey(NVDAX_MINT);
    const quote = findQuote("mainnet-beta", NVDAX_MINT);

    console.log("\n[the cloned NVDAx mint]");
    const state = await readStockQuoteState(conn, NVDAX_MINT);
    check("mint is Token-2022 with 8 decimals", state.decimals === 8, String(state.decimals));
    check("Meteora's DBC badge is on the validator", state.badgeExists, state.badge);
    check("Meteora's DAMM v2 badge is on the validator", state.dammBadgeExists, state.dammBadge);
    check("not paused, no hook program, no transfer fee", !state.paused && !state.hookProgram && state.transferFeeBps === 0, JSON.stringify(state));
    const multiplier = await readQuoteUiMultiplier(conn, NVDAX_MINT);
    check("browser reads the multiplier in force", multiplier === state.multiplier && multiplier > 1, String(multiplier));
    const powers = await readStockPowers(conn, NVDAX_MINT);
    check("risk dialog reads delegate, freeze, hook and pause powers as set", powers.permanentDelegate && powers.freezeAuthority && powers.hookAuthority && powers.pauseAuthority, JSON.stringify(powers));

    // Token-2022 ATAs; thaw them if the mint's default state freezes new accounts.
    const ata = (owner) => getAssociatedTokenAddressSync(nvdax, owner, false, TOKEN_2022_PROGRAM_ID);
    const holders = [trader, creator, collector, referralOwner];
    const setup = new Transaction();
    for (const k of holders) setup.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(k.publicKey), k.publicKey, nvdax, TOKEN_2022_PROGRAM_ID));
    await sendTx(conn, setup, [payer]);
    for (const k of holders) {
      const acct = await getAccount(conn, ata(k.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
      if (acct.isFrozen) await sendTx(conn, new Transaction().add(createThawAccountInstruction(ata(k.publicKey), nvdax, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);
    }
    const supplyAtStart = (await getMint(conn, nvdax, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    const traderSupply = 20_000_000_000n; // 200 NVDAx raw-whole
    await sendTx(conn, new Transaction().add(createMintToInstruction(nvdax, ata(trader.publicKey), authority.publicKey, traderSupply, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);
    check("trader holds 200 NVDAx (raw)", (await t22Balance(conn, trader.publicKey)) === traderSupply);

    console.log("\n[create through the API]");
    const referralAta = ata(referralOwner.publicKey);
    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
      DBC_REFERRAL_TOKEN_ACCOUNTS: JSON.stringify({ [NVDAX_MINT]: referralAta.toBase58() }),
    };
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "mainnet-beta", connection: ladderConn, payer, feeClaimer: collector.publicKey, client });
    let priced = null;
    const handle = createDbcCreateHandler({
      env, db, connection: conn, client, ladder,
      requireWalletActionAuth: requireSignedBegin,
      stockPriceStep: async (c, q) => {
        const { stockPriceStep } = await import("../../frontend/api/lib/dbc/dbcStockQuote.mjs");
        priced = await stockPriceStep(c, q);
        return priced;
      },
    });

    const refusedBuyback = await post(handle, { operation: "quote-first-buy", targetUsd: 15000, feeChoice: "buyback", firstBuyLamports: "0", quoteMint: NVDAX_MINT });
    check("buyback on a stock pairing is refused", refusedBuyback.body.code === "DBC_BUYBACK_NEEDS_SOL", refusedBuyback.body.code);

    const ticker = `NV${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
    if (!begun.body.ok) throw new Error(`begin failed ${JSON.stringify(begun.body)}`);
    const baseMint = Keypair.generate();
    const auth = await post(handle, {
      operation: "authorize", sessionToken: begun.body.sessionToken, mint: baseMint.publicKey.toBase58(),
      name: "NVDA Paired", symbol: ticker, targetUsd: 15000, feeChoice: "keep", firstBuyLamports: "0", quoteMint: NVDAX_MINT,
    });
    if (!auth.body.ok) throw new Error(`authorize failed ${JSON.stringify(auth.body)}`);
    check("price step came from the chain and Jupiter", Boolean(priced) && priced.usdMicrosPerRawUnit > 0n, priced ? `${priced.usdMicrosPerRawUnit} micros per 1e8 raw, step ${priced.stepIndex} = ${priced.stepUsdMicros}` : "none");
    const created = await submitPreparedDbcCreate({
      connection: conn, transaction: Transaction.from(Buffer.from(auth.body.transaction, "base64")),
      mintSecretKey: baseMint.secretKey, mintAddress: baseMint.publicKey.toBase58(),
      creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
      signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
    });
    const fin = await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
    check("finalize wrote the campaign", fin.body.ok === true, JSON.stringify(fin.body).slice(0, 120));
    const poolAddr = auth.body.pool;
    console.log(`  pool ${poolAddr} config ${auth.body.config}`);

    const cfg = (await client.state.getPoolConfig(new PublicKey(auth.body.config)));
    const config = cfg?.poolConfig ?? cfg;
    check("config quote is NVDAx", String(config.quoteMint) === NVDAX_MINT);
    check("config quote token flag is Token-2022", Number(config.quoteTokenFlag) === 1, String(config.quoteTokenFlag));
    const wantThreshold = thresholdQuoteRaw(DBC_TARGET_USD_MICROS[15000], quote, priced.stepUsdMicros);
    check("threshold is $15,000 in NVDAx at the stepped price", BigInt(String(config.migrationQuoteThreshold)) === wantThreshold, `${config.migrationQuoteThreshold} vs ${wantThreshold}`);
    const ladderRow = (await db.query(`select status, quote_mint from public.dbc_launch_configs where config_address = $1`, [auth.body.config])).rows[0];
    check("ladder row active after readback", ladderRow?.status === "active", ladderRow?.status);
    const meta = (await db.query(`select meta from public.campaigns where campaign_address = $1`, [poolAddr])).rows[0]?.meta;
    check("campaign meta records quote kind stock", meta?.dbc?.quoteKind === "stock", meta?.dbc?.quoteKind);
    const poolState = (await client.state.getPool(new PublicKey(poolAddr)))?.poolState;
    const quoteVaultInfo = await conn.getAccountInfo(poolState.quoteVault, "confirmed");
    check("curve's quote vault is a Token-2022 account", quoteVaultInfo?.owner.equals(TOKEN_2022_PROGRAM_ID), quoteVaultInfo?.owner.toBase58());

    // Past the 60 s launch fee so trades pay the normal 2%.
    const activation = Number(poolState.activationPoint || 0);
    for (;;) {
      const now = Number(await conn.getBlockTime(await conn.getSlot("confirmed")));
      if (now >= activation + 62) break;
      await sleep(2_000);
    }

    console.log("\n[trade through the browser builder]");
    const trade = async (side, amountIn) => {
      const built = await buildDbcSwapTransaction({ connection: conn, poolAddress: poolAddr, trader: trader.publicKey.toBase58(), side, amountIn, env });
      const sent = await submitPreparedDbcTrade({
        connection: conn, transaction: built.tx, trader: trader.publicKey.toBase58(), pool: poolAddr,
        signTransaction: async (unsigned) => { unsigned.partialSign(trader); return unsigned; },
      });
      return { ...sent, built };
    };
    const traderBase = getAssociatedTokenAddressSync(baseMint.publicKey, trader.publicKey);
    const buyIn = quoteUiToRaw("2.5", 8, multiplier);
    const before = await t22Balance(conn, trader.publicKey);
    const buy = await trade("buy", buyIn);
    const after = await t22Balance(conn, trader.publicKey);
    check("buy named the NVDAx referral account", buy.built.referral === referralAta.toBase58(), buy.built.referral);
    check("buy spent exactly the typed 2.5 NVDAx (raw = 2.5 / multiplier)", before - after === buyIn, `${before - after} vs ${buyIn}`);
    const got = BigInt((await conn.getTokenAccountBalance(traderBase)).value.amount);
    check("buy received what the quote said", got === buy.built.quoted.amountOut, `${got} vs ${buy.built.quoted.amountOut}`);
    const sellIn = got / 4n;
    const beforeSell = await t22Balance(conn, trader.publicKey);
    const sell = await trade("sell", sellIn);
    const nvdaxBack = (await t22Balance(conn, trader.publicKey)) - beforeSell;
    check("sell paid NVDAx back as quoted", nvdaxBack === sell.built.quoted.amountOut, `${nvdaxBack} vs ${sell.built.quoted.amountOut}`);

    console.log("\n[indexer and market stats]");
    const loaded = (await loadDbcPools(db)).find((p) => p.campaign === poolAddr);
    check("indexer loads the pool as a stock quote", loaded?.quoteKind === "stock" && loaded?.quoteDecimals === 8, JSON.stringify(loaded));
    // getSignaturesForAddress answers at finalized: wait for the trades to get there.
    let ingested = 0;
    for (let i = 0; i < 30 && ingested < 2; i += 1) {
      ingested += (await indexDbcPool(db, loaded)).ingested;
      if (ingested < 2) await sleep(2_000);
    }
    check("indexer wrote the trades", ingested >= 2, String(ingested));
    const rows = (await db.query(`select side, quote_amount_raw::text q, bnb_amount_raw::text s from public.curve_trades where campaign_address=$1 order by block_time, log_index`, [poolAddr])).rows;
    const acts = (await db.query(`select meta from public.activity_events where campaign_address=$1 order by block_number, log_index`, [poolAddr])).rows;
    const quoteUsd = acts[0]?.meta?.quoteUsd;
    check("activity records the stock price used", quoteUsd?.source === "jupiter:price-v3-prescaled" && Number(quoteUsd?.micros) > 0, JSON.stringify(quoteUsd));
    for (const row of rows) {
      const want = quoteRawToSolLamports(BigInt(row.q), 8, 200_000_000n, BigInt(quoteUsd.micros));
      check(`${row.side} SOL value = NVDAx x stock price / SOL price`, BigInt(row.s) === want, `${row.s} vs ${want}`);
    }
    const stats = await refreshSolanaMarketStats(poolAddr, { db });
    check("market stats price the coin in NVDAx", stats?.quote_token_address === NVDAX_MINT, stats?.quote_token_address);
    check("market stats value NVDAx from Jupiter's prescaled price", stats?.valuation_source === "jupiter:price-v3-prescaled", stats?.valuation_source);
    const livePool = (await client.state.getPool(new PublicKey(poolAddr)))?.poolState;
    const q64 = 2 ** 64;
    const poolPrice = (Number(BigInt(String(livePool.sqrtPrice))) / q64) ** 2 * 1e6 / 1e8; // NVDAx per token, 6/8 decimals
    check("market stats price = the curve's price in NVDAx", Math.abs(Number(stats?.last_price_quote) / poolPrice - 1) < 1e-6, `${stats?.last_price_quote} vs ${poolPrice}`);
    check("market stats USD price = NVDAx price x Jupiter prescaled", Math.abs(Number(stats?.last_price_usd) / (poolPrice * Number(stats?.reference_price_usd)) - 1) < 1e-9 && stats?.valuation_healthy === true, `${stats?.last_price_usd} usd, ref ${stats?.reference_price_usd}`);

    console.log("\n[fees: claim in NVDAx, referral sweep]");
    await accrueDbcFees(db);
    const owedPool = (await client.state.getPool(new PublicKey(poolAddr)))?.poolState;
    const owed = BigInt(String(owedPool.partnerQuoteFee));
    const collectorBefore = await t22Balance(conn, collector.publicKey);
    await claimPoolPartnerFees({ db, connection: conn, collector, pool: poolAddr, send: true, minLamports: 1n, client });
    await resolvePendingClaims({ db, connection: conn, client });
    const collectorGot = (await t22Balance(conn, collector.publicKey)) - collectorBefore;
    check("collector claimed the pool's NVDAx fee counter exactly", owed > 0n && collectorGot === owed, `${collectorGot} vs ${owed}`);
    const referralHeld = BigInt((await conn.getTokenAccountBalance(referralAta)).value.amount);
    check("referral account earned NVDAx on the trades", referralHeld > 0n, String(referralHeld));
    const swept = await sweepReferralToProtocol({
      db, connection: conn, collector, referralOwner, referralTokenAccount: referralAta.toBase58(), send: true, quoteMint: NVDAX_MINT, swapQuote: stubSwapQuote,
    });
    const referralAfter = await conn.getAccountInfo(referralAta, "confirmed");
    const referralLeft = BigInt((await conn.getTokenAccountBalance(referralAta)).value.amount);
    check("referral sweep moved every NVDAx with Token-2022 and kept the account", Boolean(swept.signature) && referralLeft === 0n && Boolean(referralAfter) && !swept.referralClosed, JSON.stringify({ left: String(referralLeft), sol: String(swept.swept) }));

    console.log("\n[issuer pause]");
    await sendTx(conn, new Transaction().add(createPauseInstruction(nvdax, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);
    const pausedQuote = await post(handle, { operation: "quote-first-buy", targetUsd: 15000, feeChoice: "keep", firstBuyLamports: "0", quoteMint: NVDAX_MINT });
    check("API refuses a paused stock with the reason", pausedQuote.body.code === "DBC_QUOTE_PAUSED", pausedQuote.body.code);
    let pausedTradeFailed = false;
    try {
      await trade("buy", quoteUiToRaw("0.1", 8, multiplier));
    } catch {
      pausedTradeFailed = true;
    }
    check("nobody can buy while the issuer has it paused", pausedTradeFailed);
    await sendTx(conn, new Transaction().add(createResumeInstruction(nvdax, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);

    console.log("\n[complete the curve]");
    const threshold = BigInt(String(config.migrationQuoteThreshold));
    const reserveNow = BigInt(String((await client.state.getPool(new PublicKey(poolAddr)))?.poolState.quoteReserve));
    const need = threshold - reserveNow;
    const fill = await client.pool.swap2({
      owner: trader.publicKey, pool: new PublicKey(poolAddr), swapBaseForQuote: false, referralTokenAccount: null,
      swapMode: SwapMode.PartialFill, amountIn: new BN((need + need / 5n).toString()), minimumAmountOut: new BN(1),
    });
    fill.feePayer = trader.publicKey;
    await sendTx(conn, fill, [trader]);
    const reserveDone = BigInt(String((await client.state.getPool(new PublicKey(poolAddr)))?.poolState.quoteReserve));
    check("curve complete in NVDAx", reserveDone >= threshold, `${reserveDone} / ${threshold}`);

    console.log("\n[keeper: paused stock blocks the migration, then it graduates]");
    await sendTx(conn, new Transaction().add(createPauseInstruction(nvdax, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);
    const blocked = await keeperUntil(db, conn, collector, poolAddr, (job, result) => (result?.advanced || []).some((a) => a.skipped === "quote-paused") || job.step === "done", 8);
    check("keeper refuses to migrate a paused stock and says why", /paused/.test(String(blocked.job?.blocked_reason || "")), blocked.job?.blocked_reason);
    await sendTx(conn, new Transaction().add(createResumeInstruction(nvdax, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);
    await db.query(`update public.dbc_graduation_jobs set backoff_until = null where pool = $1`, [poolAddr]);
    const creatorBefore = await t22Balance(conn, creator.publicKey);
    const { job } = await keeperUntil(db, conn, collector, poolAddr, (row) => row.step === "done" && row.status === "done");
    check("keeper graduated the coin once the pause lifted", job?.status === "done" && job?.step === "done", `${job?.step} ${job?.status}`);
    check("the pause reason is cleared once it no longer applies", !job?.blocked_reason, String(job?.blocked_reason));
    const dammPool = String(job?.damm_pool || "");
    const cpAmm = new CpAmm(conn);
    const dpool = await cpAmm.fetchPoolState(new PublicKey(dammPool));
    const nvdaxIsA = dpool.tokenAMint.equals(nvdax);
    const nvdaxVault = nvdaxIsA ? dpool.tokenAVault : dpool.tokenBVault;
    check("graduated pool's NVDAx vault is Token-2022", (await conn.getAccountInfo(nvdaxVault))?.owner.equals(TOKEN_2022_PROGRAM_ID));
    const comp = (await db.query(`select lamports::text, tx from public.dbc_graduation_compensations where pool = $1`, [poolAddr])).rows[0];
    const creatorAfterComp = await t22Balance(conn, creator.publicKey);
    if (comp?.tx && comp.tx !== "none") {
      check("D7 paid the creator in NVDAx, exactly", creatorAfterComp - creatorBefore === BigInt(comp.lamports), `${creatorAfterComp - creatorBefore} vs ${comp.lamports}`);
    } else {
      check("D7 had nothing to pay", comp?.tx === "none", JSON.stringify(comp));
    }

    console.log("\n[after graduation: DAMM swap, LP claims, creator payout]");
    const rewards = await loadCreatorRewards(conn, { pool: poolAddr, creator: creator.publicKey.toBase58() });
    check("creator rewards derive the NVDAx pool", rewards.dammPool === dammPool && rewards.quoteMint === NVDAX_MINT, `${rewards.dammPool} ${rewards.quoteMint}`);
    const swapTx = await cpAmm.swap({
      payer: trader.publicKey, pool: new PublicKey(dammPool), inputTokenMint: nvdax, outputTokenMint: baseMint.publicKey,
      amountIn: new BN(500_000_000), minimumAmountOut: new BN(1),
      tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint, tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
      tokenAProgram: getTokenProgram(dpool.tokenAFlag), tokenBProgram: getTokenProgram(dpool.tokenBFlag),
      referralTokenAccount: null, poolState: dpool,
    });
    swapTx.feePayer = trader.publicKey;
    check("a 5 NVDAx buy trades on the graduated pool", Boolean(await sendTx(conn, swapTx, [trader])));
    const lp = await runDbcLpClaimsOnce({ db, connection: conn, collector, send: true, pool: poolAddr, swapQuote: stubSwapQuote });
    await resolvePendingLpClaims({ db, connection: conn, collector, send: true, swapQuote: stubSwapQuote });
    const lpSig = (lp.advanced || []).find((a) => a.signature)?.signature;
    const lpTx = lpSig ? await getTx(conn, lpSig) : null;
    check("keeper's partner LP claim landed with the pool's token programs", Boolean(lpTx) && lpTx.meta.err == null, lpSig || JSON.stringify(lp).slice(0, 160));
    const owedLp = BigInt((await loadCreatorRewards(conn, { pool: poolAddr, creator: creator.publicKey.toBase58() })).lpFees);
    const creatorLp = await buildCreatorLpFeeTransaction({ connection: conn, dammPool, creator: creator.publicKey.toBase58() });
    const beforeLp = await t22Balance(conn, creator.publicKey);
    await sendTx(conn, creatorLp, [creator]);
    const claimedLp = (await t22Balance(conn, creator.publicKey)) - beforeLp;
    check("creator claimed exactly the NVDAx LP fee the panel showed", owedLp > 0n && claimedLp === owedLp, `${claimedLp} vs ${owedLp}`);
    const payoutTx = await buildGraduationPayoutTransaction({ connection: conn, pool: poolAddr, creator: creator.publicKey.toBase58() });
    const beforePayout = await t22Balance(conn, creator.publicKey);
    await sendTx(conn, payoutTx, [creator]);
    const payout = (await t22Balance(conn, creator.publicKey)) - beforePayout;
    check("creator's graduation payout arrived in NVDAx", payout > 0n && payout === BigInt(rewards.graduationPayout), `${payout} vs ${rewards.graduationPayout}`);

    const mintAfter = await getMint(conn, nvdax, "confirmed", TOKEN_2022_PROGRAM_ID);
    check("NVDAx supply moved only by the 200 this proof minted", mintAfter.supply === supplyAtStart + traderSupply, `${mintAfter.supply} vs ${supplyAtStart} + ${traderSupply}`);

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

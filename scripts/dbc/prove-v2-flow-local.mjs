/**
 * DBC v2 economics through OUR code on a local validator (mainnet's DBC, DAMM v2, Metaplex, locker programs):
 * the create API (config ladder + authorize with a 70% first buy + finalize), the browser create submit,
 * a public buy through the browser trade builder, the indexer + fee accrual, the graduation keeper end to
 * end, and the creator rewards read. For $30K and $50K graduation market caps, SOL quote.
 *
 *   SOLANA_MAINNET_RPC_URL=<rpc> MWZ_DBC_V2_PROOF=prove-v2-flow-local.mjs bash scripts/dbc/rehearse-v2-economics-local.sh
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { buildDbcSwapTransaction, submitPreparedDbcTrade } from "../../frontend/src/lib/dbcTrade.mjs";
import { loadCreatorRewards } from "../../frontend/src/lib/dbcGraduationClaims.mjs";
import { DBC_FIRST_BUY_MAX_BPS } from "../../frontend/shared/dbcEconomics.mjs";
import { startThrowawayPostgres } from "./throwaway-postgres.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Connection, Keypair, PublicKey, Transaction } = requireFromFrontend("@solana/web3.js");
const { getAssociatedTokenAddressSync, getMint, NATIVE_MINT } = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient, getPriceFromSqrtPrice } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");

const RPC = process.env.DBC_LOCAL_RPC || "http://127.0.0.1:18899";
const MAINNET = SOLANA_GENESIS["mainnet-beta"];
const SOL_USD_MICROS = 120_400_000n;
const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function airdrop(conn, to, sol) {
  const sig = await conn.requestAirdrop(to, sol * 1_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
}
const stubSwapQuote = async ({ amount }) => ({ solOut: amount, impactBps: 0n, transaction: null });

async function keeperUntil(db, conn, collector, pool, stop, maxPasses = 25) {
  const { runDbcGraduationOnce, resolvePendingGraduation } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");
  const steps = [];
  for (let i = 0; i < maxPasses; i += 1) {
    await runDbcGraduationOnce({ db, connection: conn, collector, send: true, pool, swapQuote: stubSwapQuote });
    await resolvePendingGraduation({ db, connection: conn });
    const job = (await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0];
    if (job?.step && steps.at(-1) !== job.step) steps.push(job.step);
    if (job && stop(job)) return { job, steps };
    await sleep(600);
  }
  return { job: (await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [pool])).rows[0], steps };
}

async function proveTarget({ db, conn, client, handle, collector, targetUsd }) {
  console.log(`\n=== $${targetUsd / 1000}K market cap, through the create API and the keeper ===`);
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  await airdrop(conn, creator.publicKey, 100);
  await airdrop(conn, trader.publicKey, 200);
  const ticker = `V2${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

  // The quote the create page shows while the creator types the first buy.
  const quoteFor = async (lamports) => post(handle, { operation: "quote-first-buy", targetUsd, feeChoice: "keep", firstBuyLamports: String(lamports), creatorWallet: creator.publicKey.toBase58() });
  // Find the most SOL that stays within 70% (the page does the same by asking the quote).
  let lo = 0n;
  let hi = 200_000_000_000n;
  while (hi - lo > 1_000_000n) {
    const mid = (lo + hi) / 2n;
    const q = await quoteFor(mid);
    if (q.body.exceedsCap) hi = mid; else lo = mid;
  }
  const atCap = await quoteFor(lo);
  check("the create page's quote shows the 70% cap", atCap.body.capBps === String(DBC_FIRST_BUY_MAX_BPS) && atCap.body.exceedsCap === false, `${Number(atCap.body.bps) / 100}% for ${(Number(lo) / 1e9).toFixed(3)} SOL`);
  const over = await quoteFor(lo + 50_000_000n);
  check("a little more is over the cap", over.body.exceedsCap === true, `${Number(over.body.bps) / 100}%`);

  const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
  if (!begun.body.ok) throw new Error(`begin failed ${JSON.stringify(begun.body)}`);
  const refused = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: Keypair.generate().publicKey.toBase58(),
    name: "V2 Proof", symbol: ticker, targetUsd, feeChoice: "keep", firstBuyLamports: String(lo + 50_000_000n),
  });
  check("authorize refuses a first buy above 70%", refused.body.code === "DBC_FIRST_BUY_CAP", refused.body.error);
  const baseMint = Keypair.generate();
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: baseMint.publicKey.toBase58(),
    name: "V2 Proof", symbol: ticker, targetUsd, feeChoice: "keep", firstBuyLamports: String(lo),
  });
  if (!auth.body.ok) throw new Error(`authorize failed ${JSON.stringify(auth.body)}`);
  const launchTx = Transaction.from(Buffer.from(auth.body.transaction, "base64"));
  const created = await submitPreparedDbcCreate({
    connection: conn, transaction: launchTx,
    mintSecretKey: baseMint.secretKey, mintAddress: baseMint.publicKey.toBase58(),
    creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
    signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
  });
  const fin = await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
  check("finalize wrote the campaign", fin.body.ok === true, JSON.stringify(fin.body).slice(0, 100));
  const pool = auth.body.pool;

  const cfgWrap = await client.state.getPoolConfig(new PublicKey(auth.body.config));
  const cfg = cfgWrap?.poolConfig ?? cfgWrap;
  check("ladder config on chain: 2% migration fee, creator 0%", Number(cfg.migrationFeePercentage) === 2 && Number(cfg.creatorMigrationFeePercentage) === 0);
  const gradPrice = Number(getPriceFromSqrtPrice(cfg.migrationSqrtPrice, 6, 9));
  const mcUsd = gradPrice * 1e9 * Number(SOL_USD_MICROS) / 1e6;
  check(`ladder config graduates at $${targetUsd / 1000}K MC`, Math.abs(mcUsd / targetUsd - 1) < 0.01, `$${mcUsd.toFixed(0)} at $${Number(SOL_USD_MICROS) / 1e6} SOL (price step)`);
  check("85% of the supply on the curve", Math.abs(Number(cfg.swapBaseAmount.toString()) / 1e15 - 0.85) < 0.0002, `${(Number(cfg.swapBaseAmount.toString()) / 1e12).toFixed(2)}M`);
  const creatorTokens = BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(baseMint.publicKey, creator.publicKey))).value.amount);
  check("the creator holds ~70% right after launch", Math.abs(Number(creatorTokens) / 1e15 - 0.70) < 0.001, `${(Number(creatorTokens) / 1e12).toFixed(2)}M`);
  let state = (await client.state.getPool(new PublicKey(pool)))?.poolState;
  const threshold = BigInt(String(cfg.migrationQuoteThreshold));
  check("70% does not graduate the coin", BigInt(String(state.quoteReserve)) < threshold, `${(Number(state.quoteReserve) / 1e9).toFixed(3)} of ${(Number(threshold) / 1e9).toFixed(3)} SOL`);

  // Past the 60 s launch fee, the public buys the rest through the browser builder.
  const activation = Number(state.activationPoint || 0);
  for (;;) {
    const now = Number(await conn.getBlockTime(await conn.getSlot("confirmed")));
    if (now >= activation + 62) break;
    await sleep(2_000);
  }
  const env = { DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: RPC };
  const built = await buildDbcSwapTransaction({ connection: conn, poolAddress: pool, trader: trader.publicKey.toBase58(), side: "buy", amountIn: threshold * 2n, env });
  await submitPreparedDbcTrade({
    connection: conn, transaction: built.tx, trader: trader.publicKey.toBase58(), pool,
    signTransaction: async (unsigned) => { unsigned.partialSign(trader); return unsigned; },
  });
  const traderTokens = BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(baseMint.publicKey, trader.publicKey))).value.amount);
  check("the public bought the remaining ~15%", Math.abs(Number(traderTokens) / 1e15 - 0.15) < 0.001, `${(Number(traderTokens) / 1e12).toFixed(2)}M`);
  state = (await client.state.getPool(new PublicKey(pool)))?.poolState;
  check("curve complete", BigInt(String(state.quoteReserve)) >= threshold);

  // Indexer + fee accrual, then the graduation keeper end to end.
  const { indexDbcPool, loadDbcPools } = await import("../../realtime-indexer/src/dbcIndexer.ts");
  const { accrueDbcFees } = await import("../../realtime-indexer/src/dbc/dbcFeeAccruals.ts");
  const loaded = (await loadDbcPools(db)).find((p) => p.campaign === pool);
  for (let i = 0; i < 30; i += 1) {
    if ((await indexDbcPool(db, loaded)).ingested >= 1) break;
    await sleep(2_000);
  }
  await accrueDbcFees(db);
  const { job, steps } = await keeperUntil(db, conn, collector, pool, (j) => j.status === "done");
  check("keeper graduates the coin to the end", job?.status === "done", `steps ${steps.join(" -> ")}`);
  check("no D7 compensation step for a v2 pool", !steps.includes("compensate"), steps.join(", "));
  const comp = (await db.query(`select count(*)::int n from public.dbc_graduation_compensations where pool = $1`, [pool])).rows[0].n;
  check("no compensation row written", comp === 0, String(comp));
  const partnerFee = BigInt(String(job?.partner_fee || "0"));
  const wantFee = threshold - (threshold * 98n + 99n) / 100n;
  check("the collector withdrew the whole 2% graduation fee", partnerFee === wantFee, `${partnerFee} vs ${wantFee}`);
  const ev = (await db.query(
    `select recruiter_amount::text r, squad_amount::text s, airdrop_amount::text a, protocol_amount::text p, raw_amount::text raw
       from public.reward_events where campaign_address = $1 and route_kind = 'finalize'`, [pool])).rows[0];
  const routed = ev ? BigInt(ev.r) + BigInt(ev.s) + BigInt(ev.a) + BigInt(ev.p) : 0n;
  check("the finalize route split the whole fee (recruiter/squad/airdrop/protocol)", ev && routed === partnerFee, ev ? `routed ${routed}, protocol ${ev.p}` : "no reward event");

  const rewards = await loadCreatorRewards(conn, { pool, creator: creator.publicKey.toBase58(), includeLp: true });
  check("creator rewards: no graduation fee share, nothing to claim", rewards.creatorGraduationShare === false && rewards.graduationPayout === "0" && rewards.graduationPayoutClaimable === false, JSON.stringify({ share: rewards.creatorGraduationShare, payout: rewards.graduationPayout }));
  const mint = await getMint(conn, baseMint.publicKey);
  check("mint supply stays 1B", Math.abs(Number(mint.supply) / 1e15 - 1) < 1e-7, (Number(mint.supply) / 1e6).toLocaleString("en-US"));
}

async function main() {
  const pg = await startThrowawayPostgres();
  process.env.DATABASE_URL = pg.url;
  process.env.PG_DISABLE_SSL = "1";
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.SOLANA_MAINNET_RPC_URL = RPC;
  process.env.ABLY_API_KEY ||= "test:key";
  process.env.DBC_GRADUATION_ENABLED = "true";
  process.env.DBC_GRADUATION_SEND = "true";
  process.env.SOLANA_CLUSTER = "mainnet-beta";
  process.env.SOLANA_GRADUATION_SOL_USD_MICROS = String(SOL_USD_MICROS);
  const db = pg.pool;
  try {
    // Columns production has that the shared throwaway schema leaves out (the DBC indexer writes them).
    await db.query(`alter table public.token_candles
      add column if not exists mcap_o numeric, add column if not exists mcap_h numeric,
      add column if not exists mcap_l numeric, add column if not exists mcap_c numeric,
      add column if not exists price_o numeric, add column if not exists price_h numeric,
      add column if not exists price_l numeric, add column if not exists price_c numeric,
      add column if not exists canonical_version integer`);
    await db.query(`alter table public.token_stats add column if not exists sold_tokens numeric`);
    const conn = new Connection(RPC, "confirmed");
    const ladderConn = new Proxy(conn, {
      get(target, prop) {
        if (prop === "getGenesisHash") return async () => MAINNET;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const payer = Keypair.generate();
    const collector = Keypair.generate();
    for (const k of [payer, collector]) await airdrop(conn, k.publicKey, 50);
    const { rewardVaults } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    for (const vault of Object.values(rewardVaults())) await airdrop(conn, vault, 1);
    for (const program of ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"]) {
      await airdrop(conn, PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey(program))[0], 5);
    }
    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
    };
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "mainnet-beta", connection: ladderConn, payer, feeClaimer: collector.publicKey, client });
    const handle = createDbcCreateHandler({
      env, db, connection: conn, client, ladder,
      requireWalletActionAuth: requireSignedBegin,
      readSolUsdMicros: async () => SOL_USD_MICROS,
    });
    for (const targetUsd of [30000, 50000]) await proveTarget({ db, conn, client, handle, collector, targetUsd });
  } finally {
    await pg.stop?.();
  }
  console.log(failures.length === 0 ? "\nALL CHECKS PASS" : `\n${failures.length} CHECK(S) FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

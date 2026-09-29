#!/usr/bin/env node
/**
 * Creator-fee choices for a coin paired with NVDAx, on a local validator carrying mainnet's DBC, DAMM
 * v2, Token-2022, Metaplex and locker programs (scripts/dbc/rehearse-stock-quote-local.sh with
 * MWZ_DBC_PROOF=prove-stock-choices-local.mjs). Throwaway keys only.
 *
 * Two coins launched through the create API: "buyback" and "split 60%". Their creator pots stay in
 * NVDAx on the collector. Production code throughout: indexer, accruals, partner claim, route, the
 * buyback worker (NVDAx spent on the coin's own curve, bought tokens burned in the same tx), the
 * holder snapshot and weekly run (creator paid in NVDAx, holders' part swapped to SOL, keyed, then the
 * SOL round), and after graduation the LP claim (creator pot stays NVDAx, our 20% becomes SOL).
 * Jupiter swaps to SOL are stubbed (the validator has no Jupiter); the ladder's genesis check is the
 * one stand-in, answered as mainnet.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { buildDbcSwapTransaction, submitPreparedDbcTrade } from "../../frontend/src/lib/dbcTrade.mjs";
import { readOwnerMintBalanceRaw } from "../../frontend/src/lib/dbcQuoteMultiplier.mjs";
import { NVDAX_MINT } from "../../frontend/shared/dbcQuotes.mjs";
import { startThrowawayPostgres } from "./throwaway-postgres.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = requireFromFrontend("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createThawAccountInstruction, getAccount, getMint,
} = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient, SwapMode } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const { CpAmm, getTokenProgram } = requireFromFrontend("@meteora-ag/cp-amm-sdk");
const BN = requireFromFrontend("bn.js");

const RPC = process.env.DBC_LOCAL_RPC || "http://127.0.0.1:18899";
const WORK = process.env.MWZ_DBC_7B_WORK || fs.mkdtempSync("/tmp/mwz-dbc-choices-");
const MAINNET = SOLANA_GENESIS["mainnet-beta"];
const MASTER = crypto.randomBytes(16).toString("hex");
const STUB_SOL_PER_RAW = 5n; // stub swap: 5 lamports per raw NVDAx (1e8 raw -> 0.5 SOL)
const failures = [];
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}
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
const sendTx = (conn, tx, signers) => sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
const nvdaxOf = (conn, owner) => readOwnerMintBalanceRaw(conn, owner.toBase58(), NVDAX_MINT);
const stubSwapQuote = async ({ amount }) => ({ solOut: amount * STUB_SOL_PER_RAW, impactBps: 0n, transaction: null });

async function marketStatsFixture(db) {
  await db.query(`alter table public.token_stats add column if not exists sold_tokens numeric`);
}

async function main() {
  const pg = await startThrowawayPostgres();
  Object.assign(process.env, {
    DATABASE_URL: pg.url, PG_DISABLE_SSL: "1", SOLANA_RPC_URL: RPC, SOLANA_RPC_HTTP: RPC, SOLANA_MAINNET_RPC_URL: RPC,
    DBC_GRADUATION_ENABLED: "true", DBC_GRADUATION_SEND: "true", DBC_LP_CLAIM_MIN_LAMPORTS: "1",
    SOLANA_CLUSTER: "mainnet-beta", SOLANA_GRADUATION_SOL_USD_MICROS: "200000000", SOLANA_MIN_PAYOUT_LAMPORTS: "1000",
    DBC_BUYBACK_MIN_USD_MICROS: "500000",
  });
  process.env.ABLY_API_KEY ||= "test:key";
  const db = pg.pool;
  try {
    await marketStatsFixture(db);
    const { indexDbcPool, loadDbcPools } = await import("../../realtime-indexer/src/dbcIndexer.ts");
    const { accrueDbcFees } = await import("../../realtime-indexer/src/dbc/dbcFeeAccruals.ts");
    const { claimPoolPartnerFees, resolvePendingClaims } = await import("../../realtime-indexer/src/dbc/dbcFeeClaimer.ts");
    const { routeClaimedAccruals, resolvePendingRoutes, rewardVaults, heldCreatorPoolSum } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    const { coinLedgers, dues, ensureWeekSecrets, runDueBuybacks, runWeeklyPayouts, takeDueSnapshots, resolvePendingPayouts } = await import("../../realtime-indexer/src/dbc/dbcCreatorPayouts.ts");
    const { weekOf } = await import("../../realtime-indexer/src/dbc/dbcCreatorChoice.ts");
    const { runDbcGraduationOnce, resolvePendingGraduation, runDbcLpClaimsOnce, resolvePendingLpClaims } = await import("../../realtime-indexer/src/dbc/dbcGraduationKeeper.ts");

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
    const creator = Keypair.generate(); // the split coin's creator
    const creatorB = Keypair.generate(); // one launch per wallet per 24 h
    const trader = Keypair.generate();
    fs.writeFileSync(path.join(WORK, "choices-keys.json"), JSON.stringify({
      payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey), creator: Array.from(creator.secretKey), trader: Array.from(trader.secretKey),
    }));
    console.log(`local validator ${RPC}\npostgres ${pg.url}`);
    for (const k of [authority, payer, collector, creator, creatorB, trader]) await airdrop(conn, k.publicKey, 50);
    for (const vault of Object.values(rewardVaults())) await airdrop(conn, vault, 1);
    for (const program of ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"]) {
      await airdrop(conn, PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey(program))[0], 5);
    }
    const nvdax = new PublicKey(NVDAX_MINT);
    const ata = (owner) => getAssociatedTokenAddressSync(nvdax, owner, false, TOKEN_2022_PROGRAM_ID);
    const setup = new Transaction();
    for (const k of [trader, creator, collector]) setup.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(k.publicKey), k.publicKey, nvdax, TOKEN_2022_PROGRAM_ID));
    await sendTx(conn, setup, [payer]);
    for (const k of [trader, creator, collector]) {
      const acct = await getAccount(conn, ata(k.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
      if (acct.isFrozen) await sendTx(conn, new Transaction().add(createThawAccountInstruction(ata(k.publicKey), nvdax, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);
    }
    await sendTx(conn, new Transaction().add(createMintToInstruction(nvdax, ata(trader.publicKey), authority.publicKey, 200_000_000_000n, [], TOKEN_2022_PROGRAM_ID)), [payer, authority]);

    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
    };
    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "mainnet-beta", connection: ladderConn, payer, feeClaimer: collector.publicKey, client });
    const handle = createDbcCreateHandler({ env, db, connection: conn, client, ladder, requireWalletActionAuth: requireSignedBegin });

    async function launch(creator, feeChoice, creatorSharePct) {
      const ticker = `C${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
      if (!begun.body.ok) throw new Error(`begin ${JSON.stringify(begun.body)}`);
      const baseMint = Keypair.generate();
      const auth = await post(handle, {
        operation: "authorize", sessionToken: begun.body.sessionToken, mint: baseMint.publicKey.toBase58(), name: `NVDA ${feeChoice}`, symbol: ticker,
        targetUsd: 15000, feeChoice, creatorSharePct, firstBuyLamports: "0", quoteMint: NVDAX_MINT,
      });
      if (!auth.body.ok) throw new Error(`authorize ${JSON.stringify(auth.body)}`);
      const created = await submitPreparedDbcCreate({
        connection: conn, transaction: Transaction.from(Buffer.from(auth.body.transaction, "base64")),
        mintSecretKey: baseMint.secretKey, mintAddress: baseMint.publicKey.toBase58(),
        creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
        signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
      });
      const fin = await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
      if (!fin.body.ok) throw new Error(`finalize ${JSON.stringify(fin.body)}`);
      return { pool: auth.body.pool, mint: baseMint.publicKey, config: auth.body.config };
    }

    console.log("\n[two NVDAx coins: buyback, split 60%]");
    const coinB = await launch(creatorB, "buyback", null);
    const coinS = await launch(creator, "split", 60);
    const creatorMode = (await db.query(`select creator_fee_mode from public.dbc_launch_configs where config_address = $1`, [coinB.config])).rows[0]?.creator_fee_mode;
    check("platform choices launch on the platform config (creator fee to the collector)", creatorMode === "platform", creatorMode);

    const activation = Number((await client.state.getPool(new PublicKey(coinS.pool)))?.poolState.activationPoint || 0);
    for (;;) {
      const now = Number(await conn.getBlockTime(await conn.getSlot("confirmed")));
      if (now >= activation + 62) break;
      await sleep(2_000);
    }
    const trade = async (pool, side, amountIn) => {
      const built = await buildDbcSwapTransaction({ connection: conn, poolAddress: pool, trader: trader.publicKey.toBase58(), side, amountIn, env });
      await submitPreparedDbcTrade({
        connection: conn, transaction: built.tx, trader: trader.publicKey.toBase58(), pool,
        signTransaction: async (unsigned) => { unsigned.partialSign(trader); return unsigned; },
      });
    };
    for (const coin of [coinB, coinS]) {
      const base = getAssociatedTokenAddressSync(coin.mint, trader.publicKey);
      for (let round = 0; round < 3; round += 1) {
        await trade(coin.pool, "buy", 3_000_000_000n); // 30 NVDAx raw-whole
        const held = BigInt((await conn.getTokenAccountBalance(base)).value.amount);
        await trade(coin.pool, "sell", held);
      }
      await trade(coin.pool, "buy", 500_000_000n); // the trader keeps a holding for the snapshot
    }

    console.log("\n[fees: indexed, accrued, claimed; creator pots stay NVDAx]");
    const pools = (await loadDbcPools(db)).filter((p) => p.campaign === coinB.pool || p.campaign === coinS.pool);
    for (const p of pools) {
      let n = 0;
      for (let i = 0; i < 40 && n < 7; i += 1) {
        n += (await indexDbcPool(db, p)).ingested;
        if (n < 7) await sleep(2_000);
      }
      check(`indexed all 7 trades of ${p.campaign.slice(0, 6)}`, n === 7, String(n));
    }
    await accrueDbcFees(db);
    for (const coin of [coinB, coinS]) {
      await claimPoolPartnerFees({ db, connection: conn, collector, pool: coin.pool, send: true, minLamports: 1n, client });
    }
    await resolvePendingClaims({ db, connection: conn, client });
    for (let i = 0; i < 4; i += 1) {
      await routeClaimedAccruals({ db, connection: conn, collector, send: true, swapQuote: stubSwapQuote });
      await resolvePendingRoutes({ db, connection: conn });
    }
    let ledgers = await coinLedgers(db);
    const potB = ledgers.get(coinB.pool)?.total || 0n;
    const potS = ledgers.get(coinS.pool)?.total || 0n;
    const collectorNvdax = await nvdaxOf(conn, collector.publicKey);
    check("both pots are NVDAx on the collector", potB > 0n && potS > 0n && collectorNvdax >= potB + potS, `pots ${potB} + ${potS}, collector holds ${collectorNvdax}`);
    const heldSol = await heldCreatorPoolSum(db);
    check("no SOL is reserved for NVDAx pots", heldSol === 0n, String(heldSol));

    console.log("\n[buyback: NVDAx spent on the coin's own curve, burned in the same tx]");
    await ensureWeekSecrets(db, MASTER, new Date());
    const endOfToday = new Date(); endOfToday.setUTCHours(23, 59, 0, 0);
    const supplyBefore = (await getMint(conn, coinB.mint)).supply;
    const vaultBefore = BigInt((await conn.getTokenAccountBalance((await client.state.getPool(new PublicKey(coinB.pool)))?.poolState.quoteVault)).value.amount);
    const collectorBefore = await nvdaxOf(conn, collector.publicKey);
    const buys = await runDueBuybacks({ db, connection: conn, collector, masterSecret: MASTER, send: true, now: endOfToday, client });
    await resolvePendingPayouts(db, conn, collector.publicKey.toBase58());
    const bought = buys.find((b) => b.pool === coinB.pool);
    check("a buyback ran for the NVDAx coin", Boolean(bought?.signature), JSON.stringify(bought));
    const row = (await db.query(`select lamports::text spent, tokens_burned::text burned, status, quote_mint from public.dbc_creator_pool_payouts where pool = $1 and kind = 'buyback'`, [coinB.pool])).rows[0];
    const spent = BigInt(row?.spent || "0");
    const vaultAfter = BigInt((await conn.getTokenAccountBalance((await client.state.getPool(new PublicKey(coinB.pool)))?.poolState.quoteVault)).value.amount);
    check("buyback row landed, in NVDAx", row?.status === "landed" && row?.quote_mint === NVDAX_MINT, JSON.stringify(row));
    check("collector spent exactly the recorded NVDAx", collectorBefore - (await nvdaxOf(conn, collector.publicKey)) === spent, `${spent}`);
    check("the curve's NVDAx vault took in what was spent", vaultAfter > vaultBefore && vaultAfter - vaultBefore <= spent, `${vaultAfter - vaultBefore} of ${spent}`);
    const supplyAfter = (await getMint(conn, coinB.mint)).supply;
    check("tokens burned = supply drop, in the same tx", BigInt(row?.burned || "0") > 0n && supplyBefore - supplyAfter === BigInt(row.burned), `${row?.burned} vs ${supplyBefore - supplyAfter}`);
    ledgers = await coinLedgers(db);
    check("the buyback due fell by what was spent", dues({ choice: "buyback", creatorSharePct: 0, quoteMint: NVDAX_MINT }, ledgers.get(coinB.pool)).buyback === potB - spent);

    console.log("\n[weekly: creator 60% in NVDAx, holders 40% swapped to SOL, then the round]");
    const week = weekOf(new Date());
    const snapped = await takeDueSnapshots({ db, connection: conn, masterSecret: MASTER, excluded: new Set([collector.publicKey.toBase58()]), now: new Date(week.end.getTime() - 60_000) });
    check("holder snapshot taken for the split coin", snapped >= 1, String(snapped));
    const creatorBefore = await nvdaxOf(conn, creator.publicKey);
    const vaults = rewardVaults();
    const airdropBefore = BigInt(await conn.getBalance(vaults.airdrop));
    const weekly = await runWeeklyPayouts({ db, connection: conn, collector, send: true, now: new Date(week.end.getTime() + 3_600_000), swapQuote: stubSwapQuote });
    await resolvePendingPayouts(db, conn, collector.publicKey.toBase58());
    const creatorShare = (potS * 60n) / 100n;
    const creatorGot = (await nvdaxOf(conn, creator.publicKey)) - creatorBefore;
    check("split creator got 60% of the pot in NVDAx, exactly", creatorGot === creatorShare, `${creatorGot} vs ${creatorShare}`);
    const swapRow = (await db.query(`select lamports::text q, sol_received::text sol, status from public.dbc_creator_pool_payouts where pool = $1 and kind = 'holders_swap'`, [coinS.pool])).rows[0];
    check("holders' 40% swapped once, keyed", swapRow?.status === "landed" && BigInt(swapRow.q) === potS - creatorShare, JSON.stringify(swapRow));
    const round = (await db.query(`select total_lamports::text total, leaves, status from public.dbc_holder_rounds where week_id = $1`, [week.weekId])).rows[0];
    const leaves = round?.leaves?.leaves || [];
    const traderLeaf = leaves.find((l) => l.owner === trader.publicKey.toBase58());
    check("the round pays the SOL the swap brought, to the only holder", round?.status === "landed" && BigInt(round.total) === BigInt(swapRow?.sol || "0") && BigInt(traderLeaf?.amount || "0") === BigInt(round.total), JSON.stringify({ weekly, total: round?.total, leaves }));
    check("airdrop vault received the round", BigInt(await conn.getBalance(vaults.airdrop)) - airdropBefore === BigInt(round?.total || "0"));
    ledgers = await coinLedgers(db);
    const owed = dues({ choice: "split", creatorSharePct: 60, quoteMint: NVDAX_MINT }, ledgers.get(coinS.pool));
    check("split coin owes nothing more this week", owed.creator === 0n && owed.holders === 0n, `${owed.creator} / ${owed.holders}`);
    const rerun = await runWeeklyPayouts({ db, connection: conn, collector, send: true, now: new Date(week.end.getTime() + 3_600_000), swapQuote: stubSwapQuote });
    const swaps = (await db.query(`select count(*)::int n from public.dbc_quote_swaps where purpose_key like 'holders:%'`)).rows[0].n;
    check("a rerun of the week pays and swaps nothing twice", swaps === 1 && (await nvdaxOf(conn, creator.publicKey)) - creatorBefore === creatorShare, JSON.stringify(rerun));

    console.log("\n[after graduation: LP claim keeps the creator pot in NVDAx]");
    const cfgS = await client.state.getPoolConfig(new PublicKey(coinS.config));
    const threshold = BigInt(String((cfgS?.poolConfig ?? cfgS).migrationQuoteThreshold));
    const reserve = BigInt(String((await client.state.getPool(new PublicKey(coinS.pool)))?.poolState.quoteReserve));
    const fill = await client.pool.swap2({
      owner: trader.publicKey, pool: new PublicKey(coinS.pool), swapBaseForQuote: false, referralTokenAccount: null,
      swapMode: SwapMode.PartialFill, amountIn: new BN(((threshold - reserve) * 6n / 5n).toString()), minimumAmountOut: new BN(1),
    });
    fill.feePayer = trader.publicKey;
    await sendTx(conn, fill, [trader]);
    let job;
    for (let i = 0; i < 20; i += 1) {
      await runDbcGraduationOnce({ db, connection: conn, collector, send: true, pool: coinS.pool, swapQuote: stubSwapQuote });
      await resolvePendingGraduation({ db, connection: conn });
      job = (await db.query(`select * from public.dbc_graduation_jobs where pool = $1`, [coinS.pool])).rows[0];
      if (job?.status === "done") break;
      await sleep(600);
    }
    check("split coin graduated", job?.status === "done", `${job?.step} ${job?.status} ${job?.blocked_reason || ""}`);
    const cpAmm = new CpAmm(conn);
    const dpool = await cpAmm.fetchPoolState(new PublicKey(job.damm_pool));
    const swapTx = await cpAmm.swap({
      payer: trader.publicKey, pool: new PublicKey(job.damm_pool), inputTokenMint: nvdax, outputTokenMint: coinS.mint,
      amountIn: new BN(1_000_000_000), minimumAmountOut: new BN(1),
      tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint, tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
      tokenAProgram: getTokenProgram(dpool.tokenAFlag), tokenBProgram: getTokenProgram(dpool.tokenBFlag),
      referralTokenAccount: null, poolState: dpool,
    });
    swapTx.feePayer = trader.publicKey;
    await sendTx(conn, swapTx, [trader]);
    const potBeforeLp = (await coinLedgers(db)).get(coinS.pool)?.total || 0n;
    await runDbcLpClaimsOnce({ db, connection: conn, collector, send: true, pool: coinS.pool, swapQuote: stubSwapQuote });
    await resolvePendingLpClaims({ db, connection: conn, collector, send: true, swapQuote: stubSwapQuote });
    const lpJob = (await db.query(`select lp_claimed::text from public.dbc_graduation_jobs where pool = $1`, [coinS.pool])).rows[0];
    const claimedQuote = BigInt(lpJob?.lp_claimed || "0");
    const potAfterLp = (await coinLedgers(db)).get(coinS.pool)?.total || 0n;
    const lpSwap = (await db.query(`select quote_in::text q, sol_out::text sol from public.dbc_quote_swaps where purpose_key like 'lp:%'`)).rows[0];
    check("LP claim: creator pot grew by 80% of the NVDAx claimed, in NVDAx", claimedQuote > 0n && potAfterLp - potBeforeLp === (claimedQuote * 80n) / 100n, `${potAfterLp - potBeforeLp} of ${claimedQuote}`);
    check("LP claim: only our 20% was swapped to SOL", lpSwap && BigInt(lpSwap.q) === claimedQuote - (claimedQuote * 80n) / 100n && BigInt(lpSwap.sol) === BigInt(lpSwap.q) * STUB_SOL_PER_RAW, JSON.stringify(lpSwap));

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

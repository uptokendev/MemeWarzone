#!/usr/bin/env node
/**
 * Meteora DBC tiny test coin -- MAINNET, run from the founder's terminal only.
 *
 * Proves on mainnet what devnet cannot: that the launch shape we plan to ship is a normal
 * 2-signer create, that Jupiter routes the coin while it is still on the curve, and that the
 * fees land where the devnet rehearsal says they do.
 *
 * Shape (what most DBC launchpads do, read from 25 recent mainnet launches on 2026-09-28):
 *   tx A  createConfig  -- our server, ahead of time (payer + config key). Here: the payer.
 *   tx B  createPool    -- the creator's own transaction: creator wallet + new mint key.
 *
 * Economics: identical to the devnet rehearsal (2% fee, creator 7% of the post-Meteora 80%,
 * graduation fee 22% / 90% creator, graduated pool 0.25%, LP 80/20 locked). The threshold is
 * set high (100 SOL) so this coin never graduates by accident.
 *
 * Sends NOTHING without --send. The cluster is decided by the genesis hash the RPC reports.
 *
 *   DBC_CANARY_PAYER_KEYPAIR=<path> node canary-dbc-mainnet.mjs           # dry run
 *   DBC_CANARY_PAYER_KEYPAIR=<path> node canary-dbc-mainnet.mjs --send    # sends
 *
 * RPC: SOLANA_MAINNET_RPC_URL, else SOLANA_RPC_URL from frontend/.env.local.
 * Test keys + resumable state: ~/.config/memewarzone/dbc-mainnet-canary/.
 * Cost: about 0.06 SOL of rent and fees; the trade SOL comes back on the sell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  DynamicBondingCurveClient, buildCurve, deriveDbcPoolAddress,
  TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode,
  MigrationOption, MigrationFeeOption, MigratedCollectFeeMode, DammV2DynamicFeeMode, ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(os.homedir(), ".config/memewarzone/dbc-mainnet-canary");
const KEYS_PATH = path.join(DIR, "keys.json");
const STATE_PATH = path.join(DIR, "state.json");
const SEND = process.argv.includes("--send");

const FEE_BPS = 200;
const CREATOR_TRADING_PCT = 7;
const MIGRATION_FEE_PCT = 22;
const CREATOR_MIGRATION_PCT = 90;
const GRADUATED_POOL_FEE_BPS = 25;
const THRESHOLD_SOL = 100;
const BUY_LAMPORTS = 20_000_000n; // 0.02 SOL

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
};
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9);
const big = (v) => BigInt(v?.toString?.() ?? v ?? 0);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 }); };
const kp = (a) => Keypair.fromSecretKey(Uint8Array.from(a));

function rpcUrl() {
  if (process.env.SOLANA_MAINNET_RPC_URL) return process.env.SOLANA_MAINNET_RPC_URL;
  const env = fs.readFileSync(path.join(HERE, "../../frontend/.env.local"), "utf8");
  const m = env.match(/^SOLANA_RPC_URL=["']?([^"'\n]+)/m);
  if (!m) throw new Error("No SOLANA_MAINNET_RPC_URL and no SOLANA_RPC_URL in frontend/.env.local.");
  return m[1];
}

export function mwzCurve(thresholdSol) {
  return buildCurve({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: FEE_BPS, endingFeeBps: FEE_BPS, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: CREATOR_TRADING_PCT, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: MIGRATION_FEE_PCT, creatorFeePercentage: CREATOR_MIGRATION_PCT },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: GRADUATED_POOL_FEE_BPS },
    },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 20, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 80, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: thresholdSol,
  });
}

async function main() {
  const conn = new Connection(rpcUrl(), "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) throw new Error(`Refusing: RPC genesis ${genesis} is not mainnet-beta.`);
  if (!process.env.DBC_CANARY_PAYER_KEYPAIR) throw new Error("Set DBC_CANARY_PAYER_KEYPAIR to the paying keypair file.");
  const payer = kp(JSON.parse(fs.readFileSync(process.env.DBC_CANARY_PAYER_KEYPAIR, "utf8")));

  let raw = readJson(KEYS_PATH, null);
  if (!raw) {
    raw = Object.fromEntries(["collector", "creator", "trader", "config", "mint"].map((k) => [k, Array.from(Keypair.generate().secretKey)]));
    writeJson(KEYS_PATH, raw);
  }
  const K = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, kp(v)]));
  const state = readJson(STATE_PATH, {});
  const save = () => writeJson(STATE_PATH, state);

  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const config = K.config.publicKey;
  const baseMint = K.mint.publicKey;
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
  const poolState = async () => { const r = await client.state.getPool(pool); return r?.poolState ?? r; };

  console.log(`mainnet-beta ${genesis}   ${SEND ? "SENDING" : "DRY RUN (nothing is sent)"}`);
  console.log(`payer     ${payer.publicKey.toBase58()}  ${sol(await conn.getBalance(payer.publicKey))} SOL`);
  console.log(`collector ${K.collector.publicKey.toBase58()}  (test fee claimer + referral)`);
  console.log(`creator   ${K.creator.publicKey.toBase58()}`);
  console.log(`trader    ${K.trader.publicKey.toBase58()}`);
  console.log(`config    ${config.toBase58()}\nmint      ${baseMint.toBase58()}\npool      ${pool.toBase58()}`);

  // A confirmed transaction is not always readable on the next call: retry, never trust one read.
  async function getTx(sig) {
    for (let i = 0; i < 20; i++) {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (t) return t;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`transaction ${sig} not readable after 30 s`);
  }
  // Token amount that moved into (+) or out of (-) an account in one transaction, from its own meta.
  async function tokenDelta(sig, account) {
    const t = await getTx(sig);
    const keys = t.transaction.message.staticAccountKeys || t.transaction.message.accountKeys;
    const i = keys.findIndex((k) => k.equals(account));
    const pick = (l) => BigInt(l.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
    return pick(t.meta.postTokenBalances) - pick(t.meta.preTokenBalances);
  }

  async function shape(tx, signers) {
    tx.feePayer = tx.feePayer || signers[0].publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    const bytes = tx.serialize().length;
    const m = tx.compileMessage(); const h = m.header; const n = m.accountKeys.length;
    return { bytes, accounts: n, writable: (h.numRequiredSignatures - h.numReadonlySignedAccounts) + (n - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts), signers: h.numRequiredSignatures, ix: m.instructions.length };
  }
  async function run(step, build, signers) {
    if (state.sigs?.[step]) { console.log(`  skip ${step} (done: ${state.sigs[step]})`); return state.sigs[step]; }
    const tx = await build();
    const s = await shape(tx, signers);
    console.log(`  ${step}: ${JSON.stringify(s)}`);
    if (!SEND) {
      const sim = await conn.simulateTransaction(tx);
      console.log(`  simulate ${step}: ${sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : `ok, ${sim.value.unitsConsumed} CU`}`);
      if (sim.value.err) console.log(sim.value.logs?.slice(-8).join("\n"));
      return null;
    }
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    state.sigs = { ...(state.sigs || {}), [step]: sig }; state.shapes = { ...(state.shapes || {}), [step]: s }; save();
    console.log(`  sig ${step}: ${sig}`);
    return sig;
  }

  const curve = mwzCurve(THRESHOLD_SOL);

  // Dry run: the two launch transactions cannot be simulated separately before the config
  // exists, so prove the pair with the combined form and stop.
  if (!SEND) {
    console.log("\n[dry] launch pair, simulated as one transaction");
    await run("dry-create", () => client.partner.createConfigAndPool({
      config, feeClaimer: K.collector.publicKey, leftoverReceiver: K.collector.publicKey, quoteMint: NATIVE_MINT, payer: payer.publicKey, ...curve,
      preCreatePoolParam: { name: "MWZ Test", symbol: "MWZTEST", uri: "https://memewar.zone/", poolCreator: K.creator.publicKey, baseMint },
    }), [payer, K.config, K.mint, K.creator]);
    console.log("\nDry run only. Re-run with --send to launch the test coin.");
    return;
  }

  console.log("\n[1] fund test wallets");
  const want = { creator: 30_000_000n, trader: BUY_LAMPORTS + 30_000_000n };
  const fund = new Transaction();
  for (const [name, amt] of Object.entries(want)) {
    const have = BigInt(await conn.getBalance(K[name].publicKey));
    if (have < amt) fund.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: K[name].publicKey, lamports: amt - have }));
  }
  const refAta = getAssociatedTokenAddressSync(NATIVE_MINT, K.collector.publicKey);
  fund.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, refAta, K.collector.publicKey, NATIVE_MINT));
  console.log(`  ${await sendAndConfirmTransaction(conn, fund, [payer], { commitment: "confirmed" })}`);

  console.log("\n[2] config (our server's transaction)");
  await run("config", () => client.partner.createConfig({ config, feeClaimer: K.collector.publicKey, leftoverReceiver: K.collector.publicKey, quoteMint: NATIVE_MINT, payer: payer.publicKey, ...curve }), [payer, K.config]);

  console.log("\n[3] create pool (the creator's transaction: wallet + mint key)");
  await run("pool", () => client.creator.createPool({ name: "MWZ Test", symbol: "MWZTEST", uri: "https://memewar.zone/", payer: K.creator.publicKey, poolCreator: K.creator.publicKey, config, baseMint }), [K.creator, K.mint]);
  check("creator transaction has exactly 2 signers", state.shapes.pool.signers === 2, JSON.stringify(state.shapes.pool));

  const snap = (p) => ({ partner: big(p.partnerQuoteFee), creator: big(p.creatorQuoteFee), protocol: big(p.protocolQuoteFee), reserve: big(p.quoteReserve) });

  console.log(`\n[4] buy ${sol(BUY_LAMPORTS)} SOL with our referral`);
  if (!state.sigs?.buy) {
    const before = snap(await poolState());
    const buySig = await run("buy", () => client.pool.swap({ owner: K.trader.publicKey, pool, amountIn: new BN(BUY_LAMPORTS.toString()), minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: refAta }), [K.trader]);
    const after = snap(await poolState());
    const referral = await tokenDelta(buySig, refAta);
    const total = (after.partner - before.partner) + (after.creator - before.creator) + (after.protocol - before.protocol) + referral;
    console.log(`  fee ${total}: collector ${after.partner - before.partner}, creator ${after.creator - before.creator}, meteora ${after.protocol - before.protocol}, referral ${referral}`);
    check("fee is 2% of the buy", total === (BUY_LAMPORTS * 2n) / 100n);
    check("referral is 20% of Meteora's 20%", referral === (total * 20n / 100n) * 20n / 100n);
    check("creator is 7% of the post-Meteora 80%", (after.creator - before.creator) === ((after.partner - before.partner) + (after.creator - before.creator)) * 7n / 100n);
  }

  console.log("\n[5] Jupiter: does it route this coin on the curve? (polls up to 10 minutes)");
  let route = null;
  for (let i = 0; i < 20 && !route; i++) {
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${NATIVE_MINT.toBase58()}&outputMint=${baseMint.toBase58()}&amount=5000000&slippageBps=500`).then((r) => r.json()).catch((e) => ({ error: e.message }));
    if (res?.routePlan?.length) route = res.routePlan.map((r) => r.swapInfo?.label).join(" -> ");
    else { console.log(`  not yet: ${res?.error || res?.errorCode || "no route"}`); await new Promise((r) => setTimeout(r, 30_000)); }
  }
  check("Jupiter quotes SOL -> test coin", Boolean(route), route || "no route after 10 minutes");
  state.jupiterRoute = route; save();

  console.log("\n[6] sell half back");
  const traderAta = getAssociatedTokenAddressSync(baseMint, K.trader.publicKey);
  if (!state.sigs?.sell) {
    const held = BigInt((await conn.getTokenAccountBalance(traderAta)).value.amount);
    await run("sell", () => client.pool.swap({ owner: K.trader.publicKey, pool, amountIn: new BN((held / 2n).toString()), minimumAmountOut: new BN(1), swapBaseForQuote: true, referralTokenAccount: refAta }), [K.trader]);
  }

  console.log("\n[7] claim trading fees (measured at the pool vault)");
  for (const who of ["collector", "creator"]) {
    const step = `claim-${who}`;
    if (state.sigs?.[step]) { console.log(`  skip ${step}`); continue; }
    const p = await poolState();
    const owed = who === "collector" ? p.partnerQuoteFee : p.creatorQuoteFee;
    const sig = await run(step, async () => {
      const tx = who === "collector"
        ? await client.partner.claimPartnerTradingFee({ feeClaimer: K.collector.publicKey, payer: payer.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: owed })
        : await client.creator.claimCreatorTradingFee({ creator: K.creator.publicKey, payer: payer.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: owed });
      tx.feePayer = payer.publicKey; return tx;
    }, [payer, who === "collector" ? K.collector : K.creator]);
    const out = -(await tokenDelta(sig, p.quoteVault));
    check(`${who} received exactly what the pool owed`, out === big(owed), `owed ${big(owed)}, paid ${out}`);
  }

  console.log(`\nPhantom check: open https://jup.ag/swap/SOL-${baseMint.toBase58()} in Phantom and buy 0.005 SOL.`);
  console.log(`Explorer: https://solscan.io/token/${baseMint.toBase58()}`);
  console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS"}\nstate: ${STATE_PATH}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e?.logs ? `${e.message}\n${e.logs.join("\n")}` : e); process.exit(1); });

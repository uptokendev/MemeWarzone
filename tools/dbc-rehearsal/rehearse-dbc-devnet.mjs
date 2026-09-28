#!/usr/bin/env node
/**
 * Meteora DBC dress rehearsal -- DEVNET ONLY.
 *
 * Runs the whole life of one coin on the launch type we are evaluating and checks every fee
 * against the program's own accounting:
 *   config + launch (one transaction) -> buys (with and without referral) -> sell
 *   -> partner + creator trading-fee claims -> buy to completion -> migrate to DAMM v2
 *   -> partner + creator migration-fee withdrawals -> surplus -> DAMM v2 trade -> LP fee claims.
 *
 * Economics under test (founder, 2026-09-28):
 *   2% trading fee; Meteora keeps 20% of it (a referral account gets 20% of Meteora's cut);
 *   creator gets 7% of the remaining 80%; graduation fee 22% of the threshold, 90% to the creator;
 *   graduated pool 0.25%, LP 80% creator / 20% partner, both permanently locked.
 *
 * The cluster is decided by the genesis hash the RPC reports, never by the URL. Anything but
 * devnet is refused. Keys live in ~/.config/memewarzone/solana-devnet/dbc-rehearsal/ and every
 * step records its signature in state.json, so an interrupted run resumes where it stopped.
 *
 *   node rehearse-dbc-devnet.mjs            # run / resume
 *   node rehearse-dbc-devnet.mjs --fresh    # new coin, new config (keys are kept)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  DynamicBondingCurveClient, buildCurve, DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDbcPoolAddress, deriveDammV2PoolAddress,
  TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode,
  MigrationOption, MigrationFeeOption, MigratedCollectFeeMode, DammV2DynamicFeeMode,
  ActivationType, SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RPC = process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const HOME = os.homedir();
const DEPLOYER_PATH = path.join(HOME, ".config/memewarzone/solana-devnet/deployer.json");
const DIR = path.join(HOME, ".config/memewarzone/solana-devnet/dbc-rehearsal");
const KEYS_PATH = path.join(DIR, "keys.json");
const STATE_PATH = path.join(DIR, "state.json");

// The economics under test.
const FEE_BPS = 200;
const CREATOR_TRADING_PCT = 7;
const MIGRATION_FEE_PCT = 22;
const CREATOR_MIGRATION_PCT = 90;
const GRADUATED_POOL_FEE_BPS = 25;
const THRESHOLD_SOL = 1.5;
const THRESHOLD = BigInt(Math.round(THRESHOLD_SOL * LAMPORTS_PER_SOL));

const argv = new Set(process.argv.slice(2));
const failures = [];

function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
const big = (v) => BigInt(v?.toString?.() ?? v ?? 0);
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9);

function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}
function near(a, b, tol = 1n) {
  const d = a > b ? a - b : b - a;
  return d <= tol;
}

function keys() {
  let raw = readJson(KEYS_PATH, null);
  if (!raw) {
    raw = Object.fromEntries(["partner", "creator", "trader"].map((k) => [k, Array.from(Keypair.generate().secretKey)]));
    writeJson(KEYS_PATH, raw);
  }
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Keypair.fromSecretKey(Uint8Array.from(v))]));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`Refusing: RPC genesis ${genesis} is not devnet.`);

  const deployer = loadKeypair(DEPLOYER_PATH);
  const { partner, creator, trader } = keys();
  let state = argv.has("--fresh") ? {} : readJson(STATE_PATH, {});
  const save = () => writeJson(STATE_PATH, state);
  const log = (step, sig) => { state.sigs = { ...(state.sigs || {}), [step]: sig }; save(); console.log(`  sig ${step}: ${sig}`); };

  console.log(`devnet ${genesis}`);
  console.log(`payer   ${deployer.publicKey.toBase58()}  ${sol(await conn.getBalance(deployer.publicKey))} SOL`);
  console.log(`partner ${partner.publicKey.toBase58()}  (fee claimer = our collector)`);
  console.log(`creator ${creator.publicKey.toBase58()}`);
  console.log(`trader  ${trader.publicKey.toBase58()}`);

  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const cpAmm = new CpAmm(conn);

  async function send(step, tx, signers) {
    if (state.sigs?.[step]) { console.log(`  skip ${step} (done: ${state.sigs[step]})`); return state.sigs[step]; }
    tx.feePayer = tx.feePayer || signers[0].publicKey;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    log(step, sig);
    return sig;
  }
  async function wsolBalance(owner) {
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    const info = await conn.getTokenAccountBalance(ata).catch(() => null);
    return info ? BigInt(info.value.amount) : 0n;
  }
  async function tokenBalance(mint, owner) {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const info = await conn.getTokenAccountBalance(ata).catch(() => null);
    return info ? BigInt(info.value.amount) : 0n;
  }
  const quoteValue = async (owner) => BigInt(await conn.getBalance(owner)) + await wsolBalance(owner);
  // What left a pool vault in one transaction. Wallet deltas also carry rent from temporary WSOL
  // accounts, so every claim is measured at the vault instead.
  async function vaultOutflow(sig, vault) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx.transaction.message.getAccountKeys ? tx.transaction.message.getAccountKeys().staticAccountKeys : tx.transaction.message.accountKeys;
    const idx = keys.findIndex((k) => k.equals(vault));
    const pick = (list) => BigInt(list.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? 0);
    return pick(tx.meta.preTokenBalances) - pick(tx.meta.postTokenBalances);
  }
  async function txShape(sig) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const m = tx.transaction.message;
    const bytes = m.serialize().length + 1 + 64 * tx.transaction.signatures.length;
    const h = m.header;
    const n = (m.staticAccountKeys || m.accountKeys).length;
    const writable = (h.numRequiredSignatures - h.numReadonlySignedAccounts) + (n - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts);
    return { bytes, accounts: n, writable, signers: h.numRequiredSignatures, ix: m.compiledInstructions?.length ?? m.instructions.length };
  }

  // 1. Fund the three wallets from the devnet deployer.
  console.log("\n[1] fund");
  const want = {
    partner: 50_000_000n,
    creator: 50_000_000n,
    trader: THRESHOLD + THRESHOLD / 5n + 400_000_000n,
  };
  const fund = new Transaction();
  for (const [name, kp] of Object.entries({ partner, creator, trader })) {
    const have = BigInt(await conn.getBalance(kp.publicKey));
    if (have < want[name]) fund.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: want[name] - have }));
  }
  if (fund.instructions.length) {
    const sig = await sendAndConfirmTransaction(conn, fund, [deployer], { commitment: "confirmed" });
    console.log(`  funded: ${sig}`);
  } else console.log("  already funded");

  // 2. Config + pool in one transaction.
  console.log("\n[2] create config + pool");
  if (!state.config) {
    const configKp = Keypair.generate();
    const mintKp = Keypair.generate();
    state = { ...state, configSecret: Array.from(configKp.secretKey), mintSecret: Array.from(mintKp.secretKey), config: configKp.publicKey.toBase58(), baseMint: mintKp.publicKey.toBase58() };
    save();
  }
  const configKp = Keypair.fromSecretKey(Uint8Array.from(state.configSecret));
  const mintKp = Keypair.fromSecretKey(Uint8Array.from(state.mintSecret));
  const config = configKp.publicKey;
  const baseMint = mintKp.publicKey;
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
  state.pool = pool.toBase58(); save();

  const curve = buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: FEE_BPS, endingFeeBps: FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: CREATOR_TRADING_PCT,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: MIGRATION_FEE_PCT, creatorFeePercentage: CREATOR_MIGRATION_PCT },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: GRADUATED_POOL_FEE_BPS,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 20,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 80,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: THRESHOLD_SOL,
  });

  if (!state.sigs?.create) {
    const tx = await client.partner.createConfigAndPool({
      config,
      feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey,
      quoteMint: NATIVE_MINT,
      payer: deployer.publicKey,
      ...curve,
      preCreatePoolParam: {
        name: "MWZ DBC Rehearsal",
        symbol: "MWZDBC",
        uri: "https://memewar.zone/",
        poolCreator: creator.publicKey,
        baseMint,
      },
    });
    const sig = await send("create", tx, [deployer, configKp, mintKp, creator]);
    const txInfo = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    void txInfo;
    state.shapeCreate = await txShape(sig); save();
  }
  const cfg = await client.state.getPoolConfig(config);
  const threshold = big(cfg.migrationQuoteThreshold);
  console.log(`  config ${config.toBase58()}  pool ${pool.toBase58()}  mint ${baseMint.toBase58()}`);
  check("config threshold is the requested one", threshold === THRESHOLD, `${sol(threshold)} SOL`);
  check("creator trading fee % stored", Number(cfg.creatorTradingFeePercentage) === CREATOR_TRADING_PCT);
  check("migration fee % stored", Number(cfg.migrationFeePercentage) === MIGRATION_FEE_PCT && Number(cfg.creatorMigrationFeePercentage) === CREATOR_MIGRATION_PCT);
  check("fee claimer is our collector", cfg.feeClaimer.equals(partner.publicKey));

  // SDK 1.5.x wraps the account: getPool -> { poolState }.
  const quoteVault = (await (async () => { const r = await client.state.getPool(pool); return r?.poolState ?? r; })()).quoteVault;
  const poolState = async () => { const r = await client.state.getPool(pool); return r?.poolState ?? r; };
  const snapshot = (p) => ({
    partner: big(p.partnerQuoteFee), creator: big(p.creatorQuoteFee), protocol: big(p.protocolQuoteFee),
    reserve: big(p.quoteReserve), progress: Number(p.migrationProgress), migrated: Number(p.isMigrated),
  });

  function checkSplit(label, before, after, referral, grossBase) {
    const dPartner = after.partner - before.partner;
    const dCreator = after.creator - before.creator;
    const dProtocol = after.protocol - before.protocol;
    const total = dPartner + dCreator + dProtocol + referral;
    const protocolRaw = dProtocol + referral;
    const trading = dPartner + dCreator;
    console.log(`  fee ${total}: partner ${dPartner}, creator ${dCreator}, meteora ${dProtocol}, referral ${referral}`);
    check(`${label}: fee is ${FEE_BPS / 100}% of ${grossBase}`, near(total, (grossBase * BigInt(FEE_BPS)) / 10_000n, 1n), `${total} vs ${(grossBase * BigInt(FEE_BPS)) / 10_000n}`);
    check(`${label}: Meteora share is 20% of the fee`, protocolRaw === (total * 20n) / 100n);
    check(`${label}: referral is 20% of Meteora's share`, referral === (referral ? (protocolRaw * 20n) / 100n : 0n));
    check(`${label}: creator is ${CREATOR_TRADING_PCT}% of the remaining 80%`, dCreator === (trading * BigInt(CREATOR_TRADING_PCT)) / 100n);
    return { total, dPartner, dCreator, dProtocol, referral };
  }

  // 3. Buy without referral (a Jupiter-style trade that names no referrer).
  const traderAta = getAssociatedTokenAddressSync(baseMint, trader.publicKey);
  console.log("\n[3] buy 0.1 SOL, no referral");
  if (!state.sigs?.buy1) {
    const before = snapshot(await poolState());
    const amountIn = new BN(100_000_000);
    const tx = await client.pool.swap({ owner: trader.publicKey, pool, amountIn, minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null });
    const sig1 = await send("buy1", tx, [trader]);
    state.shapeBuy = await txShape(sig1);
    state.split1 = Object.fromEntries(Object.entries(checkSplit("buy1", before, snapshot(await poolState()), 0n, 100_000_000n)).map(([k, v]) => [k, v.toString()]));
    save();
  } else console.log("  done");

  // 4. Buy with our collector as referral: Meteora hands 20% of its cut to that account.
  console.log("\n[4] buy 0.1 SOL, referral = our collector's WSOL account");
  const referralAta = getAssociatedTokenAddressSync(NATIVE_MINT, partner.publicKey);
  if (!state.sigs?.buy2) {
    const ataTx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, referralAta, partner.publicKey, NATIVE_MINT));
    await sendAndConfirmTransaction(conn, ataTx, [deployer], { commitment: "confirmed" });
    const before = snapshot(await poolState());
    const refBefore = await wsolBalance(partner.publicKey);
    const tx = await client.pool.swap({ owner: trader.publicKey, pool, amountIn: new BN(100_000_000), minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: referralAta });
    await send("buy2", tx, [trader]);
    const referral = (await wsolBalance(partner.publicKey)) - refBefore;
    state.split2 = Object.fromEntries(Object.entries(checkSplit("buy2", before, snapshot(await poolState()), referral, 100_000_000n)).map(([k, v]) => [k, v.toString()]));
    save();
  } else console.log("  done");

  // 5. Sell half of what the trader holds. Fee is taken from the SOL that comes out.
  console.log("\n[5] sell half the trader's tokens");
  if (!state.sigs?.sell) {
    const held = await tokenBalance(baseMint, trader.publicKey);
    const before = snapshot(await poolState());
    const reserveBefore = before.reserve;
    const tx = await client.pool.swap({ owner: trader.publicKey, pool, amountIn: new BN((held / 2n).toString()), minimumAmountOut: new BN(1), swapBaseForQuote: true, referralTokenAccount: null });
    await send("sell", tx, [trader]);
    const after = snapshot(await poolState());
    const gross = reserveBefore - after.reserve; // SOL that left the curve, fee included
    state.split3 = Object.fromEntries(Object.entries(checkSplit("sell", before, after, 0n, gross)).map(([k, v]) => [k, v.toString()]));
    save();
  } else console.log("  done");

  // 6. Claim the partner and creator trading fees.
  console.log("\n[6] claim trading fees");
  for (const [who, kp, fn] of [["partner", partner, "claimPartnerTradingFee"], ["creator", creator, "claimCreatorTradingFee"]]) {
    const step = `claim-${who}`;
    if (state.sigs?.[step]) { console.log(`  skip ${step}`); continue; }
    const p = snapshot(await poolState());
    const owed = who === "partner" ? p.partner : p.creator;
    const before = await quoteValue(kp.publicKey);
    const params = who === "partner"
      ? { feeClaimer: kp.publicKey, payer: deployer.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN(owed.toString()) }
      : { creator: kp.publicKey, payer: deployer.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN(owed.toString()) };
    const tx = await (who === "partner" ? client.partner : client.creator)[fn](params);
    tx.feePayer = deployer.publicKey;
    const sig = await send(step, tx, [deployer, kp]);
    void before;
    const got = await vaultOutflow(sig, quoteVault);
    const left = snapshot(await poolState());
    check(`${who} claimed exactly what the pool owed`, got === owed, `owed ${owed}, received ${got}`);
    check(`${who} fee counter is zero after claim`, (who === "partner" ? left.partner : left.creator) === 0n);
  }

  // 7. Buy to completion. PartialFill takes only what the curve needs and refunds the rest.
  console.log("\n[7] buy to completion (PartialFill)");
  if (!state.sigs?.complete) {
    const p = snapshot(await poolState());
    const need = threshold - p.reserve;
    const amountIn = need + need / 5n + 10_000_000n;
    const before = await quoteValue(trader.publicKey);
    const tx = await client.pool.swap2({ owner: trader.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.PartialFill, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(1) });
    await send("complete", tx, [trader]);
    const spent = before - (await quoteValue(trader.publicKey));
    const after = snapshot(await poolState());
    console.log(`  offered ${sol(amountIn)} SOL, spent ${sol(spent)} SOL (incl. tx fee + rent), reserve ${sol(after.reserve)} / ${sol(threshold)}`);
    check("curve complete: reserve >= threshold", after.reserve >= threshold);
    check("PartialFill did not take the whole offer", spent < amountIn);
    state.reserveAtCompletion = after.reserve.toString(); save();
  } else console.log("  done");

  // 8. Migrate to DAMM v2 on the customizable graduated-pool config. We do this ourselves:
  //    Meteora's keepers only migrate from 10 SOL / 750 USDC upwards.
  console.log("\n[8] migrate to DAMM v2");
  const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.Customizable]);
  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, NATIVE_MINT);
  state.dammPool = dammPool.toBase58(); save();
  if (!state.sigs?.migrate) {
    const p = await poolState();
    console.log(`  migrationProgress ${p.migrationProgress}`);
    if (Number(p.migrationProgress) === 1) {
      const lockTx = await client.migration.createLocker({ payer: deployer.publicKey, pool });
      await send("locker", lockTx, [deployer]);
    }
    const res = await client.migration.migrateToDammV2({ payer: deployer.publicKey, pool, dammConfig });
    await send("migrate", res.transaction, [deployer, res.firstPositionNftKeypair, res.secondPositionNftKeypair]);
  } else console.log("  done");
  const migrated = snapshot(await poolState());
  check("virtual pool marked migrated", migrated.migrated === 1 && migrated.progress === 3, `isMigrated ${migrated.migrated}, progress ${migrated.progress}`);

  const dpool = await cpAmm.fetchPoolState(dammPool);
  // cp-amm 1.4 keeps the base fee as raw bytes; the first u64 is the cliff fee numerator.
  const feeNum = Buffer.from(dpool.poolFees.baseFee.baseFeeInfo.data).readBigUInt64LE(0);
  console.log(`  DAMM v2 pool ${dammPool.toBase58()}  collectFeeMode ${dpool.collectFeeMode}  liquidity ${dpool.liquidity}  permanentLocked ${dpool.permanentLockLiquidity}`);
  check("graduated pool fee is 0.25%", feeNum === 2_500_000n, `cliffFeeNumerator ${feeNum}`);
  check("all pool liquidity is permanently locked", big(dpool.permanentLockLiquidity) === big(dpool.liquidity));
  const vaultA = BigInt((await conn.getTokenAccountBalance(dpool.tokenAVault)).value.amount);
  const vaultB = BigInt((await conn.getTokenAccountBalance(dpool.tokenBVault)).value.amount);
  const migrationFee = threshold - (threshold * BigInt(100 - MIGRATION_FEE_PCT) + 99n) / 100n;
  const intoPool = threshold - migrationFee;
  console.log(`  pool vaults: ${vaultA} base / ${sol(vaultB)} SOL; migrated quote before Meteora's 0.2% = ${sol(intoPool)}`);
  const ps = await poolState();
  check("Meteora's migration liquidity fee is 0.2% of the migrated quote", big(ps.protocolMigrationQuoteFeeAmount) === (intoPool * 20n) / 10_000n, `${big(ps.protocolMigrationQuoteFeeAmount)}`);
  check("graduated pool collects fees in SOL only", dpool.collectFeeMode === 1 && dpool.tokenBMint.equals(NATIVE_MINT));
  check("pool received threshold minus 22% (less Meteora's <=0.2% liquidity fee)", vaultB <= intoPool && vaultB >= intoPool - (intoPool * 20n) / 10_000n - 1n, `${vaultB} vs ${intoPool}`);
  state.meteoraMigrationQuoteFee = (intoPool - vaultB).toString(); save();

  // 9. Migration fee: 22% of the threshold, 90% creator / 10% partner.
  console.log("\n[9] withdraw migration fees");
  const creatorMig = (migrationFee * BigInt(CREATOR_MIGRATION_PCT)) / 100n;
  const partnerMig = migrationFee - creatorMig;
  for (const [who, kp] of [["partner", partner], ["creator", creator]]) {
    const step = `migfee-${who}`;
    if (state.sigs?.[step]) { console.log(`  skip ${step}`); continue; }
    const before = await quoteValue(kp.publicKey);
    const tx = await (who === "partner" ? client.partner.partnerWithdrawMigrationFee({ pool, sender: kp.publicKey }) : client.creator.creatorWithdrawMigrationFee({ pool, sender: kp.publicKey }));
    tx.feePayer = deployer.publicKey;
    const sig = await send(step, tx, [deployer, kp]);
    void before;
    const got = await vaultOutflow(sig, quoteVault);
    const want = who === "partner" ? partnerMig : creatorMig;
    check(`${who} migration fee`, got === want, `received ${got}, expected ${want} of ${migrationFee}`);
  }

  // 10. Surplus: whatever the completing buy put above the threshold.
  console.log("\n[10] surplus");
  const surplus = big(state.reserveAtCompletion) - threshold;
  console.log(`  surplus above threshold: ${surplus} lamports`);
  if (surplus > 0n) {
    for (const [who, kp] of [["partner", partner], ["creator", creator]]) {
      const step = `surplus-${who}`;
      if (state.sigs?.[step]) continue;
      const before = await quoteValue(kp.publicKey);
      const tx = await (who === "partner" ? client.partner.partnerWithdrawSurplus({ feeClaimer: kp.publicKey, pool }) : client.creator.creatorWithdrawSurplus({ creator: kp.publicKey, pool }));
      tx.feePayer = deployer.publicKey;
      await send(step, tx, [deployer, kp]).catch((e) => console.log(`  ${who} surplus: ${e.message.split("\n")[0]}`));
      console.log(`  ${who} surplus received ${(await quoteValue(kp.publicKey)) - before}`);
    }
  }

  // 11. Trade on the graduated pool, then both locked positions claim their LP fees.
  console.log("\n[11] DAMM v2 trade + LP fee claims");
  const tokenAIsBase = dpool.tokenAMint.equals(baseMint);
  if (!state.sigs?.["damm-buy"]) {
    const tx = await cpAmm.swap({
      payer: trader.publicKey, pool: dammPool,
      inputTokenMint: NATIVE_MINT, outputTokenMint: baseMint,
      amountIn: new BN(200_000_000), minimumAmountOut: new BN(1),
      tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint,
      tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null, poolState: dpool,
    });
    await send("damm-buy", tx, [trader]);
  }
  const lp = {};
  for (const [who, kp] of [["creator", creator], ["partner", partner]]) {
    const positions = await cpAmm.getUserPositionByPool(dammPool, kp.publicKey);
    check(`${who} owns one position in the graduated pool`, positions.length === 1, `${positions.length}`);
    if (!positions.length) continue;
    const pos = positions[0];
    lp[who] = { liquidity: big(pos.positionState.permanentLockedLiquidity) };
    const step = `lp-${who}`;
    if (state.sigs?.[step]) continue;
    const before = await quoteValue(kp.publicKey);
    const tx = await cpAmm.claimPositionFee({
      owner: kp.publicKey, position: pos.position, pool: dammPool, positionNftAccount: pos.positionNftAccount,
      tokenAMint: dpool.tokenAMint, tokenBMint: dpool.tokenBMint, tokenAVault: dpool.tokenAVault, tokenBVault: dpool.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, feePayer: deployer.publicKey,
    });
    tx.feePayer = deployer.publicKey;
    const sig = await send(step, tx, [deployer, kp]);
    void before;
    lp[who].claimed = await vaultOutflow(sig, tokenAIsBase ? dpool.tokenBVault : dpool.tokenAVault);
    state[`lpClaimed_${who}`] = lp[who].claimed.toString(); save();
  }
  if (lp.creator?.claimed != null && lp.partner?.claimed != null) {
    const totalLiq = lp.creator.liquidity + lp.partner.liquidity;
    const totalFee = lp.creator.claimed + lp.partner.claimed;
    console.log(`  LP fees: creator ${lp.creator.claimed}, partner ${lp.partner.claimed}; liquidity creator ${lp.creator.liquidity}, partner ${lp.partner.liquidity}`);
    check("creator holds 80% of locked liquidity", near(lp.creator.liquidity * 100n, totalLiq * 80n, totalLiq / 1000n));
    check("LP fees paid in proportion to liquidity (80/20)", totalFee > 0n && near(lp.creator.claimed * 100n, totalFee * 80n, 200n));

  }

  console.log(`\ntx shape create: ${JSON.stringify(state.shapeCreate)}\ntx shape buy:    ${JSON.stringify(state.shapeBuy)}`);
  console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS"}`);
  console.log(`state: ${STATE_PATH}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e?.logs ? `${e.message}\n${e.logs.join("\n")}` : e); process.exit(1); });

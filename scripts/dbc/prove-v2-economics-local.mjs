/**
 * DBC v2 economics (founder 2026-10-08), proven on a local validator loaded with mainnet's DBC, DAMM v2,
 * Metaplex and locker programs, BEFORE any production code changes:
 *   - graduation by market cap: $30K (fast) and $50K (normal), $15K dropped
 *   - 1B supply: 85% on the curve, 13% to the graduated pool, 2% creator reserve (locked vesting, as today)
 *   - graduation (migration) fee 2%, creator share 0% (all of it to our partner side / fee routing)
 *   - creator first buy up to 70% of supply for everyone, in the launch transaction
 * Everything else is today's production config (fees, anti-sniper, liquidity split, pool fee), taken from
 * buildLaunchConfigParams; only curve, supply, threshold and migration fee are replaced by the SDK's buildCurve.
 *
 * Per target: createConfig -> createPoolWithFirstBuy (70%) -> a public PartialFill buy completes the curve
 * -> createLocker -> migrateToDammV2 (mainnet DAMM config A8gMr...) -> partnerWithdrawMigrationFee.
 * Every number is read back from the chain and checked against the plan.
 */
import { createRequire } from "node:module";
const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const BN = requireFromFrontend("bn.js");
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } = requireFromFrontend("@solana/web3.js");
const { getAccount, getAssociatedTokenAddressSync, getMint, NATIVE_MINT } = requireFromFrontend("@solana/spl-token");
const {
  DynamicBondingCurveClient, SwapMode, buildCurve, deriveDbcPoolAddress, deriveDammV2PoolAddress, getPriceFromSqrtPrice,
  validateConfigParameters, getMigrationThresholdPrice, getInitialLiquidityFromDeltaQuote, getDeltaAmountBaseUnsigned256,
  getBaseTokenForSwap, getSwapAmountWithBuffer, getTotalVestingAmount, MIN_SQRT_PRICE, MAX_SQRT_PRICE, Rounding,
} = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const { CpAmm } = requireFromFrontend("@meteora-ag/cp-amm-sdk");
import { buildLaunchConfigParams, quoteAlongDbcCurve } from "../../frontend/api/lib/dbc/dbcLaunchConfigParams.mjs";
import * as E from "../../frontend/shared/dbcEconomics.mjs";

const RPC = process.env.DBC_LOCAL_RPC || "http://127.0.0.1:18899";
const DAMM_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
const SOL_USD = 120.4;
const STEP_USD_MICROS = 120_400_000n;
const SUPPLY = 1_000_000_000;
const CURVE_PCT = 85, POOL_PCT = 13, RESERVE_PCT = 2, GRAD_FEE_PCT = 2, FIRST_BUY_PCT = 70;

const conn = new Connection(RPC, "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail !== "" ? `  [${detail}]` : ""}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const send = async (tx, signers) => {
  tx.feePayer ||= signers[0].publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: false });
  const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  return { sig, fee: got?.meta?.fee ?? 0, size: tx.serialize().length, accounts: tx.compileMessage().accountKeys.length, signers: tx.signatures.length };
};
const fund = async (pk, sol) => {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
};
const tokenBalance = async (owner, mint) => {
  try { return Number((await getAccount(conn, getAssociatedTokenAddressSync(mint, owner, true))).amount); } catch { return 0; }
};

function v2ConfigParams(targetUsd) {
  // Today's production envelope (creator keeps 7% of trading fees, anti-sniper, DAMM v2, 0.25% pool, LP split).
  const today = buildLaunchConfigParams(15_000_000_000n, STEP_USD_MICROS, "creator").configParams;
  const graduationMcSol = targetUsd / SOL_USD;
  // Pool opens at the curve's last price: pool SOL = Q x (1 - 2%) against 13% of 1B.
  const threshold = (graduationMcSol * POOL_PCT / 100) / (1 - GRAD_FEE_PCT / 100);
  const built = buildCurve({
    // 1 token of slack so the program's rounded-up pool amount still fits inside 1B.
    token: { tokenType: 0, tokenBaseDecimal: 6, tokenQuoteDecimal: 9, tokenAuthorityOption: 1, totalTokenSupply: SUPPLY, leftover: 1 },
    fee: {
      baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: E.DBC_ANTI_SNIPER_START_FEE_BPS, endingFeeBps: E.DBC_ANTI_SNIPER_END_FEE_BPS, numberOfPeriod: E.DBC_ANTI_SNIPER_PERIODS, totalDuration: E.DBC_ANTI_SNIPER_DURATION_SECONDS } },
      dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage: E.DBC_CREATOR_TRADING_FEE_PCT_KEEP, poolCreationFee: 0, enableFirstSwapWithMinFee: true,
    },
    migration: { migrationOption: 1, migrationFeeOption: 6, migrationFee: { feePercentage: GRAD_FEE_PCT, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: E.DBC_GRADUATED_POOL_FEE_BPS } },
    // Placeholder split for the builder only; today's production split replaces it below via ...today.
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { ...E.DBC_LOCKED_VESTING },
    activationType: 1,
    percentageSupplyOnMigration: POOL_PCT,
    migrationQuoteThreshold: threshold,
  });
  // Keep only the segment from the start to the graduation price, as today's builder does. buildCurve adds a
  // last segment up to the maximum price, which makes the program demand a 25% swap buffer on top of the
  // curve (getSwapAmountWithBuffer); with the curve ending at graduation that buffer is zero.
  const curve = [built.curve[0]];
  const T = built.migrationQuoteThreshold;
  const quoteAfterFee = new BN(((BigInt(T.toString()) * BigInt(100 - GRAD_FEE_PCT) + 99n) / 100n).toString());
  const sqrtMigration = getMigrationThresholdPrice(T, built.sqrtStartPrice, curve);
  const liquidity = getInitialLiquidityFromDeltaQuote(quoteAfterFee, MIN_SQRT_PRICE, sqrtMigration);
  const includedBase = BigInt(getDeltaAmountBaseUnsigned256(sqrtMigration, MAX_SQRT_PRICE, liquidity, Rounding.Up).toString());
  const swapBase = BigInt(getBaseTokenForSwap(built.sqrtStartPrice, sqrtMigration, curve).toString());
  const swapBuffer = BigInt(getSwapAmountWithBuffer(new BN(swapBase.toString()), built.sqrtStartPrice, curve).toString());
  const vest = BigInt(getTotalVestingAmount(built.lockedVesting).toString());
  const minWithout = swapBase + includedBase + vest;
  const minWith = swapBuffer + includedBase + vest;
  const pre = BigInt(SUPPLY) * 1_000_000n;
  if (minWith > pre) throw new Error(`v2 config needs ${minWith} raw tokens, more than 1B`);
  const params = {
    ...today,
    sqrtStartPrice: built.sqrtStartPrice,
    curve,
    migrationQuoteThreshold: T,
    tokenSupply: { preMigrationTokenSupply: new BN(pre.toString()), postMigrationTokenSupply: new BN(minWithout.toString()) },
    lockedVesting: built.lockedVesting,
    migrationFee: { feePercentage: GRAD_FEE_PCT, creatorFeePercentage: 0 },
  };
  console.log(`  supply plan: curve ${(Number(swapBase) / 1e12).toFixed(2)}M, pool ${(Number(includedBase) / 1e12).toFixed(2)}M, reserve ${(Number(vest) / 1e12).toFixed(2)}M, buffer ${(Number(swapBuffer - swapBase) / 1e6).toFixed(2)} tokens, unused ${(Number(pre - minWithout) / 1e6).toFixed(2)} tokens`);
  validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey });
  return { params, thresholdSol: Number(params.migrationQuoteThreshold.toString()) / 1e9 };
}

async function proveTarget(targetUsd) {
  console.log(`\n=== $${targetUsd / 1000}K market cap ===`);
  const partner = Keypair.generate(); // our collector: fee claimer + leftover receiver
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  await fund(partner.publicKey, 50);
  await fund(creator.publicKey, 200);
  await fund(trader.publicKey, 400);

  const { params, thresholdSol } = v2ConfigParams(targetUsd);
  const configKp = Keypair.generate();
  const cfgTx = await client.partner.createConfig({
    config: configKp.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey,
    quoteMint: NATIVE_MINT, payer: partner.publicKey, ...params,
  });
  await send(cfgTx, [partner, configKp]);
  const cfg = await client.state.getPoolConfig(configKp.publicKey);
  check("config on chain: 2% migration fee, creator share 0%", Number(cfg.migrationFeePercentage) === GRAD_FEE_PCT && Number(cfg.creatorMigrationFeePercentage) === 0,
    `${cfg.migrationFeePercentage}% / creator ${cfg.creatorMigrationFeePercentage}%`);
  const swapBase = Number(cfg.swapBaseAmount.toString()) / 1e6;
  const migBase = Number(cfg.migrationBaseThreshold.toString()) / 1e6;
  const preSupply = Number(cfg.preMigrationTokenSupply.toString()) / 1e6;
  check("supply 1B: 85% curve / 13% pool / 2% reserve", near(preSupply, SUPPLY, 1) && near(swapBase / SUPPLY * 100, CURVE_PCT, 0.1) && near(migBase / SUPPLY * 100, POOL_PCT, 0.1),
    `supply ${preSupply.toFixed(0)}, curve ${(swapBase / 1e6).toFixed(2)}M, pool ${(migBase / 1e6).toFixed(2)}M`);
  const gradPrice = Number(getPriceFromSqrtPrice(cfg.migrationSqrtPrice, 6, 9));
  check(`graduates at $${targetUsd / 1000}K MC`, near(gradPrice * SUPPLY * SOL_USD, targetUsd, targetUsd * 0.002), `$${(gradPrice * SUPPLY * SOL_USD).toFixed(0)}, threshold ${thresholdSol.toFixed(3)} SOL`);

  // Launch transaction: create the pool with the creator's 70% first buy (create.js createPoolWithFirstBuy).
  const mintKp = Keypair.generate();
  const want = BigInt(Math.floor(SUPPLY * FIRST_BUY_PCT / 100)) * 1_000_000n;
  const curveCost = quoteAlongDbcCurve(params, want);
  const buyLamports = (curveCost * 10_000n) / BigInt(10_000 - E.DBC_TRADE_FEE_BPS); // first swap pays the 2% minimum fee
  const createTx = await client.creator.createPoolWithFirstBuy({
    createPoolParam: { name: "V2 Proof", symbol: "V2P", uri: "https://example.invalid/v2.json", payer: creator.publicKey, poolCreator: creator.publicKey, config: configKp.publicKey, baseMint: mintKp.publicKey },
    firstBuyParam: { buyer: creator.publicKey, buyAmount: new BN(buyLamports.toString()), minimumAmountOut: new BN(1), referralTokenAccount: null },
  });
  const before = await conn.getBalance(creator.publicKey);
  const created = await send(createTx, [creator, mintKp]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
  const creatorTokens = await tokenBalance(creator.publicKey, mintKp.publicKey) / 1e6;
  const spent = (before - (await conn.getBalance(creator.publicKey))) / 1e9;
  check("creator's 70% first buy lands in the launch transaction", near(creatorTokens / SUPPLY * 100, FIRST_BUY_PCT, 0.05), `${(creatorTokens / 1e6).toFixed(2)}M tokens = ${(creatorTokens / SUPPLY * 100).toFixed(3)}% for ${spent.toFixed(3)} SOL incl. rent and fees`);
  console.log(`  launch tx shape: ${created.size} bytes, ${created.accounts} accounts, ${created.signers} signers`);
  let state = (await client.state.getPool(pool));
  state = state?.poolState ?? state;
  const reserveAfterFirst = Number(state.quoteReserve.toString()) / 1e9;
  check("70% does not graduate the coin", Number(state.isMigrated) === 0 && reserveAfterFirst < thresholdSol, `${reserveAfterFirst.toFixed(3)} of ${thresholdSol.toFixed(3)} SOL in the curve (${(reserveAfterFirst / thresholdSol * 100).toFixed(1)}%)`);

  // The public completes the curve (PartialFill takes only what the curve needs), after the 60 s
  // anti-sniper window: a buy inside it pays up to 90% and would not reach the threshold.
  console.log(`  waiting ${E.DBC_ANTI_SNIPER_DURATION_SECONDS + 5}s for the anti-sniper window to end...`);
  await new Promise((r) => setTimeout(r, (E.DBC_ANTI_SNIPER_DURATION_SECONDS + 5) * 1000));
  const traderBefore = await conn.getBalance(trader.publicKey);
  const fillTx = await client.pool.swap2({
    owner: trader.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.PartialFill, amountIn: new BN(Math.ceil(thresholdSol * 2 * 1e9).toString()), minimumAmountOut: new BN(1),
  });
  await send(fillTx, [trader]);
  const traderTokens = await tokenBalance(trader.publicKey, mintKp.publicKey) / 1e6;
  state = (await client.state.getPool(pool)); state = state?.poolState ?? state;
  const reserveFull = Number(state.quoteReserve.toString()) / 1e9;
  check("the public gets the remaining 15% of supply", near(traderTokens / SUPPLY * 100, CURVE_PCT - FIRST_BUY_PCT, 0.1), `${(traderTokens / 1e6).toFixed(2)}M = ${(traderTokens / SUPPLY * 100).toFixed(3)}% for ${((traderBefore - await conn.getBalance(trader.publicKey)) / 1e9).toFixed(3)} SOL`);
  check("curve complete at the threshold", reserveFull >= thresholdSol - 1e-6, `${reserveFull.toFixed(4)} SOL`);

  // Graduation, as dbcGraduationKeeper does it.
  await send(await client.migration.createLocker({ payer: partner.publicKey, pool }), [partner]);
  const mig = await client.migration.migrateToDammV2({ payer: partner.publicKey, pool, dammConfig: DAMM_CONFIG });
  await send(mig.transaction, [partner, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair]);
  state = (await client.state.getPool(pool)); state = state?.poolState ?? state;
  check("migrated to DAMM v2", Number(state.isMigrated) === 1);
  const dammPool = deriveDammV2PoolAddress(DAMM_CONFIG, mintKp.publicKey, NATIVE_MINT);
  const dammState = await new CpAmm(conn).fetchPoolState(dammPool);
  const vaultBase = Number((await getAccount(conn, dammState.tokenAVault)).amount) / 1e6;
  const vaultQuote = Number((await conn.getTokenAccountBalance(dammState.tokenBVault)).value.amount) / 1e9;
  const poolPrice = vaultQuote / vaultBase;
  check("graduated pool opens at the curve's last price (within 0.5%)", near(poolPrice / gradPrice, 1, 0.005), `pool ${vaultQuote.toFixed(4)} SOL / ${(vaultBase / 1e6).toFixed(2)}M = ${poolPrice.toExponential(4)} vs curve ${gradPrice.toExponential(4)}`);

  const partnerBefore = await conn.getBalance(partner.publicKey);
  await send(await client.partner.partnerWithdrawMigrationFee({ pool, sender: partner.publicKey }), [partner]);
  const partnerFee = (await conn.getBalance(partner.publicKey) - partnerBefore) / 1e9;
  check("our 2% graduation fee arrives (net of tx fee)", near(partnerFee, thresholdSol * GRAD_FEE_PCT / 100, 0.01), `${partnerFee.toFixed(4)} SOL vs ${(thresholdSol * GRAD_FEE_PCT / 100).toFixed(4)} planned`);
  // Creator share is 0%: a creator withdraw must pay nothing (refused by the program, or a zero transfer).
  const creatorBefore = await conn.getBalance(creator.publicKey);
  const creatorTry = await client.creator.creatorWithdrawMigrationFee({ pool, sender: creator.publicKey })
    .then((tx) => send(tx, [creator]))
    .then((r) => ({ sent: true, fee: r.fee }))
    .catch((e) => ({ sent: false, reason: String(e?.transactionMessage || e?.message || e).slice(0, 120) }));
  const creatorGot = (await conn.getBalance(creator.publicKey)) - creatorBefore + (creatorTry.sent ? creatorTry.fee : 0);
  check("creator receives no graduation fee", creatorGot <= 0, creatorTry.sent ? `withdraw sent, net ${creatorGot} lamports` : `withdraw refused: ${creatorTry.reason}`);
  const mint = await getMint(conn, mintKp.publicKey);
  check("mint supply stays 1B after graduation", near(Number(mint.supply) / 1e6, SUPPLY, 20), `${(Number(mint.supply) / 1e6).toLocaleString("en-US")} tokens`);
  return { targetUsd, thresholdSol, buySol: Number(buyLamports) / 1e9, created };
}

// On mainnet the DBC pool authority PDA holds ~68 SOL and pays the locker escrow rent at graduation;
// a fresh validator starts it at 0.
await fund(new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"), 10);
const results = [];
for (const usd of [30_000, 50_000]) results.push(await proveTarget(usd));
console.log("\nSUMMARY");
for (const r of results) console.log(`  $${r.targetUsd / 1000}K: threshold ${r.thresholdSol.toFixed(3)} SOL, 70% first buy ${r.buySol.toFixed(3)} SOL, launch tx ${r.created.size} B / ${r.created.accounts} accounts / ${r.created.signers} signers`);
console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

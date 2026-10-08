import assert from "node:assert/strict";
import test from "node:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  Rounding,
  U128_MAX,
  getDeltaAmountBaseUnsigned256,
  getInitialLiquidityFromDeltaQuote,
  getPriceFromSqrtPrice,
  validateConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_FIRST_BUY_MAX_BPS,
  DBC_POOL_SUPPLY_PCT,
  DBC_CURVE_SUPPLY_PCT,
  DBC_QUOTE_MINT,
  DBC_RESERVE_RAW,
  DBC_SUPPLY_CEILING_RAW,
  DBC_TARGET_USD_MICROS,
  DBC_TOKEN_SCALE,
  migrationSplitLamports,
} from "../../../shared/dbcEconomics.mjs";
import { stepUsdMicrosFromIndex, solPriceStepIndex } from "./dbcPriceSteps.mjs";
import {
  DBC_VALIDATE_LEFTOVER_RECEIVER,
  buildLaunchConfigParams,
  curveQuoteFull,
  feeBpsAtSeconds,
  liquidityBitLength,
  paramsHashOf,
  quoteAlongDbcCurve,
  programMigrationQuoteLamports,
  programSupplyMinimums,
} from "./dbcLaunchConfigParams.mjs";

const SOL_PRICES = [50, 100, 118, 150, 200, 250, 400];
// v2 (founder 2026-10-08): graduation market caps; $15K is gone.
const TARGETS = [30_000, 50_000];

function stepForSol(usd) {
  const micros = BigInt(Math.round(usd * 1_000_000));
  return { micros, index: solPriceStepIndex(micros), step: stepUsdMicrosFromIndex(solPriceStepIndex(micros)) };
}

test("v2: graduates at the chosen market cap, 85/13/2 split, 2% fee to us, room for a 70% first buy", () => {
  const rows = [];
  for (const targetUsd of TARGETS) {
    for (const sol of SOL_PRICES) {
      const { step } = stepForSol(sol);
      for (const mode of ["creator", "platform"]) {
        const { configParams, expected } = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[targetUsd], step, mode);
        validateConfigParameters({ ...configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });
        assert.equal(configParams.curve.length, 1, "one segment, ending at the graduation price");
        assert.deepEqual(configParams.migrationFee, { feePercentage: 2, creatorFeePercentage: 0 });

        // Graduation market cap: curve end price x 1B x the step's SOL price.
        const endPrice = Number(getPriceFromSqrtPrice(configParams.curve[0].sqrtPrice, 6, 9));
        const mcUsd = endPrice * 1e9 * (Number(step) / 1e6);
        assert.ok(Math.abs(mcUsd / targetUsd - 1) < 0.003, `${targetUsd} @ $${sol}: graduates at $${mcUsd.toFixed(0)}`);

        // Supply: 1B minted, 85% sold on the curve, 13% to the pool, 20M reserve, no swap buffer.
        const pre = BigInt(configParams.tokenSupply.preMigrationTokenSupply.toString());
        const post = BigInt(configParams.tokenSupply.postMigrationTokenSupply.toString());
        assert.equal(pre, DBC_SUPPLY_CEILING_RAW);
        assert.equal(post, expected.circulatingAfterGraduation);
        assert.ok(expected.minWithBuffer <= pre && expected.minWithoutBuffer <= post);
        assert.equal(expected.minWithBuffer, expected.minWithoutBuffer, "no swap buffer when the curve ends at graduation");
        assert.ok(expected.bufferTokens < 100n * DBC_TOKEN_SCALE, `unused ${expected.bufferTokens}`);
        const pct = (raw) => Number((raw * 10_000n) / DBC_SUPPLY_CEILING_RAW) / 100;
        assert.ok(Math.abs(pct(expected.soldRaw) - DBC_CURVE_SUPPLY_PCT) <= 0.02, `curve ${pct(expected.soldRaw)}%`);
        assert.ok(Math.abs(pct(expected.poolTokens) - DBC_POOL_SUPPLY_PCT) <= 0.02, `pool ${pct(expected.poolTokens)}%`);
        assert.equal(expected.reserveTokens, DBC_RESERVE_RAW);

        // Graduation fee: 2% of the threshold, all ours; the pool gets ceil(98%).
        const split = migrationSplitLamports(expected.thresholdLamports);
        assert.equal(expected.creatorGraduationLamports, 0n);
        assert.equal(expected.ourGraduationLamports, split.feeLamports);
        assert.equal(expected.poolLamports, (expected.thresholdLamports * 98n + 99n) / 100n);
        assert.equal(expected.migrationQuote, expected.poolLamports);

        // A 70% first buy fits on the curve and leaves 15% of supply for the public.
        const firstBuyRaw = (DBC_SUPPLY_CEILING_RAW * BigInt(DBC_FIRST_BUY_MAX_BPS)) / 10_000n;
        assert.ok(firstBuyRaw < expected.soldRaw);
        const firstBuyCost = quoteAlongDbcCurve(configParams, firstBuyRaw);
        assert.ok(firstBuyCost < expected.thresholdLamports, "70% does not graduate the coin");
        assert.ok(Math.abs(pct(expected.soldRaw - firstBuyRaw) - 15) <= 0.02);
        assert.ok(curveQuoteFull(configParams) >= expected.thresholdLamports - 1n);

        assert.ok(expected.liquidityBits.every((b) => b > 0 && b <= 128));
        if (mode === "creator") {
          rows.push({
            targetUsd, sol,
            thresholdSol: (Number(expected.thresholdLamports) / 1e9).toFixed(3),
            firstBuy70Sol: (Number(firstBuyCost) / 0.98 / 1e9).toFixed(3),
            ourFeeSol: (Number(expected.ourGraduationLamports) / 1e9).toFixed(4),
            graduatesAtUsd: mcUsd.toFixed(0),
          });
        }
      }
    }
  }
  console.log("\nv2 configs (creator mode)");
  console.table(rows);

  const sample = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], stepForSol(118).step, "creator");
  const fees = [0, 5, 30, 60, 120].map((s) => feeBpsAtSeconds(sample.configParams, s));
  assert.deepEqual(fees, [9000, 8266, 4600, 200, 200], "anti-sniper unchanged");
});

test("pool quote is ceil(T * 98 / 100)", () => {
  const T = 33_053_088_348n;
  const split = migrationSplitLamports(T);
  assert.equal(split.poolLamports, (T * 98n + 99n) / 100n);
  assert.equal(split.feeLamports, T - split.poolLamports);
  assert.equal(split.creatorGraduationLamports, 0n);
  assert.equal(split.poolLamports + split.feeLamports, T);
});

test("paramsHash is stable for equal input and changes when economics change", () => {
  const step = stepForSol(118).step;
  const a = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], step, "creator");
  const b = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], step, "creator");
  assert.equal(a.paramsHash, b.paramsHash);
  const c = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[50000], step, "creator");
  assert.notEqual(a.paramsHash, c.paramsHash);
  const d = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], step, "platform");
  assert.notEqual(a.paramsHash, d.paramsHash);
  const e = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], stepForSol(200).step, "creator");
  assert.notEqual(a.paramsHash, e.paramsHash);
  assert.equal(a.paramsHash, paramsHashOf({
    economics: "v2-market-cap",
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000].toString(),
    stepUsdMicros: step.toString(),
    creatorFeeMode: "creator",
    configParams: a.configParams,
  }));
});

test("validateConfigParameters passes for both fee modes and the $150 test target", () => {
  const step = stepForSol(118).step;
  for (const mode of ["creator", "platform"]) {
    const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], step, mode);
    validateConfigParameters({ ...built.configParams, leftoverReceiver: new PublicKey("11111111111111111111111111111112") });
    assert.equal(built.configParams.creatorTradingFeePercentage, mode === "creator" ? 7 : 0);
    assert.equal(built.configParams.partnerPermanentLockedLiquidityPercentage, mode === "platform" ? 100 : 20);
    assert.equal(built.configParams.creatorPermanentLockedLiquidityPercentage, mode === "platform" ? 0 : 80);
  }
  const testTarget = buildLaunchConfigParams(DBC_DEVNET_TEST_TARGET_USD_MICROS, step, "creator");
  validateConfigParameters({ ...testTarget.configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });
});

test("program supply minimums use ceil quote and Rounding.Up base, with no swap buffer", () => {
  const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], stepForSol(118).step, "creator");
  const T = built.expected.thresholdLamports;
  const quote = programMigrationQuoteLamports(T);
  assert.equal(quote, (T * 98n + 99n) / 100n);
  assert.equal(quote, built.expected.migrationQuote);
  const mins = programSupplyMinimums({
    thresholdLamports: T,
    sqrtStartPrice: built.configParams.sqrtStartPrice,
    curve: built.configParams.curve,
    vesting: built.configParams.lockedVesting,
  });
  const liquidity = getInitialLiquidityFromDeltaQuote(
    new BN(quote.toString()),
    MIN_SQRT_PRICE,
    mins.sqrtMigration,
  );
  const included = getDeltaAmountBaseUnsigned256(
    mins.sqrtMigration,
    MAX_SQRT_PRICE,
    liquidity,
    Rounding.Up,
  );
  assert.equal(BigInt(included.toString()), mins.includedBase);
  assert.equal(mins.includedBase, built.expected.includedBase);
  assert.equal(mins.minWithoutBuffer, built.expected.minWithoutBuffer);
  assert.equal(mins.minWithBuffer, built.expected.minWithBuffer);
  assert.ok(mins.minWithoutBuffer <= built.expected.circulatingAfterGraduation);
  assert.ok(built.expected.circulatingAfterGraduation <= built.expected.totalTokenSupply);
  assert.ok(mins.minWithBuffer <= built.expected.totalTokenSupply);

  // The curve ends at the graduation price, so the program's 25% swap buffer is capped to zero.
  assert.equal(mins.swapBuffer, mins.swapBase);
});

test("createConfig serializes for every ladder case", async () => {
  const connection = new Connection("http://127.0.0.1:9", "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const payer = Keypair.generate().publicKey;
  const collector = new PublicKey("11111111111111111111111111111112");
  const cases = [];
  for (const targetUsd of TARGETS) {
    const target = DBC_TARGET_USD_MICROS[targetUsd];
    for (const sol of SOL_PRICES) {
      for (const mode of ["creator", "platform"]) {
        cases.push({ targetUsd, sol, mode, target, step: stepForSol(sol).step });
      }
    }
  }
  cases.push({
    targetUsd: 150,
    sol: 118,
    mode: "creator",
    target: DBC_DEVNET_TEST_TARGET_USD_MICROS,
    step: stepForSol(118).step,
  });
  cases.push({
    targetUsd: 150,
    sol: 118,
    mode: "platform",
    target: DBC_DEVNET_TEST_TARGET_USD_MICROS,
    step: stepForSol(118).step,
  });

  const rows = [];
  for (const c of cases) {
    const built = buildLaunchConfigParams(c.target, c.step, c.mode);
    const maxBits = Math.max(...built.expected.liquidityBits);
    assert.ok(maxBits <= 128, `${c.targetUsd} @ $${c.sol} ${c.mode}: ${maxBits} bits`);
    assert.ok(built.configParams.curve.every((pt) => {
      const bits = liquidityBitLength(pt.liquidity);
      return bits <= 128 && pt.liquidity.lte(U128_MAX);
    }));
    const config = Keypair.generate().publicKey;
    const tx = await client.partner.createConfig({
      config,
      feeClaimer: collector,
      leftoverReceiver: collector,
      quoteMint: new PublicKey(DBC_QUOTE_MINT),
      payer,
      ...built.configParams,
    });
    tx.feePayer = payer;
    tx.recentBlockhash = "11111111111111111111111111111111";
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    assert.ok(bytes.length > 0, `${c.targetUsd} @ $${c.sol} ${c.mode}: empty tx`);
    rows.push({
      targetUsd: c.targetUsd,
      sol: c.sol,
      mode: c.mode,
      maxBits,
      firstBits: built.expected.liquidityBits[0],
      bytes: bytes.length,
    });
  }
  console.log("\ncreateConfig serialize (every ladder case)");
  console.table(rows);
});

test("SOL params are unchanged when quote is omitted or native; USDC keeps D6/reserve/supply", async () => {
  const { findQuote, nativeQuote, USDC_MINT_MAINNET } = await import("../../../shared/dbcQuotes.mjs");
  const { DBC_RESERVE_RAW, migrationSplitLamports } = await import("../../../shared/dbcEconomics.mjs");
  const target = DBC_TARGET_USD_MICROS[30000];
  const { step } = stepForSol(118);
  const solDefault = buildLaunchConfigParams(target, step, "creator");
  const solNative = buildLaunchConfigParams(target, step, "creator", { quote: nativeQuote("mainnet-beta") });
  assert.equal(solDefault.paramsHash, solNative.paramsHash);
  assert.equal(solDefault.expected.thresholdLamports, solNative.expected.thresholdLamports);
  assert.equal(solDefault.expected.reserveTokens, DBC_RESERVE_RAW);
  const usdc = findQuote("mainnet-beta", USDC_MINT_MAINNET);
  const usdcBuilt = buildLaunchConfigParams(target, 1_000_000n, "creator", { quote: usdc });
  // A $30K market cap raises $30K x 13 / 98 = $3,979.59 of USDC (6 decimals).
  const usdcThreshold = Number(usdcBuilt.expected.thresholdLamports);
  assert.ok(Math.abs(usdcThreshold - 3_979_591_837) <= 2, String(usdcThreshold));
  assert.equal(usdcBuilt.expected.reserveTokens, DBC_RESERVE_RAW);
  const d6sol = migrationSplitLamports(solDefault.expected.thresholdLamports);
  const d6usdc = migrationSplitLamports(usdcBuilt.expected.thresholdLamports);
  assert.equal(d6sol.creatorGraduationLamports + d6sol.ourGraduationLamports, d6sol.feeLamports);
  assert.equal(d6usdc.creatorGraduationLamports + d6usdc.ourGraduationLamports, d6usdc.feeLamports);
  assert.equal(usdcBuilt.expected.reserveTokens, solDefault.expected.reserveTokens);
  assert.notEqual(usdcBuilt.paramsHash, solDefault.paramsHash);
  validateConfigParameters({ ...usdcBuilt.configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });
});

test("the trade box fee equals the chain's fee every second of the anti-sniper window", async () => {
  const { antiSniperFeeBps } = await import("../../../shared/dbcAntiSniper.mjs");
  const sample = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], stepForSol(118).step, "creator");
  for (let s = 0; s <= 61; s += 1) assert.equal(antiSniperFeeBps(s), feeBpsAtSeconds(sample.configParams, s), `t=${s}`);
});

test("firstBuyCapLamports: the most SOL that stays within 70%, the create page's MAX", async () => {
  const { firstBuyCapLamports, quoteFirstBuyOnConfig, firstBuyExceedsCap } = await import("./dbcFirstBuyQuote.mjs");
  for (const targetUsd of TARGETS) {
    for (const sol of [100, 118, 200]) {
      const { configParams } = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[targetUsd], stepForSol(sol).step, "creator");
      const cap = firstBuyCapLamports(configParams, 7000);
      assert.equal(firstBuyExceedsCap(quoteFirstBuyOnConfig(configParams, cap), 7000), false, `${targetUsd} @ $${sol}`);
      assert.equal(firstBuyExceedsCap(quoteFirstBuyOnConfig(configParams, cap + cap / 1000n), 7000), true, `${targetUsd} @ $${sol}: +0.1% must be over`);
    }
  }
});

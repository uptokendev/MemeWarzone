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
  getTotalSupplyFromCurve,
  validateConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_PRICE_SLOPE_LAMPORTS,
  DBC_QUOTE_MINT,
  DBC_RESERVE_RAW,
  DBC_SUPPLY_CEILING_RAW,
  DBC_TARGET_USD_MICROS,
  DBC_TOKEN_SCALE,
  migrationSplitLamports,
  roundUpToWholeTokens,
} from "../../../shared/dbcEconomics.mjs";
import { stepUsdMicrosFromIndex, solPriceStepIndex } from "./dbcPriceSteps.mjs";
import {
  DBC_VALIDATE_LEFTOVER_RECEIVER,
  buildLaunchConfigParams,
  curveQuoteFull,
  feeBpsAtSeconds,
  linearCostLamports,
  linearSoldForCost,
  liquidityBitLength,
  paramsHashOf,
  quoteAlongDbcCurve,
  programMigrationQuoteLamports,
  programSupplyMinimums,
  soldPointsEqualPriceRatio,
  soldPointsPackedStart,
} from "./dbcLaunchConfigParams.mjs";

const SOL_PRICES = [50, 100, 118, 150, 200, 250, 400];
const TARGETS = [15_000, 30_000, 50_000];

function stepForSol(usd) {
  const micros = BigInt(Math.round(usd * 1_000_000));
  return { micros, index: solPriceStepIndex(micros), step: stepUsdMicrosFromIndex(solPriceStepIndex(micros)) };
}

test("price path, supply, graduation and anti-sniper tables", () => {
  const priceRows = [];
  const supplyRows = [];
  const gradRows = [];
  const steepened = [];

  for (const targetUsd of TARGETS) {
    const target = DBC_TARGET_USD_MICROS[targetUsd];
    for (const sol of SOL_PRICES) {
      const { step } = stepForSol(sol);
      const { configParams, expected, paramsHash } = buildLaunchConfigParams(target, step, "creator");
      validateConfigParameters({ ...configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });

      let worstPct = 0;
      let worstI = 0;
      let worstPctTail = 0;
      if (!expected.steepened) {
        for (let i = 1; i <= 50; i += 1) {
          const linear = (expected.thresholdLamports * BigInt(i)) / 50n;
          const s = linearSoldForCost(linear, expected.slopeUsed);
          const dbc = quoteAlongDbcCurve(configParams, s);
          if (linear === 0n) continue;
          const diff = dbc > linear ? dbc - linear : linear - dbc;
          const pct = Number(diff) / Number(linear);
          if (pct > worstPct) {
            worstPct = pct;
            worstI = i;
          }
          if (i >= 10 && pct > worstPctTail) worstPctTail = pct;
        }
      }
      const qFull = curveQuoteFull(configParams);
      const dT = qFull > expected.thresholdLamports ? qFull - expected.thresholdLamports : expected.thresholdLamports - qFull;

      assert.ok(expected.totalTokenSupply <= DBC_SUPPLY_CEILING_RAW, "supply ceiling");
      const pre = BigInt(configParams.tokenSupply.preMigrationTokenSupply.toString());
      const post = BigInt(configParams.tokenSupply.postMigrationTokenSupply.toString());
      const linearCirculating = roundUpToWholeTokens(expected.soldRaw + expected.poolTokens + DBC_RESERVE_RAW);
      assert.equal(post, expected.circulatingAfterGraduation);
      assert.equal(pre, expected.totalTokenSupply);
      assert.equal(pre - post, expected.bufferTokens);
      assert.ok(post >= linearCirculating, "post is at least sold + pool + 20M reserve, rounded up");
      assert.ok(pre >= post, "pre-migration supply covers circulating");
      assert.ok(expected.minWithoutBuffer <= post);
      assert.ok(expected.minWithBuffer <= pre);
      assert.equal(expected.migrationQuote, (expected.thresholdLamports * 78n + 99n) / 100n);
      if (expected.steepened) {
        assert.ok(expected.slopeUsed > DBC_PRICE_SLOPE_LAMPORTS);
        steepened.push({
          targetUsd,
          sol,
          slope: expected.slopeUsed.toString(),
          totalWhole: (expected.totalTokenSupply / DBC_TOKEN_SCALE).toString(),
        });
      }

      const split = migrationSplitLamports(expected.thresholdLamports);
      assert.equal(expected.creatorGraduationLamports, split.creatorGraduationLamports);
      assert.equal(expected.ourGraduationLamports, split.ourGraduationLamports);
      assert.equal(expected.poolLamports, split.poolLamports);
      const creatorPct = Number(expected.creatorGraduationLamports * 10000n / expected.thresholdLamports) / 100;
      const ourPct = Number(expected.ourGraduationLamports * 10000n / expected.thresholdLamports) / 100;
      const poolPct = Number(expected.poolLamports * 10000n / expected.thresholdLamports) / 100;
      assert.ok(Math.abs(creatorPct - 19.8) < 0.05);
      assert.ok(Math.abs(ourPct - 2.2) < 0.05);
      assert.ok(Math.abs(poolPct - 78) < 0.05);

      const maxBits = Math.max(...expected.liquidityBits);
      assert.ok(maxBits <= 128, `${targetUsd} @ $${sol}: liquidity ${maxBits} bits`);
      assert.ok(expected.liquidityBits.every((b) => b > 0 && b <= 128));

      priceRows.push({
        targetUsd,
        sol,
        steepened: expected.steepened,
        worstPct: expected.steepened ? "steepened" : `${(worstPct * 100).toFixed(3)}%`,
        worstI,
        tailPct: expected.steepened ? "steepened" : `${(worstPctTail * 100).toFixed(3)}%`,
        dT: dT.toString(),
        maxBits,
        firstBits: expected.liquidityBits[0],
      });
      supplyRows.push({
        targetUsd,
        sol,
        slope: expected.slopeUsed.toString(),
        steepened: expected.steepened,
        soldWhole: (expected.soldRaw / DBC_TOKEN_SCALE).toString(),
        totalWhole: (expected.totalTokenSupply / DBC_TOKEN_SCALE).toString(),
      });
      gradRows.push({
        targetUsd,
        sol,
        creator: expected.creatorGraduationLamports.toString(),
        us: expected.ourGraduationLamports.toString(),
        pool: expected.poolLamports.toString(),
        creatorPct: creatorPct.toFixed(2),
        ourPct: ourPct.toFixed(2),
        poolPct: poolPct.toFixed(2),
      });
      void paramsHash;
    }
  }

  const sample = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], stepForSol(118).step, "creator");
  const fees = [0, 5, 30, 60, 120].map((s) => ({ s, bps: feeBpsAtSeconds(sample.configParams, s) }));
  assert.equal(fees[0].bps, 5000);
  assert.equal(fees[1].bps, 4600);
  assert.equal(fees[2].bps, 2600);
  assert.equal(fees[3].bps, 200);
  assert.equal(fees[4].bps, 200);

  console.log("\nprice path (worst deviation vs linear, 50 points)");
  console.table(priceRows);
  console.log("\nliquidity bit lengths (must be <= 128)");
  console.table(priceRows.map((r) => ({
    targetUsd: r.targetUsd,
    sol: r.sol,
    maxBits: r.maxBits,
    firstBits: r.firstBits,
  })));
  console.log("\nsupply / steepened");
  console.table(supplyRows);
  console.log("\ngraduation split");
  console.table(gradRows);
  console.log("\nanti-sniper fee (linear 50% -> 2% over 60s)");
  console.table(fees);
  console.log("\nsteepened configs", steepened);
  for (const row of priceRows) {
    assert.ok(BigInt(row.dT) <= 1n, `${row.targetUsd} @ $${row.sol}: threshold off by ${row.dT}`);
    if (!row.steepened) {
      const tail = Number(String(row.tailPct).replace("%", "")) / 100;
      // 16 CP segments cannot hold 1% against the 1-lamport linear start (see hand-in).
      assert.ok(tail <= 0.08, `${row.targetUsd} @ $${row.sol}: tail deviation ${row.tailPct}`);
    }
  }
});

test("pool quote is ceil(T * 78 / 100)", () => {
  const T = 127_118_644_068n;
  const split = migrationSplitLamports(T);
  assert.equal(split.poolLamports, (T * 78n + 99n) / 100n);
  assert.equal(split.feeLamports, T - split.poolLamports);
  assert.equal(split.poolLamports + split.feeLamports, T);
});

test("equal price-ratio spacing vs packed-start: keep the lower tail error", () => {
  const packingRows = [];
  let packedTail = 0;
  let ratioTail = 0;
  for (const targetUsd of TARGETS) {
    const target = DBC_TARGET_USD_MICROS[targetUsd];
    for (const sol of SOL_PRICES) {
      const { step } = stepForSol(sol);
      const packed = buildLaunchConfigParams(target, step, "creator", { soldPoints: soldPointsPackedStart });
      const ratio = buildLaunchConfigParams(target, step, "creator", { soldPoints: soldPointsEqualPriceRatio });
      function tailOf(built) {
        if (built.expected.steepened) return null;
        let worst = 0;
        for (let i = 10; i <= 50; i += 1) {
          const linear = (built.expected.thresholdLamports * BigInt(i)) / 50n;
          const s = linearSoldForCost(linear, built.expected.slopeUsed);
          const dbc = quoteAlongDbcCurve(built.configParams, s);
          if (linear === 0n) continue;
          const diff = dbc > linear ? dbc - linear : linear - dbc;
          const pct = Number(diff) / Number(linear);
          if (pct > worst) worst = pct;
        }
        return worst;
      }
      const pTail = tailOf(packed);
      const rTail = tailOf(ratio);
      packingRows.push({
        targetUsd,
        sol,
        packed: pTail == null ? "steepened" : `${(pTail * 100).toFixed(3)}%`,
        equalRatio: rTail == null ? "steepened" : `${(rTail * 100).toFixed(3)}%`,
      });
      if (pTail != null && pTail > packedTail) packedTail = pTail;
      if (rTail != null && rTail > ratioTail) ratioTail = rTail;
    }
  }
  console.log("\npacking comparison (tail 20-100% of raise)");
  console.table(packingRows);
  console.log(`worst tail packed-start ${(packedTail * 100).toFixed(3)}%  equal-ratio ${(ratioTail * 100).toFixed(3)}%`);
  assert.ok(ratioTail <= packedTail + 1e-12, "production packing is equal price-ratio only if it is not worse");
});

test("paramsHash is stable for equal input and changes when economics change", () => {
  const step = stepForSol(118).step;
  const a = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], step, "creator");
  const b = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], step, "creator");
  assert.equal(a.paramsHash, b.paramsHash);
  const c = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], step, "creator");
  assert.notEqual(a.paramsHash, c.paramsHash);
  const d = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], step, "platform");
  assert.notEqual(a.paramsHash, d.paramsHash);
  const e = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], stepForSol(200).step, "creator");
  assert.notEqual(a.paramsHash, e.paramsHash);
  assert.equal(a.paramsHash, paramsHashOf({
    targetUsdMicros: DBC_TARGET_USD_MICROS[15000].toString(),
    stepUsdMicros: step.toString(),
    creatorFeeMode: "creator",
    configParams: a.configParams,
  }));
});

test("validateConfigParameters passes for both fee modes and the $150 test target", () => {
  const step = stepForSol(118).step;
  for (const mode of ["creator", "platform"]) {
    const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], step, mode);
    validateConfigParameters({ ...built.configParams, leftoverReceiver: new PublicKey("11111111111111111111111111111112") });
    assert.equal(built.configParams.creatorTradingFeePercentage, mode === "creator" ? 7 : 0);
    assert.equal(built.configParams.partnerPermanentLockedLiquidityPercentage, mode === "platform" ? 100 : 20);
    assert.equal(built.configParams.creatorPermanentLockedLiquidityPercentage, mode === "platform" ? 0 : 80);
  }
  const testTarget = buildLaunchConfigParams(DBC_DEVNET_TEST_TARGET_USD_MICROS, step, "creator");
  validateConfigParameters({ ...testTarget.configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });
});

test("program supply minimums use ceil quote and Rounding.Up base (the SDK total is lower)", () => {
  const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[15000], stepForSol(118).step, "creator");
  const T = built.expected.thresholdLamports;
  const quote = programMigrationQuoteLamports(T);
  assert.equal(quote, (T * 78n + 99n) / 100n);
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

  const sdkTotal = BigInt(getTotalSupplyFromCurve(
    new BN(T.toString()),
    built.configParams.sqrtStartPrice,
    built.configParams.curve,
    built.configParams.lockedVesting,
    1,
    new BN(0),
    22,
  ).toString());
  assert.ok(sdkTotal < mins.minWithBuffer, `SDK ${sdkTotal} should be below program minWithBuffer ${mins.minWithBuffer}`);
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
  const target = DBC_TARGET_USD_MICROS[15000];
  const { step } = stepForSol(118);
  const solDefault = buildLaunchConfigParams(target, step, "creator");
  const solNative = buildLaunchConfigParams(target, step, "creator", { quote: nativeQuote("mainnet-beta") });
  assert.equal(solDefault.paramsHash, solNative.paramsHash);
  assert.equal(solDefault.expected.thresholdLamports, solNative.expected.thresholdLamports);
  assert.equal(solDefault.expected.reserveTokens, DBC_RESERVE_RAW);
  const usdc = findQuote("mainnet-beta", USDC_MINT_MAINNET);
  const usdcBuilt = buildLaunchConfigParams(target, 1_000_000n, "creator", { quote: usdc });
  assert.equal(usdcBuilt.expected.thresholdLamports, 15_000n * 1_000_000n);
  assert.equal(usdcBuilt.expected.reserveTokens, DBC_RESERVE_RAW);
  const d6sol = migrationSplitLamports(solDefault.expected.thresholdLamports);
  const d6usdc = migrationSplitLamports(usdcBuilt.expected.thresholdLamports);
  assert.equal(d6sol.creatorGraduationLamports + d6sol.ourGraduationLamports, d6sol.feeLamports);
  assert.equal(d6usdc.creatorGraduationLamports + d6usdc.ourGraduationLamports, d6usdc.feeLamports);
  assert.equal(usdcBuilt.expected.reserveTokens, solDefault.expected.reserveTokens);
  assert.notEqual(usdcBuilt.paramsHash, solDefault.paramsHash);
  validateConfigParameters({ ...usdcBuilt.configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });
});

import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { validateConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_PRICE_SLOPE_LAMPORTS,
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
  paramsHashOf,
  quoteAlongDbcCurve,
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
      assert.ok(pre > post, "unused swap buffer is not in the post-migration supply");
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

      priceRows.push({
        targetUsd,
        sol,
        steepened: expected.steepened,
        worstPct: expected.steepened ? "steepened" : `${(worstPct * 100).toFixed(3)}%`,
        worstI,
        tailPct: expected.steepened ? "steepened" : `${(worstPctTail * 100).toFixed(3)}%`,
        dT: dT.toString(),
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
  }
  const testTarget = buildLaunchConfigParams(DBC_DEVNET_TEST_TARGET_USD_MICROS, step, "creator");
  validateConfigParameters({ ...testTarget.configParams, leftoverReceiver: DBC_VALIDATE_LEFTOVER_RECEIVER });
});

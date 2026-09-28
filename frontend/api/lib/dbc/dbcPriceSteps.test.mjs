import assert from "node:assert/strict";
import test from "node:test";
import { DBC_SOL_PRICE_STEP_RATIO, DBC_USD_MICROS } from "../../../shared/dbcEconomics.mjs";
import { solPriceStep, solPriceStepIndex, stepUsdMicrosFromIndex } from "./dbcPriceSteps.mjs";

const KNOWN = [
  [50_000_000n, 198],
  [100_000_000n, 233],
  [118_000_000n, 241],
  [150_000_000n, 253],
  [200_000_000n, 268],
  [250_000_000n, 279],
  [400_000_000n, 303],
];

test("known SOL prices map to pinned step indices", () => {
  for (const [micros, index] of KNOWN) {
    const computed = Math.round(Math.log(Number(micros) / Number(DBC_USD_MICROS)) / Math.log(DBC_SOL_PRICE_STEP_RATIO));
    assert.equal(solPriceStepIndex(micros), computed);
    assert.equal(solPriceStepIndex(micros), index);
  }
});

test("step price is 1.02^index in USD micros", () => {
  for (const [micros] of KNOWN) {
    const { stepIndex, stepUsdMicros } = solPriceStep(micros);
    assert.equal(stepUsdMicros, stepUsdMicrosFromIndex(stepIndex));
  }
});

test("neighbouring steps differ by 2%", () => {
  for (const index of [198, 232, 241, 253, 268, 279, 303]) {
    const a = Number(stepUsdMicrosFromIndex(index));
    const b = Number(stepUsdMicrosFromIndex(index + 1));
    const ratio = b / a;
    assert.ok(Math.abs(ratio - DBC_SOL_PRICE_STEP_RATIO) < 1e-6, `index ${index} ratio ${ratio}`);
  }
});

test("the same price always yields the same index", () => {
  const a = solPriceStep(118_590_000n);
  const b = solPriceStep(118_590_000n);
  assert.deepEqual(a, b);
});

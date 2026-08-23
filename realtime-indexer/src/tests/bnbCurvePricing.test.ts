import assert from "node:assert/strict";
import test from "node:test";
import { BNB_WAD, bnbCurveState } from "../bnbCurvePricing.js";

test("SBF spot × sold matches chain currentPrice and canonical mcap_c", () => {
  const state = bnbCurveState(1_000_000_000n, 850n, 1_253_249_124_496_015_052_091_146n);
  assert.equal(state.spotNative, 2.065261755e-9);
  assert.equal(state.soldWhole, 1_253_249.124496015);
  assert.equal(state.mcapNative, 0.0025882874863088533);
  assert.equal(state.spotNative * Number(BNB_WAD), 2_065_261_755);
});

test("zero sold has zero market cap and base spot", () => {
  const state = bnbCurveState(1_000_000_000n, 850n, 0n);
  assert.equal(state.spotNative, 1e-9);
  assert.equal(state.mcapNative, 0);
});

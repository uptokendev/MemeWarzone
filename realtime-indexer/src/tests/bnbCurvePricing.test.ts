import assert from "node:assert/strict";
import test from "node:test";
import { BNB_WAD, bnbCurveState, parseRawTokenAmount } from "../bnbCurvePricing.js";

test("BTW sold raw survives pg numeric/text and does not collapse to 7 wei", () => {
  const expected = 744697837477003999999999n;
  assert.equal(parseRawTokenAmount("744697837477003999999999"), expected);
  assert.equal(parseRawTokenAmount("744697837477003999999999.0000"), expected);
  const fromSci = parseRawTokenAmount("7.44697837477003999999999e+23");
  assert.equal(fromSci > 10n ** 20n, true);
  assert.equal(parseRawTokenAmount(7.44697837477004e23) > 10n ** 20n, true);
});

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

import test from "node:test";
import assert from "node:assert/strict";
import { parseNumericBigInt } from "../rewards/rewardMath.js";

test("parseNumericBigInt accepts integer-valued Postgres numerics", () => {
  assert.equal(parseNumericBigInt("0.00000000000000000000"), 0n);
  assert.equal(parseNumericBigInt("123.00000000000000000000"), 123n);
  assert.equal(parseNumericBigInt("-42.000"), -42n);
  assert.equal(parseNumericBigInt("987654321"), 987654321n);
});

test("parseNumericBigInt rejects fractional numerics instead of truncating", () => {
  assert.throws(
    () => parseNumericBigInt("0.50000000000000000000"),
    /Expected integer-valued numeric/,
  );
});

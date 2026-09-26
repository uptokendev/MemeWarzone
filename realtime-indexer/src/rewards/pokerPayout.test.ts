import assert from "node:assert/strict";
import test from "node:test";
import { pokerPaidPlaces, pokerPayoutForField, pokerSplitRaw } from "./pokerPayout.js";
// @ts-ignore -- the API's mirror, plain JS
import * as apiMirror from "../../../frontend/shared/pokerPayout.mjs";

test("paid places: 15% of the field, min 3 weekly / 5 otherwise, never more than the field", () => {
  assert.equal(pokerPaidPlaces(0, "weekly"), 0);
  assert.equal(pokerPaidPlaces(2, "weekly"), 2);
  assert.equal(pokerPaidPlaces(10, "weekly"), 3);
  assert.equal(pokerPaidPlaces(100, "weekly"), 15);
  assert.equal(pokerPaidPlaces(100, "monthly"), 15);
  assert.equal(pokerPaidPlaces(20, "monthly"), 5);
  assert.equal(pokerPaidPlaces(4, "quarterly"), 4);
  assert.equal(pokerPaidPlaces(10_000, "mwl_monthly"), 255);
});

test("the whole pot is paid, exactly, and every place pays no more than the one above", () => {
  for (const pot of [1n, 7n, 999_999_999n, 1_000_000_000_000_000_000n, 123_456_789_012_345n]) {
    for (const places of [1, 2, 3, 5, 15, 37, 255]) {
      const shares = pokerSplitRaw(pot, places);
      assert.equal(shares.reduce((a, b) => a + b, 0n), pot, `pot ${pot} over ${places}`);
      for (let i = 1; i < shares.length; i += 1) assert.ok(shares[i] <= shares[i - 1], `monotonic at ${i}`);
    }
  }
});

test("100 players in a weekly category: 15 get paid, not 1", () => {
  const shares = pokerPayoutForField(1_000_000_000n, 100, "weekly");
  assert.equal(shares.length, 15);
  assert.ok(shares[0] > shares[14] && shares[14] > 0n);
});

test("the API shows exactly what the settlement pays", () => {
  for (const [entrants, period] of [[0, "weekly"], [3, "weekly"], [57, "monthly"], [400, "quarterly"], [2_000, "mwl_monthly"]] as const) {
    assert.equal(apiMirror.pokerPaidPlaces(entrants, period), pokerPaidPlaces(entrants, period));
    const pot = 987_654_321_123n;
    assert.deepEqual(apiMirror.pokerPayoutForField(pot, entrants, period), pokerPayoutForField(pot, entrants, period));
  }
});

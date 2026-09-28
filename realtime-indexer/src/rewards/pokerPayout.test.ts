import assert from "node:assert/strict";
import test from "node:test";
import { pokerPaidPlaces, pokerPayoutForField, pokerPlacesAboveMinimum, pokerSplitRaw, solanaMinPayoutLamports } from "./pokerPayout.js";
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

test("Solana minimum payout: fewer places, never a share below the minimum, pot still fully paid", () => {
  const min = 5_000_000n;
  // 0.02 SOL over 15 places would pay the 15th place far below 0.005 SOL.
  const places = pokerPlacesAboveMinimum(20_000_000n, 15, min);
  const shares = pokerSplitRaw(20_000_000n, places);
  assert.ok(places >= 1 && places < 15);
  assert.ok(shares[shares.length - 1] >= min);
  assert.equal(shares.reduce((a, b) => a + b, 0n), 20_000_000n);
  assert.ok(pokerSplitRaw(20_000_000n, places + 1).at(-1)! < min, "the largest such number of places");
  assert.equal(pokerPlacesAboveMinimum(4_999_999n, 5, min), 0, "a pot below the minimum pays nobody: it rolls over");
  assert.equal(pokerPlacesAboveMinimum(1_000_000_000_000n, 15, min), 15, "a big pot is untouched");
  assert.equal(solanaMinPayoutLamports({}), 5_000_000n);
  assert.equal(solanaMinPayoutLamports({ SOLANA_MIN_PAYOUT_LAMPORTS: "1000000" }), 1_000_000n);
  for (const [pot, k] of [[20_000_000n, 15], [4_999_999n, 5], [987_654_321n, 40]] as const) {
    assert.equal(apiMirror.pokerPlacesAboveMinimum(pot, k, min), pokerPlacesAboveMinimum(pot, k, min));
  }
  assert.equal(apiMirror.solanaMinPayoutLamports({}), solanaMinPayoutLamports({}));
});

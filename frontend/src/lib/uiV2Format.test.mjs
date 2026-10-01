import test from "node:test";
import assert from "node:assert/strict";
import { formatCountdown, sparklinePoints } from "./uiV2Format.mjs";

test("sparkline needs two finite values and spans the box", () => {
  assert.equal(sparklinePoints([], 80, 28), null);
  assert.equal(sparklinePoints([5, NaN], 80, 28), null);
  assert.equal(sparklinePoints([1, 3], 80, 28), "0.0,26.0 80.0,2.0");
  assert.equal(sparklinePoints([2, 2, 2], 80, 28), "0.0,26.0 40.0,26.0 80.0,26.0");
});

test("countdown formats by size and ends at zero", () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  assert.equal(formatCountdown(now + (2 * 86400 + 4 * 3600 + 30) * 1000, now), "2d 4h");
  assert.equal(formatCountdown(now + (3 * 3600 + 5 * 60) * 1000, now), "3h 05m");
  assert.equal(formatCountdown(now + (4 * 60 + 9) * 1000, now), "4m 09s");
  assert.equal(formatCountdown(new Date(now - 1000).toISOString(), now), null);
  assert.equal(formatCountdown(now, now), null);
  assert.equal(formatCountdown("not a date", now), null);
  assert.equal(formatCountdown(null, now), null);
});

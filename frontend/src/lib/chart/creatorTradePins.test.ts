import assert from "node:assert/strict";
import test from "node:test";
import { layoutCreatorPins } from "./creatorTradePins.ts";

test("two creator buys on the same bar stay as two pills", () => {
  const placed = layoutCreatorPins(
    [
      { id: "tx-a:buy:1", x: 120, y: 40, timestamp: 100 },
      { id: "tx-b:buy:1", x: 122, y: 38, timestamp: 101 },
    ],
    { width: 400, height: 260 },
  );
  assert.equal(placed.length, 2);
  assert.equal(placed[0].stackCount, 2);
  assert.equal(placed[1].stackCount, 2);
  assert.notEqual(placed[0].id, placed[1].id);
  const overlap = Math.hypot(placed[0].x - placed[1].x, placed[0].y - placed[1].y);
  assert.ok(overlap >= 16, `pills overlapped: ${overlap}`);
});

test("a pin with a missing y still renders instead of disappearing", () => {
  const placed = layoutCreatorPins(
    [
      { id: "tx-a:buy:1", x: 80, y: 90, timestamp: 100 },
      { id: "tx-b:buy:1", x: 200, y: null, timestamp: 400 },
    ],
    { width: 400, height: 260 },
  );
  assert.equal(placed.length, 2);
  assert.ok(placed.every((pin) => Number.isFinite(pin.x) && Number.isFinite(pin.y)));
});

import assert from "node:assert/strict";
import test from "node:test";
import { gasWithHeadroom } from "./evmGasHeadroom.mjs";

test("estimate + 25% + 50k; covers the 2026-10-09 testnet shortfall", async () => {
  const g = await gasWithHeadroom(async () => 454_453n);
  assert.equal(g, 618_066n);
  assert.ok(g > 455_225n);
});

test("a floor wins when the padded estimate is lower; a failed estimate returns the floor or undefined", async () => {
  assert.equal(await gasWithHeadroom(async () => 100_000n, 650_000n), 650_000n);
  assert.equal(await gasWithHeadroom(async () => 600_000n, 650_000n), 800_000n);
  assert.equal(await gasWithHeadroom(async () => { throw new Error("revert"); }, 650_000n), 650_000n);
  assert.equal(await gasWithHeadroom(async () => { throw new Error("revert"); }), undefined);
});

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

test("Robinhood legacy gas price gets 50% headroom over eth_gasPrice; BNB and others unchanged", async () => {
  const { legacyGasPriceFor } = await import("./evmGasHeadroom.mjs");
  // 2026-10-10 refusal: price 20,034,000 vs base fee 20,044,000
  assert.equal(legacyGasPriceFor(4663, 20_034_000n), 30_051_000n);
  assert.ok(legacyGasPriceFor(4663, 20_034_000n) > 20_044_000n);
  assert.equal(legacyGasPriceFor(46630, 20_000_000n), 30_000_000n);
  assert.equal(legacyGasPriceFor("4663", 20_000_000n), 30_000_000n);
  for (const chainId of [56, 97, 101, 1, undefined]) assert.equal(legacyGasPriceFor(chainId, 1_000_000_000n), 1_000_000_000n);
  assert.equal(legacyGasPriceFor(4663, 0n), 0n);
});

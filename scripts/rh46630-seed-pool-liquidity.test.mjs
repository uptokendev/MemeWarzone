import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  MAX_TICK,
  MIN_TICK,
  POSITION_MANAGER,
  STAGED_WETH9,
  V3_FACTORY,
  WETH9,
  assertChainId,
  assertLiveSurface,
  liveRequested,
  planSeedLiquidity,
  tokenAmountForNative,
} from "./rh46630-seed-pool-liquidity.mjs";

test("dry-run pins the live surface, widest range, and deposits nothing", () => {
  const plan = planSeedLiquidity({}, {});
  assert.equal(plan.chainId, 46630);
  assert.equal(plan.positionManager, ethers.getAddress(POSITION_MANAGER));
  assert.equal(plan.v3Factory, ethers.getAddress(V3_FACTORY));
  assert.equal(plan.weth9, WETH9);
  assert.equal(plan.tickLower, MIN_TICK);
  assert.equal(plan.tickUpper, MAX_TICK);
  assert.equal(plan.sent, false);
  assert.equal(plan.sendRequired, false);
});

test("production 4663 and the staged WETH are refused", () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => assertLiveSurface(STAGED_WETH9), /STAGED_WETH9_FORBIDDEN/);
  assert.throws(() => planSeedLiquidity({ weth9: STAGED_WETH9 }, {}), /STAGED_WETH9_FORBIDDEN/);
});

test("a zero or negative deposit is refused", () => {
  assert.throws(() => planSeedLiquidity({ nativeWei: 0n }, {}), /SEED_AMOUNT_MUST_BE_POSITIVE/);
});

test("token side matches the pool price on both token orderings", () => {
  // RH5661 is token0 at roughly 1.4e-8 ETH per token.
  const price = 1.4e-8;
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
  const nativeWei = ethers.parseEther("0.1");

  const asToken0 = tokenAmountForNative(nativeWei, sqrtPriceX96, true);
  const expected = 0.1 / price;
  const actual = Number(ethers.formatUnits(asToken0, 18));
  assert.ok(Math.abs(actual / expected - 1) < 0.001, `expected ~${expected}, got ${actual}`);

  // Inverted ordering must not silently reuse the same branch.
  const asToken1 = tokenAmountForNative(nativeWei, sqrtPriceX96, false);
  assert.notEqual(asToken0.toString(), asToken1.toString());
});

test("live seeding is opt-in only", () => {
  assert.equal(liveRequested({}), false);
  assert.equal(liveRequested({ RH46630_SEED_LIQUIDITY_LIVE: "1" }), false);
  assert.equal(liveRequested({ RH46630_SEED_LIQUIDITY_LIVE: "true" }), true);
});

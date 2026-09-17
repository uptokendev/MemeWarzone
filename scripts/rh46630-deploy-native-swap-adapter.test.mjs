import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_SWAP_ROUTER,
  LIVE_WETH9,
  STAGED_NATIVE_SWAP_ADAPTER,
  STAGED_SWAP_ROUTER,
  STAGED_WETH9,
  assertChainId,
  assertLiveSurface,
  liveRequested,
  planAdapterDeploy,
} from "./rh46630-deploy-native-swap-adapter.mjs";

test("dry-run targets the live V3 surface and deploys nothing", () => {
  const plan = planAdapterDeploy({}, {});
  assert.equal(plan.chainId, 46630);
  assert.equal(plan.contract, "RobinhoodV3NativeSwapAdapter");
  assert.deepEqual(plan.constructorArgs, [LIVE_SWAP_ROUTER, LIVE_WETH9]);
  assert.equal(plan.sent, false);
  assert.equal(plan.sendRequired, false);
  assert.equal(plan.envVar, "VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_46630");
});

test("production 4663 is refused", () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => assertChainId(56), /WRONG_CHAIN_56/);
});

test("the staged 0xF170 V3 surface cannot be bound", () => {
  assert.throws(() => assertLiveSurface(STAGED_SWAP_ROUTER, LIVE_WETH9), /STAGED_SWAP_ROUTER_FORBIDDEN/);
  assert.throws(() => assertLiveSurface(LIVE_SWAP_ROUTER, STAGED_WETH9), /STAGED_WETH9_FORBIDDEN/);
  assert.throws(
    () => planAdapterDeploy({ swapRouter: STAGED_SWAP_ROUTER }, {}),
    /STAGED_SWAP_ROUTER_FORBIDDEN/,
  );
  // The already-deployed staged adapter is recorded so a deploy can never return it.
  assert.equal(planAdapterDeploy({}, {}).forbiddenStagedAdapter, STAGED_NATIVE_SWAP_ADAPTER);
});

test("an unrecognised surface is refused rather than guessed", () => {
  assert.throws(
    () => assertLiveSurface("0x000000000000000000000000000000000000dEaD", LIVE_WETH9),
    /UNEXPECTED_SWAP_ROUTER/,
  );
});

test("live deploy is opt-in only", () => {
  assert.equal(liveRequested({}), false);
  assert.equal(liveRequested({ RH46630_DEPLOY_ADAPTER_LIVE: "1" }), false);
  assert.equal(liveRequested({ RH46630_DEPLOY_ADAPTER_LIVE: "true" }), true);
  assert.equal(planAdapterDeploy({}, { RH46630_DEPLOY_ADAPTER_LIVE: "true" }).sendRequired, true);
});

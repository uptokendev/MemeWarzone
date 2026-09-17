import assert from "node:assert/strict";
import test from "node:test";

import {
  FORBIDDEN_STAGED_FACTORY,
  SWAP_ROUTER_02,
  V3_FACTORY,
  WETH9,
  assertChainId,
  assertNotStagedFactory,
  liveRequested,
  planPostGradSwap,
} from "./rh46630-postgrad-v3-swap.mjs";

test("dry-run pins the live 46630 V3 surface and sends nothing", () => {
  const plan = planPostGradSwap({}, {});
  assert.equal(plan.chainId, 46630);
  assert.equal(plan.native, "ETH");
  assert.equal(plan.v3Factory, V3_FACTORY);
  assert.equal(plan.swapRouter, SWAP_ROUTER_02);
  assert.equal(plan.weth9, WETH9);
  assert.equal(plan.feeTier, 3000);
  assert.equal(plan.sent, false);
  assert.equal(plan.sendRequired, false);
  assert.deepEqual(plan.steps, [
    "exactInputSingle:ETH->TOKEN",
    "approve:TOKEN->router",
    "exactInputSingle:TOKEN->WETH",
  ]);
});

test("production 4663 and the staged 0xF170 factory are refused", () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => assertChainId(56), /WRONG_CHAIN_56/);
  assert.throws(() => assertNotStagedFactory(FORBIDDEN_STAGED_FACTORY), /STAGED_F170_FACTORY_FORBIDDEN/);
  assert.throws(() => planPostGradSwap({ campaign: FORBIDDEN_STAGED_FACTORY }, {}), /STAGED_F170_FACTORY_FORBIDDEN/);
});

test("live mode is opt-in only", () => {
  assert.equal(liveRequested({}), false);
  assert.equal(liveRequested({ RH46630_POSTGRAD_SWAP_LIVE: "1" }), false);
  assert.equal(liveRequested({ RH46630_POSTGRAD_SWAP_LIVE: "true" }), true);
  assert.equal(planPostGradSwap({}, { RH46630_POSTGRAD_SWAP_LIVE: "true" }).sendRequired, true);
});

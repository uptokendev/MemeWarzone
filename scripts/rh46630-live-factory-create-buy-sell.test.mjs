import assert from "node:assert/strict";
import test from "node:test";

import {
  FORBIDDEN_STAGED_FACTORY,
  GREEN_FACTORY,
  assertChainId,
  assertLiveFactory,
  planCreateBuySell,
  runCreateBuySell,
} from "./rh46630-live-factory-create-buy-sell.mjs";

test("46630 dry-run pins live factory, ETH, and create/buy/sell steps", () => {
  const plan = planCreateBuySell({ chainId: 46630, runId: "99" }, {});
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.native, "ETH");
  assert.equal(plan.factory, GREEN_FACTORY);
  assert.equal(plan.forbiddenFactory, FORBIDDEN_STAGED_FACTORY);
  assert.deepEqual(plan.steps, [
    "createCampaignAuthorized",
    "buyExactTokensAuthorized",
    "sellExactTokensAuthorized",
  ]);
  assert.equal(plan.sendRequired, false);
  assert.equal(plan.graduationTargetWei, "6000000000000000000");
});

test("production 4663 and staged 0xF170 are forbidden", () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => assertLiveFactory(FORBIDDEN_STAGED_FACTORY), /STAGED_F170_FACTORY_FORBIDDEN/);
  assert.throws(() => planCreateBuySell({ chainId: 4663 }, {}), /PRODUCTION_4663_FORBIDDEN/);
});

test("missing live flag never sends", async () => {
  let sends = 0;
  const result = await runCreateBuySell({
    plan: planCreateBuySell({ chainId: 46630 }, {}),
    sendCreate: async () => {
      sends += 1;
      return { campaign: GREEN_FACTORY, token: GREEN_FACTORY };
    },
    sendBuy: async () => {
      sends += 1;
      return { txHash: "0x1" };
    },
    sendApprove: async () => {
      sends += 1;
    },
    sendSell: async () => {
      sends += 1;
      return { txHash: "0x2" };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(sends, 0);
});

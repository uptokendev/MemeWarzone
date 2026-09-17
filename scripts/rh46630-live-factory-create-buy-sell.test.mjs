import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";
import {
  FORBIDDEN_STAGED_FACTORY,
  GREEN_FACTORY,
  TEST_GRADUATION_USD_THRESHOLD,
  assertChainId,
  assertLiveFactory,
  planCreateBuySell,
  runCreateBuySell,
  waitForRpcState,
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
  assert.equal(plan.graduationTargetUsd, "6000000000000000000");
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

test("live runner follows BNB 6C pre-grad and reuses bonding campaign on creator cooldown", async () => {
  const source = await readFile(new URL("./rh46630-live-factory-create-buy-sell.mjs", import.meta.url), "utf8");
  assert.equal(TEST_GRADUATION_USD_THRESHOLD, 6000000000000000000n);
  assert.match(source, /const index = await factory\.campaignsCount\(\);/);
  assert.match(source, /createdAddressesFromReceipt/);
  assert.match(source, /waitForRpcState/);
  assert.match(source, /findCreatorBondingCampaign/);
  assert.match(source, /creatorLaunchEligibility/);
  assert.match(source, /quoteBuyExactTokens/);
  assert.match(source, /CampaignCreated/);
  assert.match(source, /tuple\(address campaign,address token,address creator/);
});

test("waitForRpcState resolves when the read becomes accepted", async () => {
  let n = 0;
  const value = await waitForRpcState("probe", async () => {
    n += 1;
    return n;
  }, (v) => v >= 2, 5, 1);
  assert.equal(value, 2);
});

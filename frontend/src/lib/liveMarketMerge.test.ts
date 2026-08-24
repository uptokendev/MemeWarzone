import assert from "node:assert/strict";
import test from "node:test";
import { liveCampaignKey, mergeFeedWithCreated, pickLiveNumeric } from "./liveMarketMerge.ts";

const SOLANA = "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH";

test("liveCampaignKey preserves Solana base58 and lowercases EVM", () => {
  assert.equal(liveCampaignKey(101, SOLANA), SOLANA);
  assert.equal(liveCampaignKey(56, "0xABCDef0123456789ABCDef0123456789ABCDef01"), "0xabcdef0123456789abcdef0123456789abcdef01");
});

test("pickLiveNumeric prefers finite live including zero only when live is finite", () => {
  assert.equal(pickLiveNumeric("12.5", 1), 12.5);
  assert.equal(pickLiveNumeric(null, 9), 9);
  assert.equal(pickLiveNumeric("", 9), 9);
  assert.equal(Number.isNaN(pickLiveNumeric(undefined, undefined)), true);
});

test("mergeFeedWithCreated prepends Ably creates and does not drop REST rows", () => {
  const rest = [
    { campaignAddress: "0xabc", chainId: 56, name: "Rest" },
  ];
  const created = [
    { campaignAddress: "0xabc", name: "Dup" },
    { campaignAddress: "0xdef", name: "New" },
  ];
  const merged = mergeFeedWithCreated(rest, created, 56, (row) => ({
    campaignAddress: row.campaignAddress,
    chainId: 56,
    name: row.name,
  }));
  assert.equal(merged[0].name, "New");
  assert.equal(merged[1].name, "Rest");
  assert.equal(merged.length, 2);
});

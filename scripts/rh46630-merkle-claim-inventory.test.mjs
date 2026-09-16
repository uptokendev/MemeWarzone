import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_CHAIN_ID,
  assertStagingChainId,
  configuredClaimAddresses,
  hasRuntimeCode,
  normalizeConfiguredAddress,
  parseEnv,
} from "./rh46630-merkle-claim-inventory.mjs";

test("46630 is accepted and production 4663 is refused", () => {
  assert.equal(assertStagingChainId("0xb626"), EXPECTED_CHAIN_ID);
  assert.throws(() => assertStagingChainId(4663), /refusing production Robinhood chainId 4663/u);
});

test("placeholder and empty claim addresses are missing", () => {
  assert.equal(normalizeConfiguredAddress(""), null);
  assert.equal(normalizeConfiguredAddress("0x<REWARD_DISTRIBUTOR_ADDRESS_46630>"), null);
  assert.equal(normalizeConfiguredAddress("0x<TREASURY_VAULT_ADDRESS_46630>"), null);
  assert.equal(normalizeConfiguredAddress("0x0000000000000000000000000000000000000000"), null);
});

test("configured address inventory prefers explicit V2 and accepts the legacy vault key", () => {
  const valid = "0x1111111111111111111111111111111111111111";
  const legacy = configuredClaimAddresses(parseEnv(`\nREWARD_DISTRIBUTOR_ADDRESS_46630=0x<RD>\nTREASURY_VAULT_ADDRESS_46630=${valid}\n`));
  assert.deepEqual(legacy, { rewardDistributor: null, treasuryVaultV2: valid });

  const explicit = configuredClaimAddresses({
    TREASURY_VAULT_ADDRESS_46630: valid,
    TREASURY_VAULT_V2_ADDRESS_46630: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(explicit.treasuryVaultV2, "0x2222222222222222222222222222222222222222");
});

test("eth_getCode semantics treat empty code as missing", () => {
  assert.equal(hasRuntimeCode("0x"), false);
  assert.equal(hasRuntimeCode("0x0"), false);
  assert.equal(hasRuntimeCode("0x00"), false);
  assert.equal(hasRuntimeCode("0x60006000"), true);
});

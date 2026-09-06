import assert from "node:assert/strict";
import test from "node:test";

import {
  BNB_BASIC_CAMPAIGN_GENERATION,
  BNB_BASIC_FACTORY_GENERATION,
  buildBnbBasicQuoteCatalogBinding,
} from "./bnbBasicQuoteCatalogBinding.js";

const BASE = {
  id: "11111111-2222-3333-4444-555555555555",
  contractAddressOrMint: "0x1111111111111111111111111111111111111111",
  provider: {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    key: "bnb-basic-canonical",
  },
  policy: {
    policyKey: "bnb-basic-stable",
    version: 7,
  },
  stateVersion: 12,
};

test("BNB BASIC catalog binding commits the exact Agent 1 selection and generation", () => {
  const binding = buildBnbBasicQuoteCatalogBinding(BASE);
  assert.match(binding.bindingHash, /^0x[0-9a-f]{64}$/i);
  assert.equal(binding.deploymentId, BASE.id);
  assert.equal(binding.quoteToken.toLowerCase(), BASE.contractAddressOrMint.toLowerCase());
  assert.equal(binding.providerId, BASE.provider.id);
  assert.equal(binding.providerKey, BASE.provider.key);
  assert.equal(binding.policyKey, BASE.policy.policyKey);
  assert.equal(binding.policyVersion, 7n);
  assert.equal(binding.deploymentStateVersion, 12n);
  assert.equal(binding.factoryGeneration, BNB_BASIC_FACTORY_GENERATION);
  assert.equal(binding.campaignGeneration, BNB_BASIC_CAMPAIGN_GENERATION);
});

test("any catalog deployment/provider/policy/address/state change produces a different commitment", () => {
  const baseline = buildBnbBasicQuoteCatalogBinding(BASE).bindingHash;
  const variants = [
    { ...BASE, id: "11111111-2222-3333-4444-555555555556" },
    { ...BASE, contractAddressOrMint: "0x2222222222222222222222222222222222222222" },
    { ...BASE, provider: { ...BASE.provider, id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef" } },
    { ...BASE, provider: { ...BASE.provider, key: "bnb-basic-other-provider" } },
    { ...BASE, policy: { ...BASE.policy, policyKey: "bnb-basic-stable-v2" } },
    { ...BASE, policy: { ...BASE.policy, version: 8 } },
    { ...BASE, stateVersion: 13 },
  ];
  for (const variant of variants) {
    assert.notEqual(buildBnbBasicQuoteCatalogBinding(variant).bindingHash, baseline);
  }
});

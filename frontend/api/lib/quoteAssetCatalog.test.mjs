import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveGenericQuoteAuthority,
  mapRobinhoodStockToQuoteAsset,
  normalizeQuoteIdentity,
  ROBINHOOD_BASIC_PROVIDER_KEY,
  ROBINHOOD_STOCK_PROVIDER_KEY,
} from "./quoteAssetCatalog.js";

test("EVM quote identity is exact-address based, not symbol based", () => {
  const identity = normalizeQuoteIdentity({
    chainId: 4663,
    identityKind: "EVM_ADDRESS",
    contractAddressOrMint: "0x00000000000000000000000000000000000000aA",
  });
  assert.equal(identity.chainId, "4663");
  assert.equal(identity.identityKind, "EVM_ADDRESS");
  assert.equal(identity.identityKey, "0x00000000000000000000000000000000000000aa");
});

test("native identity uses an explicit chain sentinel", () => {
  const identity = normalizeQuoteIdentity({ chainId: 56, identityKind: "NATIVE" });
  assert.equal(identity.identityKey, "native:56");
});

test("generic policy requires explicit BASIC approval and server-side health gates", () => {
  const base = {
    provider: { admin_state: "enabled" },
    asset: { admin_state: "enabled" },
    deployment: {
      admin_state: "enabled",
      identity_status: "verified",
      security_status: "verified",
      market_health_status: "healthy",
      existing_market_support: true,
    },
    policy: {
      policy_status: "active",
      basic_approved: true,
      new_graduation_enabled: true,
      require_identity_verified: true,
      require_security_verified: true,
      require_market_healthy: true,
      policy_key: "robinhood-usdc-basic",
      version: 1,
    },
  };
  assert.equal(deriveGenericQuoteAuthority(base).newGraduationEligible, true);
  assert.equal(deriveGenericQuoteAuthority({ ...base, policy: { ...base.policy, basic_approved: false } }).newGraduationEligible, false);
  assert.equal(deriveGenericQuoteAuthority({ ...base, deployment: { ...base.deployment, market_health_status: "review" } }).newGraduationEligible, false);
  assert.equal(deriveGenericQuoteAuthority({ ...base, deployment: { ...base.deployment, admin_state: "disabled" } }).newGraduationEligible, false);
});

test("existing-market support remains independent from new-graduation eligibility", () => {
  const authority = deriveGenericQuoteAuthority({
    provider: { admin_state: "enabled" },
    asset: { admin_state: "enabled" },
    deployment: {
      admin_state: "enabled",
      identity_status: "review",
      security_status: "review",
      market_health_status: "review",
      existing_market_support: true,
    },
    policy: {
      policy_status: "active",
      basic_approved: true,
      new_graduation_enabled: false,
      require_identity_verified: true,
      require_security_verified: true,
      require_market_healthy: true,
    },
  });
  assert.equal(authority.newGraduationEligible, false);
  assert.equal(authority.existingMarketSupport, true);
});

test("Robinhood Stock Token compatibility is a pure projection of existing authority", () => {
  const stock = {
    id: "11111111-1111-1111-1111-111111111111",
    chainId: 4663,
    contractAddress: "0x00000000000000000000000000000000000000AA",
    symbol: "TESTX",
    displayName: "Test Stock Token",
    stateVersion: 7,
    canonical: true,
    automatedHealthStatus: "healthy",
    marketStatus: "eligible",
    enabledForGraduation: true,
    enabledForTrading: true,
    existingMarketSupport: true,
    adminState: "default",
    lastVerifiedAt: "2026-09-06T20:00:00.000Z",
  };
  const quote = mapRobinhoodStockToQuoteAsset(stock);
  assert.equal(quote.provider.key, ROBINHOOD_STOCK_PROVIDER_KEY);
  assert.equal(quote.provider.authorityMode, "ROBINHOOD_STOCK_REGISTRY");
  assert.equal(quote.newGraduationEligible, stock.enabledForGraduation);
  assert.equal(quote.existingMarketSupport, stock.enabledForTrading);
  assert.equal(quote.contractAddressOrMint, stock.contractAddress);
  assert.equal(quote.stateVersion, stock.stateVersion);
  assert.equal(quote.policy.authority, "delegated");
});

test("Robinhood BASIC provider is distinct from Stock Token provider", () => {
  assert.notEqual(ROBINHOOD_BASIC_PROVIDER_KEY, ROBINHOOD_STOCK_PROVIDER_KEY);
});

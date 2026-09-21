import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/test";

const { profileForAssetClass, providerClassCode, allowedQuoteProfiles } = await import("./solana-graduation-authorization-v2.js");

test("every catalog asset class maps onto one of the five on-chain profile slots", () => {
  assert.equal(profileForAssetClass("NATIVE"), 0);
  assert.equal(profileForAssetClass("STABLECOIN"), 1);
  assert.equal(profileForAssetClass("PROVIDER_RWA"), 2);
  assert.equal(profileForAssetClass("PUBLIC_RWA"), 2);
  assert.equal(profileForAssetClass("PRE_IPO_RWA"), 2);
  assert.equal(profileForAssetClass("COMMODITY"), 2);
  assert.equal(profileForAssetClass("MWZ_NATIVE"), 3);
  assert.equal(profileForAssetClass("COMMUNITY"), 4);
  assert.equal(profileForAssetClass("crypto"), 4, "ecosystem crypto shares the community slot");
  assert.throws(() => profileForAssetClass("LEVERAGED_OR_YIELD"), (error) => error.code === "SOLANA_GRADUATION_QUOTE_NOT_APPROVED");
  assert.throws(() => profileForAssetClass(""), (error) => error.code === "SOLANA_GRADUATION_QUOTE_NOT_APPROVED");
});

test("catalog provider classes map onto on-chain provider class codes", () => {
  assert.equal(providerClassCode("BASIC"), 1);
  assert.equal(providerClassCode("STABLECOIN"), 1);
  assert.equal(providerClassCode("ECOSYSTEM"), 1);
  assert.equal(providerClassCode("PROVIDER_RWA"), 2);
  assert.equal(providerClassCode("COMMUNITY"), 4);
  assert.throws(() => providerClassCode("UNKNOWN"), (error) => error.code === "SOLANA_GRADUATION_QUOTE_NOT_APPROVED");
});

test("release gate: default is native + stablecoin; explicit list wins; unknown names refuse to start", () => {
  assert.deepEqual([...allowedQuoteProfiles({})].sort(), [0, 1]);
  assert.deepEqual([...allowedQuoteProfiles({ SOLANA_GRADUATION_BASIC_RELEASE_ONLY: "false" })].sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual([...allowedQuoteProfiles({ SOLANA_GRADUATION_ALLOWED_QUOTE_PROFILES: "NATIVE, STABLECOIN, COMMUNITY" })].sort(), [0, 1, 4]);
  assert.deepEqual([...allowedQuoteProfiles({ SOLANA_GRADUATION_ALLOWED_QUOTE_PROFILES: "native", SOLANA_GRADUATION_BASIC_RELEASE_ONLY: "false" })], [0], "explicit list overrides the legacy switch");
  assert.throws(() => allowedQuoteProfiles({ SOLANA_GRADUATION_ALLOWED_QUOTE_PROFILES: "NATIVE,MOON" }), (error) => error.code === "SOLANA_GRADUATION_CONFIGURATION_INVALID");
});

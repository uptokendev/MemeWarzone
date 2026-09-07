import assert from "node:assert/strict";
import test from "node:test";

import {
  availableCreatorQuoteCategories,
  creatorQuoteIdentityKey,
  filterCreatorQuoteAssets,
  isCreatorQuoteSelectable,
  quoteHasTrendingDisplayMetadata,
} from "./graduationQuotePickerLaunch.mjs";
import {
  buildCreateDraftGraduationFields,
  directDeployBindPath,
} from "./graduationMarketPresentation.mjs";

function asset(overrides = {}) {
  return {
    id: "deployment-1",
    chainId: "56",
    provider: { key: "bnb-basic", displayName: "BNB" },
    contractAddressOrMint: "0x1111111111111111111111111111111111111111",
    symbol: "USDC",
    displayName: "USD Coin",
    assetClass: "STABLECOIN",
    category: "STABLES_CURRENCIES",
    catalogState: "ACTIVE",
    adminState: "enabled",
    newGraduationEligible: true,
    stateVersion: 7,
    ...overrides,
  };
}

test("eligible assets remain selectable on BNB, Solana and Robinhood", () => {
  for (const item of [
    asset({ chainId: "56" }),
    asset({ id: "sol", chainId: "101", provider: { key: "solana-basic" }, contractAddressOrMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }),
    asset({ id: "rh", chainId: "4663", provider: { key: "robinhood-basic" }, contractAddressOrMint: "0x2222222222222222222222222222222222222222" }),
  ]) assert.equal(isCreatorQuoteSelectable(item), true);
});

test("pending, rejected, support-only, disabled and non-new-graduation assets are not selectable", () => {
  for (const item of [
    asset({ catalogState: "PENDING" }),
    asset({ catalogState: "REJECTED" }),
    asset({ catalogState: "SUPPORT_ONLY" }),
    asset({ adminState: "disabled" }),
    asset({ newGraduationEligible: false, existingMarketSupport: true }),
  ]) assert.equal(isCreatorQuoteSelectable(item), false);
});

test("same ticker on different chains never collides by identity", () => {
  const bnb = asset();
  const sol = asset({ id: "sol-usdc", chainId: "101", provider: { key: "solana-basic" }, contractAddressOrMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
  assert.notEqual(creatorQuoteIdentityKey(bnb), creatorQuoteIdentityKey(sol));
  assert.deepEqual(filterCreatorQuoteAssets([bnb, sol], { chainId: 101 }).map((item) => item.id), ["sol-usdc"]);
});

test("search covers symbol, name, provider and category", () => {
  const stock = asset({ id: "stock", symbol: "SPYX", displayName: "S&P 500 Token", category: "ETFS", provider: { key: "xstocks", displayName: "xStocks" } });
  for (const query of ["SPYX", "500", "xstocks", "etfs"]) {
    assert.deepEqual(filterCreatorQuoteAssets([stock], { chainId: 56, query }).map((item) => item.id), ["stock"]);
  }
});

test("category filters use approved taxonomy and scale without count assumptions", () => {
  const items = Array.from({ length: 55 }, (_, index) => asset({ id: `a-${index}`, category: index % 2 ? "CORE" : "ECOSYSTEM", symbol: `Q${index}` }));
  assert.equal(filterCreatorQuoteAssets(items, { chainId: 56 }).length, 55);
  assert.equal(filterCreatorQuoteAssets(items, { chainId: 56, category: "CORE" }).length, 27);
  assert.deepEqual(availableCreatorQuoteCategories(items, 56).map((item) => item.id), ["CORE", "ECOSYSTEM"]);
});

test("TRENDING is display metadata only and cannot grant eligibility", () => {
  const pendingTrending = asset({ tags: ["TRENDING"], newGraduationEligible: false, catalogState: "PENDING" });
  assert.equal(quoteHasTrendingDisplayMetadata(pendingTrending), true);
  assert.equal(isCreatorQuoteSelectable(pendingTrending), false);
});

test("empty eligible catalog stays empty without native fabrication", () => {
  assert.deepEqual(filterCreatorQuoteAssets([], { chainId: 56 }), []);
  assert.deepEqual(filterCreatorQuoteAssets([asset({ newGraduationEligible: false })], { chainId: 56 }), []);
});

test("draft deployment stores exact catalog identity and state version", () => {
  const selected = asset({ id: "exact-deployment", stateVersion: 19, policy: { version: 4 } });
  const fields = buildCreateDraftGraduationFields(selected, 56);
  assert.equal(fields.graduationQuoteAssetId, "exact-deployment");
  assert.equal(fields.graduationQuoteStateVersion, 19);
  assert.equal(fields.graduationMarketPolicyVersion, "4");
});

test("generic approved quote never silently becomes native Direct path", () => {
  const selected = asset({ id: "approved-stable" });
  assert.equal(directDeployBindPath(selected), null);
  assert.equal(directDeployBindPath(asset({ newGraduationEligible: false })), null);
});

test("Robinhood approved Stock Token lane remains explicit", () => {
  const stock = asset({ id: "rh-stock:abc", chainId: "4663", provider: { key: "robinhood-stock-token" }, assetClass: "PROVIDER_RWA", category: "STOCKS" });
  assert.equal(directDeployBindPath(stock), "robinhood-stock");
  const fields = buildCreateDraftGraduationFields(stock, 4663);
  assert.equal(fields.graduationMarketKind, "STOCK_TOKEN");
  assert.equal(fields.graduationQuoteAsset, stock.contractAddressOrMint);
});

test("no arbitrary address or symbol-only selection exists in picker authority", () => {
  assert.equal(creatorQuoteIdentityKey({ symbol: "USDC", chainId: "56" }), "");
  assert.equal(isCreatorQuoteSelectable({ symbol: "USDC", newGraduationEligible: true }), true);
  assert.equal(creatorQuoteIdentityKey(asset()).includes("0x1111111111111111111111111111111111111111"), true);
});

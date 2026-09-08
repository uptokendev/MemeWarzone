import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { displayQuoteSymbol } from "./graduationMarketPresentation.mjs";
import {
  availableCreatorQuoteCategories,
  creatorQuoteAvailabilityLabel,
  creatorQuoteIdentityKey,
  defaultNativeQuoteAsset,
  filterCreatorQuoteAssets,
  isCreatorQuoteSelectable,
  quoteHasTrendingDisplayMetadata,
  reconcileGraduationMarketSelection,
  sameAuthoritativeQuoteIdentity,
} from "./graduationQuotePicker.mjs";
import {
  buildCreateDraftGraduationFields,
  directDeployBindPath,
} from "./graduationMarketPresentation.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function asset(overrides = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    chainId: "56",
    provider: { key: "bnb-basic", displayName: "BNB BASIC" },
    contractAddressOrMint: "0x1111111111111111111111111111111111111111",
    identityKind: "EVM_ADDRESS",
    symbol: "USDC",
    displayName: "USD Coin",
    assetClass: "STABLECOIN",
    category: "STABLES_CURRENCIES",
    adminState: "enabled",
    newGraduationEligible: true,
    stateVersion: 7,
    policy: { version: 4, policyKey: "bnb-usdc-basic" },
    ...overrides,
  };
}

function bnbNative(overrides = {}) {
  return asset({
    id: "native:56",
    identityKind: "NATIVE",
    assetClass: "NATIVE",
    symbol: "WBNB",
    displayName: "BNB",
    contractAddressOrMint: "native:56",
    category: "CORE",
    presentationDefault: true,
    policy: { authority: "presentation-default", policyKey: "chain-native-default", version: null },
    stateVersion: 0,
    ...overrides,
  });
}

function solNative(overrides = {}) {
  return asset({
    id: "sol-native-deployment",
    chainId: "101",
    provider: { key: "solana-basic", displayName: "Solana BASIC" },
    identityKind: "NATIVE",
    assetClass: "NATIVE",
    symbol: "WSOL",
    displayName: "SOL",
    contractAddressOrMint: "So11111111111111111111111111111111111111112",
    category: "CORE",
    presentationDefault: false,
    ...overrides,
  });
}

function rhNative(overrides = {}) {
  return asset({
    id: "rh-native-deployment",
    chainId: "4663",
    provider: { key: "robinhood-basic", displayName: "Robinhood BASIC" },
    identityKind: "NATIVE",
    assetClass: "NATIVE",
    symbol: "WETH",
    displayName: "ETH",
    contractAddressOrMint: "native:4663",
    category: "CORE",
    presentationDefault: false,
    ...overrides,
  });
}

test("BNB native option displays as BNB, not WBNB", () => {
  const native = bnbNative();
  assert.equal(displayQuoteSymbol(native), "BNB");
  assert.equal(isCreatorQuoteSelectable(native), true);
  assert.equal(defaultNativeQuoteAsset([native, asset()], 56)?.id, "native:56");
});

test("Solana native option displays as SOL, not WSOL", () => {
  const native = solNative();
  assert.equal(displayQuoteSymbol(native), "SOL");
  assert.equal(isCreatorQuoteSelectable(native), true);
  assert.equal(defaultNativeQuoteAsset([native, asset({ id: "sol-usdc", chainId: "101", provider: { key: "solana-basic" }, contractAddressOrMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })], 101)?.id, "sol-native-deployment");
});

test("Robinhood native option displays as ETH, not WETH", () => {
  const native = rhNative();
  assert.equal(displayQuoteSymbol(native), "ETH");
  assert.equal(isCreatorQuoteSelectable(native), true);
  assert.equal(defaultNativeQuoteAsset([native], 4663)?.id, "rh-native-deployment");
});

test("chain switch drops the previous chain selection and defaults the new chain native", () => {
  const bnbUsdc = asset();
  const sol = solNative();
  const result = reconcileGraduationMarketSelection({
    selected: bnbUsdc,
    items: [sol, asset({ id: "sol-usdc", chainId: "101", provider: { key: "solana-basic" }, contractAddressOrMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })],
    chainId: 101,
  });
  assert.equal(result.expired, false);
  assert.equal(result.defaulted, true);
  assert.equal(result.selected?.id, "sol-native-deployment");
  assert.equal(sameAuthoritativeQuoteIdentity(bnbUsdc, result.selected), false);
});

test("exact catalog deployment ID survives selection and draft fields", () => {
  const selected = asset({ id: "exact-deployment-id", stateVersion: 19 });
  const result = reconcileGraduationMarketSelection({ selected, items: [bnbNative(), selected], chainId: 56 });
  assert.equal(result.expired, false);
  assert.equal(result.selected?.id, "exact-deployment-id");
  const fields = buildCreateDraftGraduationFields(result.selected, 56);
  assert.equal(fields.graduationQuoteAssetId, "exact-deployment-id");
  assert.equal(fields.graduationQuoteStateVersion, 19);
});

test("duplicate ticker on another chain cannot substitute identity", () => {
  const bnbUsdc = asset({ id: "bnb-usdc", symbol: "USDC" });
  const solUsdc = asset({
    id: "sol-usdc",
    chainId: "101",
    provider: { key: "solana-basic" },
    contractAddressOrMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    displayName: "USD Coin",
  });
  assert.notEqual(creatorQuoteIdentityKey(bnbUsdc), creatorQuoteIdentityKey(solUsdc));
  const result = reconcileGraduationMarketSelection({
    selected: bnbUsdc,
    items: [solNative(), solUsdc],
    chainId: 101,
  });
  assert.equal(sameAuthoritativeQuoteIdentity(bnbUsdc, solUsdc), false);
  assert.equal(result.selected?.id, "sol-native-deployment");
  assert.deepEqual(filterCreatorQuoteAssets([bnbUsdc, solUsdc], { chainId: 101 }).map((item) => item.id), ["sol-usdc"]);
});

test("stale, disabled, or version-changed selection requires reselect", () => {
  const selected = asset({ id: "live-usdc", stateVersion: 3, policy: { version: 1 } });
  const missing = reconcileGraduationMarketSelection({
    selected,
    items: [bnbNative()],
    chainId: 56,
  });
  assert.equal(missing.expired, true);
  assert.equal(missing.selected, null);
  assert.equal(missing.defaulted, false);
  assert.equal(missing.reason, "missing_or_ineligible");

  const disabled = reconcileGraduationMarketSelection({
    selected,
    items: [bnbNative(), asset({ id: "live-usdc", newGraduationEligible: false, stateVersion: 3 })],
    chainId: 56,
  });
  assert.equal(disabled.expired, true);
  assert.equal(disabled.selected, null);
  assert.equal(disabled.defaulted, false);

  const versionChanged = reconcileGraduationMarketSelection({
    selected,
    items: [bnbNative(), asset({ id: "live-usdc", stateVersion: 9, policy: { version: 1 } })],
    chainId: 56,
  });
  assert.equal(versionChanged.expired, true);
  assert.equal(versionChanged.selected, null);
  assert.equal(versionChanged.reason, "version_changed");
  assert.equal(versionChanged.defaulted, false);
});

test("empty catalog produces a safe empty state", () => {
  const result = reconcileGraduationMarketSelection({ selected: null, items: [], chainId: 101 });
  assert.equal(result.selected, null);
  assert.equal(result.expired, false);
  assert.equal(result.defaulted, false);
  assert.equal(result.reason, "empty");
  assert.deepEqual(filterCreatorQuoteAssets([], { chainId: 56 }), []);
  assert.deepEqual(availableCreatorQuoteCategories([], 56), []);
});

test("no automatic first-item fallback when native is absent", () => {
  const first = asset({ id: "first-stable" });
  const second = asset({ id: "second-stable", symbol: "USDT", contractAddressOrMint: "0x2222222222222222222222222222222222222222" });
  const result = reconcileGraduationMarketSelection({
    selected: asset({ id: "gone" }),
    items: [first, second],
    chainId: 56,
  });
  assert.equal(result.selected, null);
  assert.equal(result.expired, true);
  assert.equal(result.defaulted, false);
  assert.notEqual(result.selected?.id, "first-stable");
});

test("no automatic native fallback after same-chain invalidation", () => {
  const native = bnbNative();
  const selected = asset({ id: "stale-usdc" });
  const result = reconcileGraduationMarketSelection({
    selected,
    items: [native],
    chainId: 56,
  });
  assert.equal(result.expired, true);
  assert.equal(result.selected, null);
  assert.equal(result.defaulted, false);
  assert.notEqual(result.selected?.id, "native:56");
});

test("Direct Deploy keeps catalog identity on the existing BNB bind path and fail-closes unsupported chains", () => {
  const bnbUsdc = asset({ id: "bnb-usdc-deployment" });
  assert.equal(directDeployBindPath(bnbUsdc), "native");
  assert.equal(directDeployBindPath(bnbNative()), "native");
  assert.equal(directDeployBindPath(solNative()), "native");
  assert.equal(directDeployBindPath(rhNative()), "native");
  assert.equal(directDeployBindPath(asset({
    id: "generic-other-chain",
    chainId: "1",
    provider: { key: "other" },
  })), null);
});

test("Draft stores exact catalog identity, not ticker/address authority", () => {
  const selected = asset({
    id: "draft-deployment",
    stateVersion: 11,
    policy: { version: 6, policyKey: "bnb-usdc-basic" },
    contractAddressOrMint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const fields = buildCreateDraftGraduationFields(selected, 56);
  assert.equal(fields.graduationQuoteAssetId, "draft-deployment");
  assert.equal(fields.graduationQuoteStateVersion, 11);
  assert.equal(fields.graduationMarketPolicyVersion, "6");
  assert.equal(fields.graduationQuoteContractOrMint, undefined);
  assert.equal(fields.graduationQuoteProvider, undefined);
});

test("search covers symbol, name, provider and category/asset class", () => {
  const stock = asset({
    id: "stock",
    symbol: "SPYX",
    displayName: "S&P 500 Token",
    category: "ETFS",
    assetClass: "PROVIDER_RWA",
    provider: { key: "xstocks", displayName: "xStocks" },
  });
  for (const query of ["SPYX", "500", "xstocks", "etfs", "stocks", "provider_rwa"]) {
    assert.deepEqual(filterCreatorQuoteAssets([stock], { chainId: 56, query }).map((item) => item.id), ["stock"]);
  }
});

test("only categories with chain-local catalog assets are shown", () => {
  const items = [
    bnbNative(),
    asset(),
    asset({
      id: "gold",
      symbol: "XAU",
      assetClass: "COMMODITY",
      category: "RWA_COMMODITIES",
      contractAddressOrMint: "0x3333333333333333333333333333333333333333",
    }),
  ];
  assert.deepEqual(availableCreatorQuoteCategories(items, 56).map((item) => item.id), ["POPULAR", "STABLECOINS", "COMMODITIES"]);
  assert.deepEqual(availableCreatorQuoteCategories(items, 101).map((item) => item.id), []);
});

test("TRENDING metadata cannot grant eligibility", () => {
  const pendingTrending = asset({ tags: ["TRENDING"], newGraduationEligible: false });
  assert.equal(quoteHasTrendingDisplayMetadata(pendingTrending), true);
  assert.equal(isCreatorQuoteSelectable(pendingTrending), false);
  assert.equal(creatorQuoteAvailabilityLabel(pendingTrending), "Not currently available");
});

test("ticker or symbol-only objects are never selectable identity", () => {
  const symbolOnly = { symbol: "USDC", chainId: "56", newGraduationEligible: true };
  assert.equal(creatorQuoteIdentityKey(symbolOnly), "");
  assert.equal(isCreatorQuoteSelectable(symbolOnly), false);
});

test("Step 5 stays full width and does not restore first-item or native fallback", () => {
  const create = readFileSync(join(here, "../pages/Create.tsx"), "utf8");
  const step = readFileSync(join(here, "../components/create/GraduationMarketStep.tsx"), "utf8");
  const step5 = create.slice(create.indexOf("{step === 5"), create.indexOf("{step === 6"));
  const review = create.slice(create.indexOf("{step === 6"), create.indexOf("export default Create"));
  assert.match(step5, /CreateFullPane/);
  assert.match(step5, /GraduationMarketStep/);
  assert.doesNotMatch(step5, /CreateSplitPane/);
  assert.match(step, /reconcileGraduationMarketSelection/);
  assert.doesNotMatch(step, /availableItems\[0\]/);
  assert.doesNotMatch(step, /catalogItems\[0\]/);
  assert.match(step, /graduation-market-stale-selection/);
  assert.match(step, /quote-asset-\$\{asset\.id\}/);
  assert.match(review, /Graduation Market/);
  assert.match(review, /Bonding currency/);
  assert.match(review, /graduationSummary\.pair/);
  assert.match(review, /graduationSummary\.bonding/);
});

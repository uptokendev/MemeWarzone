import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCreateDraftGraduationFields,
  catalogQuoteAssetsOnly,
  categoryForQuoteAsset,
  directDeployBindPath,
  displayQuoteSymbol,
  groupQuoteAssetsByCategory,
  isMovingQuoteAsset,
  isNativeQuote,
  isRobinhoodStockQuote,
  MOVING_QUOTE_NOTICE,
  nativeSymbol,
  providerLabel,
  robinhoodLegacyMarketKind,
  selectedMarketSummary,
} from "./graduationMarketPresentation.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function catalogQuote(overrides = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    provider: { key: "bnb-basic", displayName: "BNB BASIC" },
    chainId: "56",
    identityKind: "NATIVE",
    contractAddressOrMint: "native:56",
    assetClass: "NATIVE",
    symbol: "BNB",
    displayName: "BNB",
    newGraduationEligible: true,
    stateVersion: 3,
    policy: { authority: "generic", policyKey: "bnb-native-basic", version: 1 },
    ...overrides,
  };
}

test("chain copy displays SOL, BNB, and ETH — not wrapped tickers", () => {
  assert.equal(nativeSymbol(101), "SOL");
  assert.equal(nativeSymbol(56), "BNB");
  assert.equal(nativeSymbol(97), "BNB");
  assert.equal(nativeSymbol(4663), "ETH");
  assert.equal(displayQuoteSymbol(catalogQuote({ chainId: "101", symbol: "WSOL", identityKind: "NATIVE", assetClass: "NATIVE" })), "SOL");
  assert.equal(displayQuoteSymbol(catalogQuote({ chainId: "4663", symbol: "WETH", identityKind: "NATIVE", assetClass: "NATIVE" })), "ETH");
  assert.equal(displayQuoteSymbol(catalogQuote({ chainId: "4663", symbol: "WETH", identityKind: "NATIVE", assetClass: "NATIVE" }), { technical: true }), "WETH");
});

test("empty catalog renders no categories and does not invent quote assets", () => {
  assert.deepEqual(groupQuoteAssetsByCategory([]).map((group) => group.id), []);
  assert.deepEqual(catalogQuoteAssetsOnly([]), []);
  assert.deepEqual(catalogQuoteAssetsOnly([{ id: "native:56", presentationDefault: true, newGraduationEligible: true }]), []);
});

test("UI fixture USDC is categorized only when the catalog actually returns it", () => {
  const fixtureUsdc = catalogQuote({
    id: "fixture-usdc",
    identityKind: "EVM_ADDRESS",
    assetClass: "STABLECOIN",
    symbol: "USDC",
    displayName: "USD Coin",
    contractAddressOrMint: "0x00000000000000000000000000000000000000aa",
  });
  const groups = groupQuoteAssetsByCategory([catalogQuote(), fixtureUsdc]);
  assert.deepEqual(groups.map((group) => group.id), ["POPULAR", "STABLECOINS"]);
  assert.equal(groups.find((group) => group.id === "STOCKS_ETFS"), undefined);
});

test("Robinhood Stock Tokens appear under STOCKS & ETFs, not a NATIVE/STOCK_TOKEN split", () => {
  const nvda = catalogQuote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token", displayName: "Robinhood Stock Token Registry", authorityMode: "ROBINHOOD_STOCK_REGISTRY" },
    chainId: "4663",
    assetClass: "PROVIDER_RWA",
    identityKind: "EVM_ADDRESS",
    symbol: "NVDA",
    displayName: "NVIDIA",
    contractAddressOrMint: "0x0000000000000000000000000000000000000aaa",
  });
  const usdc = catalogQuote({
    id: "rh-usdc",
    provider: { key: "robinhood-basic", displayName: "Robinhood BASIC" },
    chainId: "4663",
    identityKind: "EVM_ADDRESS",
    assetClass: "STABLECOIN",
    symbol: "USDC",
  });
  const eth = catalogQuote({
    id: "rh-eth",
    provider: { key: "robinhood-basic" },
    chainId: "4663",
    identityKind: "NATIVE",
    assetClass: "NATIVE",
    symbol: "ETH",
  });
  const groups = groupQuoteAssetsByCategory([eth, nvda, usdc]);
  assert.deepEqual(groups.map((group) => group.id), ["POPULAR", "STABLECOINS", "STOCKS_ETFS"]);
  assert.equal(categoryForQuoteAsset(nvda), "STOCKS_ETFS");
  assert.equal(isRobinhoodStockQuote(nvda), true);
  assert.equal(isRobinhoodStockQuote(usdc), false);
  assert.equal(robinhoodLegacyMarketKind(nvda), "STOCK_TOKEN");
  assert.equal(robinhoodLegacyMarketKind(eth), "NATIVE");
  assert.equal(robinhoodLegacyMarketKind(usdc), null);
});

test("selected Graduation Market summary uses the token/quote pair and bonding currency", () => {
  const nvda = catalogQuote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token" },
    chainId: "4663",
    assetClass: "PROVIDER_RWA",
    identityKind: "EVM_ADDRESS",
    symbol: "NVDA",
  });
  const selected = selectedMarketSummary({ ticker: "DOGE", asset: nvda, chainId: 4663 });
  assert.equal(selected.pair, "$DOGE / NVDA");
  assert.equal(selected.bonding, "ETH");
  assert.equal(selected.postGraduationMarket, "$DOGE / NVDA");
  assert.equal(selected.provider, "Robinhood");
  assert.equal(selected.moving, true);
});

test("moving quote notice is for stocks/RWAs/other moving assets, not native or stables", () => {
  assert.equal(isMovingQuoteAsset(catalogQuote({ identityKind: "NATIVE", assetClass: "NATIVE", symbol: "BNB" })), false);
  assert.equal(isMovingQuoteAsset(catalogQuote({ assetClass: "STABLECOIN", symbol: "USDC", identityKind: "EVM_ADDRESS" })), false);
  assert.equal(isMovingQuoteAsset(catalogQuote({ assetClass: "PROVIDER_RWA", symbol: "NVDA", provider: { key: "robinhood-stock-token" }, identityKind: "EVM_ADDRESS" })), true);
  assert.match(MOVING_QUOTE_NOTICE, /own market price/);
});

test("draft payload stores catalog id, selected state version, and policy version — not copied provider/address authority", () => {
  const nvda = catalogQuote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token" },
    chainId: "4663",
    assetClass: "PROVIDER_RWA",
    identityKind: "EVM_ADDRESS",
    symbol: "NVDA",
    contractAddressOrMint: "0x1111111111111111111111111111111111111111",
    stateVersion: 7,
    policy: { version: 7, policyKey: "robinhood-stock-authority" },
  });
  const fields = buildCreateDraftGraduationFields(nvda, 4663);
  assert.equal(fields.graduationQuoteAssetId, "rh-stock:nvda");
  assert.equal(fields.graduationQuoteStateVersion, 7);
  assert.equal(fields.graduationQuoteContractOrMint, undefined);
  assert.equal(fields.graduationQuoteProvider, undefined);
  assert.equal(fields.graduationMarketKind, "STOCK_TOKEN");
  assert.equal(fields.graduationQuoteAsset, "0x1111111111111111111111111111111111111111");
  assert.equal(fields.graduationMarketPolicyVersion, "robinhood_market_v1");

  const solNative = buildCreateDraftGraduationFields(catalogQuote({
    id: "sol-native-id",
    chainId: "101",
    identityKind: "NATIVE",
    assetClass: "NATIVE",
    symbol: "SOL",
    provider: { key: "solana-basic" },
    stateVersion: 2,
    policy: { version: 4, policyKey: "solana-native-basic" },
  }), 101);
  assert.equal(solNative.graduationQuoteAssetId, "sol-native-id");
  assert.equal(solNative.graduationQuoteStateVersion, 2);
  assert.equal(solNative.graduationMarketPolicyVersion, "4");
  assert.equal(solNative.graduationMarketKind, undefined);
  assert.equal(solNative.graduationQuoteProvider, undefined);
});

test("disabled catalog assets are omitted from Step 5 groups", () => {
  const live = catalogQuote({ id: "live-bnb", newGraduationEligible: true });
  const disabled = catalogQuote({ id: "dead-bnb", newGraduationEligible: false, symbol: "USDC", assetClass: "STABLECOIN" });
  const groups = groupQuoteAssetsByCategory([live, disabled]);
  assert.deepEqual(groups.map((group) => group.id), ["POPULAR"]);
  assert.equal(groups[0].items.some((item) => item.id === "dead-bnb"), false);
});

test("BNB catalog Direct Deploy uses the signed shared create surface; unrelated generic assets stay fail-closed", () => {
  assert.equal(directDeployBindPath(catalogQuote({ identityKind: "NATIVE", assetClass: "NATIVE" })), "native");
  assert.equal(directDeployBindPath(catalogQuote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token" },
    assetClass: "PROVIDER_RWA",
    identityKind: "EVM_ADDRESS",
  })), "robinhood-stock");
  assert.equal(directDeployBindPath(catalogQuote({
    id: "fixture-usdc",
    identityKind: "EVM_ADDRESS",
    assetClass: "STABLECOIN",
    symbol: "USDC",
    chainId: "56",
  })), "native");
  assert.equal(directDeployBindPath(catalogQuote({
    id: "fixture-generic",
    identityKind: "EVM_ADDRESS",
    assetClass: "STABLECOIN",
    symbol: "USDC",
    chainId: "1",
  })), null);
  assert.equal(directDeployBindPath(catalogQuote({ newGraduationEligible: false })), null);
});

test("Create flow is 6 steps, catalog-only, and the NATIVE/STOCK_TOKEN picker is gone", () => {
  const create = readFileSync(join(here, "../pages/Create.tsx"), "utf8");
  const shell = readFileSync(join(here, "../components/create/CreateWizardShell.tsx"), "utf8");
  const step = readFileSync(join(here, "../components/create/GraduationMarketStep.tsx"), "utf8");
  const catalog = readFileSync(join(here, "./graduationQuoteCatalog.ts"), "utf8");
  assert.match(create, /const TOTAL_STEPS = 6;/);
  assert.match(create, /GraduationMarketStep/);
  assert.match(create, /directDeployBindPath/);
  assert.doesNotMatch(create, /RobinhoodGraduationMarketPicker/);
  assert.doesNotMatch(create, /nativeDefaultQuoteAsset/);
  assert.doesNotMatch(create, /Stock Battlefield/);
  assert.match(shell, /"Path", "Identity", "Story", "Bond", "Market", "Review"/);
  assert.match(step, /No approved Graduation Markets are available on this chain yet/);
  assert.doesNotMatch(step, /nativeDefaultQuoteAsset/);
  assert.match(catalog, /catalogQuoteAssetsOnly/);
  assert.doesNotMatch(catalog, /mergeCatalogWithNativeDefault/);
  assert.doesNotMatch(catalog, /presentationDefault\) return asset/);
});

test("Robinhood Stock Token persist authority is unchanged", () => {
  const drafts = readFileSync(join(here, "../../api/dev-fix/drafts.js"), "utf8");
  assert.match(drafts, /Graduation Market must be NATIVE or STOCK_TOKEN/);
  assert.match(drafts, /getRobinhoodStockGraduationAsset/);
  assert.match(drafts, /persistDraftGraduationPolicy/);
  assert.match(drafts, /getGraduationQuoteAssetDetail/);
  assert.doesNotMatch(drafts, /quote_contract_or_mint/);
  assert.doesNotMatch(drafts, /provider_key/);
});

test("provider labels stay product-facing", () => {
  assert.equal(providerLabel({ chainId: "4663", provider: { key: "robinhood-stock-token", displayName: "Robinhood Stock Token Registry" } }), "Robinhood");
  assert.equal(providerLabel({ chainId: "101", provider: { key: "solana-basic" } }), "Solana");
  assert.equal(providerLabel({ chainId: "56", provider: { key: "bnb-basic" } }), "BNB");
});

test("catalog native identity is classified as native even when symbol is wrapped", () => {
  assert.equal(isNativeQuote(catalogQuote({ chainId: "101", symbol: "WSOL", identityKind: "NATIVE" })), true);
});

test("BNB launch-day native choice stays on native create/draft semantics and hides catalog-native duplicates", () => {
  const nativeLaunch = catalogQuote({
    id: "native:56",
    provider: { key: "bnb-basic", authorityMode: "CHAIN_NATIVE_DEFAULT" },
    chainId: "56",
    identityKind: "NATIVE",
    contractAddressOrMint: "native:56",
    assetClass: "NATIVE",
    symbol: "BNB",
    stateVersion: 0,
    policy: { authority: "presentation-default", policyKey: "chain-native-default", version: null },
    presentationDefault: true,
  });
  assert.equal(directDeployBindPath(nativeLaunch), "native");
  const fields = buildCreateDraftGraduationFields(nativeLaunch, 56);
  assert.equal(fields.graduationQuoteAssetId, "");
  assert.equal(fields.graduationQuoteStateVersion, 0);
  assert.equal(fields.graduationMarketPolicyVersion, "chain-native-default");

  const step = readFileSync(join(here, "../components/create/GraduationMarketStep.tsx"), "utf8");
  const helper = readFileSync(join(here, "./bnbNativeLaunchQuote.ts"), "utf8");
  assert.match(step, /bnbNativeLaunchQuote\(chainId\)/);
  assert.match(step, /catalogItems\.filter\(\(item\) => !isNativeQuote\(item\)\)/);
  assert.match(step, /isBnbNativeLaunchQuote\(selected\) \? ""/);
  assert.match(helper, /contractAddressOrMint \|\| ""\) === "native:56"/);
});

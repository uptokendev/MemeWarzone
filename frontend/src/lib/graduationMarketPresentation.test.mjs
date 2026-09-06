import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCreateDraftGraduationFields,
  categoryForQuoteAsset,
  displayQuoteSymbol,
  groupQuoteAssetsByCategory,
  isMovingQuoteAsset,
  isNativeQuote,
  isRobinhoodStockQuote,
  mergeCatalogWithNativeDefault,
  MOVING_QUOTE_NOTICE,
  nativeDefaultQuoteAsset,
  nativeSymbol,
  providerLabel,
  robinhoodLegacyMarketKind,
  selectedMarketSummary,
} from "./graduationMarketPresentation.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function quote(overrides = {}) {
  return {
    id: "asset-1",
    provider: { key: "bnb-basic", displayName: "BNB BASIC" },
    chainId: "56",
    identityKind: "EVM_ADDRESS",
    contractAddressOrMint: "0x00000000000000000000000000000000000000aa",
    assetClass: "STABLECOIN",
    symbol: "USDC",
    displayName: "USD Coin",
    newGraduationEligible: true,
    policy: { authority: "generic", policyKey: "bnb-usdc-basic", version: 1 },
    ...overrides,
  };
}

test("chain defaults display as SOL, BNB, and ETH — not wrapped tickers", () => {
  assert.equal(nativeSymbol(101), "SOL");
  assert.equal(nativeSymbol(56), "BNB");
  assert.equal(nativeSymbol(97), "BNB");
  assert.equal(nativeSymbol(4663), "ETH");
  assert.equal(displayQuoteSymbol(nativeDefaultQuoteAsset(101)), "SOL");
  assert.equal(displayQuoteSymbol(nativeDefaultQuoteAsset(56)), "BNB");
  assert.equal(displayQuoteSymbol(nativeDefaultQuoteAsset(4663)), "ETH");
  assert.equal(displayQuoteSymbol(quote({ symbol: "WETH", identityKind: "NATIVE", assetClass: "NATIVE", chainId: "4663" })), "ETH");
  assert.equal(displayQuoteSymbol(quote({ symbol: "WETH", identityKind: "NATIVE", assetClass: "NATIVE", chainId: "4663" }), { technical: true }), "WETH");
});

test("empty categories are omitted and Solana/BNB BASIC stay small", () => {
  const solana = groupQuoteAssetsByCategory(mergeCatalogWithNativeDefault(101, []));
  assert.deepEqual(solana.map((group) => group.id), ["POPULAR"]);
  assert.equal(solana[0].items[0].symbol, "SOL");

  const bnb = groupQuoteAssetsByCategory(mergeCatalogWithNativeDefault(56, [
    quote({ id: "usdc", symbol: "USDC", assetClass: "STABLECOIN" }),
  ]));
  assert.deepEqual(bnb.map((group) => group.id), ["POPULAR", "STABLECOINS"]);
  assert.equal(bnb.find((group) => group.id === "STOCKS_ETFS"), undefined);
  assert.equal(bnb.find((group) => group.id === "CUSTOM"), undefined);
});

test("Robinhood Stock Tokens appear under STOCKS & ETFs, not a NATIVE/STOCK_TOKEN split", () => {
  const nvda = quote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token", displayName: "Robinhood Stock Token Registry", authorityMode: "ROBINHOOD_STOCK_REGISTRY" },
    chainId: "4663",
    assetClass: "PROVIDER_RWA",
    symbol: "NVDA",
    displayName: "NVIDIA",
    contractAddressOrMint: "0x0000000000000000000000000000000000000aaa",
  });
  const usdc = quote({
    id: "rh-usdc",
    provider: { key: "robinhood-basic", displayName: "Robinhood BASIC" },
    chainId: "4663",
    assetClass: "STABLECOIN",
    symbol: "USDC",
  });
  const groups = groupQuoteAssetsByCategory(mergeCatalogWithNativeDefault(4663, [nvda, usdc]));
  assert.deepEqual(groups.map((group) => group.id), ["POPULAR", "STABLECOINS", "STOCKS_ETFS"]);
  assert.equal(categoryForQuoteAsset(nvda), "STOCKS_ETFS");
  assert.equal(isRobinhoodStockQuote(nvda), true);
  assert.equal(isRobinhoodStockQuote(usdc), false);
  assert.equal(robinhoodLegacyMarketKind(nvda), "STOCK_TOKEN");
  assert.equal(robinhoodLegacyMarketKind(nativeDefaultQuoteAsset(4663)), "NATIVE");
  assert.equal(robinhoodLegacyMarketKind(usdc), null);
});

test("selected Graduation Market summary uses the token/quote pair and bonding currency", () => {
  const nvda = quote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token" },
    chainId: "4663",
    assetClass: "PROVIDER_RWA",
    symbol: "NVDA",
  });
  const selected = selectedMarketSummary({ ticker: "DOGE", asset: nvda, chainId: 4663 });
  assert.equal(selected.pair, "$DOGE / NVDA");
  assert.equal(selected.bonding, "ETH");
  assert.equal(selected.postGraduationMarket, "$DOGE / NVDA");
  assert.equal(selected.provider, "Robinhood");
  assert.equal(selected.moving, true);

  const stable = selectedMarketSummary({
    ticker: "TOKEN",
    asset: quote({ symbol: "USDC", assetClass: "STABLECOIN", chainId: "101", provider: { key: "solana-basic" } }),
    chainId: 101,
  });
  assert.equal(stable.pair, "$TOKEN / USDC");
  assert.equal(stable.bonding, "SOL");
  assert.equal(stable.moving, false);
});

test("moving quote notice is for stocks/RWAs/other moving assets, not native or stables", () => {
  assert.equal(isMovingQuoteAsset(nativeDefaultQuoteAsset(56)), false);
  assert.equal(isMovingQuoteAsset(quote({ assetClass: "STABLECOIN", symbol: "USDC" })), false);
  assert.equal(isMovingQuoteAsset(quote({ assetClass: "PROVIDER_RWA", symbol: "NVDA", provider: { key: "robinhood-stock-token" } })), true);
  assert.match(MOVING_QUOTE_NOTICE, /own market price/);
});

test("draft payload stores quote id, chain, contract/mint, provider, and policy version", () => {
  const nvda = quote({
    id: "rh-stock:nvda",
    provider: { key: "robinhood-stock-token" },
    chainId: "4663",
    assetClass: "PROVIDER_RWA",
    symbol: "NVDA",
    contractAddressOrMint: "0x1111111111111111111111111111111111111111",
    policy: { version: 7, policyKey: "robinhood-stock-authority" },
  });
  const fields = buildCreateDraftGraduationFields(nvda, 4663);
  assert.equal(fields.graduationQuoteAssetId, "rh-stock:nvda");
  assert.equal(fields.graduationQuoteChainId, 4663);
  assert.equal(fields.graduationQuoteContractOrMint, "0x1111111111111111111111111111111111111111");
  assert.equal(fields.graduationQuoteProvider, "robinhood-stock-token");
  assert.equal(fields.graduationMarketKind, "STOCK_TOKEN");
  assert.equal(fields.graduationQuoteAsset, "0x1111111111111111111111111111111111111111");
  assert.equal(fields.graduationMarketPolicyVersion, "robinhood_market_v1");

  const solana = buildCreateDraftGraduationFields(nativeDefaultQuoteAsset(101), 101);
  assert.equal(solana.graduationQuoteAssetId, "native:101");
  assert.equal(solana.graduationQuoteProvider, "solana-basic");
  assert.equal(solana.graduationMarketKind, undefined);
});

test("catalog native wins over the presentation default and stays eligible", () => {
  const catalogNative = quote({
    id: "sol-native-id",
    chainId: "101",
    identityKind: "NATIVE",
    assetClass: "NATIVE",
    symbol: "WSOL",
    contractAddressOrMint: "native:101",
    provider: { key: "solana-basic" },
  });
  const merged = mergeCatalogWithNativeDefault(101, [catalogNative]);
  assert.equal(merged.filter(isNativeQuote).length, 1);
  assert.equal(merged[0].id, "sol-native-id");
  assert.equal(displayQuoteSymbol(merged[0]), "SOL");
});

test("Create flow is 6 steps and the NATIVE/STOCK_TOKEN picker is no longer the product UI", () => {
  const create = readFileSync(join(here, "../pages/Create.tsx"), "utf8");
  const shell = readFileSync(join(here, "../components/create/CreateWizardShell.tsx"), "utf8");
  const step = readFileSync(join(here, "../components/create/GraduationMarketStep.tsx"), "utf8");
  assert.match(create, /const TOTAL_STEPS = 6;/);
  assert.match(create, /GraduationMarketStep/);
  assert.doesNotMatch(create, /RobinhoodGraduationMarketPicker/);
  assert.doesNotMatch(create, /Stock Battlefield/);
  assert.doesNotMatch(create, /kind === "NATIVE"/);
  assert.doesNotMatch(create, /kind === "STOCK_TOKEN"/);
  assert.match(shell, /"Path", "Identity", "Story", "Bond", "Market", "Review"/);
  assert.match(step, /copy\.title/);
  assert.match(step, /Selected Graduation Market/);
  assert.match(step, /data-testid="graduation-market-step"/);
  assert.doesNotMatch(step, /Stock Battlefield/);
  assert.doesNotMatch(step, /onKindChange/);
});

test("Robinhood Stock Token persist authority is unchanged", () => {
  const drafts = readFileSync(join(here, "../../api/dev-fix/drafts.js"), "utf8");
  assert.match(drafts, /Graduation Market must be NATIVE or STOCK_TOKEN/);
  assert.match(drafts, /getRobinhoodStockGraduationAsset/);
  assert.match(drafts, /persistDraftGraduationPolicy/);
  assert.match(drafts, /persistGraduationQuoteSelection/);
  assert.match(drafts, /campaign_draft_graduation_quote_selection/);
});

test("provider labels stay product-facing", () => {
  assert.equal(providerLabel({ chainId: "4663", provider: { key: "robinhood-stock-token", displayName: "Robinhood Stock Token Registry" } }), "Robinhood");
  assert.equal(providerLabel({ chainId: "101", provider: { key: "solana-basic" } }), "Solana");
  assert.equal(providerLabel({ chainId: "56", provider: { key: "bnb-basic" } }), "BNB");
});

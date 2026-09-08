import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverRobinhoodCanonicalStockCandidates,
  listRobinhoodManifestPairCandidates,
} from "../frontend/api/lib/robinhoodFullApprovedPairCatalog.js";
import { buildRobinhoodApprovedPairReport } from "./report-robinhood-approved-pairs.mjs";

test("Robinhood catalog contains canonical WETH and USDG plus Stock Token provider candidates", () => {
  const items = listRobinhoodManifestPairCandidates();
  assert.ok(items.length >= 35, `expected at least 35 Robinhood candidates, got ${items.length}`);
  const weth = items.find((item) => item.asset === "WETH");
  const usdg = items.find((item) => item.asset === "USDG");
  assert.equal(weth?.contract, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  assert.equal(usdg?.contract, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(weth?.provider, "ROBINHOOD_CHAIN_CANONICAL");
  assert.equal(usdg?.provider, "ROBINHOOD_CHAIN_CANONICAL");
  assert.ok(items.some((item) => item.provider === "ROBINHOOD_CANONICAL"));
});

test("Solana-only provider catalogs are never projected onto Robinhood", () => {
  const providers = new Set(listRobinhoodManifestPairCandidates().map((item) => String(item.providerKey).toLowerCase()));
  assert.equal(providers.has("xstocks"), false);
  assert.equal(providers.has("prestocks"), false);
  assert.equal(providers.has("sunrise"), false);
});

test("actual admitted Robinhood deployments retain ETF, provider-RWA and pre-IPO classification", () => {
  const items = listRobinhoodManifestPairCandidates();
  assert.equal(items.find((item) => item.asset === "SPY")?.category, "ETF");
  assert.equal(items.find((item) => item.asset === "QQQ")?.category, "ETF");
  assert.equal(items.find((item) => item.asset === "GLD")?.category, "PROVIDER_RWA");
  assert.equal(items.find((item) => item.asset === "SPCX")?.category, "PRE_IPO");
});

test("live provider discovery adds exact chain-4663 deployments without self-admitting them", () => {
  const payload = {
    assets: [{
      tokenSymbol: "P",
      tokenName: "Everpure • Robinhood Token",
      tokenDecimals: 18,
      status: "ASSET_STATUS_ACTIVE",
      deployments: [{ chainId: 4663, contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D" }],
      tradingCapabilities: { market: { whole: "TRADING_STATUS_TRADABLE" } },
    }],
  };
  const items = discoverRobinhoodCanonicalStockCandidates(payload);
  const discovered = items.find((item) => item.asset === "P");
  assert.equal(discovered?.contract, "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D");
  assert.equal(discovered?.provider, "ROBINHOOD_CANONICAL");
  assert.equal(discovered?.identityStatus, "VERIFIED_ROBINHOOD_CHAIN_4663_PROVIDER_FEED");
  assert.equal(discovered?.manifestState, "DISCOVERED_NOT_ADMITTED");
  assert.equal(discovered?.disposition, "PENDING");
});

test("dark production manifest leaves every discovered candidate PENDING", () => {
  const report = buildRobinhoodApprovedPairReport({
    productionManifest: { chainId: 4663, supportEnabled: false, creationEnabled: false, contracts: {} },
    canonicalPayload: {
      assets: [{
        tokenSymbol: "P",
        tokenName: "Everpure • Robinhood Token",
        tokenDecimals: 18,
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ chainId: 4663, contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D" }],
        tradingCapabilities: { market: { whole: "TRADING_STATUS_TRADABLE" } },
      }],
    },
  });
  assert.equal(report.productionRuntimeReady, false);
  assert.ok(report.candidates.length > 0);
  assert.ok(report.candidates.every((item) => item.disposition === "PENDING"));
  assert.ok(report.candidates.every((item) => item.health === "PENDING_PRODUCTION_RUNTIME"));
});

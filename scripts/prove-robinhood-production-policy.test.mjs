import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { proveRobinhoodProductionManifest } from "./prove-robinhood-production-manifest.mjs";

const CANDIDATE_SHA = "1234567890abcdef1234567890abcdef12345678";
const REQUIRED_KEYS = [
  "launchFactory","launchCampaignImplementation","stockCampaignImplementation","permanentV3PositionLocker","treasuryRouterV3","graduationAdapter","v3NativeSwapAdapter","stockGraduationAdapter","v3MultiHopSwapAdapter","graduationOracle","creatorRegistry","riskRegistry","weeklyLeagueVault","recruiterRewardsVault","communityRewardsVault","protocolRevenueVault","upVoteTreasury","v3Factory","nonfungiblePositionManager","v3SwapRouter","weth9",
];
function address(index) { return `0x${BigInt(index).toString(16).padStart(40, "0")}`; }
function acceptedTestnet() { return JSON.parse(fs.readFileSync("deployments/robinhood/testnet.accepted.json", "utf8")); }
function manifest() {
  const contracts = Object.fromEntries(REQUIRED_KEYS.map((key, index) => [key, address(100 + index)]));
  return {
    schemaVersion: 2,
    chainKey: "robinhood-mainnet",
    chainId: 4663,
    targetChainId: 4663,
    environment: "production",
    sourceSha: CANDIDATE_SHA,
    deploymentBlock: 123456,
    factoryGeneration: 4,
    campaignGeneration: 3,
    liquidityKind: 2,
    productionCompatible: true,
    testnetOnly: false,
    oracleMaxAgeSeconds: 900,
    supportEnabled: false,
    creationEnabled: false,
    stockMarketsEnabled: false,
    stockGraduationEnabled: false,
    stockEthRoutingEnabled: false,
    stockMarketUiEnabled: false,
    beatTheMarketEnabled: false,
    factoryLive: false,
    createPaused: true,
    securityDefaultsLocked: true,
    requireRouteAuthorization: true,
    requireAuthorizedTrading: true,
    admin: address(50),
    routeAuthority: address(51),
    contracts,
    oracles: { nativeUsdFeed: address(200) },
    stock: {
      canonicalRegistryConfigured: true,
      nativeUsdOracleConfigured: true,
      approvedAcquisitionRoutesConfigured: true,
      stockRoutesEnabled: false,
      graduationPolicy: {
        maxOracleAgeSeconds: 900,
        maxSwapSlippageBps: 300,
        maxOracleDeviationBps: 300,
        maxPriceImpactBps: 500,
        minimumRouteLiquidityUsd: 25000,
      },
      registry: [{
        symbol: "NVDA",
        displayName: "NVIDIA Stock Token",
        underlyingSymbol: "NVDA",
        decimals: 18,
        contractAddress: address(210),
        oracleFeedAddress: address(211),
        oracleType: "chainlink",
        canonical: true,
        enabledForDiscovery: true,
        enabledForGraduation: false,
        enabledForTrading: false,
        minimumQuoteLiquidityUsd: 25000,
        maximumGraduationSwapImpactBps: 500,
        acquisitionPoolAddress: address(212),
        acquisitionQuoterAddress: address(214),
        acquisitionRouterAddress: contracts.v3SwapRouter,
        acquisitionFeeTier: 3000,
        acquisitionQuoteKind: "SIMPLE_EXACT_INPUT_SINGLE",
      }],
    },
    activationPrerequisites: ["oracle freshness", "route health", "canary", "rollback"],
  };
}
function prove(value) {
  return proveRobinhoodProductionManifest(value, { acceptedTestnet: acceptedTestnet(), candidateSha: CANDIDATE_SHA });
}

test("accepts an explicit fail-closed production Stock safety policy", () => {
  const result = prove(manifest());
  assert.equal(result.chainId, 4663);
  assert.equal(result.stockRouteCount, 1);
  assert.equal(result.dark, true);
});

test("rejects missing, mismatched, or unsafe oracle-age policy", () => {
  for (const mutate of [
    (m) => { delete m.oracleMaxAgeSeconds; },
    (m) => { delete m.stock.graduationPolicy; },
    (m) => { m.stock.graduationPolicy.maxOracleAgeSeconds = 901; },
    (m) => { m.stock.graduationPolicy.maxOracleAgeSeconds = 0; },
  ]) {
    const value = manifest(); mutate(value); assert.throws(() => prove(value));
  }
});

test("rejects unsafe Stock route slippage, oracle deviation, impact, or liquidity policy", () => {
  for (const mutate of [
    (m) => { m.stock.graduationPolicy.maxSwapSlippageBps = 0; },
    (m) => { m.stock.graduationPolicy.maxSwapSlippageBps = 10001; },
    (m) => { m.stock.graduationPolicy.maxOracleDeviationBps = 10001; },
    (m) => { m.stock.graduationPolicy.maxPriceImpactBps = 10001; },
    (m) => { m.stock.graduationPolicy.minimumRouteLiquidityUsd = 0; },
    (m) => { m.stock.registry[0].minimumQuoteLiquidityUsd = 24999; },
    (m) => { m.stock.registry[0].maximumGraduationSwapImpactBps = 501; },
  ]) {
    const value = manifest(); mutate(value); assert.throws(() => prove(value));
  }
});

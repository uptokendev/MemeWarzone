import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildRobinhoodProductionManifest } from "./prepare-robinhood-production-manifest.mjs";
import { proveRobinhoodProductionManifest } from "./prove-robinhood-production-manifest.mjs";

const CANDIDATE_SHA = "1234567890abcdef1234567890abcdef12345678";

function address(index) {
  return `0x${BigInt(index).toString(16).padStart(40, "0")}`;
}

const CONTRACT_KEYS = [
  "launchFactory","launchCampaignImplementation","stockCampaignImplementation","permanentV3PositionLocker","treasuryRouterV3","graduationAdapter","v3NativeSwapAdapter","stockGraduationAdapter","v3MultiHopSwapAdapter","graduationOracle","creatorRegistry","riskRegistry","weeklyLeagueVault","recruiterRewardsVault","communityRewardsVault","protocolRevenueVault","upVoteTreasury","v3Factory","nonfungiblePositionManager","v3SwapRouter","weth9",
];

function acceptedTestnet() {
  return JSON.parse(fs.readFileSync("deployments/robinhood/testnet.accepted.json", "utf8"));
}

function validInventory() {
  const contracts = Object.fromEntries(CONTRACT_KEYS.map((key, index) => [key, address(100 + index)]));
  return {
    sourceSha: CANDIDATE_SHA,
    deploymentBlock: 987654,
    admin: address(50),
    routeAuthority: address(51),
    oracleMaxAgeSeconds: 900,
    contracts,
    oracles: { nativeUsdFeed: address(200) },
    stock: {
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
        enabledForGraduation: true,
        enabledForTrading: true,
        minimumQuoteLiquidityUsd: 25000,
        maximumGraduationSwapImpactBps: 500,
        acquisitionPoolAddress: address(212),
        acquisitionQuoterAddress: address(213),
        acquisitionRouterAddress: contracts.v3SwapRouter,
        acquisitionFeeTier: 3000,
        acquisitionQuoteKind: "SIMPLE_EXACT_INPUT_SINGLE",
      }],
    },
  };
}

test("builder emits a complete dark 4663 preflight candidate", () => {
  const testnet = acceptedTestnet();
  const manifest = buildRobinhoodProductionManifest(validInventory(), {
    acceptedTestnet: testnet,
    candidateSha: CANDIDATE_SHA,
    nowMs: Date.UTC(2026, 8, 3, 12, 0, 0),
  });

  assert.equal(manifest.chainId, 4663);
  assert.equal(manifest.factoryGeneration, 4);
  assert.equal(manifest.campaignGeneration, 3);
  assert.equal(manifest.factoryLive, false);
  assert.equal(manifest.createPaused, true);
  assert.equal(manifest.creationEnabled, false);
  assert.equal(manifest.stockMarketsEnabled, false);
  assert.equal(manifest.stockGraduationEnabled, false);
  assert.equal(manifest.stockEthRoutingEnabled, false);
  assert.equal(manifest.stockMarketUiEnabled, false);
  assert.equal(manifest.beatTheMarketEnabled, false);
  assert.equal(manifest.oracleMaxAgeSeconds, 900);
  assert.equal(manifest.stock.graduationPolicy.maxSwapSlippageBps, 300);
  assert.equal(manifest.stock.graduationPolicy.maxOracleDeviationBps, 300);
  assert.equal(manifest.stock.graduationPolicy.minimumRouteLiquidityUsd, 25000);
  assert.equal(manifest.stock.registry[0].enabledForGraduation, false);
  assert.equal(manifest.stock.registry[0].enabledForTrading, false);
  assert.equal(manifest.generatedAt, "2026-09-03T12:00:00.000Z");

  const proof = proveRobinhoodProductionManifest(manifest, { acceptedTestnet: testnet, candidateSha: CANDIDATE_SHA });
  assert.equal(proof.dark, true);
});

test("builder ignores inventory attempts to pre-enable production surfaces", () => {
  const inventory = validInventory();
  inventory.creationEnabled = true;
  inventory.factoryLive = true;
  inventory.stockMarketsEnabled = true;
  inventory.stockGraduationEnabled = true;
  inventory.stockEthRoutingEnabled = true;
  inventory.stockMarketUiEnabled = true;
  inventory.beatTheMarketEnabled = true;

  const manifest = buildRobinhoodProductionManifest(inventory, {
    acceptedTestnet: acceptedTestnet(),
    candidateSha: CANDIDATE_SHA,
  });

  for (const key of ["creationEnabled","stockMarketsEnabled","stockGraduationEnabled","stockEthRoutingEnabled","stockMarketUiEnabled","beatTheMarketEnabled","factoryLive"]) {
    assert.equal(manifest[key], false, `${key} must remain dark`);
  }
  assert.equal(manifest.createPaused, true);
});

test("builder rejects accepted testnet contract reuse", () => {
  const testnet = acceptedTestnet();
  const inventory = validInventory();
  inventory.contracts.launchFactory = testnet.contracts.launchFactory;
  assert.throws(() => buildRobinhoodProductionManifest(inventory, { acceptedTestnet: testnet, candidateSha: CANDIDATE_SHA }), /reuses accepted Robinhood testnet address/i);
});

test("builder rejects route authority reuse with admin and missing deployment evidence", () => {
  const testnet = acceptedTestnet();
  const sameAuthority = validInventory();
  sameAuthority.routeAuthority = sameAuthority.admin;
  assert.throws(() => buildRobinhoodProductionManifest(sameAuthority, { acceptedTestnet: testnet, candidateSha: CANDIDATE_SHA }), /distinct from admin/i);

  const noBlock = validInventory();
  noBlock.deploymentBlock = null;
  assert.throws(() => buildRobinhoodProductionManifest(noBlock, { acceptedTestnet: testnet, candidateSha: CANDIDATE_SHA }), /deploymentBlock/i);
});

test("builder rejects missing or unsafe Stock safety policy input", () => {
  for (const mutate of [
    (inventory) => { delete inventory.oracleMaxAgeSeconds; },
    (inventory) => { delete inventory.stock.graduationPolicy; },
    (inventory) => { inventory.stock.graduationPolicy.maxSwapSlippageBps = 0; },
    (inventory) => { inventory.stock.graduationPolicy.maxOracleDeviationBps = 10001; },
    (inventory) => { inventory.stock.graduationPolicy.minimumRouteLiquidityUsd = 0; },
  ]) {
    const inventory = validInventory();
    mutate(inventory);
    assert.throws(() => buildRobinhoodProductionManifest(inventory, { acceptedTestnet: acceptedTestnet(), candidateSha: CANDIDATE_SHA }));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  proveRobinhoodProductionManifest,
  ROBINHOOD_MAINNET_CHAIN_ID,
} from "./prove-robinhood-production-manifest.mjs";

const CANDIDATE_SHA = "1234567890abcdef1234567890abcdef12345678";

function address(index) {
  return `0x${BigInt(index).toString(16).padStart(40, "0")}`;
}

const REQUIRED_KEYS = [
  "launchFactory",
  "launchCampaignImplementation",
  "permanentV3PositionLocker",
  "treasuryRouterV3",
  "graduationAdapter",
  "v3NativeSwapAdapter",
  "stockGraduationAdapter",
  "v3MultiHopSwapAdapter",
  "graduationOracle",
  "creatorRegistry",
  "riskRegistry",
  "weeklyLeagueVault",
  "recruiterRewardsVault",
  "communityRewardsVault",
  "protocolRevenueVault",
  "upVoteTreasury",
  "v3Factory",
  "nonfungiblePositionManager",
  "v3SwapRouter",
  "weth9",
];

function validManifest() {
  return {
    schemaVersion: 2,
    chainKey: "robinhood-mainnet",
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    targetChainId: ROBINHOOD_MAINNET_CHAIN_ID,
    environment: "production",
    sourceSha: CANDIDATE_SHA,
    deploymentBlock: 123456,
    factoryGeneration: 4,
    campaignGeneration: 3,
    liquidityKind: 2,
    productionCompatible: true,
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
    contracts: Object.fromEntries(REQUIRED_KEYS.map((key, index) => [key, address(100 + index)])),
    stock: {
      canonicalRegistryConfigured: true,
      nativeUsdOracleConfigured: true,
      approvedAcquisitionRoutesConfigured: true,
      stockRoutesEnabled: false,
    },
    activationPrerequisites: [
      "verify production oracle freshness and feed identity",
      "verify approved Stock route liquidity and route health",
      "complete mainnet canary with creation still disabled",
      "prove rollback and feature-disable procedure",
    ],
  };
}

function acceptedTestnet() {
  const committed = JSON.parse(fs.readFileSync("deployments/robinhood/testnet.accepted.json", "utf8"));
  return committed;
}

test("accepts a complete dark 4663 preflight isolated from accepted testnet", () => {
  const result = proveRobinhoodProductionManifest(validManifest(), {
    acceptedTestnet: acceptedTestnet(),
    candidateSha: CANDIDATE_SHA,
  });
  assert.equal(result.chainId, 4663);
  assert.equal(result.sourceSha, CANDIDATE_SHA);
  assert.equal(result.contractCount, REQUIRED_KEYS.length);
  assert.equal(result.dark, true);
});

test("current committed mainnet placeholder cannot masquerade as a deployed production preflight", () => {
  const placeholder = JSON.parse(fs.readFileSync("deployments/robinhood/mainnet.json", "utf8"));
  assert.throws(
    () => proveRobinhoodProductionManifest(placeholder, { acceptedTestnet: acceptedTestnet(), candidateSha: CANDIDATE_SHA }),
    /deploymentBlock|generation|sourceSha|contract/i,
  );
});

test("rejects a production manifest that reuses an accepted 46630 contract address", () => {
  const manifest = validManifest();
  const testnet = acceptedTestnet();
  const testnetAddress = Object.values(testnet.contracts || {}).find((value) => /^0x[0-9a-fA-F]{40}$/.test(String(value)));
  assert.ok(testnetAddress, "accepted testnet fixture should contain a contract address");
  manifest.contracts.launchFactory = String(testnetAddress);
  assert.throws(
    () => proveRobinhoodProductionManifest(manifest, { acceptedTestnet: testnet, candidateSha: CANDIDATE_SHA }),
    /reuses accepted Robinhood testnet address/i,
  );
});

test("rejects wrong chain, generation, source SHA, duplicate contracts, or missing required contract", () => {
  for (const mutate of [
    (manifest) => { manifest.chainId = 46630; manifest.targetChainId = 46630; },
    (manifest) => { manifest.factoryGeneration = 3; },
    (manifest) => { manifest.sourceSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"; },
    (manifest) => { manifest.contracts.v3SwapRouter = manifest.contracts.v3Factory; },
    (manifest) => { delete manifest.contracts.stockGraduationAdapter; },
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }));
  }
});

test("rejects any attempt to enable creation or Stock product surfaces before canary", () => {
  for (const flag of [
    "supportEnabled",
    "creationEnabled",
    "stockMarketsEnabled",
    "stockGraduationEnabled",
    "stockEthRoutingEnabled",
    "stockMarketUiEnabled",
    "beatTheMarketEnabled",
  ]) {
    const manifest = validManifest();
    manifest[flag] = true;
    assert.throws(
      () => proveRobinhoodProductionManifest(manifest, { acceptedTestnet: acceptedTestnet(), candidateSha: CANDIDATE_SHA }),
      new RegExp(`${flag}=false`, "i"),
    );
  }
});

test("rejects incomplete production oracle, route, canary, or rollback evidence", () => {
  for (const mutate of [
    (manifest) => { manifest.stock.canonicalRegistryConfigured = false; },
    (manifest) => { manifest.stock.nativeUsdOracleConfigured = false; },
    (manifest) => { manifest.stock.approvedAcquisitionRoutesConfigured = false; },
    (manifest) => { manifest.stock.stockRoutesEnabled = true; },
    (manifest) => { manifest.activationPrerequisites = ["oracle", "route", "canary"]; },
    (manifest) => { manifest.activationPrerequisites = ["oracle", "route", "rollback", "manual review"]; },
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }));
  }
});

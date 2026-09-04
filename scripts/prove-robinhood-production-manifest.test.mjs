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
  "stockCampaignImplementation",
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
  const contracts = Object.fromEntries(REQUIRED_KEYS.map((key, index) => [key, address(100 + index)]));
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
    admin: address(50),
    routeAuthority: address(51),
    contracts,
    oracles: {
      nativeUsdFeed: address(200),
    },
    stock: {
      canonicalRegistryConfigured: true,
      nativeUsdOracleConfigured: true,
      approvedAcquisitionRoutesConfigured: true,
      stockRoutesEnabled: false,
      registry: [
        {
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
        },
      ],
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
  return JSON.parse(fs.readFileSync("deployments/robinhood/testnet.accepted.json", "utf8"));
}

test("accepts a complete dark 4663 preflight isolated from accepted testnet", () => {
  const result = proveRobinhoodProductionManifest(validManifest(), {
    acceptedTestnet: acceptedTestnet(),
    candidateSha: CANDIDATE_SHA,
  });
  assert.equal(result.chainId, 4663);
  assert.equal(result.sourceSha, CANDIDATE_SHA);
  assert.equal(result.contractCount, REQUIRED_KEYS.length);
  assert.equal(result.stockRouteCount, 1);
  assert.equal(result.dark, true);
});

test("current committed mainnet placeholder cannot masquerade as a deployed production preflight", () => {
  const placeholder = JSON.parse(fs.readFileSync("deployments/robinhood/mainnet.json", "utf8"));
  assert.throws(
    () => proveRobinhoodProductionManifest(placeholder, { acceptedTestnet: acceptedTestnet(), candidateSha: CANDIDATE_SHA }),
    /deploymentBlock|generation|sourceSha|contract/i,
  );
});

test("rejects a production manifest that reuses an accepted 46630 address", () => {
  const manifest = validManifest();
  const testnet = acceptedTestnet();
  const testnetAddress = Object.values(testnet.contracts || {}).find((value) => /^0x[0-9a-fA-F]{40}$/.test(String(value)));
  assert.ok(testnetAddress);
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
    (manifest) => { delete manifest.contracts.stockCampaignImplementation; },
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }));
  }
});

test("requires production route authority separation", () => {
  const manifest = validManifest();
  manifest.routeAuthority = manifest.admin;
  assert.throws(
    () => proveRobinhoodProductionManifest(manifest, { acceptedTestnet: acceptedTestnet(), candidateSha: CANDIDATE_SHA }),
    /distinct from admin/i,
  );
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

test("rejects missing concrete production oracle or Stock route evidence", () => {
  for (const mutate of [
    (manifest) => { manifest.oracles.nativeUsdFeed = ""; },
    (manifest) => { manifest.stock.canonicalRegistryConfigured = false; },
    (manifest) => { manifest.stock.nativeUsdOracleConfigured = false; },
    (manifest) => { manifest.stock.approvedAcquisitionRoutesConfigured = false; },
    (manifest) => { manifest.stock.stockRoutesEnabled = true; },
    (manifest) => { manifest.stock.registry = []; },
    (manifest) => { manifest.stock.registry[0].canonical = false; },
    (manifest) => { manifest.stock.registry[0].enabledForGraduation = true; },
    (manifest) => { manifest.stock.registry[0].acquisitionPoolAddress = ""; },
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }));
  }
});

test("rejects non-canonical Stock policy fields before production acceptance", () => {
  for (const mutate of [
    (manifest) => { manifest.stock.registry[0].displayName = ""; },
    (manifest) => { manifest.stock.registry[0].underlyingSymbol = ""; },
    (manifest) => { manifest.stock.registry[0].decimals = 37; },
    (manifest) => { manifest.stock.registry[0].oracleType = "custom"; },
    (manifest) => { manifest.stock.registry[0].enabledForDiscovery = false; },
    (manifest) => { manifest.stock.registry[0].minimumQuoteLiquidityUsd = 0; },
    (manifest) => { manifest.stock.registry[0].maximumGraduationSwapImpactBps = 0; },
    (manifest) => { manifest.stock.registry[0].maximumGraduationSwapImpactBps = 10001; },
    (manifest) => { manifest.stock.registry[0].acquisitionQuoterAddress = ""; },
    (manifest) => { manifest.stock.registry[0].acquisitionRouterAddress = address(999); },
    (manifest) => { manifest.stock.registry[0].acquisitionQuoteKind = "UNSUPPORTED"; },
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }));
  }
});

test("rejects duplicate canonical Stock symbols or token identities", () => {
  for (const duplicateField of ["symbol", "contractAddress"]) {
    const manifest = validManifest();
    const duplicate = { ...manifest.stock.registry[0], contractAddress: address(310), symbol: "AAPL", underlyingSymbol: "AAPL", displayName: "Apple Stock Token", oracleFeedAddress: address(311), acquisitionPoolAddress: address(312), acquisitionQuoterAddress: address(314) };
    duplicate[duplicateField] = manifest.stock.registry[0][duplicateField];
    manifest.stock.registry.push(duplicate);
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }), /duplicates/i);
  }
});

test("rejects incomplete oracle, route, canary, or rollback activation prerequisites", () => {
  for (const prerequisites of [
    ["oracle", "route", "canary"],
    ["oracle", "route", "rollback", "manual review"],
  ]) {
    const manifest = validManifest();
    manifest.activationPrerequisites = prerequisites;
    assert.throws(() => proveRobinhoodProductionManifest(manifest, {
      acceptedTestnet: acceptedTestnet(),
      candidateSha: CANDIDATE_SHA,
    }));
  }
});

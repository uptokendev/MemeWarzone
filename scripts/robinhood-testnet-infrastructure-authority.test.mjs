import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_SOURCE_IDENTITIES,
  INFRA_BROADCAST_TOKEN,
  INFRA_MANIFEST_SCHEMA_VERSION,
  LEGACY_V3_EXACT_INPUT_SINGLE_SELECTOR,
  SWAP_ROUTER02_EXACT_INPUT_SINGLE_SELECTOR,
  buildInfrastructureManifest,
  requireSwapRouter02Runtime,
  validateBootstrapBoundary,
  validateInfrastructureManifest,
  validateOracleObservation,
} from "./robinhoodTestnetInfrastructureAuthority.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const E = "0x5555555555555555555555555555555555555555";
const F = "0x6666666666666666666666666666666666666666";
const G = "0x7777777777777777777777777777777777777777";
const I = "0x8888888888888888888888888888888888888888";
const H = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;

function receipt(address, blockNumber) {
  return { address, txHash: TX, blockNumber, runtimeCodeHash: H };
}

function manifestInput() {
  return {
    chainId: 46630,
    sourceSha: "18ffff677f8d6420c4539f9d9db9ec7eee1b0790",
    deployer: A,
    oracleUpdater: F,
    feeTier: 3000,
    feeTickSpacing: 60,
    deployments: {
      weth: receipt(B, 10),
      v3Factory: receipt(C, 11),
      positionManager: receipt(D, 14),
      swapRouter02: receipt(E, 15),
      oracle: receipt(F, 16),
    },
    peripheryDependencies: {
      nftDescriptor: receipt(G, 12),
      tokenDescriptor: receipt(I, 13),
    },
    bindings: { npmFactory: C, npmWeth9: B, routerFactory: C, routerWeth9: B },
    oracle: { decimals: 8, roundId: 1, answer: 250000000000n, updatedAt: 1000, answeredInRound: 1, certifiedAtTimestamp: 1001, maxAgeSeconds: 900 },
  };
}

test("pins exact upstream source generations", () => {
  assert.equal(BOOTSTRAP_SOURCE_IDENTITIES.v3Core, "@uniswap/v3-core@1.0.1");
  assert.equal(BOOTSTRAP_SOURCE_IDENTITIES.v3Periphery, "@uniswap/v3-periphery@1.4.4");
  assert.equal(BOOTSTRAP_SOURCE_IDENTITIES.swapRouter02, "@uniswap/swap-router-contracts@1.3.1");
});

test("bootstrap broadcast boundary rejects production, local broadcast and manifest overwrite", () => {
  assert.throws(() => validateBootstrapBoundary({ chainId: 4663, networkName: "robinhoodMainnet" }), /production chain 4663/);
  assert.throws(() => validateBootstrapBoundary({ chainId: 31337, networkName: "hardhat", broadcastToken: INFRA_BROADCAST_TOKEN }), /requires robinhoodTestnet/);
  assert.throws(() => validateBootstrapBoundary({ chainId: 46630, networkName: "robinhoodTestnet", broadcastToken: INFRA_BROADCAST_TOKEN, manifestExists: true }), /refusing overwrite/);
  assert.equal(validateBootstrapBoundary({ chainId: 46630, networkName: "robinhoodTestnet" }).broadcast, false);
  assert.equal(validateBootstrapBoundary({ chainId: 46630, networkName: "robinhoodTestnet", broadcastToken: INFRA_BROADCAST_TOKEN }).broadcast, true);
});

test("SwapRouter02 selector guard rejects old deadline-bearing V3 router runtime", () => {
  assert.equal(requireSwapRouter02Runtime(`0x600063${SWAP_ROUTER02_EXACT_INPUT_SINGLE_SELECTOR}14600057`), true);
  assert.throws(() => requireSwapRouter02Runtime(`0x600063${LEGACY_V3_EXACT_INPUT_SINGLE_SELECTOR}14600057`), /0x04e45aaf/);
  assert.throws(() => requireSwapRouter02Runtime("0x"), /no runtime bytecode/);
});

test("oracle observation matrix is fail-closed", () => {
  const base = { decimals: 8, roundId: 3, answer: 250000000000n, updatedAt: 1000, answeredInRound: 3, currentTimestamp: 1100, maxAgeSeconds: 900 };
  assert.equal(validateOracleObservation(base), true);
  assert.throws(() => validateOracleObservation({ ...base, answer: 0 }), /invalid/);
  assert.throws(() => validateOracleObservation({ ...base, answer: -1 }), /invalid/);
  assert.throws(() => validateOracleObservation({ ...base, answeredInRound: 2 }), /invalid/);
  assert.throws(() => validateOracleObservation({ ...base, updatedAt: 100, currentTimestamp: 1001 }), /stale/);
  assert.throws(() => validateOracleObservation({ ...base, updatedAt: 1200, currentTimestamp: 1100 }), /future/);
});

test("manifest v2 retains both deployed periphery dependency receipts", () => {
  const manifest = buildInfrastructureManifest(manifestInput());
  assert.equal(manifest.schemaVersion, INFRA_MANIFEST_SCHEMA_VERSION);
  assert.equal(INFRA_MANIFEST_SCHEMA_VERSION, 2);
  assert.deepEqual(manifest.peripheryDependencies, {
    nftDescriptor: receipt(G, 12),
    tokenDescriptor: receipt(I, 13),
  });
  assert.equal(manifest.deploymentBlock, 10);
  assert.equal(manifest.completionBlock, 16);
  assert.equal(validateInfrastructureManifest(manifest), true);

  const missing = structuredClone(manifest);
  delete missing.peripheryDependencies.tokenDescriptor;
  assert.throws(() => validateInfrastructureManifest(missing), /peripheryDependencies\.tokenDescriptor deployment receipt missing/);

  const badHash = structuredClone(manifest);
  badHash.peripheryDependencies.nftDescriptor.runtimeCodeHash = "0x1234";
  assert.throws(() => validateInfrastructureManifest(badHash), /runtimeCodeHash invalid/);
});

test("receipt-derived manifest maps exactly to the five current-stage environment variables", () => {
  const manifest = buildInfrastructureManifest(manifestInput());
  assert.equal(validateInfrastructureManifest(manifest), true);
  assert.deepEqual(manifest.mwzEnvironment, {
    ROBINHOOD_WETH_ADDRESS_46630: B,
    ROBINHOOD_V3_FACTORY_ADDRESS_46630: C,
    ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630: D,
    ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630: E,
    ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630: F,
  });
  assert.equal(manifest.productionCompatible, false);
  assert.equal(manifest.productionChainId, 4663);
});

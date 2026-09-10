import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  BROADCAST_TOKEN,
  CURRENT_CAMPAIGN_GENERATION,
  CURRENT_FACTORY_GENERATION,
  CURRENT_LIQUIDITY_KIND,
  CURRENT_STAGE_MANIFEST_SCHEMA_VERSION,
  CURRENT_STAGE_REQUIRED_DEPLOYMENTS,
  buildCurrentStageManifest,
  requireBoundAddress,
  requireRuntimeCode,
  validateCurrentStageManifest,
  validateOperatorBoundary,
} from "./robinhoodCurrentStageAuthority.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const E = "0x5555555555555555555555555555555555555555";
const F = "0x6666666666666666666666666666666666666666";
const G = "0x7777777777777777777777777777777777777777";
const H = "0x8888888888888888888888888888888888888888";
const I = "0x9999999999999999999999999999999999999999";
const J = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const K = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const L = "0xcccccccccccccccccccccccccccccccccccccccc";
const M = "0xdddddddddddddddddddddddddddddddddddddddd";
const N = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const O = "0xffffffffffffffffffffffffffffffffffffffff";
const P = "0x1212121212121212121212121212121212121212";
const Q = "0x1313131313131313131313131313131313131313";
const R = "0x1414141414141414141414141414141414141414";
const S = "0x1515151515151515151515151515151515151515";
const T = "0x1616161616161616161616161616161616161616";
const TX1 = `0x${"1".repeat(64)}`;
const TX2 = `0x${"2".repeat(64)}`;

function operator(overrides = {}) {
  return {
    chainId: 46630,
    rpcUrl: "https://rpc.operator.invalid",
    deployer: A,
    admin: A,
    routeAuthority: B,
    weth: C,
    v3Factory: D,
    positionManager: E,
    swapRouter: F,
    nativeUsdOracle: G,
    deployerBalanceWei: 100_000_000_000_000_000n,
    minimumBalanceWei: 50_000_000_000_000_000n,
    historicalAddresses: [I],
    ...overrides,
  };
}

function deploymentEvidence() {
  const addresses = [H, J, K, L, M, N, O, P, Q, R, S, T, "0x1717171717171717171717171717171717171717", "0x1818181818181818181818181818181818181818", "0x1919191919191919191919191919191919191919"];
  return Object.fromEntries(
    CURRENT_STAGE_REQUIRED_DEPLOYMENTS.map((name, index) => [name, {
      address: addresses[index],
      txHash: index < 8 ? TX1 : TX2,
      blockNumber: 101 + index,
    }]),
  );
}

test("current repository generation constants stay pinned", () => {
  assert.equal(CURRENT_FACTORY_GENERATION, 4);
  assert.equal(CURRENT_CAMPAIGN_GENERATION, 3);
  assert.equal(CURRENT_LIQUIDITY_KIND, 2);
  assert.equal(CURRENT_STAGE_MANIFEST_SCHEMA_VERSION, 4);
  assert.ok(CURRENT_STAGE_REQUIRED_DEPLOYMENTS.includes("treasuryRouterV3"));
  assert.ok(CURRENT_STAGE_REQUIRED_DEPLOYMENTS.includes("permanentV3PositionLocker"));
});

test("operator boundary accepts exact 46630 but remains dry-run by default", () => {
  const result = validateOperatorBoundary(operator());
  assert.equal(result.chainId, 46630);
  assert.equal(result.broadcast, false);
});

test("broadcast requires the exact explicit opt-in token", () => {
  assert.equal(validateOperatorBoundary(operator({ broadcastToken: "yes" })).broadcast, false);
  assert.equal(validateOperatorBoundary(operator({ broadcastToken: BROADCAST_TOKEN })).broadcast, true);
});

test("operator boundary rejects every non-46630 identity", () => {
  for (const chainId of [56, 97, 31337, 4663]) {
    assert.throws(() => validateOperatorBoundary(operator({ chainId })), /requires chain 46630/);
  }
});

test("operator boundary rejects placeholders and missing explicit RPC", () => {
  assert.throws(() => validateOperatorBoundary(operator({ rpcUrl: "https://<rpc>" })), /placeholders are forbidden/);
  assert.throws(() => validateOperatorBoundary(operator({ weth: "0x<weth>" })), /non-placeholder/);
  assert.throws(() => validateOperatorBoundary(operator({ nativeUsdOracle: "" })), /non-placeholder/);
});

test("operator boundary rejects wrong deployer/admin and shared route authority", () => {
  assert.throws(() => validateOperatorBoundary(operator({ admin: B })), /deployer must exactly equal/);
  assert.throws(() => validateOperatorBoundary(operator({ routeAuthority: A })), /distinct/);
});

test("operator boundary rejects insufficient deployer funding when known", () => {
  assert.throws(
    () => validateOperatorBoundary(operator({ deployerBalanceWei: 49_999_999_999_999_999n })),
    /below minimum/,
  );
});

test("operator boundary refuses frozen 5B/5C external infrastructure reuse", () => {
  assert.throws(() => validateOperatorBoundary(operator({ historicalAddresses: [D] })), /frozen historical/);
  assert.throws(() => validateOperatorBoundary(operator({ historicalAddresses: [C] })), /frozen historical/);
});

test("runtime bytecode and immutable binding helpers fail closed", () => {
  assert.throws(() => requireRuntimeCode("weth", "0x"), /no runtime bytecode/);
  assert.equal(requireRuntimeCode("weth", "0x6000"), true);
  assert.throws(() => requireBoundAddress("manager factory", C, D), /binding mismatch/);
  assert.equal(requireBoundAddress("manager factory", C, C), true);
});

test("manifest can only be built from complete deployment and wiring receipt evidence", () => {
  assert.throws(() => buildCurrentStageManifest({ operator: operator() }), /deployment evidence/);
  const incomplete = deploymentEvidence();
  delete incomplete.treasuryRouterV3;
  assert.throws(() => buildCurrentStageManifest({
    operator: operator(), deployment: incomplete,
    wiringTransactions: [{ name: "wire", txHash: TX2, blockNumber: 200 }],
    factoryLive: false, createPaused: true, securityDefaultsLocked: true,
  }), /treasuryRouterV3 deployment receipt is missing/);
  assert.throws(
    () => buildCurrentStageManifest({
      operator: operator(), deployment: deploymentEvidence(), wiringTransactions: [],
      factoryLive: false, createPaused: true, securityDefaultsLocked: true,
    }),
    /wiring transaction evidence/,
  );
});

test("generated manifest is receipt-derived, current-generation, dark and production-isolated", () => {
  const deployment = deploymentEvidence();
  const manifest = buildCurrentStageManifest({
    operator: operator(),
    deployment,
    wiringTransactions: [{ name: "wire", txHash: TX2, blockNumber: 200 }],
    factoryLive: false,
    createPaused: true,
    securityDefaultsLocked: true,
    deployedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(manifest.chainId, 46630);
  assert.equal(manifest.factoryGeneration, 4);
  assert.equal(manifest.campaignGeneration, 3);
  assert.equal(manifest.liquidityKind, 2);
  assert.equal(manifest.treasury, deployment.treasuryRouterV3.address);
  assert.equal(manifest.deploymentTransactions.launchFactory.txHash, TX2);
  assert.equal(manifest.deploymentBlock, 101);
  assert.equal(manifest.completionBlock, 200);
  assert.equal(manifest.state.factoryLive, false);
  assert.equal(manifest.state.createPaused, true);
  assert.equal(manifest.productionChainId, 4663);
  assert.equal(manifest.productionCompatible, false);
  assert.equal(validateCurrentStageManifest(manifest), true);
});

test("unsafe manifest state is rejected", () => {
  assert.throws(() => buildCurrentStageManifest({
    operator: operator(), deployment: deploymentEvidence(),
    wiringTransactions: [{ name: "wire", txHash: TX2, blockNumber: 200 }],
    factoryLive: true, createPaused: true, securityDefaultsLocked: true,
  }), /dark/);
});

test("source boundary preserves old 5C freeze and uses a separate current cutover executor", () => {
  const oldFreeze = fs.readFileSync(new URL("./robinhoodTestnetFreeze.mjs", import.meta.url), "utf8");
  const oldStage = fs.readFileSync(new URL("./deploy-robinhood-testnet-stage.ts", import.meta.url), "utf8");
  const current = fs.readFileSync(new URL("./deploy-robinhood-current-stage.ts", import.meta.url), "utf8");
  const factory = fs.readFileSync(new URL("../contracts/LaunchFactory.sol", import.meta.url), "utf8");
  const adapter = fs.readFileSync(new URL("../contracts/integrations/RobinhoodUniswapV3GraduationAdapter.sol", import.meta.url), "utf8");
  const locker = fs.readFileSync(new URL("../contracts/PermanentV3PositionLocker.sol", import.meta.url), "utf8");

  assert.match(oldFreeze, /assertRobinhoodTestnetMutationForbidden/);
  assert.match(oldFreeze, /later replacement requires a new generation\/factory cut/);
  assert.match(oldStage, /assertRobinhoodTestnetMutationForbidden\(chainId\)/);
  assert.match(factory, /FACTORY_GENERATION = 4/);
  assert.match(factory, /CAMPAIGN_GENERATION = 3/);
  assert.match(adapter, /contract RobinhoodUniswapV3GraduationAdapter/);
  assert.match(adapter, /LIQUIDITY_KIND_V3_NFT = 2/);
  assert.match(locker, /contract PermanentV3PositionLocker/);
  assert.match(locker, /exposes no NFT transfer, approve, decrease-liquidity, burn/);

  assert.match(current, /chainId !== CHAIN_ID \|\| network\.name !== "robinhoodTestnet"/);
  assert.match(current, /ROBINHOOD_TESTNET_BROADCAST/);
  assert.match(current, /getContractFactory\("TreasuryRouterV3"/);
  assert.match(current, /getContractFactory\("CommunityRewardsVault"/);
  assert.match(current, /getContractFactory\("CreatorRewardsVault"/);
  assert.match(current, /fs\.writeFileSync\(MANIFEST_PATH/);
  assert.doesNotMatch(current, /ROBINHOOD_TREASURY_ROUTER_ADDRESS_46630/);
  assert.doesNotMatch(current, /--network robinhoodMainnet|ROBINHOOD_MAINNET_BROADCAST/);
  assert.doesNotMatch(current, /getContractFactory\("MockWETH9"\)|getContractFactory\("MockUniswapV3Factory"\)/);
  assert.doesNotMatch(current, /0x9523d856E469E37D4b2C52f3b6C8fA2d360a229F/i);
});

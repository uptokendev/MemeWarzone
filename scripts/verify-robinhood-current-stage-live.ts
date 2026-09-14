import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const CHAIN_ID = 46630;
const MANIFEST_PATH = path.resolve("deployments/robinhood/testnet.staged.json");
const EVIDENCE_PATH = path.resolve(process.env.ROBINHOOD_CURRENT_STAGE_EVIDENCE_FILE || "robinhood-current-stage-deployment-evidence.json");

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sameAddress(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function runtimeHash(address: string): Promise<string> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`runtime bytecode missing at ${address}`);
  return ethers.keccak256(code);
}

async function main() {
  if (network.name !== "robinhoodTestnet") throw new Error(`verification requires robinhoodTestnet; got ${network.name}`);
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`verification requires chain ${CHAIN_ID}; got ${net.chainId}`);

  const authority = await import("./robinhoodCurrentStageAuthority.mjs");
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`missing generated staging manifest: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  authority.validateCurrentStageManifest(manifest);

  const expectedInfrastructure = {
    wrappedNative: required("ROBINHOOD_WETH_ADDRESS_46630"),
    v3Factory: required("ROBINHOOD_V3_FACTORY_ADDRESS_46630"),
    positionManager: required("ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630"),
    swapRouter: required("ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630"),
    nativeUsdOracleFeed: required("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630"),
  };
  for (const [name, expected] of Object.entries(expectedInfrastructure)) {
    const actual = manifest.infrastructure?.[name];
    if (!sameAddress(actual, expected)) throw new Error(`manifest infrastructure mismatch for ${name}`);
    const code = await ethers.provider.getCode(expected);
    if (!code || code === "0x") throw new Error(`accepted infrastructure has no runtime code: ${name}`);
  }

  const deployments: Record<string, unknown> = {};
  for (const name of authority.CURRENT_STAGE_REQUIRED_DEPLOYMENTS) {
    const address = manifest.contracts?.[name];
    const txEvidence = manifest.deploymentTransactions?.[name];
    const expectedHash = manifest.contractRuntimeCodeHashes?.[name];
    if (!address || !txEvidence?.txHash || !txEvidence?.blockNumber || !expectedHash) {
      throw new Error(`${name} deployment provenance incomplete`);
    }
    const receipt = await ethers.provider.getTransactionReceipt(txEvidence.txHash);
    if (!receipt || receipt.status !== 1 || Number(receipt.blockNumber) !== Number(txEvidence.blockNumber)) {
      throw new Error(`${name} deployment receipt mismatch`);
    }
    const observedHash = await runtimeHash(address);
    if (observedHash.toLowerCase() !== String(expectedHash).toLowerCase()) throw new Error(`${name} runtime hash mismatch`);
    deployments[name] = {
      address,
      txHash: txEvidence.txHash,
      blockNumber: Number(txEvidence.blockNumber),
      runtimeCodeHash: observedHash,
      sourceGeneration: name === "launchFactory"
        ? `factory-${authority.CURRENT_FACTORY_GENERATION}`
        : name === "campaignImplementation"
          ? `campaign-${authority.CURRENT_CAMPAIGN_GENERATION}`
          : "current-head-source",
    };
  }

  for (const tx of manifest.wiringTransactions || []) {
    const receipt = await ethers.provider.getTransactionReceipt(tx.txHash);
    if (!receipt || receipt.status !== 1 || Number(receipt.blockNumber) !== Number(tx.blockNumber)) {
      throw new Error(`wiring receipt mismatch: ${tx.name}`);
    }
  }

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", manifest.contracts.treasuryRouterV3);
  const creatorRegistry = await ethers.getContractAt("CreatorRegistry", manifest.contracts.creatorRegistry);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", manifest.contracts.permanentV3PositionLocker);

  if (Number(await factory.FACTORY_GENERATION()) !== authority.CURRENT_FACTORY_GENERATION) throw new Error("factory generation mismatch");
  if (Number(await factory.CAMPAIGN_GENERATION()) !== authority.CURRENT_CAMPAIGN_GENERATION) throw new Error("campaign generation mismatch");
  if (Number(await factory.liquidityKind()) !== authority.CURRENT_LIQUIDITY_KIND) throw new Error("liquidity kind mismatch");
  if (!sameAddress(await factory.routeAuthority(), manifest.routeAuthority)) throw new Error("route authority wiring mismatch");
  if (!sameAddress(await factory.creatorRegistry(), manifest.contracts.creatorRegistry)) throw new Error("creator registry wiring mismatch");
  if (!sameAddress(await factory.riskRegistry(), manifest.contracts.riskRegistry)) throw new Error("risk registry wiring mismatch");
  if (Number(await factory.tradeRouteProfile()) !== 1 || Number(await factory.finalizeRouteProfile()) !== 1) throw new Error("route profile wiring mismatch");
  if (await factory.live()) throw new Error("staging factory unexpectedly live");
  if (!(await factory.createPaused())) throw new Error("staging factory must remain createPaused");
  if (!(await factory.securityDefaultsLocked())) throw new Error("security defaults not locked");
  if (!(await factory.requireAuthorizedTrading()) || !(await factory.requireRouteAuthorization())) throw new Error("authorization defaults weakened");
  if (!(await creatorRegistry.launchRecorder(manifest.contracts.launchFactory))) throw new Error("launch recorder wiring mismatch");

  const treasuryBindings: Array<[string, string]> = [
    ["weeklyLeagueVault", manifest.contracts.weeklyLeagueVault],
    ["monthlyLeagueTreasury", manifest.contracts.monthlyLeagueTreasury],
    ["recruiterRewardsVault", manifest.contracts.recruiterRewardsVault],
    ["communityRewardsVault", manifest.contracts.communityRewardsVault],
    ["protocolRevenueVault", manifest.contracts.protocolRevenueVault],
    ["creatorRewardsVault", manifest.contracts.creatorRewardsVault],
  ];
  for (const [getter, expected] of treasuryBindings) {
    const actual = await (treasury as any)[getter]();
    if (!sameAddress(actual, expected)) throw new Error(`treasury ${getter} wiring mismatch`);
  }
  if (!sameAddress(await treasury.permanentLpLocker(), manifest.contracts.permanentV3PositionLocker)) throw new Error("primary locker mismatch");
  if (!(await treasury.authorizedLpLocker(manifest.contracts.permanentV3PositionLocker))) throw new Error("locker authorization missing");
  if (!sameAddress(await factory.permanentLpLocker(), manifest.contracts.permanentV3PositionLocker)) throw new Error("factory locker mismatch");

  if (!sameAddress(await locker.v3Factory(), expectedInfrastructure.v3Factory)) throw new Error("locker factory binding mismatch");
  if (!sameAddress(await locker.positionManager(), expectedInfrastructure.positionManager)) throw new Error("locker position manager binding mismatch");
  if (!sameAddress(await locker.wrappedNative(), expectedInfrastructure.wrappedNative)) throw new Error("locker WETH binding mismatch");
  if (!sameAddress(await locker.integrationSource(), manifest.contracts.graduationAdapter)) throw new Error("locker integration source mismatch");

  const evidence = {
    sourceSha: required("GITHUB_SHA"),
    chainId: CHAIN_ID,
    productionChainId: 4663,
    productionCompatible: false,
    factoryGeneration: authority.CURRENT_FACTORY_GENERATION,
    campaignGeneration: authority.CURRENT_CAMPAIGN_GENERATION,
    liquidityKind: authority.CURRENT_LIQUIDITY_KIND,
    v3FeeTier: authority.CURRENT_V3_FEE_TIER,
    infrastructure: manifest.infrastructure,
    deployments,
    wiringTransactions: manifest.wiringTransactions,
    state: manifest.state,
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    sourceSha: evidence.sourceSha,
    chainId: evidence.chainId,
    productionCompatible: evidence.productionCompatible,
    factoryGeneration: evidence.factoryGeneration,
    campaignGeneration: evidence.campaignGeneration,
    deployments,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

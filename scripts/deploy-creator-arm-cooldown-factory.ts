import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { refuseBnbFactoryBroadcastIfSourceHeadIsNotLive } from "./lib/bnbLiveGenerationGuard";

const TESTNET_CHAIN_ID = 97n;
const OBSOLETE_FACTORY_FALLBACK = "0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6";
const PREVIOUS_FACTORY_FALLBACK = "0xF7872169265eCE4E4C93ef894F1635E84DC6F681";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function rawEnv(name: string) {
  return String(process.env[name] || "").trim();
}

function requireAddress(label: string, value: string) {
  if (!ADDRESS_RE.test(value)) throw new Error(`${label}: missing or invalid address: ${value || "<empty>"}`);
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error(`${label}: zero address is not allowed.`);
  return address;
}

async function assertCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label}: no contract code at ${address}`);
}

function assertAddressEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  console.log(`[creator-arm-cooldown-factory] submitted ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed.`);
  return receipt;
}

async function main() {
  refuseBnbFactoryBroadcastIfSourceHeadIsNotLive();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`This staged replacement is restricted to BSC Testnet chain 97; connected chain is ${net.chainId}.`);
  }

  const obsoleteFactoryAddress = requireAddress(
    "Obsolete scheduled-slot factory",
    rawEnv("OBSOLETE_SCHEDULED_FACTORY_ADDRESS") || OBSOLETE_FACTORY_FALLBACK,
  );
  const previousFactoryAddress = requireAddress(
    "Previous supported factory",
    rawEnv("PREVIOUS_SUPPORTED_FACTORY_ADDRESS") || PREVIOUS_FACTORY_FALLBACK,
  );
  const [deployer] = await ethers.getSigners();
  const deployerAddress = ethers.getAddress(await deployer.getAddress());

  await assertCode("Obsolete scheduled-slot factory", obsoleteFactoryAddress);
  await assertCode("Previous supported factory", previousFactoryAddress);

  const obsoleteFactory = await ethers.getContractAt("LaunchFactory", obsoleteFactoryAddress, deployer);
  const previousFactory = await ethers.getContractAt("LaunchFactory", previousFactoryAddress, deployer);

  const router = requireAddress("Topaz router adapter", await obsoleteFactory.router());
  const treasuryRouter = requireAddress("TreasuryRouterV2", await obsoleteFactory.feeRecipient());
  const campaignImplementation = requireAddress("LaunchCampaign implementation", await obsoleteFactory.campaignImplementation());
  const graduationOracle = requireAddress("GraduationOracle", await obsoleteFactory.graduationOracle());
  const creatorRegistry = requireAddress("CreatorRegistry", await obsoleteFactory.creatorRegistry());
  const riskRegistry = requireAddress("RiskRegistry", await obsoleteFactory.riskRegistry());
  const routeAuthority = requireAddress("Route authority", await obsoleteFactory.routeAuthority());
  const obsoleteLocker = requireAddress("Obsolete factory locker", await obsoleteFactory.permanentLpLocker());
  const previousLocker = requireAddress("Previous factory locker", await previousFactory.permanentLpLocker());

  for (const [label, address] of [
    ["Topaz router adapter", router],
    ["TreasuryRouterV2", treasuryRouter],
    ["LaunchCampaign implementation", campaignImplementation],
    ["GraduationOracle", graduationOracle],
    ["CreatorRegistry", creatorRegistry],
    ["RiskRegistry", riskRegistry],
    ["Obsolete factory locker", obsoleteLocker],
    ["Previous factory locker", previousLocker],
  ] as Array<[string, string]>) {
    await assertCode(label, address);
  }

  const registry = new ethers.Contract(
    creatorRegistry,
    [
      "function owner() view returns (address)",
      "function launchRecorder(address) view returns (bool)",
      "function setLaunchRecorder(address,bool)",
    ],
    deployer,
  );
  const treasury = new ethers.Contract(
    treasuryRouter,
    [
      "function admin() view returns (address)",
      "function authorizedLpLocker(address) view returns (bool)",
      "function permanentLpLocker() view returns (address)",
      "function setAuthorizedLpLocker(address,bool)",
      "function setPrimaryLpLocker(address)",
    ],
    deployer,
  );

  if (!(await registry.launchRecorder(obsoleteFactoryAddress))) {
    throw new Error("Obsolete factory is not retained as a CreatorRegistry launch recorder.");
  }
  if (!(await registry.launchRecorder(previousFactoryAddress))) {
    throw new Error("Previous factory is not retained as a CreatorRegistry launch recorder.");
  }
  if (!(await treasury.authorizedLpLocker(obsoleteLocker))) {
    throw new Error("Obsolete factory locker is not authorized in TreasuryRouterV2.");
  }
  if (!(await treasury.authorizedLpLocker(previousLocker))) {
    throw new Error("Previous factory locker is not authorized in TreasuryRouterV2.");
  }

  const oldConfig = await obsoleteFactory.config();
  const oldProtection = await obsoleteFactory.launchProtectionConfig();
  const tradeRouteProfile = Number(await obsoleteFactory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await obsoleteFactory.finalizeRouteProfile());
  const protocolFeeBps = BigInt(await obsoleteFactory.protocolFeeBps());

  const Factory = await ethers.getContractFactory("LaunchFactory", deployer);
  const replacement = await Factory.deploy(router, treasuryRouter, campaignImplementation, graduationOracle);
  const deploymentTx = replacement.deploymentTransaction();
  if (!deploymentTx) throw new Error("Replacement deployment transaction is unavailable.");
  const deploymentReceipt = await deploymentTx.wait(2);
  if (!deploymentReceipt || deploymentReceipt.status !== 1) throw new Error("Replacement LaunchFactory deployment failed.");

  const replacementAddress = ethers.getAddress(await replacement.getAddress());
  const replacementLocker = ethers.getAddress(await replacement.permanentLpLocker());
  await assertCode("Replacement LaunchFactory", replacementAddress);
  await assertCode("Replacement PermanentLpLocker", replacementLocker);

  await waitTx(replacement.setConfig({
    totalSupply: oldConfig.totalSupply,
    curveBps: oldConfig.curveBps,
    liquidityTokenBps: oldConfig.liquidityTokenBps,
    basePrice: oldConfig.basePrice,
    priceSlope: oldConfig.priceSlope,
    graduationTarget: oldConfig.graduationTarget,
    liquidityBps: oldConfig.liquidityBps,
  }), "LaunchFactory.setConfig");
  await waitTx(replacement.setRegistries(creatorRegistry, riskRegistry), "LaunchFactory.setRegistries");
  await waitTx(replacement.setRouteAuthority(routeAuthority), "LaunchFactory.setRouteAuthority");
  await waitTx(replacement.setRouteProfiles(tradeRouteProfile, finalizeRouteProfile), "LaunchFactory.setRouteProfiles");
  if (BigInt(await replacement.protocolFeeBps()) !== protocolFeeBps) {
    await waitTx(replacement.setProtocolFee(protocolFeeBps), "LaunchFactory.setProtocolFee");
  }
  if (BigInt(oldProtection.blocks_) || BigInt(oldProtection.maxBuyWei) || BigInt(oldProtection.maxWalletWei)) {
    await waitTx(
      replacement.setLaunchProtectionConfig(oldProtection.blocks_, oldProtection.maxBuyWei, oldProtection.maxWalletWei),
      "LaunchFactory.setLaunchProtectionConfig",
    );
  }
  await waitTx(replacement.lockSecurityDefaults(), "LaunchFactory.lockSecurityDefaults");

  if (Number(await replacement.FACTORY_GENERATION()) !== 3) throw new Error("Replacement factory generation is not 3.");
  if (Number(await replacement.CAMPAIGN_GENERATION()) !== 2) throw new Error("Replacement campaign generation is not 2.");
  if (await replacement.live()) throw new Error("Replacement factory must remain disabled after staged deployment.");
  if (BigInt(await replacement.campaignsCount()) !== 0n) throw new Error("Replacement factory unexpectedly contains campaigns.");
  assertAddressEq("Replacement campaign implementation", await replacement.campaignImplementation(), campaignImplementation);
  assertAddressEq("Replacement creator registry", await replacement.creatorRegistry(), creatorRegistry);
  assertAddressEq("Replacement risk registry", await replacement.riskRegistry(), riskRegistry);
  assertAddressEq("Replacement route authority", await replacement.routeAuthority(), routeAuthority);

  const canConfigureRegistry = (await registry.owner()).toLowerCase() === deployerAddress.toLowerCase();
  const canConfigureTreasury = (await treasury.admin()).toLowerCase() === deployerAddress.toLowerCase();
  const executeDependencies = ["1", "true", "yes"].includes(rawEnv("EXECUTE_REPLACEMENT_DEPENDENCIES").toLowerCase());

  const dependencyTransactions: Record<string, string> = {};
  if (executeDependencies) {
    if (!canConfigureRegistry || !canConfigureTreasury) {
      throw new Error("EXECUTE_REPLACEMENT_DEPENDENCIES requires deployer control of CreatorRegistry and TreasuryRouterV2.");
    }
    if (!(await registry.launchRecorder(replacementAddress))) {
      const receipt = await waitTx(registry.setLaunchRecorder(replacementAddress, true), "CreatorRegistry.setLaunchRecorder(new factory)");
      dependencyTransactions.creatorRegistry = receipt.hash;
    }
    if (!(await treasury.authorizedLpLocker(replacementLocker))) {
      const receipt = await waitTx(treasury.setAuthorizedLpLocker(replacementLocker, true), "TreasuryRouterV2.setAuthorizedLpLocker(new locker)");
      dependencyTransactions.lockerAuthorization = receipt.hash;
    }
  }

  const root = path.resolve(__dirname, "..");
  const manifestFile = path.join(root, "deployments", "bscTestnet.creator-arm-cooldown-factory.staged.json");
  writeJson(manifestFile, {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deploymentBlock: deploymentReceipt.blockNumber,
    deploymentTxHash: deploymentReceipt.hash,
    deployer: deployerAddress,
    status: "staged-not-live",
    purpose: "creator cooldown evaluated at arm/deploy time; launchAt is a non-exclusive trading-open timestamp",
    replacement: {
      factory: replacementAddress,
      locker: replacementLocker,
      factoryGeneration: Number(await replacement.FACTORY_GENERATION()),
      campaignGeneration: Number(await replacement.CAMPAIGN_GENERATION()),
      live: Boolean(await replacement.live()),
      securityDefaultsLocked: Boolean(await replacement.securityDefaultsLocked()),
    },
    reused: {
      campaignImplementation,
      treasuryRouter,
      creatorRegistry,
      riskRegistry,
      graduationOracle,
      router,
      routeAuthority,
    },
    supportedFactories: [
      { address: previousFactoryAddress, locker: previousLocker, creationEnabled: false, supportEnabled: true },
      { address: obsoleteFactoryAddress, locker: obsoleteLocker, creationEnabled: false, supportEnabled: true },
      { address: replacementAddress, locker: replacementLocker, creationEnabled: false, supportEnabled: true },
    ],
    dependencyState: {
      previousRecorder: Boolean(await registry.launchRecorder(previousFactoryAddress)),
      obsoleteRecorder: Boolean(await registry.launchRecorder(obsoleteFactoryAddress)),
      replacementRecorder: Boolean(await registry.launchRecorder(replacementAddress)),
      previousLockerAuthorized: Boolean(await treasury.authorizedLpLocker(previousLocker)),
      obsoleteLockerAuthorized: Boolean(await treasury.authorizedLpLocker(obsoleteLocker)),
      replacementLockerAuthorized: Boolean(await treasury.authorizedLpLocker(replacementLocker)),
      primaryLocker: await treasury.permanentLpLocker(),
      transactions: dependencyTransactions,
    },
    activationRequired: [
      "Authorize replacement factory as CreatorRegistry launch recorder",
      "Authorize replacement locker in TreasuryRouterV2 without removing old lockers",
      "Run activation verifier",
      "Enable replacement factory",
      "Pause creation on obsolete factory only",
      "Update frontend, Railway, and indexer generation manifests",
    ],
  });

  console.log(`[creator-arm-cooldown-factory] staged factory=${replacementAddress}`);
  console.log(`[creator-arm-cooldown-factory] staged locker=${replacementLocker}`);
  console.log(`[creator-arm-cooldown-factory] manifest=${manifestFile}`);
  console.log("[creator-arm-cooldown-factory] factory remains disabled; run the activation verifier before cutover");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

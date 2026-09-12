import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import {
  PRODUCTION_SAFE,
  REQUIRED_CAMPAIGN_GENERATION,
  REQUIRED_FACTORY_GENERATION,
  REQUIRED_VOLATILE_FEE_BPS,
  assertProductionGraduationTarget,
  resolveBnb56TopazAuthority,
} from "./lib/bnbMainnetTopazAuthority";

const EXECUTE_CONFIRM = "I_UNDERSTAND_BNB56_DARK_DEPLOY";
const DEFAULT_GAS_BUDGET = 16_000_000n;
const CONFIG = {
  totalSupply: ethers.parseEther("1000000000"),
  curveBps: 8400n,
  liquidityTokenBps: 1400n,
  basePrice: 1_000_000_000n,
  priceSlope: 850n,
  graduationTarget: ethers.parseEther("30000"),
  liquidityBps: 3300n,
};

function executeRequested(): boolean {
  return String(process.env.BNB56_EXECUTE_DARK_DEPLOY || "").trim() === EXECUTE_CONFIRM;
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function requireCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${label} has no runtime code at ${address}`);
}

async function main() {
  if (network.name !== "bscMainnet") throw new Error(`BNB56 Gen-4 executor is bscMainnet-only, got ${network.name}`);
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 56) throw new Error(`BNB56 Gen-4 executor refuses chain ${net.chainId}`);

  assertProductionGraduationTarget(CONFIG.graduationTarget);
  const authority = await resolveBnb56TopazAuthority();
  if (authority.volatileFeeBps !== REQUIRED_VOLATILE_FEE_BPS.toString()) throw new Error("Topaz fee proof drifted from 30 bps");
  if (authority.activeFactoryOwner.toLowerCase() !== PRODUCTION_SAFE.toLowerCase()) throw new Error("current production owner is not the production Safe");
  if (authority.treasuryAdmin.toLowerCase() !== PRODUCTION_SAFE.toLowerCase()) throw new Error("Treasury authority is not the production Safe");

  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.gasPrice ?? ethers.parseUnits("1", "gwei");
  const gasBudget = BigInt(String(process.env.BNB56_DARK_GAS_BUDGET || DEFAULT_GAS_BUDGET));
  const minimumFunding = gasBudget * gasPrice;
  const recommendedFunding = minimumFunding * 3n / 2n;

  console.log(`[bnb56-gen4] mode=${executeRequested() ? "EXECUTE_DARK" : "PREFLIGHT_ONLY"}`);
  console.log(`[bnb56-gen4] chain=56 liveBlock=${authority.blockNumber}`);
  console.log(`[bnb56-gen4] currentFactory=${authority.activeFactory}`);
  console.log(`[bnb56-gen4] currentOwner=${authority.activeFactoryOwner}`);
  console.log(`[bnb56-gen4] currentRouteAuthority=${authority.activeFactoryRouteAuthority}`);
  console.log(`[bnb56-gen4] currentOracle=${authority.activeFactoryOracle}`);
  console.log(`[bnb56-gen4] treasury=${authority.activeFactoryTreasury} admin=${authority.treasuryAdmin}`);
  console.log(`[bnb56-gen4] Topaz Router=${authority.router.address} codeHash=${authority.router.codeHash}`);
  console.log(`[bnb56-gen4] Topaz PoolFactory=${authority.poolFactory.address} codeHash=${authority.poolFactory.codeHash}`);
  console.log(`[bnb56-gen4] Topaz FactoryRegistry=${authority.factoryRegistry.address} codeHash=${authority.factoryRegistry.codeHash}`);
  console.log(`[bnb56-gen4] WBNB=${authority.wbnb.address} codeHash=${authority.wbnb.codeHash}`);
  console.log(`[bnb56-gen4] Topaz PoolImplementation=${authority.poolImplementation.address} codeHash=${authority.poolImplementation.codeHash}`);
  console.log(`[bnb56-gen4] funding floor methodology: gasBudget(${gasBudget}) * currentGasPrice(${gasPrice}) = ${ethers.formatEther(minimumFunding)} BNB`);
  console.log(`[bnb56-gen4] recommended safe funding: 150% of floor = ${ethers.formatEther(recommendedFunding)} BNB`);

  if (!executeRequested()) {
    console.log(`[bnb56-gen4] PREFLIGHT PASS. No signer required, no transaction constructed for broadcast.`);
    console.log(`[bnb56-gen4] To authorize a later dark deployment set BNB56_EXECUTE_DARK_DEPLOY=${EXECUTE_CONFIRM}; Launch Control must separately approve.`);
    return;
  }

  const signers = await ethers.getSigners();
  if (!signers.length) throw new Error("dark deployment execution requires a configured deployer signer");
  const deployer = signers[0];
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  if (deployerAddress.toLowerCase() === PRODUCTION_SAFE.toLowerCase()) throw new Error("deployment signer must not be the production Safe");
  const balance = await ethers.provider.getBalance(deployerAddress);
  if (balance < minimumFunding) throw new Error(`deployer funding below preflight floor: have ${ethers.formatEther(balance)}, need >= ${ethers.formatEther(minimumFunding)} BNB`);

  const Adapter = await ethers.getContractFactory("TopazRouterAdapter", deployer);
  const adapter = await Adapter.deploy(authority.router.address);
  await adapter.waitForDeployment();
  eq("adapter.topazRouter", await adapter.topazRouter(), authority.router.address);
  eq("adapter.poolFactory", await adapter.poolFactory(), authority.poolFactory.address);
  eq("adapter.WETH", await adapter.WETH(), authority.wbnb.address);

  const Campaign = await ethers.getContractFactory("LaunchCampaign", deployer);
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory", deployer);
  const factory = await Factory.deploy(
    await adapter.getAddress(),
    authority.activeFactoryTreasury,
    await campaignImplementation.getAddress(),
    authority.activeFactoryOracle,
  );
  await factory.waitForDeployment();
  const factoryAddress = ethers.getAddress(await factory.getAddress());
  const lockerAddress = ethers.getAddress(await factory.permanentLpLocker());
  const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress, deployer);

  if (factoryAddress.toLowerCase() === authority.activeFactory.toLowerCase()) throw new Error("fresh Gen-4 factory collided with current production factory");
  await requireCode(lockerAddress, "fresh permanent locker");
  eq("FACTORY_GENERATION", await factory.FACTORY_GENERATION(), REQUIRED_FACTORY_GENERATION);
  eq("CAMPAIGN_GENERATION", await factory.CAMPAIGN_GENERATION(), REQUIRED_CAMPAIGN_GENERATION);
  eq("liquidityKind", await factory.liquidityKind(), 1n);
  eq("locker.REQUIRED_POOL_FEE_BPS", await locker.REQUIRED_POOL_FEE_BPS(), 30n);
  eq("locker.CREATOR_FEE_BPS", await locker.CREATOR_FEE_BPS(), 8000n);
  eq("locker.PROTOCOL_FEE_BPS", await locker.PROTOCOL_FEE_BPS(), 2000n);
  eq("locker.topazFactory", await locker.topazFactory(), authority.poolFactory.address);

  await (await factory.setCreatePaused(true)).wait();
  await (await factory.setRegistries(authority.activeFactoryCreatorRegistry, authority.activeFactoryRiskRegistry)).wait();
  await (await factory.setRouteAuthority(authority.activeFactoryRouteAuthority)).wait();
  await (await factory.setRouteProfiles(1, 1)).wait();
  await (await factory.setConfig(CONFIG)).wait();
  await (await factory.setLaunchProtectionConfig(0, 0, 0)).wait();
  await (await factory.lockSecurityDefaults()).wait();

  eq("live", await factory.live(), false);
  eq("createPaused", await factory.createPaused(), true);
  eq("securityDefaultsLocked", await factory.securityDefaultsLocked(), true);
  eq("requireRouteAuthorization", await factory.requireRouteAuthorization(), true);
  eq("requireAuthorizedTrading", await factory.requireAuthorizedTrading(), true);
  eq("routeAuthority", await factory.routeAuthority(), authority.activeFactoryRouteAuthority);
  eq("graduationOracle", await factory.graduationOracle(), authority.activeFactoryOracle);
  eq("feeRecipient", await factory.feeRecipient(), authority.activeFactoryTreasury);
  eq("creatorRegistry", await factory.creatorRegistry(), authority.activeFactoryCreatorRegistry);
  eq("riskRegistry", await factory.riskRegistry(), authority.activeFactoryRiskRegistry);
  eq("$6 forbidden", await factory.isGraduationTargetAllowedForChain(56, ethers.parseEther("6")), false);

  await (await factory.transferOwnership(authority.activeFactoryOwner)).wait();
  eq("owner", await factory.owner(), authority.activeFactoryOwner);

  const treasuryIface = new ethers.Interface([
    "function setAuthorizedLpLocker(address locker, bool allowed)",
    "function setPrimaryLpLocker(address newLocker)",
  ]);
  const creatorRegistryIface = new ethers.Interface(["function setLaunchRecorder(address recorder, bool allowed)"]);
  const safePreparation = {
    creatorRegistryAuthorization: {
      to: authority.activeFactoryCreatorRegistry,
      data: creatorRegistryIface.encodeFunctionData("setLaunchRecorder", [factoryAddress, true]),
      description: "Authorize fresh Gen-4 factory as launch recorder only when Launch Control starts controlled-canary wiring.",
    },
    treasuryLockerAuthorization: {
      to: authority.activeFactoryTreasury,
      data: treasuryIface.encodeFunctionData("setAuthorizedLpLocker", [lockerAddress, true]),
      description: "Authorize fresh permanent locker as a Treasury revenue source before the controlled canary. This does not change the historical primary locker.",
    },
    postCanaryPrimaryLockerCutover: {
      to: authority.activeFactoryTreasury,
      data: treasuryIface.encodeFunctionData("setPrimaryLpLocker", [lockerAddress]),
      description: "POST-CANARY ONLY: set fresh Gen-4 locker primary after Launch Control accepts the canary. Do not execute during dark deployment/preparation.",
    },
  };

  const receipt = await factory.deploymentTransaction()?.wait();
  const artifact = {
    schemaVersion: 1,
    network: "bscMainnet",
    chainId: 56,
    sourceHead: process.env.BNB56_SOURCE_HEAD || null,
    status: "DARK_DEPLOYED_NOT_CUT_OVER",
    deployedAt: new Date().toISOString(),
    deploymentBlock: receipt?.blockNumber ?? null,
    deployer: deployerAddress,
    factoryGeneration: 4,
    campaignGeneration: 3,
    launchFactory: factoryAddress,
    campaignImplementation: await campaignImplementation.getAddress(),
    topazRouterAdapter: await adapter.getAddress(),
    permanentLpLocker: lockerAddress,
    owner: authority.activeFactoryOwner,
    routeAuthority: authority.activeFactoryRouteAuthority,
    graduationOracle: authority.activeFactoryOracle,
    treasury: authority.activeFactoryTreasury,
    live: false,
    createPaused: true,
    topazEvidence: authority,
    safePreparation,
    activationForbiddenUntilCanaryGate: true,
  };
  const out = path.resolve(process.env.BNB56_DARK_DEPLOY_OUT || "deployments/bscMainnet/gen4-dark-deployment.generated.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[bnb56-gen4] dark deployment complete at ${factoryAddress}; wrote ${out}`);
  console.log(`[bnb56-gen4] STOP: live=false and createPaused=true. No frontend/indexer promotion. No canary transactions.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

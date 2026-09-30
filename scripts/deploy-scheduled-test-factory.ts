import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";
import { assertCode, resolveContracts } from "./verify-deployment";
import { deployFactoryWithLocker } from "./lib/deployFactoryWithLocker";

const TESTNET_CHAIN_ID = 97n;
const MAINNET_CHAIN_ID = 56n;
const TEST_GRADUATION_TARGET_USD = ethers.parseUnits("6", 18);
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function rawEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function requireAddress(label: string, value: string): string {
  if (!ADDRESS_RE.test(value || "")) throw new Error(`${label}: missing or invalid address: ${value || "<empty>"}`);
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error(`${label}: zero address is not allowed.`);
  return address;
}

function assertAddressEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function loadBaseDeployment() {
  const file = process.env.DEPLOYMENT_FILE
    ? path.resolve(process.env.DEPLOYMENT_FILE)
    : path.join(__dirname, "..", "deployments", `${network.name}.treasury-v2-staged.json`);
  if (!fs.existsSync(file)) throw new Error(`Base deployment file not found: ${file}`);
  return { file, deployment: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function signerMatchesGetter(contractAddress: string, getter: "owner" | "admin"): Promise<boolean> {
  const [signer] = await ethers.getSigners();
  const contract = new ethers.Contract(contractAddress, [`function ${getter}() view returns (address)`], signer);
  try {
    return String(await contract[getter]()).toLowerCase() === (await signer.getAddress()).toLowerCase();
  } catch {
    return false;
  }
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId === MAINNET_CHAIN_ID) {
    throw new Error("Refusing test-threshold deployment on BSC mainnet (chain 56).");
  }
  if (net.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`This deployment is restricted to BSC Testnet chain 97; connected chain is ${net.chainId.toString()}.`);
  }

  const { file: baseFile, deployment: baseDeployment } = loadBaseDeployment();
  const contracts = resolveContracts(baseDeployment);
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const deploymentBlock = await ethers.provider.getBlockNumber();

  if (baseDeployment.treasuryRouterVersion !== "v2") {
    throw new Error("Scheduled test factory requires a TreasuryRouterV2 staged deployment. Run deploy:treasury-v2-minimal:bsc-testnet first.");
  }

  const oldFactory = requireAddress("Base LaunchFactory", contracts.LaunchFactory);
  const oldLocker = requireAddress("Base PermanentLpLocker", contracts.PermanentLpLocker);
  const launchRouter = requireAddress(
    "Launch router",
    rawEnv("FACTORY_ONLY_TOPAZ_ROUTER") ||
      baseDeployment.routing?.topazRouter ||
      baseDeployment.router ||
      baseDeployment.topazRouterAdapter ||
      baseDeployment.topazRouter,
  );
  const treasuryRouter = requireAddress("TreasuryRouterV2", contracts.TreasuryRouterV2);
  const graduationOracle = requireAddress("GraduationOracle", contracts.GraduationOracle);
  const creatorRegistry = requireAddress("CreatorRegistry", contracts.CreatorRegistry);
  const riskRegistry = requireAddress("RiskRegistry", contracts.RiskRegistry);
  const weeklyLeagueVault = requireAddress(
    "WeeklyLeagueVault",
    contracts.WeeklyLeagueVault || contracts.TreasuryVaultV2,
  );
  const monthlyLeagueTreasury = requireAddress("MonthlyLeagueTreasury", contracts.MonthlyLeagueTreasury);
  const recruiterRewardsVault = requireAddress("RecruiterRewardsVault", contracts.RecruiterRewardsVault);
  const communityRewardsVault = requireAddress("CommunityRewardsVault", contracts.CommunityRewardsVault);
  const protocolRevenueVault = requireAddress("ProtocolRevenueVault", contracts.ProtocolRevenueVault);
  const routeAuthority = requireAddress(
    "Route authority",
    rawEnv("ROUTE_AUTHORITY_ADDRESS") || baseDeployment.routing?.factoryRouteAuthority || baseDeployment.routeAuthority || "",
  );

  await assertCode("Old LaunchFactory", oldFactory);
  await assertCode("Old PermanentLpLocker", oldLocker);
  await assertCode("Launch router", launchRouter);
  await assertCode("TreasuryRouterV2", treasuryRouter);
  await assertCode("GraduationOracle", graduationOracle);
  await assertCode("CreatorRegistry", creatorRegistry);
  await assertCode("RiskRegistry", riskRegistry);
  await assertCode("WeeklyLeagueVault", weeklyLeagueVault);
  await assertCode("MonthlyLeagueTreasury", monthlyLeagueTreasury);
  await assertCode("RecruiterRewardsVault", recruiterRewardsVault);
  await assertCode("CommunityRewardsVault", communityRewardsVault);
  await assertCode("ProtocolRevenueVault", protocolRevenueVault);

  const treasury = new ethers.Contract(
    treasuryRouter,
    [
      "function admin() view returns (address)",
      "function weeklyLeagueVault() view returns (address)",
      "function monthlyLeagueTreasury() view returns (address)",
      "function recruiterRewardsVault() view returns (address)",
      "function communityRewardsVault() view returns (address)",
      "function protocolRevenueVault() view returns (address)",
      "function forwardingPaused() view returns (bool)",
      "function authorizedLpLocker(address) view returns (bool)",
      "function permanentLpLocker() view returns (address)",
      "function setAuthorizedLpLocker(address,bool)",
      "function setPrimaryLpLocker(address)",
    ],
    deployer,
  );

  assertAddressEq("TreasuryRouterV2.weeklyLeagueVault", await treasury.weeklyLeagueVault(), weeklyLeagueVault);
  assertAddressEq("TreasuryRouterV2.monthlyLeagueTreasury", await treasury.monthlyLeagueTreasury(), monthlyLeagueTreasury);
  assertAddressEq("TreasuryRouterV2.recruiterRewardsVault", await treasury.recruiterRewardsVault(), recruiterRewardsVault);
  assertAddressEq("TreasuryRouterV2.communityRewardsVault", await treasury.communityRewardsVault(), communityRewardsVault);
  assertAddressEq("TreasuryRouterV2.protocolRevenueVault", await treasury.protocolRevenueVault(), protocolRevenueVault);
  if (await treasury.forwardingPaused()) throw new Error("TreasuryRouterV2 forwarding is paused.");
  if (!(await treasury.authorizedLpLocker(oldLocker))) {
    throw new Error(`TreasuryRouterV2 has not authorized the legacy locker ${oldLocker}. Complete the staged Safe actions first.`);
  }
  assertAddressEq("TreasuryRouterV2.permanentLpLocker", await treasury.permanentLpLocker(), oldLocker);

  console.log(`[scheduled-test-factory] base deployment: ${baseFile}`);
  console.log(`[scheduled-test-factory] chainId=${net.chainId.toString()} network=${network.name}`);
  console.log(`[scheduled-test-factory] deployer=${deployerAddress}`);
  console.log("[scheduled-test-factory] TreasuryRouterV2 wiring verified");
  console.log("[scheduled-test-factory] fixed graduation target=$6 USD");

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();
  const campaignImplementationAddress = await campaignImplementation.getAddress();
  console.log(`[scheduled-test-factory] LaunchCampaign implementation=${campaignImplementationAddress}`);

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [launchRouter, treasuryRouter, campaignImplementationAddress, graduationOracle] })).factory;
  await factory.waitForDeployment();
  const newFactory = await factory.getAddress();
  const newLocker = await factory.permanentLpLocker();
  console.log(`[scheduled-test-factory] staged LaunchFactory=${newFactory}`);
  console.log(`[scheduled-test-factory] staged PermanentLpLocker=${newLocker}`);

  const currentConfig = await factory.config();
  await (
    await factory.setConfig({
      totalSupply: currentConfig.totalSupply,
      curveBps: currentConfig.curveBps,
      liquidityTokenBps: currentConfig.liquidityTokenBps,
      basePrice: currentConfig.basePrice,
      priceSlope: currentConfig.priceSlope,
      graduationTarget: TEST_GRADUATION_TARGET_USD,
      liquidityBps: currentConfig.liquidityBps,
    })
  ).wait();
  if ((await factory.config()).graduationTarget !== TEST_GRADUATION_TARGET_USD) {
    throw new Error("Factory graduation target verification failed.");
  }

  await (await factory.setRegistries(creatorRegistry, riskRegistry)).wait();
  await (await factory.setRouteAuthority(routeAuthority)).wait();

  const tradeRouteProfile = BigInt(baseDeployment.routing?.factoryTradeRouteProfile ?? 1);
  const finalizeRouteProfile = BigInt(baseDeployment.routing?.factoryFinalizeRouteProfile ?? 1);
  await (await factory.setRouteProfiles(tradeRouteProfile, finalizeRouteProfile)).wait();

  const protocolFeeBps = BigInt(baseDeployment.protocolFeeBps ?? 200);
  await (await factory.setProtocolFee(protocolFeeBps)).wait();
  await (await factory.lockSecurityDefaults()).wait();

  const postDeployActions: string[] = [];
  const registry = new ethers.Contract(
    creatorRegistry,
    ["function setLaunchRecorder(address,bool)", "function launchRecorder(address) view returns (bool)"],
    deployer,
  );
  if (!(await registry.launchRecorder(newFactory))) {
    if (await signerMatchesGetter(creatorRegistry, "owner")) {
      await (await registry.setLaunchRecorder(newFactory, true)).wait();
    } else {
      postDeployActions.push(`CreatorRegistry.setLaunchRecorder(${newFactory}, true)`);
    }
  }

  const signerIsTreasuryAdmin = await signerMatchesGetter(treasuryRouter, "admin");
  if (!(await treasury.authorizedLpLocker(newLocker))) {
    if (signerIsTreasuryAdmin) {
      await (await treasury.setAuthorizedLpLocker(newLocker, true)).wait();
    } else {
      postDeployActions.push(`TreasuryRouterV2.setAuthorizedLpLocker(${newLocker}, true)`);
    }
  }
  if (String(await treasury.permanentLpLocker()).toLowerCase() !== newLocker.toLowerCase()) {
    if (signerIsTreasuryAdmin) {
      await (await treasury.setPrimaryLpLocker(newLocker)).wait();
    } else {
      postDeployActions.push(`TreasuryRouterV2.setPrimaryLpLocker(${newLocker})`);
    }
  }

  const launchRecorderEnabled = Boolean(await registry.launchRecorder(newFactory));
  const newLockerAuthorized = Boolean(await treasury.authorizedLpLocker(newLocker));
  const newLockerPrimary = String(await treasury.permanentLpLocker()).toLowerCase() === newLocker.toLowerCase();
  const activationReady = launchRecorderEnabled && newLockerAuthorized && newLockerPrimary;

  const generation = rawEnv("FACTORY_ONLY_GENERATION") || "bnb-testnet-scheduled-v2";
  const priorFactories = Array.isArray(baseDeployment.factoryRegistry?.factories)
    ? baseDeployment.factoryRegistry.factories.map((entry: any) => ({
        ...entry,
        creationEnabled: String(entry.address || "").toLowerCase() === oldFactory.toLowerCase(),
        tradingEnabled: entry.tradingEnabled !== false,
        supportEnabled: entry.supportEnabled !== false,
      }))
    : [];

  let oldGeneration = baseDeployment.factoryRegistry?.activeGeneration || "previous";
  const oldEntry = priorFactories.find((entry: any) => String(entry.address || "").toLowerCase() === oldFactory.toLowerCase());
  if (oldEntry) {
    oldGeneration = oldEntry.generation || oldGeneration;
  } else {
    priorFactories.push({
      generation: oldGeneration,
      address: oldFactory,
      deploymentBlock: baseDeployment.deploymentBlock ?? null,
      creationEnabled: true,
      tradingEnabled: true,
      supportEnabled: true,
      routeAuthority: baseDeployment.routing?.factoryRouteAuthority || null,
      treasuryRouter: baseDeployment.contracts?.LegacyTreasuryRouter || baseDeployment.treasuryV2Migration?.legacyTreasuryRouter || null,
      permanentLpLocker: oldLocker,
      notes: "previous test factory retained as the active creation factory until staged activation",
    });
  }

  priorFactories.push({
    generation,
    address: newFactory,
    deploymentBlock,
    creationEnabled: false,
    tradingEnabled: true,
    supportEnabled: true,
    routeAuthority,
    treasuryRouter,
    permanentLpLocker: newLocker,
    campaignImplementation: campaignImplementationAddress,
    factoryGeneration: 2,
    campaignGeneration: 2,
    graduationTargetUsd: TEST_GRADUATION_TARGET_USD.toString(),
    notes: "staged BSC Testnet scheduled-launch factory; activation verification required",
  });

  const nextDeployment = {
    ...baseDeployment,
    network: network.name,
    chainId: Number(net.chainId),
    factoryReplacement: {
      stagedAt: new Date().toISOString(),
      activationRequired: true,
      baseDeployment: baseFile,
      oldFactory,
      oldPermanentLpLocker: oldLocker,
      newFactory,
      newPermanentLpLocker: newLocker,
      newCampaignImplementation: campaignImplementationAddress,
      purpose: "scheduled-launch end-to-end graduation testing",
    },
    stagedContracts: {
      LaunchCampaignImplementation: campaignImplementationAddress,
      LaunchFactory: newFactory,
      PermanentLpLocker: newLocker,
    },
    routing: {
      ...(baseDeployment.routing || {}),
      stagedFactoryFeeRecipient: treasuryRouter,
      stagedFactoryRouteAuthority: routeAuthority,
      stagedCampaignImplementation: campaignImplementationAddress,
      stagedPermanentLpLocker: newLocker,
      stagedPermanentLpLockerAuthorized: newLockerAuthorized,
    },
    stagedGraduationTargetUsd: TEST_GRADUATION_TARGET_USD.toString(),
    stagedFactoryGeneration: 2,
    stagedCampaignGeneration: 2,
    factoryRegistry: {
      activeFactory: oldFactory,
      activeGeneration: oldGeneration,
      stagedFactory: newFactory,
      stagedGeneration: generation,
      factories: priorFactories,
    },
    activationRequired: true,
    activationReady,
    postDeployActions,
  };

  const outFile = rawEnv("SCHEDULED_FACTORY_STAGED_OUTPUT_FILE")
    ? path.resolve(rawEnv("SCHEDULED_FACTORY_STAGED_OUTPUT_FILE"))
    : path.join(__dirname, "..", "deployments", `${network.name}.scheduled-test-factory.staged.json`);
  writeJson(outFile, nextDeployment);

  console.log(`\n[scheduled-test-factory] staged deployment=${outFile}`);
  console.log(`[scheduled-test-factory] STAGED_FACTORY_ADDRESS_97=${newFactory}`);
  console.log(`[scheduled-test-factory] STAGED_FACTORY_START_BLOCK_97=${deploymentBlock}`);
  console.log("[scheduled-test-factory] factory remains disabled until activate:scheduled-test-factory:bsc-testnet passes");

  if (postDeployActions.length) {
    console.log("\n[scheduled-test-factory] required Safe/admin actions before activation:");
    for (const action of postDeployActions) console.log(`- ${action}`);
  } else {
    console.log("[scheduled-test-factory] on-chain permissions are ready; run the activation script after reviewing the staged manifest.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

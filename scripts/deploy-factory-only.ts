import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";
import { assertCode, pickAddress, resolveContracts } from "./verify-deployment";
import { refuseBnbFactoryBroadcastIfSourceHeadIsNotLive } from "./lib/bnbLiveGenerationGuard";

const { writeFrontendEnv } = require("./lib/frontendEnv.cjs");
const { writeIndexerManifest } = require("./lib/indexerManifest.cjs");

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function rawEnv(name: string) {
  return String(process.env[name] ?? "").trim();
}

function boolEnv(name: string, fallback = false) {
  const raw = rawEnv(name).toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function numberEnv(name: string, fallback: number) {
  const raw = rawEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name}: expected integer`);
  return value;
}

function bigintEnv(name: string, fallback: bigint) {
  const raw = rawEnv(name);
  if (!raw) return fallback;
  return BigInt(raw);
}

function requireAddress(label: string, value: string) {
  if (!ADDRESS_RE.test(value || "")) throw new Error(`${label}: missing or invalid address: ${value || "<empty>"}`);
  return ethers.getAddress(value);
}

function optionalAddress(label: string, value: string) {
  if (!value) return "";
  return requireAddress(label, value);
}

function loadBaseDeployment() {
  const file = process.env.DEPLOYMENT_FILE
    ? path.resolve(process.env.DEPLOYMENT_FILE)
    : path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Base deployment file not found: ${file}`);
  return { file, deployment: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function signerOwns(contractAddress: string) {
  const [signer] = await ethers.getSigners();
  const ownable = new ethers.Contract(contractAddress, ["function owner() view returns (address)"], signer);
  try {
    return String(await ownable.owner()).toLowerCase() === (await signer.getAddress()).toLowerCase();
  } catch {
    return false;
  }
}

async function setIfDifferent(
  label: string,
  current: () => Promise<unknown>,
  expected: unknown,
  write: () => Promise<{ hash: string; wait: () => Promise<unknown> }>,
) {
  const before = await current();
  const beforeText = String(before).toLowerCase();
  const expectedText = String(expected).toLowerCase();
  if (beforeText === expectedText) {
    console.log(`[factory-only] ${label}: already ${expected}`);
    return false;
  }
  const tx = await write();
  console.log(`[factory-only] ${label}: submitted ${tx.hash}`);
  await tx.wait();
  console.log(`[factory-only] ${label}: set ${expected}`);
  return true;
}

async function supportsAuthorizedLpLocker(router: any, locker: string) {
  try {
    await router.authorizedLpLocker(locker);
    return true;
  } catch {
    return false;
  }
}

function buildFactoryRegistry(baseDeployment: any, nextDeployment: any, oldFactory: string, newFactory: string) {
  const source = baseDeployment.factoryRegistry || {};
  const sourceFactories = Array.isArray(source.factories) ? source.factories : [];
  const oldGeneration = source.activeGeneration || baseDeployment.factoryGeneration || "previous";
  const newGeneration = rawEnv("FACTORY_ONLY_GENERATION") || `factory-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const factories = sourceFactories.map((factory: any) => ({
    ...factory,
    creationEnabled: false,
    tradingEnabled: factory.tradingEnabled !== false,
    supportEnabled: factory.supportEnabled !== false,
    notes: factory.notes || "previous supported factory",
  }));

  if (!factories.some((factory: any) => String(factory.address || "").toLowerCase() === oldFactory.toLowerCase())) {
    factories.push({
      generation: oldGeneration,
      address: oldFactory,
      deploymentBlock: baseDeployment.deploymentBlock ?? null,
      creationEnabled: false,
      tradingEnabled: true,
      supportEnabled: true,
      routeAuthority: baseDeployment.routing?.factoryRouteAuthority || null,
      treasuryRouter: pickAddress(baseDeployment, "TreasuryRouter", ["TreasuryRouterV2", "treasuryRouterV2", "treasuryRouter", "leagueRouter", "routerAddress"]),
      permanentLpLocker: pickAddress(baseDeployment, "PermanentLpLocker", ["permanentLpLocker"]),
      notes: "previous canonical factory kept for legacy campaigns",
    });
  }

  factories.push({
    generation: newGeneration,
    address: newFactory,
    deploymentBlock: nextDeployment.deploymentBlock,
    creationEnabled: true,
    tradingEnabled: true,
    supportEnabled: true,
    routeAuthority: nextDeployment.routing?.factoryRouteAuthority || null,
    treasuryRouter: nextDeployment.routing?.factoryFeeRecipient || null,
    permanentLpLocker: nextDeployment.contracts?.PermanentLpLocker || null,
    notes: rawEnv("FACTORY_ONLY_NOTES") || "factory-only replacement",
  });

  return {
    activeFactory: newFactory,
    activeGeneration: newGeneration,
    factories,
  };
}

async function main() {
  refuseBnbFactoryBroadcastIfSourceHeadIsNotLive();
  const { file: baseFile, deployment: baseDeployment } = loadBaseDeployment();
  const contracts = resolveContracts(baseDeployment);
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const net = await ethers.provider.getNetwork();
  const deploymentBlock = await ethers.provider.getBlockNumber();

  const oldFactory = requireAddress("Base LaunchFactory", contracts.LaunchFactory);
  const launchRouter = requireAddress(
    "Launch router",
    optionalAddress("FACTORY_ONLY_TOPAZ_ROUTER", rawEnv("FACTORY_ONLY_TOPAZ_ROUTER")) ||
      baseDeployment.routing?.topazRouter ||
      baseDeployment.router ||
      baseDeployment.topazRouterAdapter ||
      baseDeployment.topazRouter,
  );
  const treasuryRouter = requireAddress("TreasuryRouter", contracts.TreasuryRouter);
  const campaignImplementation = requireAddress("LaunchCampaignImplementation", contracts.LaunchCampaignImplementation);
  const graduationOracle = requireAddress("GraduationOracle", contracts.GraduationOracle);
  const creatorRegistry = requireAddress("CreatorRegistry", contracts.CreatorRegistry);
  const riskRegistry = requireAddress("RiskRegistry", contracts.RiskRegistry);
  const routeAuthority = requireAddress(
    "Route authority",
    rawEnv("ROUTE_AUTHORITY_ADDRESS") || baseDeployment.routing?.factoryRouteAuthority || baseDeployment.routeAuthority || "",
  );
  const tradeRouteProfile = numberEnv("PHASE1_TRADE_ROUTE_PROFILE", Number(baseDeployment.routing?.factoryTradeRouteProfile ?? 1));
  const finalizeRouteProfile = numberEnv("PHASE1_FINALIZE_ROUTE_PROFILE", Number(baseDeployment.routing?.factoryFinalizeRouteProfile ?? 1));
  const protocolFeeBps = bigintEnv("PROTOCOL_FEE_BPS", BigInt(baseDeployment.protocolFeeBps ?? 200));
  const enableLive = boolEnv("FACTORY_ONLY_ENABLE_LIVE", true);
  const wireLpRouter = boolEnv("FACTORY_ONLY_WIRE_LP_ROUTER", false);

  console.log(`[factory-only] base deployment: ${baseFile}`);
  console.log(`[factory-only] network=${network.name} chainId=${net.chainId.toString()}`);
  console.log(`[factory-only] deployer=${deployerAddress}`);
  console.log(`[factory-only] oldFactory=${oldFactory}`);
  console.log(`[factory-only] launchRouter=${launchRouter}`);
  console.log(`[factory-only] treasuryRouter=${treasuryRouter}`);
  console.log(`[factory-only] campaignImplementation=${campaignImplementation}`);
  console.log(`[factory-only] graduationOracle=${graduationOracle}`);
  console.log(`[factory-only] creatorRegistry=${creatorRegistry}`);
  console.log(`[factory-only] riskRegistry=${riskRegistry}`);
  console.log(`[factory-only] routeAuthority=${routeAuthority}`);
  console.log(`[factory-only] routeProfiles trade=${tradeRouteProfile} finalize=${finalizeRouteProfile}`);
  console.log(`[factory-only] protocolFeeBps=${protocolFeeBps.toString()}`);
  console.log(`[factory-only] enableLive=${enableLive}`);
  console.log(`[factory-only] wireLpRouter=${wireLpRouter}`);

  await assertCode("Old LaunchFactory", oldFactory);
  await assertCode("Launch router", launchRouter);
  await assertCode("TreasuryRouter", treasuryRouter);
  await assertCode("LaunchCampaignImplementation", campaignImplementation);
  await assertCode("GraduationOracle", graduationOracle);
  await assertCode("CreatorRegistry", creatorRegistry);
  await assertCode("RiskRegistry", riskRegistry);

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(launchRouter, treasuryRouter, campaignImplementation, graduationOracle);
  await factory.waitForDeployment();
  const newFactory = await factory.getAddress();
  const newLocker = await factory.permanentLpLocker();
  console.log(`[factory-only] LaunchFactory deployed: ${newFactory}`);
  console.log(`[factory-only] PermanentLpLocker created: ${newLocker}`);

  const currentCreatorRegistry = await factory.creatorRegistry();
  const currentRiskRegistry = await factory.riskRegistry();
  if (currentCreatorRegistry.toLowerCase() !== creatorRegistry.toLowerCase() || currentRiskRegistry.toLowerCase() !== riskRegistry.toLowerCase()) {
    const tx = await factory.setRegistries(creatorRegistry, riskRegistry);
    console.log(`[factory-only] setRegistries: submitted ${tx.hash}`);
    await tx.wait();
    console.log(`[factory-only] setRegistries: creator=${creatorRegistry} risk=${riskRegistry}`);
  } else {
    console.log("[factory-only] setRegistries: already set");
  }

  await setIfDifferent(
    "setRouteAuthority",
    async () => (await factory.routeAuthority()).toString(),
    routeAuthority,
    () => factory.setRouteAuthority(routeAuthority),
  );

  if ((await factory.tradeRouteProfile()) !== BigInt(tradeRouteProfile) || (await factory.finalizeRouteProfile()) !== BigInt(finalizeRouteProfile)) {
    const tx = await factory.setRouteProfiles(tradeRouteProfile, finalizeRouteProfile);
    console.log(`[factory-only] setRouteProfiles: submitted ${tx.hash}`);
    await tx.wait();
  } else {
    console.log("[factory-only] setRouteProfiles: already set");
  }

  await setIfDifferent(
    "setProtocolFee",
    async () => (await factory.protocolFeeBps()).toString(),
    protocolFeeBps.toString(),
    () => factory.setProtocolFee(protocolFeeBps),
  );

  const postDeployActions: string[] = [];
  const creatorRegistryOwnedByDeployer = await signerOwns(creatorRegistry);
  if (creatorRegistryOwnedByDeployer) {
    const registry = new ethers.Contract(creatorRegistry, ["function setLaunchRecorder(address,bool)", "function launchRecorders(address) view returns (bool)"], deployer);
    const isRecorder = await registry.launchRecorders(newFactory);
    if (!isRecorder) {
      const tx = await registry.setLaunchRecorder(newFactory, true);
      console.log(`[factory-only] CreatorRegistry.setLaunchRecorder: submitted ${tx.hash}`);
      await tx.wait();
    } else {
      console.log("[factory-only] CreatorRegistry.setLaunchRecorder: already true");
    }
  } else {
    postDeployActions.push(`CreatorRegistry.setLaunchRecorder(${newFactory}, true)`);
    console.warn("[factory-only] CreatorRegistry owner is not deployer; launch recorder action queued.");
  }

  if (enableLive && !(await factory.live())) {
    const tx = await factory.enableLive();
    console.log(`[factory-only] enableLive: submitted ${tx.hash}`);
    await tx.wait();
  }

  const router = new ethers.Contract(
    treasuryRouter,
    [
      "function permanentLpLocker() view returns (address)",
      "function setPermanentLpLocker(address)",
      "function authorizedLpLocker(address) view returns (bool)",
      "function setAuthorizedLpLocker(address,bool)",
      "function setPrimaryLpLocker(address)",
    ],
    deployer,
  );

  if (wireLpRouter) {
    if (await supportsAuthorizedLpLocker(router, newLocker)) {
      const authorized = await router.authorizedLpLocker(newLocker);
      if (!authorized) {
        const tx = await router.setAuthorizedLpLocker(newLocker, true);
        console.log(`[factory-only] TreasuryRouterV2.setAuthorizedLpLocker: submitted ${tx.hash}`);
        await tx.wait();
      }
      const currentPrimary = await router.permanentLpLocker();
      if (currentPrimary.toLowerCase() !== newLocker.toLowerCase()) {
        const tx = await router.setPrimaryLpLocker(newLocker);
        console.log(`[factory-only] TreasuryRouterV2.setPrimaryLpLocker: submitted ${tx.hash}`);
        await tx.wait();
      }
    } else {
      const currentLocker = await router.permanentLpLocker();
      if (currentLocker.toLowerCase() !== newLocker.toLowerCase()) {
        const tx = await router.setPermanentLpLocker(newLocker);
        console.log(`[factory-only] TreasuryRouter.setPermanentLpLocker: submitted ${tx.hash}`);
        await tx.wait();
      }
    }
  } else {
    postDeployActions.push(
      "Optional LP-fee routing write skipped. For TreasuryRouterV1 run only when ready: TreasuryRouter.setPermanentLpLocker(newLocker).",
    );
  }

  const nextDeployment = {
    ...baseDeployment,
    network: network.name,
    chainId: Number(net.chainId),
    deploymentBlock,
    factoryReplacement: {
      replacedAt: new Date().toISOString(),
      baseDeployment: baseFile,
      oldFactory,
      oldPermanentLpLocker: contracts.PermanentLpLocker || null,
    },
    deployer: deployerAddress,
    router: launchRouter,
    topazRouter: launchRouter,
    productionTopazRouter: baseDeployment.productionTopazRouter || baseDeployment.topazInfrastructure?.contracts?.Router || baseDeployment.topazRouter || launchRouter,
    contracts: {
      ...(baseDeployment.contracts || {}),
      LaunchFactory: newFactory,
      PermanentLpLocker: newLocker,
    },
    routing: {
      ...(baseDeployment.routing || {}),
      factoryFeeRecipient: treasuryRouter,
      factoryTradeRouteProfile: tradeRouteProfile,
      factoryFinalizeRouteProfile: finalizeRouteProfile,
      factoryRouteAuthority: routeAuthority,
      campaignImplementation,
      graduationOracle,
      topazRouter: launchRouter,
      productionTopazRouter: baseDeployment.productionTopazRouter || baseDeployment.routing?.productionTopazRouter || baseDeployment.topazInfrastructure?.contracts?.Router || baseDeployment.topazRouter || launchRouter,
      permanentLpLocker: newLocker,
      permanentLpLockerAuthorized: wireLpRouter ? true : baseDeployment.routing?.permanentLpLockerAuthorized ?? null,
    },
    protocolFeeBps: protocolFeeBps.toString(),
    postDeployActions,
  };
  nextDeployment.factoryRegistry = buildFactoryRegistry(baseDeployment, nextDeployment, oldFactory, newFactory);

  const outBase = path.join(__dirname, "..", "deployments", `${network.name}.factory-only.json`);
  const outFrontend = path.join(__dirname, "..", "deployments", `${network.name}.factory-only.frontend.env`);
  const outManifest = path.join(__dirname, "..", "deployments", `${network.name}.factory-only.indexer-manifest.json`);
  writeJson(outBase, nextDeployment);
  writeFrontendEnv(nextDeployment, outFrontend, outBase);
  writeIndexerManifest(nextDeployment, outManifest, outBase);

  console.log(`\n[factory-only] Wrote deployment: ${outBase}`);
  console.log(`[factory-only] Wrote frontend env: ${outFrontend}`);
  console.log(`[factory-only] Wrote indexer manifest: ${outManifest}`);
  console.log("\n[factory-only] New env values:");
  console.log(`VITE_FACTORY_ADDRESS_${Number(net.chainId)}=${newFactory}`);
  console.log(`FACTORY_ADDRESS_${Number(net.chainId)}=${newFactory}`);
  console.log(`VITE_PERMANENT_LP_LOCKER_ADDRESS_${Number(net.chainId)}=${newLocker}`);
  console.log(`FACTORY_START_BLOCK_${Number(net.chainId)}=${deploymentBlock}`);
  console.log("\n[factory-only] BscScan verify:");
  console.log(`npx hardhat verify --network ${network.name} ${newFactory} ${launchRouter} ${treasuryRouter} ${campaignImplementation} ${graduationOracle}`);
  console.log(`npx hardhat verify --network ${network.name} ${newLocker} ${newFactory}`);

  if (postDeployActions.length) {
    console.log("\n[factory-only] Pending/optional actions:");
    for (const action of postDeployActions) console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

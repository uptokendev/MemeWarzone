/**
 * Deploy a second LaunchFactory for dual-factory testing on BSC Testnet (97).
 *
 * Clones config/wiring from the KEEP factory (default: 0xA2B19f… creator-arm-cooldown),
 * deploys a fresh factory + PermanentLpLocker, authorizes recorder/locker, enables live
 * on the new factory, and optionally pauses *creation* on KEEP (trading stays open).
 *
 * Writes:
 *   deployments/bscTestnet.dual-test-factory.json
 *   deployments/bscTestnet.dual-test-factory.frontend.env
 *   deployments/bscTestnet.dual-test-factory.railway.env
 *
 * Usage:
 *   npx hardhat run scripts/deploy-dual-test-factory.ts --network bscTestnet
 *
 * Env (optional):
 *   KEEP_FACTORY_ADDRESS=0xA2B19f194826b6D930D18F3fBCad662FaDC9459E
 *   KEEP_FACTORY_START_BLOCK=122024169
 *   EXECUTE_DEPENDENCIES=true          # setLaunchRecorder + authorize locker (default true)
 *   ENABLE_NEW_LIVE=true               # enableLive on new factory (default true)
 *   PAUSE_KEEP_CREATION=true           # pause create on keep factory only (default true)
 *   ROUTE_AUTHORITY_ADDRESS=0x...      # override if needed
 */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { refuseBnbFactoryBroadcastIfSourceHeadIsNotLive } from "./lib/bnbLiveGenerationGuard";

const TESTNET_CHAIN_ID = 97n;
const DEFAULT_KEEP_FACTORY = "0xA2B19f194826b6D930D18F3fBCad662FaDC9459E";
const DEFAULT_KEEP_START_BLOCK = 122024169;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function rawEnv(name: string) {
  return String(process.env[name] || "").trim();
}

function boolEnv(name: string, fallback: boolean) {
  const raw = rawEnv(name).toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
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

function writeText(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function writeJson(file: string, value: unknown) {
  writeText(file, JSON.stringify(value, null, 2));
}

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  console.log(`[dual-test-factory] submitted ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed.`);
  return receipt;
}

async function main() {
  refuseBnbFactoryBroadcastIfSourceHeadIsNotLive();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Dual-test factory deploy is restricted to BSC Testnet 97; got chain ${net.chainId}`);
  }

  const keepFactoryAddress = requireAddress(
    "KEEP_FACTORY_ADDRESS",
    rawEnv("KEEP_FACTORY_ADDRESS") || DEFAULT_KEEP_FACTORY,
  );
  const keepStartBlock = Number(rawEnv("KEEP_FACTORY_START_BLOCK") || DEFAULT_KEEP_START_BLOCK);
  if (!Number.isInteger(keepStartBlock) || keepStartBlock <= 0) {
    throw new Error("KEEP_FACTORY_START_BLOCK must be a positive integer");
  }

  const executeDependencies = boolEnv("EXECUTE_DEPENDENCIES", true);
  const enableNewLive = boolEnv("ENABLE_NEW_LIVE", true);
  const pauseKeepCreation = boolEnv("PAUSE_KEEP_CREATION", true);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = ethers.getAddress(await deployer.getAddress());

  console.log(`[dual-test-factory] network=${network.name} chainId=${net.chainId}`);
  console.log(`[dual-test-factory] deployer=${deployerAddress}`);
  console.log(`[dual-test-factory] keepFactory=${keepFactoryAddress} startBlock=${keepStartBlock}`);
  console.log(
    `[dual-test-factory] executeDependencies=${executeDependencies} enableNewLive=${enableNewLive} pauseKeepCreation=${pauseKeepCreation}`,
  );

  await assertCode("Keep LaunchFactory", keepFactoryAddress);
  const keep = await ethers.getContractAt("LaunchFactory", keepFactoryAddress, deployer);

  const router = requireAddress("Topaz router adapter", await keep.router());
  const treasuryRouter = requireAddress("TreasuryRouterV2", await keep.feeRecipient());
  const campaignImplementation = requireAddress(
    "LaunchCampaign implementation",
    await keep.campaignImplementation(),
  );
  const graduationOracle = requireAddress("GraduationOracle", await keep.graduationOracle());
  const creatorRegistry = requireAddress("CreatorRegistry", await keep.creatorRegistry());
  const riskRegistry = requireAddress("RiskRegistry", await keep.riskRegistry());
  const routeAuthority = requireAddress(
    "Route authority",
    rawEnv("ROUTE_AUTHORITY_ADDRESS") || (await keep.routeAuthority()),
  );
  const keepLocker = requireAddress("Keep PermanentLpLocker", await keep.permanentLpLocker());

  for (const [label, address] of [
    ["Topaz router adapter", router],
    ["TreasuryRouterV2", treasuryRouter],
    ["LaunchCampaign implementation", campaignImplementation],
    ["GraduationOracle", graduationOracle],
    ["CreatorRegistry", creatorRegistry],
    ["RiskRegistry", riskRegistry],
    ["Keep locker", keepLocker],
  ] as Array<[string, string]>) {
    await assertCode(label, address);
  }

  const oldConfig = await keep.config();
  const oldProtection = await keep.launchProtectionConfig();
  const tradeRouteProfile = Number(await keep.tradeRouteProfile());
  const finalizeRouteProfile = Number(await keep.finalizeRouteProfile());
  const protocolFeeBps = BigInt(await keep.protocolFeeBps());

  if (Number(await keep.FACTORY_GENERATION()) !== 3) {
    throw new Error(`Keep factory generation is ${await keep.FACTORY_GENERATION()}, expected 3`);
  }
  if (Number(await keep.CAMPAIGN_GENERATION()) !== 2) {
    throw new Error(`Keep campaign generation is ${await keep.CAMPAIGN_GENERATION()}, expected 2`);
  }

  // --- Deploy new factory (same constructor args as keep) ---
  const Factory = await ethers.getContractFactory("LaunchFactory", deployer);
  const replacement = await Factory.deploy(router, treasuryRouter, campaignImplementation, graduationOracle);
  const deploymentTx = replacement.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction missing");
  const deploymentReceipt = await deploymentTx.wait(2);
  if (!deploymentReceipt || deploymentReceipt.status !== 1) throw new Error("LaunchFactory deployment failed");

  const newFactoryAddress = ethers.getAddress(await replacement.getAddress());
  const newLocker = ethers.getAddress(await replacement.permanentLpLocker());
  const newStartBlock = Number(deploymentReceipt.blockNumber);
  await assertCode("New LaunchFactory", newFactoryAddress);
  await assertCode("New PermanentLpLocker", newLocker);

  console.log(`[dual-test-factory] newFactory=${newFactoryAddress}`);
  console.log(`[dual-test-factory] newLocker=${newLocker}`);
  console.log(`[dual-test-factory] newStartBlock=${newStartBlock}`);

  // --- Clone configuration ---
  await waitTx(
    replacement.setConfig({
      totalSupply: oldConfig.totalSupply,
      curveBps: oldConfig.curveBps,
      liquidityTokenBps: oldConfig.liquidityTokenBps,
      basePrice: oldConfig.basePrice,
      priceSlope: oldConfig.priceSlope,
      graduationTarget: oldConfig.graduationTarget,
      liquidityBps: oldConfig.liquidityBps,
    }),
    "setConfig",
  );
  await waitTx(replacement.setRegistries(creatorRegistry, riskRegistry), "setRegistries");
  await waitTx(replacement.setRouteAuthority(routeAuthority), "setRouteAuthority");
  await waitTx(replacement.setRouteProfiles(tradeRouteProfile, finalizeRouteProfile), "setRouteProfiles");
  if (BigInt(await replacement.protocolFeeBps()) !== protocolFeeBps) {
    await waitTx(replacement.setProtocolFee(protocolFeeBps), "setProtocolFee");
  }
  if (BigInt(oldProtection.blocks_) || BigInt(oldProtection.maxBuyWei) || BigInt(oldProtection.maxWalletWei)) {
    await waitTx(
      replacement.setLaunchProtectionConfig(
        oldProtection.blocks_,
        oldProtection.maxBuyWei,
        oldProtection.maxWalletWei,
      ),
      "setLaunchProtectionConfig",
    );
  }
  await waitTx(replacement.lockSecurityDefaults(), "lockSecurityDefaults");

  if (Number(await replacement.FACTORY_GENERATION()) !== 3) throw new Error("New factory generation is not 3");
  if (Number(await replacement.CAMPAIGN_GENERATION()) !== 2) throw new Error("New campaign generation is not 2");
  if (BigInt(await replacement.campaignsCount()) !== 0n) throw new Error("New factory already has campaigns");

  // --- Shared infra: recorder + locker ---
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
      "function setAuthorizedLpLocker(address,bool)",
    ],
    deployer,
  );

  const dependencyTxs: Record<string, string> = {};
  if (executeDependencies) {
    const owner = String(await registry.owner()).toLowerCase();
    const admin = String(await treasury.admin()).toLowerCase();
    if (owner !== deployerAddress.toLowerCase()) {
      throw new Error(`EXECUTE_DEPENDENCIES requires deployer to own CreatorRegistry (owner=${owner})`);
    }
    if (admin !== deployerAddress.toLowerCase()) {
      throw new Error(`EXECUTE_DEPENDENCIES requires deployer to admin TreasuryRouterV2 (admin=${admin})`);
    }
    // Keep factory must remain a recorder
    if (!(await registry.launchRecorder(keepFactoryAddress))) {
      const receipt = await waitTx(
        registry.setLaunchRecorder(keepFactoryAddress, true),
        "CreatorRegistry.setLaunchRecorder(keep)",
      );
      dependencyTxs.keepRecorder = receipt.hash;
    }
    if (!(await registry.launchRecorder(newFactoryAddress))) {
      const receipt = await waitTx(
        registry.setLaunchRecorder(newFactoryAddress, true),
        "CreatorRegistry.setLaunchRecorder(new)",
      );
      dependencyTxs.newRecorder = receipt.hash;
    }
    if (!(await treasury.authorizedLpLocker(keepLocker))) {
      const receipt = await waitTx(
        treasury.setAuthorizedLpLocker(keepLocker, true),
        "TreasuryRouterV2.setAuthorizedLpLocker(keep)",
      );
      dependencyTxs.keepLocker = receipt.hash;
    }
    if (!(await treasury.authorizedLpLocker(newLocker))) {
      const receipt = await waitTx(
        treasury.setAuthorizedLpLocker(newLocker, true),
        "TreasuryRouterV2.setAuthorizedLpLocker(new)",
      );
      dependencyTxs.newLocker = receipt.hash;
    }
  } else {
    console.warn(
      "[dual-test-factory] EXECUTE_DEPENDENCIES=false — you must authorize recorder + locker manually before enableLive",
    );
  }

  // --- Activate new; optionally pause creation on keep ---
  const activationTxs: Record<string, string> = {};
  if (enableNewLive) {
    if (!(await registry.launchRecorder(newFactoryAddress))) {
      throw new Error("New factory is not a CreatorRegistry launch recorder; set EXECUTE_DEPENDENCIES=true");
    }
    if (!(await treasury.authorizedLpLocker(newLocker))) {
      throw new Error("New locker is not authorized; set EXECUTE_DEPENDENCIES=true");
    }
    if (!(await replacement.live())) {
      const receipt = await waitTx(replacement.enableLive(), "enableLive(new)");
      activationTxs.enableLive = receipt.hash;
    }
    if (await replacement.createPaused()) {
      throw new Error("New factory creation is paused after enableLive");
    }
  }

  if (pauseKeepCreation) {
    if ((await keep.owner()).toLowerCase() !== deployerAddress.toLowerCase()) {
      throw new Error("PAUSE_KEEP_CREATION requires deployer ownership of keep factory");
    }
    if (!(await keep.createPaused())) {
      const receipt = await waitTx(keep.setCreatePaused(true), "setCreatePaused(keep,true)");
      activationTxs.pauseKeepCreation = receipt.hash;
    }
    // Never global-pause keep — existing campaigns must remain tradable
    if (await keep.globalPaused()) {
      throw new Error("Keep factory is globally paused; unpause before dual-test");
    }
  }

  const supportedCsv = `${keepFactoryAddress},${newFactoryAddress}`;
  const startBlocksCsv = `${keepStartBlock},${newStartBlock}`;

  const frontendEnv = [
    `# Dual-test factory env — Netlify (chain 97)`,
    `VITE_FACTORY_ADDRESS_97=${newFactoryAddress}`,
    `VITE_SUPPORTED_FACTORY_ADDRESSES_97=${supportedCsv}`,
    `VITE_SUPPORTED_FACTORY_START_BLOCKS_97=${startBlocksCsv}`,
    `VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_97=${campaignImplementation}`,
    `VITE_CREATOR_REGISTRY_ADDRESS_97=${creatorRegistry}`,
    `VITE_RISK_REGISTRY_ADDRESS_97=${riskRegistry}`,
    `VITE_GRADUATION_ORACLE_ADDRESS_97=${graduationOracle}`,
    `VITE_TREASURY_ROUTER_ADDRESS_97=${treasuryRouter}`,
    `VITE_PERMANENT_LP_LOCKER_ADDRESS_97=${newLocker}`,
    `VITE_TOPAZ_ROUTER_ADAPTER_ADDRESS_97=${router}`,
    `VITE_LAUNCH_ROUTER_ADDRESS_97=${router}`,
    `# Route authority is the API signer; keep existing key that matches:`,
    `# ${routeAuthority}`,
    "",
  ].join("\n");

  const railwayEnv = [
    `# Dual-test factory env — Railway realtime-indexer (chain 97)`,
    `FACTORY_ADDRESS_97=${newFactoryAddress}`,
    `SUPPORTED_FACTORY_ADDRESSES_97=${supportedCsv}`,
    `FACTORY_START_BLOCK_97=${newStartBlock}`,
    `SUPPORTED_FACTORY_START_BLOCKS_97=${startBlocksCsv}`,
    `# Keep paid RPC + Topaz flags as you already run them`,
    "",
  ].join("\n");

  const root = path.resolve(__dirname, "..");
  const manifestFile = path.join(root, "deployments", "bscTestnet.dual-test-factory.json");
  const frontendEnvFile = path.join(root, "deployments", "bscTestnet.dual-test-factory.frontend.env");
  const railwayEnvFile = path.join(root, "deployments", "bscTestnet.dual-test-factory.railway.env");

  writeJson(manifestFile, {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    purpose: "dual-factory test: keep A2B19f tradable, create on new factory",
    keepFactory: {
      address: keepFactoryAddress,
      locker: keepLocker,
      startBlock: keepStartBlock,
      creationPaused: pauseKeepCreation,
      supportEnabled: true,
    },
    newFactory: {
      address: newFactoryAddress,
      locker: newLocker,
      startBlock: newStartBlock,
      deploymentTxHash: deploymentReceipt.hash,
      live: Boolean(await replacement.live()),
      creationEnabled: Boolean(await replacement.live()) && !(await replacement.createPaused()),
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
    dependencyTransactions: dependencyTxs,
    activationTransactions: activationTxs,
    factoryGeneration: 3,
    campaignGeneration: 2,
    contracts: {
      LaunchFactory: newFactoryAddress,
      LaunchCampaignImplementation: campaignImplementation,
      PermanentLpLocker: newLocker,
      TreasuryRouter: treasuryRouter,
      CreatorRegistry: creatorRegistry,
      RiskRegistry: riskRegistry,
      GraduationOracle: graduationOracle,
    },
    env: {
      supportedFactories: supportedCsv,
      startBlocks: startBlocksCsv,
    },
  });
  writeText(frontendEnvFile, frontendEnv);
  writeText(railwayEnvFile, railwayEnv);

  console.log("\n=== dual-test-factory DONE ===");
  console.log(`manifest: ${manifestFile}`);
  console.log(`frontend env: ${frontendEnvFile}`);
  console.log(`railway env:  ${railwayEnvFile}`);
  console.log("\nNext:");
  console.log("1) Paste railway env into Railway indexer + redeploy");
  console.log("2) Paste frontend env into Netlify + redeploy");
  console.log("3) Create a token on NEW factory → trade + chart");
  console.log("4) Open a KEEP (A2B19f) token → still trade + chart");
  console.log("5) Confirm create is disabled on KEEP if PAUSE_KEEP_CREATION=true");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * Clean-slate BSC testnet factory: deploy ONE new LaunchFactory for creation,
 * pause creation on the previous factory, and write env that lists ONLY the new
 * factory (no dual inventory).
 *
 * Clones config/wiring from TEMPLATE_FACTORY (default: current dual-test creation
 * factory 0x8d4937…), deploys fresh factory + PermanentLpLocker, authorizes
 * recorder/locker, enableLive.
 *
 * Writes:
 *   deployments/bscTestnet.clean-slate-factory.json
 *   deployments/bscTestnet.clean-slate-factory.frontend.env
 *   deployments/bscTestnet.clean-slate-factory.railway.env
 *
 * Usage:
 *   npx hardhat run scripts/deploy-clean-slate-factory.ts --network bscTestnet
 *
 * Env (optional):
 *   TEMPLATE_FACTORY_ADDRESS=0x8d4937D3BEe8A750411c0a24f888C0088754D3eD
 *   PAUSE_PREVIOUS_FACTORIES=true  (default true) pause create on 8d4937 + A2B19f
 *   EXECUTE_DEPENDENCIES=true
 *   ENABLE_NEW_LIVE=true
 *   ROUTE_AUTHORITY_ADDRESS=0x...
 */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { refuseBnbFactoryBroadcastIfSourceHeadIsNotLive } from "./lib/bnbLiveGenerationGuard";

const TESTNET_CHAIN_ID = 97n;
const DEFAULT_TEMPLATE = "0x8d4937D3BEe8A750411c0a24f888C0088754D3eD";
const PREVIOUS_FACTORIES = [
  "0xA2B19f194826b6D930D18F3fBCad662FaDC9459E",
  "0x8d4937D3BEe8A750411c0a24f888C0088754D3eD",
];
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
  console.log(`[clean-slate-factory] submitted ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed.`);
  return receipt;
}

async function main() {
  refuseBnbFactoryBroadcastIfSourceHeadIsNotLive();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Clean-slate factory deploy is restricted to BSC Testnet 97; got chain ${net.chainId}`);
  }

  const templateFactoryAddress = requireAddress(
    "TEMPLATE_FACTORY_ADDRESS",
    rawEnv("TEMPLATE_FACTORY_ADDRESS") || DEFAULT_TEMPLATE,
  );
  const executeDependencies = boolEnv("EXECUTE_DEPENDENCIES", true);
  const enableNewLive = boolEnv("ENABLE_NEW_LIVE", true);
  const pausePrevious = boolEnv("PAUSE_PREVIOUS_FACTORIES", true);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = ethers.getAddress(await deployer.getAddress());

  console.log(`[clean-slate-factory] network=${network.name} chainId=${net.chainId}`);
  console.log(`[clean-slate-factory] deployer=${deployerAddress}`);
  console.log(`[clean-slate-factory] templateFactory=${templateFactoryAddress}`);
  console.log(
    `[clean-slate-factory] executeDependencies=${executeDependencies} enableNewLive=${enableNewLive} pausePrevious=${pausePrevious}`,
  );

  await assertCode("Template LaunchFactory", templateFactoryAddress);
  const template = await ethers.getContractAt("LaunchFactory", templateFactoryAddress, deployer);

  const router = requireAddress("Topaz router adapter", await template.router());
  const treasuryRouter = requireAddress("TreasuryRouterV2", await template.feeRecipient());
  const campaignImplementation = requireAddress(
    "LaunchCampaign implementation",
    await template.campaignImplementation(),
  );
  const graduationOracle = requireAddress("GraduationOracle", await template.graduationOracle());
  const creatorRegistry = requireAddress("CreatorRegistry", await template.creatorRegistry());
  const riskRegistry = requireAddress("RiskRegistry", await template.riskRegistry());
  const routeAuthority = requireAddress(
    "Route authority",
    rawEnv("ROUTE_AUTHORITY_ADDRESS") || (await template.routeAuthority()),
  );

  for (const [label, address] of [
    ["Topaz router adapter", router],
    ["TreasuryRouterV2", treasuryRouter],
    ["LaunchCampaign implementation", campaignImplementation],
    ["GraduationOracle", graduationOracle],
    ["CreatorRegistry", creatorRegistry],
    ["RiskRegistry", riskRegistry],
  ] as Array<[string, string]>) {
    await assertCode(label, address);
  }

  const oldConfig = await template.config();
  const oldProtection = await template.launchProtectionConfig();
  const tradeRouteProfile = Number(await template.tradeRouteProfile());
  const finalizeRouteProfile = Number(await template.finalizeRouteProfile());
  const protocolFeeBps = BigInt(await template.protocolFeeBps());

  if (Number(await template.FACTORY_GENERATION()) !== 3) {
    throw new Error(`Template factory generation is ${await template.FACTORY_GENERATION()}, expected 3`);
  }
  if (Number(await template.CAMPAIGN_GENERATION()) !== 2) {
    throw new Error(`Template campaign generation is ${await template.CAMPAIGN_GENERATION()}, expected 2`);
  }

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

  console.log(`[clean-slate-factory] newFactory=${newFactoryAddress}`);
  console.log(`[clean-slate-factory] newLocker=${newLocker}`);
  console.log(`[clean-slate-factory] newStartBlock=${newStartBlock}`);

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
    if (!(await registry.launchRecorder(newFactoryAddress))) {
      const receipt = await waitTx(
        registry.setLaunchRecorder(newFactoryAddress, true),
        "CreatorRegistry.setLaunchRecorder(new)",
      );
      dependencyTxs.newRecorder = receipt.hash;
    }
    if (!(await treasury.authorizedLpLocker(newLocker))) {
      const receipt = await waitTx(
        treasury.setAuthorizedLpLocker(newLocker, true),
        "TreasuryRouterV2.setAuthorizedLpLocker(new)",
      );
      dependencyTxs.newLocker = receipt.hash;
    }
  } else {
    console.warn("[clean-slate-factory] EXECUTE_DEPENDENCIES=false — authorize recorder + locker manually");
  }

  const activationTxs: Record<string, string> = {};
  if (enableNewLive) {
    // Re-read after dependency txs — some RPCs lag one block behind wait().
    for (let i = 0; i < 5; i++) {
      const rec = await registry.launchRecorder(newFactoryAddress);
      const lock = await treasury.authorizedLpLocker(newLocker);
      if (rec && lock) break;
      await new Promise((r) => setTimeout(r, 1500));
      if (i === 4) {
        throw new Error(
          `New factory not fully authorized after deps (recorder=${rec} locker=${lock}); set EXECUTE_DEPENDENCIES=true and retry`,
        );
      }
    }
    if (!(await replacement.live())) {
      const receipt = await waitTx(replacement.enableLive(), "enableLive(new)");
      activationTxs.enableLive = receipt.hash;
    }
    if (await replacement.createPaused()) {
      throw new Error("New factory creation is paused after enableLive");
    }
  }

  if (pausePrevious) {
    for (const prev of PREVIOUS_FACTORIES) {
      try {
        const code = await ethers.provider.getCode(prev);
        if (!code || code === "0x") continue;
        const fac = await ethers.getContractAt("LaunchFactory", prev, deployer);
        const owner = String(await fac.owner()).toLowerCase();
        if (owner !== deployerAddress.toLowerCase()) {
          console.warn(`[clean-slate-factory] skip pause ${prev}: not owner`);
          continue;
        }
        if (!(await fac.createPaused())) {
          const receipt = await waitTx(fac.setCreatePaused(true), `setCreatePaused(${prev})`);
          activationTxs[`pause_${prev.slice(0, 10)}`] = receipt.hash;
        }
      } catch (e: any) {
        console.warn(`[clean-slate-factory] pause previous failed ${prev}: ${e?.message || e}`);
      }
    }
  }

  const frontendEnv = [
    `# Clean-slate single factory (chain 97) — generated ${new Date().toISOString()}`,
    `VITE_FACTORY_ADDRESS_97=${newFactoryAddress}`,
    `VITE_SUPPORTED_FACTORY_ADDRESSES_97=${newFactoryAddress}`,
    `VITE_SUPPORTED_FACTORY_START_BLOCKS_97=${newStartBlock}`,
    `VITE_SCHEDULED_FACTORY_ADDRESS_97=${newFactoryAddress}`,
    `FACTORY_ADDRESS_97=${newFactoryAddress}`,
    `SUPPORTED_FACTORY_ADDRESSES_97=${newFactoryAddress}`,
    `SUPPORTED_FACTORY_START_BLOCKS_97=${newStartBlock}`,
    `FACTORY_START_BLOCK_97=${newStartBlock}`,
    "",
  ].join("\n");

  const railwayEnv = [
    `# Clean-slate Railway / indexer (chain 97) — generated ${new Date().toISOString()}`,
    `FACTORY_ADDRESS_97=${newFactoryAddress}`,
    `SUPPORTED_FACTORY_ADDRESSES_97=${newFactoryAddress}`,
    `SUPPORTED_FACTORY_START_BLOCKS_97=${newStartBlock}`,
    `FACTORY_START_BLOCK_97=${newStartBlock}`,
    `INDEXER_NORMAL_SCOPE=campaigns`,
    "",
  ].join("\n");

  const out = {
    network: "bscTestnet",
    chainId: 97,
    deployedAt: new Date().toISOString(),
    purpose: "clean-slate single factory — no dual inventory",
    templateFactory: templateFactoryAddress,
    previousFactoriesPaused: pausePrevious ? PREVIOUS_FACTORIES : [],
    newFactory: {
      address: newFactoryAddress,
      locker: newLocker,
      startBlock: newStartBlock,
      deploymentTxHash: deploymentTx.hash,
      live: enableNewLive,
      creationEnabled: true,
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
      supportedFactories: newFactoryAddress,
      startBlocks: String(newStartBlock),
    },
  };

  const base = path.join(__dirname, "..", "deployments");
  writeJson(path.join(base, "bscTestnet.clean-slate-factory.json"), out);
  writeText(path.join(base, "bscTestnet.clean-slate-factory.frontend.env"), frontendEnv);
  writeText(path.join(base, "bscTestnet.clean-slate-factory.railway.env"), railwayEnv);

  console.log("[clean-slate-factory] wrote deployments/bscTestnet.clean-slate-factory.json");
  console.log("[clean-slate-factory] wrote deployments/bscTestnet.clean-slate-factory.frontend.env");
  console.log("[clean-slate-factory] wrote deployments/bscTestnet.clean-slate-factory.railway.env");
  console.log("[clean-slate-factory] DONE — set Railway + frontend env to the new factory only.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const {
  assertArenaV2DeploymentTarget,
  envNamesFor,
  defaultArenaV2DeploymentFile,
} = require("./lib/arenaV2DeploymentPolicy.cjs");

/**
 * Deploys the existing EVM Arena competition V2 money path without touching
 * historical V1 or creating a chain-specific contract generation.
 *
 * Founder-locked V2 economics:
 *   entry/buy-in: 75% prize / 20% Post-Grad League / 5% protocol
 *   Battle/Tournament Boost: 90% prize / 10% protocol
 *   Post-Grad League V2: 60% Monthly MWL / 40% Quarterly reserve
 *
 * Permitted deployment targets:
 *   bscMainnet       / 56     (preserved existing behavior)
 *   bscTestnet       / 97
 *   robinhoodTestnet / 46630
 *   hardhat/localhost / 31337 only with ARENA_V2_ALLOW_LOCAL=1
 *
 * Robinhood mainnet 4663 is intentionally NOT activated by T2-PRE.
 *
 * Common authority inputs:
 *   ARENA_V2_RESOLVER=<address>
 * Optional:
 *   ARENA_V2_OWNER=<address>                 defaults to deployer
 *   ARENA_LEAGUE_V2_OWNER=<address>          defaults to ARENA_V2_OWNER
 *   ARENA_V2_DEPLOYMENT_FILE=<path>          defaults by exact chain
 *
 * Chain-native receiver/signing inputs are resolved chain-specifically first.
 * For Robinhood testnet 46630 they are STRICT and have no generic/BSC fallback:
 *   ARENA_BOOST_QUOTE_SIGNER_ADDRESS_46630
 *   ARENA_PROTOCOL_RECEIVER_46630
 *   ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_46630 (optional existing League V2)
 * or, when deploying a fresh League V2:
 *   ARENA_MONTHLY_MWL_RECEIVER_46630
 *   ARENA_QUARTERLY_RESERVE_RECEIVER_46630
 */

function envAddress(names: string[], required = true): string {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (!value) continue;
    if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
      throw new Error(`${name} must be a non-zero EVM address`);
    }
    return ethers.getAddress(value);
  }
  if (required) throw new Error(`Missing required address env: ${names.join(" or ")}`);
  return "";
}

function truthy(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

async function requireContract(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode: ${address}`);
  return code;
}

async function waitReceipt(tx: any, label: string) {
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} transaction failed`);
  return receipt;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error(`No deployer signer configured for Hardhat network ${network.name}`);

  const providerNetwork = await ethers.provider.getNetwork();
  const chainId = Number(providerNetwork.chainId);
  assertArenaV2DeploymentTarget(chainId, network.name, {
    allowLocal: truthy(process.env.ARENA_V2_ALLOW_LOCAL),
  });

  const owner = envAddress(["ARENA_V2_OWNER"], false) || ethers.getAddress(deployer.address);
  const leagueOwner = envAddress(["ARENA_LEAGUE_V2_OWNER"], false) || owner;
  const resolver = envAddress([
    `ARENA_V2_RESOLVER_${chainId}`,
    "ARENA_V2_RESOLVER",
    "ARENA_WAR_POOL_RESOLVER",
    "RESOLVER",
  ]);

  const boostQuoteSigner = envAddress(envNamesFor(chainId, "ARENA_BOOST_QUOTE_SIGNER_ADDRESS"));
  const protocolReceiver = envAddress(
    envNamesFor(chainId, ["ARENA_PROTOCOL_RECEIVER", "PROTOCOL_REVENUE_VAULT_ADDRESS"]),
  );
  const existingLeague = envAddress(
    envNamesFor(chainId, "ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS"),
    false,
  );

  const txHashes: Record<string, string | null> = {
    leagueDeployment: null,
    warPoolDeployment: null,
    leagueSourceAuthorization: null,
    leagueOwnershipTransfer: null,
  };

  let leagueAddress: string;
  let league: any;
  let deployedLeague = false;
  let leagueDeploymentBlock: number | null = null;

  if (existingLeague) {
    await requireContract(existingLeague, "PostGradLeagueTreasuryV2");
    leagueAddress = existingLeague;
    league = await ethers.getContractAt("PostGradLeagueTreasuryV2", leagueAddress);
    const generation = await league.GENERATION();
    if (generation !== 2n) throw new Error(`Existing PostGradLeagueTreasuryV2 has unexpected generation ${generation}`);
    console.log("PostGradLeagueTreasuryV2: attaching", leagueAddress);
  } else {
    const monthlyReceiver = envAddress(envNamesFor(chainId, "ARENA_MONTHLY_MWL_RECEIVER"));
    const quarterlyReceiver = envAddress(envNamesFor(chainId, "ARENA_QUARTERLY_RESERVE_RECEIVER"));
    const League = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
    league = await League.deploy(deployer.address, monthlyReceiver, quarterlyReceiver);
    const deploymentTx = league.deploymentTransaction();
    const receipt = deploymentTx ? await waitReceipt(deploymentTx, "PostGradLeagueTreasuryV2 deployment") : null;
    await league.waitForDeployment();
    leagueAddress = await league.getAddress();
    deployedLeague = true;
    txHashes.leagueDeployment = deploymentTx?.hash || null;
    leagueDeploymentBlock = receipt ? Number(receipt.blockNumber) : null;
    console.log("PostGradLeagueTreasuryV2: deployed", leagueAddress);
  }

  const WarPool = await ethers.getContractFactory("ArenaWarPoolTreasuryV2");
  const warPool = await WarPool.deploy(owner, resolver, boostQuoteSigner, protocolReceiver, leagueAddress);
  const warPoolDeploymentTx = warPool.deploymentTransaction();
  const warPoolReceipt = warPoolDeploymentTx
    ? await waitReceipt(warPoolDeploymentTx, "ArenaWarPoolTreasuryV2 deployment")
    : null;
  await warPool.waitForDeployment();
  const warPoolAddress = await warPool.getAddress();
  txHashes.warPoolDeployment = warPoolDeploymentTx?.hash || null;

  const generation = await warPool.GENERATION();
  const leagueGeneration = await league.GENERATION();
  const entryLeagueBps = await warPool.ENTRY_LEAGUE_BPS();
  const entryProtocolBps = await warPool.ENTRY_PROTOCOL_BPS();
  const boostProtocolBps = await warPool.BOOST_PROTOCOL_BPS();
  const leagueMonthlyBps = await league.MONTHLY_BPS();

  if (generation !== 2n) throw new Error("ArenaWarPoolTreasuryV2 generation invariant failed");
  if (leagueGeneration !== 2n) throw new Error("PostGradLeagueTreasuryV2 generation invariant failed");
  if (entryLeagueBps !== 2_000n) throw new Error("Arena V2 league split invariant failed");
  if (entryProtocolBps !== 500n) throw new Error("Arena V2 protocol split invariant failed");
  if (boostProtocolBps !== 1_000n) throw new Error("Arena V2 Boost split invariant failed");
  if (leagueMonthlyBps !== 6_000n) throw new Error("PostGrad League V2 monthly split invariant failed");

  if ((await warPool.owner()).toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Arena V2 owner invariant failed");
  }
  if ((await warPool.resolver()).toLowerCase() !== resolver.toLowerCase()) {
    throw new Error("Arena V2 resolver invariant failed");
  }
  if ((await warPool.boostQuoteSigner()).toLowerCase() !== boostQuoteSigner.toLowerCase()) {
    throw new Error("Arena V2 Boost quote signer invariant failed");
  }
  if ((await warPool.protocolReceiver()).toLowerCase() !== protocolReceiver.toLowerCase()) {
    throw new Error("Arena V2 protocol receiver invariant failed");
  }
  if ((await warPool.postGradLeagueTreasury()).toLowerCase() !== leagueAddress.toLowerCase()) {
    throw new Error("Arena V2 League treasury invariant failed");
  }

  const currentLeagueOwner = ethers.getAddress(await league.owner());
  if (currentLeagueOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Existing PostGradLeagueTreasuryV2 owner ${currentLeagueOwner} must authorize ${warPoolAddress} as a source. ` +
        `Rerun this script with the League owner signer or authorize the source explicitly before activation.`,
    );
  }

  const sourceTx = await league.setSource(warPoolAddress, true);
  await waitReceipt(sourceTx, "PostGradLeagueTreasuryV2 source authorization");
  txHashes.leagueSourceAuthorization = sourceTx.hash;
  if (!(await league.authorizedSources(warPoolAddress))) {
    throw new Error("PostGradLeagueTreasuryV2 source authorization invariant failed");
  }

  if (deployedLeague && leagueOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    const transferTx = await league.transferOwnership(leagueOwner);
    await waitReceipt(transferTx, "PostGradLeagueTreasuryV2 ownership transfer");
    txHashes.leagueOwnershipTransfer = transferTx.hash;
  }
  if ((await league.owner()).toLowerCase() !== leagueOwner.toLowerCase()) {
    throw new Error("PostGradLeagueTreasuryV2 final ownership invariant failed");
  }

  const warPoolCode = await requireContract(warPoolAddress, "ArenaWarPoolTreasuryV2");
  const leagueCode = await requireContract(leagueAddress, "PostGradLeagueTreasuryV2");
  const monthlyReceiver = ethers.getAddress(await league.monthlyReceiver());
  const quarterlyReceiver = ethers.getAddress(await league.quarterlyReceiver());

  const outputFile = String(process.env.ARENA_V2_DEPLOYMENT_FILE || "").trim() || defaultArenaV2DeploymentFile(chainId);
  const artifact = {
    schema: "memewarzone.arena-war-pool-treasury-v2.deployment.v1",
    createdAt: new Date().toISOString(),
    network: network.name,
    chainId,
    deploymentBlock: warPoolReceipt ? Number(warPoolReceipt.blockNumber) : null,
    deployer: ethers.getAddress(deployer.address),
    contracts: {
      arenaWarPoolTreasuryV2: {
        address: warPoolAddress,
        generation: generation.toString(),
        owner: ethers.getAddress(await warPool.owner()),
        resolver: ethers.getAddress(await warPool.resolver()),
        boostQuoteSigner: ethers.getAddress(await warPool.boostQuoteSigner()),
        protocolReceiver: ethers.getAddress(await warPool.protocolReceiver()),
        postGradLeagueTreasuryV2: leagueAddress,
        runtimeBytecodeHash: ethers.keccak256(warPoolCode),
        deploymentTxHash: txHashes.warPoolDeployment,
      },
      postGradLeagueTreasuryV2: {
        address: leagueAddress,
        generation: leagueGeneration.toString(),
        owner: ethers.getAddress(await league.owner()),
        monthlyReceiver,
        quarterlyReceiver,
        sourceAuthorized: true,
        deployedByThisRun: deployedLeague,
        deploymentBlock: leagueDeploymentBlock,
        runtimeBytecodeHash: ethers.keccak256(leagueCode),
        deploymentTxHash: txHashes.leagueDeployment,
      },
    },
    economics: {
      competition: { prizeBps: 7_500, leagueBps: 2_000, protocolBps: 500 },
      boost: { prizeBps: 9_000, protocolBps: 1_000 },
      postGradLeague: { monthlyBps: 6_000, quarterlyBps: 4_000 },
    },
    configurationTransactions: {
      leagueSourceAuthorization: txHashes.leagueSourceAuthorization,
      leagueOwnershipTransfer: txHashes.leagueOwnershipTransfer,
    },
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log("ArenaWarPoolTreasuryV2:", warPoolAddress);
  console.log("Boost quote signer:", boostQuoteSigner);
  console.log("Protocol receiver:", protocolReceiver);
  console.log("Post-Grad League V2:", leagueAddress);
  console.log("Post-Grad League V2 owner:", await league.owner());
  console.log("Deployment artifact:", outputFile);
  console.log("");
  console.log(`# Persist these server/runtime addresses for chain ${chainId}:`);
  console.log(`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chainId}=${warPoolAddress}`);
  console.log(`ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_${chainId}=${leagueAddress}`);
  console.log(`ARENA_BOOST_QUOTE_SIGNER_ADDRESS_${chainId}=${boostQuoteSigner}`);
  console.log("");
  console.log("Do not set ARENA_BATTLE_BOOSTS=true until indexer confirmation and pricing freshness config are ready.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

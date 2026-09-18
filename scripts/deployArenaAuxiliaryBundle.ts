import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const {
  ARENA_AUX_CHAINS,
  assertArenaAuxiliaryTarget,
  envNameFor,
  confirmTokenFor,
  defaultArenaAuxiliaryFile,
} = require("./lib/arenaAuxiliaryDeploymentPolicy.cjs");

function truthy(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function envAddress(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required address env: ${name}`);
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return ethers.getAddress(value);
}

async function requireCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode: ${address}`);
  return code;
}

async function waitReceipt(tx: any, label: string) {
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} transaction failed`);
  return receipt;
}

function normalizeKey(value: string) {
  const key = String(value || "").trim();
  return key && !key.startsWith("0x") ? `0x${key}` : key;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error(`No deployer signer configured for Hardhat network ${network.name}`);

  const providerNetwork = await ethers.provider.getNetwork();
  const chainId = Number(providerNetwork.chainId);
  const local = chainId === ARENA_AUX_CHAINS.LOCAL;
  assertArenaAuxiliaryTarget(chainId, network.name, {
    allowLocal: truthy(process.env.ARENA_AUX_ALLOW_LOCAL),
  });

  const defaultOutputFile = defaultArenaAuxiliaryFile(chainId);
  const outputFile = String(process.env.ARENA_AUX_DEPLOYMENT_FILE || "").trim() || defaultOutputFile;

  if (!local) {
    const expectedConfirm = confirmTokenFor(chainId);
    if (String(process.env.ARENA_AUX_DEPLOY_CONFIRM || "").trim() !== expectedConfirm) {
      throw new Error(`Arena auxiliary deployment on chain ${chainId} requires ARENA_AUX_DEPLOY_CONFIRM=${expectedConfirm}`);
    }
    if (path.resolve(outputFile) !== path.resolve(defaultOutputFile)) {
      throw new Error(`Arena auxiliary chain ${chainId} must use its chain-specific manifest: ${defaultOutputFile}`);
    }
    if (fs.existsSync(outputFile)) {
      throw new Error(`Arena auxiliary deployment manifest already exists; refusing overwrite: ${outputFile}`);
    }
  }

  const expectedDeployer = envAddress(envNameFor(chainId, "ARENA_AUX_EXPECTED_DEPLOYER"));
  if (expectedDeployer.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Arena auxiliary deployer mismatch: expected ${expectedDeployer}, got ${deployer.address}`);
  }

  if (chainId === ARENA_AUX_CHAINS.ROBINHOOD_MAINNET || chainId === ARENA_AUX_CHAINS.ROBINHOOD_TESTNET) {
    const keyEnv =
      chainId === ARENA_AUX_CHAINS.ROBINHOOD_MAINNET
        ? "ROBINHOOD_MAINNET_DEPLOYER_PRIVATE_KEY"
        : "ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY";
    const dedicatedKey = normalizeKey(String(process.env[keyEnv] || ""));
    if (!dedicatedKey) throw new Error(`Arena auxiliary Robinhood deployment requires ${keyEnv}`);
    const dedicatedAddress = new ethers.Wallet(dedicatedKey).address;
    if (dedicatedAddress.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(
        `Arena auxiliary Robinhood signer mismatch: dedicated signer ${dedicatedAddress} != Hardhat signer ${deployer.address}`,
      );
    }
  }

  // All non-local inputs are exact-chain suffixed. There are no generic/BSC fallbacks.
  const owner = envAddress(envNameFor(chainId, "ARENA_AUX_OWNER"));
  const voteOwner = envAddress(envNameFor(chainId, "ARENA_AUX_VOTE_OWNER"));
  const quoteSigner = envAddress(envNameFor(chainId, "ARENA_SPONSORSHIP_QUOTE_SIGNER"));
  const marketingReceiver = envAddress(envNameFor(chainId, "ARENA_MARKETING_RECEIVER"));
  const protocolReceiver = envAddress(envNameFor(chainId, "ARENA_PROTOCOL_RECEIVER"));

  // Distinct Arena vote treasury is always deployed fresh. The launchpad vote
  // treasury is only a collision guard and is never attached/reused.
  const launchpadVoteTreasuryRaw = String(process.env[envNameFor(chainId, "VOTE_TREASURY_ADDRESS")] || "").trim();
  const launchpadVoteTreasury =
    launchpadVoteTreasuryRaw && ethers.isAddress(launchpadVoteTreasuryRaw)
      ? ethers.getAddress(launchpadVoteTreasuryRaw)
      : "";

  const PrizeVault = await ethers.getContractFactory("EventPrizeVaultV1");
  const prizeVault = await PrizeVault.deploy(owner);
  const prizeDeployTx = prizeVault.deploymentTransaction();
  const prizeReceipt = prizeDeployTx ? await waitReceipt(prizeDeployTx, "EventPrizeVaultV1 deployment") : null;
  await prizeVault.waitForDeployment();
  const prizeVaultAddress = await prizeVault.getAddress();

  const Sponsorship = await ethers.getContractFactory("WarzoneSponsorshipRouterV1");
  const sponsorship = await Sponsorship.deploy(
    owner,
    quoteSigner,
    prizeVaultAddress,
    marketingReceiver,
    protocolReceiver,
  );
  const sponsorDeployTx = sponsorship.deploymentTransaction();
  const sponsorReceipt = sponsorDeployTx
    ? await waitReceipt(sponsorDeployTx, "WarzoneSponsorshipRouterV1 deployment")
    : null;
  await sponsorship.waitForDeployment();
  const sponsorshipAddress = await sponsorship.getAddress();

  const VoteTreasury = await ethers.getContractFactory("UPVoteTreasury");
  const voteTreasury = await VoteTreasury.deploy(voteOwner, protocolReceiver);
  const voteDeployTx = voteTreasury.deploymentTransaction();
  const voteReceipt = voteDeployTx ? await waitReceipt(voteDeployTx, "Arena UPVoteTreasury deployment") : null;
  await voteTreasury.waitForDeployment();
  const voteTreasuryAddress = await voteTreasury.getAddress();

  if (launchpadVoteTreasury && launchpadVoteTreasury.toLowerCase() === voteTreasuryAddress.toLowerCase()) {
    throw new Error("Arena vote treasury must be distinct from the launchpad vote treasury");
  }

  // Dark-by-default wiring. Event receivers/events are deliberately not configured here.
  const setRouterTx = await prizeVault.setRouter(sponsorshipAddress);
  const setRouterReceipt = await waitReceipt(setRouterTx, "EventPrizeVaultV1 router wiring");
  const pauseVaultTx = await prizeVault.setDepositsPaused(true);
  const pauseVaultReceipt = await waitReceipt(pauseVaultTx, "EventPrizeVaultV1 pause");
  const pauseSponsorTx = await sponsorship.setPaymentsPaused(true);
  const pauseSponsorReceipt = await waitReceipt(pauseSponsorTx, "WarzoneSponsorshipRouterV1 pause");

  if ((await prizeVault.owner()).toLowerCase() !== owner.toLowerCase()) throw new Error("EventPrizeVaultV1 owner mismatch");
  if ((await prizeVault.router()).toLowerCase() !== sponsorshipAddress.toLowerCase()) throw new Error("EventPrizeVaultV1 router mismatch");
  if (!(await prizeVault.depositsPaused())) throw new Error("EventPrizeVaultV1 must be dark/paused after deployment");
  if ((await sponsorship.owner()).toLowerCase() !== owner.toLowerCase()) throw new Error("WarzoneSponsorshipRouterV1 owner mismatch");
  if ((await sponsorship.quoteSigner()).toLowerCase() !== quoteSigner.toLowerCase()) throw new Error("Sponsorship quote signer mismatch");
  if ((await sponsorship.eventPrizeVault()).toLowerCase() !== prizeVaultAddress.toLowerCase()) throw new Error("Sponsorship prize vault mismatch");
  if ((await sponsorship.marketingReceiver()).toLowerCase() !== marketingReceiver.toLowerCase()) throw new Error("Sponsorship marketing receiver mismatch");
  if ((await sponsorship.protocolReceiver()).toLowerCase() !== protocolReceiver.toLowerCase()) throw new Error("Sponsorship protocol receiver mismatch");
  if (!(await sponsorship.paymentsPaused())) throw new Error("WarzoneSponsorshipRouterV1 must be dark/paused after deployment");
  if ((await voteTreasury.owner()).toLowerCase() !== voteOwner.toLowerCase()) throw new Error("Arena vote treasury owner mismatch");
  if ((await voteTreasury.feeReceiver()).toLowerCase() !== protocolReceiver.toLowerCase()) throw new Error("Arena vote treasury fee receiver mismatch");
  const nativeVoteConfig = await voteTreasury.assetConfig(ethers.ZeroAddress);
  if (!nativeVoteConfig.enabled) throw new Error("Arena vote treasury native asset must be enabled");

  if ((await prizeVault.GENERATION()) !== 1n) throw new Error("EventPrizeVaultV1 generation invariant failed");
  if ((await sponsorship.GENERATION()) !== 1n) throw new Error("WarzoneSponsorshipRouterV1 generation invariant failed");
  if ((await sponsorship.EVENT_BPS()) !== 7_000n) throw new Error("Sponsorship event split invariant failed");
  if ((await sponsorship.MARKETING_BPS()) !== 2_000n) throw new Error("Sponsorship marketing split invariant failed");

  const prizeCode = await requireCode(prizeVaultAddress, "EventPrizeVaultV1");
  const sponsorCode = await requireCode(sponsorshipAddress, "WarzoneSponsorshipRouterV1");
  const voteCode = await requireCode(voteTreasuryAddress, "Arena UPVoteTreasury");

  const artifact = {
    schema: "memewarzone.arena-auxiliary-bundle.v1",
    createdAt: new Date().toISOString(),
    network: network.name,
    chainId,
    deployer: ethers.getAddress(deployer.address),
    contracts: {
      eventPrizeVaultV1: {
        address: prizeVaultAddress,
        owner,
        router: sponsorshipAddress,
        depositsPaused: true,
        generation: "1",
        runtimeBytecodeHash: ethers.keccak256(prizeCode),
        deploymentTxHash: prizeDeployTx?.hash || null,
        deploymentBlock: prizeReceipt ? Number(prizeReceipt.blockNumber) : null,
      },
      warzoneSponsorshipRouterV1: {
        address: sponsorshipAddress,
        owner,
        quoteSigner,
        eventPrizeVault: prizeVaultAddress,
        marketingReceiver,
        protocolReceiver,
        paymentsPaused: true,
        generation: "1",
        runtimeBytecodeHash: ethers.keccak256(sponsorCode),
        deploymentTxHash: sponsorDeployTx?.hash || null,
        deploymentBlock: sponsorReceipt ? Number(sponsorReceipt.blockNumber) : null,
      },
      arenaVoteTreasury: {
        address: voteTreasuryAddress,
        owner: voteOwner,
        feeReceiver: protocolReceiver,
        nativeAssetEnabled: true,
        distinctFromLaunchpadVoteTreasury: launchpadVoteTreasury || null,
        runtimeBytecodeHash: ethers.keccak256(voteCode),
        deploymentTxHash: voteDeployTx?.hash || null,
        deploymentBlock: voteReceipt ? Number(voteReceipt.blockNumber) : null,
      },
    },
    economics: {
      sponsorship: { eventBps: 7_000, marketingBps: 2_000, protocolBps: 1_000 },
      arenaVoteTreasury: { forwardingReceiver: protocolReceiver },
    },
    configurationTransactions: {
      eventPrizeVaultRouter: setRouterReceipt.hash,
      eventPrizeVaultPause: pauseVaultReceipt.hash,
      sponsorshipPaymentsPause: pauseSponsorReceipt.hash,
    },
    activation: {
      dark: true,
      eventReceiversConfigured: false,
      sponsorshipEventsEnabled: false,
    },
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: local ? "w" : "wx",
  });

  console.log(`Arena auxiliary bundle deployed dark on ${network.name}/${chainId}`);
  console.log(`EVENT_PRIZE_VAULT_V1_ADDRESS_${chainId}=${prizeVaultAddress}`);
  console.log(`WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS_${chainId}=${sponsorshipAddress}`);
  console.log(`ARENA_VOTE_TREASURY_ADDRESS_${chainId}=${voteTreasuryAddress}`);
  console.log(`Artifact=${outputFile}`);
  console.log("EventPrizeVault deposits and sponsorship payments remain paused; no event is enabled.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

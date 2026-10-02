import fs from "node:fs";
import { ethers, network } from "hardhat";

const {
  assertArenaAuxiliaryTarget,
  envNameFor,
  defaultArenaAuxiliaryFile,
} = require("./lib/arenaAuxiliaryDeploymentPolicy.cjs");

function truthy(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function expectEq(actual: unknown, expected: unknown, label: string) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function requireReceipt(hash: string | null | undefined, label: string) {
  if (!hash) throw new Error(`${label} transaction hash missing from deployment artifact`);
  const receipt = await ethers.provider.getTransactionReceipt(hash);
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} receipt missing or failed: ${hash}`);
  return receipt;
}

async function main() {
  const providerNetwork = await ethers.provider.getNetwork();
  const chainId = Number(providerNetwork.chainId);
  assertArenaAuxiliaryTarget(chainId, network.name, {
    allowLocal: truthy(process.env.ARENA_AUX_ALLOW_LOCAL),
  });

  const artifactPath =
    String(process.env.ARENA_AUX_DEPLOYMENT_FILE || "").trim() || defaultArenaAuxiliaryFile(chainId);
  if (!fs.existsSync(artifactPath)) throw new Error(`Arena auxiliary deployment artifact not found: ${artifactPath}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  expectEq(artifact.schema, "memewarzone.arena-auxiliary-bundle.v1", "artifact schema");
  expectEq(artifact.chainId, chainId, "artifact chainId");
  expectEq(artifact.network, network.name, "artifact network");
  if (artifact.activation?.dark !== true) throw new Error("Arena auxiliary artifact is not marked dark");
  if (artifact.activation?.eventReceiversConfigured !== false) throw new Error("Event receivers must remain unconfigured");
  if (artifact.activation?.sponsorshipEventsEnabled !== false) throw new Error("Sponsorship events must remain disabled");

  const prize = artifact.contracts?.eventPrizeVaultV1;
  const sponsorshipRecord = artifact.contracts?.warzoneSponsorshipRouterV1;
  const vote = artifact.contracts?.arenaVoteTreasury;
  if (!prize?.address || !sponsorshipRecord?.address || !vote?.address) {
    throw new Error("Arena auxiliary artifact is missing required contract addresses");
  }
  if (new Set([prize.address.toLowerCase(), sponsorshipRecord.address.toLowerCase(), vote.address.toLowerCase()]).size !== 3) {
    throw new Error("Arena auxiliary contract addresses must be distinct");
  }

  const [prizeCode, sponsorCode, voteCode] = await Promise.all([
    ethers.provider.getCode(prize.address),
    ethers.provider.getCode(sponsorshipRecord.address),
    ethers.provider.getCode(vote.address),
  ]);
  if (!prizeCode || prizeCode === "0x") throw new Error(`EventPrizeVaultV1 has no bytecode: ${prize.address}`);
  if (!sponsorCode || sponsorCode === "0x") throw new Error(`WarzoneSponsorshipRouterV1 has no bytecode: ${sponsorshipRecord.address}`);
  if (!voteCode || voteCode === "0x") throw new Error(`Arena UPVoteTreasury has no bytecode: ${vote.address}`);
  expectEq(ethers.keccak256(prizeCode), prize.runtimeBytecodeHash, "EventPrizeVaultV1 runtime hash");
  expectEq(ethers.keccak256(sponsorCode), sponsorshipRecord.runtimeBytecodeHash, "WarzoneSponsorshipRouterV1 runtime hash");
  expectEq(ethers.keccak256(voteCode), vote.runtimeBytecodeHash, "Arena UPVoteTreasury runtime hash");

  const prizeVault: any = await ethers.getContractAt("EventPrizeVaultV1", prize.address);
  const sponsorship: any = await ethers.getContractAt("WarzoneSponsorshipRouterV1", sponsorshipRecord.address);
  const voteTreasury: any = await ethers.getContractAt("UPVoteTreasury", vote.address);

  expectEq(await prizeVault.GENERATION(), 1n, "EventPrizeVaultV1 generation");
  expectEq(await sponsorship.GENERATION(), 1n, "WarzoneSponsorshipRouterV1 generation");
  expectEq(await prizeVault.owner(), prize.owner, "EventPrizeVaultV1 owner");
  expectEq(await prizeVault.router(), sponsorshipRecord.address, "EventPrizeVaultV1 router");
  if (!(await prizeVault.depositsPaused())) throw new Error("EventPrizeVaultV1 deposits are not paused");

  expectEq(await sponsorship.owner(), sponsorshipRecord.owner, "Sponsorship owner");
  expectEq(await sponsorship.quoteSigner(), sponsorshipRecord.quoteSigner, "Sponsorship quote signer");
  expectEq(await sponsorship.eventPrizeVault(), prize.address, "Sponsorship prize vault");
  expectEq(await sponsorship.marketingReceiver(), sponsorshipRecord.marketingReceiver, "Sponsorship marketing receiver");
  expectEq(await sponsorship.protocolReceiver(), sponsorshipRecord.protocolReceiver, "Sponsorship protocol receiver");
  if (!(await sponsorship.paymentsPaused())) throw new Error("WarzoneSponsorshipRouterV1 payments are not paused");

  expectEq(await sponsorship.EVENT_BPS(), 7_000n, "Sponsorship event BPS");
  expectEq(await sponsorship.MARKETING_BPS(), 2_000n, "Sponsorship marketing BPS");
  expectEq(artifact.economics?.sponsorship?.protocolBps, 1_000, "Sponsorship protocol BPS");

  expectEq(await voteTreasury.owner(), vote.owner, "Arena vote treasury owner");
  expectEq(await voteTreasury.feeReceiver(), vote.feeReceiver, "Arena vote treasury fee receiver");
  const nativeVoteConfig = await voteTreasury.assetConfig(ethers.ZeroAddress);
  if (!nativeVoteConfig.enabled) throw new Error("Arena vote treasury native asset is disabled");

  const launchpadVoteRaw = String(process.env[envNameFor(chainId, "VOTE_TREASURY_ADDRESS")] || "").trim();
  if (launchpadVoteRaw && ethers.isAddress(launchpadVoteRaw)) {
    if (ethers.getAddress(launchpadVoteRaw).toLowerCase() === vote.address.toLowerCase()) {
      throw new Error("Arena vote treasury collides with launchpad vote treasury");
    }
  }
  if (
    vote.distinctFromLaunchpadVoteTreasury &&
    String(vote.distinctFromLaunchpadVoteTreasury).toLowerCase() === String(vote.address).toLowerCase()
  ) {
    throw new Error("Artifact records an Arena/launchpad vote treasury collision");
  }

  const receipts = await Promise.all([
    requireReceipt(prize.deploymentTxHash, "EventPrizeVaultV1 deployment"),
    requireReceipt(sponsorshipRecord.deploymentTxHash, "WarzoneSponsorshipRouterV1 deployment"),
    requireReceipt(vote.deploymentTxHash, "Arena UPVoteTreasury deployment"),
    requireReceipt(artifact.configurationTransactions?.eventPrizeVaultRouter, "EventPrizeVaultV1 router wiring"),
    requireReceipt(artifact.configurationTransactions?.eventPrizeVaultPause, "EventPrizeVaultV1 pause"),
    requireReceipt(artifact.configurationTransactions?.sponsorshipPaymentsPause, "Sponsorship payments pause"),
  ]);

  const expectedBlocks = [prize.deploymentBlock, sponsorshipRecord.deploymentBlock, vote.deploymentBlock];
  for (let i = 0; i < 3; i += 1) {
    if (Number(receipts[i].blockNumber) !== Number(expectedBlocks[i])) {
      throw new Error(`Deployment block mismatch at contract index ${i}`);
    }
  }

  console.log(`Arena auxiliary deployment attested dark: ${network.name}/${chainId}`);
  console.log(`EventPrizeVaultV1=${prize.address}`);
  console.log(`WarzoneSponsorshipRouterV1=${sponsorshipRecord.address}`);
  console.log(`ArenaVoteTreasury=${vote.address}`);
  console.log("Sponsorship=70/20/10; deposits/payments paused");
  console.log(`Artifact=${artifactPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

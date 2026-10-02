import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const NETWORK_BY_CHAIN: Record<number, string> = {
  56: "bscMainnet",
  97: "bscTestnet",
  4663: "robinhoodMainnet",
  46630: "robinhoodTestnet",
};

function suffix(chainId: number) {
  if (chainId === 56) return "bsc56";
  if (chainId === 97) return "bsc97";
  if (chainId === 4663) return "robinhood4663";
  if (chainId === 46630) return "robinhood46630";
  throw new Error(`Unsupported Arena auxiliary verification chain ${chainId}`);
}

function eq(actual: unknown, expected: unknown, label: string) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function codeHash(address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`Missing runtime bytecode: ${address}`);
  return ethers.keccak256(code);
}

async function requireReceipt(hash: string | null | undefined, label: string) {
  if (!hash) throw new Error(`${label} transaction hash is missing`);
  const receipt = await ethers.provider.getTransactionReceipt(hash);
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} receipt is missing or failed`);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const expectedNetwork = NETWORK_BY_CHAIN[chainId];
  if (!expectedNetwork || network.name !== expectedNetwork) {
    throw new Error(`Arena auxiliary verifier requires exact supported network binding; got ${network.name}/${chainId}`);
  }

  const artifactPath = String(process.env.ARENA_AUX_DEPLOYMENT_FILE || "").trim() ||
    path.join("deployments", "arena", `auxiliary.${suffix(chainId)}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error(`Arena auxiliary deployment artifact not found: ${artifactPath}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  eq(artifact.schema, "memewarzone.arena-auxiliary-bundle.v1", "artifact schema");
  eq(artifact.chainId, chainId, "artifact chainId");
  eq(artifact.network, network.name, "artifact network");

  const vaultRecord = artifact.contracts?.eventPrizeVaultV1;
  const routerRecord = artifact.contracts?.warzoneSponsorshipRouterV1;
  const voteRecord = artifact.contracts?.arenaVoteTreasury;
  if (!vaultRecord?.address || !routerRecord?.address || !voteRecord?.address) {
    throw new Error("Arena auxiliary artifact is missing contract addresses");
  }

  eq(await codeHash(vaultRecord.address), vaultRecord.runtimeBytecodeHash, "EventPrizeVaultV1 runtime hash");
  eq(await codeHash(routerRecord.address), routerRecord.runtimeBytecodeHash, "WarzoneSponsorshipRouterV1 runtime hash");
  eq(await codeHash(voteRecord.address), voteRecord.runtimeBytecodeHash, "Arena UPVoteTreasury runtime hash");

  const vault: any = await ethers.getContractAt("EventPrizeVaultV1", vaultRecord.address);
  const router: any = await ethers.getContractAt("WarzoneSponsorshipRouterV1", routerRecord.address);
  const vote: any = await ethers.getContractAt("UPVoteTreasury", voteRecord.address);

  eq(await vault.GENERATION(), 1n, "EventPrizeVaultV1 generation");
  eq(await router.GENERATION(), 1n, "WarzoneSponsorshipRouterV1 generation");
  eq(await vault.owner(), vaultRecord.owner, "EventPrizeVaultV1 owner");
  eq(await vault.router(), routerRecord.address, "EventPrizeVaultV1 router");
  eq(await router.owner(), routerRecord.owner, "Sponsorship router owner");
  eq(await router.quoteSigner(), routerRecord.quoteSigner, "Sponsorship quote signer");
  eq(await router.eventPrizeVault(), vaultRecord.address, "Sponsorship event vault");
  eq(await router.marketingReceiver(), routerRecord.marketingReceiver, "Sponsorship marketing receiver");
  eq(await router.protocolReceiver(), routerRecord.protocolReceiver, "Sponsorship protocol receiver");
  if ((await router.paymentsPaused()) !== true) throw new Error("Sponsorship router is not dark/paused");

  eq(await router.EVENT_BPS(), 7_000n, "Sponsorship event BPS");
  eq(await router.MARKETING_BPS(), 2_000n, "Sponsorship marketing BPS");
  eq(artifact.economics?.sponsorship?.protocolBps, 1_000, "Sponsorship protocol BPS evidence");

  eq(await vote.owner(), voteRecord.owner, "Arena vote owner");
  eq(await vote.feeReceiver(), voteRecord.feeReceiver, "Arena vote fee receiver");
  const nativeVote = await vote.assetConfig(ethers.ZeroAddress);
  if (Boolean(nativeVote.enabled) !== false) throw new Error("Arena vote native asset is enabled before activation");

  const launchpad = String(voteRecord.launchpadVoteTreasury || "").trim();
  if (launchpad && launchpad.toLowerCase() === String(voteRecord.address).toLowerCase()) {
    throw new Error("Arena vote treasury collides with launchpad vote treasury");
  }

  await requireReceipt(vaultRecord.deploymentTxHash, "EventPrizeVaultV1 deployment");
  await requireReceipt(routerRecord.deploymentTxHash, "WarzoneSponsorshipRouterV1 deployment");
  await requireReceipt(voteRecord.deploymentTxHash, "Arena UPVoteTreasury deployment");
  await requireReceipt(artifact.configurationTransactions?.vaultSetRouter, "EventPrizeVaultV1.setRouter");
  await requireReceipt(artifact.configurationTransactions?.sponsorshipPause, "Sponsorship pause");
  await requireReceipt(artifact.configurationTransactions?.arenaVoteDisableNative, "Arena vote disable-native");

  console.log(JSON.stringify({
    verified: true,
    chainId,
    network: network.name,
    artifact: artifactPath,
    eventPrizeVaultV1: vaultRecord.address,
    warzoneSponsorshipRouterV1: routerRecord.address,
    arenaVoteTreasury: voteRecord.address,
    activation: "dark",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

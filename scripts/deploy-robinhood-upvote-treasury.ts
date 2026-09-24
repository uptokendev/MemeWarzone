/**
 * Deploy the Robinhood mainnet UPVoteTreasury -- the $3 UP Vote pass-through.
 *
 * Founder decision 2026-09-24: UP votes land in the capped protocol wallet on
 * every chain. So the fee receiver is the chain's ProtocolRevenueVault (read
 * from deployments/robinhood/mainnet.prerequisites.json, code required on
 * chain), and the owner is the Safe from the first block: the constructor
 * already enables native voting with no minimum, so nothing needs configuring
 * afterwards and no Safe transaction is required to make it live.
 *
 * Refuses to run twice: the record file is the lock.
 *
 *   npx hardhat run scripts/deploy-robinhood-upvote-treasury.ts --network robinhoodMainnet
 *
 * Rehearsed on a local chain by test/RobinhoodUpVoteTreasuryDeploy.spec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663n;
export const RECORD_PATH = path.resolve(__dirname, "..", "deployments", "robinhood", "mainnet.upvote-treasury.json");
const PREREQUISITES_PATH = path.resolve(__dirname, "..", "deployments", "robinhood", "mainnet.prerequisites.json");

export async function deployUpVoteTreasury(inputs: { owner: string; feeReceiver: string }) {
  const owner = ethers.getAddress(inputs.owner);
  const feeReceiver = ethers.getAddress(inputs.feeReceiver);
  if ((await ethers.provider.getCode(feeReceiver)) === "0x") {
    throw new Error(`fee receiver ${feeReceiver} has no code on this chain; UP votes would be forwarded to an EOA`);
  }
  const factory = await ethers.getContractFactory("UPVoteTreasury");
  const treasury = await factory.deploy(owner, feeReceiver);
  await treasury.waitForDeployment();
  const address = await treasury.getAddress();

  // Read back what was written, not what was intended.
  const [ownerOnChain, receiverOnChain, native] = await Promise.all([
    treasury.owner(),
    treasury.feeReceiver(),
    treasury.assetConfig(ethers.ZeroAddress),
  ]);
  if (ethers.getAddress(ownerOnChain) !== owner) throw new Error(`owner is ${ownerOnChain}, expected ${owner}`);
  if (ethers.getAddress(receiverOnChain) !== feeReceiver) throw new Error(`feeReceiver is ${receiverOnChain}, expected ${feeReceiver}`);
  if (!native.enabled) throw new Error("native voting is not enabled after deploy");
  if (native.minAmount !== 0n) throw new Error(`native minAmount is ${native.minAmount}, expected 0`);
  return { address, owner, feeReceiver };
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(`this script is for Robinhood mainnet (4663); ${network.name} reports chain ${chainId}`);
  }
  if (fs.existsSync(RECORD_PATH)) {
    throw new Error(`${RECORD_PATH} exists -- the treasury is already deployed; delete the record only if you mean to deploy a second one`);
  }
  const prerequisites = JSON.parse(fs.readFileSync(PREREQUISITES_PATH, "utf8"));
  const safe = ethers.getAddress(String(prerequisites.safe || ""));
  const vault = ethers.getAddress(String(prerequisites.contracts?.ProtocolRevenueVault || ""));
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[upvote] chain ${chainId}  deployer ${deployer.address}  ${ethers.formatEther(balance)} ETH`);
  console.log(`[upvote] owner (Safe)      ${safe}`);
  console.log(`[upvote] feeReceiver       ${vault}  (ProtocolRevenueVault -- the capped protocol wallet)`);

  const result = await deployUpVoteTreasury({ owner: safe, feeReceiver: vault });
  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: { UPVoteTreasury: result.address },
    owner: result.owner,
    feeReceiver: result.feeReceiver,
    nativeVoting: { enabled: true, minAmount: "0" },
    env: {
      app: { VITE_VOTE_TREASURY_ADDRESS_4663: result.address },
      api: { VOTE_TREASURY_ADDRESS_4663: result.address, VITE_VOTE_TREASURY_ADDRESS_4663: result.address },
      indexer: { VOTE_TREASURY_ADDRESS_4663: result.address, VOTE_TREASURY_START_BLOCK_4663: String(await ethers.provider.getBlockNumber()) },
    },
  };
  fs.writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[upvote] UPVoteTreasury ${result.address}  owner ${result.owner}  feeReceiver ${result.feeReceiver}`);
  console.log(`[upvote] wrote ${RECORD_PATH}`);
  console.log("[upvote] env to set:");
  console.log(`  app:      VITE_VOTE_TREASURY_ADDRESS_4663=${result.address}`);
  console.log(`  api:      VOTE_TREASURY_ADDRESS_4663=${result.address}`);
  console.log(`  indexer:  VOTE_TREASURY_ADDRESS_4663=${result.address}  VOTE_TREASURY_START_BLOCK_4663=${record.env.indexer.VOTE_TREASURY_START_BLOCK_4663}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

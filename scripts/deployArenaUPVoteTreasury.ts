import { ethers } from "hardhat";

const SUPPORTED_EVM_CHAINS = new Set([56, 97, 4663, 46630]);

/**
 * Deploys the separate Arena UPVoteTreasury instance.
 * Uses the same UPVoteTreasury bytecode as the launchpad, but a distinct address
 * and chain-local ProtocolRevenueVault receiver.
 *
 * Robinhood testnet example:
 *   DEPLOYER_PK=... PROTOCOL_REVENUE_VAULT_ADDRESS_46630=0x... \
 *     npx hardhat run scripts/deployArenaUPVoteTreasury.ts --network robinhoodTestnet
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (!SUPPORTED_EVM_CHAINS.has(chainId)) throw new Error(`Unsupported Arena EVM chain ${chainId}`);

  const feeReceiver = String(
    process.env.FEE_RECEIVER ||
      process.env[`PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}`] ||
      process.env.PROTOCOL_REVENUE_VAULT_ADDRESS ||
      "",
  ).trim();
  if (!ethers.isAddress(feeReceiver)) {
    throw new Error(`Missing/invalid FEE_RECEIVER or PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}`);
  }

  const owner = String(process.env.ARENA_VOTE_OWNER || deployer.address).trim();
  if (!ethers.isAddress(owner)) throw new Error("Invalid ARENA_VOTE_OWNER");

  const UPVoteTreasury = await ethers.getContractFactory("UPVoteTreasury");
  const treasury = await UPVoteTreasury.deploy(owner, feeReceiver);
  await treasury.waitForDeployment();
  const address = await treasury.getAddress();

  console.log("Arena UPVoteTreasury deployed:", address);
  console.log("chainId:", chainId);
  console.log("owner:", owner);
  console.log("feeReceiver:", feeReceiver);
  console.log(`ARENA_VOTE_TREASURY_ADDRESS_${chainId}=${address}`);
  console.log(`VITE_ARENA_VOTE_TREASURY_ADDRESS_${chainId}=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

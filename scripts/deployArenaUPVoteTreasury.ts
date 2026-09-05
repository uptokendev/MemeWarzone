import { ethers } from "hardhat";

/**
 * Second UPVoteTreasury instance for Arena UpVotes.
 * Same bytecode as launchpad. New address. feeReceiver MUST be ProtocolRevenueVault
 * so Arena UpVotes follow the same protocol-treasury route as launchpad UP Votes.
 *
 *   FEE_RECEIVER=0x... npx hardhat run scripts/deployArenaUPVoteTreasury.ts --network bscTestnet
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const feeReceiver = String(
    process.env.FEE_RECEIVER ||
      process.env.PROTOCOL_REVENUE_VAULT_ADDRESS ||
      process.env.PROTOCOL_REVENUE_VAULT_ADDRESS_97 ||
      process.env.PROTOCOL_REVENUE_VAULT_ADDRESS_56 ||
      "",
  ).trim();
  if (!feeReceiver) throw new Error("Missing FEE_RECEIVER / PROTOCOL_REVENUE_VAULT_ADDRESS");

  const owner = String(process.env.ARENA_VOTE_OWNER || deployer.address).trim();
  const UPVoteTreasury = await ethers.getContractFactory("UPVoteTreasury");
  const treasury = await UPVoteTreasury.deploy(owner, feeReceiver);
  await treasury.waitForDeployment();
  const addr = await treasury.getAddress();
  const net = await ethers.provider.getNetwork();
  console.log("Arena UPVoteTreasury deployed:", addr);
  console.log(`ARENA_VOTE_TREASURY_ADDRESS_${Number(net.chainId)}=${addr}`);
  console.log(`VITE_ARENA_VOTE_TREASURY_ADDRESS_${Number(net.chainId)}=${addr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

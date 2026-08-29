import { ethers } from "hardhat";

/**
 * Holding escrow for Arena stakes, tournament buy-ins, and Support donations.
 * fee receivers: ProtocolRevenueVault (5%), TreasuryVaultV2 (10% MWL).
 * Winner campaign owner claims 85% of stakes + Support. No charity path.
 *
 *   RESOLVER=<addr> PROTOCOL_REVENUE_VAULT_ADDRESS=... TREASURY_VAULT_ADDRESS=... \
 *     npx hardhat run scripts/deployArenaWarPoolTreasury.ts --network bscTestnet
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = String(process.env.ARENA_WAR_POOL_OWNER || deployer.address).trim();
  const resolver = String(process.env.RESOLVER || process.env.ARENA_WAR_POOL_RESOLVER || deployer.address).trim();
  const protocol = String(process.env.PROTOCOL_REVENUE_VAULT_ADDRESS || process.env.PROTOCOL_REVENUE_VAULT_ADDRESS_97 || "").trim();
  const mwl = String(process.env.TREASURY_VAULT_ADDRESS || process.env.TREASURY_VAULT_ADDRESS_97 || process.env.VITE_TREASURY_VAULT_ADDRESS_97 || "").trim();
  if (!protocol || !mwl) {
    throw new Error("Need PROTOCOL_REVENUE_VAULT_ADDRESS and TREASURY_VAULT_ADDRESS");
  }
  const Factory = await ethers.getContractFactory("ArenaWarPoolTreasury");
  const treasury = await Factory.deploy(owner, resolver, protocol, mwl);
  await treasury.waitForDeployment();
  const addr = await treasury.getAddress();
  const net = await ethers.provider.getNetwork();
  console.log("ArenaWarPoolTreasury:", addr);
  console.log(`ARENA_WAR_POOL_TREASURY_ADDRESS_${Number(net.chainId)}=${addr}`);
  console.log(`VITE_ARENA_WAR_POOL_TREASURY_ADDRESS_${Number(net.chainId)}=${addr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

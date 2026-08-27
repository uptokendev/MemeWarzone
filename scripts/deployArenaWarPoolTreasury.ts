import { ethers } from "hardhat";

const SUPPORTED_EVM_CHAINS = new Set([56, 97, 4663, 46630]);

/**
 * Deploys ArenaWarPoolTreasury with chain-local receivers.
 * Same contract behavior on BNB and Robinhood; only the native asset changes.
 *
 * Robinhood testnet example:
 *   DEPLOYER_PK=... ARENA_WAR_POOL_RESOLVER=0x... \
 *   PROTOCOL_REVENUE_VAULT_ADDRESS_46630=0x... \
 *   TREASURY_VAULT_ADDRESS_46630=0x... \
 *   CHARITY_TREASURY_ADDRESS_46630=0x... \
 *     npx hardhat run scripts/deployArenaWarPoolTreasury.ts --network robinhoodTestnet
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (!SUPPORTED_EVM_CHAINS.has(chainId)) throw new Error(`Unsupported Arena EVM chain ${chainId}`);

  const owner = String(process.env.ARENA_WAR_POOL_OWNER || deployer.address).trim();
  const resolver = String(process.env.RESOLVER || process.env.ARENA_WAR_POOL_RESOLVER || deployer.address).trim();
  const protocol = String(
    process.env[`PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}`] ||
      process.env.PROTOCOL_REVENUE_VAULT_ADDRESS ||
      "",
  ).trim();
  const mwl = String(
    process.env[`TREASURY_VAULT_ADDRESS_${chainId}`] ||
      process.env[`VITE_TREASURY_VAULT_ADDRESS_${chainId}`] ||
      process.env.TREASURY_VAULT_ADDRESS ||
      "",
  ).trim();
  const charity = String(
    process.env[`CHARITY_TREASURY_ADDRESS_${chainId}`] ||
      process.env.CHARITY_TREASURY_ADDRESS ||
      "",
  ).trim();

  for (const [name, value] of [
    ["ARENA_WAR_POOL_OWNER", owner],
    ["ARENA_WAR_POOL_RESOLVER", resolver],
    [`PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}`, protocol],
    [`TREASURY_VAULT_ADDRESS_${chainId}`, mwl],
    [`CHARITY_TREASURY_ADDRESS_${chainId}`, charity],
  ] as const) {
    if (!ethers.isAddress(value)) throw new Error(`Missing/invalid ${name}`);
  }

  const Factory = await ethers.getContractFactory("ArenaWarPoolTreasury");
  const treasury = await Factory.deploy(owner, resolver, protocol, mwl, charity);
  await treasury.waitForDeployment();
  const address = await treasury.getAddress();

  console.log("ArenaWarPoolTreasury deployed:", address);
  console.log("chainId:", chainId);
  console.log("owner:", owner);
  console.log("resolver:", resolver);
  console.log("protocolReceiver:", protocol);
  console.log("mwlReceiver:", mwl);
  console.log("charityReceiver:", charity);
  console.log(`ARENA_WAR_POOL_TREASURY_ADDRESS_${chainId}=${address}`);
  console.log(`VITE_ARENA_WAR_POOL_TREASURY_ADDRESS_${chainId}=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

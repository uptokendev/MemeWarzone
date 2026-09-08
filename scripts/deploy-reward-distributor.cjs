const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const NETWORK_CHAIN_IDS = {
  bscMainnet: 56,
  bscTestnet: 97,
  robinhoodMainnet: 4663,
  robinhoodTestnet: 46630,
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const expectedChainId = NETWORK_CHAIN_IDS[hre.network.name];
  if (expectedChainId && chainId !== expectedChainId) {
    throw new Error(`${hre.network.name} must resolve chain ID ${expectedChainId}, got ${chainId}`);
  }

  const perChainOwner = process.env[`REWARD_DISTRIBUTOR_OWNER_${chainId}`];
  const owner = perChainOwner || process.env.REWARD_DISTRIBUTOR_OWNER || deployer.address;
  if (!hre.ethers.isAddress(owner)) {
    throw new Error(`REWARD_DISTRIBUTOR_OWNER_${chainId} / REWARD_DISTRIBUTOR_OWNER must be a valid EVM address`);
  }

  const productionChain = chainId === 56 || chainId === 4663;
  if (productionChain) {
    if (!perChainOwner && !process.env.REWARD_DISTRIBUTOR_OWNER) {
      throw new Error(`REWARD_DISTRIBUTOR_OWNER_${chainId} or REWARD_DISTRIBUTOR_OWNER is required on production chain ${chainId}`);
    }
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      throw new Error(`Production RewardDistributor owner on chain ${chainId} must not be the deployer`);
    }
  }

  const RewardDistributor = await hre.ethers.getContractFactory("RewardDistributor");
  const distributor = await RewardDistributor.deploy(owner);
  await distributor.waitForDeployment();

  const address = await distributor.getAddress();
  const deploymentTx = distributor.deploymentTransaction();
  const receipt = deploymentTx ? await deploymentTx.wait() : null;
  const runtimeCode = await hre.ethers.provider.getCode(address);

  const artifact = {
    contract: "RewardDistributor",
    address,
    owner,
    deployer: deployer.address,
    network: hre.network.name,
    chainId,
    blockNumber: receipt?.blockNumber ?? null,
    transactionHash: deploymentTx?.hash ?? null,
    runtimeCodeHash: hre.ethers.keccak256(runtimeCode),
    verified: false,
  };
  const outFile = path.join(__dirname, "..", "deployments", `${hre.network.name}.reward-distributor.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
  console.log(`REWARD_DISTRIBUTOR_ADDRESS_${chainId}=${address}`);
  console.log(`REWARD_DISTRIBUTOR_OWNER_${chainId}=${owner}`);
  console.log(`Saved ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
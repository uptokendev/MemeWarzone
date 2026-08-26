import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const allowLocal = ["1", "true", "yes"].includes(String(process.env.ALLOW_LOCAL_RH_V3_MOCK || "").toLowerCase());
  if (chainId !== 46630 && !(allowLocal && chainId === 31337)) {
    throw new Error(`Robinhood V3 mock deployment is testnet-only. Expected chain 46630, got ${chainId}.`);
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deploying Robinhood V3 staging DEX", {
    chainId,
    deployer: await deployer.getAddress(),
  });

  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const SwapRouter = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await SwapRouter.deploy(await factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();

  await (await factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress())).wait();

  const deployment = {
    schemaVersion: 1,
    purpose: "robinhood-testnet-uniswap-v3-compatible-mock",
    chainId,
    feeTier: 3000,
    contracts: {
      weth9: await weth.getAddress(),
      factory: await factory.getAddress(),
      nonfungiblePositionManager: await positionManager.getAddress(),
      swapRouter02: await swapRouter.getAddress(),
    },
    productionCompatible: false,
    note: "Staging-only deterministic V3 interface harness. Never promote these addresses to production.",
  };

  console.log(JSON.stringify(deployment, null, 2));

  if (chainId === 46630) {
    const out = path.resolve("deployments/robinhood/testnet-v3-mock.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`Wrote ${out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

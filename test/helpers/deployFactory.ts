import { ethers } from "hardhat";
import { deployFactoryWithLocker } from "../../scripts/lib/deployFactoryWithLocker";

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

export async function deployLaunchFactory(routerAddress: string, treasuryRouterAddress: string) {
  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits("1", 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [routerAddress,
    treasuryRouterAddress,
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress()] })).factory;
  await factory.waitForDeployment();

  return { factory, campaignImplementation, priceFeed, graduationOracle };
}

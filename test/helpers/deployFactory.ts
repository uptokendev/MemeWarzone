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

  const factory = await (await deployFactoryWithLocker({
    factoryName: "LaunchFactory",
    args: [routerAddress, treasuryRouterAddress, await campaignImplementation.getAddress(), await graduationOracle.getAddress()],
  })).factory;
  await factory.waitForDeployment();

  // EVM launch generation: every campaign needs a native graduation adapter (IGraduationAdapterV2) and the
  // LaunchTokenDeployer before the first create, and the factory registers each coin's fee choice on the
  // router's creator vault. Legacy fixtures get the test doubles the generation's own specs use.
  const graduationAdapter = await wireEvmGenTestDoubles(factory, routerAddress, treasuryRouterAddress);

  return { factory, campaignImplementation, priceFeed, graduationOracle, graduationAdapter };
}

/**
 * Sets the native graduation adapter (MockGraduationAdapterEvmGen on the router's Topaz pool factory, LP to the
 * factory's locker) and the LaunchTokenDeployer, and binds the router's creator vault to the factory when it is the
 * choice-aware MockCreatorRewardsVaultEvmGen. V2 (Topaz) routers only.
 */
export async function wireEvmGenTestDoubles(factory: any, routerAddress: string, treasuryRouterAddress: string) {
  const dex = await ethers.getContractAt(["function poolFactory() view returns (address)", "function WETH() view returns (address)"], routerAddress);
  const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await dex.poolFactory(), await dex.WETH());
  await adapter.waitForDeployment();
  await (await adapter.setLocker(await factory.permanentLpLocker())).wait();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();
  await (await factory.setNativeGraduationAdapter(await adapter.getAddress())).wait();
  await (await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress())).wait();
  try {
    const router = await ethers.getContractAt(["function creatorRewardsVault() view returns (address)"], treasuryRouterAddress);
    const vault = await router.creatorRewardsVault();
    const mock = await ethers.getContractAt("MockCreatorRewardsVaultEvmGen", vault);
    if ((await ethers.provider.getCode(vault)) !== "0x") {
      await mock.factory(); // throws unless it is the mock
      await (await mock.setFactory(await factory.getAddress())).wait();
    }
  } catch {
    // not a choice-aware mock vault (or no creator vault): the test owns that wiring
  }
  return adapter;
}

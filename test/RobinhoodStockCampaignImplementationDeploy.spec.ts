import { expect } from "chai";
import { ethers } from "hardhat";

import {
  deployStockCampaignImplementation,
  readFactoryReadiness,
  stockImplementationBatch,
} from "../scripts/deploy-robinhood-stock-campaign-implementation";

const FEE = 3000;

async function freshFeed(price: string) {
  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const feed = await Feed.deploy(8);
  await feed.waitForDeployment();
  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block!.timestamp);
  await feed.setRoundData(1n, ethers.parseUnits(price, 8), now, now, 1n);
  return feed;
}

/** The mainnet shape: a V3-mode LaunchFactory with the stock adapter set and no stock implementation. */
async function fixture() {
  const [owner, routeSigner] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
  const positionManager = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3Factory.getAddress(), await weth.getAddress());
  const swapRouter = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3Factory.getAddress(), await weth.getAddress());
  await v3Factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());
  const nativeAdapter = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(
    await v3Factory.getAddress(), await positionManager.getAddress(), await weth.getAddress(), FEE,
  );
  const campaignImplementation = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  const treasury = await (await ethers.getContractFactory("MockPhase1TreasuryRouter")).deploy();
  const nativeFeed = await freshFeed("3000");
  const graduationOracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await nativeFeed.getAddress(), 30 * 24 * 60 * 60);
  const factory = await (await ethers.getContractFactory("LaunchFactory")).deploy(
    await nativeAdapter.getAddress(), await treasury.getAddress(), await campaignImplementation.getAddress(), await graduationOracle.getAddress(),
  );
  await factory.setRouteAuthority(await routeSigner.getAddress());
  const locker = await factory.permanentLpLocker();
  const stockAdapter = await (await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter")).deploy(
    await v3Factory.getAddress(), await positionManager.getAddress(), await swapRouter.getAddress(), await weth.getAddress(), locker, await nativeFeed.getAddress(), FEE, 3600,
  );
  await stockAdapter.setCampaignFactoryOnce(await factory.getAddress());
  await factory.setStockGraduationAdapter(await stockAdapter.getAddress());
  return { owner, factory, stockAdapter };
}

describe("Robinhood stock campaign implementation deployment", function () {
  it("reads the mainnet-shaped factory as ready, deploys the implementation, and the generated Safe call binds it", async function () {
    const { owner, factory } = await fixture();
    const factoryAddress = await factory.getAddress();
    const readiness = await readFactoryReadiness(factoryAddress);
    expect(readiness.campaigns).to.equal(0n);
    expect(readiness.liquidityKind).to.equal(2);
    expect(readiness.stockImplementation).to.equal(ethers.ZeroAddress);
    expect(readiness.owner).to.equal(owner.address);

    const implementation = await deployStockCampaignImplementation();
    expect(await ethers.provider.getCode(implementation)).to.not.equal("0x");

    // The exact bytes the Safe would sign, executed by the owner here.
    const batch = stockImplementationBatch(31337, factoryAddress, implementation);
    expect(batch.transactions).to.have.length(1);
    const tx = batch.transactions[0];
    expect(ethers.getAddress(tx.to)).to.equal(factoryAddress);
    expect(tx.contractMethod.name).to.equal("setStockCampaignImplementation");
    expect(tx.contractInputsValues.newImplementation).to.equal(implementation);
    await owner.sendTransaction({ to: tx.to, data: tx.data });
    expect(await factory.stockCampaignImplementation()).to.equal(implementation);

    // Idempotence guard: a second run refuses a factory that is already bound.
    await expect(readFactoryReadiness(factoryAddress)).to.be.rejectedWith(/already has stockCampaignImplementation/);
  });

  it("refuses a factory that already holds a campaign, and the setter itself reverts FactoryLocked -- why R5 runs before step H", async function () {
    const { owner, factory } = await fixture();
    const [, , creator] = await ethers.getSigners();
    const implementation = await deployStockCampaignImplementation();

    // The mainnet mistake, replayed: open the doors first and let one native campaign in.
    await factory.setConfig({
      totalSupply: ethers.parseEther("1000000000"), curveBps: 8400, liquidityTokenBps: 1400,
      basePrice: 1_000_000_000n, priceSlope: 850n, graduationTarget: ethers.parseEther("60"), liquidityBps: 3300,
    });
    await factory.setRequireRouteAuthorization(false);
    await factory.setRequireAuthorizedTrading(false);
    await factory.enableLive();
    await factory.setCreatePaused(false);
    await factory.connect(creator).createCampaign({
      name: "Native Meme", symbol: "NATIVE", logoURI: "ipfs://native", xAccount: "", website: "", extraLink: "",
      graduationTarget: ethers.parseEther("60"),
    });
    expect(await factory.campaignsCount()).to.equal(1n);

    await expect(readFactoryReadiness(await factory.getAddress())).to.be.rejectedWith(/already holds 1 campaign/);
    await expect(factory.setStockCampaignImplementation(implementation)).to.be.revertedWithCustomError(factory, "FactoryLocked");
    expect(await factory.stockCampaignImplementation()).to.equal(ethers.ZeroAddress);
  });
});

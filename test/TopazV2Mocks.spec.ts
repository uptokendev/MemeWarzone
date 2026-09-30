import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployLaunchFactory } from "./helpers/deployFactory";
import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";


const request = (overrides: Record<string, unknown> = {}) => ({
  name: "Topaz Token",
  symbol: "TOP",
  logoURI: "ipfs://topaz",
  xAccount: "",
  website: "",
  extraLink: "",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function deployTopazDex(wrappedAddress: string) {
  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const TopazRouter = await ethers.getContractFactory("MockTopazRouter");
  const topazRouter = await TopazRouter.deploy(await topazFactory.getAddress(), wrappedAddress);
  await topazRouter.waitForDeployment();

  return { topazFactory, topazRouter };
}

describe("Topaz v2 mocks", function () {
  it("keeps stable and volatile pools separate", async () => {
    const [owner, tokenA, tokenB] = await ethers.getSigners();
    const { topazFactory } = await deployTopazDex(await owner.getAddress());

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const volatilePool = await Pool.deploy();
    const stablePool = await Pool.deploy();

    await topazFactory.setPool(await tokenA.getAddress(), await tokenB.getAddress(), false, await volatilePool.getAddress());
    await topazFactory.setPool(await tokenA.getAddress(), await tokenB.getAddress(), true, await stablePool.getAddress());

    expect(await topazFactory.getPool(await tokenA.getAddress(), await tokenB.getAddress(), false)).to.equal(await volatilePool.getAddress());
    expect(await topazFactory.getPool(await tokenA.getAddress(), await tokenB.getAddress(), true)).to.equal(await stablePool.getAddress());
    expect(await volatilePool.stable()).to.equal(false);
    expect(await stablePool.stable()).to.equal(true);
  });

  it("graduates through a Topaz volatile pool and stores the pool address", async () => {
    const [owner, creator, trader] = await ethers.getSigners();
    const { topazFactory, topazRouter } = await deployTopazDex(await owner.getAddress());
    // V3: campaigns from this factory are strict and call routeTrade.
    const routing = await deployConfiguredTreasuryRouterV3(await owner.getAddress());
    const { factory, graduationAdapter } = await deployLaunchFactory(await topazRouter.getAddress(), await routing.treasuryRouter.getAddress());

    await factory.connect(owner).setRequireRouteAuthorization(false);
    await factory.connect(owner).setRequireAuthorizedTrading(false);
    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.005"),
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("0.005"),
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    });
    await factory.connect(owner).enableLive();

    await factory.connect(creator).createCampaign(request() as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", info.token);

    await network.provider.send("evm_setNextBlockTimestamp", [Number(await campaign.launchAt()) + 61]);
    await network.provider.send("evm_mine");

    const oneToken = ethers.parseUnits("1", 18);
    const quote = await campaign.quoteBuyExactTokens(oneToken);
    // C5: the crossing buy marks Pending; graduate() builds the pool through the native adapter.
    await expect(campaign.connect(trader).buyExactTokens(oneToken, quote, { value: quote })).to.emit(campaign, "GraduationPending");
    const tx = await campaign.connect(trader).graduate();
    await expect(tx).to.emit(campaign, "Graduated");
    expect(await graduationAdapter.calls()).to.equal(1n);
    const lr = await graduationAdapter.lastRequest();
    expect(lr.token).to.equal(await token.getAddress());
    expect(lr.quoteToken).to.equal(ethers.ZeroAddress);

    const stored = await campaign.getGraduationState();
    const volatilePool = await topazFactory.getPool(await token.getAddress(), await topazRouter.WETH(), false);
    expect(stored[0]).to.equal(volatilePool);
    expect(volatilePool).to.not.equal(ethers.ZeroAddress);
    expect(await (await ethers.getContractAt("MockTopazPool", volatilePool)).stable()).to.equal(false);
    expect(await topazFactory.getPool(await token.getAddress(), await topazRouter.WETH(), true)).to.equal(ethers.ZeroAddress);
  });

  it("rejects stable liquidity requests in the test router", async () => {
    const [owner] = await ethers.getSigners();
    const { topazRouter } = await deployTopazDex(await owner.getAddress());

    await expect(
      topazRouter.addLiquidityETH(ethers.ZeroAddress, true, 1n, 0n, 0n, await owner.getAddress(), 0n, { value: 1n })
    ).to.be.revertedWith("stable pool unsupported");
  });
});

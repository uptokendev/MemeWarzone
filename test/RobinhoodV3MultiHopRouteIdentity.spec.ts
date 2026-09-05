import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;

describe("RobinhoodV3MultiHopSwapAdapter route identity", function () {
  it("locks Stock Token and fee tiers after first configuration while allowing policy updates", async () => {
    const [owner] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("MockWETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();

    const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const Router = await ethers.getContractFactory("MockUniswapV3SwapRouter");
    const router = await Router.deploy(await factory.getAddress(), await weth.getAddress());
    await router.waitForDeployment();

    const Token = await ethers.getContractFactory("MockERC20");
    const meme = await Token.deploy("War Meme", "WAR", ethers.parseEther("1000"), await owner.getAddress());
    const stockA = await Token.deploy("Stock A", "STKA", ethers.parseEther("1000"), await owner.getAddress());
    const stockB = await Token.deploy("Stock B", "STKB", ethers.parseEther("1000"), await owner.getAddress());
    await Promise.all([meme.waitForDeployment(), stockA.waitForDeployment(), stockB.waitForDeployment()]);

    const Adapter = await ethers.getContractFactory("RobinhoodV3MultiHopSwapAdapter");
    const adapter = await Adapter.deploy(
      await factory.getAddress(),
      await router.getAddress(),
      await weth.getAddress(),
    );
    await adapter.waitForDeployment();

    await adapter.configureMarketRoute(
      await meme.getAddress(),
      await stockA.getAddress(),
      FEE,
      FEE,
      500,
      false,
    );

    // Operational policy may change without changing the canonical market identity.
    await adapter.configureMarketRoute(
      await meme.getAddress(),
      await stockA.getAddress(),
      FEE,
      FEE,
      250,
      false,
    );
    const route = await adapter.marketRoutes(await meme.getAddress());
    expect(route.stockToken).to.equal(await stockA.getAddress());
    expect(route.maxPriceImpactBps).to.equal(250n);

    await expect(
      adapter.configureMarketRoute(
        await meme.getAddress(),
        await stockB.getAddress(),
        FEE,
        FEE,
        250,
        false,
      ),
    ).to.be.revertedWithCustomError(adapter, "RouteIdentityLocked");

    await expect(
      adapter.configureMarketRoute(
        await meme.getAddress(),
        await stockA.getAddress(),
        500,
        FEE,
        250,
        false,
      ),
    ).to.be.revertedWithCustomError(adapter, "RouteIdentityLocked");
  });
});

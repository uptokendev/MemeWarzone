import { expect } from "chai";
import { ethers } from "hardhat";

import { assertFeedWithinMaxAge, configFor, graduationTargetFor, maxOracleAgeFor } from "../scripts/deploy-robinhood-quote-generation";

/**
 * The factory's default graduation target has to be one the factory allows on
 * the chain it is deployed to. The previous default, 10, was allowed nowhere,
 * and the acceptance harness hid it by passing its own $6 on every campaign.
 * This asks the factory's own pure view rather than restating the allow-list.
 */
describe("Robinhood generation config", function () {
  async function factoryView() {
    const [owner] = await ethers.getSigners();
    const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    await feed.waitForDeployment();
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 3600);
    await oracle.waitForDeployment();
    const routing = await (await import("./helpers/deployRouting")).deployConfiguredTreasuryRouterV3(await owner.getAddress());
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    await weth.waitForDeployment();
    const v3f = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    await v3f.waitForDeployment();
    const pm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3f.getAddress(), await weth.getAddress());
    await pm.waitForDeployment();
    const adapter = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(await v3f.getAddress(), await pm.getAddress(), await weth.getAddress(), 3000);
    await adapter.waitForDeployment();
    const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    await impl.waitForDeployment();
    const factory = await (await ethers.getContractFactory("LaunchFactory")).deploy(
      await adapter.getAddress(), await routing.treasuryRouter.getAddress(), await impl.getAddress(), await oracle.getAddress(),
    );
    await factory.waitForDeployment();
    return factory as any;
  }

  it("uses a default the factory allows on mainnet and on testnet", async function () {
    const factory = await factoryView();
    for (const chainId of [4663n, 46630n]) {
      const target = configFor(chainId).graduationTarget;
      expect(await factory.isGraduationTargetAllowedForChain(chainId, target), `chain ${chainId}`).to.equal(true);
    }
  });

  it("the old default of 10 was refused everywhere, which is why this test exists", async function () {
    const factory = await factoryView();
    const ten = ethers.parseEther("10");
    for (const chainId of [4663n, 46630n, 56n, 97n]) {
      expect(await factory.isGraduationTargetAllowedForChain(chainId, ten), `chain ${chainId}`).to.equal(false);
    }
  });

  it("mainnet gets the production target and the test target is testnet-only", async function () {
    const factory = await factoryView();
    expect(graduationTargetFor(4663n)).to.equal(ethers.parseEther("30000"));
    expect(graduationTargetFor(46630n)).to.equal(ethers.parseEther("6"));
    // The $6 target must never be accepted on a mainnet chain.
    expect(await factory.isGraduationTargetAllowedForChain(4663n, ethers.parseEther("6"))).to.equal(false);
    expect(await factory.isGraduationTargetAllowedForChain(56n, ethers.parseEther("6"))).to.equal(false);
  });

  describe("oracle max age", function () {
    it("mainnet covers Chainlink's 86,400 s heartbeat on Robinhood; testnet stays tight", function () {
      expect(maxOracleAgeFor(4663n)).to.be.greaterThanOrEqual(86_400);
      expect(maxOracleAgeFor(46630n)).to.equal(3600);
    });

    it("refuses a max age the live feed already exceeds", async function () {
      const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
      await feed.waitForDeployment();
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      // A price updated two hours ago, the age the real feed showed when checked.
      await (await (feed as any).setRoundData(1n, ethers.parseUnits("2663", 8), now - 7200, now - 7200, 1n)).wait();
      let rejection = "";
      try {
        await assertFeedWithinMaxAge(await feed.getAddress(), 3600, "test");
      } catch (error: any) {
        rejection = String(error?.message || error);
      }
      expect(rejection).to.match(/is 72\d\ds old .* above the 3600s/);
      await assertFeedWithinMaxAge(await feed.getAddress(), 90_000, "test");
    });
  });
});

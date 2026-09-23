import { expect } from "chai";
import { ethers } from "hardhat";

import { assertV3PiecesAgree, deployPrerequisites, DEFAULT_MONTHLY_CAP_USD } from "../scripts/deploy-robinhood-prerequisites";

/**
 * Rehearsal for scripts/deploy-robinhood-prerequisites.ts, the step Robinhood
 * mainnet needs before the router and the generation because nothing of ours
 * exists there. Drives the same deployments with the same wiring and checks
 * the two refusals that guard immutables: a feed already older than the max
 * age about to be burned in, and Uniswap pieces from different deployments.
 */
describe("Robinhood prerequisites deployment", function () {
  async function v3() {
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy(); await weth.waitForDeployment();
    const factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy(); await factory.waitForDeployment();
    const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await factory.getAddress(), await weth.getAddress()); await npm.waitForDeployment();
    return { weth, factory, npm };
  }
  async function feedAgedSeconds(age: number) {
    const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8); await feed.waitForDeployment();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await (feed as any).setRoundData(1n, ethers.parseUnits("2663", 8), now - age, now - age, 1n)).wait();
    return feed;
  }

  it("deploys and wires everything the router and generation take as inputs", async function () {
    const [owner, safe] = await ethers.getSigners();
    const S = await safe.getAddress();
    const { weth, factory, npm } = await v3();
    const feed = await feedAgedSeconds(7200);

    const c = await deployPrerequisites({
      chainId: 4663n, safe: S,
      nativeUsdFeed: await feed.getAddress(), v3Factory: await factory.getAddress(), positionManager: await npm.getAddress(), weth: await weth.getAddress(),
      maxOracleAgeSeconds: 90_000, monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD, log: () => {},
    });

    const oracle = await ethers.getContractAt("GraduationOracle", c.GraduationOracle);
    expect(await (oracle as any).maxPriceAge()).to.equal(90_000n);
    expect(await (oracle as any).priceFeed()).to.equal(await feed.getAddress());

    const monthly = await ethers.getContractAt("MonthlyLeagueTreasury", c.MonthlyLeagueTreasury);
    expect(await (monthly as any).oracle()).to.equal(c.GraduationOracle);
    expect(await (monthly as any).charityTreasury()).to.equal(c.CharityTreasury);
    expect(await (monthly as any).multisig()).to.equal(S);
    expect(await (monthly as any).rootPoster()).to.equal(ethers.ZeroAddress);
    expect(await (monthly as any).monthlyCapUsd()).to.equal(DEFAULT_MONTHLY_CAP_USD);

    const weekly = await ethers.getContractAt("TreasuryVaultV2", c.WeeklyLeagueVault);
    expect(await (weekly as any).multisig()).to.equal(S);
    expect(await (weekly as any).operator()).to.equal(ethers.ZeroAddress);

    const adapter = await ethers.getContractAt("RobinhoodUniswapV3GraduationAdapter", c.RobinhoodUniswapV3GraduationAdapter);
    expect(await (adapter as any).liquidityKind()).to.equal(2n);
    expect(await (adapter as any).feeTier()).to.equal(3000n);

    // The one thing the generation script will do with the adapter: build a
    // factory on it. That is where a wrong liquidity kind would surface.
    const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy(); await impl.waitForDeployment();
    // A throwaway router for the factory build; its admin is whoever wires it.
    const routing = await (await import("./helpers/deployRouting")).deployConfiguredTreasuryRouterV3(await owner.getAddress());
    const lf = await (await ethers.getContractFactory("LaunchFactory")).deploy(c.RobinhoodUniswapV3GraduationAdapter, await routing.treasuryRouter.getAddress(), await impl.getAddress(), c.GraduationOracle);
    await lf.waitForDeployment();
    expect(await (lf as any).liquidityKind()).to.equal(2n);
  });

  it("refuses a max age the feed already exceeds, before the oracle is made immutable", async function () {
    const [, safe] = await ethers.getSigners();
    const { weth, factory, npm } = await v3();
    const feed = await feedAgedSeconds(7200);
    let message = "";
    try {
      await deployPrerequisites({ chainId: 4663n, safe: await safe.getAddress(), nativeUsdFeed: await feed.getAddress(), v3Factory: await factory.getAddress(), positionManager: await npm.getAddress(), weth: await weth.getAddress(), maxOracleAgeSeconds: 3600, monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD, log: () => {} });
    } catch (error: any) { message = String(error?.message || error); }
    expect(message).to.match(/above the 3600s max age/);
  });

  it("refuses Uniswap pieces that belong to different deployments", async function () {
    const a = await v3();
    const b = await v3();
    let message = "";
    try { await assertV3PiecesAgree(await a.factory.getAddress(), await b.npm.getAddress(), await a.weth.getAddress()); } catch (error: any) { message = String(error?.message || error); }
    expect(message).to.match(/reports factory/);
    message = "";
    try { await assertV3PiecesAgree(await a.factory.getAddress(), await a.npm.getAddress(), await b.weth.getAddress()); } catch (error: any) { message = String(error?.message || error); }
    expect(message).to.match(/reports WETH9/);
    await assertV3PiecesAgree(await a.factory.getAddress(), await a.npm.getAddress(), await a.weth.getAddress());
  });
});

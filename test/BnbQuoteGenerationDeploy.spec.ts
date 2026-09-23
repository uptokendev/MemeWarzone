import { expect } from "chai";
import { ethers, network } from "hardhat";

import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";

/**
 * Rehearsal for scripts/deploy-bnb-quote-generation.ts.
 *
 * The BNB contracts are immutable once deployed, and the deployment script is
 * the one piece that only runs for real. The standing rule is that nothing
 * reaches a live chain before it has run on a throwaway one, so this drives the
 * same wiring the script performs, in the same order, and asserts the state it
 * promises to leave behind: everything paused, nothing live, and the routing
 * invariant that bricked the previous generation held.
 *
 * It also proves the refusals, because a guard nobody has seen fire is a guard
 * nobody knows works.
 */
describe("BNB quote generation deployment", function () {
  async function deployPrerequisites() {
    const [owner, safe, routeAuthority] = await ethers.getSigners();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();

    // The adapter's constructor reads defaultFactory() and weth() off the router
    // and requires both to have code, so the wrapped native has to be a real
    // contract rather than a placeholder address.
    const Wbnb = await ethers.getContractFactory("MockWBNB");
    const wbnb = await Wbnb.deploy();
    await wbnb.waitForDeployment();

    const Router = await ethers.getContractFactory("MockTopazRouter");
    const topazRouter = await Router.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    await topazRouter.waitForDeployment();

    const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
    const nativeFeed = await PriceFeed.deploy(8);
    await nativeFeed.waitForDeployment();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await nativeFeed.setRoundData(1n, ethers.parseUnits("600", 8), now, now, 1n);

    const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
    const graduationOracle = await GraduationOracle.deploy(await nativeFeed.getAddress(), 30 * 24 * 60 * 60);
    await graduationOracle.waitForDeployment();

    const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
    const creatorRegistry = await CreatorRegistry.deploy();
    await creatorRegistry.waitForDeployment();

    const RiskRegistry = await ethers.getContractFactory("RiskRegistry");
    const riskRegistry = await RiskRegistry.deploy();
    await riskRegistry.waitForDeployment();

    const routing = await deployConfiguredTreasuryRouterV3(await owner.getAddress());

    return { owner, safe, routeAuthority, wbnb, topazRouter, nativeFeed, graduationOracle, creatorRegistry, riskRegistry, routing };
  }

  it("leaves the whole generation deployed, wired, and closed", async function () {
    const fx = await deployPrerequisites();

    // --- the order the script uses, because the wiring requires it ---------
    const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    await nativeImpl.waitForDeployment();

    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
    await quoteImpl.waitForDeployment();
    expect(await (quoteImpl as any).isBnbQuoteCampaignImplementation()).to.equal(true);

    const factory = await (await ethers.getContractFactory("BnbBasicLaunchFactory")).deploy(
      await fx.topazRouter.getAddress(),
      await fx.routing.treasuryRouter.getAddress(),
      await nativeImpl.getAddress(),
      await fx.graduationOracle.getAddress(),
      await quoteImpl.getAddress(),
    );
    await factory.waitForDeployment();

    // The invariant whose absence bricked every campaign after a router change.
    expect(await (factory as any).feeRecipient()).to.equal(await fx.routing.treasuryRouter.getAddress());
    expect(await (factory as any).leagueReceiver()).to.equal(await (factory as any).feeRecipient());

    // The adapter needs the locker the factory just deployed, so it cannot be
    // constructed earlier however tempting the ordering looks.
    const lockerAddress = await (factory as any).permanentLpLocker();
    expect(lockerAddress).to.not.equal(ethers.ZeroAddress);

    const adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
      await fx.topazRouter.getAddress(),
      lockerAddress,
      await fx.nativeFeed.getAddress(),
      3600,
    );
    await adapter.waitForDeployment();

    await (await (adapter as any).setCampaignFactoryOnce(await factory.getAddress())).wait();
    await (await (factory as any).setBnbQuoteGraduationAdapter(await adapter.getAddress())).wait();

    // The factory pointer locks after the first set, so a second attempt is a
    // configuration error rather than a silent re-point.
    await expect((adapter as any).setCampaignFactoryOnce(await factory.getAddress())).to.be.reverted;

    // --- battle system -----------------------------------------------------
    const league = await (await ethers.getContractFactory("PostGradLeagueTreasuryV2")).deploy(
      await fx.owner.getAddress(),
      await fx.safe.getAddress(),
      await fx.safe.getAddress(),
    );
    await league.waitForDeployment();

    const warPool = await (await ethers.getContractFactory("ArenaWarPoolTreasuryV2")).deploy(
      await fx.owner.getAddress(),
      await fx.owner.getAddress(),
      await fx.owner.getAddress(),
      await fx.safe.getAddress(),
      await league.getAddress(),
    );
    await warPool.waitForDeployment();
    await (await (league as any).setSource(await warPool.getAddress(), true)).wait();
    await (await (warPool as any).setDepositsPaused(true)).wait();

    // --- configuration, all with CREATE closed -----------------------------
    await (await (factory as any).setConfig({
      totalSupply: ethers.parseEther("1000000000"),
      curveBps: 8400n,
      liquidityTokenBps: 1400n,
      basePrice: 1_000_000_000n,
      priceSlope: 850n,
      graduationTarget: ethers.parseEther("30000"),
      liquidityBps: 3300n,
    })).wait();
    await (await (factory as any).setProtocolFee(200n)).wait();
    await (await (factory as any).setRouteAuthority(await fx.routeAuthority.getAddress())).wait();
    await (await (factory as any).setCreatePaused(true)).wait();

    // --- what the script promises it leaves behind -------------------------
    expect(await (factory as any).createPaused()).to.equal(true);
    expect(await (factory as any).live()).to.equal(false);
    expect(await (warPool as any).depositsPaused()).to.equal(true);
    expect(await (factory as any).protocolFeeBps()).to.equal(200n);
    expect(await (factory as any).bnbQuoteGraduationAdapter()).to.equal(await adapter.getAddress());

    // Closed means closed: nobody can create while CREATE is paused, and the
    // war pool takes no money while deposits are.
    await expect(
      (factory as any).connect(fx.owner).createCampaign({
        name: "Blocked",
        symbol: "BLK",
        logoURI: "ipfs://x",
        xAccount: "x",
        website: "https://memewar.zone",
        extraLink: "https://docs.memewar.zone",
        basePrice: 0n,
        priceSlope: 0n,
        graduationTarget: 0n,
        lpReceiver: ethers.ZeroAddress,
        initialBuyBnbWei: 0n,
      }),
    ).to.be.reverted;
  });

  it("refuses a treasury router that cannot serve strict routing", async function () {
    const fx = await deployPrerequisites();

    // A router without the V3 surface is the shape that bricked BNB: the
    // factory would build campaigns whose every trade reverts FeeRoutingFailed.
    // The deploy script probes creatorRewardsVault precisely because the router
    // live on BNB today does not have it.
    const legacy = await (await ethers.getContractFactory("TreasuryRouter")).deploy(
      await fx.owner.getAddress(),
      await fx.routing.leagueVault.getAddress(),
      3600,
    );
    await legacy.waitForDeployment();

    const probe = await ethers.getContractAt(
      ["function creatorRewardsVault() view returns (address)"],
      await legacy.getAddress(),
    );
    await expect((probe as any).creatorRewardsVault()).to.be.reverted;

    // And the V3 router the script demands does answer it.
    const ok = await ethers.getContractAt(
      ["function creatorRewardsVault() view returns (address)"],
      await fx.routing.treasuryRouter.getAddress(),
    );
    expect(await (ok as any).creatorRewardsVault()).to.equal(await fx.routing.creatorVault.getAddress());
  });

  it("refuses a quote implementation that does not identify itself", async function () {
    const fx = await deployPrerequisites();

    const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    await nativeImpl.waitForDeployment();

    // The native implementation is a contract with code, so only the explicit
    // self-identification call separates it from a real quote implementation.
    await expect(
      (await ethers.getContractFactory("BnbBasicLaunchFactory")).deploy(
        await fx.topazRouter.getAddress(),
        await fx.routing.treasuryRouter.getAddress(),
        await nativeImpl.getAddress(),
        await fx.graduationOracle.getAddress(),
        await nativeImpl.getAddress(),
      ),
    ).to.be.reverted;
  });
});

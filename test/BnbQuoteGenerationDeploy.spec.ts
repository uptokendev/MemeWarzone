import { expect } from "chai";
import { ethers, network } from "hardhat";

import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";
import { assertTopazRoutersFit } from "../scripts/deploy-bnb-quote-generation";

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

  /**
   * The gap the first three tests could not see.
   *
   * They deploy the registries and then never hand them to the factory, so two
   * defects in the deployment script survived: it called setCreatorRegistry and
   * setRiskRegistry, neither of which exists on LaunchFactory (the real setter
   * is setRegistries, taking both), and it never registered the factory as a
   * launch recorder. createCampaign calls creatorRegistry.recordLaunch behind
   * onlyLaunchRecorder, so an unregistered factory cannot create one campaign --
   * on any chain, mainnet included. This drives a real create, which is the only
   * thing that shows either.
   */
  it("wires the registries through the one setter that exists, and cannot create until it is a launch recorder", async function () {
    const fx = await deployPrerequisites();
    const [, , , creator] = await ethers.getSigners();

    const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    await nativeImpl.waitForDeployment();
    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
    await quoteImpl.waitForDeployment();

    const factory = await (await ethers.getContractFactory("BnbBasicLaunchFactory")).deploy(
      await fx.topazRouter.getAddress(),
      await fx.routing.treasuryRouter.getAddress(),
      await nativeImpl.getAddress(),
      await fx.graduationOracle.getAddress(),
      await quoteImpl.getAddress(),
    );
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();

    // There is no setCreatorRegistry and no setRiskRegistry. The script called
    // both, and the ABI has neither, so the call could only ever have failed.
    expect((factory as any).interface.getFunction("setCreatorRegistry")).to.equal(null);
    expect((factory as any).interface.getFunction("setRiskRegistry")).to.equal(null);
    expect((factory as any).setCreatorRegistry).to.equal(undefined);
    expect((factory as any).setRiskRegistry).to.equal(undefined);

    await (await (factory as any).setRegistries(
      await fx.creatorRegistry.getAddress(),
      await fx.riskRegistry.getAddress(),
    )).wait();
    expect(await (factory as any).creatorRegistry()).to.equal(await fx.creatorRegistry.getAddress());
    expect(await (factory as any).riskRegistry()).to.equal(await fx.riskRegistry.getAddress());

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

    // Open every other gate, so the only thing left standing is the recorder.
    await (await (factory as any).setRequireRouteAuthorization(false)).wait();
    await (await (factory as any).enableLive()).wait();
    await (await (factory as any).setCreatePaused(false)).wait();

    const request = {
      name: "Recorder",
      symbol: "REC",
      logoURI: "ipfs://x",
      xAccount: "x",
      website: "https://memewar.zone",
      extraLink: "https://docs.memewar.zone",
      basePrice: 0n,
      priceSlope: 0n,
      graduationTarget: 0n,
      lpReceiver: ethers.ZeroAddress,
      initialBuyBnbWei: 0n,
    };

    expect(await (fx.creatorRegistry as any).launchRecorder(factoryAddress)).to.equal(false);
    await expect(
      (factory as any).connect(creator).createCampaign(request),
    ).to.be.revertedWithCustomError(fx.creatorRegistry, "NotLaunchRecorder");

    // The one call the script was missing.
    await (await (fx.creatorRegistry as any).setLaunchRecorder(factoryAddress, true)).wait();
    expect(await (fx.creatorRegistry as any).launchRecorder(factoryAddress)).to.equal(true);

    await expect((factory as any).connect(creator).createCampaign(request)).to.not.be.reverted;

    // And the launch actually landed on the creator's profile, which is the
    // whole reason the registry is in the path.
    const profile = await (fx.creatorRegistry as any).getCreatorProfile(await creator.getAddress());
    expect(profile.liveBondingCount).to.equal(1n);
  });

  /**
   * Two Topaz addresses, not one, and they are not interchangeable.
   *
   * LaunchFactory's constructor calls poolFactory(); BnbQuoteGraduationAdapter's
   * calls defaultFactory() and weth(). On BNB mainnet the adapter answers only
   * the first and Topaz's router only the second -- so the profile that pinned a
   * single address for both would have reverted a constructor on the real chain.
   * The script now checks before it spends, and this proves the check fires.
   */
  describe("the two Topaz routers", function () {
    async function topazPair() {
      const factory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
      await factory.waitForDeployment();
      const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
      await wbnb.waitForDeployment();
      // Answers all four, so it can stand in for either side.
      const full = await (await ethers.getContractFactory("MockTopazRouter")).deploy(
        await factory.getAddress(),
        await wbnb.getAddress(),
      );
      await full.waitForDeployment();
      // Answers only the factory side.
      const adapterOnly = await (await ethers.getContractFactory("MockTopazAdapterOnly")).deploy(
        await factory.getAddress(),
        await wbnb.getAddress(),
      );
      await adapterOnly.waitForDeployment();
      return { factory, wbnb, full, adapterOnly };
    }

    it("accepts a pair that agrees on the pool factory and the wrapped native", async function () {
      const { full } = await topazPair();
      await assertTopazRoutersFit(await full.getAddress(), await full.getAddress());
    });

    it("refuses the adapter where the quote adapter's router belongs", async function () {
      const { adapterOnly } = await topazPair();
      // This is the swap that reverts BnbQuoteGraduationAdapter's constructor.
      await expect(
        assertTopazRoutersFit(await adapterOnly.getAddress(), await adapterOnly.getAddress()),
      ).to.be.rejectedWith(/no defaultFactory\(\)\/weth\(\)/);
    });

    it("refuses a router that cannot answer poolFactory where the factory belongs", async function () {
      const { full, wbnb } = await topazPair();
      // MockWBNB has code but none of the router surface, standing in for
      // Topaz's own router, which reverts poolFactory() on both real chains.
      await expect(
        assertTopazRoutersFit(await wbnb.getAddress(), await full.getAddress()),
      ).to.be.rejectedWith(/no poolFactory\(\)/);
    });

    it("refuses two routers pointing at different Topaz deployments", async function () {
      const { full, wbnb } = await topazPair();
      const otherFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
      await otherFactory.waitForDeployment();
      const strayAdapter = await (await ethers.getContractFactory("MockTopazAdapterOnly")).deploy(
        await otherFactory.getAddress(),
        await wbnb.getAddress(),
      );
      await strayAdapter.waitForDeployment();

      // The quiet failure: both constructors succeed, and the graduation builds
      // its pool on a Topaz the campaign never trades against.
      await expect(
        assertTopazRoutersFit(await strayAdapter.getAddress(), await full.getAddress()),
      ).to.be.rejectedWith(/disagree on the pool factory/);
    });
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

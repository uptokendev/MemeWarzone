import { expect } from "chai";
import { ethers, network } from "hardhat";

import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertRouterCanServeStrictRouting, assertTopazRoutersFit, main as deployQuoteGeneration } from "../scripts/deploy-bnb-quote-generation";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { wireGenerationCreatePath } from "../scripts/lib/evmGenerationCreateWiring";
import { E, req, signCreate } from "./fixtures/evmgenCore";

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

    const factory = await (await deployFactoryWithLocker({ factoryName: "BnbBasicLaunchFactory", args: [await fx.topazRouter.getAddress(),
      await fx.routing.treasuryRouter.getAddress(),
      await nativeImpl.getAddress(),
      await fx.graduationOracle.getAddress(),
      await quoteImpl.getAddress()] })).factory;
    await factory.waitForDeployment();

    // The invariant whose absence bricked every campaign after a router change.
    expect(await (factory as any).feeRecipient()).to.equal(await fx.routing.treasuryRouter.getAddress());
    expect(await (factory as any).leagueReceiver()).to.equal(await (factory as any).feeRecipient());

    // The adapter needs the locker the factory just deployed, so it cannot be
    // constructed earlier however tempting the ordering looks.
    const lockerAddress = await (factory as any).permanentLpLocker();
    expect(lockerAddress).to.not.equal(ethers.ZeroAddress);

    const nativeAdapter = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(
      await fx.topazRouter.poolFactory(),
      await fx.wbnb.getAddress(),
      lockerAddress,
    );
    await nativeAdapter.waitForDeployment();

    const adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
      await fx.topazRouter.getAddress(),
      lockerAddress,
      await fx.nativeFeed.getAddress(),
      3600,
    );
    await adapter.waitForDeployment();

    await (await (nativeAdapter as any).setCampaignFactoryOnce(await factory.getAddress())).wait();
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
      curveBps: 7000n,
      liquidityTokenBps: 2800n,
      basePrice: 1_000_000_000n,
      priceSlope: 1080n,
      graduationTarget: ethers.parseEther("30000"),
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
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
        firstBuyTokens: 0n,
        firstBuyMaxCost: 0n,
        feeChoice: 1,
        feeCreatorPct: 0,
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

    const factory = await (await deployFactoryWithLocker({ factoryName: "BnbBasicLaunchFactory", args: [await fx.topazRouter.getAddress(),
      await fx.routing.treasuryRouter.getAddress(),
      await nativeImpl.getAddress(),
      await fx.graduationOracle.getAddress(),
      await quoteImpl.getAddress()] })).factory;
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
      curveBps: 7000n,
      liquidityTokenBps: 2800n,
      basePrice: 1_000_000_000n,
      priceSlope: 1080n,
      graduationTarget: ethers.parseEther("30000"),
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
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
      graduationTarget: 0n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    };

    // The copy above deploys both adapters and binds them on the adapter side, but does not call
    // factory.setNativeGraduationAdapter (that lives in wireGenerationCreatePath). Create still
    // reverts until that setter and the token deployer land.
    await expect(
      (factory as any).connect(creator).createCampaign(request),
    ).to.be.revertedWithCustomError(factory, "NativeGraduationAdapterUnavailable");

    const lockerAddress = await (factory as any).permanentLpLocker();
    const nativeAdapter = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(
      await fx.topazRouter.poolFactory(),
      await fx.wbnb.getAddress(),
      lockerAddress,
    );
    await nativeAdapter.waitForDeployment();
    await (await (factory as any).setNativeGraduationAdapter(await nativeAdapter.getAddress())).wait();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    await (await (factory as any).setLaunchTokenDeployer(await tokenDeployer.getAddress())).wait();
    await (await (fx.routing.creatorVault as any).setFactory(factoryAddress)).wait();

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

    it("refuses a Topaz on any fee tier but the one the locker requires", async function () {
      const { factory, full } = await topazPair();

      // BSC testnet has two Topaz deployments. The one the older deployment
      // records point at charges 100 bps; the authoritative manifest's charges
      // 30, like BNB mainnet. Nothing in the addresses says which is which, and
      // the whole generation was deployed against the 100 bps one before this
      // check existed. (Before E13 the locker also refused any fee but 30 at
      // graduation; it now records the real fee, and this guard enforces E6.)
      await (await (factory as any).setFeeBps(100n)).wait();
      await expect(
        assertTopazRoutersFit(await full.getAddress(), await full.getAddress()),
      ).to.be.rejectedWith(/charges 100 bps[\s\S]*E6 requires 30 bps/);

      await (await (factory as any).setFeeBps(30n)).wait();
      await assertTopazRoutersFit(await full.getAddress(), await full.getAddress());
    });

    it("E13: the locker no longer pins 30 bps; the deploy guard is E6's intended Topaz, not a locker rule", async function () {
      const [owner] = await ethers.getSigners();
      const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(await owner.getAddress());
      await locker.waitForDeployment();
      expect((locker as any).REQUIRED_POOL_FEE_BPS).to.equal(undefined);
      expect(await (locker as any).REQUIRED_LIQUIDITY_KIND()).to.equal(1n);
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
    // A correctly bound locker, so the refusal can only come from the quote implementation check.
    const [signer] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(await signer.getAddress(), "pending");
    const predicted = ethers.getCreateAddress({ from: await signer.getAddress(), nonce: nonce + 1 });
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(predicted);
    await locker.waitForDeployment();
    const BasicFactory = await ethers.getContractFactory("BnbBasicLaunchFactory");
    await expect(
      BasicFactory.deploy(
        await fx.topazRouter.getAddress(),
        await fx.routing.treasuryRouter.getAddress(),
        await nativeImpl.getAddress(),
        await fx.graduationOracle.getAddress(),
        await nativeImpl.getAddress(),
        await locker.getAddress(),
      ),
    ).to.be.revertedWithCustomError(BasicFactory, "BnbQuoteCampaignImplementationUnavailable");
  });

  /**
   * The generation's real fee path: TreasuryRouterV4 whose creatorRewardsVault() is a
   * CreatorRewardsVaultV2 paying that router, on the Topaz mocks. This is what the script now demands.
   */
  async function deployGenerationRouting(admin: string, topazFactory: string, wbnb: string) {
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const weekly = await Receiver.deploy();
    const monthly = await Receiver.deploy();
    const recruiter = await Receiver.deploy();
    const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
    const protocolVault = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(admin);
    const creatorVault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
      admin, await router.getAddress(), wbnb, 1, topazFactory, 24 * 60 * 60,
    );
    await (await router.setRecruiterRewardsVault(await recruiter.getAddress())).wait();
    await (await router.setCommunityRewardsVault(await community.getAddress())).wait();
    await (await router.setProtocolRevenueVault(await protocolVault.getAddress())).wait();
    await (await router.setCreatorRewardsVault(await creatorVault.getAddress())).wait();
    return { router, creatorVault, weekly, monthly };
  }

  describe("the script itself, run on the throwaway chain", function () {
    const ENV_KEYS = [
      "CONFIRM_BNB_QUOTE_GENERATION", "BNB_TOPAZ_ROUTER", "BNB_TOPAZ_QUOTE_ROUTER", "BNB_GRADUATION_ORACLE",
      "BNB_ROUTE_AUTHORITY", "BNB_TREASURY_ROUTER", "BNB_NATIVE_USD_FEED",
      "BNB_OWNER_SAFE", "BNB_CREATOR_REGISTRY", "BNB_RISK_REGISTRY", "QUOTE_GEN_OUT",
    ];
    let saved: Record<string, string | undefined>;
    let outDir: string;
    beforeEach(function () {
      saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
      for (const k of ENV_KEYS) delete process.env[k];
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-quote-gen-"));
    });
    afterEach(function () {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(outDir, { recursive: true, force: true });
    });

    async function scriptInputs() {
      const fx = await deployPrerequisites();
      const topazFactory = await fx.topazRouter.poolFactory();
      const routing = await deployGenerationRouting(await fx.owner.getAddress(), topazFactory, await fx.wbnb.getAddress());
      Object.assign(process.env, {
        CONFIRM_BNB_QUOTE_GENERATION: "I_UNDERSTAND_REHEARSAL",
        BNB_TOPAZ_ROUTER: await fx.topazRouter.getAddress(),
        BNB_TOPAZ_QUOTE_ROUTER: await fx.topazRouter.getAddress(),
        BNB_GRADUATION_ORACLE: await fx.graduationOracle.getAddress(),
        BNB_ROUTE_AUTHORITY: await fx.routeAuthority.getAddress(),
        BNB_TREASURY_ROUTER: await routing.router.getAddress(),
        BNB_NATIVE_USD_FEED: await fx.nativeFeed.getAddress(),
        QUOTE_GEN_OUT: path.join(outDir, "rehearsal.json"),
      });
      return { fx, routing };
    }

    it("leaves a closed factory that can create the moment it is opened", async function () {
      this.timeout(120_000);
      const { fx, routing } = await scriptInputs();
      const artifact: any = await deployQuoteGeneration();

      expect(artifact.createPathWired).to.equal(true);
      expect(artifact.launchRecorderWired).to.equal(true);
      expect(artifact.lpLockerAuthorized).to.equal(true);
      expect(artifact.pendingOwnerActions).to.deep.equal([]);
      expect(JSON.parse(fs.readFileSync(process.env.QUOTE_GEN_OUT!, "utf8")).contracts.LaunchTokenDeployer)
        .to.equal(artifact.contracts.LaunchTokenDeployer);

      const factory: any = await ethers.getContractAt("BnbBasicLaunchFactory", artifact.contracts.BnbBasicLaunchFactory);
      expect(await factory.nativeGraduationAdapter()).to.equal(artifact.contracts.BnbNativeGraduationAdapter);
      expect(artifact.contracts.BnbNativeGraduationAdapter).to.not.equal(ethers.ZeroAddress);
      expect(await factory.launchTokenDeployer()).to.equal(artifact.contracts.LaunchTokenDeployer);
      expect(await routing.creatorVault.factory()).to.equal(await factory.getAddress());
      expect(await factory.createPaused()).to.equal(true);
      expect(await factory.live()).to.equal(false);

      const nativeOnChain: any = await ethers.getContractAt("BnbNativeGraduationAdapter", artifact.contracts.BnbNativeGraduationAdapter);
      expect(await nativeOnChain.topazFactory()).to.equal(await fx.topazRouter.poolFactory());
      expect(await nativeOnChain.WBNB()).to.equal(await fx.wbnb.getAddress());
      expect(await nativeOnChain.permanentLpLocker()).to.equal(artifact.contracts.PermanentLpLocker);
      expect(await nativeOnChain.campaignFactory()).to.equal(artifact.contracts.BnbBasicLaunchFactory);

      // Closed as promised...
      const [, , , creator] = await ethers.getSigners();
      const request = req({ name: "Opened", symbol: "OPEN", logoURI: "ipfs://open" });
      const auth = await signCreate(fx.routeAuthority, await factory.getAddress(), creator.address, request);
      await expect(factory.connect(creator).createCampaignAuthorized(request, auth)).to.be.reverted;

      // ...and opening is the only step left: no further wiring is needed for a create to land.
      await (await factory.enableLive()).wait();
      await (await factory.setCreatePaused(false)).wait();
      await expect(factory.connect(creator).createCampaignAuthorized(request, auth)).to.emit(routing.creatorVault, "CampaignChoiceSet");
      expect(await factory.campaignsCount()).to.equal(1n);
    });

    it("deploys BnbNativeGraduationAdapter after the factory and binds it on both sides", async function () {
      this.timeout(120_000);
      const { fx } = await scriptInputs();
      const artifact: any = await deployQuoteGeneration();
      const native: any = await ethers.getContractAt("BnbNativeGraduationAdapter", artifact.contracts.BnbNativeGraduationAdapter);
      const quote: any = await ethers.getContractAt("BnbQuoteGraduationAdapter", artifact.contracts.BnbQuoteGraduationAdapter);
      const factory: any = await ethers.getContractAt("BnbBasicLaunchFactory", artifact.contracts.BnbBasicLaunchFactory);
      expect(await native.campaignFactoryLocked()).to.equal(true);
      expect(await quote.campaignFactoryLocked()).to.equal(true);
      expect(await factory.bnbQuoteGraduationAdapter()).to.equal(artifact.contracts.BnbQuoteGraduationAdapter);
      expect(await factory.nativeGraduationAdapter()).to.equal(artifact.contracts.BnbNativeGraduationAdapter);
      expect(await quote.topazFactory()).to.equal(await fx.topazRouter.poolFactory());
      expect(await quote.WBNB()).to.equal(await fx.wbnb.getAddress());
    });
  });

  it("returns the create wiring as owner actions when the factory belongs to the Safe, and they are sufficient", async function () {
    const fx = await deployPrerequisites();
    const [, , , creator] = await ethers.getSigners();
    const topazFactory = await fx.topazRouter.poolFactory();
    const routing = await deployGenerationRouting(await fx.owner.getAddress(), topazFactory, await fx.wbnb.getAddress());
    const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
    const { factory } = await deployFactoryWithLocker({ factoryName: "BnbBasicLaunchFactory", args: [
      await fx.topazRouter.getAddress(), await routing.router.getAddress(), await nativeImpl.getAddress(),
      await fx.graduationOracle.getAddress(), await quoteImpl.getAddress(),
    ] });
    const f: any = factory;
    await (await f.setRegistries(await fx.creatorRegistry.getAddress(), await fx.riskRegistry.getAddress())).wait();
    await (await (fx.creatorRegistry as any).setLaunchRecorder(await f.getAddress(), true)).wait();
    await (await f.setRouteAuthority(await fx.routeAuthority.getAddress())).wait();
    await (await f.enableLive()).wait();
    await (await f.transferOwnership(await fx.safe.getAddress())).wait();
    const nativeAdapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(topazFactory, await fx.wbnb.getAddress());

    // The deployer is neither factory owner nor vault admin here: nothing is sent, all three are returned.
    const wiring = await wireGenerationCreatePath({
      factoryAddress: await f.getAddress(),
      nativeGraduationAdapter: await nativeAdapter.getAddress(),
      creatorVault: await routing.creatorVault.getAddress(),
      senderAddress: await creator.getAddress(),
    });
    expect(wiring.wired).to.equal(false);
    expect(wiring.ownerActions.map((a) => a.why.split("(")[0])).to.deep.equal(["setNativeGraduationAdapter", "setLaunchTokenDeployer", "setFactoryOnce"]);
    expect(await f.nativeGraduationAdapter()).to.equal(ethers.ZeroAddress);

    const request = req({ name: "Safe", symbol: "SAFE", logoURI: "ipfs://safe" });
    const auth = await signCreate(fx.routeAuthority, await f.getAddress(), creator.address, request);
    await expect(f.connect(creator).createCampaignAuthorized(request, auth)).to.be.revertedWithCustomError(f, "NativeGraduationAdapterUnavailable");

    // Executing exactly the returned calls (factory ones from the Safe, the vault pin from the vault admin) opens create.
    for (const action of wiring.ownerActions) {
      const from = action.to.toLowerCase() === (await f.getAddress()).toLowerCase() ? fx.safe : fx.owner;
      await (await from.sendTransaction({ to: action.to, data: action.data })).wait();
    }
    await expect(f.connect(creator).createCampaignAuthorized(request, auth)).to.not.be.reverted;
  });

  describe("the router's creator vault", function () {
    async function routingFixture() {
      const fx = await deployPrerequisites();
      const topazFactory = await fx.topazRouter.poolFactory();
      const routing = await deployGenerationRouting(await fx.owner.getAddress(), topazFactory, await fx.wbnb.getAddress());
      return { fx, topazFactory, routing };
    }

    it("accepts TreasuryRouterV4 with an unpinned CreatorRewardsVaultV2 that pays it", async function () {
      const { routing } = await routingFixture();
      await assertRouterCanServeStrictRouting(await routing.router.getAddress());
    });

    it("refuses a router whose creatorRewardsVault() is the first-generation vault (the live BNB V3 router's shape)", async function () {
      const { fx } = await routingFixture();
      // TreasuryRouterV3 + CreatorRewardsVault: every presence check passes, and every create would revert,
      // because the first vault has no setCampaignChoice.
      const v3 = fx.routing.treasuryRouter;
      const v1Vault = await (await ethers.getContractFactory("CreatorRewardsVault")).deploy(await fx.owner.getAddress(), await v3.getAddress());
      const fresh = await (await ethers.getContractFactory("TreasuryRouterV3")).deploy(
        await fx.owner.getAddress(), await fx.routing.leagueVault.getAddress(), await fx.routing.monthlyVault.getAddress(), 3600,
      );
      await (await fresh.setRecruiterRewardsVault(await fx.routing.recruiterVault.getAddress())).wait();
      await (await fresh.setCommunityRewardsVault(await fx.routing.communityVault.getAddress())).wait();
      await (await fresh.setProtocolRevenueVault(await fx.routing.protocolVault.getAddress())).wait();
      await (await fresh.setCreatorRewardsVault(await v1Vault.getAddress())).wait();
      await expect(assertRouterCanServeStrictRouting(await fresh.getAddress()))
        .to.be.rejectedWith(/not a CreatorRewardsVaultV2[\s\S]*TreasuryRouterV4[\s\S]*CreatorRewardsVaultV2/);
    });

    it("refuses a CreatorRewardsVaultV2 that pays a different router", async function () {
      const { fx, topazFactory } = await routingFixture();
      const stray = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
        await fx.owner.getAddress(), await fx.routing.treasuryRouter.getAddress(), await fx.wbnb.getAddress(), 1, topazFactory, 24 * 60 * 60,
      );
      // A second router whose creatorRewardsVault() is that vault: the vault still pays the first one.
      const other = await deployGenerationRouting(await fx.owner.getAddress(), topazFactory, await fx.wbnb.getAddress());
      const r2 = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(
        await fx.owner.getAddress(), await other.weekly.getAddress(), await other.monthly.getAddress(), 3600,
      );
      await (await r2.setRecruiterRewardsVault(await other.weekly.getAddress())).wait();
      await (await r2.setCommunityRewardsVault(await other.weekly.getAddress())).wait();
      await (await r2.setProtocolRevenueVault(await other.weekly.getAddress())).wait();
      await (await r2.setCreatorRewardsVault(await stray.getAddress())).wait();
      await expect(assertRouterCanServeStrictRouting(await r2.getAddress()))
        .to.be.rejectedWith(/pays router .* accrueTradeFee is onlyRouter[\s\S]*TreasuryRouterV4/);
    });

    it("refuses a CreatorRewardsVaultV2 already pinned to another factory", async function () {
      const { fx, routing } = await routingFixture();
      const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
      const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
      const { factory } = await deployFactoryWithLocker({ factoryName: "BnbBasicLaunchFactory", args: [
        await fx.topazRouter.getAddress(), await routing.router.getAddress(), await nativeImpl.getAddress(),
        await fx.graduationOracle.getAddress(), await quoteImpl.getAddress(),
      ] });
      await (await routing.creatorVault.setFactoryOnce(await factory.getAddress())).wait();
      await expect(assertRouterCanServeStrictRouting(await routing.router.getAddress()))
        .to.be.rejectedWith(/already pinned to factory[\s\S]*could never create/);
    });
  });
});

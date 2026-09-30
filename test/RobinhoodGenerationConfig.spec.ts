import { expect } from "chai";
import { ethers } from "hardhat";

import {
  assertFeedWithinMaxAge,
  assertRouterCanServeStrictRouting,
  configFor,
  graduationTargetFor,
  maxOracleAgeFor,
} from "../scripts/deploy-robinhood-quote-generation";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { wireGenerationCreatePath } from "../scripts/lib/evmGenerationCreateWiring";
import { req, signCreate } from "./fixtures/evmgenCore";

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
    const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await adapter.getAddress(), await routing.treasuryRouter.getAddress(), await impl.getAddress(), await oracle.getAddress()] })).factory;
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

  /**
   * The create wiring the Robinhood script now performs (shared with BNB, scripts/lib/evmGenerationCreateWiring.ts),
   * on a V3 LaunchFactory behind TreasuryRouterV4 + CreatorRewardsVaultV2 (dexKind 2). Before it, the script left a
   * factory that reverted NativeGraduationAdapterUnavailable on every create.
   */
  describe("create wiring", function () {
    async function v3Generation() {
      const [owner, , , , routeAuthority] = await ethers.getSigners();
      const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
      const t = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await (feed as any).setRoundData(1n, ethers.parseUnits("2600", 8), t, t, 1n)).wait();
      const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);
      const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
      const v3f = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
      const pm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3f.getAddress(), await weth.getAddress());
      const v3Adapter = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(await v3f.getAddress(), await pm.getAddress(), await weth.getAddress(), 3000);

      const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
      const weekly = await Receiver.deploy();
      const monthly = await Receiver.deploy();
      const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
      const creatorVault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
        owner.address, await router.getAddress(), await weth.getAddress(), 2, await v3f.getAddress(), 24 * 60 * 60,
      );
      await (await router.setRecruiterRewardsVault(await weekly.getAddress())).wait();
      await (await router.setCommunityRewardsVault(await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy().then((c) => c.getAddress()))).wait();
      await (await router.setProtocolRevenueVault(await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(owner.address).then((c) => c.getAddress()))).wait();
      await (await router.setCreatorRewardsVault(await creatorVault.getAddress())).wait();

      const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
      const { factory } = await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [
        await v3Adapter.getAddress(), await router.getAddress(), await impl.getAddress(), await oracle.getAddress(),
      ] });
      await (await (factory as any).setRouteAuthority(routeAuthority.address)).wait();
      await (await (factory as any).enableLive()).wait();
      // Stand-in for the generation's V3 native adapter (claude/evm-rh). On a V3 factory the setter authorizes it on
      // the locker, which requires the V3 integration surface (liquidityKind/v3Factory/positionManager/WETH/feeTier)
      // to match; RobinhoodUniswapV3GraduationAdapter has it. Create never calls the adapter.
      const nativeAdapter = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(await v3f.getAddress(), await pm.getAddress(), await weth.getAddress(), 3000);
      return { owner, routeAuthority, router, creatorVault, factory: factory as any, nativeAdapter };
    }

    it("the router guard accepts the V3 vault, and the wired factory creates", async function () {
      const g = await v3Generation();
      await assertRouterCanServeStrictRouting(await g.router.getAddress());
      const [, , , creator] = await ethers.getSigners();
      const request = req({ name: "Robin", symbol: "ROBN", logoURI: "ipfs://robin" });
      const auth = await signCreate(g.routeAuthority, await g.factory.getAddress(), creator.address, request);
      await expect(g.factory.connect(creator).createCampaignAuthorized(request, auth))
        .to.be.revertedWithCustomError(g.factory, "NativeGraduationAdapterUnavailable");

      const wiring = await wireGenerationCreatePath({
        factoryAddress: await g.factory.getAddress(),
        nativeGraduationAdapter: await g.nativeAdapter.getAddress(),
        creatorVault: await g.creatorVault.getAddress(),
        senderAddress: g.owner.address,
      });
      expect(wiring.wired).to.equal(true);
      expect(wiring.ownerActions).to.deep.equal([]);
      expect(await g.factory.nativeGraduationAdapter()).to.equal(await g.nativeAdapter.getAddress());
      expect(await g.factory.launchTokenDeployer()).to.equal(wiring.tokenDeployer);
      expect(await g.creatorVault.factory()).to.equal(await g.factory.getAddress());

      await expect(g.factory.connect(creator).createCampaignAuthorized(request, auth)).to.emit(g.creatorVault, "CampaignChoiceSet");
    });

    it("the router guard refuses a Topaz (dexKind 1) vault on Robinhood", async function () {
      const g = await v3Generation();
      const r2 = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(g.owner.address, await g.router.weeklyLeagueVault(), await g.router.monthlyLeagueTreasury(), 3600);
      // Pays r2 and is unpinned, so only the DEX kind is wrong.
      const topazVault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
        g.owner.address, await r2.getAddress(), await g.creatorVault.wrappedNative(), 1, await g.creatorVault.dexFactory(), 24 * 60 * 60,
      );
      await (await r2.setRecruiterRewardsVault(await g.router.recruiterRewardsVault())).wait();
      await (await r2.setCommunityRewardsVault(await g.router.communityRewardsVault())).wait();
      await (await r2.setProtocolRevenueVault(await g.router.protocolRevenueVault())).wait();
      await (await r2.setCreatorRewardsVault(await topazVault.getAddress())).wait();
      await expect(assertRouterCanServeStrictRouting(await r2.getAddress())).to.be.rejectedWith(/dexKind\(\)=1, this chain needs 2/);
    });
  });
});

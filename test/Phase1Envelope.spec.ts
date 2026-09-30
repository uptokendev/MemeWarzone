import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { getBalance } from "./helpers/balances";
import { quoteBuyExactTokens } from "./helpers/math";
import { deployLaunchFactory } from "./helpers/deployFactory";
import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";

const ROUTE_KIND_TRADE = 0;
const ROUTE_KIND_FINALIZE = 1;
const ROUTE_PROFILE_STANDARD_UNLINKED = 1;

type RoutedSystem = Awaited<ReturnType<typeof deployRoutedSystem>>;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployCommonDex() {
  const [owner, creator, alice] = await ethers.getSigners();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const DexRouter = await ethers.getContractFactory("MockRouter");
  const dexRouter = await DexRouter.deploy(await topazFactory.getAddress(), await owner.getAddress());
  await dexRouter.waitForDeployment();

  return { owner, creator, alice, dexRouter };
}

async function deployRoutedSystem() {
  const { owner, creator, alice, dexRouter } = await deployCommonDex();

  // V3: the factory points feeRecipient and leagueReceiver here and stamps
  // strictFeeRouting: true, so campaigns call routeTrade / routeFinalize.
  const { treasuryRouter, leagueVault, monthlyVault, creatorVault, recruiterVault, protocolVault, communityVault } =
    await deployConfiguredTreasuryRouterV3(await owner.getAddress());

  const { factory, priceFeed } = await deployLaunchFactory(await dexRouter.getAddress(), await treasuryRouter.getAddress());
  await factory.connect(owner).setRequireRouteAuthorization(false);
  await factory.connect(owner).setRequireAuthorizedTrading(false);
  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: ethers.parseEther("0.005"),
    priceSlope: 10n ** 9n,
    graduationTarget: ethers.parseEther("2"),
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
    liquidityBps: 8000,
  });
  await factory.connect(owner).enableLive();

  return {
    owner,
    creator,
    alice,
    dexRouter,
    treasuryRouter,
    leagueVault,
    recruiterVault,
    communityVault,
    protocolVault,
    factory,
    priceFeed,
  };
}

async function createCampaign(factory: any, creator: any, suffix: string) {
  await factory.connect(creator).createCampaign({
    name: `Phase1 ${suffix}`,
    symbol: `P1${suffix}`,
    logoURI: `ipfs://${suffix}`,
    xAccount: `x-${suffix}`,
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
  });

  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { info, campaign, token };
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

async function parseFinalizedEvent(campaign: any, tx: any) {
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((log: any) => {
      try {
        return campaign.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((entry: any) => entry?.name === "CampaignFinalized");

  expect(parsed, "CampaignFinalized not found").to.not.equal(undefined);
  return parsed!.args;
}

describe("Phase 1 fee envelope and economics invariants", function () {
  it("previewRoute matches the published Phase 1 splits exactly on a divisible input", async () => {
    const { treasuryRouter } = await loadFixture(deployRoutedSystem);
    const amount = ethers.parseEther("2");

    // Trade fees carry a 5% creator share on TreasuryRouterV3, taken out of what
    // used to be the protocol's, so protocol is 0.85 where V1 paid 0.95.
    // Finalize fees have no creator or league share and are unchanged.
    const tradeLinked = await treasuryRouter.previewRoute(amount, ROUTE_KIND_TRADE, 0);
    expect(tradeLinked.league).to.equal(ethers.parseEther("0.75"));
    expect(tradeLinked.creator).to.equal(ethers.parseEther("0.10"));
    expect(tradeLinked.recruiter).to.equal(ethers.parseEther("0.25"));
    expect(tradeLinked.airdrop).to.equal(0n);
    expect(tradeLinked.squad).to.equal(ethers.parseEther("0.05"));
    expect(tradeLinked.protocol).to.equal(ethers.parseEther("0.85"));

    const tradeUnlinked = await treasuryRouter.previewRoute(amount, ROUTE_KIND_TRADE, ROUTE_PROFILE_STANDARD_UNLINKED);
    expect(tradeUnlinked.league).to.equal(ethers.parseEther("0.75"));
    expect(tradeUnlinked.creator).to.equal(ethers.parseEther("0.10"));
    expect(tradeUnlinked.recruiter).to.equal(0n);
    expect(tradeUnlinked.airdrop).to.equal(ethers.parseEther("0.30"));
    expect(tradeUnlinked.squad).to.equal(0n);
    expect(tradeUnlinked.protocol).to.equal(ethers.parseEther("0.85"));

    const finalizeLinked = await treasuryRouter.previewRoute(amount, ROUTE_KIND_FINALIZE, 0);
    expect(finalizeLinked.league).to.equal(0n);
    expect(finalizeLinked.recruiter).to.equal(ethers.parseEther("0.30"));
    expect(finalizeLinked.airdrop).to.equal(0n);
    expect(finalizeLinked.squad).to.equal(ethers.parseEther("0.05"));
    expect(finalizeLinked.protocol).to.equal(ethers.parseEther("1.65"));

    const finalizeUnlinked = await treasuryRouter.previewRoute(amount, ROUTE_KIND_FINALIZE, ROUTE_PROFILE_STANDARD_UNLINKED);
    expect(finalizeUnlinked.league).to.equal(0n);
    expect(finalizeUnlinked.recruiter).to.equal(0n);
    expect(finalizeUnlinked.airdrop).to.equal(ethers.parseEther("0.35"));
    expect(finalizeUnlinked.squad).to.equal(0n);
    expect(finalizeUnlinked.protocol).to.equal(ethers.parseEther("1.65"));

    const ogTrade = await treasuryRouter.previewRoute(amount, ROUTE_KIND_TRADE, 2);
    expect(ogTrade.creator).to.equal(ethers.parseEther("0.10"));
    expect(ogTrade.recruiter).to.equal(ethers.parseEther("0.30"));
    expect(ogTrade.squad).to.equal(ethers.parseEther("0.05"));
    expect(ogTrade.protocol).to.equal(ethers.parseEther("0.80"));

    const ogFinalize = await treasuryRouter.previewRoute(amount, ROUTE_KIND_FINALIZE, 2);
    expect(ogFinalize.creator).to.equal(0n);
    expect(ogFinalize.recruiter).to.equal(ethers.parseEther("0.35"));
    expect(ogFinalize.squad).to.equal(ethers.parseEther("0.05"));
    expect(ogFinalize.protocol).to.equal(ethers.parseEther("1.60"));

    // Whatever the profile, every wei of the fee is accounted for.
    for (const split of [tradeLinked, tradeUnlinked, finalizeLinked, finalizeUnlinked, ogTrade, ogFinalize]) {
      expect(split.league + split.creator + split.recruiter + split.airdrop + split.squad + split.protocol).to.equal(amount);
    }
  });

  it("previewRoute preserves the exact fee envelope across representative odd amounts", async () => {
    const { treasuryRouter } = await loadFixture(deployRoutedSystem);
    const samples = [1n, 2n, 3n, 7n, 11n, 101n, 10_001n, 123_456_789n, ethers.parseEther("1.23456789")];

    for (const amount of samples) {
      for (const kind of [0, 1] as const) {
        for (const profile of [0, 1, 2] as const) {
          const preview = await treasuryRouter.previewRoute(amount, kind, profile);
          const total =
            preview.league + preview.creator + preview.recruiter + preview.airdrop + preview.squad + preview.protocol;
          expect(total, `net mismatch for amount=${amount} kind=${kind} profile=${profile}`).to.equal(amount);
        }
      }
    }
  });

  it("migrating the treasury router keeps unified routing intact, so campaigns created after it still trade", async () => {
    // LaunchCampaign routes every fee to feeRecipient, and the factory keeps leagueReceiver equal to it. The
    // setCoreRouting bug (leagueReceiver immutable while feeRecipient moved) bricked every campaign minted after a
    // migration. EVM launch generation: setCoreRouting is removed; the DEX router, feeRecipient and leagueReceiver
    // are fixed at construction, so a migration is a new factory generation on the new router. This asserts that the
    // divergent state is unreachable (no setter), that both fields name the router, and that a campaign on the
    // migrated generation routes the exact trade split to the new router's vaults and nothing to the old one's.
    const { owner, creator, alice, dexRouter, factory, treasuryRouter } = await loadFixture(deployRoutedSystem);

    for (const removed of ["setCoreRouting", "setFeeRecipient", "setLeagueReceiver", "setRouter", "setTreasuryRouter"]) {
      expect(factory.interface.getFunction(removed), `${removed} must not exist`).to.equal(null);
    }
    expect(await factory.feeRecipient()).to.equal(await treasuryRouter.getAddress());
    expect(await factory.leagueReceiver()).to.equal(await factory.feeRecipient());

    const migrated = await deployConfiguredTreasuryRouterV3(await owner.getAddress());
    const { factory: migratedFactory } = await deployLaunchFactory(
      await dexRouter.getAddress(),
      await migrated.treasuryRouter.getAddress()
    );
    await migratedFactory.connect(owner).setRequireRouteAuthorization(false);
    await migratedFactory.connect(owner).setRequireAuthorizedTrading(false);
    await migratedFactory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.005"),
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("2"),
    });
    await migratedFactory.connect(owner).enableLive();

    expect(await migratedFactory.feeRecipient()).to.equal(await migrated.treasuryRouter.getAddress());
    expect(await migratedFactory.leagueReceiver()).to.equal(await migratedFactory.feeRecipient());

    const { campaign } = await createCampaign(migratedFactory, creator, "Migrated");
    expect(await campaign.feeRecipient()).to.equal(await migrated.treasuryRouter.getAddress());
    // Past the C2 anti-sniper window: flat protocolFeeBps.
    await time.increase(61);

    const amountOut = ethers.parseEther("10");
    const { fee, total } = quoteBuyExactTokens(
      await campaign.sold(),
      amountOut,
      await campaign.basePrice(),
      await campaign.priceSlope(),
      await campaign.protocolFeeBps()
    );
    const expected = await migrated.treasuryRouter.previewRoute(fee, ROUTE_KIND_TRADE, await campaign.tradeRouteProfile());

    const vaults = async (sys: any) =>
      (await getBalance(await sys.leagueVault.getAddress())) + (await getBalance(await sys.monthlyVault.getAddress()));
    const oldRouterBalance = await getBalance(await treasuryRouter.getAddress());
    const leagueBefore = await vaults(migrated);
    const creatorBefore = await getBalance(await migrated.creatorVault.getAddress());
    const protocolBefore = await getBalance(await migrated.protocolVault.getAddress());

    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });

    expect((await vaults(migrated)) - leagueBefore).to.equal(expected.league);
    expect((await getBalance(await migrated.creatorVault.getAddress())) - creatorBefore).to.equal(expected.creator);
    expect((await getBalance(await migrated.protocolVault.getAddress())) - protocolBefore).to.equal(expected.protocol);
    expect(expected.league).to.be.gt(0n);
    expect(expected.creator).to.be.gt(0n);
    expect(await getBalance(await treasuryRouter.getAddress())).to.equal(oldRouterBalance);
  });
});

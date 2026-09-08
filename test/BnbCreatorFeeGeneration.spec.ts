import { expect } from "chai";
import { ethers } from "hardhat";

const PROTOCOL_FEE_BPS = 200n;
const ROUTE_BPS = 10_000n;
const CREATOR_SHARE_BPS = 500n;
const LEAGUE_SHARE_BPS = 3_750n;
const STANDARD_LINKED = 0;
const STANDARD_UNLINKED = 1;
const OG_LINKED = 2;

const PROFILES = [
  { id: STANDARD_LINKED, name: "Standard", recruiterBps: 1_250n, airdropBps: 0n, squadBps: 250n },
  { id: STANDARD_UNLINKED, name: "Unlinked", recruiterBps: 0n, airdropBps: 1_500n, squadBps: 0n },
  { id: OG_LINKED, name: "OG", recruiterBps: 1_500n, airdropBps: 0n, squadBps: 250n },
];

function expectedTradeSplit(fee: bigint, profile: (typeof PROFILES)[number]) {
  const league = (fee * LEAGUE_SHARE_BPS) / ROUTE_BPS;
  const creator = (fee * CREATOR_SHARE_BPS) / ROUTE_BPS;
  const recruiter = (fee * profile.recruiterBps) / ROUTE_BPS;
  const airdrop = (fee * profile.airdropBps) / ROUTE_BPS;
  const squad = (fee * profile.squadBps) / ROUTE_BPS;
  const protocol = fee - league - creator - recruiter - airdrop - squad;
  return { league, creator, recruiter, airdrop, squad, protocol };
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

function hashCreateRouteRequest(req: {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: bigint;
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        ethers.keccak256(ethers.toUtf8Bytes(req.name)),
        ethers.keccak256(ethers.toUtf8Bytes(req.symbol)),
        ethers.keccak256(ethers.toUtf8Bytes(req.logoURI)),
        ethers.keccak256(ethers.toUtf8Bytes(req.xAccount)),
        ethers.keccak256(ethers.toUtf8Bytes(req.website)),
        ethers.keccak256(ethers.toUtf8Bytes(req.extraLink)),
        req.graduationTarget,
      ],
    ),
  );
}

async function signCreateRoute(
  factory: any,
  creator: string,
  signer: any,
  req: any,
  tradeProfile: number,
  finalizeProfile: number,
  deadline: bigint,
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_ROUTE_AUTH", chainId, await factory.getAddress(), creator, hashCreateRouteRequest(req), tradeProfile, finalizeProfile, deadline],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function deploySourceHeadFeeStack() {
  const [owner, creator, buyer] = await ethers.getSigners();

  const WBNB = await ethers.getContractFactory("MockWBNB");
  const wbnb = await WBNB.deploy();
  await wbnb.waitForDeployment();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockTopazRouter");
  const router = await Router.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await router.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits("1", 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  await weekly.waitForDeployment();
  await monthly.waitForDeployment();
  await recruiter.waitForDeployment();

  const TreasuryRouter = await ethers.getContractFactory("TreasuryRouterV3");
  const treasuryRouter = await TreasuryRouter.deploy(
    await owner.getAddress(),
    await weekly.getAddress(),
    await monthly.getAddress(),
    3600,
  );
  await treasuryRouter.waitForDeployment();

  const Community = await ethers.getContractFactory("CommunityRewardsVaultV3Mock");
  const community = await Community.deploy();
  await community.waitForDeployment();

  const ProtocolVault = await ethers.getContractFactory("ProtocolRevenueVault");
  const protocolVault = await ProtocolVault.deploy(await owner.getAddress());
  await protocolVault.waitForDeployment();

  const CreatorVault = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorVault = await CreatorVault.deploy(await owner.getAddress(), await treasuryRouter.getAddress());
  await creatorVault.waitForDeployment();

  await treasuryRouter.setRecruiterRewardsVault(await recruiter.getAddress());
  await treasuryRouter.setCommunityRewardsVault(await community.getAddress());
  await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(
    await router.getAddress(),
    await treasuryRouter.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress(),
  );
  await factory.waitForDeployment();

  await factory.setRouteAuthority(await owner.getAddress());
  await factory.setRequireAuthorizedTrading(false);
  await factory.setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: 10n ** 12n,
    priceSlope: 10n ** 9n,
    graduationTarget: ethers.parseEther("30000"),
    liquidityBps: 8000,
  });
  await factory.enableLive();

  return {
    owner,
    creator,
    buyer,
    weekly,
    monthly,
    recruiter,
    community,
    protocolVault,
    creatorVault,
    treasuryRouter,
    factory,
  };
}

describe("BNB 6B creator-fee generation (local source-head only)", function () {
  it("Factory 4/3 + Topaz V2 + TreasuryRouterV3 pays 0.10% of volume to creator for Standard, OG, and Unlinked", async function () {
    this.timeout(180_000);
    const stack = await deploySourceHeadFeeStack();
    const { owner, creator, buyer, weekly, monthly, recruiter, community, protocolVault, creatorVault, treasuryRouter, factory } = stack;

    expect(await factory.FACTORY_GENERATION()).to.equal(4n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(3n);
    expect(await factory.liquidityKind()).to.equal(1n);
    expect(await factory.protocolFeeBps()).to.equal(PROTOCOL_FEE_BPS);
    expect((PROTOCOL_FEE_BPS * CREATOR_SHARE_BPS) / ROUTE_BPS).to.equal(10n);

    for (const [index, profile] of PROFILES.entries()) {
      const req = {
        name: `${profile.name} Fee`,
        symbol: `F${index}`,
        logoURI: `ipfs://${profile.name}`,
        xAccount: "",
        website: "",
        extraLink: "",
        graduationTarget: 0n,
      };
      const deadline = (await latestTimestamp()) + 600n;
      const signature = await signCreateRoute(
        factory,
        await creator.getAddress(),
        owner,
        req,
        profile.id,
        profile.id,
        deadline,
      );
      await factory.connect(creator).createCampaignAuthorized(req, {
        tradeRouteProfile: profile.id,
        finalizeRouteProfile: profile.id,
        deadline,
        signature,
      });
      const created = await factory.getCampaign(BigInt(index));
      const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign);
      expect(await campaign.strictFeeRouting()).to.equal(true);
      expect(await campaign.tradeRouteProfile()).to.equal(BigInt(profile.id));
      expect(await campaign.protocolFeeBps()).to.equal(PROTOCOL_FEE_BPS);

      const amountOut = ethers.parseEther("10");
      const totalCost = await campaign.quoteBuyExactTokens(amountOut);
      const weeklyBefore = await weekly.received();
      const monthlyBefore = await monthly.received();
      const recruiterBefore = await recruiter.received();
      const airdropBefore = await community.airdropReceived();
      const squadBefore = await community.squadReceived();
      const protocolBefore = await ethers.provider.getBalance(await protocolVault.getAddress());
      const creatorBefore = await creatorVault.pendingCreatorFees(created.campaign);

      const buyTx = await campaign.connect(buyer).buyExactTokens(amountOut, totalCost, { value: totalCost });
      const buyReceipt = await buyTx.wait();
      const executed = buyReceipt!.logs
        .map((log) => {
          try {
            return treasuryRouter.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "RouteExecuted");
      expect(executed).to.not.equal(undefined);
      expect(executed!.args.kind).to.equal(0n);
      expect(executed!.args.profile).to.equal(BigInt(profile.id));

      const fee = executed!.args.amountIn as bigint;
      const costNoFee = totalCost - fee;
      expect(fee).to.equal((costNoFee * PROTOCOL_FEE_BPS) / ROUTE_BPS);
      expect(costNoFee + fee).to.equal(totalCost);
      const expected = expectedTradeSplit(fee, profile);
      expect(expected.creator).to.equal((fee * CREATOR_SHARE_BPS) / ROUTE_BPS);
      expect((PROTOCOL_FEE_BPS * CREATOR_SHARE_BPS) / ROUTE_BPS).to.equal(10n);
      expect(expected.creator).to.equal((costNoFee * PROTOCOL_FEE_BPS / ROUTE_BPS) * CREATOR_SHARE_BPS / ROUTE_BPS);
      expect(await campaign.launched()).to.equal(false);

      expect(executed!.args.creatorAmount).to.equal(expected.creator);
      expect(executed!.args.leagueAmount).to.equal(expected.league);
      expect(executed!.args.recruiterAmount).to.equal(expected.recruiter);
      expect(executed!.args.airdropAmount).to.equal(expected.airdrop);
      expect(executed!.args.squadAmount).to.equal(expected.squad);
      expect(executed!.args.protocolAmount).to.equal(expected.protocol);
      expect((await creatorVault.pendingCreatorFees(created.campaign)) - creatorBefore).to.equal(expected.creator);
      expect((await weekly.received()) - weeklyBefore + ((await monthly.received()) - monthlyBefore)).to.equal(expected.league);
      expect((await recruiter.received()) - recruiterBefore).to.equal(expected.recruiter);
      expect((await community.airdropReceived()) - airdropBefore).to.equal(expected.airdrop);
      expect((await community.squadReceived()) - squadBefore).to.equal(expected.squad);
      expect((await ethers.provider.getBalance(await protocolVault.getAddress())) - protocolBefore).to.equal(expected.protocol);
    }
  });
});

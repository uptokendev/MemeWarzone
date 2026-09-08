import { expect } from "chai";
import { ethers } from "hardhat";
import { increaseTime } from "./helpers/settlementAuth";

const TRADE = 0;
const FINALIZE = 1;
const STANDARD_LINKED = 0;
const STANDARD_UNLINKED = 1;
const OG_LINKED = 2;

async function deployReceiver() {
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const receiver = await Receiver.deploy();
  await receiver.waitForDeployment();
  return receiver;
}

async function deployCampaign(creatorAddress: string) {
  const Campaign = await ethers.getContractFactory("CreatorFeeCampaignMock");
  const campaign = await Campaign.deploy(creatorAddress);
  await campaign.waitForDeployment();
  return campaign;
}

describe("TreasuryRouterV3", function () {
  async function deployBare() {
    const [admin, creator, alice, lockerA] = await ethers.getSigners();
    const weekly = await deployReceiver();
    const monthly = await deployReceiver();

    const Router = await ethers.getContractFactory("TreasuryRouterV3");
    const router = await Router.deploy(await admin.getAddress(), await weekly.getAddress(), await monthly.getAddress(), 3600);
    await router.waitForDeployment();

    return { router, weekly, monthly, admin, creator, alice, lockerA };
  }

  async function deployConfigured() {
    const fixture = await deployBare();
    const recruiter = await deployReceiver();
    const protocol = await deployReceiver();
    const Community = await ethers.getContractFactory("CommunityRewardsVaultV3Mock");
    const community = await Community.deploy();
    await community.waitForDeployment();
    const CreatorVault = await ethers.getContractFactory("CreatorRewardsVault");
    const creatorVault = await CreatorVault.deploy(await fixture.admin.getAddress(), await fixture.router.getAddress());
    await creatorVault.waitForDeployment();

    await fixture.router.setRecruiterRewardsVault(await recruiter.getAddress());
    await fixture.router.setCommunityRewardsVault(await community.getAddress());
    await fixture.router.setProtocolRevenueVault(await protocol.getAddress());
    await fixture.router.setCreatorRewardsVault(await creatorVault.getAddress());

    return { ...fixture, recruiter, protocol, community, creatorVault };
  }

  it("routes standard linked trade fees into creator custody and allows only creator claim", async () => {
    const { router, weekly, monthly, recruiter, protocol, community, creatorVault, creator, alice } = await deployConfigured();
    const campaign = await deployCampaign(await creator.getAddress());

    await expect(campaign.connect(alice).routeTrade(await router.getAddress(), STANDARD_LINKED, { value: 10_000n }))
      .to.emit(router, "RouteExecuted")
      .withArgs(TRADE, STANDARD_LINKED, await campaign.getAddress(), 10_000n, 3_750n, 500n, 1_250n, 0n, 250n, 4_250n);

    expect(await weekly.received()).to.eq(1_125n);
    expect(await monthly.received()).to.eq(2_625n);
    expect(await recruiter.received()).to.eq(1_250n);
    expect(await community.airdropReceived()).to.eq(0n);
    expect(await community.squadReceived()).to.eq(250n);
    expect(await protocol.received()).to.eq(4_250n);
    expect(await creatorVault.pendingCreatorFees(await campaign.getAddress())).to.eq(500n);

    await expect(creatorVault.connect(alice).claimCreatorFees(await campaign.getAddress())).to.be.revertedWith("not creator");
    await expect(creatorVault.connect(creator).claimCreatorFees(await campaign.getAddress()))
      .to.emit(creatorVault, "CreatorFeeClaimed")
      .withArgs(await campaign.getAddress(), await creator.getAddress(), 500n, 500n, 500n);
    expect(await creatorVault.pendingCreatorFees(await campaign.getAddress())).to.eq(0n);
    expect(await creatorVault.claimedCreatorFees(await campaign.getAddress())).to.eq(500n);
  });

  it("routes OG trades with recruiter uplift coming from protocol", async () => {
    const { router, recruiter, protocol, community, creatorVault, creator, alice } = await deployConfigured();
    const campaign = await deployCampaign(await creator.getAddress());

    await campaign.connect(alice).routeTrade(await router.getAddress(), OG_LINKED, { value: 10_000n });

    expect(await recruiter.received()).to.eq(1_500n);
    expect(await community.squadReceived()).to.eq(250n);
    expect(await community.airdropReceived()).to.eq(0n);
    expect(await protocol.received()).to.eq(4_000n);
    expect(await creatorVault.pendingCreatorFees(await campaign.getAddress())).to.eq(500n);
  });

  it("routes unlinked trades to airdrop while preserving the creator share", async () => {
    const { router, recruiter, protocol, community, creatorVault, creator, alice } = await deployConfigured();
    const campaign = await deployCampaign(await creator.getAddress());

    await campaign.connect(alice).routeTrade(await router.getAddress(), STANDARD_UNLINKED, { value: 10_000n });

    expect(await recruiter.received()).to.eq(0n);
    expect(await community.airdropReceived()).to.eq(1_500n);
    expect(await community.squadReceived()).to.eq(0n);
    expect(await protocol.received()).to.eq(4_250n);
    expect(await creatorVault.pendingCreatorFees(await campaign.getAddress())).to.eq(500n);
  });

  it("keeps finalize routing creator-free", async () => {
    const { router, recruiter, protocol, community, creatorVault, creator, alice } = await deployConfigured();
    const campaign = await deployCampaign(await creator.getAddress());

    await expect(campaign.connect(alice).routeFinalize(await router.getAddress(), STANDARD_UNLINKED, { value: 10_000n }))
      .to.emit(router, "RouteExecuted")
      .withArgs(FINALIZE, STANDARD_UNLINKED, ethers.ZeroAddress, 10_000n, 0n, 0n, 0n, 1_750n, 0n, 8_250n);

    expect(await community.airdropReceived()).to.eq(1_750n);
    expect(await protocol.received()).to.eq(8_250n);
    expect(await creatorVault.pendingCreatorFees(await campaign.getAddress())).to.eq(0n);
    expect(await recruiter.received()).to.eq(0n);
  });

  it("requires creator routing to be configured for trade execution", async () => {
    const { router, creator, alice } = await deployBare();
    const recruiter = await deployReceiver();
    const protocol = await deployReceiver();
    const Community = await ethers.getContractFactory("CommunityRewardsVaultV3Mock");
    const community = await Community.deploy();
    await community.waitForDeployment();
    await router.setRecruiterRewardsVault(await recruiter.getAddress());
    await router.setCommunityRewardsVault(await community.getAddress());
    await router.setProtocolRevenueVault(await protocol.getAddress());
    const campaign = await deployCampaign(await creator.getAddress());

    await expect(campaign.connect(alice).routeTrade(await router.getAddress(), STANDARD_LINKED, { value: 1n })).to.be.revertedWith("creatorVault=0");
  });

  it("delays replacement of V3 money destinations including the creator vault", async () => {
    const { router, recruiter, community, protocol, creatorVault, alice, lockerA } = await deployConfigured();
    const replacement = await deployReceiver();
    const replacementAddress = await replacement.getAddress();

    await expect(router.setRecruiterRewardsVault(replacementAddress)).to.be.revertedWith("use propose");
    await expect(router.setCommunityRewardsVault(replacementAddress)).to.be.revertedWith("use propose");
    await expect(router.setProtocolRevenueVault(replacementAddress)).to.be.revertedWith("use propose");
    await expect(router.setCreatorRewardsVault(replacementAddress)).to.be.revertedWith("use propose");
    await expect(router.proposeCreatorRewardsVault(await alice.getAddress())).to.be.revertedWith("not contract");

    await router.proposeCreatorRewardsVault(replacementAddress);
    await expect(router.acceptCreatorRewardsVault()).to.be.revertedWith("delay");
    await increaseTime(3600);
    await expect(router.acceptCreatorRewardsVault())
      .to.emit(router, "CreatorRewardsVaultUpdated")
      .withArgs(await creatorVault.getAddress(), replacementAddress);
    expect(await router.creatorRewardsVault()).to.eq(replacementAddress);

    await router.proposeRecruiterRewardsVault(replacementAddress);
    await router.proposeCommunityRewardsVault(replacementAddress);
    await router.proposeProtocolRevenueVault(replacementAddress);
    await increaseTime(3600);
    await router.acceptRecruiterRewardsVault();
    await router.acceptCommunityRewardsVault();
    await router.acceptProtocolRevenueVault();
    expect(await router.recruiterRewardsVault()).to.eq(replacementAddress);
    expect(await router.communityRewardsVault()).to.eq(replacementAddress);
    expect(await router.protocolRevenueVault()).to.eq(replacementAddress);

    await router.setAuthorizedLpLocker(await lockerA.getAddress(), true);
    await expect(router.setAuthorizedLpLocker(await alice.getAddress(), true)).to.be.revertedWith("use propose");
    await router.emergencyDisableLpLocker(await lockerA.getAddress());
    expect(await router.authorizedLpLocker(await lockerA.getAddress())).to.eq(false);
    expect(await router.anyLpLockerAuthorized()).to.eq(true);
  });
});

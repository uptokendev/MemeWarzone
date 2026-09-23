import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployTestOracle(price = "1") {
  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits(price, 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();
  return { priceFeed, graduationOracle };
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

const directInitParams = async (values: {
  creator: string;
  owner: string;
  router: string;
  feeRecipient?: string;
  leagueReceiver?: string;
  basePrice?: bigint;
  priceSlope?: bigint;
  graduationTarget?: bigint;
  graduationOracle?: string;
}) => ({
  name: "Phase2Guard",
  symbol: "P2G",
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  totalSupply: ethers.parseEther("1000"),
  curveBps: 5000,
  liquidityTokenBps: 4000,
  basePrice: values.basePrice ?? ethers.parseEther("0.001"),
  priceSlope: values.priceSlope ?? 1n,
  graduationTarget: values.graduationTarget ?? ethers.parseEther("10"),
  graduationOracle: values.graduationOracle ?? await (await deployTestOracle()).graduationOracle.getAddress(),
  liquidityBps: 8000,
  protocolFeeBps: 200,
  leagueFeeBps: 75,
  leagueReceiver: values.leagueReceiver ?? values.owner,
  router: values.router,
  lpReceiver: values.creator,
  feeRecipient: values.feeRecipient ?? values.owner,
  creator: values.creator,
  factory: values.creator,
  creatorRegistry: ethers.ZeroAddress,
  riskRegistry: ethers.ZeroAddress,
  creatorBuyLockUntil: 0n,
  creatorBuyCapWei: 0n,
  requireAuthorizedTrading: false,
  tradeRouteProfile: 1,
  finalizeRouteProfile: 1,
  // These campaigns are initialized directly with an EOA fee recipient, which
  // is the legacy path; LaunchFactory sets this true for real campaigns.
  strictFeeRouting: false,
});

async function deployDirectCampaign(params: any) {
  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const impl = await Campaign.deploy();
  await impl.waitForDeployment();

  const implAddr = await impl.getAddress();
  const minimalProxyBytecode =
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    implAddr.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3";

  const [, creator] = await ethers.getSigners();
  const txClone = await creator.sendTransaction({ data: minimalProxyBytecode });
  const receipt = await txClone.wait();
  const campaign = Campaign.attach(receipt!.contractAddress);
  await campaign.initialize(params);
  return campaign;
}

async function deployEarlyGraduationCampaign() {
  const fx = await deployCoreFixture();
  const { owner, creator, alice, factory } = fx;

  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: ethers.parseEther("0.025"),
    priceSlope: 10n ** 9n,
    graduationTarget: ethers.parseEther("10"),
    liquidityBps: 8000,
  });

  await factory.connect(creator).createCampaign({
    name: "Early Grad",
    symbol: "EGR",
    logoURI: "ipfs://early-grad",
    xAccount: "",
    website: "",
    extraLink: "",
    basePrice: 0n,
    priceSlope: 0n,
    graduationTarget: 0n,
    lpReceiver: ethers.ZeroAddress,
  } as any);

  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);

  const buyAmount = ethers.parseEther("1");
  const buyQuote = await campaign.quoteBuyExactTokens(buyAmount);
  await campaign.connect(alice).buyExactTokens(buyAmount, buyQuote, { value: buyQuote });
  await makeGraduationEligibleByOracle(campaign, fx.priceFeed);

  return { ...fx, campaign, token, buyAmount };
}

describe("LaunchCampaign Phase 2 graduation guardrails", function () {
  it("rejects graduation when router liquidity opens outside the curve price tolerance", async () => {
    const { owner, creator, alice } = await deployCoreFixture();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();

    const DriftRouter = await ethers.getContractFactory("MockDriftRouter");
    const router = await DriftRouter.deploy(await topazFactory.getAddress(), await owner.getAddress());
    await router.waitForDeployment();

    const { priceFeed, graduationOracle } = await deployTestOracle();
    const campaign = await deployDirectCampaign(
      await directInitParams({
        creator: await creator.getAddress(),
        owner: await owner.getAddress(),
        router: await router.getAddress(),
        graduationOracle: await graduationOracle.getAddress(),
      })
    );

    const oneToken = ethers.parseUnits("1", 18);
    const quote = await campaign.quoteBuyExactTokens(oneToken);
    await campaign.connect(alice).buyExactTokens(oneToken, quote, { value: quote });
    await makeGraduationEligibleByOracle(campaign, priceFeed);

    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.be.revertedWithCustomError(campaign, "DexPriceDrift");
  });

  it("records separate unsold curve and unused LP burn lanes on early graduation", async () => {
    const { campaign, token, alice, buyAmount } = await deployEarlyGraduationCampaign();

    await campaign.connect(alice).graduateIfEligible(0, 0);

    const state = await campaign.getGraduationState();
    const burnedUnsoldTokens = state[6];
    const burnedUnusedLpTokens = state[7];
    const postBurnTotalSupply = state[8];

    expect(await campaign.sold()).to.equal(buyAmount);
    expect(burnedUnsoldTokens).to.equal((await campaign.curveSupply()) - buyAmount);
    expect(burnedUnsoldTokens).to.be.gt(0n);
    expect(burnedUnusedLpTokens).to.be.gt(0n);
    expect(postBurnTotalSupply).to.equal(await token.totalSupply());
    expect(postBurnTotalSupply).to.equal((await campaign.totalSupply()) - burnedUnsoldTokens - burnedUnusedLpTokens);
  });

  it("emits the same graduation telemetry that is stored for indexers", async () => {
    const { campaign, alice } = await deployEarlyGraduationCampaign();

    const tx = await campaign.connect(alice).graduateIfEligible(0, 0);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => {
        try {
          return campaign.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === "CampaignFinalized");

    expect(event).to.not.equal(undefined);

    const state = await campaign.getGraduationState();
    expect(event!.args.pair).to.equal(state[0]);
    expect(event!.args.finalCurvePrice).to.equal(state[1]);
    expect(event!.args.initialDexPrice).to.equal(state[2]);
    expect(event!.args.liquidityTokens).to.equal(state[3]);
    expect(event!.args.liquidityBnb).to.equal(state[4]);
    expect(event!.args.liquidityLp).to.equal(state[5]);
    expect(event!.args.burnedUnsoldTokens).to.equal(state[6]);
    expect(event!.args.burnedUnusedLpTokens).to.equal(state[7]);
    expect(event!.args.postBurnTotalSupply).to.equal(state[8]);
    expect(event!.args.graduationBalance).to.equal(state[9]);
    expect(event!.args.graduationOvershoot).to.equal(state[10]);
  });

  it("permanently locks the minted Topaz LP in the factory locker", async () => {
    const { owner, campaign, alice, creator, factory, permanentLpLocker } = await deployEarlyGraduationCampaign();

    const tx = await campaign.connect(alice).graduateIfEligible(0, 0);
    const receipt = await tx.wait();

    const state = await campaign.getGraduationState();
    const pairAddress = state[0];
    const lpMinted = state[5];
    const pair = await ethers.getContractAt("MockTopazPool", pairAddress);
    const lockerAddress = await permanentLpLocker.getAddress();
    const factoryGraduated = receipt!.logs
      .map((log: any) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === "CampaignGraduated");

    expect(pairAddress).to.not.equal(ethers.ZeroAddress);
    expect(lpMinted).to.be.gt(0n);
    expect(factoryGraduated).to.not.equal(undefined);
    expect(factoryGraduated!.args.campaign).to.equal(await campaign.getAddress());
    expect(factoryGraduated!.args.creator).to.equal(await creator.getAddress());
    expect(factoryGraduated!.args.lpToken).to.equal(pairAddress);
    expect(factoryGraduated!.args.locker).to.equal(lockerAddress);
    expect(await permanentLpLocker.registeredLpToken(pairAddress)).to.equal(true);
    expect(await permanentLpLocker.lockedBalance(pairAddress)).to.equal(lpMinted);
    expect(await permanentLpLocker.lockedByDepositor(pairAddress, lockerAddress)).to.equal(lpMinted);
    expect(await pair.balanceOf(lockerAddress)).to.equal(lpMinted);
    expect(await pair.balanceOf(await owner.getAddress())).to.equal(0n);
    expect(await pair.balanceOf(await creator.getAddress())).to.equal(0n);
    expect(await pair.balanceOf(await campaign.getAddress())).to.equal(0n);
  });
});

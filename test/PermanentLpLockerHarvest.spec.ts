import { expect } from "chai";
import { ethers } from "hardhat";

async function deployLaunchToken(name: string, symbol: string, owner: any) {
  const Token = await ethers.getContractFactory("LaunchToken");
  const token = await Token.deploy(name, symbol, ethers.parseEther("1000000"), await owner.getAddress());
  await token.waitForDeployment();
  await token.mint(await owner.getAddress(), ethers.parseEther("100000"));
  await token.enableTrading();
  return token;
}

async function createRegisteredPool(params: {
  owner: any;
  creator: any;
  creatorFeeRecipient: any;
  campaign: any;
  locker: any;
  topazFactory: any;
}) {
  const token = await deployLaunchToken("Launch Token", "LAUNCH", params.owner);
  const wbnb = await deployLaunchToken("Wrapped BNB", "WBNB", params.owner);
  const tokenAddress = await token.getAddress();
  const wbnbAddress = await wbnb.getAddress();
  const poolAddress = await params.topazFactory.createPool.staticCall(tokenAddress, wbnbAddress, false);
  await params.topazFactory.createPool(tokenAddress, wbnbAddress, false);
  const pool = await ethers.getContractAt("MockTopazPool", poolAddress);

  const lockedLp = ethers.parseEther("10");
  await pool.mint(await params.locker.getAddress(), lockedLp);

  await params.locker.registerGraduatedPool(
    await params.campaign.getAddress(),
    await params.creator.getAddress(),
    await params.creatorFeeRecipient.getAddress(),
    poolAddress,
    tokenAddress,
    wbnbAddress,
    lockedLp
  );

  return { token, wbnb, tokenAddress, wbnbAddress, pool, poolAddress, lockedLp };
}

async function fundPoolFees(params: { owner: any; token: any; wbnb: any; pool: any; locker: any; tokenAddress: string; feeToken: bigint; feeWbnb: bigint }) {
  const poolAddress = await params.pool.getAddress();
  const poolToken0 = await params.pool.token0();
  const amount0 = poolToken0.toLowerCase() === params.tokenAddress.toLowerCase() ? params.feeToken : params.feeWbnb;
  const amount1 = poolToken0.toLowerCase() === params.tokenAddress.toLowerCase() ? params.feeWbnb : params.feeToken;

  await params.token.approve(poolAddress, params.feeToken);
  await params.wbnb.approve(poolAddress, params.feeWbnb);
  await params.pool.fundFees(await params.locker.getAddress(), amount0, amount1);
}

async function expectHarvestSplit(params: {
  locker: any;
  pool: any;
  poolAddress: string;
  token: any;
  wbnb: any;
  tokenAddress: string;
  wbnbAddress: string;
  creatorFeeRecipient: any;
  protocolRevenueVault: any;
  lockedLp: bigint;
  feeToken: bigint;
  feeWbnb: bigint;
}) {
  const creatorTokenBefore = await params.token.balanceOf(await params.creatorFeeRecipient.getAddress());
  const creatorWbnbBefore = await params.wbnb.balanceOf(await params.creatorFeeRecipient.getAddress());
  const protocolTokenBefore = await params.token.balanceOf(await params.protocolRevenueVault.getAddress());
  const protocolWbnbBefore = await params.wbnb.balanceOf(await params.protocolRevenueVault.getAddress());
  const lpBefore = await params.pool.balanceOf(await params.locker.getAddress());

  await expect(params.locker.harvest(params.poolAddress)).to.emit(params.locker, "FeesHarvested");

  const expectedCreatorToken = (params.feeToken * 8000n) / 10000n;
  const expectedProtocolToken = params.feeToken - expectedCreatorToken;
  const expectedCreatorWbnb = (params.feeWbnb * 8000n) / 10000n;
  const expectedProtocolWbnb = params.feeWbnb - expectedCreatorWbnb;

  expect(await params.token.balanceOf(await params.creatorFeeRecipient.getAddress()) - creatorTokenBefore).to.equal(expectedCreatorToken);
  expect(await params.token.balanceOf(await params.protocolRevenueVault.getAddress()) - protocolTokenBefore).to.equal(expectedProtocolToken);
  expect(await params.wbnb.balanceOf(await params.creatorFeeRecipient.getAddress()) - creatorWbnbBefore).to.equal(expectedCreatorWbnb);
  expect(await params.wbnb.balanceOf(await params.protocolRevenueVault.getAddress()) - protocolWbnbBefore).to.equal(expectedProtocolWbnb);

  expect(await params.pool.balanceOf(await params.locker.getAddress())).to.equal(lpBefore);
  expect(await params.locker.lockedBalance(params.poolAddress)).to.equal(params.lockedLp);
  expect(await params.token.balanceOf(await params.locker.getAddress())).to.equal(0n);
  expect(await params.wbnb.balanceOf(await params.locker.getAddress())).to.equal(0n);
  expect(await params.locker.cumulativeCreatorPaid(params.poolAddress, params.tokenAddress)).to.equal(expectedCreatorToken);
  expect(await params.locker.cumulativeProtocolRouted(params.poolAddress, params.tokenAddress)).to.equal(expectedProtocolToken);
  expect(await params.locker.cumulativeCreatorPaid(params.poolAddress, params.wbnbAddress)).to.equal(expectedCreatorWbnb);
  expect(await params.locker.cumulativeProtocolRouted(params.poolAddress, params.wbnbAddress)).to.equal(expectedProtocolWbnb);
}

describe("PermanentLpLocker Topaz fee harvest", function () {
  it("claims both Topaz fee assets, splits them 80/20, and preserves LP principal", async () => {
    const [owner, creator, creatorFeeRecipient, campaign, protocolRevenueVault] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await Factory.deploy();
    await topazFactory.waitForDeployment();

    const Locker = await ethers.getContractFactory("PermanentLpLocker");
    const locker = await Locker.deploy(await owner.getAddress());
    await locker.waitForDeployment();

    const TreasuryRouter = await ethers.getContractFactory("TreasuryRouter");
    const treasuryRouter = await TreasuryRouter.deploy(await owner.getAddress(), await owner.getAddress(), 3600);
    await treasuryRouter.waitForDeployment();
    await treasuryRouter.setProtocolRevenueVault(await protocolRevenueVault.getAddress());
    await treasuryRouter.setPermanentLpLocker(await locker.getAddress());

    await locker.configureRevenue(await treasuryRouter.getAddress(), await topazFactory.getAddress());

    const poolSetup = await createRegisteredPool({ owner, creator, creatorFeeRecipient, campaign, locker, topazFactory });
    const feeToken = ethers.parseEther("100");
    const feeWbnb = ethers.parseEther("5");
    await fundPoolFees({ owner, locker, feeToken, feeWbnb, ...poolSetup });

    await expectHarvestSplit({
      locker,
      creatorFeeRecipient,
      protocolRevenueVault,
      feeToken,
      feeWbnb,
      ...poolSetup,
    });
  });

  it("routes protocol fee assets through an authorized TreasuryRouterV2 locker", async () => {
    const [owner, creator, creatorFeeRecipient, campaign, , weeklyVault, monthlyTreasury] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await Factory.deploy();
    await topazFactory.waitForDeployment();

    const Locker = await ethers.getContractFactory("PermanentLpLocker");
    const locker = await Locker.deploy(await owner.getAddress());
    await locker.waitForDeployment();

    const ProtocolVault = await ethers.getContractFactory("ProtocolRevenueVault");
    const protocolVault = await ProtocolVault.deploy(await owner.getAddress());
    await protocolVault.waitForDeployment();

    const TreasuryRouterV2 = await ethers.getContractFactory("TreasuryRouterV2");
    const treasuryRouter = await TreasuryRouterV2.deploy(
      await owner.getAddress(),
      await weeklyVault.getAddress(),
      await monthlyTreasury.getAddress(),
      3600
    );
    await treasuryRouter.waitForDeployment();
    await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());
    await treasuryRouter.setAuthorizedLpLocker(await locker.getAddress(), true);
    await treasuryRouter.setPrimaryLpLocker(await locker.getAddress());

    await locker.configureRevenue(await treasuryRouter.getAddress(), await topazFactory.getAddress());

    const poolSetup = await createRegisteredPool({ owner, creator, creatorFeeRecipient, campaign, locker, topazFactory });
    const feeToken = ethers.parseEther("80");
    const feeWbnb = ethers.parseEther("4");
    await fundPoolFees({ owner, locker, feeToken, feeWbnb, ...poolSetup });

    await expectHarvestSplit({
      locker,
      creatorFeeRecipient,
      protocolRevenueVault: protocolVault,
      feeToken,
      feeWbnb,
      ...poolSetup,
    });

    expect(await treasuryRouter.authorizedLpLocker(await locker.getAddress())).to.equal(true);
    expect(await treasuryRouter.permanentLpLocker()).to.equal(await locker.getAddress());
  });
});

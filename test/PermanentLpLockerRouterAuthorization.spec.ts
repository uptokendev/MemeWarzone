import { expect } from "chai";
import { ethers } from "hardhat";

import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";

/**
 * The failure a green deployment cannot show you.
 *
 * PermanentLpLocker sends the protocol's 20% of every LP fee harvest through
 * TreasuryRouterV3.routeLpToken, which only an authorizedLpLocker may call. The
 * locker wraps that call in try/catch on purpose -- a treasury that refuses the
 * money must not be able to brick a harvest -- so an unauthorized locker does
 * not revert. It pays the creator, parks the protocol share in
 * pendingProtocolToken, emits HarvestPaymentPending, and returns success.
 *
 * So every surface reads healthy: the graduation lands, the pool is real, the
 * LP is locked, the creator is paid. Only the protocol vault, which nobody
 * watches during a deployment, stays at zero.
 *
 * This is not hypothetical. The first BSC testnet canary did exactly this and
 * stranded 38.22 tokens and 0.000006 WBNB, because the deployment script
 * deployed the locker and never authorized it on the router.
 */
describe("LP harvest when the locker is not authorized on the treasury router", function () {
  const FEE_TOKEN = ethers.parseEther("100");
  const FEE_WBNB = ethers.parseEther("4");
  const CREATOR_BPS = 8_000n;
  const BPS = 10_000n;

  async function setup() {
    const [owner, creator, campaign] = await ethers.getSigners();
    const ownerAddress = await owner.getAddress();

    const routing = await deployConfiguredTreasuryRouterV3(ownerAddress);

    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    await topazFactory.waitForDeployment();

    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(ownerAddress);
    await locker.waitForDeployment();
    await (await locker.configureRevenue(
      await routing.treasuryRouter.getAddress(),
      await topazFactory.getAddress(),
    )).wait();

    const Token = await ethers.getContractFactory("LaunchToken");
    const token = await Token.deploy("Launch", "LAUNCH", ethers.parseEther("1000000"), ownerAddress);
    await token.waitForDeployment();
    await (await token.mint(ownerAddress, ethers.parseEther("100000"))).wait();
    await (await token.enableTrading()).wait();
    const wbnb = await Token.deploy("Wrapped BNB", "WBNB", ethers.parseEther("1000000"), ownerAddress);
    await wbnb.waitForDeployment();
    await (await wbnb.mint(ownerAddress, ethers.parseEther("100000"))).wait();
    await (await wbnb.enableTrading()).wait();

    const tokenAddress = await token.getAddress();
    const wbnbAddress = await wbnb.getAddress();
    const poolAddress = await topazFactory.createPool.staticCall(tokenAddress, wbnbAddress, false);
    await (await topazFactory.createPool(tokenAddress, wbnbAddress, false)).wait();
    const pool = await ethers.getContractAt("MockTopazPool", poolAddress);

    const lockedLp = ethers.parseEther("10");
    await (await pool.mint(await locker.getAddress(), lockedLp)).wait();
    await (await locker.registerGraduatedPool(
      await campaign.getAddress(),
      await creator.getAddress(),
      await creator.getAddress(),
      poolAddress,
      tokenAddress,
      wbnbAddress,
      lockedLp,
    )).wait();

    // Accrue real fees on the pool for the locker to harvest.
    const token0 = await pool.token0();
    const tokenIsZero = token0.toLowerCase() === tokenAddress.toLowerCase();
    await (await token.approve(poolAddress, FEE_TOKEN)).wait();
    await (await wbnb.approve(poolAddress, FEE_WBNB)).wait();
    await (await pool.fundFees(
      await locker.getAddress(),
      tokenIsZero ? FEE_TOKEN : FEE_WBNB,
      tokenIsZero ? FEE_WBNB : FEE_TOKEN,
    )).wait();

    return { owner, creator, routing, locker, token, wbnb, tokenAddress, wbnbAddress, pool, poolAddress, lockedLp };
  }

  it("pays the creator, strands the protocol share, and reports success either way", async function () {
    const fx = await setup();
    const protocolVault = await fx.routing.protocolVault.getAddress();
    const creatorAddress = await fx.creator.getAddress();

    expect(await (fx.routing.treasuryRouter as any).authorizedLpLocker(await fx.locker.getAddress())).to.equal(false);

    // The harvest does not revert. That is the whole problem.
    await expect(fx.locker.harvest(fx.poolAddress)).to.not.be.reverted;

    const expectedCreatorToken = (FEE_TOKEN * CREATOR_BPS) / BPS;
    const expectedCreatorWbnb = (FEE_WBNB * CREATOR_BPS) / BPS;
    expect(await fx.token.balanceOf(creatorAddress), "creator is paid in full").to.equal(expectedCreatorToken);
    expect(await fx.wbnb.balanceOf(creatorAddress)).to.equal(expectedCreatorWbnb);

    // And the protocol vault, which is the thing nobody looks at, is empty.
    expect(await fx.token.balanceOf(protocolVault), "protocol vault got nothing").to.equal(0n);
    expect(await fx.wbnb.balanceOf(protocolVault)).to.equal(0n);

    // The money is not lost, it is parked.
    expect(await fx.locker.pendingProtocolToken(fx.tokenAddress)).to.equal(FEE_TOKEN - expectedCreatorToken);
    expect(await fx.locker.pendingProtocolToken(fx.wbnbAddress)).to.equal(FEE_WBNB - expectedCreatorWbnb);
  });

  it("authorizing the locker lets the parked share be recovered by anyone", async function () {
    const fx = await setup();
    const lockerAddress = await fx.locker.getAddress();
    const protocolVault = await fx.routing.protocolVault.getAddress();
    await (await fx.locker.harvest(fx.poolAddress)).wait();

    const parkedToken = await fx.locker.pendingProtocolToken(fx.tokenAddress);
    const parkedWbnb = await fx.locker.pendingProtocolToken(fx.wbnbAddress);
    expect(parkedToken).to.be.greaterThan(0n);

    // The one call the deployment was missing. A fresh router takes it directly;
    // once any locker is authorized the router requires propose/accept instead.
    expect(await (fx.routing.treasuryRouter as any).anyLpLockerAuthorized()).to.equal(false);
    await (await (fx.routing.treasuryRouter as any).setAuthorizedLpLocker(lockerAddress, true)).wait();

    // Permissionless: recovery does not need the admin key.
    const [, , , stranger] = await ethers.getSigners();
    await (await fx.locker.connect(stranger).retryPendingProtocolToken(fx.tokenAddress)).wait();
    await (await fx.locker.connect(stranger).retryPendingProtocolToken(fx.wbnbAddress)).wait();

    expect(await fx.token.balanceOf(protocolVault)).to.equal(parkedToken);
    expect(await fx.wbnb.balanceOf(protocolVault)).to.equal(parkedWbnb);
    expect(await fx.locker.pendingProtocolToken(fx.tokenAddress)).to.equal(0n);
    expect(await fx.locker.pendingProtocolToken(fx.wbnbAddress)).to.equal(0n);
  });

  it("an authorized locker routes the protocol share on the harvest itself", async function () {
    const fx = await setup();
    const protocolVault = await fx.routing.protocolVault.getAddress();
    await (await (fx.routing.treasuryRouter as any).setAuthorizedLpLocker(await fx.locker.getAddress(), true)).wait();

    await (await fx.locker.harvest(fx.poolAddress)).wait();

    expect(await fx.token.balanceOf(protocolVault)).to.equal(FEE_TOKEN - (FEE_TOKEN * CREATOR_BPS) / BPS);
    expect(await fx.wbnb.balanceOf(protocolVault)).to.equal(FEE_WBNB - (FEE_WBNB * CREATOR_BPS) / BPS);
    expect(await fx.locker.pendingProtocolToken(fx.tokenAddress)).to.equal(0n);
  });
});

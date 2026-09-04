import { expect } from "chai";
import { ethers } from "hardhat";

const TRADE = 0;
const FINALIZE = 1;
const STANDARD_LINKED = 0;
const STANDARD_UNLINKED = 1;
const OG_LINKED = 2;

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("TreasuryRouterV2", function () {
  async function deployReceiver() {
    const Receiver = await ethers.getContractFactory("TreasuryRouterReceiverMock");
    const receiver = await Receiver.deploy();
    await receiver.waitForDeployment();
    return receiver;
  }

  async function deployBare(opts?: { weekly?: string; monthly?: string; delay?: number }) {
    const [admin, alice, bob, lockerA, lockerB] = await ethers.getSigners();
    const weekly = opts?.weekly ? undefined : await deployReceiver();
    const monthly = opts?.monthly ? undefined : await deployReceiver();

    const Router = await ethers.getContractFactory("TreasuryRouterV2");
    const router = await Router.deploy(
      await admin.getAddress(),
      opts?.weekly ?? (await weekly!.getAddress()),
      opts?.monthly ?? (await monthly!.getAddress()),
      opts?.delay ?? 3600
    );
    await router.waitForDeployment();

    return { router, weekly, monthly, admin, alice, bob, lockerA, lockerB };
  }

  async function deployConfigured() {
    const fixture = await deployBare();
    const recruiter = await deployReceiver();
    const protocol = await deployReceiver();
    const Community = await ethers.getContractFactory("CommunityRewardsVaultMock");
    const community = await Community.deploy();
    await community.waitForDeployment();

    await fixture.router.setRecruiterRewardsVault(await recruiter.getAddress());
    await fixture.router.setCommunityRewardsVault(await community.getAddress());
    await fixture.router.setProtocolRevenueVault(await protocol.getAddress());

    return { ...fixture, recruiter, community, protocol };
  }

  it("validates constructor arguments and starts with the default 30/70 league split", async () => {
    const [admin] = await ethers.getSigners();
    const weekly = await deployReceiver();
    const monthly = await deployReceiver();
    const Router = await ethers.getContractFactory("TreasuryRouterV2");

    await expect(Router.deploy(ethers.ZeroAddress, await weekly.getAddress(), await monthly.getAddress(), 3600)).to.be.revertedWith(
      "admin=0"
    );
    await expect(Router.deploy(await admin.getAddress(), ethers.ZeroAddress, await monthly.getAddress(), 3600)).to.be.revertedWith(
      "weekly=0"
    );
    await expect(Router.deploy(await admin.getAddress(), await weekly.getAddress(), ethers.ZeroAddress, 3600)).to.be.revertedWith(
      "monthly=0"
    );
    await expect(Router.deploy(await admin.getAddress(), await weekly.getAddress(), await monthly.getAddress(), 3599)).to.be.revertedWith(
      "delay too small"
    );

    const { router } = await deployBare();
    expect(await router.weeklyLeagueBps()).to.eq(3000n);
    expect(await router.monthlyLeagueBps()).to.eq(7000n);

    const split = await router.previewLeagueSplit(10_000n);
    expect(split.weekly).to.eq(3000n);
    expect(split.monthly).to.eq(7000n);
  });

  it("forwards direct native deposits only to the weekly league vault and preserves paused balances", async () => {
    const { router, weekly, monthly, admin } = await deployBare();
    const routerAddress = await router.getAddress();

    await expect(admin.sendTransaction({ to: routerAddress, value: 1234n }))
      .to.emit(router, "Forwarded")
      .withArgs(await weekly!.getAddress(), 1234n);
    expect(await weekly!.received()).to.eq(1234n);
    expect(await monthly!.received()).to.eq(0n);
    expect(await ethers.provider.getBalance(routerAddress)).to.eq(0n);

    await expect(router.setForwardingPaused(true)).to.emit(router, "ForwardingPaused").withArgs(true);
    await admin.sendTransaction({ to: routerAddress, value: 777n });
    expect(await weekly!.received()).to.eq(1234n);
    expect(await ethers.provider.getBalance(routerAddress)).to.eq(777n);

    await router.forward();
    expect(await ethers.provider.getBalance(routerAddress)).to.eq(777n);

    await router.setForwardingPaused(false);
    await expect(router.forward()).to.emit(router, "Forwarded").withArgs(await weekly!.getAddress(), 777n);
    expect(await weekly!.received()).to.eq(2011n);
    expect(await ethers.provider.getBalance(routerAddress)).to.eq(0n);
  });

  it("does not revert direct deposits when the weekly vault rejects native value", async () => {
    const [admin] = await ethers.getSigners();
    const Reverting = await ethers.getContractFactory("RevertingTreasuryReceiverMock");
    const rejectingWeekly = await Reverting.deploy();
    await rejectingWeekly.waitForDeployment();
    const monthly = await deployReceiver();

    const { router } = await deployBare({ weekly: await rejectingWeekly.getAddress(), monthly: await monthly.getAddress() });
    const routerAddress = await router.getAddress();

    await expect(admin.sendTransaction({ to: routerAddress, value: 999n }))
      .to.emit(router, "ForwardFailed")
      .withArgs(await rejectingWeekly.getAddress(), 999n);
    expect(await ethers.provider.getBalance(routerAddress)).to.eq(999n);
  });

  it("enforces admin-only vault setters and league split totals", async () => {
    const { router, alice } = await deployBare();
    const receiver = await deployReceiver();
    const receiverAddress = await receiver.getAddress();

    await expect(router.connect(alice).setRecruiterRewardsVault(receiverAddress)).to.be.revertedWith("not admin");
    await expect(router.connect(alice).setCommunityRewardsVault(receiverAddress)).to.be.revertedWith("not admin");
    await expect(router.connect(alice).setProtocolRevenueVault(receiverAddress)).to.be.revertedWith("not admin");
    await expect(router.connect(alice).setLeagueSplit(3000, 7000)).to.be.revertedWith("not admin");

    await expect(router.setRecruiterRewardsVault(ethers.ZeroAddress)).to.be.revertedWith("target=0");
    await expect(router.setCommunityRewardsVault(ethers.ZeroAddress)).to.be.revertedWith("target=0");
    await expect(router.setProtocolRevenueVault(ethers.ZeroAddress)).to.be.revertedWith("target=0");
    await expect(router.setLeagueSplit(3000, 6999)).to.be.revertedWith("bad split");

    await expect(router.setRecruiterRewardsVault(receiverAddress))
      .to.emit(router, "RecruiterRewardsVaultUpdated")
      .withArgs(ethers.ZeroAddress, receiverAddress);
    await expect(router.setCommunityRewardsVault(receiverAddress))
      .to.emit(router, "CommunityRewardsVaultUpdated")
      .withArgs(ethers.ZeroAddress, receiverAddress);
    await expect(router.setProtocolRevenueVault(receiverAddress))
      .to.emit(router, "ProtocolRevenueVaultUpdated")
      .withArgs(ethers.ZeroAddress, receiverAddress);
    await expect(router.setLeagueSplit(4000, 6000)).to.emit(router, "LeagueSplitUpdated").withArgs(4000, 6000);

    const split = await router.previewLeagueSplit(10_000n);
    expect(split.weekly).to.eq(4000n);
    expect(split.monthly).to.eq(6000n);
  });

  it("executes a standard unlinked trade into weekly, monthly, airdrop, and protocol balances", async () => {
    const { router, weekly, monthly, recruiter, community, protocol, alice } = await deployConfigured();

    await expect(router.connect(alice).route(TRADE, STANDARD_UNLINKED, { value: 10_000n }))
      .to.emit(router, "RouteExecuted")
      .withArgs(TRADE, STANDARD_UNLINKED, 10_000n, 3750n, 0n, 1500n, 0n, 4750n);

    expect(await weekly!.received()).to.eq(1125n);
    expect(await monthly!.received()).to.eq(2625n);
    expect(await recruiter.received()).to.eq(0n);
    expect(await community.airdropReceived()).to.eq(1500n);
    expect(await community.squadReceived()).to.eq(0n);
    expect(await protocol.received()).to.eq(4750n);
  });

  it("executes linked finalize routes without touching league treasuries", async () => {
    const { router, weekly, monthly, recruiter, community, protocol, alice } = await deployConfigured();

    await expect(router.connect(alice).route(FINALIZE, STANDARD_LINKED, { value: 10_000n }))
      .to.emit(router, "RouteExecuted")
      .withArgs(FINALIZE, STANDARD_LINKED, 10_000n, 0n, 1500n, 0n, 250n, 8250n);

    expect(await weekly!.received()).to.eq(0n);
    expect(await monthly!.received()).to.eq(0n);
    expect(await recruiter.received()).to.eq(1500n);
    expect(await community.airdropReceived()).to.eq(0n);
    expect(await community.squadReceived()).to.eq(250n);
    expect(await protocol.received()).to.eq(8250n);
  });

  it("rejects route execution while paused, empty, missing configured vaults, or with rejecting targets", async () => {
    const { router } = await deployBare();

    await router.setForwardingPaused(true);
    await expect(router.route(TRADE, STANDARD_LINKED, { value: 1n })).to.be.revertedWith("routing paused");

    await router.setForwardingPaused(false);
    await expect(router.route(TRADE, STANDARD_LINKED, { value: 0n })).to.be.revertedWith("amount=0");
    await expect(router.route(TRADE, STANDARD_LINKED, { value: 1n })).to.be.revertedWith("recruiterVault=0");

    const configured = await deployConfigured();
    const Reverting = await ethers.getContractFactory("RevertingTreasuryReceiverMock");
    const rejecting = await Reverting.deploy();
    await rejecting.waitForDeployment();
    await configured.router.proposeProtocolRevenueVault(await rejecting.getAddress());
    await increaseTime(3600);
    await configured.router.acceptProtocolRevenueVault();

    await expect(configured.router.route(TRADE, STANDARD_UNLINKED, { value: 10_000n })).to.be.revertedWith("route failed");
  });

  it("enforces delayed weekly and monthly treasury rotations", async () => {
    const { router, weekly, monthly, alice } = await deployBare();
    const newWeekly = await deployReceiver();
    const newMonthly = await deployReceiver();

    await expect(router.connect(alice).proposeWeeklyLeagueVault(await newWeekly.getAddress())).to.be.revertedWith("not admin");
    await expect(router.connect(alice).acceptWeeklyLeagueVault()).to.be.revertedWith("not admin");
    await expect(router.proposeWeeklyLeagueVault(ethers.ZeroAddress)).to.be.revertedWith("target=0");
    await expect(router.proposeWeeklyLeagueVault(await alice.getAddress())).to.be.revertedWith("not contract");
    await expect(router.acceptWeeklyLeagueVault()).to.be.revertedWith("no pending");

    await expect(router.proposeWeeklyLeagueVault(await newWeekly.getAddress())).to.emit(router, "WeeklyLeagueVaultProposed");
    await expect(router.acceptWeeklyLeagueVault()).to.be.revertedWith("delay");
    await increaseTime(3600);
    await expect(router.acceptWeeklyLeagueVault())
      .to.emit(router, "WeeklyLeagueVaultActivated")
      .withArgs(await weekly!.getAddress(), await newWeekly.getAddress());
    expect(await router.weeklyLeagueVault()).to.eq(await newWeekly.getAddress());
    expect(await router.pendingWeeklyLeagueVault()).to.eq(ethers.ZeroAddress);
    expect(await router.pendingWeeklyLeagueVaultSince()).to.eq(0n);

    await expect(router.connect(alice).proposeMonthlyLeagueTreasury(await newMonthly.getAddress())).to.be.revertedWith("not admin");
    await expect(router.connect(alice).acceptMonthlyLeagueTreasury()).to.be.revertedWith("not admin");
    await expect(router.proposeMonthlyLeagueTreasury(ethers.ZeroAddress)).to.be.revertedWith("target=0");
    await expect(router.proposeMonthlyLeagueTreasury(await alice.getAddress())).to.be.revertedWith("not contract");
    await expect(router.acceptMonthlyLeagueTreasury()).to.be.revertedWith("no pending");

    await expect(router.proposeMonthlyLeagueTreasury(await newMonthly.getAddress())).to.emit(
      router,
      "MonthlyLeagueTreasuryProposed"
    );
    await expect(router.acceptMonthlyLeagueTreasury()).to.be.revertedWith("delay");
    await increaseTime(3600);
    await expect(router.acceptMonthlyLeagueTreasury())
      .to.emit(router, "MonthlyLeagueTreasuryActivated")
      .withArgs(await monthly!.getAddress(), await newMonthly.getAddress());
    expect(await router.monthlyLeagueTreasury()).to.eq(await newMonthly.getAddress());
    expect(await router.pendingMonthlyLeagueTreasury()).to.eq(ethers.ZeroAddress);
    expect(await router.pendingMonthlyLeagueTreasurySince()).to.eq(0n);
  });

  it("authorizes multiple LP lockers and routes their native revenue to protocol", async () => {
    const { router, protocol, alice, lockerA, lockerB } = await deployConfigured();
    const lockerAAddress = await lockerA.getAddress();
    const lockerBAddress = await lockerB.getAddress();

    await expect(router.connect(lockerA).routeLpNative({ value: 1n })).to.be.revertedWith("not lp locker");
    await expect(router.connect(alice).setAuthorizedLpLocker(lockerAAddress, true)).to.be.revertedWith("not admin");
    await expect(router.setAuthorizedLpLocker(ethers.ZeroAddress, true)).to.be.revertedWith("locker=0");

    await expect(router.setAuthorizedLpLocker(lockerAAddress, true))
      .to.emit(router, "AuthorizedLpLockerUpdated")
      .withArgs(lockerAAddress, true);
    await expect(router.setAuthorizedLpLocker(lockerBAddress, true)).to.be.revertedWith("use propose");
    await expect(router.proposeAuthorizedLpLocker(lockerBAddress)).to.emit(router, "LpLockerAuthorizationProposed");
    await expect(router.acceptAuthorizedLpLocker()).to.be.revertedWith("delay");
    await increaseTime(3600);
    await expect(router.acceptAuthorizedLpLocker())
      .to.emit(router, "AuthorizedLpLockerUpdated")
      .withArgs(lockerBAddress, true);

    await expect(router.connect(lockerA).routeLpNative({ value: 111n }))
      .to.emit(router, "LpNativeRouted")
      .withArgs(lockerAAddress, await protocol.getAddress(), 111n);
    await expect(router.connect(lockerB).routeLpNative({ value: 222n }))
      .to.emit(router, "LpNativeRouted")
      .withArgs(lockerBAddress, await protocol.getAddress(), 222n);
    expect(await protocol.received()).to.eq(333n);
  });

  it("routes LP tokens only from authorized lockers", async () => {
    const { router, protocol, lockerA, lockerB } = await deployConfigured();
    const Token = await ethers.getContractFactory("TreasuryRouterTokenMock");
    const token = await Token.deploy();
    await token.waitForDeployment();

    await token.mint(await lockerA.getAddress(), 1000n);
    await token.connect(lockerA).approve(await router.getAddress(), 400n);

    await expect(router.connect(lockerA).routeLpToken(await token.getAddress(), 400n)).to.be.revertedWith("not lp locker");
    await router.setAuthorizedLpLocker(await lockerA.getAddress(), true);

    await expect(router.connect(lockerA).routeLpToken(ethers.ZeroAddress, 1n)).to.be.revertedWith("token=0");
    await expect(router.connect(lockerA).routeLpToken(await token.getAddress(), 0n)).to.be.revertedWith("amount=0");

    await expect(router.connect(lockerA).routeLpToken(await token.getAddress(), 400n))
      .to.emit(router, "LpTokenRouted")
      .withArgs(await lockerA.getAddress(), await token.getAddress(), await protocol.getAddress(), 400n);

    expect(await token.balanceOf(await protocol.getAddress())).to.eq(400n);
    expect(await token.balanceOf(await lockerA.getAddress())).to.eq(600n);
    await expect(router.connect(lockerB).routeLpToken(await token.getAddress(), 1n)).to.be.revertedWith("not lp locker");
  });

  it("keeps a compatibility primary locker pointer and clears it when deauthorized", async () => {
    const { router, alice, lockerA } = await deployBare();
    const lockerAddress = await lockerA.getAddress();

    await expect(router.connect(alice).setPrimaryLpLocker(lockerAddress)).to.be.revertedWith("not admin");
    await expect(router.setPrimaryLpLocker(ethers.ZeroAddress)).to.be.revertedWith("locker=0");
    await expect(router.setPrimaryLpLocker(lockerAddress)).to.be.revertedWith("locker not authorized");

    await router.setAuthorizedLpLocker(lockerAddress, true);
    await expect(router.setPrimaryLpLocker(lockerAddress))
      .to.emit(router, "PrimaryLpLockerUpdated")
      .withArgs(ethers.ZeroAddress, lockerAddress);
    expect(await router.permanentLpLocker()).to.eq(lockerAddress);

    await expect(router.setAuthorizedLpLocker(lockerAddress, false))
      .to.emit(router, "PrimaryLpLockerUpdated")
      .withArgs(lockerAddress, ethers.ZeroAddress);
    expect(await router.authorizedLpLocker(lockerAddress)).to.eq(false);
    expect(await router.permanentLpLocker()).to.eq(ethers.ZeroAddress);
  });

  it("pauses LP native and token routing for authorized lockers", async () => {
    const { router, protocol, lockerA } = await deployConfigured();
    const Token = await ethers.getContractFactory("TreasuryRouterTokenMock");
    const token = await Token.deploy();
    await token.waitForDeployment();

    await router.setAuthorizedLpLocker(await lockerA.getAddress(), true);
    await token.mint(await lockerA.getAddress(), 10n);
    await token.connect(lockerA).approve(await router.getAddress(), 10n);

    await router.setForwardingPaused(true);
    await expect(router.connect(lockerA).routeLpNative({ value: 1n })).to.be.revertedWith("routing paused");
    await expect(router.connect(lockerA).routeLpToken(await token.getAddress(), 1n)).to.be.revertedWith("routing paused");

    await router.setForwardingPaused(false);
    await router.connect(lockerA).routeLpNative({ value: 1n });
    await router.connect(lockerA).routeLpToken(await token.getAddress(), 1n);
    expect(await protocol.received()).to.eq(1n);
    expect(await token.balanceOf(await protocol.getAddress())).to.eq(1n);
  });

  it("delays replacement of money destinations and only emergency-disables lockers", async () => {
    const { router, recruiter, alice, lockerA } = await deployConfigured();
    const replacement = await deployReceiver();
    const replacementAddress = await replacement.getAddress();

    await expect(router.setRecruiterRewardsVault(replacementAddress)).to.be.revertedWith("use propose");
    await expect(router.proposeRecruiterRewardsVault(await alice.getAddress())).to.be.revertedWith("not contract");
    await expect(router.proposeRecruiterRewardsVault(replacementAddress)).to.emit(router, "RecruiterRewardsVaultProposed");
    await expect(router.acceptRecruiterRewardsVault()).to.be.revertedWith("delay");
    await increaseTime(3600);
    await expect(router.acceptRecruiterRewardsVault())
      .to.emit(router, "RecruiterRewardsVaultUpdated")
      .withArgs(await recruiter.getAddress(), replacementAddress);
    expect(await router.recruiterRewardsVault()).to.eq(replacementAddress);

    await router.setAuthorizedLpLocker(await lockerA.getAddress(), true);
    const lockerC = (await ethers.getSigners())[5];
    await expect(router.setAuthorizedLpLocker(await lockerC.getAddress(), true)).to.be.revertedWith("use propose");
    await router.emergencyDisableLpLocker(await lockerA.getAddress());
    expect(await router.authorizedLpLocker(await lockerA.getAddress())).to.eq(false);
    await expect(router.setAuthorizedLpLocker(await lockerC.getAddress(), true)).to.be.revertedWith("use propose");
  });
});

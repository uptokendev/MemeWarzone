import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { authorizeMonth, latestTs } from "./helpers/settlementAuth";

const AUTH_CEILING = ethers.parseEther("10000");

const MAX_AGE = 3600n;
const MONTHLY_CAP_USD = ethers.parseUnits("1500000", 18);
const ORACLE_PRICE = ethers.parseUnits("600", 18);
const CATEGORY = ethers.keccak256(ethers.toUtf8Bytes("monthly-overall"));

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

function claimLeaf(monthId: bigint, category: string, rank: number, recipient: string, amount: bigint) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32", "uint8", "address", "uint256"],
      [monthId, category, rank, recipient, amount]
    )
  );
}

async function setFreshPrice(feed: any, price: string, decimals = 8) {
  const now = await latestTimestamp();
  await feed.setRoundData(1n, ethers.parseUnits(price, decimals), now, now, 1n);
}

async function deployFixture() {
  const [multisig, rootPoster, winner, other] = await ethers.getSigners();

  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const feed = await Feed.deploy(8);
  await feed.waitForDeployment();
  await setFreshPrice(feed, "600");

  const Oracle = await ethers.getContractFactory("GraduationOracle");
  const oracle = await Oracle.deploy(await feed.getAddress(), MAX_AGE);
  await oracle.waitForDeployment();

  const Charity = await ethers.getContractFactory("CharityTreasury");
  const charity = await Charity.deploy(await multisig.getAddress());
  await charity.waitForDeployment();

  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");
  const monthly = await Monthly.deploy(
    await multisig.getAddress(),
    await rootPoster.getAddress(),
    await oracle.getAddress(),
    await charity.getAddress(),
    0n
  );
  await monthly.waitForDeployment();

  return { multisig, rootPoster, winner, other, feed, oracle, charity, monthly };
}

describe("CharityTreasury", function () {
  it("allows only the multisig to withdraw native and token balances", async () => {
    const { multisig, other, charity } = await loadFixture(deployFixture);

    await multisig.sendTransaction({ to: await charity.getAddress(), value: ethers.parseEther("1") });
    await expect(charity.connect(other).withdrawNative(await other.getAddress(), 1n)).to.be.revertedWithCustomError(charity, "NotMultisig");
    await expect(charity.connect(multisig).withdrawNative(await other.getAddress(), ethers.parseEther("0.4"))).to.changeEtherBalances(
      [charity, other],
      [-ethers.parseEther("0.4"), ethers.parseEther("0.4")]
    );

    const Token = await ethers.getContractFactory("TreasuryRouterTokenMock");
    const token = await Token.deploy();
    await token.waitForDeployment();
    await token.mint(await charity.getAddress(), 100n);

    await expect(charity.connect(other).withdrawToken(await token.getAddress(), await other.getAddress(), 1n)).to.be.revertedWithCustomError(
      charity,
      "NotMultisig"
    );
    await charity.connect(multisig).withdrawToken(await token.getAddress(), await other.getAddress(), 40n);
    expect(await token.balanceOf(await other.getAddress())).to.eq(40n);
  });
});

describe("MonthlyLeagueTreasury", function () {
  it("validates constructor arguments and stores default cap settings", async () => {
    const { multisig, rootPoster, oracle, charity, monthly } = await loadFixture(deployFixture);
    const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");

    expect(await monthly.multisig()).to.eq(await multisig.getAddress());
    expect(await monthly.rootPoster()).to.eq(await rootPoster.getAddress());
    expect(await monthly.oracle()).to.eq(await oracle.getAddress());
    expect(await monthly.charityTreasury()).to.eq(await charity.getAddress());
    expect(await monthly.monthlyCapUsd()).to.eq(MONTHLY_CAP_USD);
    expect(await monthly.totalOutstandingClaims()).to.eq(0n);
    expect(await monthly.unallocatedBalance()).to.eq(0n);

    await expect(Monthly.deploy(ethers.ZeroAddress, await rootPoster.getAddress(), await oracle.getAddress(), await charity.getAddress(), 0n)).to.be
      .revertedWithCustomError(Monthly, "ZeroAddress");
    await expect(Monthly.deploy(await multisig.getAddress(), await rootPoster.getAddress(), ethers.ZeroAddress, await charity.getAddress(), 0n)).to.be
      .revertedWithCustomError(Monthly, "ZeroAddress");
    await expect(Monthly.deploy(await multisig.getAddress(), await rootPoster.getAddress(), await oracle.getAddress(), ethers.ZeroAddress, 0n)).to.be
      .revertedWithCustomError(Monthly, "ZeroAddress");
  });

  it("seals a month once, snapshots price, reserves claims, and transfers overflow atomically to charity", async () => {
    const { multisig, rootPoster, winner, charity, monthly } = await loadFixture(deployFixture);
    const monthId = 202607n;
    const winnerTotal = ethers.parseEther("2500");
    const leaf = claimLeaf(monthId, CATEGORY, 1, await winner.getAddress(), winnerTotal);

    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: ethers.parseEther("3000") });
    await authorizeMonth(monthly, multisig, monthId, AUTH_CEILING);
    await expect(monthly.connect(rootPoster).sealMonth(monthId, leaf, winnerTotal))
      .to.emit(monthly, "MonthSealed")
      .withArgs(monthId, leaf, MONTHLY_CAP_USD, ethers.parseEther("2500"), ethers.parseEther("2500"), winnerTotal, ethers.parseEther("500"));

    const seal = await monthly.monthSeal(monthId);
    expect(seal.isSealed).to.eq(true);
    expect(seal.winnersRoot).to.eq(leaf);
    expect(seal.oraclePrice).to.eq(ORACLE_PRICE);
    expect(seal.capNative).to.eq(ethers.parseEther("2500"));
    expect(seal.playerPool).to.eq(ethers.parseEther("2500"));
    expect(seal.overflow).to.eq(ethers.parseEther("500"));
    expect(await monthly.monthOutstandingClaims(monthId)).to.eq(winnerTotal);
    expect(await monthly.totalOutstandingClaims()).to.eq(winnerTotal);
    expect(await monthly.unallocatedBalance()).to.eq(0n);
    expect(await ethers.provider.getBalance(await charity.getAddress())).to.eq(ethers.parseEther("500"));
    expect(await ethers.provider.getBalance(await monthly.getAddress())).to.eq(ethers.parseEther("2500"));

    await expect(monthly.connect(rootPoster).sealMonth(monthId, leaf, winnerTotal)).to.be.revertedWithCustomError(monthly, "MonthAlreadySealed");
  });

  it("rejects winner totals above the oracle cap or funded unallocated player pool", async () => {
    const { multisig, rootPoster, winner, monthly } = await loadFixture(deployFixture);
    const monthId = 202608n;
    const cap = ethers.parseEther("2500");
    const leaf = claimLeaf(monthId, CATEGORY, 1, await winner.getAddress(), cap + 1n);

    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: ethers.parseEther("3000") });
    await authorizeMonth(monthly, multisig, monthId, AUTH_CEILING);
    await expect(monthly.connect(rootPoster).sealMonth(monthId, leaf, cap + 1n)).to.be.revertedWithCustomError(monthly, "WinnerTotalAboveCap");

    const lowFundedMonth = 202609n;
    const lowFundedLeaf = claimLeaf(lowFundedMonth, CATEGORY, 1, await winner.getAddress(), ethers.parseEther("1000"));
    const { multisig: multisig2, rootPoster: rootPoster2, monthly: monthly2 } = await deployFixture();
    await rootPoster2.sendTransaction({ to: await monthly2.getAddress(), value: ethers.parseEther("900") });
    await authorizeMonth(monthly2, multisig2, lowFundedMonth, AUTH_CEILING);
    await expect(monthly2.connect(rootPoster2).sealMonth(lowFundedMonth, lowFundedLeaf, ethers.parseEther("1000"))).to.be.revertedWithCustomError(
      monthly2,
      "WinnerTotalAbovePlayerPool"
    );
  });

  it("keeps prior-month unclaimed rewards reserved when sealing another month", async () => {
    const { multisig, rootPoster, winner, other, charity, monthly } = await loadFixture(deployFixture);
    const firstMonth = 202607n;
    const secondMonth = 202608n;
    const firstPrize = ethers.parseEther("100");
    const secondPrize = ethers.parseEther("50");
    const firstLeaf = claimLeaf(firstMonth, CATEGORY, 1, await winner.getAddress(), firstPrize);
    const secondLeaf = claimLeaf(secondMonth, CATEGORY, 1, await other.getAddress(), secondPrize);

    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: firstPrize });
    await authorizeMonth(monthly, multisig, firstMonth, AUTH_CEILING);
    await monthly.connect(rootPoster).sealMonth(firstMonth, firstLeaf, firstPrize);
    expect(await monthly.totalOutstandingClaims()).to.eq(firstPrize);

    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: ethers.parseEther("70") });
    expect(await monthly.unallocatedBalance()).to.eq(ethers.parseEther("70"));

    await authorizeMonth(monthly, multisig, secondMonth, AUTH_CEILING);
    await monthly.connect(rootPoster).sealMonth(secondMonth, secondLeaf, secondPrize);

    expect(await monthly.monthOutstandingClaims(firstMonth)).to.eq(firstPrize);
    expect(await monthly.monthOutstandingClaims(secondMonth)).to.eq(secondPrize);
    expect(await monthly.totalOutstandingClaims()).to.eq(firstPrize + secondPrize);
    expect(await ethers.provider.getBalance(await charity.getAddress())).to.eq(0n);
    expect(await ethers.provider.getBalance(await monthly.getAddress())).to.eq(firstPrize + ethers.parseEther("70"));
    expect(await monthly.unallocatedBalance()).to.eq(ethers.parseEther("20"));
  });

  it("prevents multisig withdrawals from consuming sealed winner reserves", async () => {
    const { multisig, rootPoster, winner, other, monthly } = await loadFixture(deployFixture);
    const monthId = 202609n;
    const prize = ethers.parseEther("10");
    const leaf = claimLeaf(monthId, CATEGORY, 1, await winner.getAddress(), prize);

    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: prize + ethers.parseEther("3") });
    await authorizeMonth(monthly, multisig, monthId, AUTH_CEILING);
    await monthly.connect(rootPoster).sealMonth(monthId, leaf, prize);

    expect(await monthly.unallocatedBalance()).to.eq(ethers.parseEther("3"));
    await expect(monthly.connect(multisig).withdrawNative(await other.getAddress(), ethers.parseEther("4"))).to.be.revertedWithCustomError(
      monthly,
      "InsufficientBalance"
    );
    await expect(monthly.connect(multisig).withdrawNative(await other.getAddress(), ethers.parseEther("3"))).to.changeEtherBalances(
      [monthly, other],
      [-ethers.parseEther("3"), ethers.parseEther("3")]
    );
    expect(await monthly.unallocatedBalance()).to.eq(0n);
    expect(await monthly.totalOutstandingClaims()).to.eq(prize);
  });

  it("reverts sealing when oracle data is stale or charity overflow transfer fails", async () => {
    const { multisig, rootPoster, winner, feed, monthly } = await loadFixture(deployFixture);
    const now = await latestTimestamp();
    await feed.setRoundData(2n, ethers.parseUnits("600", 8), now - MAX_AGE - 1n, now - MAX_AGE - 1n, 2n);

    const leaf = claimLeaf(202610n, CATEGORY, 1, await winner.getAddress(), ethers.parseEther("1"));
    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: ethers.parseEther("2") });
    await authorizeMonth(monthly, multisig, 202610n, AUTH_CEILING);
    const monthlyOracle = await ethers.getContractAt("GraduationOracle", await monthly.oracle());
    await expect(monthly.connect(rootPoster).sealMonth(202610n, leaf, ethers.parseEther("1"))).to.be.revertedWithCustomError(
      monthlyOracle,
      "StalePrice"
    );

    const [, rejectingRootPoster] = await ethers.getSigners();
    const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
    const freshFeed = await Feed.deploy(8);
    await freshFeed.waitForDeployment();
    await setFreshPrice(freshFeed, "600");
    const Oracle = await ethers.getContractFactory("GraduationOracle");
    const oracle = await Oracle.deploy(await freshFeed.getAddress(), MAX_AGE);
    await oracle.waitForDeployment();
    const Rejecting = await ethers.getContractFactory("RevertingTreasuryReceiverMock");
    const rejectingCharity = await Rejecting.deploy();
    await rejectingCharity.waitForDeployment();
    const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");
    const revertingMonthly = await Monthly.deploy(
      await multisig.getAddress(),
      await rejectingRootPoster.getAddress(),
      await oracle.getAddress(),
      await rejectingCharity.getAddress(),
      0n
    );
    await revertingMonthly.waitForDeployment();

    await rejectingRootPoster.sendTransaction({ to: await revertingMonthly.getAddress(), value: ethers.parseEther("3000") });
    await authorizeMonth(revertingMonthly, multisig, 202611n, AUTH_CEILING);
    await expect(revertingMonthly.connect(rejectingRootPoster).sealMonth(202611n, leaf, ethers.parseEther("2500"))).to.be.revertedWithCustomError(
      revertingMonthly,
      "NativeTransferFailed"
    );
    expect(await revertingMonthly.totalOutstandingClaims()).to.eq(0n);
  });

  it("allows winners to claim from the sealed root and releases their reserved balance", async () => {
    const { multisig, rootPoster, winner, other, monthly } = await loadFixture(deployFixture);
    const monthId = 202612n;
    const amount = ethers.parseEther("12.5");
    const leaf = claimLeaf(monthId, CATEGORY, 1, await winner.getAddress(), amount);

    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: amount });
    await authorizeMonth(monthly, multisig, monthId, AUTH_CEILING);
    await monthly.connect(rootPoster).sealMonth(monthId, leaf, amount);
    expect(await monthly.monthOutstandingClaims(monthId)).to.eq(amount);

    await expect(monthly.claim(monthId, CATEGORY, 1, await winner.getAddress(), amount, []))
      .to.emit(monthly, "ClaimReserveUpdated")
      .withArgs(monthId, 0n, 0n);
    expect(await monthly.monthClaimedTotal(monthId)).to.eq(amount);
    expect(await monthly.monthOutstandingClaims(monthId)).to.eq(0n);
    expect(await monthly.totalOutstandingClaims()).to.eq(0n);

    await expect(monthly.claim(monthId, CATEGORY, 1, await winner.getAddress(), amount, [])).to.be.revertedWithCustomError(monthly, "AlreadyClaimed");
    await expect(monthly.claim(monthId, CATEGORY, 2, await other.getAddress(), 1n, [])).to.be.revertedWithCustomError(monthly, "BadProof");
  });

  it("restricts sealing to rootPoster or multisig and rootPoster updates to multisig", async () => {
    const { multisig, rootPoster, other, winner, monthly } = await loadFixture(deployFixture);
    const monthId = 202701n;
    const leaf = claimLeaf(monthId, CATEGORY, 1, await winner.getAddress(), 1n);

    await other.sendTransaction({ to: await monthly.getAddress(), value: 1n });
    await expect(monthly.connect(other).sealMonth(monthId, leaf, 1n)).to.be.revertedWithCustomError(monthly, "NotRootPosterOrMultisig");
    await expect(monthly.connect(other).setRootPoster(await other.getAddress())).to.be.revertedWithCustomError(monthly, "NotMultisig");

    await monthly.connect(multisig).setRootPoster(await other.getAddress());
    expect(await monthly.rootPoster()).to.eq(await other.getAddress());
    await authorizeMonth(monthly, multisig, monthId, AUTH_CEILING);
    await monthly.connect(other).sealMonth(monthId, leaf, 1n);
    expect((await monthly.monthSeal(monthId)).isSealed).to.eq(true);
    expect(await monthly.rootPoster()).to.not.eq(await rootPoster.getAddress());
  });

  it("requires Safe-authorized canonical months and rejects invented or skipped settlement", async () => {
    const { multisig, rootPoster, other, monthly } = await loadFixture(deployFixture);
    const leaf = ethers.keccak256(ethers.toUtf8Bytes("month-leaf"));
    await rootPoster.sendTransaction({ to: await monthly.getAddress(), value: ethers.parseEther("10") });

    await expect(monthly.connect(rootPoster).sealMonth(202608n, leaf, 1n)).to.be.revertedWithCustomError(monthly, "MonthNotAuthorized");
    await expect(monthly.connect(rootPoster).authorizeMonth(202608n, AUTH_CEILING, 1, 2, false)).to.be.revertedWithCustomError(
      monthly,
      "NotMultisig"
    );
    await expect(monthly.connect(multisig).authorizeMonth(999999n, AUTH_CEILING, 1, 2, false)).to.be.revertedWithCustomError(
      monthly,
      "InvalidMonthId"
    );
    await expect(monthly.connect(multisig).authorizeMonth(202613n, AUTH_CEILING, 1, 2, false)).to.be.revertedWithCustomError(
      monthly,
      "InvalidMonthId"
    );

    await authorizeMonth(monthly, multisig, 202608n, AUTH_CEILING);
    await expect(monthly.connect(multisig).authorizeMonth(202610n, AUTH_CEILING, 1, 2, false)).to.be.revertedWithCustomError(
      monthly,
      "MonthNotNextCanonical"
    );

    await monthly.connect(multisig).revokeMonth(202608n);
    await expect(monthly.connect(rootPoster).sealMonth(202608n, leaf, 1n)).to.be.revertedWithCustomError(monthly, "MonthNotAuthorized");

    await authorizeMonth(monthly, multisig, 202608n, ethers.parseEther("1"));
    await expect(monthly.connect(rootPoster).sealMonth(202608n, leaf, ethers.parseEther("2"))).to.be.revertedWithCustomError(
      monthly,
      "WinnerTotalAboveAuthorizedMax"
    );

    const now = Number(await latestTs());
    await monthly.connect(multisig).authorizeMonth(202608n, AUTH_CEILING, now + 10_000, now + 20_000, false);
    await expect(monthly.connect(rootPoster).sealMonth(202608n, leaf, 1n)).to.be.revertedWithCustomError(monthly, "SealTooEarly");

    await monthly.connect(multisig).authorizeMonth(202608n, AUTH_CEILING, now - 20, now - 1, false);
    await expect(monthly.connect(rootPoster).sealMonth(202608n, leaf, 1n)).to.be.revertedWithCustomError(monthly, "SealAuthExpired");

    await authorizeMonth(monthly, multisig, 202608n, AUTH_CEILING);
    await monthly.connect(rootPoster).sealMonth(202608n, leaf, 1n);
    await expect(monthly.connect(multisig).authorizeMonth(202608n, AUTH_CEILING, 1, 2, false)).to.be.revertedWithCustomError(
      monthly,
      "MonthAuthConsumed"
    );

    await expect(monthly.connect(multisig).authorizeMonth(202610n, AUTH_CEILING, 1, 2, false)).to.be.revertedWithCustomError(
      monthly,
      "MonthNotNextCanonical"
    );
    await authorizeMonth(monthly, multisig, 202609n, AUTH_CEILING);
    await monthly.connect(rootPoster).sealMonth(202609n, leaf, 1n);

    await authorizeMonth(monthly, multisig, 202701n, AUTH_CEILING, true);
    expect((await monthly.monthAuthorization(202701n)).exceptional).to.eq(true);
    await expect(monthly.connect(other).revokeMonth(202701n)).to.be.revertedWithCustomError(monthly, "NotMultisig");
  });
});

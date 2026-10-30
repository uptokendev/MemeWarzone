// Gen-8 audit regressions on the Bark stack (Chikyu fork, Barkswap's real pools), the rows of the gen-8 F1-F17 mapping
// in docs/dogeos/barkswap-audit.md (Gate 0) whose test column names t10, plus B11 and F3/F4 with the real splitter:
//   F1           reserve release by the price NOW: a one-transaction forced graduation (buy to the graduation price,
//                release, sell back) cannot release; release at the graduation price works, fallen back it is refused
//   F1 residual  1 h between the latch and a release (+59 min / +59:59 refused, +60 min allowed); the accepted residual
//                (audit I-5): a second bundle one hour after a forced latch releases, to the creator only
//   F3           a router change parks the bucket for the old splitter (its plan still routes; payParkedRouter is its
//                next run); the new router claims only later fees
//   F4           claimRouter only by the router, its current operator() (the splitter's operator, rotations follow) or
//                the owner; a third party cannot break a plan
//   F5           holder-batch claim deadline bounds, named in the approval, re-checked at execution (real distributor)
//   B11          a route run never reverts OutOfBand at Barkswap community fee 0, the live 30 and 1000 (100%)
// The other "applies" rows (F2, F6, B, A4, A12, A13, I6, I7/I17, I12, I13) are owned by BarkLaunch / BarkPlugin (t8)
// and BarkMoney / BarkAdmin (t9). Plan task t10.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkGen8Regressions.fork.spec.ts
//
// Needs the root build too (`npx hardhat compile`): the reused vaults deploy from artifacts/ (solc 0.8.24) through
// fixtures/rootVaults.ts. A small TEST-ONLY force graduator (BarkForceGraduator, source below; the Algebra counterpart
// of gen-8's ForceGraduator) is compiled inline with solc 0.8.26. Nothing reaches Chikyu.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BARKSWAP,
  CREATOR_RESERVE,
  WAD,
  approveRouter,
  barkSwapOf,
  deployBarkStack,
  eventsOf,
  impersonate,
  launchCoin,
  poolState,
  raiseOfA,
  readyFork,
  routerBuy,
  routerSell,
  type BarkStack,
  type C,
  type LaunchResult,
} from "./fixtures/barkswap";
import { barkVaultsOf, compileInline, deployRealVaults, wireRealVaults, type RealVaults } from "./fixtures/rootVaults";

const DAY = 86_400n;
const RESERVE_RELEASE_DELAY = 3_600n;
const MIN_CLAIM_WINDOW = 7n * DAY;
const MAX_CLAIM_WINDOW = 365n * DAY;
const LIVE_COMMUNITY_FEE = 30n;

// ------------------------------------------------------------------------------------------------- test-only graduator

/** TEST ONLY. gen-8's ForceGraduator on Algebra: in ONE transaction, buy to the graduation price (limit sqrtGrad),
 *  try MwzBarkReserveLock.release(coin) between the legs (outside any swap), sell every coin bought back (limit
 *  sqrtStart), refund the unspent DOGE. Records the release outcome and the round trip's net cost. */
const GRADUATOR_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IGPool {
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IGToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IGWNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

contract BarkForceGraduator {
    address public pool;
    bool public releaseOk;
    bytes public releaseError;
    uint256 public lastBuyIn;
    uint256 public lastCoinsBought;
    uint256 public lastSellOut;
    uint256 public lastNetCost;

    receive() external payable {}

    function run(address pool_, uint256 buyIn, uint160 sqrtGrad, uint160 sqrtStart, address lock, address coin) external payable {
        address w = IGPool(pool_).token1();
        IGWNative(w).deposit{value: msg.value}();
        pool = pool_;
        (int256 b0, int256 b1) = IGPool(pool_).swap(address(this), false, int256(buyIn), sqrtGrad, "");
        lastBuyIn = uint256(b1);
        lastCoinsBought = uint256(-b0);
        if (lock != address(0)) {
            (bool ok, bytes memory err) = lock.call(abi.encodeWithSignature("release(address)", coin));
            releaseOk = ok;
            releaseError = err;
        }
        (, int256 s1) = IGPool(pool_).swap(address(this), true, int256(lastCoinsBought), sqrtStart, "");
        lastSellOut = uint256(-s1);
        pool = address(0);
        uint256 left = IGToken(w).balanceOf(address(this));
        IGWNative(w).withdraw(left);
        lastNetCost = msg.value - left;
        (bool sent,) = msg.sender.call{value: left}("");
        require(sent, "refund");
    }

    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == pool && pool != address(0), "graduator: not the pool");
        if (d0 > 0) require(IGToken(IGPool(msg.sender).token0()).transfer(msg.sender, uint256(d0)), "pay0");
        if (d1 > 0) require(IGToken(IGPool(msg.sender).token1()).transfer(msg.sender, uint256(d1)), "pay1");
    }
}
`;


// ------------------------------------------------------------------------------------------------- fixture

interface Env {
  s: BarkStack;
  v: RealVaults;
  graduator: C;
}

/** The reused vaults from the root build, the Bark stack routed into them, t15's wiring, the force graduator. */
async function regressionsFixture(): Promise<Env> {
  await readyFork();
  const [deployer] = await ethers.getSigners();
  const v = await deployRealVaults(deployer);
  const s = await deployBarkStack({ vaults: await barkVaultsOf(v) });
  await wireRealVaults(s, v);
  const ga = await compileInline("BarkForceGraduator", GRADUATOR_SOURCE);
  const graduator = (await new ethers.ContractFactory(ga.abi, ga.bytecode, deployer).deploy()) as unknown as C;
  await graduator.waitForDeployment();
  return { s, v, graduator };
}

// ------------------------------------------------------------------------------------------------- helpers

const balanceOf = (a: string) => ethers.provider.getBalance(a);
const blockTime = async (rc: { blockNumber: number }) => BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp);

describe("Bark gen-8 audit regressions on the Chikyu fork (t10)", function () {
  let env: Env;
  let s: BarkStack;

  beforeEach(async function () {
    env = await loadFixture(regressionsFixture);
    s = env.s;
  });

  async function openCoin(opts: Parameters<typeof launchCoin>[1] = {}): Promise<LaunchResult> {
    const L = await launchCoin(s, opts);
    if ((await time.latest()) < Number(L.openAt) + 61) await time.increaseTo(L.openAt + 61n);
    return L;
  }

  async function graduate(L: LaunchResult, buyer = s.signers.trader) {
    return routerBuy(s, buyer, L.coin, (raiseOfA(L) * 13n) / 10n);
  }

  async function collect(coin: string) {
    return (await (await s.launcher.connect(s.signers.keeper).collect(coin, { gasLimit: 3_000_000n })).wait())!;
  }

  /** Bonding volume on `L` collected into the launcher's books (router bucket > 0). */
  async function bondingFees(L: LaunchResult, amount = 20n * WAD) {
    await routerBuy(s, s.signers.trader, L.coin, amount);
    await collect(L.coin);
  }

  async function bundle(L: LaunchResult) {
    const value = raiseOfA(L) * 2n;
    const rc = (await (
      await env.graduator
        .connect(s.signers.outsider)
        .run(L.pool, value, L.sqrtGrad, L.sqrtStart, await s.reserveLock.getAddress(), L.coin, { value, gasLimit: 6_000_000n })
    ).wait())!;
    return rc;
  }

  async function vaultLiabilitiesMatch() {
    expect(await s.choiceVault.totalLiabilities()).to.equal(await balanceOf(await s.choiceVault.getAddress()));
  }

  // ================================================================================================= F1
  describe("F1: reserve release by the price NOW (forced graduation)", function () {
    it("A-1 one transaction: buy to the graduation price, release, sell back cannot release (ReserveTooEarly); trades back in A pay the bonding rate", async function () {
      const { trader, outsider } = s.signers;
      const L = await openCoin();
      const rc = await bundle(L);
      const ts = await blockTime(rc);
      expect(await env.graduator.releaseOk()).to.equal(false);
      expect(await env.graduator.releaseError()).to.equal(s.reserveLock.interface.encodeErrorResult("ReserveTooEarly", []));
      // the bundle latched (the buy ended exactly at the graduation price) and took the one 2% fee inline
      expect(eventsOf(rc, s.plugin, "Graduated")).to.have.length(1);
      const pp = await s.plugin.pools(L.pool);
      expect([pp.graduated, pp.graduatedAt]).to.deep.equal([true, ts]);
      expect(eventsOf(rc, s.launcher, "GraduationFeeTaken")).to.have.length(1);
      expect(await env.graduator.lastNetCost()).to.be.greaterThan(0n);
      // the price is back inside A: the reserve stays, the fee phase is bonding again (phase by the START price)
      expect((await poolState(L.pool)).price).to.be.lessThan(L.sqrtGrad);
      expect((await s.reserveLock.reserves(L.coin)).amount).to.equal(CREATOR_RESERVE);
      const sw = barkSwapOf(s, await routerBuy(s, trader, L.coin, WAD));
      expect([sw.phase, sw.rateBps, sw.crossing]).to.deep.equal([0n, 200n, false]);
      // and an hour later the price is still in A: refused by the price now
      await time.increase(RESERVE_RELEASE_DELAY);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.be.revertedWithCustomError(s.reserveLock, "PriceBelowGraduation");
    });

    it("release at exactly the graduation price works; fallen back below it is refused; back at it, it works again", async function () {
      const { trader, outsider, creator } = s.signers;
      const L = await openCoin();
      await graduate(L);
      await time.increase(RESERVE_RELEASE_DELAY);
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, 200_000_000n * WAD);
      expect((await poolState(L.pool)).price).to.be.lessThan(L.sqrtGrad);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.be.revertedWithCustomError(s.reserveLock, "PriceBelowGraduation");
      // a buy limited at sqrtGrad ends exactly there (sqrtP >= sqrtGrad holds with equality)
      await routerBuy(s, trader, L.coin, raiseOfA(L), { limit: L.sqrtGrad });
      expect((await poolState(L.pool)).price).to.equal(L.sqrtGrad);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.emit(s.reserveLock, "ReserveReleased").withArgs(L.coin, creator.address, CREATOR_RESERVE);
    });
  });

  // ================================================================================================= F1 residual
  describe("F1 residual: 1 h between the latch and a release", function () {
    it("refused at latch + 59 min and + 59:59, allowed at + 60 min; graduatedAt is set once", async function () {
      const { trader, outsider, creator } = s.signers;
      const L = await openCoin();
      const rc = await graduate(L);
      const at = await blockTime(rc);
      expect((await s.plugin.pools(L.pool)).graduatedAt).to.equal(at);
      // a second crossing later does not move graduatedAt
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, 200_000_000n * WAD);
      await routerBuy(s, trader, L.coin, raiseOfA(L));
      expect((await poolState(L.pool)).price).to.be.at.least(L.sqrtGrad);
      expect((await s.plugin.pools(L.pool)).graduatedAt).to.equal(at);
      for (const dt of [59n * 60n, RESERVE_RELEASE_DELAY - 1n]) {
        await time.setNextBlockTimestamp(at + dt);
        await expect(s.reserveLock.connect(outsider).release(L.coin, { gasLimit: 500_000n })).to.be.revertedWithCustomError(s.reserveLock, "ReserveTooEarly");
        expect(BigInt(await time.latest())).to.equal(at + dt); // the refused release was mined at that second
      }
      await time.setNextBlockTimestamp(at + RESERVE_RELEASE_DELAY);
      const rel = (await (await s.reserveLock.connect(outsider).release(L.coin, { gasLimit: 500_000n })).wait())!;
      expect(await blockTime(rel)).to.equal(at + RESERVE_RELEASE_DELAY);
      expect(eventsOf(rel, s.reserveLock, "ReserveReleased").map((e) => [e.args.to, e.args.amount])).to.deep.equal([[creator.address, CREATOR_RESERVE]]);
    });

    it("accepted residual (audit I-5): one hour after a forced latch a second bundle releases the reserve, to the creator only, and the attacker pays both round trips", async function () {
      const { creator } = s.signers;
      const L = await openCoin();
      await bundle(L);
      const cost1 = await env.graduator.lastNetCost();
      expect(await env.graduator.releaseOk()).to.equal(false);
      await time.increase(RESERVE_RELEASE_DELAY);
      const c0 = await L.coinContract.balanceOf(creator.address);
      const rc = await bundle(L);
      expect(await env.graduator.releaseOk()).to.equal(true);
      expect(eventsOf(rc, s.reserveLock, "ReserveReleased").map((e) => [e.args.coin, e.args.to, e.args.amount])).to.deep.equal([[L.coin, creator.address, CREATOR_RESERVE]]);
      expect((await L.coinContract.balanceOf(creator.address)) - c0).to.equal(CREATOR_RESERVE);
      // the reserve goes to the creator only: the attacker paid two round trips (bonding fee up, post fee down, the 2%
      // burn once) and holds only coins it bought (the sell-back into the thinner A stopped at the start price, F2)
      expect(cost1).to.be.greaterThan(0n);
      expect((await poolState(L.pool)).price).to.be.at.least(L.sqrtStart);
      expect(await env.graduator.lastNetCost()).to.be.greaterThan(0n);
      expect(eventsOf(rc, s.launcher, "GraduationFeeTaken")).to.have.length(0); // taken once, in the first bundle
    });
  });

  // ================================================================================================= F4
  describe("F4: claimRouter by the router, its current operator() or the owner", function () {
    it("an operator rotation on the splitter moves the right; a cleared operator leaves the router and the owner; nobody else", async function () {
      const { operator, outsider, keeper, creator, deployer, spare } = s.signers;
      const splitter = await s.splitter.getAddress();
      const L = await openCoin();
      await bondingFees(L);
      for (const who of [outsider, keeper, creator, spare]) {
        await expect(s.launcher.connect(who).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      }
      await expect(s.splitter.connect(outsider).setOperator(spare.address)).to.be.revertedWithCustomError(s.splitter, "NotAdmin");
      await expect(s.splitter.connect(deployer).setOperator(spare.address)).to.emit(s.splitter, "OperatorUpdated").withArgs(operator.address, spare.address);
      await expect(s.launcher.connect(operator).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      const owed = await s.launcher.routerOwed();
      const bonding = await s.launcher.pendingBondingFees();
      await expect(s.launcher.connect(spare).claimRouter()).to.emit(s.launcher, "RouterClaimed").withArgs(splitter, owed, bonding, 0n);
      expect(await balanceOf(splitter)).to.equal(owed);
      await expect(s.launcher.connect(spare).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      // a cleared operator: the old one and the cleared key are refused; the router itself and the owner still claim
      await (await s.splitter.connect(deployer).setOperator(ethers.ZeroAddress)).wait();
      await bondingFees(L);
      for (const who of [spare, operator, outsider]) {
        await expect(s.launcher.connect(who).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      }
      await (await s.launcher.connect(deployer).claimRouter()).wait();
      expect(await s.launcher.routerOwed()).to.equal(0n);
      // the owner (or admin) still routes the whole bounded run
      const paid = await s.launcher.routerPaid(splitter);
      const [total, B, G] = await s.splitter.pending();
      expect(total).to.equal(paid.amount);
      const b = await s.splitter.bands(B, G);
      await (await s.splitter.connect(deployer).route(1, paid.amount, b.rsaMin, 0n, 0n, ethers.ZeroHash)).wait();
      expect(await balanceOf(splitter)).to.equal(0n);
    });

    it("a third party cannot claim between the plan and the route; the planned run routes while new fees wait in the launcher", async function () {
      const { operator, outsider } = s.signers;
      const splitter = await s.splitter.getAddress();
      const L = await openCoin();
      await bondingFees(L);
      await (await s.launcher.connect(operator).claimRouter()).wait();
      const plan = await s.launcher.routerPaid(splitter);
      const [, B, G] = await s.splitter.pending();
      await bondingFees(L, 9n * WAD);
      const waiting = await s.launcher.routerOwed();
      expect(waiting).to.be.greaterThan(0n);
      await expect(s.launcher.connect(outsider).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      const b = await s.splitter.bands(B, G);
      await (await s.splitter.connect(operator).route(1, plan.amount, b.rsaMax, 0n, 0n, ethers.id("plan-1"))).wait();
      expect(await s.launcher.routerOwed()).to.equal(waiting);
      expect((await s.splitter.pending())[0]).to.equal(0n);
    });
  });

  // ================================================================================================= F3
  describe("F3: a router change parks the bucket for the old splitter", function () {
    it("a plan made before the change still routes; the parked bucket is paid to the old splitter by anyone and is its next run; the new router gets only later fees", async function () {
      const { operator, outsider, deployer, spare } = s.signers;
      const splitter = await s.splitter.getAddress();
      const L = await openCoin();
      await bondingFees(L);
      await (await s.launcher.connect(operator).claimRouter()).wait();
      const plan = await s.launcher.routerPaid(splitter);
      const [, B1, G1] = await s.splitter.pending();
      // fees earned under the splitter, then the 48 h redirect to a new router
      await graduate(L);
      await collect(L.coin);
      const owed = await s.launcher.routerOwed();
      const bonding = await s.launcher.pendingBondingFees();
      const grad = await s.launcher.pendingGradFees();
      expect(grad).to.be.greaterThan(0n);
      await (await s.launcher.connect(deployer).proposeTreasuryRouter(spare.address)).wait();
      await expect(s.launcher.connect(deployer).executeTreasuryRouter()).to.be.revertedWithCustomError(s.launcher, "TimelockActive");
      await time.increase(48n * 3600n);
      await expect(s.launcher.connect(deployer).executeTreasuryRouter()).to.emit(s.launcher, "RouterParked").withArgs(splitter, owed, bonding, grad);
      expect([await s.launcher.routerOwed(), await s.launcher.parkedOwed(), await s.launcher.treasuryRouter()]).to.deep.equal([0n, owed, spare.address]);
      // the plan still routes (routerPaid did not move); the old operator can no longer claim
      const b1 = await s.splitter.bands(B1, G1);
      await (await s.splitter.connect(operator).route(1, plan.amount, b1.rsaMin, 0n, 0n, ethers.ZeroHash)).wait();
      await expect(s.launcher.connect(operator).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      // anyone pays the parked bucket, only to the old splitter; it is the splitter's next run
      await (await s.launcher.connect(outsider).payParkedRouter(splitter)).wait();
      await expect(s.launcher.connect(outsider).payParkedRouter(splitter)).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      expect(await s.launcher.parkedOwed()).to.equal(0n);
      const [t2, B2, G2] = await s.splitter.pending();
      expect([t2, B2, G2]).to.deep.equal([owed, bonding, grad]);
      const b2 = await s.splitter.bands(B2, G2);
      await (await s.splitter.connect(operator).route(2, (await s.launcher.routerPaid(splitter)).amount, b2.rsaMax, 0n, 0n, ethers.ZeroHash)).wait();
      expect(await balanceOf(splitter)).to.equal(0n);
      // later fees: the new router (an EOA, no operator()) claims them; the splitter sees nothing new
      await routerBuy(s, s.signers.trader, L.coin, 5n * WAD);
      await collect(L.coin);
      const later = await s.launcher.routerOwed();
      const sp0 = await balanceOf(spare.address);
      const rc = (await (await s.launcher.connect(spare).claimRouter()).wait())!;
      expect((await balanceOf(spare.address)) - sp0 + rc.gasUsed * rc.gasPrice).to.equal(later);
      expect((await s.splitter.pending())[0]).to.equal(0n);
    });
  });

  // ================================================================================================= F5
  describe("F5: holder-batch claim deadline bounded, approved exactly, re-checked at execution", function () {
    it("0, too early and too late are refused at proposal; the bounds themselves pass; the approval names the deadline; a late execution is refused; a good batch reaches the real distributor and its unclaimed part is recoverable", async function () {
      const { trader, operator, deployer } = s.signers;
      const { holderDistributor } = env.v;
      const L = await openCoin({ feeChoice: 2 });
      await routerBuy(s, trader, L.coin, 30n * WAD);
      await collect(L.coin);
      await (await s.choiceVault.pull(L.coin)).wait();
      const hb = await s.choiceVault.holderBalance(L.coin);
      expect(hb).to.be.greaterThan(10n);
      const delay = await s.choiceVault.holderBatchDelay();
      const root = ethers.id("f5-root");
      const propose = (id: string, deadline: bigint, amount = 1n) =>
        s.choiceVault.connect(operator).proposeHolderBatch(ethers.id(id), root, deadline, [L.coin], [amount], { gasLimit: 1_000_000n });

      let t = BigInt(await time.latest()) + 10n;
      // each deadline relative to the second its proposal is mined at
      const bad: Array<[string, (now: bigint) => bigint]> = [
        ["zero", () => 0n],
        ["early", (now) => now + delay + MIN_CLAIM_WINDOW - 1n],
        ["late", (now) => now + MAX_CLAIM_WINDOW + 1n],
      ];
      for (const [id, deadline] of bad) {
        await time.setNextBlockTimestamp(t);
        await expect(propose(id, deadline(t))).to.be.revertedWithCustomError(s.choiceVault, "BadClaimDeadline");
        t += 1n;
      }
      await time.setNextBlockTimestamp(t);
      await (await propose("lo", t + delay + MIN_CLAIM_WINDOW)).wait();
      t += 1n;
      await time.setNextBlockTimestamp(t);
      await (await propose("hi", t + MAX_CLAIM_WINDOW)).wait();
      const lo = await s.choiceVault.holderBatches(ethers.id("lo"));
      const hi = await s.choiceVault.holderBatches(ethers.id("hi"));
      await vaultLiabilitiesMatch();

      // the admin must approve the exact root, total and deadline
      await expect(s.choiceVault.connect(deployer).approveHolderBatch(ethers.id("lo"), root, 1n, lo.claimDeadline + 1n)).to.be.revertedWithCustomError(s.choiceVault, "BadBatch");
      await expect(s.choiceVault.connect(deployer).approveHolderBatch(ethers.id("lo"), root, 2n, lo.claimDeadline)).to.be.revertedWithCustomError(s.choiceVault, "BadBatch");
      await expect(s.choiceVault.connect(deployer).approveHolderBatch(ethers.id("lo"), ethers.id("other"), 1n, lo.claimDeadline)).to.be.revertedWithCustomError(
        s.choiceVault,
        "BadBatch",
      );
      await (await s.choiceVault.connect(deployer).approveHolderBatch(ethers.id("lo"), root, 1n, lo.claimDeadline)).wait();
      await (await s.choiceVault.connect(deployer).approveHolderBatch(ethers.id("hi"), root, 1n, hi.claimDeadline)).wait();
      // the minimum-window batch can execute only at its first second: one second later it would leave holders < 7 days
      await time.setNextBlockTimestamp(BigInt(lo.executableAt) + 1n);
      await expect(s.choiceVault.connect(operator).executeHolderBatch(ethers.id("lo"), { gasLimit: 1_000_000n })).to.be.revertedWithCustomError(
        s.choiceVault,
        "BadClaimDeadline",
      );
      expect(BigInt(lo.claimDeadline)).to.equal(BigInt(lo.executableAt) + MIN_CLAIM_WINDOW);
      await (await s.choiceVault.connect(deployer).vetoHolderBatch(ethers.id("lo"))).wait();
      await vaultLiabilitiesMatch();

      // the well-formed batch executes into the real RewardDistributor with the approved deadline
      await (await holderDistributor.connect(deployer).authorizeBatch(ethers.id("hi"), 1n, BigInt(hi.executableAt) - 1n, hi.claimDeadline)).wait();
      expect(BigInt(await time.latest())).to.be.at.least(BigInt(hi.executableAt));
      const rc = (await (await s.choiceVault.connect(operator).executeHolderBatch(ethers.id("hi"))).wait())!;
      const created = eventsOf(rc, holderDistributor, "BatchCreated")[0].args;
      expect([created[0], created[1], created[2], created[3]]).to.deep.equal([ethers.id("hi"), root, 1n, hi.claimDeadline]);
      expect((await holderDistributor.batches(ethers.id("hi"))).claimDeadline).to.equal(hi.claimDeadline);
      await vaultLiabilitiesMatch();
      // nothing is locked for good: after the deadline the distributor's owner recovers the unclaimed part
      await time.increaseTo(BigInt(hi.claimDeadline) + 1n);
      await expect(holderDistributor.connect(deployer).recoverUnclaimed(ethers.id("hi"), deployer.address)).to.emit(holderDistributor, "UnclaimedRecovered");
    });
  });

  // ================================================================================================= B11
  describe("B11: a route run never reverts OutOfBand, whatever Barkswap's community fee", function () {
    for (const cf of [0n, LIVE_COMMUNITY_FEE, 1_000n]) {
      it(`community fee ${cf} (${cf === LIVE_COMMUNITY_FEE ? "live" : cf === 0n ? "none" : "100%"}): the band and the league fit the net books; both band edges route`, async function () {
        const { trader, operator, keeper } = s.signers;
        const splitter = await s.splitter.getAddress();
        const L = await openCoin();
        expect(BigInt((await poolState(L.pool)).communityFee)).to.equal(LIVE_COMMUNITY_FEE);
        if (cf !== LIVE_COMMUNITY_FEE) {
          const poolAsAdmin = L.poolContract.connect(await impersonate(BARKSWAP.admin)) as C;
          await (await poolAsAdmin.setCommunityFee(cf)).wait();
        }
        expect(BigInt((await poolState(L.pool)).communityFee)).to.equal(cf);

        // bonding buys and sells, booked net of the cut
        const buy = barkSwapOf(s, await routerBuy(s, trader, L.coin, 20n * WAD));
        expect(buy.communityFee).to.equal(cf);
        expect(buy.netFee).to.equal((buy.grossFee as bigint) - ((buy.grossFee as bigint) * cf) / 1000n);
        await approveRouter(trader, L.coin);
        await routerSell(s, trader, L.coin, (buy.coinAmount as bigint) / 2n);
        if (cf < 1_000n) {
          await collect(L.coin);
          await time.increase(601);
          await (await s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait();
        } else {
          // at 100% the LPs (our positions) earn nothing: there is nothing to collect
          await expect(s.launcher.connect(keeper).collect(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "NothingToCollect");
        }
        // graduation (the 2% burn is not a swap fee: the cut never touches it) and post-graduation volume
        await graduate(L);
        await routerBuy(s, trader, L.coin, 5n * WAD);
        if (cf < 1_000n) await collect(L.coin);

        await (await s.launcher.connect(operator).claimRouter()).wait();
        const paid = await s.launcher.routerPaid(splitter);
        const [total, B, G] = await s.splitter.pending();
        const grad = (await s.launcher.launches(L.coin)).graduationFee;
        expect(G).to.equal(grad);
        if (cf === 1_000n) {
          expect(B).to.equal(0n);
          expect(total).to.equal(grad);
          expect(await s.launcher.creatorOwed(L.coin)).to.equal(0n);
        } else {
          expect(B).to.be.greaterThan(0n);
        }
        const b = await s.splitter.bands(B, G);
        // the audit's B11 derivation on these numbers (0.55 B + 0.2 G <= B + G <= total); the invariant itself is that
        // both band edges route below
        expect(b.weekly + b.monthly + b.rsaMax).to.be.at.most(total);
        const snap = await takeSnapshot();
        const airdrop = b.rsaMax - b.squadMax;
        await (await s.splitter.connect(operator).route(1, paid.amount, 0n, b.squadMax, airdrop, ethers.id(`b11-${cf}-max`))).wait();
        expect(await balanceOf(splitter)).to.equal(0n);
        await snap.restore();
        await (await s.splitter.connect(operator).route(1, paid.amount, b.rsaMin, 0n, 0n, ethers.id(`b11-${cf}-min`))).wait();
        expect(await balanceOf(splitter)).to.equal(0n);
        expect(await env.v.community.squadPoolBalance()).to.equal(0n);
      });
    }
  });
});

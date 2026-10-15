// MwzBarkPlugin on a Chikyu fork, through Barkswap's real pools, SwapRouter and QuoterV2: the rate per phase and the
// launch decay from openAt, no swap before openAt, pool.fee() / getCurrentFee, the per-swap BarkSwap event and the
// per-phase fee totals, router execution = QuoterV2 quote, partial fills, the graduation latch (once, graduatedAt), the
// one-time 2% graduation fee inline and through the guarded fallback (I6: at most once, never inside A, never with a
// foreign plugin), the conversion's 0 fee against the creator first buy's 2%, F2 and the Algebra facts the audit hands
// to t8. Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md §2, §3 (Invariants, per-swap fields);
// audit: docs/dogeos/barkswap-audit.md (Gate 0 "Open items handed to the fork tests", MwzBarkPlugin). Plan task t8.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkPlugin.fork.spec.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import type { FunctionFragment } from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BARKSWAP,
  CREATOR_RESERVE,
  WAD,
  algebraFeeUnits,
  amount1Delta,
  approveRouter,
  barkStackFixture,
  barkSwapOf,
  communityFeesOf,
  eventsOf,
  expectedRateBps,
  impersonate,
  launchCoin,
  poolState,
  positionLiquidity,
  printGasTable,
  quoteBuy,
  quoteSell,
  raiseOfA,
  recordGas,
  routerBuy,
  routerSell,
  type BarkStack,
  type LaunchResult,
} from "./fixtures/barkswap";

const TICK_MAX = 887_270;
const COMMUNITY_FEE = 30n;

/** BarkSwap field checks shared by the trade tests (spec §3 "Per-swap event fields"). */
function expectFeeFields(sw: Record<string, bigint | boolean | string>, cf: bigint = COMMUNITY_FEE) {
  const gross = sw.grossFee as bigint;
  const amountIn = (sw.buy ? sw.nativeAmount : sw.coinAmount) as bigint;
  expect(gross).to.equal((amountIn * (sw.feeUnits as bigint)) / 1_000_000n);
  const net = gross - (gross * cf) / 1000n;
  expect(sw.netFee).to.equal(net);
  const creator = sw.phase === 0n ? (gross * 560n) / 10_000n : (gross * 50n) / 100n;
  expect(sw.creatorAmount).to.equal(creator < net ? creator : net);
  expect(sw.curveAmount).to.equal(sw.buy ? (sw.nativeAmount as bigint) - gross : sw.nativeAmount);
  expect(sw.communityFee).to.equal(cf);
}

describe("Bark plugin on the Chikyu fork (t8)", function () {
  let s: BarkStack;

  beforeEach(async function () {
    s = await loadFixture(barkStackFixture);
  });

  after(function () {
    printGasTable("BarkPlugin.fork.spec.ts");
  });

  /** A launched coin with trading open and the 60 s launch window over. */
  async function openCoin(opts: Parameters<typeof launchCoin>[1] = {}): Promise<LaunchResult> {
    const L = await launchCoin(s, opts);
    await time.increaseTo(L.openAt + 61n);
    return L;
  }

  /** The crossing buy: raiseOfA x 1.3 crosses A into B whatever was bought before. */
  async function graduate(L: LaunchResult, buyer = s.signers.trader) {
    const rc = await routerBuy(s, buyer, L.coin, (raiseOfA(L) * 13n) / 10n);
    return rc;
  }

  describe("rate per phase and launch decay (gen-8 F1, B)", function () {
    it("no trade before openAt; then 90% at openAt falling linearly to 2% at openAt + 60 s, buys and sells", async function () {
      const openAt = BigInt(await time.latest()) + 300n;
      const L = await launchCoin(s, { openAt, firstBuy: 20n * WAD });
      const { trader, creator } = s.signers;
      await approveRouter(creator, L.coin);
      await expect(routerBuy(s, trader, L.coin, WAD)).to.be.revertedWithCustomError(s.plugin, "TradingNotOpen");
      await expect(routerSell(s, creator, L.coin, 10n ** 24n)).to.be.revertedWithCustomError(s.plugin, "TradingNotOpen");

      const samples: Array<[bigint, "buy" | "sell"]> = [
        [0n, "buy"],
        [1n, "sell"],
        [15n, "buy"],
        [30n, "sell"],
        [45n, "buy"],
        [58n, "sell"],
        [59n, "buy"],
        [60n, "sell"],
        [61n, "buy"],
        [600n, "sell"],
      ];
      for (const [k, side] of samples) {
        await time.setNextBlockTimestamp(openAt + k);
        const rc = side === "buy" ? await routerBuy(s, trader, L.coin, WAD) : await routerSell(s, creator, L.coin, 1_000_000n * WAD);
        const ts = BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp);
        expect(ts).to.equal(openAt + k);
        const want = expectedRateBps(openAt, ts);
        const sw = barkSwapOf(s, rc);
        expect(sw.rateBps, `rate at openAt + ${k}`).to.equal(want);
        expect(sw.feeUnits, `fee units at openAt + ${k}`).to.equal(BigInt(algebraFeeUnits(Number(want), side === "buy")));
        expect(sw.phase).to.equal(0n);
        expect(sw.kind).to.equal(0n);
        expectFeeFields(sw);
        const ps = eventsOf(rc, L.poolContract, "Swap")[0].args;
        expect(ps.overrideFee).to.equal(sw.feeUnits); // the pool charged exactly the plugin's fee
        expect(ps.pluginFee).to.equal(0n);
        // Algebra fact: the override fee is never written to lastFee
        expect((await poolState(L.pool)).lastFee).to.equal(0);
      }
      expect(expectedRateBps(openAt, openAt)).to.equal(9000n);
      expect(expectedRateBps(openAt, openAt + 60n)).to.equal(200n);
    });

    it("pool.fee() and getCurrentFee() never revert: the sell fee now, capped at uint16, by the current price", async function () {
      const L = await launchCoin(s, {});
      await time.increaseTo(L.openAt + 10n);
      expect(await L.poolContract.fee()).to.equal(65_535n); // 200 + 8800 x 50/60 bps does not fit the uint16 interface
      await time.increaseTo(L.openAt + 120n);
      expect(await L.poolContract.fee()).to.equal(20_000n);
      expect(await s.plugin.getCurrentFee()).to.equal(0n); // not one of our pools
      await graduate(L);
      expect(await L.poolContract.fee()).to.equal(10_000n);
    });
  });

  describe("per-swap event and fee totals", function () {
    it("emits exactly one BarkSwap per router buy and sell with every spec field", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      const coinBefore = await L.coinContract.balanceOf(trader.address);
      const nativeBefore = await ethers.provider.getBalance(trader.address);
      const rc = await routerBuy(s, trader, L.coin, 3n * WAD);
      const all = eventsOf(rc, s.plugin, "BarkSwap");
      expect(all).to.have.length(1);
      const sw = barkSwapOf(s, rc);
      const ps = eventsOf(rc, L.poolContract, "Swap")[0].args;
      expect(sw.pool).to.equal(L.pool);
      expect(sw.coin).to.equal(L.coin);
      expect(sw.sender).to.equal(BARKSWAP.swapRouter); // the contract that called pool.swap; trader = tx.from
      expect(sw.kind).to.equal(0n);
      expect(sw.buy).to.equal(true);
      expect(sw.phase).to.equal(0n);
      expect(sw.crossing).to.equal(false);
      expect(sw.nativeAmount).to.equal(ps.amount1);
      expect(sw.nativeAmount).to.equal(3n * WAD);
      expect(sw.coinAmount).to.equal(-ps.amount0);
      expect(sw.feeToken).to.equal(BARKSWAP.wdoge);
      expect(sw.rateBps).to.equal(200n);
      expect(sw.feeUnits).to.equal(19_607n);
      expect(sw.sqrtPriceAfter).to.equal(ps.price);
      expect(sw.sqrtPriceAfter).to.equal((await poolState(L.pool)).price);
      expectFeeFields(sw);
      expect((await L.coinContract.balanceOf(trader.address)) - coinBefore).to.equal(sw.coinAmount);
      const gasCost = rc.gasUsed * rc.gasPrice;
      expect(nativeBefore - (await ethers.provider.getBalance(trader.address)) - gasCost).to.equal(sw.nativeAmount);
      // gen-7: the buy costs the curve amount plus r (within the 1e6 fee-unit rounding)
      const r = Number(sw.grossFee) / Number(sw.curveAmount);
      expect(r).to.be.closeTo(0.02, 0.00001);

      await approveRouter(trader, L.coin);
      const sell = await routerSell(s, trader, L.coin, (sw.coinAmount as bigint) / 2n);
      const ss = barkSwapOf(s, sell);
      const sp = eventsOf(sell, L.poolContract, "Swap")[0].args;
      expect(ss.buy).to.equal(false);
      expect(ss.sender).to.equal(BARKSWAP.swapRouter);
      expect(ss.coinAmount).to.equal(sp.amount0);
      expect(ss.coinAmount).to.equal((sw.coinAmount as bigint) / 2n);
      expect(ss.nativeAmount).to.equal(-sp.amount1);
      expect(ss.feeToken).to.equal(L.coin);
      expect(ss.feeUnits).to.equal(20_000n);
      expectFeeFields(ss);
      expect(eventsOf(sell, s.plugin, "BarkSwap")).to.have.length(1);
    });

    it("books per-pool per-phase totals: the creator amount on the gross fee, the router the net remainder (B10)", async function () {
      const L = await openCoin({ firstBuy: 2n * WAD });
      const { trader } = s.signers;
      await approveRouter(trader, L.coin);
      const swaps = [barkSwapOf(s, L.receipt)];
      swaps.push(barkSwapOf(s, await routerBuy(s, trader, L.coin, 4n * WAD)));
      swaps.push(barkSwapOf(s, await routerSell(s, trader, L.coin, 50_000_000n * WAD)));
      swaps.push(barkSwapOf(s, await graduate(L)));
      swaps.push(barkSwapOf(s, await routerBuy(s, trader, L.coin, 2n * WAD)));
      swaps.push(barkSwapOf(s, await routerSell(s, trader, L.coin, 1_000_000n * WAD)));
      const want = {
        bondingNative: { creator: 0n, router: 0n },
        bondingCoin: { creator: 0n, router: 0n },
        postNative: { creator: 0n, router: 0n },
        postCoin: { creator: 0n, router: 0n },
      };
      for (const sw of swaps) {
        const book = sw.phase === 0n ? (sw.buy ? want.bondingNative : want.bondingCoin) : sw.buy ? want.postNative : want.postCoin;
        book.creator += sw.creatorAmount as bigint;
        book.router += (sw.netFee as bigint) - (sw.creatorAmount as bigint);
      }
      expect(swaps.filter((x) => x.phase === 1n)).to.have.length(2);
      const t = await s.plugin.feeTotals(L.pool);
      for (const k of ["bondingNative", "bondingCoin", "postNative", "postCoin"] as const) {
        expect(t[k].creator, `${k}.creator`).to.equal(want[k].creator);
        expect(t[k].router, `${k}.router`).to.equal(want[k].router);
      }
      // post-graduation: the creator gets exactly 50% of the gross fee (0.50% of volume on buys)
      const post = swaps[4];
      expect(post.rateBps).to.equal(100n);
      expect(post.feeUnits).to.equal(BigInt(algebraFeeUnits(100, true)));
      expect(post.creatorAmount).to.equal((post.grossFee as bigint) / 2n);
    });
  });

  describe("Barkswap SwapRouter and QuoterV2 (deployer = launcher)", function () {
    it("exactInputSingle executes exactly what QuoterV2 quotes, buy and sell", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      const qb = await quoteBuy(s, L.coin, 7n * WAD);
      const rb = await routerBuy(s, trader, L.coin, 7n * WAD);
      recordGas("router buy (exactInputSingle, bonding)", rb.gasUsed);
      const sb = barkSwapOf(s, rb);
      expect(qb.amountOut).to.equal(sb.coinAmount);
      expect(qb.amountIn).to.equal(7n * WAD);
      expect(qb.sqrtPriceX96After).to.equal(sb.sqrtPriceAfter);

      await approveRouter(trader, L.coin);
      const coins = (sb.coinAmount as bigint) / 3n;
      const qs = await quoteSell(s, L.coin, coins);
      const nativeBefore = await ethers.provider.getBalance(trader.address);
      const rs = await routerSell(s, trader, L.coin, coins);
      recordGas("router sell (multicall exactInputSingle + unwrapWNativeToken)", rs.gasUsed);
      const ss = barkSwapOf(s, rs);
      expect(qs.amountOut).to.equal(ss.nativeAmount);
      expect(qs.sqrtPriceX96After).to.equal(ss.sqrtPriceAfter);
      // the WDOGE unwrap path pays the seller native DOGE
      expect((await ethers.provider.getBalance(trader.address)) - nativeBefore + rs.gasUsed * rs.gasPrice).to.equal(ss.nativeAmount);
    });

    it("a buy stopped at a price limit pays the fee on the filled part only, the rest is refunded (A1)", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      const before = await poolState(L.pool);
      const limit = before.price + before.price / 5_000n;
      const community0 = await communityFeesOf(L.pool, BARKSWAP.wdoge);
      const nativeBefore = await ethers.provider.getBalance(trader.address);
      const rc = await routerBuy(s, trader, L.coin, 50n * WAD, { limit });
      const sw = barkSwapOf(s, rc);
      const ps = eventsOf(rc, L.poolContract, "Swap")[0].args;
      expect(ps.price).to.equal(limit);
      expect(sw.nativeAmount).to.equal(ps.amount1);
      expect(sw.nativeAmount).to.be.lessThan(50n * WAD);
      expect(nativeBefore - (await ethers.provider.getBalance(trader.address)) - rc.gasUsed * rc.gasPrice).to.equal(sw.nativeAmount);
      expectFeeFields(sw);
      // Barkswap's cut is 3% of the fee the pool charged on the filled amount (pool fee >= plugin estimate by rounding)
      const community = (await communityFeesOf(L.pool, BARKSWAP.wdoge)) - community0;
      const low = ((sw.grossFee as bigint) * COMMUNITY_FEE) / 1000n;
      expect(community).to.be.at.least(low).and.at.most(low + 1n);
    });
  });

  describe("graduation: latch, graduatedAt and the one-time 2% fee (I6, I7, I17, A12)", function () {
    it("the crossing swap pays the bonding rate, latches once with graduatedAt and takes the 2% fee inline", async function () {
      const L = await openCoin();
      const launcher = await s.launcher.getAddress();
      const native0 = await ethers.provider.getBalance(launcher);
      const rc = await graduate(L);
      recordGas("crossing buy (latch + inline graduation fee)", rc.gasUsed);
      const ts = BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp);
      const sw = barkSwapOf(s, rc);
      expect(sw.crossing).to.equal(true);
      expect(sw.phase).to.equal(0n); // A12: the crossing swap is a bonding swap on its whole amount
      expect(sw.rateBps).to.equal(200n);
      expect(sw.sqrtPriceAfter).to.be.at.least(L.sqrtGrad);
      const grad = eventsOf(rc, s.plugin, "Graduated");
      expect(grad).to.have.length(1);
      expect(grad[0].args.pool).to.equal(L.pool);
      expect(grad[0].args.coin).to.equal(L.coin);
      expect(grad[0].args.graduatedAt).to.equal(ts);
      const p = await s.plugin.pools(L.pool);
      expect(p.graduated).to.equal(true);
      expect(p.graduatedAt).to.equal(ts);
      expect(p.gradBurnDone).to.equal(true);
      // inline fee: the pool is unlocked in afterSwap (Algebra fact), so the launcher's burn runs inside the trade
      const inline = eventsOf(rc, s.plugin, "GraduationFeeInline");
      expect(inline.map((e) => e.args.ok)).to.deep.equal([true]);
      const taken = eventsOf(rc, s.launcher, "GraduationFeeTaken");
      expect(taken).to.have.length(1);
      const liq = (L.liqA * 200n) / 10_000n;
      const amount = amount1Delta(L.sqrtStart, L.sqrtGrad, liq, false);
      expect(taken[0].args.liquidity).to.equal(liq);
      expect(taken[0].args.amount).to.equal(amount);
      expect(taken[0].args.inlineCall).to.equal(true);
      // "2% of A's native": the WDOGE A holds at the graduation price
      const aNative = amount1Delta(L.sqrtStart, L.sqrtGrad, L.liqA, false);
      expect(Number(amount) / Number(aNative)).to.be.closeTo(0.02, 1e-9);
      // I6: A lost exactly floor(liqA x 2%), B nothing
      expect(await positionLiquidity(L.pool, launcher, L.tickStart, L.tickGrad)).to.equal(L.liqA - liq);
      expect(await positionLiquidity(L.pool, launcher, L.tickGrad, TICK_MAX)).to.equal(L.liqB);
      // the WDOGE unwrap path: native lands in the launcher's receive() and in the graduation book
      expect((await ethers.provider.getBalance(launcher)) - native0).to.equal(amount);
      expect(await s.barkswap.wdoge.balanceOf(launcher)).to.equal(0n);
      expect(await s.launcher.routerOwed()).to.equal(amount);
      expect(await s.launcher.pendingGradFees()).to.equal(amount);
      const rec = await s.launcher.launches(L.coin);
      expect(rec.gradFeeTaken).to.equal(true);
      expect(rec.graduationFee).to.equal(amount);
      await expect(s.launcher.connect(s.signers.keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(
        s.launcher,
        "GraduationFeeAlreadyTaken",
      );
      // native reaches the launcher only from WDOGE
      await expect(s.signers.outsider.sendTransaction({ to: launcher, value: 1n })).to.be.revertedWithCustomError(s.launcher, "NotWNative");
    });

    it("never latches twice; the rate follows the price at swap start (F1); after graduation 1% with the creator at 50%", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      await graduate(L);
      const at = (await s.plugin.pools(L.pool)).graduatedAt;
      await time.increase(30);
      const post = barkSwapOf(s, await routerBuy(s, trader, L.coin, 3n * WAD));
      expect([post.phase, post.rateBps, post.crossing]).to.deep.equal([1n, 100n, false]);
      expect(post.creatorAmount).to.equal((post.grossFee as bigint) / 2n);
      // a sell that starts above graduation pays the post rate even if it ends inside A
      await approveRouter(trader, L.coin);
      const down = await routerSell(s, trader, L.coin, 300_000_000n * WAD);
      const sd = barkSwapOf(s, down);
      expect(sd.sqrtPriceAfter).to.be.lessThan(L.sqrtGrad);
      expect([sd.phase, sd.rateBps, sd.feeUnits]).to.deep.equal([1n, 100n, 10_000n]);
      // back up across the graduation price: bonding rate by the start price, no second latch, no second fee
      const up = await routerBuy(s, trader, L.coin, raiseOfA(L));
      const su = barkSwapOf(s, up);
      expect(su.sqrtPriceAfter).to.be.at.least(L.sqrtGrad);
      expect([su.phase, su.rateBps, su.crossing]).to.deep.equal([0n, 200n, false]);
      expect(eventsOf(up, s.plugin, "Graduated")).to.have.length(0);
      expect(eventsOf(up, s.plugin, "GraduationFeeInline")).to.have.length(0);
      expect(eventsOf(up, s.launcher, "GraduationFeeTaken")).to.have.length(0);
      expect((await s.plugin.pools(L.pool)).graduatedAt).to.equal(at);
    });

    it("Algebra fact: a buy limited at sqrtGrad - 1 stays below (tick tickGrad - 1); limited at sqrtGrad it ends exactly there and latches", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      const below = await routerBuy(s, trader, L.coin, raiseOfA(L) * 2n, { limit: L.sqrtGrad - 1n });
      let g = await poolState(L.pool);
      expect(g.price).to.equal(L.sqrtGrad - 1n);
      expect(g.tick).to.equal(L.tickGrad - 1);
      expect(barkSwapOf(s, below).crossing).to.equal(false);
      expect((await s.plugin.pools(L.pool)).graduated).to.equal(false);
      // the remaining step to sqrtGrad: Algebra's price at tickGrad is v4's sqrtGrad (it crosses the tick there)
      const at = await routerBuy(s, trader, L.coin, WAD, { limit: L.sqrtGrad });
      g = await poolState(L.pool);
      expect(g.price).to.equal(L.sqrtGrad);
      expect(g.tick).to.equal(L.tickGrad);
      const sw = barkSwapOf(s, at);
      expect(sw.crossing).to.equal(true);
      expect(eventsOf(at, s.plugin, "GraduationFeeInline").map((e) => e.args.ok)).to.deep.equal([true]);
      // at exactly sqrtGrad, A is WDOGE only: the burn returned no coin (GraduationBurnNotNative did not fire)
      const taken = eventsOf(at, s.launcher, "GraduationFeeTaken")[0].args;
      expect(taken.amount).to.equal(amount1Delta(L.sqrtStart, L.sqrtGrad, (L.liqA * 200n) / 10_000n, false));
    });

    it("an escrow buy that crosses graduation is labelled escrow and takes the fee inline", async function () {
      const L = await openCoin();
      const { creator } = s.signers;
      const value = (raiseOfA(L) * 13n) / 10n;
      const rc = await (await s.escrow.connect(creator).buy(L.coin, 0n, { value, gasLimit: 3_000_000n })).wait();
      recordGas("escrow buy crossing graduation (inline fee)", rc!.gasUsed);
      const sw = barkSwapOf(s, rc!);
      expect(sw.kind).to.equal(2n);
      expect(sw.sender).to.equal(await s.escrow.getAddress());
      expect(sw.crossing).to.equal(true);
      expect(sw.rateBps).to.equal(200n);
      expectFeeFields(sw);
      expect(eventsOf(rc!, s.plugin, "GraduationFeeInline").map((e) => e.args.ok)).to.deep.equal([true]);
      expect(eventsOf(rc!, s.launcher, "GraduationFeeTaken")[0].args.inlineCall).to.equal(true);
      expect(await s.escrow.escrowedTotal(L.coin, creator.address)).to.equal(sw.coinAmount);
    });

    it("fallback: deferred while the launcher's lock is held; never inside A, never under a foreign plugin, at most once", async function () {
      const L = await openCoin();
      const { trader, keeper } = s.signers;
      const launcher = await s.launcher.getAddress();
      const asLauncher = L.poolContract.connect(await ethers.getImpersonatedSigner(launcher)) as typeof L.poolContract;
      const burnLiq = (L.liqA * 200n) / 10_000n;
      // sells leave coin fees for a conversion
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 30n * WAD));
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, (b.coinAmount as bigint) / 2n);
      await (await s.launcher.connect(keeper).collect(L.coin, { gasLimit: 3_000_000n })).wait();
      // plugin defense in depth: no launcher burn before the latch, none outside A
      await expect(asLauncher.burn.staticCall(L.tickStart, L.tickGrad, burnLiq, "0x")).to.be.revertedWithCustomError(s.plugin, "GraduationBurnRefused");
      await expect(asLauncher.burn.staticCall(L.tickGrad, TICK_MAX, 1n, "0x")).to.be.revertedWithCustomError(s.plugin, "BadPositionRange");
      await expect(s.launcher.connect(keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(s.launcher, "NotGraduated");

      // an admin outage of the after-swap hook: the price passes graduation without a latch
      const admin = await impersonate(BARKSWAP.admin);
      const poolAsAdmin = L.poolContract.connect(admin) as typeof L.poolContract;
      await (await poolAsAdmin.setPluginConfig(133)).wait();
      await routerBuy(s, trader, L.coin, (raiseOfA(L) * 3n) / 2n);
      expect((await poolState(L.pool)).price).to.be.greaterThan(L.sqrtGrad);
      expect((await s.plugin.pools(L.pool)).graduated).to.equal(false);
      await expect(s.launcher.connect(keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(s.launcher, "NotGraduated");
      await expect(asLauncher.burn.staticCall(L.tickStart, L.tickGrad, burnLiq, "0x")).to.be.revertedWithCustomError(s.plugin, "GraduationBurnRefused");
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();

      // the latching swap is the launcher's own conversion: the inline call hits the launcher's lock and is deferred
      await time.increase(600);
      const conv = await (await s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait();
      recordGas("convert (latching, inline fee deferred)", conv!.gasUsed);
      const cs = barkSwapOf(s, conv!);
      expect([cs.kind, cs.crossing, cs.phase, cs.feeUnits, cs.rateBps]).to.deep.equal([1n, true, 1n, 0n, 0n]);
      expect(eventsOf(conv!, s.plugin, "Graduated")).to.have.length(1);
      expect(eventsOf(conv!, s.plugin, "GraduationFeeInline").map((e) => e.args.ok)).to.deep.equal([false]);
      expect(eventsOf(conv!, s.launcher, "GraduationFeeTaken")).to.have.length(0);
      expect((await s.launcher.launches(L.coin)).gradFeeTaken).to.equal(false);

      // never inside A: the price falls back below graduation, the fallback and the burn are refused
      await routerSell(s, trader, L.coin, 300_000_000n * WAD);
      expect((await poolState(L.pool)).price).to.be.lessThan(L.sqrtGrad);
      await expect(s.launcher.connect(keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(s.launcher, "PriceBelowGraduation");
      await expect(asLauncher.burn.staticCall(L.tickStart, L.tickGrad, burnLiq, "0x")).to.be.revertedWithCustomError(s.plugin, "GraduationBurnRefused");
      // back above graduation: no second latch, still no fee
      const up = await routerBuy(s, trader, L.coin, raiseOfA(L));
      expect(eventsOf(up, s.plugin, "Graduated")).to.have.length(0);
      expect((await poolState(L.pool)).price).to.be.at.least(L.sqrtGrad);

      // a foreign plugin could tax the burn: refused until restore
      await (await poolAsAdmin.setPlugin(s.signers.outsider.address)).wait();
      await expect(s.launcher.connect(keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(s.launcher, "ForeignPlugin");
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();

      const native0 = await ethers.provider.getBalance(launcher);
      const owed0 = await s.launcher.routerOwed();
      const rc = await (await s.launcher.connect(keeper).takeGraduationFee(L.pool, { gasLimit: 1_000_000n })).wait();
      recordGas("takeGraduationFee (fallback)", rc!.gasUsed);
      const taken = eventsOf(rc!, s.launcher, "GraduationFeeTaken")[0].args;
      const amount = amount1Delta(L.sqrtStart, L.sqrtGrad, burnLiq, false);
      expect([taken.amount, taken.liquidity, taken.inlineCall]).to.deep.equal([amount, burnLiq, false]);
      expect((await ethers.provider.getBalance(launcher)) - native0).to.equal(amount);
      expect((await s.launcher.routerOwed()) - owed0).to.equal(amount);
      expect(await positionLiquidity(L.pool, launcher, L.tickStart, L.tickGrad)).to.equal(L.liqA - burnLiq);
      expect(await positionLiquidity(L.pool, launcher, L.tickGrad, TICK_MAX)).to.equal(L.liqB);
      expect((await s.plugin.pools(L.pool)).gradBurnDone).to.equal(true);
      // at most once, on both sides
      await expect(s.launcher.connect(keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(s.launcher, "GraduationFeeAlreadyTaken");
      await expect(asLauncher.burn.staticCall(L.tickStart, L.tickGrad, burnLiq, "0x")).to.be.revertedWithCustomError(s.plugin, "GraduationBurnRefused");
    });
  });

  describe("conversion 0 fee vs creator first buy 2%", function () {
    it("the launcher's conversion sell pays 0 fee (kind conversion); its creator first buy pays the 2% bonding rate", async function () {
      const L = await launchCoin(s, { firstBuy: 3n * WAD });
      const first = barkSwapOf(s, L.receipt);
      expect([first.kind, first.rateBps, first.feeUnits]).to.deep.equal([0n, 200n, 19_607n]);
      expect(first.sender).to.equal(await s.launcher.getAddress());
      expect(first.grossFee).to.be.greaterThan(0n);
      const { trader, keeper } = s.signers;
      // no conversion inside the launch window
      await expect(s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(
        s.launcher,
        "ConversionInLaunchWindow",
      );
      await time.increaseTo(L.openAt + 61n);
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 5n * WAD));
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, (b.coinAmount as bigint) / 2n);
      const col = await (await s.launcher.connect(keeper).collect(L.coin, { gasLimit: 3_000_000n })).wait();
      recordGas("collect (A + B, WDOGE and coin)", col!.gasUsed);
      const totals0 = await s.plugin.feeTotals(L.pool);
      const community0 = await communityFeesOf(L.pool, L.coin);
      const rc = await (await s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait();
      recordGas("convert (bonding, no latch)", rc!.gasUsed);
      const cs = barkSwapOf(s, rc!);
      expect(cs.kind).to.equal(1n);
      expect(cs.sender).to.equal(await s.launcher.getAddress());
      expect([cs.buy, cs.phase, cs.rateBps, cs.feeUnits, cs.grossFee, cs.netFee, cs.creatorAmount]).to.deep.equal([false, 0n, 0n, 0n, 0n, 0n, 0n]);
      const ps = eventsOf(rc!, L.poolContract, "Swap")[0].args;
      expect([ps.overrideFee, ps.pluginFee]).to.deep.equal([0n, 0n]);
      // a true 0 fee: lastFee 0, Barkswap's cut of the conversion is 0, no books move
      expect((await poolState(L.pool)).lastFee).to.equal(0);
      expect(await communityFeesOf(L.pool, L.coin)).to.equal(community0);
      const totals1 = await s.plugin.feeTotals(L.pool);
      expect(totals1.bondingCoin.creator).to.equal(totals0.bondingCoin.creator);
      expect(totals1.bondingCoin.router).to.equal(totals0.bondingCoin.router);
      const conv = eventsOf(rc!, s.launcher, "CoinFeesConverted")[0].args;
      expect(conv.coinsIn).to.equal(cs.coinAmount);
      expect(conv.nativeOut).to.equal(cs.nativeAmount);
      // the conversion flag lives only inside convert
      expect(await s.launcher.conversionInProgress(L.pool)).to.equal(false);
    });
  });

  describe("F2: no sell below the start price", function () {
    it("reverts a dump below the start price; a sell limited at the start price ends exactly there and is accepted", async function () {
      const L = await openCoin();
      const { trader, outsider } = s.signers;
      await routerBuy(s, trader, L.coin, WAD / 2n);
      // outside coins (e.g. the released 2% reserve): the reserve lock's balance moved to a seller
      const lock = await impersonate(await s.reserveLock.getAddress());
      await (await (L.coinContract.connect(lock) as typeof L.coinContract).transfer(outsider.address, CREATOR_RESERVE)).wait();
      await approveRouter(outsider, L.coin);
      await expect(routerSell(s, outsider, L.coin, CREATOR_RESERVE)).to.be.revertedWithCustomError(s.plugin, "PriceBelowStart");
      // Algebra fact: a sell limited at sqrtStart stops exactly there (tick tickStart - 1, no liquidity) and F2 passes
      const rc = await routerSell(s, outsider, L.coin, CREATOR_RESERVE, { limit: L.sqrtStart });
      const sw = barkSwapOf(s, rc);
      const g = await poolState(L.pool);
      expect(g.price).to.equal(L.sqrtStart);
      expect(g.tick).to.equal(L.tickStart - 1);
      expect(await L.poolContract.liquidity()).to.equal(0n);
      expect(sw.sqrtPriceAfter).to.equal(L.sqrtStart);
      expect(sw.coinAmount).to.be.lessThan(CREATOR_RESERVE);
      expect(await L.coinContract.balanceOf(outsider.address)).to.equal(CREATOR_RESERVE - (sw.coinAmount as bigint));
      // the next buy re-crosses tickStart and trades on A again
      const again = barkSwapOf(s, await routerBuy(s, trader, L.coin, WAD));
      expect(again.coinAmount).to.be.greaterThan(0n);
      expect(await L.poolContract.liquidity()).to.equal(L.liqA);
    });
  });

  describe("fixed rates and no money in the plugin (I12)", function () {
    it("has fixed rate constants, no setter and no transfer path; it never holds tokens or native", async function () {
      expect(await s.plugin.BONDING_FEE_BPS()).to.equal(200n);
      expect(await s.plugin.POST_FEE_BPS()).to.equal(100n);
      expect(await s.plugin.CREATOR_POST_BPS()).to.equal(50n);
      expect(await s.plugin.SNIPER_START_BPS()).to.equal(9000n);
      expect(await s.plugin.CREATOR_BONDING_BPS()).to.equal(560n);
      expect(await s.plugin.PLUGIN_CONFIG()).to.equal(135n);
      const mutating = s.plugin.interface.fragments
        .filter((f) => f.type === "function" && !["view", "pure"].includes((f as FunctionFragment).stateMutability))
        .map((f) => (f as FunctionFragment).name)
        .sort();
      expect(mutating).to.deep.equal(["afterSwap", "beforeModifyPosition", "beforeSwap", "handlePluginFee", "registerPool"]);

      const L = await openCoin({ firstBuy: WAD });
      await graduate(L);
      await approveRouter(s.signers.trader, L.coin);
      await routerSell(s, s.signers.trader, L.coin, 10_000_000n * WAD);
      const plugin = await s.plugin.getAddress();
      expect(await L.coinContract.balanceOf(plugin)).to.equal(0n);
      expect(await s.barkswap.wdoge.balanceOf(plugin)).to.equal(0n);
      expect(await ethers.provider.getBalance(plugin)).to.equal(0n);
      const [p0, p1] = await L.poolContract.getPluginFeePending();
      expect([p0, p1]).to.deep.equal([0n, 0n]);
    });
  });
});

// Fix round 2026-10-12 (founder go after the AI audit, docs/build_plans/GEN8_AI_AUDIT_FINDINGS.md):
//   F1 fee phase by the price at the start of each swap; reserve release needs the price at/past graduation now
//   F2 no sell may leave the price above the start price
//   F3 router change parks the old router's bucket (no try/catch, no external call)      [hook.spec covers the PoC]
//   F4 claimRouter only by the router, its operator or the owner                          [hook.spec covers access]
//   F5 holder-batch claim deadline bounded and approved by the Safe
//   F6 oracle band BNB $10..$100K, ETH $50..$500K (deploy inputs; launcher accepts any band at construction)
//   B  scheduled trading open (openAt), signed, enforced by the hook, decay from openAt
// Each audit proof of concept that applies to the contracts is replayed here and must now fail to exploit.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployGen8, launch, trade, mineAt, now, setNextTs, graduate, ledgers, slot0, liquidity, nativeTargetA, revertOf, req, reqTuple, signCreate, claimRouter,
  Env, Pool, FAST_TARGET,
} from "./fixtures/gen8";
import { BPS, WAD, RESERVE, MAX_SQRT_PRICE, rateAt } from "./fixtures/v4math";

const fmt = (w: bigint) => ethers.formatEther(w);

async function coinAfterWindow() {
  const env = await deployGen8();
  const { P } = await launch(env, env.creator, { firstBuyValue: WAD / 2n });
  await mineAt(P.launchTs + 61n);
  return { env, P };
}

async function freshCoin() {
  const env = await deployGen8();
  const { P } = await launch(env, env.creator, { firstBuyValue: 0n });
  await mineAt(P.launchTs + 61n);
  return { env, P };
}

function hookEvents(env: Env, rc: any) {
  const hookAddr = env.hook.target.toString().toLowerCase();
  return rc.logs.filter((l: any) => l.address.toLowerCase() === hookAddr).map((l: any) => env.hook.interface.parseLog(l));
}

/** Exact-input buy that stops exactly at the graduation price (partial fill at the limit). */
async function buyToGrad(env: Env, P: Pool, wallet = env.bot) {
  return trade(env, P, { wallet, buy: true, exactIn: true, amount: nativeTargetA(P) * 2n, sqrtLimit: P.sqrtGrad });
}

describe("gen8 fix round 2026-10-12", function () {
  // ------------------------------------------------------------------------------------------------ F1
  describe("F1: fee phase by the start price; reserve release by the current price", () => {
    it("the crossing swap pays the bonding rate; a swap starting exactly at the graduation price pays the post rate", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      const c = await buyToGrad(env, P);
      expect(c.graduated).to.not.eq(null);
      expect([c.rate, c.graduatedFlag]).to.deep.eq([200n, false]);
      expect((await slot0(env, P)).sqrtP).to.eq(P.sqrtGrad);
      expect(await env.lens.currentFeeBps(P.id, env.bot.address)).to.eq(100n);
      const pb = await env.hook.pendingBondingFees();
      const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      expect([t.rate, t.graduatedFlag]).to.deep.eq([100n, true]);
      expect(t.creatorShare).to.eq((t.curve! * 50n) / BPS);
      expect(await env.hook.pendingBondingFees()).to.eq(pb); // post fees never enter the bonding bucket
    });

    it("after graduation, swaps that start back inside A pay the bonding rate and split (all four types), in the bonding bucket", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      await graduate(env, P, env.bot);
      // sell back into A
      const back = await trade(env, P, { wallet: env.bot, buy: false, exactIn: true, amount: 50_000_000n * WAD });
      expect([back.rate, back.graduatedFlag]).to.deep.eq([100n, true]); // started past graduation: post
      expect((await slot0(env, P)).sqrtP > P.sqrtGrad).to.eq(true);
      expect(await env.lens.currentFeeBps(P.id, env.bot.address)).to.eq(200n);
      const prog = await env.lens.progress(P.id);
      expect([prog.graduated, prog.postPhase]).to.deep.eq([true, false]);
      for (const [buy, exactIn, amount] of [[true, true, WAD / 10n], [true, false, 100_000n * WAD], [false, true, 100_000n * WAD], [false, false, WAD / 100n]] as [boolean, boolean, bigint][]) {
        const pb = await env.hook.pendingBondingFees();
        const t = await trade(env, P, { wallet: env.bot, buy, exactIn, amount, limit: buy ? 10n * WAD : 10n ** 30n });
        expect([t.rate, t.graduatedFlag], `${buy} ${exactIn}`).to.deep.eq([200n, false]);
        expect(t.creatorShare).to.eq((t.fee! * 560n) / BPS);
        expect((await env.hook.pendingBondingFees()) - pb).to.eq(t.fee);
        expect(t.graduated).to.eq(null); // graduation is one-time
      }
      const l = await ledgers(env, [P.id]);
      expect(l.claims).to.eq(l.sum);
    });

    it("A-1 / D-H1 one transaction: forced graduation no longer changes the fee for trades back in A and cannot release the reserve", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      const R = nativeTargetA(P);
      const G = await (await ethers.getContractFactory("ForceGraduator")).deploy(await env.pm.getAddress());
      const lock = await env.reserveLock.getAddress();
      const rc = await (await G.connect(env.attacker).run(P.key, R * 2n, P.sqrtGrad, P.sqrtStart, lock, P.id, { value: R / 10n, gasLimit: 6_000_000n })).wait();
      const ev = hookEvents(env, rc);
      const fees = ev.filter((e: any) => e.name === "HookFee");
      expect(fees.map((e: any) => [e.args.buy, e.args.graduated, e.args.feeBps])).to.deep.eq([[true, false, 200n], [false, true, 100n]]);
      expect(ev.some((e: any) => e.name === "Graduated")).to.eq(true);
      expect((await env.hook.pools(P.id)).graduated).to.eq(true); // the one-time latch still fires (founder design)
      // the release attempt inside the attacker's unlock was refused (price was at graduation, but mid-unlock)
      expect(await G.lastReleaseOk()).to.eq(false);
      expect((await G.lastReleaseError()).slice(0, 10)).to.eq(env.reserveLock.interface.getError("PoolManagerUnlocked")!.selector);
      // price back in A: everyone pays 2% again, bonding bucket and creator split as before graduation
      const s = await slot0(env, P);
      expect(s.sqrtP > P.sqrtGrad).to.eq(true);
      expect(await env.lens.currentFeeBps(P.id, env.buyer.address)).to.eq(200n);
      const t = await trade(env, P, { wallet: env.buyer, buy: true, exactIn: true, amount: WAD / 2n });
      expect([t.rate, t.graduatedFlag]).to.deep.eq([200n, false]);
      // and the reserve stays locked
      await expect(env.reserveLock.connect(env.attacker).release(P.id)).to.be.revertedWithCustomError(env.reserveLock, "PriceBelowGraduation");
      expect((await env.reserveLock.reserves(P.id)).amount).to.eq(RESERVE);
      const net = await G.lastNetCost();
      const gradFee = ev.find((e: any) => e.name === "Graduated").args.gradFeeNative;
      console.log(`      forced graduation now costs ${fmt(net)} native (${(Number((net * 1_000_000n) / R) / 10_000).toFixed(3)}% of A's raise ${fmt(R)}), of which graduation fee ${fmt(gradFee)}; gains: none on fees, reserve stays locked`);
      const l = await ledgers(env, [P.id]);
      expect(l.claims).to.eq(l.sum);
    });

    it("D-H1 as audit D wrote it (sell-back with no price limit): the whole round trip now reverts PriceAboveStart (F2)", async () => {
      const { env, P } = await loadFixture(freshCoin);
      const R = nativeTargetA(P);
      const G = await (await ethers.getContractFactory("ForceGraduator")).deploy(await env.pm.getAddress());
      const why = await revertOf(() => G.connect(env.attacker).run(P.key, R * 2n, P.sqrtGrad, MAX_SQRT_PRICE - 1n, ethers.ZeroAddress, P.id, { value: R / 5n, gasLimit: 8_000_000n }).then((t: any) => t.wait()), env, [G.interface]);
      expect(why).to.match(/PriceAboveStart/);
      expect((await env.hook.pools(P.id)).graduated).to.eq(false);
    });

    it("A-1 / D-H1 two transactions in one block (bundle): same result; a third transaction in between can release the reserve (residual, measured)", async () => {
      const { env, P } = await loadFixture(freshCoin);
      await (await P.coin.connect(env.attacker).approve(await env.trader.getAddress(), ethers.MaxUint256)).wait();
      const big = nativeTargetA(P) * 2n;
      const coinsA = (P.mintedA * 9990n) / 10_000n;
      const nB = await ethers.provider.getBalance(env.attacker.address);
      await network.provider.send("evm_setAutomine", [false]);
      const t1 = await env.trader.connect(env.attacker).swap(P.key, true, -big, P.sqrtGrad, "0x", { value: big, gasLimit: 3_000_000n });
      const t2 = await env.reserveLock.connect(env.attacker).release(P.id, { gasLimit: 500_000n });
      const t3 = await env.trader.connect(env.attacker).swap(P.key, false, -coinsA, P.sqrtStart, "0x", { gasLimit: 3_000_000n });
      await network.provider.send("evm_mine", []);
      await network.provider.send("evm_setAutomine", [true]);
      const [r1, r2, r3] = await Promise.all([t1, t2, t3].map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      expect([r1!.status, r2!.status, r3!.status]).to.deep.eq([1, 1, 1]);
      expect(r1!.blockNumber).to.eq(r3!.blockNumber);
      expect((await env.hook.pools(P.id)).graduated).to.eq(true);
      expect((await slot0(env, P)).sqrtP > P.sqrtGrad).to.eq(true);
      // fees are back to 2% for everyone
      expect(await env.lens.currentFeeBps(P.id, env.buyer.address)).to.eq(200n);
      // residual: the reserve WAS released by the middle transaction (price at graduation, PoolManager locked)
      expect((await env.reserveLock.reserves(P.id)).amount).to.eq(0n);
      const gas = [r1!, r2!, r3!].reduce((a, r) => a + r.gasUsed * r.gasPrice, 0n);
      const cost = nB - (await ethers.provider.getBalance(env.attacker.address)) - gas;
      console.log(`      residual bundle (buy to graduation, release, sell back): net cost ${fmt(cost)} native, needs ${fmt(nativeTargetA(P))} native for one block; releases the creator's 20M reserve early; no fee change`);
    });

    it("release: latch alone is not enough; at/past the graduation price outside an unlock it works", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      await expect(env.reserveLock.release(P.id)).to.be.revertedWithCustomError(env.reserveLock, "NotGraduated");
      await graduate(env, P, env.bot);
      await trade(env, P, { wallet: env.bot, buy: false, exactIn: true, amount: 30_000_000n * WAD });
      await expect(env.reserveLock.release(P.id)).to.be.revertedWithCustomError(env.reserveLock, "PriceBelowGraduation");
      await buyToGrad(env, P);
      expect((await slot0(env, P)).sqrtP).to.eq(P.sqrtGrad); // exactly at the graduation price counts
      const b = await P.coin.balanceOf(env.creator.address);
      await expect(env.reserveLock.connect(env.attacker).release(P.id)).to.emit(env.reserveLock, "ReserveReleased");
      expect((await P.coin.balanceOf(env.creator.address)) - b).to.eq(RESERVE);
    });
  });

  // ------------------------------------------------------------------------------------------------ F2
  describe("F2: no sell may leave the price above the start price", () => {
    it("A-3: a zero-coin seller can no longer push the price to MAX; the next buyer's gas is normal", async () => {
      const { env, P } = await loadFixture(freshCoin);
      expect(await liquidity(env, P)).to.eq(0n);
      await (await P.coin.connect(env.attacker).approve(await env.trader.getAddress(), ethers.MaxUint256)).wait();
      const why = await revertOf(() => env.trader.connect(env.attacker).swap(P.key, false, -1n, 0n, "0x", { gasLimit: 15_000_000n }).then((t: any) => t.wait()), env);
      expect(why).to.match(/PriceAboveStart/);
      expect((await slot0(env, P)).sqrtP).to.eq(P.sqrtStart);
      // a limit at the start price while the price sits there is refused by the PoolManager itself (nothing to fill)
      const why2 = await revertOf(() => env.trader.connect(env.attacker).swap(P.key, false, -1n, P.sqrtStart, "0x").then((t: any) => t.wait()), env);
      expect(why2).to.eq("selector " + ethers.id("PriceLimitAlreadyExceeded(uint160,uint160)").slice(0, 10));
      expect((await slot0(env, P)).sqrtP).to.eq(P.sqrtStart);
      const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n });
      expect(t.gas < 400_000n).to.eq(true);
    });

    it("a sell larger than A can absorb (after graduation, plus the reserve) reverts without a limit and fills to exactly the start price with one", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      await graduate(env, P, env.bot);
      await (await env.reserveLock.release(P.id)).wait();
      await (await P.coin.connect(env.creator).transfer(env.bot.address, await P.coin.balanceOf(env.creator.address))).wait();
      const all = await P.coin.balanceOf(env.bot.address);
      await (await P.coin.connect(env.bot).approve(await env.trader.getAddress(), ethers.MaxUint256)).wait();
      const why = await revertOf(() => env.trader.connect(env.bot).swap(P.key, false, -all, 0n, "0x", { gasLimit: 5_000_000n }).then((t: any) => t.wait()), env);
      expect(why).to.match(/PriceAboveStart/);
      const t = await trade(env, P, { wallet: env.bot, buy: false, exactIn: true, amount: all, sqrtLimit: P.sqrtStart });
      expect((await slot0(env, P)).sqrtP).to.eq(P.sqrtStart);
      expect(-t.userCoin < all).to.eq(true); // partial fill: the rest stays with the seller
      const l = await ledgers(env, [P.id]);
      expect(l.claims).to.eq(l.sum);
    });

    it("exact-output sells: asking for more native than A holds reverts; within A it fills", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const ok = await trade(env, P, { wallet: env.bot, buy: false, exactIn: false, amount: WAD / 10n, limit: 10n ** 30n });
      expect(ok.rate).to.eq(200n);
      const why = await revertOf(() => env.trader.connect(env.bot).swap(P.key, false, 100n * WAD, 0n, "0x", { gasLimit: 5_000_000n }).then((t: any) => t.wait()), env);
      expect(why).to.not.eq(null);
      expect((await slot0(env, P)).sqrtP <= P.sqrtStart).to.eq(true);
    });
  });

  // ------------------------------------------------------------------------------------------------ F4 (splitter flow)
  describe("F4: the splitter operator's plan cannot be broken by a third party (C-M1 / D-L3)", () => {
    it("third-party claimRouter between plan and route reverts; the planned run routes while new fees wait in the hook", async () => {
      const { env, P } = await loadFixture(coinAfterWindow);
      for (let i = 0; i < 3; i++) await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 2n });
      await claimRouter(env);
      const s = env.splitter;
      for (let run = 1n; run <= 4n; run++) {
        const paid = (await env.hook.routerPaid(await s.getAddress())).amount;
        const [, B, G] = await s.pending();
        const [, , rsaMin] = await s.bands(B, G);
        await trade(env, P, { wallet: env.buyer, buy: true, exactIn: true, amount: WAD / 100n });
        await expect(env.hook.connect(env.attacker).claimRouter()).to.be.revertedWithCustomError(env.hook, "NotRouterCaller");
        await (await s.connect(env.operator).route(run, paid, 0n, 0n, rsaMin, ethers.ZeroHash)).wait();
        expect(await env.hook.routerOwed() > 0n).to.eq(true); // the late fee waits for the next run
        await claimRouter(env);
      }
      expect(await s.runs()).to.eq(4n);
    });
  });

  // ------------------------------------------------------------------------------------------------ F5
  describe("F5: holder-batch claim deadline is bounded and approved by the Safe (C-L2)", () => {
    async function vaultWithHolders() {
      const env = await deployGen8();
      const v: any = await (await ethers.getContractFactory("MwzCreatorChoiceVault")).deploy(env.safe.address, await env.hook.getAddress(), env.other.address, 24 * 3600);
      const rd: any = await (await ethers.getContractFactory("RewardDistributor")).deploy(env.safe.address);
      await (await v.connect(env.safe).setHolderDistributorOnce(await rd.getAddress())).wait();
      await (await v.connect(env.safe).setOperator(env.operator.address, false)).wait();
      await (await v.connect(env.safe).setCaps(WAD, WAD, 0, 50, 1000n * WAD)).wait();
      await (await rd.connect(env.safe).setBatchOperator(await v.getAddress())).wait();
      const id = ethers.id("coin-x");
      await (await v.connect(env.other).registerCoin(id, env.payee.address, env.creator.address, 2, 0)).wait();
      const amt = 3n * WAD;
      await (await v.connect(env.safe).creditUnclaimedHolders([id], [amt], { value: amt })).wait();
      return { env, v, rd, id, amt };
    }

    it("deadline 0, too early or too late is refused at proposal; the Safe must approve the exact deadline; a late execution is refused", async () => {
      const { env, v, rd, id, amt } = await loadFixture(vaultWithHolders);
      const root = ethers.id("root");
      const t = await now();
      const delay = 24n * 3600n;
      const minW = await v.MIN_CLAIM_WINDOW();
      const maxW = await v.MAX_CLAIM_WINDOW();
      expect([minW, maxW]).to.deep.eq([7n * 86400n, 365n * 86400n]);
      let ts = t;
      const nextTs = async () => {
        ts = (await now()) + 1n;
        await setNextTs(ts);
        return ts;
      };
      for (const k of [0, 1, 2]) {
        await nextTs();
        const d = [0n, ts + delay + minW - 1n, ts + maxW + 1n][k];
        await expect(v.connect(env.operator).proposeHolderBatch(ethers.id("b0"), root, d, [id], [amt]), `deadline ${d}`).to.be.revertedWithCustomError(v, "BadClaimDeadline");
      }
      // exactly at both bounds is accepted
      await nextTs();
      await (await v.connect(env.operator).proposeHolderBatch(ethers.id("lo"), root, ts + delay + minW, [id], [1n])).wait();
      await nextTs();
      await (await v.connect(env.operator).proposeHolderBatch(ethers.id("hi"), root, ts + maxW, [id], [1n])).wait();
      await (await v.connect(env.safe).vetoHolderBatch(ethers.id("lo"))).wait();
      await (await v.connect(env.safe).vetoHolderBatch(ethers.id("hi"))).wait();
      await nextTs();
      const deadline = ts + delay + 30n * 86400n;
      await (await v.connect(env.operator).proposeHolderBatch(ethers.id("b1"), root, deadline, [id], [amt])).wait();
      expect((await v.holderBatches(ethers.id("b1"))).claimDeadline).to.eq(deadline);
      // C-L2 replay: the Safe approving root + total only is no longer possible; a different deadline is refused
      await expect(v.connect(env.safe).approveHolderBatch(ethers.id("b1"), root, amt, 0n)).to.be.revertedWithCustomError(v, "BadBatch");
      await expect(v.connect(env.safe).approveHolderBatch(ethers.id("b1"), root, amt, deadline + 1n)).to.be.revertedWithCustomError(v, "BadBatch");
      await expect(v.connect(env.safe).approveHolderBatch(ethers.id("b1"), root, amt, deadline)).to.emit(v, "HolderBatchApproved").withArgs(ethers.id("b1"), root, amt, deadline);
      // executed too late to leave holders the minimum window: refused (veto and re-propose)
      await (await rd.connect(env.safe).authorizeBatch(ethers.id("b1"), amt, t, deadline)).wait();
      await mineAt(deadline - minW + 1n);
      await expect(v.connect(env.operator).executeHolderBatch(ethers.id("b1"))).to.be.revertedWithCustomError(v, "BadClaimDeadline");
      await (await v.connect(env.safe).vetoHolderBatch(ethers.id("b1"))).wait();
      expect(await v.holderBalance(id)).to.eq(amt);
    });

    it("a well-formed batch executes; after its deadline the Safe recovers the unclaimed part (nothing is locked for good)", async () => {
      const { env, v, rd, id, amt } = await loadFixture(vaultWithHolders);
      const root = ethers.id("root-nobody-can-prove");
      const t = await now();
      const deadline = t + 10n * 86400n;
      await (await rd.connect(env.safe).authorizeBatch(ethers.id("w41"), amt, t, t + 30n * 86400n)).wait();
      await (await v.connect(env.operator).proposeHolderBatch(ethers.id("w41"), root, deadline, [id], [amt])).wait();
      await (await v.connect(env.safe).approveHolderBatch(ethers.id("w41"), root, amt, deadline)).wait();
      await mineAt(t + 24n * 3600n + 10n);
      await (await v.connect(env.operator).executeHolderBatch(ethers.id("w41"))).wait();
      await mineAt(deadline + 1n);
      const b = await ethers.provider.getBalance(await rd.getAddress());
      await (await rd.connect(env.safe).recoverUnclaimed(ethers.id("w41"), env.safe.address)).wait();
      expect(b - (await ethers.provider.getBalance(await rd.getAddress()))).to.eq(amt);
    });
  });

  // ------------------------------------------------------------------------------------------------ F6
  describe("F6: oracle band (deploy inputs BNB $10..$100K, ETH $50..$500K)", () => {
    it("BNB band: launches at $10 and $100,000, refused just outside (B-05 PoC at $50,001 now launches)", async () => {
      const env = await deployGen8({ minNativeUsd: 10n * WAD, maxNativeUsd: 100_000n * WAD });
      expect([await env.launcher.minNativeUsd(), await env.launcher.maxNativeUsd()]).to.deep.eq([10n * WAD, 100_000n * WAD]);
      for (const [px, ok] of [[10n, true], [50_001n, true], [100_000n, true], [9n, false], [100_001n, false]] as [bigint, boolean][]) {
        await (await env.feed.set(px * 10n ** 8n, await now())).wait();
        if (ok) await launch(env, env.creator);
        else await expect(launch(env, env.creator)).to.be.revertedWithCustomError(env.launcher, "OraclePriceOutOfBand");
      }
    });

    it("ETH band: launches at $50 and $500,000, refused just outside", async () => {
      const env = await deployGen8({ display: false, nativeUsd: 2_500n * 10n ** 8n, minNativeUsd: 50n * WAD, maxNativeUsd: 500_000n * WAD });
      for (const [px, ok] of [[50n, true], [500_000n, true], [49n, false], [500_001n, false]] as [bigint, boolean][]) {
        await (await env.feed.set(px * 10n ** 8n, await now())).wait();
        if (ok) await launch(env, env.creator);
        else await expect(launch(env, env.creator)).to.be.revertedWithCustomError(env.launcher, "OraclePriceOutOfBand");
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ B
  describe("B: scheduled trading open (openAt)", () => {
    async function scheduled() {
      const env = await deployGen8();
      const openAt = (await now()) + 2n * 86400n;
      const l = await launch(env, env.creator, { firstBuyValue: WAD / 2n, openAt });
      return { env, ...l, openAt };
    }

    it("the creator first buy runs inside launch() at the bonding rate; Launched and PoolLaunched carry openAt", async () => {
      const { env, P, rc, ev, openAt } = await loadFixture(scheduled);
      expect(P.launchTs).to.eq(openAt);
      expect(ev.args.openAt).to.eq(openAt);
      const pl = hookEvents(env, rc).find((e: any) => e.name === "PoolLaunched");
      expect(pl.args.openAt).to.eq(openAt);
      const fee = hookEvents(env, rc).find((e: any) => e.name === "HookFee");
      expect(fee.args.feeBps).to.eq(200n);
      expect(P.firstBuyOut > 0n).to.eq(true);
      const [open, at] = await env.lens.tradingOpen(P.id);
      expect([open, at]).to.deep.eq([false, openAt]);
    });

    it("every swap before openAt is refused: direct buy and sell, escrow buy, vault buyback; at openAt the launch rate starts and decays over 60 s", async () => {
      const { env, P, openAt } = await loadFixture(scheduled);
      const r1 = await revertOf(() => env.trader.connect(env.bot).swap(P.key, true, -WAD, 0n, "0x", { value: WAD }).then((t: any) => t.wait()), env);
      expect(r1).to.match(/TradingNotOpen/);
      await (await P.coin.connect(env.creator).approve(await env.trader.getAddress(), ethers.MaxUint256)).wait();
      const r2 = await revertOf(() => env.trader.connect(env.creator).swap(P.key, false, -(1000n * WAD), 0n, "0x").then((t: any) => t.wait()), env);
      expect(r2).to.match(/TradingNotOpen/);
      const r3 = await revertOf(() => env.escrow.connect(env.creator).buy(P.token, 0n, { value: WAD }).then((t: any) => t.wait()), env);
      expect(r3).to.match(/TradingNotOpen/);
      // one second before: still refused
      await setNextTs(openAt - 1n);
      const r4 = await revertOf(() => env.trader.connect(env.bot).swap(P.key, true, -WAD, 0n, "0x", { value: WAD }).then((t: any) => t.wait()), env);
      expect(r4).to.match(/TradingNotOpen/);
      // at openAt: the launch rate (9000) applies, then the gen-7 decay from openAt
      for (const dt of [0n, 30n, 59n, 60n]) {
        const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 100n, ts: openAt + dt });
        expect(t.rate, `openAt + ${dt}`).to.eq(rateAt(dt));
      }
      expect(rateAt(0n)).to.eq(9000n);
    });

    it("buyback coin: the vault cannot buy back before openAt + 60 s", async () => {
      const env = await deployGen8();
      const openAt = (await now()) + 3600n;
      const { P } = await launch(env, env.creator, { feeChoice: 4, firstBuyValue: WAD, openAt });
      await mineAt(openAt + 61n);
      for (let i = 0; i < 3; i++) await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await env.vault.pull(P.id)).wait();
      await (await env.vault.connect(env.operator).buyback(P.id, (await env.vault.buybackBalance(P.id)) / 4n)).wait();
      const env2 = await deployGen8();
      const openAt2 = (await now()) + 3600n;
      const Q = (await launch(env2, env2.creator, { feeChoice: 4, firstBuyValue: WAD, openAt: openAt2 })).P;
      await (await env2.vault.pull(Q.id)).wait();
      await expect(env2.vault.connect(env2.operator).buyback(Q.id, 1n)).to.be.revertedWithCustomError(env2.vault, "CurveState");
    });

    it("openAt bounds: 0 and past times open now; now + 30 days is accepted; one second more is refused; openAt is signed", async () => {
      const env = await deployGen8();
      const a = await launch(env, env.creator, { openAt: 0n });
      expect(a.P.launchTs).to.eq(BigInt((await ethers.provider.getBlock(a.rc.blockNumber))!.timestamp));
      const b = await launch(env, env.creator, { openAt: 1n });
      expect(b.P.launchTs).to.eq(BigInt((await ethers.provider.getBlock(b.rc.blockNumber))!.timestamp));
      const t = await now();
      await setNextTs(t + 1n);
      const c = await launch(env, env.creator, { openAt: t + 1n + 30n * 86400n });
      expect(c.P.launchTs).to.eq(t + 1n + 30n * 86400n);
      const t2 = await now();
      const r = req({ openAt: t2 + 1n + 30n * 86400n + 1n });
      const deadline = t2 + 3600n;
      const sig = await signCreate(env, env.creator.address, r, deadline);
      await setNextTs(t2 + 1n);
      await expect(env.launcher.connect(env.creator).launch(reqTuple(r), { deadline, signature: sig })).to.be.revertedWithCustomError(env.launcher, "OpenAtTooFar");
      // tampering openAt breaks the API signature
      const r2 = req({ openAt: t2 + 7200n });
      const sig2 = await signCreate(env, env.creator.address, r2, deadline);
      await expect(env.launcher.connect(env.creator).launch(reqTuple({ ...r2, openAt: t2 + 7201n }), { deadline, signature: sig2 })).to.be.revertedWithCustomError(env.launcher, "InvalidAuthorization");
      void FAST_TARGET;
    });

    it("graduation, claims and the router are unaffected by a schedule", async () => {
      const { env, P, openAt } = await loadFixture(scheduled);
      // the creator's first-buy fee is claimable before trading opens
      expect(await env.hook.creatorOwed(P.id) > 0n).to.eq(true);
      await (await env.hook.connect(env.creator).claimCreator(P.id, env.payee.address)).wait();
      await claimRouter(env);
      await mineAt(openAt + 61n);
      const g = await graduate(env, P, env.bot);
      expect(g.graduated).to.not.eq(null);
      expect(g.rate).to.eq(200n);
      void MAX_SQRT_PRICE;
    });
  });
});

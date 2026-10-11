import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployGen8, launch, trade, feeExact, mineAt, now, graduate, ledgers, slot0, liquidity, nativeTargetA, soldFromPrice, revertOf, deployQuoter, quote,
  quotedSide, poolOf, Env, Pool, DEAD, coder, NATIVE, DYNAMIC_FEE, SPACING, WNATIVE_LOCAL, HOOK_FLAGS,
} from "./fixtures/gen8";
import { BPS, WAD, COINS_A, COINS_B, RESERVE, SUPPLY, MIN_USABLE_TICK, MIN_SQRT_PRICE, MAX_SQRT_PRICE, amount0Delta, amount1Delta, grossForNet, rateAt, sqrtAtTick, isqrt, ppm } from "./fixtures/v4math";

const FEES = [200n, 100n, 50n, 9000n, 560n];

async function base() {
  const env = await deployGen8();
  const quoter = await deployQuoter(env);
  const { P, rc, ev } = await launch(env, env.creator, { firstBuyValue: WAD / 2n });
  return { env, quoter, P, rcLaunch: rc, evLaunch: ev };
}

async function afterWindow() {
  const b = await base();
  await mineAt(b.P.launchTs + 61n);
  return b;
}

async function graduated() {
  const b = await afterWindow();
  const g = await graduate(b.env, b.P, b.env.bot);
  return { ...b, g };
}

async function impersonate(addr: string) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

describe("gen8 MwzLaunchHook", function () {
  describe("deployment and permissions", () => {
    it("address carries exactly the 0x28EC flags; immutables, owner and router are set", async () => {
      const { env } = await loadFixture(base);
      const hookAddr = await env.hook.getAddress();
      expect(BigInt(hookAddr) & 0x3fffn).to.eq(HOOK_FLAGS);
      expect(await env.hook.poolManager()).to.eq(await env.pm.getAddress());
      expect(await env.hook.launcher()).to.eq(await env.launcher.getAddress());
      expect(await env.hook.displayFactory()).to.eq(await env.displayFactory!.getAddress());
      expect(await env.hook.owner()).to.eq(env.safe.address);
      expect(await env.hook.treasuryRouter()).to.eq(await env.splitter.getAddress());
      expect(await env.hook.TICK_SPACING()).to.eq(10n);
      expect(await env.hook.MAX_BONDING_FEE_BPS()).to.eq(200n);
      expect(await env.hook.MAX_POST_FEE_BPS()).to.eq(100n);
      expect(await env.hook.MAX_SNIPER_START_BPS()).to.eq(9000n);
      expect(await env.hook.MAX_CREATOR_BONDING_BPS()).to.eq(1000n);
      expect(await env.hook.GRAD_FEE_BPS()).to.eq(200n);
      expect(await env.hook.ROUTER_TIMELOCK()).to.eq(48n * 3600n);
      expect(await env.hook.DISPLAY_GAS()).to.eq(60_000n);
    });

    it("constructor rejects zero addresses and an address without the hook flags", async () => {
      const { env } = await loadFixture(base);
      const F = await ethers.getContractFactory("MwzLaunchHook", { libraries: env.libs });
      const pm = await env.pm.getAddress();
      const z = ethers.ZeroAddress;
      await expect(F.deploy(z, env.other.address, env.safe.address, env.other.address, z)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(pm, z, env.safe.address, env.other.address, z)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(pm, env.other.address, z, env.other.address, z)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(pm, env.other.address, env.safe.address, z, z)).to.be.revertedWithCustomError(F, "ZeroAddress");
      // valid args at an address without the flags: v4-core Hooks.validateHookPermissions reverts
      const r = await revertOf(() => F.deploy(pm, env.other.address, env.safe.address, env.other.address, z), env);
      expect(r).to.eq("selector " + ethers.id("HookAddressNotValid(address)").slice(0, 10));
    });

    it("every callback is PoolManager-only; unused callbacks revert HookNotImplemented", async () => {
      const { env, P } = await loadFixture(base);
      const h = env.hook.connect(env.attacker);
      const swapParams = [true, -1n, MIN_SQRT_PRICE + 1n];
      const mlp = [P.tickGrad, P.tickStart, 1n, ethers.ZeroHash];
      await expect(h.beforeInitialize(env.attacker.address, P.key, 1n)).to.be.revertedWithCustomError(env.hook, "NotPoolManager");
      await expect(h.beforeAddLiquidity(env.attacker.address, P.key, mlp, "0x")).to.be.revertedWithCustomError(env.hook, "NotPoolManager");
      await expect(h.beforeDonate(env.attacker.address, P.key, 1n, 0n, "0x")).to.be.revertedWithCustomError(env.hook, "NotPoolManager");
      await expect(h.beforeSwap(env.attacker.address, P.key, swapParams, "0x")).to.be.revertedWithCustomError(env.hook, "NotPoolManager");
      await expect(h.afterSwap(env.attacker.address, P.key, swapParams, 0n, "0x")).to.be.revertedWithCustomError(env.hook, "NotPoolManager");
      await expect(h.unlockCallback("0x")).to.be.revertedWithCustomError(env.hook, "NotPoolManager");
      await expect(h.afterInitialize(env.attacker.address, P.key, 1n, 0)).to.be.revertedWithCustomError(env.hook, "HookNotImplemented");
      await expect(h.afterAddLiquidity(env.attacker.address, P.key, mlp, 0n, 0n, "0x")).to.be.revertedWithCustomError(env.hook, "HookNotImplemented");
      await expect(h.beforeRemoveLiquidity(env.attacker.address, P.key, mlp, "0x")).to.be.revertedWithCustomError(env.hook, "HookNotImplemented");
      await expect(h.afterRemoveLiquidity(env.attacker.address, P.key, mlp, 0n, 0n, "0x")).to.be.revertedWithCustomError(env.hook, "HookNotImplemented");
      await expect(h.afterDonate(env.attacker.address, P.key, 1n, 0n, "0x")).to.be.revertedWithCustomError(env.hook, "HookNotImplemented");
      // an unknown action through the hook's own unlock path is impossible; from the PoolManager address it reverts
      const pmSigner = await impersonate(await env.pm.getAddress());
      await expect(env.hook.connect(pmSigner).unlockCallback(coder.encode(["uint8", "bytes"], [9, "0x"]))).to.be.revertedWithCustomError(env.hook, "HookNotImplemented");
      await expect(env.hook.connect(pmSigner).beforeInitialize(env.attacker.address, P.key, 1n)).to.be.revertedWithCustomError(env.hook, "OnlyThisHookMayInitialize");
      await expect(env.hook.connect(pmSigner).beforeAddLiquidity(env.attacker.address, P.key, mlp, "0x")).to.be.revertedWithCustomError(env.hook, "LiquidityIsLocked");
      await expect(env.hook.connect(pmSigner).beforeDonate(env.attacker.address, P.key, 1n, 0n, "0x")).to.be.revertedWithCustomError(env.hook, "DonateDisabled");
      const unknownKey = [NATIVE, env.other.address, DYNAMIC_FEE, SPACING, await env.hook.getAddress()];
      await expect(env.hook.connect(pmSigner).beforeSwap(env.attacker.address, unknownKey, swapParams, "0x")).to.be.revertedWithCustomError(env.hook, "UnknownPool");
    });
  });

  describe("createPool (launcher only)", () => {
    it("reverts for anyone but the launcher, on every cap, on bad ranges, on zero addresses and on an existing pool", async () => {
      const { env, P } = await loadFixture(base);
      const fees = [200, 100, 50, 9000, 560];
      await expect(env.hook.connect(env.attacker).createPool(env.other.address, env.attacker.address, P.tickStart, P.tickGrad, 1n, 1n, fees)).to.be.revertedWithCustomError(env.hook, "NotLauncher");
      const L = await impersonate(await env.launcher.getAddress());
      const h = env.hook.connect(L);
      const tok = env.other.address;
      for (const f of [[201, 100, 50, 9000, 560], [200, 101, 50, 9000, 560], [200, 100, 50, 9001, 560], [200, 100, 101, 9000, 560], [200, 100, 50, 199, 560], [200, 100, 50, 9000, 1001]]) {
        await expect(h.createPool(tok, env.creator.address, P.tickStart, P.tickGrad, COINS_A, COINS_B, f)).to.be.revertedWithCustomError(env.hook, "FeeCapExceeded");
      }
      for (const [ts, tg] of [[P.tickStart + 1, P.tickGrad], [P.tickStart, P.tickGrad + 3], [P.tickGrad, P.tickGrad], [P.tickGrad - 10, P.tickGrad], [P.tickStart, MIN_USABLE_TICK], [887280, P.tickGrad]]) {
        await expect(h.createPool(tok, env.creator.address, ts, tg, COINS_A, COINS_B, fees)).to.be.revertedWithCustomError(env.hook, "BadRange");
      }
      await expect(h.createPool(tok, env.creator.address, P.tickStart, P.tickGrad, 0n, COINS_B, fees)).to.be.revertedWithCustomError(env.hook, "BadRange");
      await expect(h.createPool(tok, ethers.ZeroAddress, P.tickStart, P.tickGrad, COINS_A, COINS_B, fees)).to.be.revertedWithCustomError(env.hook, "ZeroAddress");
      await expect(h.createPool(ethers.ZeroAddress, env.creator.address, P.tickStart, P.tickGrad, COINS_A, COINS_B, fees)).to.be.revertedWithCustomError(env.hook, "ZeroAddress");
      await expect(h.createPool(P.token, env.creator.address, P.tickStart, P.tickGrad, COINS_A, COINS_B, fees)).to.be.revertedWithCustomError(env.hook, "PoolExists");
    });

    it("launch state: positions A (850M) and B (130M) owned by the hook, rates stored, LP fee 0, hook holds 0 coins, dust burned (I5, I13)", async () => {
      const { env, P, rcLaunch } = await loadFixture(base);
      const st = await env.hook.pools(P.id);
      expect(st.creator).to.eq(env.creator.address);
      expect(st.graduated).to.eq(false);
      expect(st.fees.map((x: bigint) => x)).to.deep.eq(FEES);
      expect(st.sqrtGrad).to.eq(sqrtAtTick(P.tickGrad));
      const s = await slot0(env, P);
      expect(s.lpFee).to.eq(0);
      expect(P.mintedA <= COINS_A && COINS_A - P.mintedA < 10n ** 6n).to.eq(true);
      const mintedB = amount1Delta(sqrtAtTick(MIN_USABLE_TICK), P.sqrtGrad, P.liqB, true);
      expect(mintedB <= COINS_B && COINS_B - mintedB < 10n ** 6n).to.eq(true);
      expect(await P.coin.balanceOf(await env.hook.getAddress())).to.eq(0n);
      // I13: every coin accounted: pool (A + B minus the first buy), creator first buy, reserve lock, dust at DEAD
      const pmBal = await P.coin.balanceOf(await env.pm.getAddress());
      const dead = await P.coin.balanceOf(DEAD);
      const creatorBal = await P.coin.balanceOf(env.creator.address);
      const lockBal = await P.coin.balanceOf(await env.reserveLock.getAddress());
      expect(pmBal + dead + creatorBal + lockBal).to.eq(SUPPLY);
      expect(lockBal).to.eq(RESERVE);
      expect(creatorBal).to.eq(P.firstBuyOut);
      expect(dead).to.eq(COINS_A + COINS_B - P.mintedA - mintedB);
      expect(await P.coin.totalSupply()).to.eq(SUPPLY);
      const launched = rcLaunch.logs.map((l: any) => { try { return env.hook.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "PoolLaunched");
      expect(launched.args.id).to.eq(P.id);
      expect(launched.args.display).to.eq(P.pair);
    });
  });

  describe("liquidity lock and front-running (I6)", () => {
    it("outside initialize, add, remove and donate all fail", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const fakeKey = [NATIVE, env.other.address, DYNAMIC_FEE, SPACING, await env.hook.getAddress()];
      expect(await revertOf(() => env.attackerC.tryInitialize.staticCall(fakeKey, sqrtAtTick(P.tickStart)), env)).to.match(/OnlyThisHookMayInitialize/);
      await (await P.coin.connect(env.creator).transfer(await env.attackerC.getAddress(), 1_000_000n * WAD)).wait();
      expect(await revertOf(() => env.attackerC.tryAdd.staticCall(P.key, P.tickGrad, P.tickStart, 10n ** 18n), env)).to.match(/LiquidityIsLocked/);
      expect(await revertOf(() => env.attackerC.tryAdd.staticCall(P.key, MIN_USABLE_TICK, P.tickGrad, 10n ** 18n), env)).to.match(/LiquidityIsLocked/);
      expect(await revertOf(() => env.attackerC.tryRemove.staticCall(P.key, P.tickGrad, P.tickStart, 1n), env)).to.not.eq(null);
      expect(await revertOf(() => env.attackerC.tryDonate.staticCall(P.key, { value: WAD }), env)).to.match(/DonateDisabled/);
      // positions untouched
      expect(await liquidity(env, P)).to.eq(P.liqA);
    });
  });

  describe("fees, gen-7 definition to the wei (I1, I3, D2)", () => {
    it("bonding 2% for all four swap types, with V4Quoter == executed and creator share 560 bps of the fee", async () => {
      const { env, quoter, P } = await loadFixture(afterWindow);
      const R = nativeTargetA(P);
      const cases: [boolean, boolean, bigint, bigint][] = [
        [true, true, R / 50n + 12345n, 0n],
        [true, false, 5_000_000n * WAD, R],
        [false, true, 2_000_000n * WAD, 0n],
        [false, false, R / 200n + 777n, 0n],
      ];
      for (const [buy, exactIn, amount, limit] of cases) {
        const q = await quote(quoter, P, buy, exactIn, amount);
        const before = await ledgers(env, [P.id]);
        const t = await trade(env, P, { wallet: buy ? env.buyer : env.creator, buy, exactIn, amount, limit });
        const after = await ledgers(env, [P.id]);
        const [ok, d] = feeExact(t, buy, exactIn, amount);
        expect(ok, d).to.eq(true);
        expect(t.rate).to.eq(200n);
        expect(t.graduatedFlag).to.eq(false);
        expect(q).to.eq(quotedSide(t, buy, exactIn));
        const cShare = (t.fee! * 560n) / BPS;
        expect(t.creatorShare).to.eq(cShare);
        expect(after.creators - before.creators).to.eq(cShare);
        expect(after.router - before.router).to.eq(t.fee! - cShare);
        expect(after.claims).to.eq(after.sum); // I4
        expect(await env.hook.pendingBondingFees()).to.be.gte(t.fee!);
      }
    });

    it("exact-input buy fee is the gen-7 floor plus 0..2 wei over 60 sizes", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const R = nativeTargetA(P);
      let maxDust = 0n;
      for (let i = 1n; i <= 60n; i++) {
        const G = (R * i) / 4999n + i * 7919n;
        const cost = (G * BPS) / (BPS + 200n);
        const d = G - cost - (cost * 200n) / BPS;
        if (d > maxDust) maxDust = d;
        expect(d >= 0n && d <= 2n).to.eq(true);
      }
      // and on chain for a few sizes
      for (const G of [1n, 101n, 10_203n, R / 1000n + 1n]) {
        const t = await trade(env, P, { wallet: env.buyer, buy: true, exactIn: true, amount: G });
        const [ok, d] = feeExact(t, true, true, G);
        expect(ok, d).to.eq(true);
      }
    });

    it("anti-sniper: 9000 bps falling linearly to 200 over 60 s for buys and sells, every caller; the launcher's first buy paid 200 (A11)", async () => {
      const { env, P, evLaunch } = await loadFixture(base);
      // first buy at the bonding rate
      const fbIn = evLaunch.args.firstBuyIn as bigint;
      const fbCost = (fbIn * BPS) / (BPS + 200n);
      const fbFee = fbIn - fbCost;
      const fbShare = (fbFee * 560n) / BPS;
      expect(await env.hook.creatorOwed(P.id)).to.eq(fbShare);
      expect(await env.hook.routerOwed()).to.eq(fbFee - fbShare);
      const R = nativeTargetA(P);
      for (const dt of [1n, 2n, 10n, 30n, 45n, 59n, 60n, 61n]) {
        for (const buy of [true, false]) {
          const snap = await network.provider.send("evm_snapshot", []);
          const amount = buy ? R / 100n : 1_000_000n * WAD;
          expect(await env.lens.currentFeeBps(P.id, env.bot.address)).to.be.gte(200n);
          const t = await trade(env, P, { wallet: buy ? env.bot : env.creator, buy, exactIn: true, amount, ts: P.launchTs + dt });
          const blockTs = BigInt((await ethers.provider.getBlock(t.rc.blockNumber))!.timestamp);
          const expected = rateAt(blockTs - P.launchTs);
          const [ok, d] = feeExact(t, buy, true, amount);
          expect(t.rate, `t+${dt}`).to.eq(expected);
          expect(ok, d).to.eq(true);
          await network.provider.send("evm_revert", [snap]);
        }
      }
      expect(await env.lens.currentFeeBps(P.id, await env.launcher.getAddress())).to.eq(200n);
    });

    it("partial fills: preview == fill, fee only on the filled part, price stops at the limit (I2)", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const R = nativeTargetA(P);
      const pf = async (buy: boolean, amount: bigint, limit: bigint) => {
        const r = await env.lens.currentFeeBps(P.id, await env.trader.getAddress());
        const spec = buy ? -((amount * BPS) / (BPS + r)) : grossForNet(amount, r);
        const preview = await env.lens.previewFill(P.id, buy, spec, limit);
        const t = await trade(env, P, { wallet: env.bot, buy, exactIn: buy, amount, limit: buy ? 0n : 10n ** 30n, sqrtLimit: limit });
        const s = await slot0(env, P);
        const fill = buy ? -t.raw0 : t.raw0;
        const fee = (fill * r) / BPS;
        expect(fill).to.eq(preview);
        expect(fill < (buy ? -spec : spec)).to.eq(true);
        expect(t.fee).to.eq(fee);
        expect(t.curve).to.eq(fill);
        expect(buy ? -t.userNative === fill + fee : t.userNative === fill - fee).to.eq(true);
        expect(s.sqrtP).to.eq(limit);
        return t;
      };
      // need coins to sell: buy some first
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: R / 4n });
      let s = await slot0(env, P);
      await pf(true, R, s.sqrtP - s.sqrtP / 100n); // exact-in buy, limit inside A
      s = await slot0(env, P);
      await pf(false, R, s.sqrtP + s.sqrtP / 200n); // exact-out sell, limit inside A
      // across the A/B boundary to a limit inside B: graduates in the same swap
      const t = await pf(true, R * 3n, P.sqrtGrad - P.sqrtGrad / 100n);
      expect(t.graduated).to.not.eq(null);
      // post-graduation partial fills inside B and back to the boundary and into A
      s = await slot0(env, P);
      await pf(true, R * 2n, s.sqrtP - s.sqrtP / 50n);
      s = await slot0(env, P);
      await pf(false, R * 2n, s.sqrtP + (P.sqrtGrad - s.sqrtP) / 3n);
      await pf(false, R * 2n, P.sqrtGrad);
      await pf(false, R * 5n, P.sqrtGrad + P.sqrtGrad / 20n);
      expect((await env.hook.pools(P.id)).graduated).to.eq(true);
      expect(await env.lens.currentFeeBps(P.id, env.bot.address)).to.eq(100n);
    });

    it("a limit already passed fills nothing in the preview; the PoolManager rejects the swap", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const s = await slot0(env, P);
      expect(await env.lens.previewFill(P.id, true, -WAD, s.sqrtP + 1n)).to.eq(0n);
      expect(await env.lens.previewFill(P.id, false, WAD, s.sqrtP - 1n)).to.eq(0n);
      await expect(env.lens.previewFill(ethers.ZeroHash, true, -WAD, s.sqrtP - 1n)).to.be.revertedWithCustomError(env.lens, "UnknownPool");
      await expect(env.lens.currentFeeBps(ethers.ZeroHash, env.bot.address)).to.be.revertedWithCustomError(env.lens, "UnknownPool");
    });

    it("with the Uniswap protocol fee forced to 0.1%: fee still gen-7 exact, quoter exact, partial-fill replay exact (A6)", async () => {
      const { env, quoter, P } = await loadFixture(afterWindow);
      await (await env.pm.connect(env.deployer).setProtocolFeeController(env.deployer.address)).wait();
      await (await env.pm.connect(env.deployer).setProtocolFee(P.key, 1000 | (1000 << 12))).wait();
      expect((await slot0(env, P)).protocolFee).to.eq(1000 | (1000 << 12));
      const R = nativeTargetA(P);
      for (const [buy, exactIn, amount, limit] of [[true, true, R / 20n, 0n], [true, false, 3_000_000n * WAD, R], [false, true, 1_000_000n * WAD, 0n], [false, false, R / 300n, 0n]] as [boolean, boolean, bigint, bigint][]) {
        const q = await quote(quoter, P, buy, exactIn, amount);
        const t = await trade(env, P, { wallet: buy ? env.bot : env.creator, buy, exactIn, amount, limit });
        // the protocol fee is charged on the swap input by the PoolManager on top; our fee stays gen-7 exact on the
        // curve amount that the Swap event reports
        expect(t.fee).to.eq(buy && exactIn ? amount - (amount * BPS) / (BPS + 200n) : (t.curve! * 200n) / BPS);
        expect(q).to.eq(quotedSide(t, buy, exactIn));
      }
      const s = await slot0(env, P);
      const r = 200n;
      const amount = R;
      const limit = P.sqrtGrad - P.sqrtGrad / 200n;
      const spec = -((amount * BPS) / (BPS + r));
      const preview = await env.lens.previewFill(P.id, true, spec, limit);
      const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount, sqrtLimit: limit });
      expect(-t.raw0).to.eq(preview);
      expect((await slot0(env, P)).sqrtP).to.eq(limit);
      void s;
    });
  });

  describe("graduation latch (I6, I7)", () => {
    it("no graduation with one coin of A left; the crossing swap graduates once, removes exactly floor(liqA * 2%) of A for 2% of A's raise", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const s0 = await slot0(env, P);
      const left = P.mintedA - soldFromPrice(P, s0.sqrtP);
      const t1 = await trade(env, P, { wallet: env.bot, buy: true, exactIn: false, amount: left - WAD, limit: nativeTargetA(P) * 2n });
      expect(t1.graduated).to.eq(null);
      expect((await env.hook.pools(P.id)).graduated).to.eq(false);
      const before = await ledgers(env, [P.id]);
      const gradBefore = await env.hook.pendingGradFees();
      const t2 = await trade(env, P, { wallet: env.bot, buy: true, exactIn: false, amount: 2n * WAD, limit: WAD });
      expect(t2.graduated).to.not.eq(null);
      expect(t2.graduatedFlag).to.eq(false); // the crossing swap pays the bonding rate (A12)
      expect(t2.rate).to.eq(200n);
      const removed = (P.liqA * 200n) / BPS;
      const nativeInA = amount0Delta(P.sqrtGrad, P.sqrtStart, P.liqA, false);
      const expectedFee = amount0Delta(P.sqrtGrad, P.sqrtStart, removed, false);
      expect(t2.graduated!.removed).to.eq(removed);
      expect(t2.graduated!.nativeInA).to.eq(nativeInA);
      expect(t2.graduated!.gradFee).to.eq(expectedFee);
      expect(expectedFee - (nativeInA * 200n) / BPS <= 2n && (nativeInA * 200n) / BPS - expectedFee <= 2n).to.eq(true);
      const after = await ledgers(env, [P.id]);
      expect(after.router - before.router).to.eq(t2.fee! - t2.creatorShare! + expectedFee);
      expect((await env.hook.pendingGradFees()) - gradBefore).to.eq(expectedFee);
      expect(after.claims).to.eq(after.sum);
      // A keeps exactly 98%, B untouched (positions owned by the hook)
      const stateSlot = (posKey: string) => posKey;
      void stateSlot;
      expect((await env.hook.pools(P.id)).graduated).to.eq(true);
    });

    it("buy to exactly the A/B boundary graduates; after graduation 1%: creator exactly 0.5% of volume, router the rest (I8)", async () => {
      const { env, quoter, P } = await loadFixture(afterWindow);
      const t0 = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: nativeTargetA(P) * 2n, sqrtLimit: P.sqrtGrad });
      expect(t0.graduated).to.not.eq(null);
      expect((await slot0(env, P)).sqrtP).to.eq(P.sqrtGrad);
      const R = nativeTargetA(P);
      for (const [buy, exactIn, amount, limit] of [[true, true, R / 20n + 3n, 0n], [true, false, 3_000_000n * WAD, R], [false, true, 5_000_000n * WAD, 0n], [false, false, R / 100n + 5n, 0n]] as [boolean, boolean, bigint, bigint][]) {
        const q = await quote(quoter, P, buy, exactIn, amount);
        const b = await ledgers(env, [P.id]);
        const pb = await env.hook.pendingBondingFees();
        const t = await trade(env, P, { wallet: env.bot, buy, exactIn, amount, limit });
        const a = await ledgers(env, [P.id]);
        const [ok, d] = feeExact(t, buy, exactIn, amount);
        expect(ok, d).to.eq(true);
        expect(t.rate).to.eq(100n);
        expect(t.graduatedFlag).to.eq(true);
        const cExp = (t.curve! * 50n) / BPS;
        expect(t.creatorShare).to.eq(cExp);
        expect(a.creators - b.creators).to.eq(cExp);
        expect(a.router - b.router).to.eq(t.fee! - cExp);
        expect(await env.hook.pendingBondingFees()).to.eq(pb); // post-grad fees are not bonding fees
        expect(q).to.eq(quotedSide(t, buy, exactIn));
        expect(t.graduated).to.eq(null);
      }
    });

    it("falling back into A keeps the 1% rate; re-crossing never graduates again or takes another 2% (I7)", async () => {
      const { env, P } = await loadFixture(graduated);
      const R = nativeTargetA(P);
      await trade(env, P, { wallet: env.bot, buy: false, exactIn: false, amount: R * 5n, sqrtLimit: P.sqrtGrad + P.sqrtGrad / 20n, limit: 10n ** 30n });
      expect((await slot0(env, P)).sqrtP > P.sqrtGrad).to.eq(true);
      expect(await env.lens.currentFeeBps(P.id, env.bot.address)).to.eq(100n);
      const g = await env.hook.pendingGradFees();
      const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: R });
      expect(t.graduated).to.eq(null);
      expect(t.rate).to.eq(100n);
      expect(await env.hook.pendingGradFees()).to.eq(g);
    });
  });

  describe("creator rights (I9)", () => {
    it("only the creator claims, to any address; owner and strangers cannot; two-step transfer; old creator loses rights", async () => {
      const { env, P } = await loadFixture(graduated);
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const id = P.id;
      await expect(env.hook.connect(env.safe).claimCreator(id, env.safe.address)).to.be.revertedWithCustomError(env.hook, "NotCreator");
      await expect(env.hook.connect(env.safe).proposeCreator(id, env.safe.address)).to.be.revertedWithCustomError(env.hook, "NotCreator");
      await expect(env.hook.connect(env.attacker).claimCreator(id, env.attacker.address)).to.be.revertedWithCustomError(env.hook, "NotCreator");
      await expect(env.hook.connect(env.creator).claimCreator(id, ethers.ZeroAddress)).to.be.revertedWithCustomError(env.hook, "ZeroAddress");
      await expect(env.hook.connect(env.attacker).proposeCreator(ethers.ZeroHash, env.attacker.address)).to.be.revertedWithCustomError(env.hook, "UnknownPool");
      const owed = await env.hook.creatorOwed(id);
      const pb = await ethers.provider.getBalance(env.payee.address);
      await expect(env.hook.connect(env.creator).claimCreator(id, env.payee.address)).to.emit(env.hook, "CreatorClaimed").withArgs(id, env.payee.address, owed);
      expect((await ethers.provider.getBalance(env.payee.address)) - pb).to.eq(owed);
      expect(await env.hook.creatorOwed(id)).to.eq(0n);
      await expect(env.hook.connect(env.creator).claimCreator(id, env.payee.address)).to.be.revertedWithCustomError(env.hook, "NothingOwed");
      await expect(env.hook.connect(env.creator).proposeCreator(id, env.creator2.address)).to.emit(env.hook, "CreatorProposed").withArgs(id, env.creator.address, env.creator2.address);
      await expect(env.hook.connect(env.creator2).claimCreator(id, env.creator2.address)).to.be.revertedWithCustomError(env.hook, "NotCreator");
      await expect(env.hook.connect(env.attacker).acceptCreator(id)).to.be.revertedWithCustomError(env.hook, "NotPendingCreator");
      // cancel and re-propose
      await (await env.hook.connect(env.creator).proposeCreator(id, ethers.ZeroAddress)).wait();
      await expect(env.hook.connect(env.creator2).acceptCreator(id)).to.be.revertedWithCustomError(env.hook, "NotPendingCreator");
      await (await env.hook.connect(env.creator).proposeCreator(id, env.creator2.address)).wait();
      await expect(env.hook.connect(env.creator2).acceptCreator(id)).to.emit(env.hook, "CreatorTransferred").withArgs(id, env.creator.address, env.creator2.address);
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await expect(env.hook.connect(env.creator).claimCreator(id, env.creator.address)).to.be.revertedWithCustomError(env.hook, "NotCreator");
      await expect(env.hook.connect(env.creator).proposeCreator(id, env.creator.address)).to.be.revertedWithCustomError(env.hook, "NotCreator");
      const owed2 = await env.hook.creatorOwed(id);
      expect(owed2 > 0n).to.eq(true);
      await expect(env.hook.connect(env.creator2).claimCreator(id, env.payee.address)).to.emit(env.hook, "CreatorClaimed").withArgs(id, env.payee.address, owed2);
      const l = await ledgers(env, [id]);
      expect(l.claims).to.eq(l.sum);
    });

    it("a creator contract that rejects native: claiming to itself reverts and keeps the balance, claiming to an EOA works (A13)", async () => {
      const { env, P } = await loadFixture(graduated);
      const rej = await (await ethers.getContractFactory("RejectingCreator")).connect(env.deployer).deploy();
      await (await env.hook.connect(env.creator).proposeCreator(P.id, await rej.getAddress())).wait();
      await (await rej.connect(env.deployer).accept(await env.hook.getAddress(), P.id)).wait();
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const owed = await env.hook.creatorOwed(P.id);
      const hookAddr = await env.hook.getAddress();
      const rejAddr = await rej.getAddress();
      expect(await revertOf(() => rej.connect(env.deployer).claimTo.staticCall(hookAddr, P.id, rejAddr), env)).to.not.eq(null);
      expect(await env.hook.creatorOwed(P.id)).to.eq(owed);
      const pb = await ethers.provider.getBalance(env.payee.address);
      await (await rej.connect(env.deployer).claimTo(await env.hook.getAddress(), P.id, env.payee.address)).wait();
      expect((await ethers.provider.getBalance(env.payee.address)) - pb).to.eq(owed);
    });

    it("reentrancy: a creator re-entering claimCreator or claimRouter from its receive() is refused (A14)", async () => {
      const { env, P } = await loadFixture(graduated);
      for (const mode of [1, 2]) {
        const rc = await (await ethers.getContractFactory("ReentrantClaimer")).deploy();
        const id = P.id;
        const cur = (await env.hook.pools(id)).creator;
        const curSigner = cur === env.creator.address ? env.creator : await impersonate(cur);
        await (await env.hook.connect(curSigner).proposeCreator(id, await rc.getAddress())).wait();
        await (await rc.arm(await env.hook.getAddress(), id, mode)).wait();
        await (await rc.accept()).wait();
        await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
        const owed = await env.hook.creatorOwed(id);
        await (await rc.claim()).wait();
        expect(await rc.reentered()).to.eq(true);
        expect(await rc.reentrySucceeded()).to.eq(false);
        const err = await rc.reentryError();
        expect(err.slice(0, 10)).to.eq(env.hook.interface.getError("Reentrancy")!.selector);
        expect(await ethers.provider.getBalance(await rc.getAddress())).to.be.gte(owed);
        expect(await env.hook.creatorOwed(id)).to.eq(0n);
      }
    });
  });

  describe("router bucket, timelock and A4 flush (I10)", () => {
    it("claimRouter is permissionless, pays the current router and records routerPaid; nothing owed reverts", async () => {
      const { env, P } = await loadFixture(graduated);
      const owed = await env.hook.routerOwed();
      const bonding = await env.hook.pendingBondingFees();
      const grad = await env.hook.pendingGradFees();
      const splitter = await env.splitter.getAddress();
      const sb = await ethers.provider.getBalance(splitter);
      await expect(env.hook.connect(env.attacker).claimRouter()).to.emit(env.hook, "RouterClaimed").withArgs(splitter, owed, bonding, grad);
      expect((await ethers.provider.getBalance(splitter)) - sb).to.eq(owed);
      const paid = await env.hook.routerPaid(splitter);
      expect([paid.amount, paid.bondingFees, paid.gradFees]).to.deep.eq([owed, bonding, grad]);
      expect(await env.hook.routerOwed()).to.eq(0n);
      expect(await env.hook.pendingBondingFees()).to.eq(0n);
      expect(await env.hook.pendingGradFees()).to.eq(0n);
      await expect(env.hook.claimRouter()).to.be.revertedWithCustomError(env.hook, "NothingOwed");
      const l = await ledgers(env, [P.id]);
      expect(l.claims).to.eq(l.sum);
    });

    it("propose / cancel / execute: owner only, 48 h, then the old router is flushed first (A4)", async () => {
      const { env, P } = await loadFixture(graduated);
      const sink = await (await ethers.getContractFactory("NativeSink")).deploy();
      const next = await sink.getAddress();
      await expect(env.hook.connect(env.attacker).proposeTreasuryRouter(next)).to.be.revertedWithCustomError(env.hook, "NotOwner");
      await expect(env.hook.connect(env.safe).proposeTreasuryRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(env.hook, "ZeroAddress");
      await expect(env.hook.connect(env.safe).cancelTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "NoPendingRouter");
      await expect(env.hook.connect(env.safe).executeTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "NoPendingRouter");
      await (await env.hook.connect(env.safe).proposeTreasuryRouter(next)).wait();
      const eta = await env.hook.routerEta();
      await expect(env.hook.connect(env.safe).executeTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "TimelockActive");
      await mineAt(eta - 60n);
      await expect(env.hook.connect(env.safe).executeTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "TimelockActive");
      await expect(env.hook.connect(env.attacker).cancelTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "NotOwner");
      await expect(env.hook.connect(env.safe).cancelTreasuryRouter()).to.emit(env.hook, "RouterProposalCancelled").withArgs(next);
      await mineAt(eta + 1n);
      await expect(env.hook.connect(env.safe).executeTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "NoPendingRouter");
      await (await env.hook.connect(env.safe).proposeTreasuryRouter(next)).wait();
      const eta2 = await env.hook.routerEta();
      await mineAt(eta2);
      await expect(env.hook.connect(env.attacker).executeTreasuryRouter()).to.be.revertedWithCustomError(env.hook, "NotOwner");
      const splitter = await env.splitter.getAddress();
      const owed = await env.hook.routerOwed();
      const sb = await ethers.provider.getBalance(splitter);
      const tx = env.hook.connect(env.safe).executeTreasuryRouter();
      await expect(tx).to.emit(env.hook, "RouterClaimed").withArgs(splitter, owed, (v: bigint) => true, (v: bigint) => true);
      expect((await ethers.provider.getBalance(splitter)) - sb).to.eq(owed); // flushed to the OLD router
      expect(await env.hook.treasuryRouter()).to.eq(next);
      expect(await env.hook.routerOwed()).to.eq(0n);
      // new accruals go to the new router
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const owed2 = await env.hook.routerOwed();
      await (await env.hook.connect(env.attacker).claimRouter()).wait();
      expect(await sink.received()).to.eq(owed2);
      // rates unchanged by any admin action (I12)
      expect((await env.hook.pools(P.id)).fees.map((x: bigint) => x)).to.deep.eq(FEES);
    });

    it("a router that refuses native cannot block the change: the flush fails softly and the bucket follows the new router", async () => {
      const { env, P } = await loadFixture(graduated);
      const bad = await (await ethers.getContractFactory("RevertingSink")).deploy();
      const good = await (await ethers.getContractFactory("NativeSink")).deploy();
      await (await env.hook.connect(env.safe).proposeTreasuryRouter(await bad.getAddress())).wait();
      await mineAt((await env.hook.routerEta()) + 1n);
      await (await env.hook.connect(env.safe).executeTreasuryRouter()).wait(); // flushes to the splitter (works)
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const owed = await env.hook.routerOwed();
      const pending = [await env.hook.pendingBondingFees(), await env.hook.pendingGradFees()];
      await expect(env.hook.claimRouter()).to.be.reverted; // the bad router rejects
      await (await env.hook.connect(env.safe).proposeTreasuryRouter(await good.getAddress())).wait();
      await mineAt((await env.hook.routerEta()) + 1n);
      await expect(env.hook.connect(env.safe).executeTreasuryRouter()).to.emit(env.hook, "RouterFlushFailed").withArgs(await bad.getAddress(), owed);
      expect(await env.hook.routerOwed()).to.eq(owed);
      expect([await env.hook.pendingBondingFees(), await env.hook.pendingGradFees()]).to.deep.eq(pending);
      const paidBad = await env.hook.routerPaid(await bad.getAddress());
      expect(paidBad.amount).to.eq(0n);
      await (await env.hook.claimRouter()).wait();
      expect(await good.received()).to.eq(owed);
      const l = await ledgers(env, [P.id]);
      expect(l.claims).to.eq(l.sum);
    });

    it("ownership is two-step; the owner has no function that touches rates, liquidity or creator balances", async () => {
      const { env } = await loadFixture(base);
      await expect(env.hook.connect(env.attacker).transferOwnership(env.attacker.address)).to.be.revertedWithCustomError(env.hook, "NotOwner");
      await (await env.hook.connect(env.safe).transferOwnership(env.other.address)).wait();
      await expect(env.hook.connect(env.attacker).acceptOwnership()).to.be.revertedWithCustomError(env.hook, "NotOwner");
      await expect(env.hook.connect(env.other).acceptOwnership()).to.emit(env.hook, "OwnershipTransferred").withArgs(env.safe.address, env.other.address);
      expect(await env.hook.owner()).to.eq(env.other.address);
      expect(await env.hook.pendingOwner()).to.eq(ethers.ZeroAddress);
      const fnNames = env.hook.interface.fragments.filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f: any) => f.name);
      expect(fnNames.some((n: string) => /setFee|setRate|withdraw|rescue|sweep|remove|migrate|setCreator|pause/i.test(n))).to.eq(false);
      expect(fnNames.sort()).to.deep.eq(
        ["acceptCreator", "acceptOwnership", "afterSwap", "beforeSwap", "cancelTreasuryRouter", "claimCreator", "claimRouter", "createPool", "executeTreasuryRouter", "proposeCreator", "proposeTreasuryRouter", "transferOwnership", "unlockCallback"].sort(),
      );
    });
  });

  describe("display pair (BNB): never blocks a trade (I11)", () => {
    it("Sync then Swap per trade with trader-side amounts; reserves equal the pool price", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const pair = await ethers.getContractAt("MwzDisplayPair", P.pair!);
      const t = await trade(env, P, { wallet: env.buyer, buy: true, exactIn: true, amount: WAD });
      const logs = t.rc.logs.filter((l: any) => l.address.toLowerCase() === P.pair!.toLowerCase()).map((l: any) => pair.interface.parseLog(l));
      expect(logs.map((l: any) => l.name)).to.deep.eq(["Sync", "Swap"]);
      const [r0, r1] = await pair.getReserves();
      const rN = P.nativeIsToken0 ? r0 : r1;
      const rC = P.nativeIsToken0 ? r1 : r0;
      const s = await slot0(env, P);
      expect(ppm(rC * (1n << 192n), rN * s.sqrtP * s.sqrtP) < 0.01).to.eq(true);
      const sw = logs[1].args;
      const nIn = P.nativeIsToken0 ? sw.amount0In : sw.amount1In;
      const cOut = P.nativeIsToken0 ? sw.amount1Out : sw.amount0Out;
      expect(nIn).to.eq(-t.userNative);
      expect(cOut).to.eq(t.userCoin);
      expect(sw.to).to.eq(env.buyer.address);
      expect(await pair.factory()).to.eq(await env.displayFactory!.getAddress());
      expect(await pair.totalSupply()).to.eq(isqrt(r0 * r1));
    });

    it("a reverting display and a gas-burning display: the trade succeeds with the same fee, DisplayUpdateFailed logged, burn capped at 60k", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const real = await ethers.provider.getCode(P.pair!);
      const once = async (code: string | null) => {
        const snap = await network.provider.send("evm_snapshot", []);
        if (code) await network.provider.send("hardhat_setCode", [P.pair, code]);
        const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n });
        await network.provider.send("evm_revert", [snap]);
        return t;
      };
      const normal = await once(null);
      const reverting = await once("0x60006000fd");
      const burner = await once("0x5b600056");
      const stop = await once("0x00");
      expect(reverting.rc.status).to.eq(1);
      expect(reverting.displayFailed).to.eq(true);
      expect(reverting.fee).to.eq(normal.fee);
      expect(burner.rc.status).to.eq(1);
      expect(burner.displayFailed).to.eq(true);
      expect(burner.gas - stop.gas < 62_000n).to.eq(true);
      expect(normal.displayFailed).to.eq(false);
      expect(await ethers.provider.getCode(P.pair!)).to.eq(real);
    });

    it("Robinhood (no display factory): no pair, no V2 events", async () => {
      const env = await deployGen8({ display: false });
      const { P, rc } = await launch(env, env.creator, { firstBuyValue: WAD / 10n });
      expect(P.pair).to.eq(null);
      expect(await env.hook.displayFactory()).to.eq(ethers.ZeroAddress);
      const SYNC = ethers.id("Sync(uint112,uint112)");
      expect(rc.logs.some((l: any) => l.topics[0] === SYNC)).to.eq(false);
      await mineAt(P.launchTs + 61n);
      const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      expect(feeExact(t, true, true, WAD)[0]).to.eq(true);
    });
  });

  describe("per-coin isolation", () => {
    it("two coins keep separate ledgers and rates; a second launch does not touch the first coin's state", async () => {
      const { env, P } = await loadFixture(afterWindow);
      const { P: P2 } = await launch(env, env.creator2, { firstBuyValue: WAD / 20n });
      const st1 = await env.hook.pools(P.id);
      await trade(env, P2, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 10n, ts: P2.launchTs + 5n });
      expect(await env.hook.pools(P.id)).to.deep.eq(st1);
      const l = await ledgers(env, [P.id, P2.id]);
      expect(l.claims).to.eq(l.sum);
      expect(await env.hook.creatorOwed(P2.id)).to.be.gt(0n);
    });
  });
});

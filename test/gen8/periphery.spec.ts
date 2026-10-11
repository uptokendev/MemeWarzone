import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployGen8, launch, trade, mineAt, setNextTs, now, graduate, ledgers, slot0, nativeTargetA, revertOf, Env, Pool, DEAD, WNATIVE_LOCAL } from "./fixtures/gen8";
import { BPS, WAD, RESERVE } from "./fixtures/v4math";

async function impersonate(addr: string) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

async function keepCoin() {
  const env = await deployGen8();
  const { P } = await launch(env, env.creator, { firstBuyValue: WAD / 2n });
  await mineAt(P.launchTs + 61n);
  return { env, P };
}

async function choiceCoins() {
  const env = await deployGen8();
  const coins: Record<string, Pool> = {};
  for (const [name, choice, pct] of [["holders", 2, 0], ["split", 3, 40], ["buyback", 4, 0]] as [string, number, number][]) {
    const { P } = await launch(env, env.creator, { feeChoice: choice, feeCreatorPct: pct, firstBuyValue: WAD / 4n });
    coins[name] = P;
  }
  await mineAt((await now()) + 61n);
  return { env, coins };
}

describe("gen8 periphery", function () {
  describe("MwzReserveLock (D6 R2)", () => {
    it("lock is launcher-only; release waits for graduation, pays the current creator once", async () => {
      const { env, P } = await loadFixture(keepCoin);
      const lock = env.reserveLock;
      await expect(lock.connect(env.attacker).lock(P.id, P.token, 1n)).to.be.revertedWithCustomError(lock, "OnlyLauncher");
      const L = await impersonate(await env.launcher.getAddress());
      await expect(lock.connect(L).lock(P.id, P.token, 1n)).to.be.revertedWithCustomError(lock, "AlreadyLocked");
      await expect(lock.connect(L).lock(ethers.ZeroHash, ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(lock, "ZeroAddress");
      await expect(lock.connect(L).lock(ethers.ZeroHash, P.token, 0n)).to.be.revertedWithCustomError(lock, "BadAmount");
      await expect(lock.connect(L).lock(ethers.ZeroHash, P.token, RESERVE * 2n)).to.be.revertedWithCustomError(lock, "NotFunded");
      await expect(lock.release(P.id)).to.be.revertedWithCustomError(lock, "NotGraduated");
      await expect(lock.release(ethers.ZeroHash)).to.be.revertedWithCustomError(lock, "NothingLocked");
      // creator hands over the hook right before graduation: the reserve follows
      await (await env.hook.connect(env.creator).proposeCreator(P.id, env.creator2.address)).wait();
      await (await env.hook.connect(env.creator2).acceptCreator(P.id)).wait();
      await graduate(env, P, env.bot);
      const b = await P.coin.balanceOf(env.creator2.address);
      await expect(lock.connect(env.attacker).release(P.id)).to.emit(lock, "ReserveReleased").withArgs(P.id, P.token, env.creator2.address, RESERVE);
      expect((await P.coin.balanceOf(env.creator2.address)) - b).to.eq(RESERVE);
      expect(await P.coin.balanceOf(await lock.getAddress())).to.eq(0n);
      await expect(lock.release(P.id)).to.be.revertedWithCustomError(lock, "NothingLocked");
    });

    it("choice coins release to the human creator recorded in the vault (and follow its transfer)", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const P = coins.split;
      await (await env.vault.connect(env.creator).proposeCreator(P.id, env.creator2.address)).wait();
      await (await env.vault.connect(env.creator2).acceptCreator(P.id)).wait();
      await graduate(env, P, env.bot);
      await (await env.reserveLock.release(P.id)).wait();
      expect(await P.coin.balanceOf(env.creator2.address)).to.eq(RESERVE);
    });
  });

  describe("MwzCreatorEscrow (D5 E1)", () => {
    it("escrows a buy on the gen-7 schedule: 20% at 30 days, then 20% every 7 days; only the buyer claims", async () => {
      const { env, P } = await loadFixture(keepCoin);
      const e = env.escrow;
      const tx = await e.connect(env.creator).buy(P.token, 1n, { value: WAD });
      const rc = await tx.wait();
      const ev = rc!.logs.map((l: any) => { try { return e.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "EscrowBuy");
      const out = ev.args.coinsEscrowed as bigint;
      expect(ev.args.nativeSpent).to.eq(WAD);
      expect(await P.coin.balanceOf(await e.getAddress())).to.eq(out);
      expect(await e.escrowedTotal(P.token, env.creator.address)).to.eq(out);
      // the hook charged its fee like any trade (sender = escrow)
      const fee = rc!.logs.map((l: any) => { try { return env.hook.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "HookFee");
      expect(fee.args.swapSender).to.eq(await e.getAddress());
      expect(fee.args.feeBps).to.eq(200n);
      const t0 = BigInt((await ethers.provider.getBlock(rc!.blockNumber))!.timestamp);
      await expect(e.connect(env.creator).claim(P.token)).to.be.revertedWithCustomError(e, "NothingToClaim");
      await mineAt(t0 + 30n * 86400n - 1n);
      expect(await e.claimable(P.token, env.creator.address)).to.eq(0n);
      await mineAt(t0 + 30n * 86400n);
      expect(await e.claimable(P.token, env.creator.address)).to.eq(out / 5n);
      await expect(e.connect(env.attacker).claim(P.token)).to.be.revertedWithCustomError(e, "NothingToClaim");
      await (await e.connect(env.creator).claim(P.token)).wait();
      expect(await P.coin.balanceOf(env.creator.address) - P.firstBuyOut).to.eq(out / 5n);
      await mineAt(t0 + 58n * 86400n); // 30 + 4*7 = all five tranches
      await (await e.connect(env.creator).claim(P.token)).wait();
      expect(await e.claimed(P.token, env.creator.address)).to.eq(out);
      expect(await P.coin.balanceOf(await e.getAddress())).to.eq(0n);
    });

    it("rejects zero value, unknown coins and slippage; the callback is PoolManager-only inside buy", async () => {
      const { env, P } = await loadFixture(keepCoin);
      const e = env.escrow;
      await expect(e.buy(P.token, 0n)).to.be.revertedWithCustomError(e, "ZeroAmount");
      await expect(e.buy(env.other.address, 0n, { value: WAD })).to.be.revertedWithCustomError(e, "UnknownPool");
      await expect(e.buy(P.token, 10n ** 30n, { value: WAD })).to.be.revertedWithCustomError(e, "Slippage");
      await expect(e.unlockCallback("0x")).to.be.revertedWithCustomError(e, "UnexpectedCallback");
      const pm = await impersonate(await env.pm.getAddress());
      await expect(e.connect(pm).unlockCallback("0x")).to.be.revertedWithCustomError(e, "UnexpectedCallback");
    });
  });

  describe("MwzFeeSplitter (D1 A)", () => {
    async function withFees() {
      const b = await keepCoin();
      const { env, P } = b;
      for (let i = 0; i < 5; i++) await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 2n });
      await trade(env, P, { wallet: env.creator, buy: false, exactIn: true, amount: 1_000_000n * WAD });
      await graduate(env, P, env.bot);
      for (let i = 0; i < 3; i++) await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      return b;
    }

    it("claim, then route against the paid ledger: league exact 37.5% of bonding fees (30/70), band for recruiter+squad+airdrop, protocol the rest", async () => {
      const { env } = await loadFixture(withFees);
      const s = env.splitter;
      const owed = await env.hook.routerOwed();
      const B = await env.hook.pendingBondingFees();
      const G = await env.hook.pendingGradFees();
      const [weekly, monthly, rsaMin, rsaMax, squadMax] = await s.bands(B, G);
      expect(weekly + monthly).to.eq((B * 3750n) / BPS);
      expect(weekly).to.eq((((B * 3750n) / BPS) * 3000n) / BPS);
      expect(rsaMin).to.eq((B * 1500n) / BPS + (G * 1750n) / BPS);
      expect(rsaMax).to.eq((B * 1750n) / BPS + (G * 2000n) / BPS);
      // a standard_linked-shaped run: recruiter 1250/1500, squad 250/250
      const recruiter = (B * 1250n) / BPS + (G * 1500n) / BPS;
      const squad = (B * 250n) / BPS + (G * 250n) / BPS;
      const airdrop = rsaMin - recruiter - squad > 0n ? rsaMin - recruiter - squad : 0n;
      // route never claims: before the claim the paid ledger is 0, so a plan of 0 has nothing to route
      await expect(s.connect(env.operator).route(1, 0n, recruiter, squad, airdrop, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "NothingToRoute");
      await (await env.hook.claimRouter()).wait();
      const paid = (await env.hook.routerPaid(await s.getAddress())).amount;
      expect(paid).to.eq(owed);
      await expect(s.connect(env.attacker).route(1, paid, recruiter, squad, airdrop, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "NotOperator");
      await expect(s.connect(env.operator).route(2, paid, recruiter, squad, airdrop, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "BadRunId");
      await expect(s.connect(env.operator).route(1, paid - 1n, recruiter, squad, airdrop, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "PaidMismatch").withArgs(paid - 1n, paid);
      await expect(s.connect(env.operator).route(1, paid, rsaMin - 1n, 0n, 0n, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "OutOfBand");
      await expect(s.connect(env.operator).route(1, paid, rsaMax + 1n, 0n, 0n, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "OutOfBand");
      await expect(s.connect(env.operator).route(1, paid, rsaMin - squadMax - 1n, squadMax + 1n, 0n, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "OutOfBand");
      const root = ethers.id("accruals-run-1");
      const before = await Promise.all([env.weekly, env.monthly, env.recruiter, env.protocol].map((c: any) => c.received()));
      const tx = await s.connect(env.operator).route(1, paid, recruiter, squad, airdrop, root);
      const rc = await tx.wait();
      const ev = rc!.logs.map((l: any) => { try { return s.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Routed");
      const run = ev.args.run;
      expect(ev.args.accrualRoot).to.eq(root);
      expect(run.total).to.eq(owed);
      expect(run.bondingFees).to.eq(B);
      expect(run.gradFees).to.eq(G);
      const after = await Promise.all([env.weekly, env.monthly, env.recruiter, env.protocol].map((c: any) => c.received()));
      expect(after[0] - before[0]).to.eq(weekly);
      expect(after[1] - before[1]).to.eq(monthly);
      expect(after[2] - before[2]).to.eq(recruiter);
      expect(await env.community.squadPoolBalance()).to.eq(squad);
      expect(await env.community.warzoneAirdropBalance()).to.eq(airdrop);
      const protocol = owed - weekly - monthly - recruiter - squad - airdrop;
      expect(after[3] - before[3]).to.eq(protocol);
      expect(run.protocol).to.eq(protocol);
      // nothing left, nothing invented
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(0n);
      expect(await s.routedAmount()).to.eq((await env.hook.routerPaid(await s.getAddress())).amount);
      await expect(s.connect(env.operator).route(2, paid, 0n, 0n, 0n, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "NothingToRoute");
      // protocol share stays inside the doc's bound: <= 4190 bps of bonding fees + 8250 of graduation fees + post-grad router part
      const postRouter = owed - (B - (B * 560n) / BPS) - G; // approx (creator share floors per trade)
      expect(protocol <= (B * 4190n) / BPS + (G * 8250n) / BPS + postRouter + 10n).to.eq(true);
    });

    it("unlinked-shaped run (airdrop 15% / 17.5%), admin can route, operator rotation, receive only from the PoolManager", async () => {
      const { env } = await loadFixture(withFees);
      const s = env.splitter;
      await expect(env.attacker.sendTransaction({ to: await s.getAddress(), value: 1n })).to.be.reverted;
      await expect(s.connect(env.attacker).setOperator(env.attacker.address)).to.be.revertedWithCustomError(s, "NotAdmin");
      await expect(s.connect(env.safe).setOperator(env.other.address)).to.emit(s, "OperatorUpdated").withArgs(env.operator.address, env.other.address);
      await (await env.hook.claimRouter()).wait(); // anyone may claim first; route still sees the paid ledger
      const [B, G] = [(await s.pending())[1], (await s.pending())[2]];
      const [, , rsaMin] = await s.bands(B, G);
      const paid = (await env.hook.routerPaid(await s.getAddress())).amount;
      await expect(s.connect(env.operator).route(1, paid, 0n, 0n, rsaMin, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "NotOperator");
      await (await s.connect(env.safe).route(1, paid, 0n, 0n, rsaMin, ethers.ZeroHash)).wait();
      expect(await env.community.warzoneAirdropBalance()).to.eq(rsaMin);
      expect(await s.runs()).to.eq(1n);
    });

    it("a destination that refuses reverts the whole run; with the community vault re-pointed the operator routes the band to the recruiter vault", async () => {
      const { env } = await loadFixture(withFees);
      const s = env.splitter;
      await (await env.community.connect(env.safe).setRouter(env.other.address)).wait();
      await (await env.hook.claimRouter()).wait();
      const [, B, G] = await s.pending();
      const [, , rsaMin] = await s.bands(B, G);
      const bal = await ethers.provider.getBalance(await s.getAddress());
      const paid = (await env.hook.routerPaid(await s.getAddress())).amount;
      await expect(s.connect(env.operator).route(1, paid, 0n, 0n, rsaMin, ethers.ZeroHash)).to.be.reverted;
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(bal);
      await (await s.connect(env.operator).route(1, paid, rsaMin, 0n, 0n, ethers.ZeroHash)).wait();
      expect(await env.recruiter.received()).to.eq(rsaMin);
    });

    it("after a router change the old splitter routes what the A4 flush paid it: the flush counts as a claim (routerPaid per payee)", async () => {
      const { env, P } = await loadFixture(withFees);
      const s = env.splitter;
      const owed = await env.hook.routerOwed();
      const sink = await (await ethers.getContractFactory("NativeSink")).deploy();
      await (await env.hook.connect(env.safe).proposeTreasuryRouter(await sink.getAddress())).wait();
      await mineAt((await env.hook.routerEta()) + 1n);
      await (await env.hook.connect(env.safe).executeTreasuryRouter()).wait();
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD }); // accrues for the new router
      const [total, B, G] = await s.pending();
      expect(total).to.eq(owed);
      const paid = (await env.hook.routerPaid(await s.getAddress())).amount;
      expect(paid).to.eq(owed); // the flush recorded the bucket for the old router exactly like a claim
      const [, , rsaMin] = await s.bands(B, G);
      await (await s.connect(env.operator).route(1, paid, rsaMin, 0n, 0n, ethers.ZeroHash)).wait();
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(0n);
      expect(await env.hook.routerOwed()).to.be.gt(0n);
    });

    it("a post-graduation-only run must route nothing to the band and everything outside the league to protocol", async () => {
      const { env, P } = await loadFixture(withFees);
      const s = env.splitter;
      await (await env.hook.claimRouter()).wait();
      const p1 = await s.pending();
      const [, , m] = await s.bands(p1[1], p1[2]);
      await (await s.connect(env.operator).route(1, (await env.hook.routerPaid(await s.getAddress())).amount, m, 0n, 0n, ethers.ZeroHash)).wait();
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await env.hook.claimRouter()).wait();
      const paid2 = (await env.hook.routerPaid(await s.getAddress())).amount;
      await expect(s.connect(env.operator).route(2, paid2, 1n, 0n, 0n, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "OutOfBand");
      const pb = await env.protocol.received();
      await (await s.connect(env.operator).route(2, paid2, 0n, 0n, 0n, ethers.ZeroHash)).wait();
      expect((await env.protocol.received()) - pb).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(0n);
    });
  });

  describe("MwzFeeSplitter: runs pinned to the plan (expectedPaid)", () => {
    async function claimed() {
      const b = await keepCoin();
      const { env, P } = b;
      for (let i = 0; i < 4; i++) await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD / 2n + BigInt(i) });
      await (await env.hook.claimRouter()).wait();
      return b;
    }
    // the operator's plan: claim done, B / G / total read from the paid ledger, standard_linked-shaped split
    async function plan(env: any) {
      const s = env.splitter;
      const paid = (await env.hook.routerPaid(await s.getAddress())).amount;
      const [total, B, G] = await s.pending();
      const [, , rsaMin, , squadMax] = await s.bands(B, G);
      const squad = (B * 250n) / BPS + (G * 250n) / BPS;
      const recruiter = rsaMin - squad;
      return { paid, total, B, G, recruiter, squad: squad > squadMax ? squadMax : squad, airdrop: 0n };
    }

    it("a fee landing between the claim and the route stays in the hook and goes to the next run with its full shares", async () => {
      const { env, P } = await loadFixture(claimed);
      const s = env.splitter;
      const p = await plan(env);
      // a trade lands after the plan; nobody claims it
      const o0 = await env.hook.routerOwed();
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const late = (await env.hook.routerOwed()) - o0;
      const lateB = await env.hook.pendingBondingFees();
      expect(late).to.be.gt(0n);
      const pb = await env.protocol.received();
      const rc = await (await s.connect(env.operator).route(1, p.paid, p.recruiter, p.squad, p.airdrop, ethers.id("run-1"))).wait();
      const run = rc!.logs.map((l: any) => { try { return s.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Routed").args.run;
      expect(run.total).to.eq(p.total);
      expect(run.bondingFees).to.eq(p.B);
      expect(run.recruiter).to.eq(p.recruiter);
      expect((await env.protocol.received()) - pb).to.eq(p.total - run.weeklyLeague - run.monthlyLeague - p.recruiter - p.squad - p.airdrop); // nothing extra fell into protocol
      expect(await env.hook.routerOwed()).to.eq(late); // the late fee is still in the hook bucket
      // next run: claim, re-plan, full league + band on the late fee
      await (await env.hook.claimRouter()).wait();
      const q = await plan(env);
      expect(q.total).to.eq(late);
      expect(q.B).to.eq(lateB);
      const [w, m, rsaMin] = await s.bands(q.B, q.G);
      const rc2 = await (await s.connect(env.operator).route(2, q.paid, q.recruiter, q.squad, q.airdrop, ethers.id("run-2"))).wait();
      const run2 = rc2!.logs.map((l: any) => { try { return s.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Routed").args.run;
      expect(run2.weeklyLeague + run2.monthlyLeague).to.eq(w + m);
      expect(run2.recruiter + run2.squad + run2.airdrop).to.eq(rsaMin);
      expect(w + m).to.eq((lateB * 3750n) / BPS);
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(0n);
    });

    it("a third-party claim between the plan and the route makes the route revert PaidMismatch; the re-plan succeeds", async () => {
      const { env, P } = await loadFixture(claimed);
      const s = env.splitter;
      const p = await plan(env);
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await env.hook.connect(env.attacker).claimRouter()).wait(); // anyone may claim
      const actual = (await env.hook.routerPaid(await s.getAddress())).amount;
      expect(actual).to.be.gt(p.paid);
      await expect(s.connect(env.operator).route(1, p.paid, p.recruiter, p.squad, p.airdrop, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "PaidMismatch").withArgs(p.paid, actual);
      expect(await s.runs()).to.eq(0n);
      const q = await plan(env);
      expect(q.paid).to.eq(actual);
      await (await s.connect(env.operator).route(1, q.paid, q.recruiter, q.squad, q.airdrop, ethers.ZeroHash)).wait();
      expect(await s.runs()).to.eq(1n);
      expect(await s.routedAmount()).to.eq(actual);
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(0n);
    });

    it("the A4 router-change flush into the splitter counts as a claim: a plan made before it reverts, the re-plan routes the flushed bucket", async () => {
      const { env, P } = await loadFixture(claimed);
      const s = env.splitter;
      const p = await plan(env);
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      const owed = await env.hook.routerOwed();
      const sink = await (await ethers.getContractFactory("NativeSink")).deploy();
      await (await env.hook.connect(env.safe).proposeTreasuryRouter(await sink.getAddress())).wait();
      await mineAt((await env.hook.routerEta()) + 1n);
      await (await env.hook.connect(env.safe).executeTreasuryRouter()).wait(); // flushes `owed` to the splitter
      const actual = (await env.hook.routerPaid(await s.getAddress())).amount;
      expect(actual).to.eq(p.paid + owed);
      await expect(s.connect(env.operator).route(1, p.paid, p.recruiter, p.squad, p.airdrop, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "PaidMismatch");
      const q = await plan(env);
      await (await s.connect(env.operator).route(1, q.paid, q.recruiter, q.squad, q.airdrop, ethers.ZeroHash)).wait();
      expect(await ethers.provider.getBalance(await s.getAddress())).to.eq(0n);
      // later fees go to the new router; the old splitter has nothing more to route
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await expect(s.connect(env.operator).route(2, q.paid, 0n, 0n, 0n, ethers.ZeroHash)).to.be.revertedWithCustomError(s, "NothingToRoute");
    });
  });

  describe("MwzCreatorChoiceVault (D2)", () => {
    it("registration is launcher-only and validated", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const v = env.vault;
      await expect(v.connect(env.attacker).registerCoin(ethers.ZeroHash, env.other.address, env.creator.address, 2, 0)).to.be.revertedWithCustomError(v, "OnlyLauncher");
      const L = await impersonate(await env.launcher.getAddress());
      await expect(v.connect(L).registerCoin(coins.split.id, env.other.address, env.creator.address, 2, 0)).to.be.revertedWithCustomError(v, "AlreadySet");
      for (const [c, p] of [[1, 0], [5, 0], [3, 0], [3, 100], [2, 1]]) {
        await expect(v.connect(L).registerCoin(ethers.id("x"), env.other.address, env.creator.address, c, p)).to.be.revertedWithCustomError(v, "BadChoice");
      }
      await expect(v.connect(L).registerCoin(ethers.id("x"), ethers.ZeroAddress, env.creator.address, 2, 0)).to.be.revertedWithCustomError(v, "ZeroAddress");
      await expect(env.attacker.sendTransaction({ to: await v.getAddress(), value: 1n })).to.be.reverted;
    });

    it("pull credits by the fixed choice: holders 100%, split 40/60, buyback 100%; liabilities == balance", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const v = env.vault;
      for (const [name, P] of Object.entries(coins)) {
        await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
        const owed = await env.hook.creatorOwed(P.id);
        expect(owed).to.be.gt(0n);
        await expect(v.connect(env.attacker).pull(P.id)).to.emit(v, "Pulled");
        const [c, h, b] = [await v.creatorBalance(P.id), await v.holderBalance(P.id), await v.buybackBalance(P.id)];
        if (name === "holders") expect([c, h, b]).to.deep.eq([0n, owed, 0n]);
        if (name === "split") expect([c, h, b]).to.deep.eq([(owed * 40n) / 100n, owed - (owed * 40n) / 100n, 0n]);
        if (name === "buyback") expect([c, h, b]).to.deep.eq([0n, 0n, owed]);
      }
      expect(await v.totalLiabilities()).to.eq(await ethers.provider.getBalance(await v.getAddress()));
      await expect(v.pull(coins.split.id)).to.be.revertedWithCustomError(env.hook, "NothingOwed");
      await expect(v.pull(ethers.ZeroHash)).to.be.revertedWithCustomError(v, "WrongChoice");
    });

    it("split creator claims its part to any address; two-step human creator transfer", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const v = env.vault;
      const P = coins.split;
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await v.pull(P.id)).wait();
      const c = await v.creatorBalance(P.id);
      await expect(v.connect(env.attacker).claimCreatorFees(P.id, env.attacker.address)).to.be.revertedWithCustomError(v, "NotCreator");
      await expect(v.connect(env.creator).claimCreatorFees(P.id, ethers.ZeroAddress)).to.be.revertedWithCustomError(v, "ZeroAddress");
      const pb = await ethers.provider.getBalance(env.payee.address);
      await expect(v.connect(env.creator).claimCreatorFees(P.id, env.payee.address)).to.emit(v, "CreatorFeesClaimed").withArgs(P.id, env.creator.address, env.payee.address, c);
      expect((await ethers.provider.getBalance(env.payee.address)) - pb).to.eq(c);
      await expect(v.connect(env.creator).claimCreatorFees(P.id, env.payee.address)).to.be.revertedWithCustomError(v, "NothingToClaim");
      await expect(v.connect(env.attacker).proposeCreator(P.id, env.attacker.address)).to.be.revertedWithCustomError(v, "NotCreator");
      await (await v.connect(env.creator).proposeCreator(P.id, env.creator2.address)).wait();
      await expect(v.connect(env.attacker).acceptCreator(P.id)).to.be.revertedWithCustomError(v, "NotPendingCreator");
      await (await v.connect(env.creator2).acceptCreator(P.id)).wait();
      expect(await v.creatorOf(P.id)).to.eq(env.creator2.address);
      // holders / buyback coins never have a creator balance
      await expect(v.connect(env.creator).claimCreatorFees(coins.holders.id, env.creator.address)).to.be.revertedWithCustomError(v, "NothingToClaim");
    });

    it("holder batches: operator proposes within the weekly cap, admin approves the exact root and total, executes after the delay; veto restores", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const v = env.vault;
      for (const P of [coins.holders, coins.split]) {
        await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
        await (await v.pull(P.id)).wait();
      }
      const ids = [coins.holders.id, coins.split.id];
      const amts = [await v.holderBalance(ids[0]), await v.holderBalance(ids[1])];
      const total = amts[0] + amts[1];
      const root = ethers.id("root");
      await expect(v.connect(env.attacker).proposeHolderBatch(ethers.id("b1"), root, 0, ids, amts)).to.be.revertedWithCustomError(v, "OnlyOperator");
      await expect(v.connect(env.operator).proposeHolderBatch(ethers.id("b1"), root, 0, [coins.buyback.id], [1n])).to.be.revertedWithCustomError(v, "WrongChoice");
      await expect(v.connect(env.operator).proposeHolderBatch(ethers.id("b1"), root, 0, ids, [amts[0] + 1n, amts[1]])).to.be.revertedWithCustomError(v, "Insufficient");
      await expect(v.connect(env.operator).proposeHolderBatch(ethers.ZeroHash, root, 0, ids, amts)).to.be.revertedWithCustomError(v, "BadBatch");
      await (await v.connect(env.operator).proposeHolderBatch(ethers.id("b1"), root, 0, ids, amts)).wait();
      await expect(v.connect(env.operator).proposeHolderBatch(ethers.id("b1"), root, 0, ids, amts)).to.be.revertedWithCustomError(v, "AlreadySet");
      expect(await v.holderBalance(ids[0])).to.eq(0n);
      await expect(v.connect(env.operator).executeHolderBatch(ethers.id("b1"))).to.be.revertedWithCustomError(v, "NotApproved");
      await expect(v.connect(env.safe).approveHolderBatch(ethers.id("b1"), ethers.id("other"), total)).to.be.revertedWithCustomError(v, "BadBatch");
      await expect(v.connect(env.operator).approveHolderBatch(ethers.id("b1"), root, total)).to.be.revertedWithCustomError(v, "OnlyAdmin");
      await (await v.connect(env.safe).approveHolderBatch(ethers.id("b1"), root, total)).wait();
      await expect(v.connect(env.operator).executeHolderBatch(ethers.id("b1"))).to.be.revertedWithCustomError(v, "TooSoon");
      await mineAt((await now()) + 86400n);
      await (await v.connect(env.operator).executeHolderBatch(ethers.id("b1"))).wait();
      const b = await env.distributor.batches(ethers.id("b1"));
      expect([b.root, b.amount]).to.deep.eq([root, total]);
      expect(await v.totalLiabilities()).to.eq(await ethers.provider.getBalance(await v.getAddress()));
      await expect(v.connect(env.safe).vetoHolderBatch(ethers.id("b1"))).to.be.revertedWithCustomError(v, "BadBatch");
      // veto path
      await trade(env, coins.holders, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await v.pull(coins.holders.id)).wait();
      const a2 = await v.holderBalance(coins.holders.id);
      await (await v.connect(env.operator).proposeHolderBatch(ethers.id("b2"), root, 0, [coins.holders.id], [a2])).wait();
      await (await v.connect(env.safe).vetoHolderBatch(ethers.id("b2"))).wait();
      expect(await v.holderBalance(coins.holders.id)).to.eq(a2);
      // weekly cap
      await (await v.connect(env.safe).setCaps(10n * WAD, 100n * WAD, 0, 50, 1n)).wait();
      await expect(v.connect(env.operator).proposeHolderBatch(ethers.id("b3"), root, 0, [coins.holders.id], [a2])).to.be.revertedWithCustomError(v, "CapExceeded");
      // unclaimed re-credit: exact value, holders / split coins only
      await expect(v.connect(env.safe).creditUnclaimedHolders([coins.holders.id], [5n], { value: 4n })).to.be.revertedWithCustomError(v, "ValueMismatch");
      await expect(v.connect(env.safe).creditUnclaimedHolders([coins.buyback.id], [5n], { value: 5n })).to.be.revertedWithCustomError(v, "WrongChoice");
      await (await v.connect(env.safe).creditUnclaimedHolders([coins.holders.id], [5n], { value: 5n })).wait();
      expect(await v.holderBalance(coins.holders.id)).to.eq(a2 + 5n);
      expect(await v.totalLiabilities()).to.eq(await ethers.provider.getBalance(await v.getAddress()));
    });

    it("buyback: buyback coins only, outside the launch window, caps, at most 50 bps price impact, never past 95% of A before graduation; coins to 0xdEaD", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const v = env.vault;
      const P = coins.buyback;
      for (let i = 0; i < 4; i++) await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await v.pull(P.id)).wait();
      const bal = await v.buybackBalance(P.id);
      expect(bal).to.be.gt(0n);
      await expect(v.connect(env.attacker).buyback(P.id, 1n)).to.be.revertedWithCustomError(v, "OnlyOperator");
      await expect(v.connect(env.operator).buyback(coins.holders.id, 1n)).to.be.revertedWithCustomError(v, "WrongChoice");
      await expect(v.connect(env.operator).buyback(P.id, bal + 1n)).to.be.revertedWithCustomError(v, "Insufficient");
      await (await v.connect(env.safe).setCaps(bal / 4n, bal, 3600, 50, 1000n * WAD)).wait();
      await expect(v.connect(env.operator).buyback(P.id, bal / 2n)).to.be.revertedWithCustomError(v, "CapExceeded");
      const s0 = await slot0(env, P);
      const dead0 = await P.coin.balanceOf(DEAD);
      const amt = bal / 4n;
      const tx = await v.connect(env.operator).buyback(P.id, amt);
      const rc = await tx.wait();
      const ev = rc!.logs.map((l: any) => { try { return v.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Buyback");
      const s1 = await slot0(env, P);
      // native price up by at most 50 bps: (s0/s1)^2 <= 1.005
      expect(s0.sqrtP * s0.sqrtP * 10_000n <= s1.sqrtP * s1.sqrtP * 10_050n).to.eq(true);
      expect((await P.coin.balanceOf(DEAD)) - dead0).to.eq(ev.args.coinsBurned);
      expect(ev.args.nativeSpent <= amt).to.eq(true);
      expect(await v.buybackBalance(P.id)).to.eq(bal - ev.args.nativeSpent);
      await expect(v.connect(env.operator).buyback(P.id, 1000n)).to.be.revertedWithCustomError(v, "TooSoon");
      expect(await v.totalLiabilities()).to.eq(await ethers.provider.getBalance(await v.getAddress()));
      await (await v.connect(env.safe).setOperator(env.operator.address, true)).wait();
      await expect(v.connect(env.operator).buyback(P.id, 1000n)).to.be.revertedWithCustomError(v, "OnlyOperator");
      await expect(v.connect(env.safe).setCaps(1n, 1n, 0, 51, 1n)).to.be.revertedWithCustomError(v, "ImpactTooHigh");
      await expect(v.unlockCallback("0x")).to.be.revertedWithCustomError(v, "UnexpectedCallback");
    });

    it("buyback refuses inside the 60 s launch window and past 95% of A", async () => {
      const env = await deployGen8();
      const { P } = await launch(env, env.creator, { feeChoice: 4, firstBuyValue: WAD });
      const v = env.vault;
      await setNextTs(P.launchTs + 1n);
      await (await v.pull(P.id)).wait(); // first-buy creator share
      const bal = await v.buybackBalance(P.id);
      await setNextTs(P.launchTs + 2n);
      await (await v.connect(env.safe).setCaps(bal, bal, 0, 50, 0)).wait();
      await setNextTs(P.launchTs + 59n);
      await expect(v.connect(env.operator).buyback(P.id, bal)).to.be.revertedWithCustomError(v, "CurveState");
      await mineAt(P.launchTs + 61n);
      // take A to ~96%
      const pr = await env.lens.progress(P.id);
      const need = (pr.nativeTargetA * 96n) / 100n - pr.nativeInA;
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: (need * 10_200n) / 10_000n });
      const pr2 = await env.lens.progress(P.id);
      expect(pr2.graduated).to.eq(false);
      expect(pr2.nativeInA * 100n > pr2.nativeTargetA * 95n).to.eq(true);
      await expect(v.connect(env.operator).buyback(P.id, bal)).to.be.revertedWithCustomError(v, "CurveState");
    });

    it("rescue moves only native above every liability", async () => {
      const { env, coins } = await loadFixture(choiceCoins);
      const v = env.vault;
      await trade(env, coins.holders, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await v.pull(coins.holders.id)).wait();
      const addr = await v.getAddress();
      const bal = await ethers.provider.getBalance(addr);
      await network.provider.send("hardhat_setBalance", [addr, ethers.toQuantity(bal + 777n)]); // a forced send
      await expect(v.connect(env.attacker).rescueExcessNative(env.attacker.address, 1n)).to.be.revertedWithCustomError(v, "OnlyAdmin");
      await expect(v.connect(env.safe).rescueExcessNative(env.payee.address, 778n)).to.be.revertedWithCustomError(v, "Insufficient");
      await (await v.connect(env.safe).rescueExcessNative(env.payee.address, 777n)).wait();
      expect(await ethers.provider.getBalance(addr)).to.eq(await v.totalLiabilities());
    });
  });

  describe("MwzDisplayPairFactory + MwzDisplayPair (D10)", () => {
    it("setHook once by the deployer; pairs only by the hook; V2 PairCreated; getPair both ways; writes only by the hook", async () => {
      const { env, P } = await loadFixture(keepCoin);
      const f = env.displayFactory!;
      await expect(f.connect(env.deployer).setHook(env.attacker.address)).to.be.revertedWithCustomError(f, "HookAlreadySet");
      await expect(f.connect(env.attacker).setHook(env.attacker.address)).to.be.revertedWithCustomError(f, "NotDeployer");
      await expect(f.connect(env.attacker).createPair(env.attacker.address)).to.be.revertedWithCustomError(f, "NotHook");
      const H = await impersonate(await env.hook.getAddress());
      await expect(f.connect(H).createPair(P.token)).to.be.revertedWithCustomError(f, "PairExists");
      expect(await f.getPair(P.token, WNATIVE_LOCAL)).to.eq(P.pair);
      expect(await f.getPair(WNATIVE_LOCAL, P.token)).to.eq(P.pair);
      expect(await f.allPairsLength()).to.eq(1n);
      expect(await f.allPairs(0)).to.eq(P.pair);
      const pair = await ethers.getContractAt("MwzDisplayPair", P.pair!);
      expect(await pair.name()).to.eq("Uniswap V2");
      expect(await pair.symbol()).to.eq("UNI-V2");
      expect(await pair.decimals()).to.eq(18n);
      expect(await pair.factory()).to.eq(await f.getAddress());
      expect(await pair.hook()).to.eq(await env.hook.getAddress());
      const [t0, t1] = BigInt(P.token) < BigInt(WNATIVE_LOCAL) ? [P.token, WNATIVE_LOCAL] : [WNATIVE_LOCAL, P.token];
      expect([await pair.token0(), await pair.token1()]).to.deep.eq([t0, t1]);
      await expect(pair.connect(env.attacker).init(1n, 1n)).to.be.revertedWithCustomError(pair, "NotHook");
      await expect(pair.connect(env.attacker).update(env.attacker.address, env.attacker.address, 1n, 0n, 0n, 1n, 1n, 1n)).to.be.revertedWithCustomError(pair, "NotHook");
      expect(await ethers.provider.getBalance(P.pair!)).to.eq(0n);
      const fresh = await (await ethers.getContractFactory("MwzDisplayPairFactory")).deploy(WNATIVE_LOCAL);
      await expect(fresh.setHook(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
      await expect((await ethers.getContractFactory("MwzDisplayPairFactory")).deploy(ethers.ZeroAddress)).to.be.reverted;
    });

    it("reserves are clamped to uint112 for display", async () => {
      const { env, P } = await loadFixture(keepCoin);
      const H = await impersonate(await env.hook.getAddress());
      const pair = await ethers.getContractAt("MwzDisplayPair", P.pair!);
      await (await pair.connect(H).update(env.bot.address, env.bot.address, 1n, 0n, 0n, 1n, 2n ** 120n, 5n)).wait();
      const [r0, r1] = await pair.getReserves();
      const max = 2n ** 112n - 1n;
      expect(P.nativeIsToken0 ? r0 : r1).to.eq(max);
    });
  });

  it("I4 after periphery flows: hook claims == router + creator ledgers", async () => {
    const { env, coins } = await loadFixture(choiceCoins);
    const ids = Object.values(coins).map((p) => p.id);
    const l = await ledgers(env, ids);
    expect(l.claims).to.eq(l.sum);
    void revertOf;
  });
});

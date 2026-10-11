// Property / invariant tests for gen-8 (design 2.9, I1-I13; plus splitter and display bounds).
// Seeded random action sequences against the full local stack; every invariant is checked after every action.
// Seeds are fixed so a failure reproduces; set GEN8_FUZZ_SEEDS / GEN8_FUZZ_STEPS to run more.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
  deployGen8, launch, trade, feeExact, now, setNextTs, ledgers, slot0, revertOf, deployQuoter, quote, Env, Pool, coder, DEAD, TradeResult,
} from "./fixtures/gen8";
import { BPS, WAD, SUPPLY, RESERVE, MIN_USABLE_TICK, rateAt } from "./fixtures/v4math";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = (process.env.GEN8_FUZZ_SEEDS ?? "1,2,3,4,5,6,7,8,9,10").split(",").map(Number);
const STEPS = Number(process.env.GEN8_FUZZ_STEPS ?? 220);

/** liquidity of the hook's position (owner = hook, salt 0) read from PoolManager storage */
async function positionLiquidity(env: Env, P: Pool, lower: number, upper: number): Promise<bigint> {
  const stateSlot = BigInt(ethers.keccak256(coder.encode(["bytes32", "uint256"], [P.id, 6])));
  const posKey = ethers.solidityPackedKeccak256(["address", "int24", "int24", "bytes32"], [await env.hook.getAddress(), lower, upper, ethers.ZeroHash]);
  const slot = ethers.keccak256(coder.encode(["bytes32", "uint256"], [posKey, stateSlot + 6n]));
  return BigInt(await env.pm["extsload(bytes32)"](slot)) & ((1n << 128n) - 1n);
}

describe("gen8 invariants (seeded property runs)", function () {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${STEPS} random actions keep I1-I13, splitter and display bounds`, async function () {
      const R = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(R() * xs.length)];
      const big = (max: bigint) => (max * BigInt(Math.floor(R() * 1e9))) / 1_000_000_000n;
      const env = await deployGen8({ display: seed % 2 === 1 });
      const quoter = await deployQuoter(env);
      const keep = (await launch(env, env.creator, { feeChoice: 1, firstBuyValue: WAD / 3n })).P;
      const choice = (await launch(env, env.creator2, { feeChoice: 4, firstBuyValue: WAD / 5n })).P;
      const coins = [keep, choice];
      const ids = coins.map((c) => c.id);
      const feesAtLaunch = await Promise.all(ids.map(async (id) => (await env.hook.pools(id)).fees.map((x: bigint) => x)));
      const users = [env.buyer, env.bot, env.attacker, env.payee, env.other];
      const latched: Record<string, boolean> = {};
      let splitterRouted = 0n;
      let runs = 0n;
      const stats = { trades: 0, partial: 0, grads: 0, claims: 0, routes: 0, pulls: 0, escrow: 0, transfers: 0, skipped: 0 };

      const checkAll = async (label: string) => {
        // I4: ERC6909 native claims held by the hook == router bucket + creator ledgers
        const l = await ledgers(env, ids);
        expect(l.claims, `${label}: I4`).to.eq(l.sum);
        for (const P of coins) {
          // I5: the hook never holds coins
          expect(await P.coin.balanceOf(await env.hook.getAddress()), `${label}: I5`).to.eq(0n);
          // I13: supply conserved and fully accounted (no mint after construction)
          expect(await P.coin.totalSupply()).to.eq(SUPPLY);
          const st = await env.hook.pools(P.id);
          // I7: latch monotonic
          if (latched[P.id]) expect(st.graduated, `${label}: I7 latch reset`).to.eq(true);
          latched[P.id] = st.graduated;
          // I6: A and B only ever lose the one graduation removal
          const a = await positionLiquidity(env, P, P.tickGrad, P.tickStart);
          const b = await positionLiquidity(env, P, MIN_USABLE_TICK, P.tickGrad);
          expect(a, `${label}: I6 A`).to.eq(st.graduated ? P.liqA - (P.liqA * 200n) / BPS : P.liqA);
          expect(b, `${label}: I6 B`).to.eq(P.liqB);
          // I12: rates never change
          expect(st.fees.map((x: bigint) => x)).to.deep.eq(feesAtLaunch[coins.indexOf(P)]);
          // reserve stays locked until released
          const res = await env.reserveLock.reserves(P.id);
          expect(res.amount === RESERVE || res.amount === 0n).to.eq(true);
          if (res.amount === 0n) expect(st.graduated).to.eq(true);
        }
        // splitter: never holds more than what the hook paid it minus what it routed
        const paid = await env.hook.routerPaid(await env.splitter.getAddress());
        expect(paid.amount - splitterRouted, `${label}: splitter accounting`).to.eq(await ethers.provider.getBalance(await env.splitter.getAddress()));
        // choice vault: liabilities == balance
        expect(await env.vault.totalLiabilities()).to.eq(await ethers.provider.getBalance(await env.vault.getAddress()));
      };

      const checkTrade = async (P: Pool, t: TradeResult, buy: boolean, exactIn: boolean, amount: bigint, wasGrad: boolean, limited: boolean, label: string) => {
        const blockTs = BigInt((await ethers.provider.getBlock(t.rc.blockNumber))!.timestamp);
        const expectedRate = wasGrad ? 100n : rateAt(blockTs - P.launchTs);
        expect(t.rate, `${label}: I3 rate`).to.eq(expectedRate);
        if (!limited) {
          const [ok, d] = feeExact(t, buy, exactIn, amount);
          expect(ok, `${label}: I1 ${d}`).to.eq(true);
        } else {
          // I2: fee only on the filled part
          const fill = buy ? -t.raw0 : t.raw0;
          expect(t.fee, `${label}: I2`).to.eq((buy && exactIn) || (!buy && !exactIn) ? (fill * t.rate!) / BPS : t.fee);
        }
        // I8 / D2: creator share
        const exp = wasGrad ? (t.curve! * 50n) / BPS : (t.fee! * 560n) / BPS;
        expect(t.creatorShare, `${label}: I8`).to.eq(exp > t.fee! ? t.fee! : exp);
        expect(t.graduatedFlag).to.eq(wasGrad);
        // I11: our display never fails in normal operation
        expect(t.displayFailed).to.eq(false);
        // I7: the latch fires exactly when the price ends at or below the top of A, once
        const st = await env.hook.pools(P.id);
        if (!wasGrad) {
          const s = await slot0(env, P);
          expect(st.graduated, `${label}: I7 latch condition`).to.eq(s.sqrtP <= P.sqrtGrad);
          expect(t.graduated !== null).to.eq(st.graduated);
        } else {
          expect(t.graduated).to.eq(null);
        }
      };

      for (let step = 0; step < STEPS; step++) {
        const P = pick(coins);
        const roll = R();
        const label = `seed ${seed} step ${step}`;
        // time: mostly a few seconds, sometimes a jump
        const jump = R() < 0.1 ? BigInt(Math.floor(R() * 3 * 86400)) : BigInt(Math.floor(R() * 20));
        await setNextTs((await now()) + 1n + jump);
        const wasGrad = (await env.hook.pools(P.id)).graduated;
        const pr = await env.lens.progress(P.id);
        const left = pr.nativeTargetA > pr.nativeInA ? pr.nativeTargetA - pr.nativeInA : 0n;
        let action = "";
        try {
          if (roll < 0.25) {
            // exact-input buy; sometimes big enough to graduate
            const amount = R() < 0.15 ? left + WAD / 10n : big(left / 3n + WAD / 5n) + 1000n;
            const user = pick(users);
            action = `buy exactIn ${amount} grad=${wasGrad}`;
            const t = await trade(env, P, { wallet: user, buy: true, exactIn: true, amount });
            await checkTrade(P, t, true, true, amount, wasGrad, false, label);
            stats.trades++;
            if (t.graduated) stats.grads++;
          } else if (roll < 0.4) {
            // never ask for more coins than the pool holds (the PoolManager's own math overflows on such a request,
            // as for any V4 pool: SafeCastOverflow); cap at 90% of the coins left in the pool
            const poolCoins = await P.coin.balanceOf(await env.pm.getAddress());
            const cap = (poolCoins * 9n) / 10n;
            let amount = big(20_000_000n * WAD) + WAD;
            if (amount > cap) amount = cap;
            const user = pick(users);
            action = `buy exactOut ${amount} grad=${wasGrad} poolCoins ${poolCoins}`;
            const t = await trade(env, P, { wallet: user, buy: true, exactIn: false, amount, limit: 10_000n * WAD });
            await checkTrade(P, t, true, false, amount, wasGrad, false, label);
            stats.trades++;
            if (t.graduated) stats.grads++;
          } else if (roll < 0.55) {
            const user = pick(users);
            const bal = await P.coin.balanceOf(user.address);
            if (bal < WAD) { stats.skipped++; continue; }
            const amount = big(bal) + 1n;
            action = `sell exactIn ${amount} grad=${wasGrad}`;
            const t = await trade(env, P, { wallet: user, buy: false, exactIn: true, amount });
            await checkTrade(P, t, false, true, amount, wasGrad, false, label);
            stats.trades++;
          } else if (roll < 0.65) {
            const user = pick(users);
            const bal = await P.coin.balanceOf(user.address);
            if (bal < 1000n * WAD) { stats.skipped++; continue; }
            const q = await quote(quoter, P, false, true, bal / 2n);
            const amount = big(q / 2n) + 1n;
            action = `sell exactOut ${amount} grad=${wasGrad}`;
            const t = await trade(env, P, { wallet: user, buy: false, exactIn: false, amount, limit: 10n ** 30n });
            await checkTrade(P, t, false, false, amount, wasGrad, false, label);
            stats.trades++;
          } else if (roll < 0.72) {
            // price-limited swap: exact-in buy or exact-out sell with a limit 0.1%..3% away
            const s = await slot0(env, P);
            const bps = BigInt(10 + Math.floor(R() * 290));
            const buy = R() < 0.6;
            const user = buy ? env.bot : pick(users);
            if (!buy && (await P.coin.balanceOf(user.address)) < 10_000_000n * WAD) { stats.skipped++; continue; }
            const limit = buy ? s.sqrtP - (s.sqrtP * bps) / 10_000n : s.sqrtP + (s.sqrtP * bps) / 10_000n;
            const amount = buy ? 1000n * WAD : WAD * 1000n;
            const r = await env.lens.currentFeeBps(P.id, await env.trader.getAddress());
            const spec = buy ? -((amount * BPS) / (BPS + r)) : await env.lens.grossForNet(amount, r);
            action = `limited ${buy ? "buy" : "sell"} ${amount} limit ${limit} spec ${spec} grad=${wasGrad}`;
            const preview = await env.lens.previewFill(P.id, buy, spec, limit);
            const t = await trade(env, P, { wallet: user, buy, exactIn: buy, amount, limit: buy ? 0n : 10n ** 30n, sqrtLimit: limit });
            const fill = buy ? -t.raw0 : t.raw0;
            expect(fill, `${label}: I2 preview`).to.eq(preview);
            await checkTrade(P, t, buy, buy, amount, wasGrad, true, label);
            expect((await slot0(env, P)).sqrtP).to.eq(limit);
            stats.partial++;
            if (t.graduated) stats.grads++;
          } else if (roll < 0.78) {
            if ((await env.hook.routerOwed()) === 0n) {
              await expect(env.hook.connect(pick(users)).claimRouter()).to.be.revertedWithCustomError(env.hook, "NothingOwed");
              continue;
            }
            await (await env.hook.connect(pick(users)).claimRouter()).wait();
            stats.claims++;
          } else if (roll < 0.83) {
            if (P === keep) {
              const owed = await env.hook.creatorOwed(P.id);
              const cur = (await env.hook.pools(P.id)).creator;
              const signer = await ethers.getSigner(cur);
              if (owed > 0n) {
                const pb = await ethers.provider.getBalance(env.payee.address);
                await (await env.hook.connect(signer).claimCreator(P.id, env.payee.address)).wait();
                expect((await ethers.provider.getBalance(env.payee.address)) - pb).to.eq(owed);
                stats.claims++;
              }
            } else if ((await env.hook.creatorOwed(P.id)) > 0n) {
              await (await env.vault.connect(pick(users)).pull(P.id)).wait();
              stats.pulls++;
            }
          } else if (roll < 0.88) {
            // splitter run with a random split inside the band
            if ((await env.hook.treasuryRouter()) === (await env.splitter.getAddress()) && (await env.hook.routerOwed()) > 0n) await (await env.hook.claimRouter()).wait();
            const [total, B, G] = await env.splitter.pending();
            if (total === 0n) { stats.skipped++; continue; }
            const [weekly, monthly, rsaMin, rsaMax, squadMax] = await env.splitter.bands(B, G);
            const rsa = rsaMin + big(rsaMax - rsaMin);
            const squad = big(squadMax < rsa ? squadMax : rsa);
            const airdrop = big(rsa - squad);
            const recruiter = rsa - squad - airdrop;
            const before = await Promise.all([env.weekly, env.monthly, env.recruiter, env.protocol].map((c: any) => c.received()));
            const cb = [await env.community.warzoneAirdropBalance(), await env.community.squadPoolBalance()];
            runs++;
            await (await env.splitter.connect(env.operator).route(runs, recruiter, squad, airdrop, ethers.id(`run-${runs}`))).wait();
            const after = await Promise.all([env.weekly, env.monthly, env.recruiter, env.protocol].map((c: any) => c.received()));
            const ca = [await env.community.warzoneAirdropBalance(), await env.community.squadPoolBalance()];
            expect(after[0] - before[0]).to.eq(weekly);
            expect(after[1] - before[1]).to.eq(monthly);
            expect(weekly + monthly).to.eq((B * 3750n) / BPS);
            expect(after[2] - before[2]).to.eq(recruiter);
            expect(ca[0] - cb[0]).to.eq(airdrop);
            expect(ca[1] - cb[1]).to.eq(squad);
            const protocol = after[3] - before[3];
            expect(weekly + monthly + recruiter + airdrop + squad + protocol, `${label}: splitter sum == received`).to.eq(total);
            splitterRouted += total;
            stats.routes++;
          } else if (roll < 0.92) {
            const amount = big(WAD) + 10n ** 12n;
            await (await env.escrow.connect(P === keep ? env.creator : env.creator2).buy(P.token, 0n, { value: amount })).wait();
            stats.escrow++;
          } else if (roll < 0.94 && P === keep) {
            // creator transfer round trip
            const cur = (await env.hook.pools(P.id)).creator;
            const next = cur === env.creator.address ? env.creator2 : env.creator;
            await (await env.hook.connect(await ethers.getSigner(cur)).proposeCreator(P.id, next.address)).wait();
            await (await env.hook.connect(next).acceptCreator(P.id)).wait();
            stats.transfers++;
          } else {
            // release the reserve when graduated (permissionless)
            const res = await env.reserveLock.reserves(P.id);
            if (res.amount > 0n && (await env.hook.pools(P.id)).graduated) await (await env.reserveLock.connect(pick(users)).release(P.id)).wait();
          }
        } catch (e: any) {
          const why = await revertOf(async () => { throw e; }, env);
          // the only legitimate failures in this generator: a wallet without enough coins or native for a random size
          if (why && /ERC20InsufficientBalance|insufficient funds|doesn't have enough funds/i.test(why)) { stats.skipped++; continue; }
          throw new Error(`${label}: unexpected revert: ${why} (action: ${action || "other"})`);
        }
        await checkAll(label);
      }
      console.log(`      seed ${seed}: ${JSON.stringify(stats)}`);
      expect(stats.trades + stats.partial).to.be.gt(STEPS / 3);
      void DEAD;
      void network;
    });
  }

  it("fee math fuzz: grossForNet is the smallest gross for every net and rate (exact-output sells), rate schedule matches gen-7", async () => {
    const env = await deployGen8({ display: false });
    const R = rng(99);
    for (let i = 0; i < 400; i++) {
      const r = BigInt(Math.floor(R() * 9001));
      const net = BigInt(Math.floor(R() * 1e12)) * BigInt(Math.floor(R() * 1e12)) + 1n;
      const g = await env.lens.grossForNet(net, r);
      expect(g - (g * r) / BPS).to.eq(net);
      expect(g - 1n - ((g - 1n) * r) / BPS < net).to.eq(true);
    }
    for (let dt = 0n; dt <= 61n; dt++) {
      const left = dt >= 60n ? 0n : 60n - dt;
      expect(rateAt(dt)).to.eq(200n + (8800n * left) / 60n);
    }
  });
});

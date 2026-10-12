// EVM generation 8, fix round 2026-10-12 (founder go after the AI audit, docs/build_plans/GEN8_AI_AUDIT_FINDINGS.md):
// the fork-suite area "fixes". Same rules as the rest of the suite: local anvil forks of BSC 56 / Robinhood 4663 only,
// fresh deterministic keys, production bytecode from artifacts-gen8, no real transaction.
//
// It replays the audit proofs of concept against the fixed contracts on the canonical PoolManager and every
// UniversalRouter version of the chain:
//   F1  A-1 / D-H1 forced graduation in ONE unlock (flash accounting), with a reserve release attempted between the
//       legs; the same as two transactions in one block; the residual three-transaction bundle that releases the
//       reserve; trades back in A pay the bonding rate through every router
//   F2  A-3 zero-coin sell at the start price, direct and through every UR, refused; the limit at the start price works
//   F3  A-2 owner contract changing the router from inside an unlock: the old router's bucket is parked and paid to it
//   F4  covered in base (third-party claimRouter) and step-2 split (plan / route)
//   F6  the fork's oracle price lies inside the new band; the launcher carries the band
//   B   scheduled open: the creator first buy inside launch(), every other path refused before openAt (direct, every
//       UR, escrow), the launch rate from openAt and the decay, events carry openAt
import { ethers } from "ethers";
import { WAD, BPS, fmt, revertOf, decodeRevert } from "./lib.mjs";

const coder = ethers.AbiCoder.defaultAbiCoder();

async function now(env) {
  return BigInt((await env.provider.getBlock("latest")).timestamp);
}
async function warpTo(env, ts) {
  const cur = await now(env);
  await env.provider.send("evm_setNextBlockTimestamp", [Number(ts > cur ? ts : cur + 1n)]);
  await env.provider.send("evm_mine", []);
}
function nativeTargetA(P) {
  return ((P.liqA << 96n) * (P.sqrtStart - P.sqrtGrad)) / P.sqrtStart / P.sqrtGrad;
}
function hookEvents(env, rc) {
  const out = [];
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== env.hook.target.toLowerCase()) continue;
    try {
      out.push(env.hook.interface.parseLog(l));
    } catch {}
  }
  return out;
}

export async function areaFixes(env, H, S, out) {
  const { check, note } = H;
  const N = (out.nums.fixes = {});
  const px = Number(fmt(env.nativeUsd, 2));
  const usd = (w) => "$" + (Number(fmt(w, 9)) * px).toFixed(2);
  const deploy = async (name, args = []) => {
    const art = env.C[name];
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, env.W.deployer).deploy(...args);
    await c.waitForDeployment();
    return new ethers.Contract(await c.getAddress(), art.abi, env.provider);
  };
  const G = await deploy("ForceGraduator", [env.pm.target]);
  const ifaces = [...env.ifaces, G.interface];

  // ---- F6: the band
  {
    const lo = await env.launcher.minNativeUsd();
    const hi = await env.launcher.maxNativeUsd();
    const want = env.name === "bsc" ? [10n * WAD, 100_000n * WAD] : [50n * WAD, 500_000n * WAD];
    check(`[F6] launcher band ${env.name === "bsc" ? "BNB $10 .. $100,000" : "ETH $50 .. $500,000"}, the fork's oracle price inside it`, lo === want[0] && hi === want[1] && env.nativeUsd >= lo && env.nativeUsd <= hi, `band ${fmt(lo, 0)}..${fmt(hi, 0)}, oracle $${fmt(env.nativeUsd, 2)}`);
  }

  // ---- F1: one-transaction forced graduation with a release attempt in the middle
  N.forced = [];
  for (const sc of [{ label: "fresh coin, no first buy", pre: 0n }, { label: "$1,000 of buyers before", pre: ethers.parseEther(String(1000 / px)) }]) {
    const snap = await H.snapshot(env);
    const { P } = await H.launchCoin(env, env.W.creator, S.target, 0n, H.consts.FEES, "F1 coin");
    await warpTo(env, P.launchTs + 61n);
    if (sc.pre > 0n) await H.trade(env, P, { via: "direct", wallet: env.W.buyer, buy: true, exactIn: true, amount: sc.pre, limit: 0n });
    const R = nativeTargetA(P);
    const nB = await env.provider.getBalance(env.A.attacker);
    const rc = await (await G.connect(env.W.attacker).run(P.key, R * 2n, P.sqrtGrad, P.sqrtStart, env.reserveLock.target, P.id, { value: R / 5n, gasLimit: 8_000_000n })).wait();
    const cost = nB - (await env.provider.getBalance(env.A.attacker)) - rc.gasUsed * (rc.gasPrice ?? 0n);
    const ev = hookEvents(env, rc);
    const fees = ev.filter((e) => e.name === "HookFee").map((e) => [e.args.buy, e.args.graduated, e.args.feeBps]);
    const gradFee = ev.find((e) => e.name === "Graduated")?.args.gradFeeNative ?? 0n;
    const relErr = await G.lastReleaseError();
    const relWhy = relErr && relErr !== "0x" ? decodeRevert(relErr, ifaces) : "none";
    const sel = env.reserveLock.interface.getError("PoolManagerUnlocked").selector;
    const st = await env.hook.pools(P.id);
    const s = await H.slot0(env, P);
    check(`[F1] A-1 one unlock (${sc.label}): latch fires, but the release attempted between the legs is refused (PoolManagerUnlocked)`, st.graduated && !(await G.lastReleaseOk()) && relErr.slice(0, 10) === sel, `release error ${relWhy}`);
    check(`[F1] A-1 (${sc.label}): buy leg bonding 2%, sell leg starts at the graduation price so it pays 1%; the price ends back inside A`, fees.map((f) => f.join(":")).join(",") === "true:false:200,false:true:100" && s.sqrtP > P.sqrtGrad, JSON.stringify(fees.map((f) => f.map(String))));
    const rateNow = await env.lens.currentFeeBps(P.id, env.A.buyer);
    const rel = await revertOf(() => env.reserveLock.connect(env.W.attacker).release.staticCall(P.id), ifaces);
    check(`[F1] A-1 (${sc.label}): afterwards everyone pays the bonding rate again and the reserve stays locked (PriceBelowGraduation)`, rateNow === 200n && rel?.includes("PriceBelowGraduation") && (await env.reserveLock.reserves(P.id)).amount === 20_000_000n * WAD, `rate ${rateNow}; release ${rel}`);
    // later trades through every router: bonding rate, bonding split
    let allOk = true;
    const detail = [];
    for (const [via, urName] of S.vias) {
      const ob = await H.owedAll(env, P);
      const pb = await env.hook.pendingBondingFees();
      const t = await H.trade(env, P, { via, urName, wallet: env.W.buyer, buy: true, exactIn: true, amount: ethers.parseEther(String(100 / px)), limit: 0n });
      const oa = await H.owedAll(env, P);
      const ok = t.rate === 200n && t.creatorShare === (t.fee * 560n) / BPS && oa.router - ob.router === t.fee - t.creatorShare && (await env.hook.pendingBondingFees()) - pb === t.fee && t.graduated === null;
      allOk &&= ok;
      detail.push(`${via === "ur" ? urName : "direct"} ${t.rate}bps`);
    }
    check(`[F1] A-1 (${sc.label}): a later $100 buy through every router pays 2% with the bonding split, booked as bonding fees`, allOk, detail.join(", "));
    N.forced.push({ scenario: sc.label, netCost: cost.toString(), netCostUsd: usd(cost), gradFee: gradFee.toString(), gas: Number(rc.gasUsed), R: R.toString() });
    note(`[F1] ${env.name} $${S.target / WAD / 1000n}K ${sc.label}: forced graduation now costs ${fmt(cost, 6)} native (${usd(cost)}) incl. graduation fee ${fmt(gradFee, 6)}; gain on fees: none; reserve: locked`);
    await H.revert(env, snap);
  }

  // ---- F1: the same as two transactions in one block, then the residual three-transaction bundle with a release
  {
    const snap = await H.snapshot(env);
    const { P } = await H.launchCoin(env, env.W.creator, S.target, 0n, H.consts.FEES, "F1 bundle coin");
    await warpTo(env, P.launchTs + 61n);
    await (await P.coin.connect(env.W.attacker).approve(env.trader.target, ethers.MaxUint256)).wait();
    const R = nativeTargetA(P);
    const coins = (P.mintedA * 9990n) / 10_000n;
    for (const withRelease of [false, true]) {
      const s2 = await H.snapshot(env);
      const nB = await env.provider.getBalance(env.A.attacker);
      await env.provider.send("evm_setAutomine", [false]);
      const txs = [];
      txs.push(await env.trader.connect(env.W.attacker).swap(P.key, true, -(R * 2n), P.sqrtGrad, "0x", { value: R * 2n, gasLimit: 3_000_000n }));
      if (withRelease) txs.push(await env.reserveLock.connect(env.W.attacker).release(P.id, { gasLimit: 500_000n }));
      txs.push(await env.trader.connect(env.W.attacker).swap(P.key, false, -coins, P.sqrtStart, "0x", { gasLimit: 3_000_000n }));
      await env.provider.send("evm_mine", []);
      await env.provider.send("evm_setAutomine", [true]);
      const rcs = await Promise.all(txs.map((t) => env.provider.getTransactionReceipt(t.hash)));
      const gas = rcs.reduce((a, r) => a + r.gasUsed * (r.gasPrice ?? 0n), 0n);
      const cost = nB - (await env.provider.getBalance(env.A.attacker)) - gas;
      const sameBlock = rcs.every((r) => r.blockNumber === rcs[0].blockNumber && r.status === 1);
      const st = await env.hook.pools(P.id);
      const rateNow = await env.lens.currentFeeBps(P.id, env.A.buyer);
      const reserve = (await env.reserveLock.reserves(P.id)).amount;
      if (!withRelease) {
        check(`[F1] D-H1 two transactions in one block: latch fires, fee back to 2% for everyone, reserve locked`, sameBlock && st.graduated && rateNow === 200n && reserve === 20_000_000n * WAD, `net cost ${fmt(cost, 6)} (${usd(cost)}), capital ${fmt(R, 4)} for one block`);
        N.bundle2 = { netCost: cost.toString(), netCostUsd: usd(cost), capital: R.toString() };
      } else {
        check(`[F1] residual (measured, not a fix failure): a three-transaction bundle (buy to graduation, release, sell back) releases the reserve early; the fee still returns to 2%`, sameBlock && st.graduated && rateNow === 200n && reserve === 0n, `net cost ${fmt(cost, 6)} (${usd(cost)}), capital ${fmt(R, 4)} (${usd(R)}) for one block; benefit: the creator gets 20M coins before a real graduation`);
        N.bundle3 = { netCost: cost.toString(), netCostUsd: usd(cost), capital: R.toString(), capitalUsd: usd(R) };
      }
      env.W.attacker.reset();
      await H.revert(env, s2);
    }
    await H.revert(env, snap);
  }

  // ---- F2: A-3 zero-coin sell at the start price, direct and through every UR
  {
    const snap = await H.snapshot(env);
    const { P } = await H.launchCoin(env, env.W.creator, S.target, 0n, H.consts.FEES, "F2 coin");
    await warpTo(env, P.launchTs + 61n);
    await (await P.coin.connect(env.W.attacker).approve(env.trader.target, ethers.MaxUint256)).wait();
    const why = await revertOf(() => env.trader.connect(env.W.attacker).swap.staticCall(P.key, false, -1n, 0n, "0x", { gasLimit: 15_000_000n }), ifaces);
    check("[F2] A-3: a 1-wei sell with no limit at the start price (zero liquidity above) reverts PriceAboveStart", why?.includes("PriceAboveStart"), why);
    // through every UR: after graduation A keeps 98% of its liquidity and the reserve is out, so the coins in
    // circulation exceed what A can take back; a full sell with no limit (UR V4 swaps carry none) must revert
    await H.trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: S.R * 2n, limit: 0n });
    check("[F2] setup: the coin graduated", (await env.hook.pools(P.id)).graduated);
    await (await env.reserveLock.connect(env.W.attacker).release(P.id)).wait();
    await (await P.coin.connect(env.W.creator).transfer(env.A.bot, await P.coin.balanceOf(env.A.creator))).wait();
    const bal = await P.coin.balanceOf(env.A.bot);
    const urRes = [];
    for (const [via, urName] of S.vias.filter(([v]) => v === "ur")) {
      let r;
      try {
        await H.trade(env, P, { via, urName, wallet: env.W.bot, buy: false, exactIn: true, amount: bal, limit: 0n });
        r = "went through";
      } catch (e) {
        r = e.tradeRevert ?? String(e.message).slice(0, 160);
      }
      urRes.push(`${urName}: ${r}`);
    }
    check("[F2] through every UniversalRouter a sell that would overshoot the start price reverts PriceAboveStart", urRes.length > 0 && urRes.every((x) => x.includes("PriceAboveStart")), urRes.join(" | "));
    const tl = await H.trade(env, P, { via: "direct", wallet: env.W.bot, buy: false, exactIn: true, amount: bal, limit: 0n, sqrtLimit: P.sqrtStart });
    const sEnd = await H.slot0(env, P);
    check("[F2] the same full sell with the limit at the start price fills to exactly the start price; the rest stays with the seller", sEnd.sqrtP === P.sqrtStart && -tl.userCoin < bal && tl.rate === 100n, `sold ${fmt(-tl.userCoin, 0)} of ${fmt(bal, 0)} coins`);
    const s = await H.slot0(env, P);
    check("[F2] the price never left the range: still at or below the start price", s.sqrtP <= P.sqrtStart);
    await H.revert(env, snap);
  }

  // ---- F3: A-2 owner contract executes the router change from inside an unlock
  {
    const snap = await H.snapshot(env);
    const O = await deploy("UnlockingOwner", [env.pm.target, env.hook.target]);
    const { P } = await H.launchCoin(env, env.W.creator, S.target, 0n, H.consts.FEES, "F3 coin");
    await warpTo(env, P.launchTs + 61n);
    await H.trade(env, P, { via: "direct", wallet: env.W.buyer, buy: true, exactIn: true, amount: S.R / 20n, limit: 0n });
    await (await env.hook.connect(env.W.safe).transferOwnership(O.target)).wait();
    await (await O.connect(env.W.deployer).accept()).wait();
    await (await O.connect(env.W.deployer).propose(env.A.treasury2)).wait();
    await warpTo(env, (await env.hook.routerEta()) + 1n);
    const owed = await env.hook.routerOwed();
    const paid0 = (await env.hook.routerPaid(env.splitter.target)).amount;
    await (await O.connect(env.W.deployer).executeInsideUnlock({ gasLimit: 2_000_000n })).wait();
    const parked = (await env.hook.routerParked(env.splitter.target)).amount;
    const t2b = await env.provider.getBalance(env.A.treasury2);
    await (await env.hook.connect(env.W.attacker).payParkedRouter(env.splitter.target)).wait();
    const paid1 = (await env.hook.routerPaid(env.splitter.target)).amount;
    check("[F3] A-2: a router change executed from inside an unlock parks the whole bucket for the OLD router; anyone pays it there; the new router gets none of it", owed > 0n && parked === owed && paid1 - paid0 === owed && (await env.provider.getBalance(env.A.treasury2)) === t2b && (await env.hook.treasuryRouter()) === env.A.treasury2, `${fmt(owed, 9)} parked and paid to the old splitter`);
    await H.revert(env, snap);
  }

  // ---- B: scheduled open
  {
    const snap = await H.snapshot(env);
    const openAt = (await now(env)) + 86_400n;
    const firstBuy = S.R / 20n;
    const { P, rcL, ev } = await H.launchCoin(env, env.W.creator, S.target, firstBuy, H.consts.FEES, "B scheduled coin", 1, 0, openAt);
    const evs = hookEvents(env, rcL);
    const pl = evs.find((e) => e.name === "PoolLaunched");
    const hf = evs.find((e) => e.name === "HookFee");
    check("[B] launch with openAt = now + 1 day: Launched and PoolLaunched carry openAt; the creator first buy ran inside launch() at the 2% bonding rate", ev.args.openAt === openAt && pl.args.openAt === openAt && ev.args.firstBuyOut > 0n && hf?.args.feeBps === 200n && P.launchTs === openAt, `firstBuyOut ${fmt(ev.args.firstBuyOut, 0)} coins`);
    const res = [];
    const d = await revertOf(() => env.trader.connect(env.W.bot).swap.staticCall(P.key, true, -WAD / 100n, 0n, "0x", { value: WAD / 100n }), ifaces);
    res.push(`direct buy: ${d}`);
    await (await P.coin.connect(env.W.creator).approve(env.trader.target, ethers.MaxUint256)).wait();
    const ds = await revertOf(() => env.trader.connect(env.W.creator).swap.staticCall(P.key, false, -(1000n * WAD), 0n, "0x"), ifaces);
    res.push(`creator sell: ${ds}`);
    for (const [via, urName] of S.vias.filter(([v]) => v === "ur")) {
      let r;
      try {
        await H.trade(env, P, { via, urName, wallet: env.W.bot, buy: true, exactIn: true, amount: WAD / 100n, limit: 0n });
        r = "went through";
      } catch (e) {
        r = e.tradeRevert ?? String(e.message).slice(0, 120);
      }
      res.push(`${urName} buy: ${r}`);
    }
    const es = await revertOf(() => env.escrow.connect(env.W.creator).buy.staticCall(P.token, 0n, { value: WAD / 100n }), ifaces);
    res.push(`escrow buy: ${es}`);
    check("[B] before openAt every path is refused with TradingNotOpen: direct buy, the creator's sell, every UR, the escrow", res.every((x) => x.includes("TradingNotOpen")), res.join(" | "));
    const [open] = await env.lens.tradingOpen(P.id);
    check("[B] lens.tradingOpen reports closed before openAt", open === false);
    const rates = [];
    for (const dt of [0n, 30n, 60n]) {
      const t = await H.trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: WAD / 1000n, limit: 0n, ts: openAt + dt });
      rates.push(t.rate);
    }
    check("[B] trading opens at openAt with the launch rate 90%, decaying to 2% over 60 s from openAt", rates[0] === 9000n && rates[1] === 200n + (8800n * 30n) / 60n && rates[2] === 200n, rates.map(String).join(" / "));
    N.scheduled = { openAt: openAt.toString(), launchGas: Number(rcL.gasUsed), rates: rates.map(String) };
    await H.revert(env, snap);
  }
}

// Barkswap admin powers over our pools on a Chikyu fork (impersonated Barkswap admin, the factory owner): setPlugin,
// setPluginConfig, setFee, setCommunityFee and setTickSpacing on a launched pool. For each: A/B principal stays where it
// was (only the one graduation burn ever removes liquidity), the launcher's books stay equal to its balances and exact
// (creators first, unbooked fees in router post), the change is visible on chain, and `restore` re-applies only our
// plugin, lastFee 0 and config 135 (never the tick spacing or the community fee). Plus side-pool creation for our coin,
// detectable from the factory's Pool / CustomPool events (B3).
// Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md §3 (Invariants: Barkswap-specific cases, Accepted
// testnet risks), B3; audit: docs/dogeos/barkswap-audit.md (MwzBarkLauncher "Barkswap admin powers", Gate 0 t9 items:
// setTickSpacing then collect and the graduation burn; Algebra zero-amount burn as fee poke). Plan task t9.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkAdmin.fork.spec.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BARKSWAP,
  WAD,
  amount1Delta,
  approveRouter,
  barkStackFixture,
  barkSwapOf,
  eventsOf,
  impersonate,
  launchCoin,
  poolState,
  positionKey,
  positionLiquidity,
  printGasTable,
  raiseOfA,
  recordGas,
  routerBuy,
  routerSell,
  setNativeBalance,
  type BarkStack,
  type C,
  type LaunchResult,
} from "./fixtures/barkswap";
import { MEASURED_TOLERANCE_WEI, absb, collectChecked, expectBooksEqualBalances, sum } from "./fixtures/barkBooks";
import { compileInline } from "./fixtures/rootVaults";

const TICK_MAX = 887_270;
const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
/** A/B principal: A holds liqA (minus the one graduation burn once taken), B holds liqB. */
async function expectPrincipal(s: BarkStack, L: LaunchResult, label: string): Promise<void> {
  const launcher = await s.launcher.getAddress();
  const burned = (await s.launcher.launches(L.coin)).gradFeeTaken ? (L.liqA * 200n) / 10_000n : 0n;
  expect(await positionLiquidity(L.pool, launcher, L.tickStart, L.tickGrad), `${label}: A`).to.equal(L.liqA - burned);
  expect(await positionLiquidity(L.pool, launcher, L.tickGrad, TICK_MAX), `${label}: B`).to.equal(L.liqB);
}

// ------------------------------------------------------------------------------------------------- inline test actor

let SIDE_DEPLOYER: { abi: any[]; bytecode: string } | undefined;

/** An outside custom-pool deployer (any contract may create custom pools through Barkswap's entry point with itself as
 *  the deployer): creates a coin / token custom pool with no plugin. Test actor for side-pool detection; compiled with
 *  the Bark build's solc (0.8.26, cancun). */
async function sideDeployerArtifact(): Promise<{ abi: any[]; bytecode: string }> {
  if (SIDE_DEPLOYER) return SIDE_DEPLOYER;
  const source = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface IEntryPoint {
    function createCustomPool(address deployer, address creator, address tokenA, address tokenB, bytes calldata data) external returns (address);
}
contract BarkSideDeployer {
    function create(address entryPoint, address tokenA, address tokenB) external returns (address) {
        return IEntryPoint(entryPoint).createCustomPool(address(this), msg.sender, tokenA, tokenB, "");
    }
    function beforeCreatePoolHook(address, address, address, address, address, bytes calldata) external pure returns (address) {
        return address(0);
    }
    function afterCreatePoolHook(address, address, address) external pure {}
}
`;
  SIDE_DEPLOYER = await compileInline("BarkSideDeployer", source);
  return SIDE_DEPLOYER;
}

/** The side-pool watch (spec §4 admin-change / side-pool watch, B3): every factory Pool or CustomPool event since
 *  `fromBlock` with `coin` as token0 or token1, except our own custom pool (deployer == the launcher). */
async function sidePoolsOf(coin: string, launcher: string, fromBlock: number): Promise<Array<{ kind: string; pool: string; other: string; deployer?: string }>> {
  const factory = await ethers.getContractAt("IAlgebraFactory", BARKSWAP.factory);
  const topicCoin = ethers.zeroPadValue(coin, 32);
  const poolTopic = factory.interface.getEvent("Pool")!.topicHash;
  const customTopic = factory.interface.getEvent("CustomPool")!.topicHash;
  const queries = [
    [poolTopic, topicCoin],
    [poolTopic, null, topicCoin],
    [customTopic, null, topicCoin],
    [customTopic, null, null, topicCoin],
  ];
  const seen = new Map<string, { kind: string; pool: string; other: string; deployer?: string }>();
  for (const topics of queries) {
    const logs = await ethers.provider.getLogs({ address: BARKSWAP.factory, fromBlock, toBlock: "latest", topics });
    for (const log of logs) {
      const ev = factory.interface.parseLog(log)!;
      const t0 = String(ev.args.token0);
      const other = t0.toLowerCase() === coin.toLowerCase() ? String(ev.args.token1) : t0;
      if (ev.name === "CustomPool" && String(ev.args.deployer).toLowerCase() === launcher.toLowerCase()) continue;
      seen.set(String(ev.args.pool), { kind: ev.name, pool: String(ev.args.pool), other, deployer: ev.name === "CustomPool" ? String(ev.args.deployer) : undefined });
    }
  }
  return [...seen.values()];
}

// =====================================================================================================================

describe("Barkswap admin cases on our pools (t9)", function () {
  let s: BarkStack;

  beforeEach(async function () {
    s = await loadFixture(barkStackFixture);
  });

  after(function () {
    printGasTable("BarkAdmin.fork.spec.ts");
  });

  async function openCoin(opts: Parameters<typeof launchCoin>[1] = {}): Promise<LaunchResult> {
    const L = await launchCoin(s, opts);
    await time.increaseTo(L.openAt + 61n);
    return L;
  }

  async function adminPool(L: LaunchResult): Promise<C> {
    return L.poolContract.connect(await impersonate(BARKSWAP.admin)) as C;
  }

  async function restore(L: LaunchResult): Promise<[boolean, boolean, boolean]> {
    const rc = (await (await s.launcher.connect(s.signers.keeper).restore(L.coin)).wait())!;
    const ev = eventsOf(rc, s.launcher, "Restored")[0].args;
    const g = await poolState(L.pool);
    expect(await L.poolContract.plugin()).to.equal(await s.plugin.getAddress());
    expect([g.lastFee, g.config]).to.deep.equal([0, 135]);
    return [ev.pluginReset, ev.feeReset, ev.configReset];
  }

  it("setPlugin (foreign) + setFee: fees charged meanwhile are unbooked and land in router post; convert and the graduation fee wait for restore; principal untouched", async function () {
    const L = await openCoin({ firstBuy: WAD });
    const { trader, keeper } = s.signers;
    await approveRouter(trader, L.coin);
    const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 40n * WAD));
    await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 3n);
    await collectChecked(s, L);
    const pool = await adminPool(L);
    const rc = (await (await pool.setPlugin(s.signers.outsider.address)).wait())!;
    expect(eventsOf(rc, L.poolContract, "Plugin").map((e) => e.args[0])).to.deep.equal([s.signers.outsider.address]); // detectable
    expect((await poolState(L.pool)).config).to.equal(0); // Algebra: setPlugin resets the config, so setFee is open
    await (await pool.setFee(3000)).wait();
    // a trade pays 0.3% to our positions, nothing is booked by our plugin
    const free = await routerBuy(s, trader, L.coin, 10n * WAD);
    expect(eventsOf(free, s.plugin, "BarkSwap")).to.have.length(0);
    // money paths that a foreign plugin could tax are refused; collect still works
    await expect(s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "ForeignPlugin");
    await routerBuy(s, trader, L.coin, (raiseOfA(L) * 13n) / 10n); // crosses graduation, no latch (no hooks)
    expect((await s.plugin.pools(L.pool)).graduated).to.equal(false);
    await expect(s.launcher.connect(keeper).takeGraduationFee(L.pool)).to.be.revertedWithCustomError(s.launcher, "ForeignPlugin");
    const c = await collectChecked(s, L);
    expect(c.dN.concat(c.dC)).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
    expect(c.nativeBooks.slice(0, 3)).to.deep.equal([0n, 0n, 0n]);
    expect(c.nativeBooks[3]).to.equal(c.native);
    const cf = BigInt((await poolState(L.pool)).communityFee);
    const swapIn = 10n * WAD + (raiseOfA(L) * 13n) / 10n;
    const gross = (swapIn * 3000n) / 1_000_000n;
    expect(absb(c.native - (gross - (gross * cf) / 1000n))).to.be.at.most(8n * MEASURED_TOLERANCE_WEI);
    await expectPrincipal(s, L, "foreign plugin");
    await expectBooksEqualBalances(s, [L.coin], "foreign plugin");
    // restore: our plugin, lastFee 0, config 135, in that order
    expect(await restore(L)).to.deep.equal([true, true, true]);
    // trading books again; the graduation latch waits for the next swap at or past the graduation price
    const paid = barkSwapOf(s, await routerBuy(s, trader, L.coin, WAD));
    expect([paid.phase, paid.rateBps, paid.crossing]).to.deep.equal([1n, 100n, true]);
    expect((await s.launcher.launches(L.coin)).gradFeeTaken).to.equal(true);
    const after = await collectChecked(s, L);
    expect(after.nativeBooks[2]).to.equal(BigInt(paid.creatorAmount));
    await expectPrincipal(s, L, "after restore");
    await expectBooksEqualBalances(s, [L.coin], "after restore");
  });

  it("setPluginConfig without the position guard lets an outsider add liquidity: creators still collect their full amounts, the router books shrink pro rata; restore relocks", async function () {
    const L = await openCoin();
    const { trader, outsider } = s.signers;
    const launcher = await s.launcher.getAddress();
    await routerBuy(s, trader, L.coin, 60n * WAD);
    await collectChecked(s, L);
    const pool = await adminPool(L);
    await (await pool.setPluginConfig(131)).wait(); // swap hooks + dynamic fee, no before-position-modify
    // the outsider mints a range around the price through Barkswap's NPM (deployer = our launcher)
    const coinsHeld = BigInt(barkSwapOf(s, await routerBuy(s, outsider, L.coin, 20n * WAD)).coinAmount);
    await (await s.barkswap.wdoge.connect(outsider).deposit({ value: 20n * WAD })).wait();
    const npmAddr = BARKSWAP.nonfungiblePositionManager;
    await (await (await ethers.getContractAt(IERC20, BARKSWAP.wdoge, outsider)).approve(npmAddr, ethers.MaxUint256)).wait();
    await (await (await ethers.getContractAt(IERC20, L.coin, outsider)).approve(npmAddr, ethers.MaxUint256)).wait();
    const tick = (await poolState(L.pool)).tick;
    const base = Math.floor(tick / 10) * 10;
    const npm = s.barkswap.nonfungiblePositionManager.connect(outsider) as C;
    const params = {
      token0: L.coin,
      token1: BARKSWAP.wdoge,
      deployer: launcher,
      tickLower: base - 600,
      tickUpper: base + 600,
      amount0Desired: coinsHeld,
      amount1Desired: 20n * WAD,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: outsider.address,
      deadline: 2n ** 40n,
    };
    await (await npm.mint(params)).wait();
    await collectChecked(s, L); // the outsider's own buy (before its mint): all ours
    // trades now pay fees shared with the outsider; the plugin books the full net fee
    await approveRouter(trader, L.coin);
    const sw = barkSwapOf(s, await routerBuy(s, trader, L.coin, 10n * WAD));
    const c = await collectChecked(s, L);
    expect(c.native, "our positions got only part of the fee").to.be.lessThan(sum(c.dN));
    // B10 first: the creator amount is whole; the router bonding book is the pro-rata share of what is left
    expect(c.nativeBooks[0]).to.equal(BigInt(sw.creatorAmount));
    const rest = c.native - c.nativeBooks[0];
    expect(c.nativeBooks[1]).to.equal((rest * c.dN[1]) / (c.dN[1] + c.dN[3]));
    expect(c.nativeBooks[1]).to.be.lessThan(c.dN[1]);
    await expectPrincipal(s, L, "outside LP");
    await expectBooksEqualBalances(s, [L.coin], "outside LP");
    // restore relocks: no new liquidity from anyone but the launcher (the outsider's position stays: accepted risk)
    expect(await restore(L)).to.deep.equal([false, false, true]);
    await expect(npm.mint(params)).to.be.revertedWithCustomError(s.plugin, "LiquidityIsLocked");
    // the outsider's position (owned in the pool by the NPM) stays and keeps sharing fees: the accepted testnet risk
    const npmKey = positionKey(npmAddr, base - 600, base + 600);
    expect((await L.poolContract.positions(npmKey))[0]).to.be.greaterThan(0n);
    await expectPrincipal(s, L, "after restore");
    await expectBooksEqualBalances(s, [L.coin], "after restore");
  });

  it("setPluginConfig(7) + setFee(3000): swaps pay lastFee and are booked at it (the rate is reported, the fee is lastFee; creator on that gross fee); convert refused until restore", async function () {
    const L = await openCoin();
    const { trader, keeper } = s.signers;
    await approveRouter(trader, L.coin);
    const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 30n * WAD));
    await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 2n);
    await collectChecked(s, L);
    const pool = await adminPool(L);
    await expect(pool.setFee(3000)).to.be.revertedWithCustomError(L.poolContract, "dynamicFeeActive");
    await (await pool.setPluginConfig(7)).wait();
    const frc = (await (await pool.setFee(3000)).wait())!;
    expect(eventsOf(frc, L.poolContract, "Fee").map((e) => e.args[0])).to.deep.equal([3000n]); // detectable
    const buy = barkSwapOf(s, await routerBuy(s, trader, L.coin, 5n * WAD));
    // the before-swap hook still runs and reports the phase rate; with the flag off the pool charges lastFee instead
    expect([buy.rateBps, buy.feeUnits, buy.phase]).to.deep.equal([200n, 3000n, 0n]);
    expect(buy.grossFee).to.equal((5n * WAD * 3000n) / 1_000_000n);
    expect(buy.creatorAmount).to.equal((BigInt(buy.grossFee) * 560n) / 10_000n);
    await expect(s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(
      s.launcher,
      "ConversionFeeNotZero",
    );
    const c = await collectChecked(s, L);
    expect(c.nativeBooks[0]).to.equal(BigInt(buy.creatorAmount));
    expect(absb(c.native - sum(c.dN))).to.be.at.most(MEASURED_TOLERANCE_WEI);
    expect(await restore(L)).to.deep.equal([false, true, true]);
    const conv = (await (await s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait())!;
    expect(eventsOf(conv, s.launcher, "CoinFeesConverted")).to.have.length(1);
    await expectPrincipal(s, L, "setFee");
    await expectBooksEqualBalances(s, [L.coin], "setFee");
  });

  it("setCommunityFee 30 -> 500 -> 1000 -> 30: visible on the pool and in every BarkSwap; restore leaves it alone; principal and books exact", async function () {
    const L = await openCoin();
    const { trader, keeper } = s.signers;
    const pool = await adminPool(L);
    for (const cf of [500n, 1000n, 30n]) {
      const rc = (await (await pool.setCommunityFee(cf)).wait())!;
      expect(eventsOf(rc, L.poolContract, "CommunityFee").map((e) => e.args[0])).to.deep.equal([cf]);
      const sw = barkSwapOf(s, await routerBuy(s, trader, L.coin, 3n * WAD));
      expect(sw.communityFee).to.equal(cf);
      // not ours to set: restore has nothing to do
      await expect(s.launcher.connect(keeper).restore(L.coin)).to.be.revertedWithCustomError(s.launchLib, "NothingToRestore");
      expect((await poolState(L.pool)).communityFee).to.equal(Number(cf));
      if (cf === 1000n) {
        await expect(s.launcher.connect(keeper).collect(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "NothingToCollect");
      } else {
        const c = await collectChecked(s, L);
        expect(c.nativeBooks[0]).to.equal(BigInt(sw.creatorAmount));
      }
      await expectPrincipal(s, L, `cf ${cf}`);
      await expectBooksEqualBalances(s, [L.coin], `cf ${cf}`);
    }
  });

  it("setTickSpacing(60): zero-amount fee pokes, collect, the inline graduation burn and convert still address our 10-spaced ranges; restore leaves the spacing", async function () {
    const L = await openCoin();
    const { trader, keeper } = s.signers;
    const launcher = await s.launcher.getAddress();
    const pool = await adminPool(L);
    const rc = (await (await pool.setTickSpacing(60)).wait())!;
    expect(eventsOf(rc, L.poolContract, "TickSpacing").map((e) => Number(e.args[0]))).to.deep.equal([60]); // detectable
    expect(await L.poolContract.tickSpacing()).to.equal(60n);
    expect(TICK_MAX % 60, "B's top tick is not a multiple of 60").to.not.equal(0);
    await approveRouter(trader, L.coin);
    const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 30n * WAD));
    await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 2n);

    // Algebra: a zero-amount burn is a fee poke: it moves A's accrued fees into the position's owed amounts and
    // removes nothing (the launcher's collect starts with exactly these pokes)
    const keyA = positionKey(launcher, L.tickStart, L.tickGrad);
    const before = await L.poolContract.positions(keyA);
    expect([before[3], before[4]]).to.deep.equal([0n, 0n]);
    const nativeBefore = await ethers.provider.getBalance(launcher);
    const asLauncher = L.poolContract.connect(await impersonate(launcher)) as C;
    const poke = (await (await asLauncher.burn(L.tickStart, L.tickGrad, 0n, "0x")).wait())!;
    await network.provider.send("hardhat_stopImpersonatingAccount", [launcher]);
    await setNativeBalance(launcher, nativeBefore); // undo the impersonation's gas money
    expect(eventsOf(poke, L.poolContract, "Burn")).to.have.length(0); // Algebra emits no Burn for a zero-amount poke
    const poked = await L.poolContract.positions(keyA);
    expect(poked[0]).to.equal(before[0]);
    expect(poked[3], "coin fees owed").to.be.greaterThan(0n);
    expect(poked[4], "WDOGE fees owed").to.be.greaterThan(0n);
    const c = await collectChecked(s, L);
    expect(c.coins).to.be.at.least(poked[3]);
    expect(c.native).to.be.at.least(poked[4]);
    const after = await L.poolContract.positions(keyA);
    expect([after[0], after[3], after[4]]).to.deep.equal([before[0], 0n, 0n]);
    recordGas("collect (tick spacing 60)", c.rc.gasUsed);

    // the crossing swap's inline graduation burn of [tickStart, tickGrad]
    const cross = await routerBuy(s, trader, L.coin, (raiseOfA(L) * 13n) / 10n);
    const taken = eventsOf(cross, s.launcher, "GraduationFeeTaken");
    expect(taken).to.have.length(1);
    const burnLiq = (L.liqA * 200n) / 10_000n;
    expect(taken[0].args.amount).to.equal(amount1Delta(L.sqrtStart, L.sqrtGrad, burnLiq, false));
    await routerSell(s, trader, L.coin, 2_000_000n * WAD);
    await collectChecked(s, L);
    await time.increase(600);
    const conv = (await (await s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait())!;
    expect(eventsOf(conv, s.launcher, "CoinFeesConverted")).to.have.length(1);
    // restore has nothing to re-apply: the tick spacing is not ours to set after launch
    await expect(s.launcher.connect(keeper).restore(L.coin)).to.be.revertedWithCustomError(s.launchLib, "NothingToRestore");
    expect(await L.poolContract.tickSpacing()).to.equal(60n);
    await expectPrincipal(s, L, "tick spacing 60");
    await expectBooksEqualBalances(s, [L.coin], "tick spacing 60");
  });

  it("side pools for our coin are detectable from the factory's Pool / CustomPool events; our own pool is not reported", async function () {
    const L = await launchCoin(s, {});
    const L2 = await launchCoin(s, {});
    const { outsider } = s.signers;
    const launcher = await s.launcher.getAddress();
    const from = L.receipt.blockNumber;
    expect(await sidePoolsOf(L.coin, launcher, from)).to.deep.equal([]);
    const factory = (await ethers.getContractAt("IAlgebraFactory", BARKSWAP.factory)) as unknown as C;
    // a default Barkswap pool coin / WDOGE, by an outsider
    const prc = (await (await factory.connect(outsider).createPool(L.coin, BARKSWAP.wdoge, "0x")).wait())!;
    const defaultPool = eventsOf(prc, factory, "Pool")[0].args.pool;
    // a default pool of our coin against another token (our coin as token1 or token0)
    const xrc = (await (await factory.connect(outsider).createPool(L2.coin, L.coin, "0x")).wait())!;
    const crossPool = eventsOf(xrc, factory, "Pool")[0].args.pool;
    // a custom pool by an outside deployer contract
    const art = await sideDeployerArtifact();
    const side = (await new ethers.ContractFactory(art.abi, art.bytecode, outsider).deploy()) as unknown as C;
    await side.waitForDeployment();
    const crc = (await (await side.create(BARKSWAP.customPoolEntryPoint, L.coin, BARKSWAP.wdoge)).wait())!;
    const customPool = eventsOf(crc, factory, "CustomPool")[0].args.pool;
    const found = await sidePoolsOf(L.coin, launcher, from);
    expect(found.map((p) => p.pool).sort()).to.deep.equal([defaultPool, crossPool, customPool].sort());
    expect(found.find((p) => p.pool === customPool)!.deployer).to.equal(await side.getAddress());
    expect(found.find((p) => p.pool === crossPool)!.other).to.equal(L2.coin);
    expect(found.map((p) => p.pool)).to.not.include(L.pool);
    // our pool keeps trading and booking untouched by the side pools
    await time.increaseTo(L.openAt + 61n);
    const sw = barkSwapOf(s, await routerBuy(s, s.signers.trader, L.coin, WAD));
    expect(sw.pool).to.equal(L.pool);
    await expectBooksEqualBalances(s, [L.coin, L2.coin], "side pools");
  });
});

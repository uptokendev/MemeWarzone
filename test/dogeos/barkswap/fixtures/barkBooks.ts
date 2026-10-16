// Off-chain mirrors of MwzBarkLauncher's fee books for the Bark money and admin fork tests (t9): MwzBarkFeeBooks'
// apportion / draw, the plugin's FeeTotals in book order, the measured rounding tolerance, the "books == balances"
// invariant and a fully checked collect. Shared by BarkMoney.fork.spec.ts and BarkAdmin.fork.spec.ts; t8's
// fixtures/barkswap.ts holds the Bark stack itself and is not touched here.
// Audit: docs/dogeos/barkswap-audit.md (MwzBarkLauncher "Fee books", collect).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { ethers } from "hardhat";
import type { ContractTransactionReceipt } from "ethers";
import { eventsOf, type BarkStack, type LaunchResult } from "./barkswap";

const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";

/** Measured on this fork (t9; $0.10 DOGE, $150 target, fork block 8,578,734): collected - plugin-booked of one swap in
 *  one book, in wei (WDOGE or coin units). In our favour up to 45 wei (single-step sells of millions of coins: the pool
 *  recomputes the input from the rounded price and keeps the rest of the available amount as fee). The audit's derived
 *  bound (16 wei) is exceeded by large sells; the excess is always in our favour and lands in router post
 *  (MwzBarkFeeBooks.apportion), never in a creator book. The table is printed by BarkMoney's tolerance test. */
export const MEASURED_TOLERANCE_WEI = 45n;
/** Measured: against us at most 1 wei per swap per book (buys: the plugin's floor of r/(1+r) on the input). */
export const MEASURED_AGAINST_US_WEI = 1n;
/** The audit's derived bound (plugin "Tolerance"), which the measurement exceeds. */
export const AUDIT_DERIVED_TOLERANCE_WEI = 16n;

export const sum = (a: readonly bigint[]): bigint => a.reduce((x, y) => x + y, 0n);
export const big4 = (r: any): bigint[] => Array.from(r as ArrayLike<any>, (v) => BigInt(v));
export const absb = (v: bigint): bigint => (v < 0n ? -v : v);

/** MwzBarkFeeBooks.apportion, off chain. Book order [creator bonding, router bonding, creator post, router post]. */
export function apportion(amount: bigint, d: readonly bigint[]): bigint[] {
  let rest = amount;
  const b = [0n, 0n, 0n, 0n];
  b[0] = d[0] < rest ? d[0] : rest;
  rest -= b[0];
  b[2] = d[2] < rest ? d[2] : rest;
  rest -= b[2];
  const dR = d[1] + d[3];
  b[1] = rest >= dR ? d[1] : (rest * d[1]) / dR;
  b[3] = rest - b[1];
  return b;
}

/** MwzBarkFeeBooks.draw, off chain. */
export function draw(books: readonly bigint[], used: bigint, pending: bigint, out: bigint): { taken: bigint[]; got: bigint[] } {
  const taken = books.map((b) => (used === pending ? b : (b * used) / pending));
  let left = used - sum(taken);
  for (let i = 3; left !== 0n && i >= 0; i--) {
    const room = books[i] - taken[i];
    const add = room < left ? room : left;
    taken[i] += add;
    left -= add;
  }
  const got = [0n, 0n, 0n, 0n];
  if (used !== 0n) for (let i = 0; i < 4; i++) got[i] = (out * taken[i]) / used;
  got[3] += out - sum(got);
  return { taken, got };
}

/** Plugin FeeTotals in MwzBarkFeeBooks order [creator bonding, router bonding, creator post, router post]. */
export const nativeOrder = (t: any): bigint[] => [t.bondingNative.creator, t.bondingNative.router, t.postNative.creator, t.postNative.router].map(BigInt);
export const coinOrder = (t: any): bigint[] => [t.bondingCoin.creator, t.bondingCoin.router, t.postCoin.creator, t.postCoin.router].map(BigInt);

/** The coin's four pending coin books (MwzBarkLauncher.coinFees) in book order. */
export async function coinBooks(s: BarkStack, coin: string): Promise<bigint[]> {
  const k = await s.launcher.coinFees(coin);
  return [k.creatorBonding, k.routerBonding, k.creatorPost, k.routerPost].map(BigInt);
}

export async function balanceOf(token: string, holder: string): Promise<bigint> {
  return (await ethers.getContractAt(IERC20, token)).balanceOf(holder);
}

export interface Donations {
  native?: bigint;
  wdoge?: bigint;
  coins?: Record<string, bigint>;
}

/** Spec invariant "books == balances" (audit "Fee books"): native == sum(creatorOwed) + routerOwed + parkedOwed, no
 *  WDOGE at rest, per coin balance == the four pending coin books; plus whatever was donated, which stays inert. */
export async function expectBooksEqualBalances(s: BarkStack, coins: string[], label: string, d: Donations = {}): Promise<void> {
  const launcher = await s.launcher.getAddress();
  let creators = 0n;
  for (const c of coins) creators += await s.launcher.creatorOwed(c);
  const routerOwed = BigInt(await s.launcher.routerOwed());
  const parked = BigInt(await s.launcher.parkedOwed());
  expect(await ethers.provider.getBalance(launcher), `${label}: native`).to.equal(creators + routerOwed + parked + (d.native ?? 0n));
  expect(await s.barkswap.wdoge.balanceOf(launcher), `${label}: WDOGE`).to.equal(d.wdoge ?? 0n);
  for (const c of coins) {
    expect(await balanceOf(c, launcher), `${label}: coin ${c}`).to.equal(sum(await coinBooks(s, c)) + (d.coins?.[c] ?? 0n));
  }
  const bonding = BigInt(await s.launcher.pendingBondingFees());
  const grad = BigInt(await s.launcher.pendingGradFees());
  expect(bonding + grad, `${label}: B + G inside the bucket`).to.be.at.most(routerOwed);
}

export interface Collected {
  rc: ContractTransactionReceipt;
  native: bigint;
  coins: bigint;
  dN: bigint[];
  dC: bigint[];
  nativeBooks: bigint[];
  coinBooks: bigint[];
  /** collected - plugin-booked, per token (signed) */
  errN: bigint;
  errC: bigint;
}

/** collect(coin) with every money check of the audit's "collect" entry: the event's books are apportion(received, the
 *  plugin's totals since the last collect), they sum to what the pool's Collect events paid, and the launcher's books
 *  move by exactly those amounts. */
export async function collectChecked(s: BarkStack, L: LaunchResult, caller = s.signers.keeper): Promise<Collected> {
  const prev = await s.launcher.collectedTotals(L.coin);
  const t = await s.plugin.feeTotals(L.pool);
  const dN = nativeOrder(t).map((v, i) => v - nativeOrder(prev)[i]);
  const dC = coinOrder(t).map((v, i) => v - coinOrder(prev)[i]);
  const owed0 = BigInt(await s.launcher.creatorOwed(L.coin));
  const router0 = BigInt(await s.launcher.routerOwed());
  const bonding0 = BigInt(await s.launcher.pendingBondingFees());
  const grad0 = BigInt(await s.launcher.pendingGradFees());
  const books0 = await coinBooks(s, L.coin);
  const rc = (await (await s.launcher.connect(caller).collect(L.coin, { gasLimit: 3_000_000n })).wait())!;
  const evs = eventsOf(rc, s.launcher, "FeesCollected");
  expect(evs).to.have.length(1);
  const ev = evs[0].args;
  const native = BigInt(ev.native);
  const coins = BigInt(ev.coins);
  const nativeBooks = big4(ev.nativeBooks);
  const cBooks = big4(ev.coinBooks);
  expect(ev.coin).to.equal(L.coin);
  expect(nativeBooks, "native apportion").to.deep.equal(apportion(native, dN));
  expect(cBooks, "coin apportion").to.deep.equal(apportion(coins, dC));
  // the pool's Collect events (A and B) paid exactly what was booked; principal never (no Burn with liquidity)
  const pc = eventsOf(rc, L.poolContract, "Collect"); // Algebra emits Collect only for a non-zero collect
  expect(pc.length).to.be.at.most(2);
  expect(sum(pc.map((e) => BigInt(e.args.amount0)))).to.equal(coins);
  expect(sum(pc.map((e) => BigInt(e.args.amount1)))).to.equal(native);
  for (const b of eventsOf(rc, L.poolContract, "Burn")) expect(b.args.liquidityAmount).to.equal(0n);
  expect(BigInt(await s.launcher.creatorOwed(L.coin)) - owed0).to.equal(nativeBooks[0] + nativeBooks[2]);
  expect(BigInt(await s.launcher.routerOwed()) - router0).to.equal(nativeBooks[1] + nativeBooks[3]);
  expect(BigInt(await s.launcher.pendingBondingFees()) - bonding0).to.equal(nativeBooks[1]);
  expect(BigInt(await s.launcher.pendingGradFees())).to.equal(grad0);
  const books1 = await coinBooks(s, L.coin);
  expect(books1.map((v, i) => v - books0[i])).to.deep.equal(cBooks);
  const after = await s.launcher.collectedTotals(L.coin);
  expect(nativeOrder(after)).to.deep.equal(nativeOrder(t));
  expect(coinOrder(after)).to.deep.equal(coinOrder(t));
  return { rc, native, coins, dN, dC, nativeBooks, coinBooks: cBooks, errN: native - sum(dN), errC: coins - sum(dC) };
}

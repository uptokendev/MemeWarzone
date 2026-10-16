// MwzBarkLauncher's money side on a Chikyu fork, through Barkswap's real pools, SwapRouter and community vault: collect
// books exactly what the pool hands over (books == balances, donations inert), the measured rounding between the plugin's
// per-phase totals and what collect can take, the creator's amounts on the GROSS fee whatever Barkswap's community fee
// (B10), router post absorbing rounding and unbooked surplus (flash fee, direct transfer, hooks-off period), convert (the
// full capped amount whoever calls, pro rata over the phase books, interval, launch window, F2 floor, the 1% cap pinned
// against CONVERT_IMPACT_BPS, ConversionFeeNotZero / ForeignPlugin, a sandwich loses), the graduation book, route runs
// that never revert OutOfBand (B11), creator claims and the two-step transfer, claimRouter (F4), the parked router (F3,
// A4, A13) and the recorded money-flow fixture for t19.
// Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md §3 (Money flow 1-5, Attribution for D1,
// Invariants), B10, B11; audit: docs/dogeos/barkswap-audit.md (Gate 0 "Open items handed to the fork tests" t9,
// MwzBarkLauncher "Fee books", collect, convert, claims, "Hand-off from t4"). Plan task t9.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkMoney.fork.spec.ts
//
// MWZ_RECORD_BARK_FIXTURES=1 rewrites test/fixtures/dogeos/barkMoneyFlow.json from this run; without it the committed
// file is verified on its own (every log decodes to its recorded args; the books replayed from the events equal every
// recorded read-back; collect / convert / route arithmetic recomputed) and its event sequence is compared with the run.
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { expect } from "chai";
import hre, { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "hardhat/builtin-tasks/task-names";
import type { ContractTransactionReceipt } from "ethers";
import {
  BARKSWAP,
  CREATOR_RESERVE,
  DOGEOS_CHIKYU_CHAIN_ID,
  WAD,
  amount1Delta,
  approveRouter,
  barkSwapOf,
  communityFeesOf,
  deployBarkStack,
  eventsOf,
  exportedAbi,
  impersonate,
  launchCoin,
  plainArgs,
  poolState,
  positionLiquidity,
  printGasTable,
  raiseOfA,
  readyFork,
  recordGas,
  routerBuy,
  routerSell,
  setNativeBalance,
  type BarkStack,
  type C,
  type LaunchResult,
} from "./fixtures/barkswap";

const TICK_MAX = 887_270;
const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
/** MwzBarkLauncher.CONVERT_SQRT_FACTOR_E9 (internal): ceil(sqrt(0.99) x 1e9), audit I-8. */
const CONVERT_SQRT_FACTOR_E9 = 994_987_438n;
/** Measured on this fork (t9; $0.10 DOGE, $150 target, fork block 8,578,734): collected - plugin-booked of one swap in
 *  one book, in wei (WDOGE or coin units). Against us at most 1 wei (buys: the plugin's floor of r/(1+r) on the input);
 *  in our favour up to 45 wei (single-step sells of millions of coins: the pool recomputes the input from the rounded
 *  price and keeps the rest of the available amount as fee). The audit's derived bound (16 wei) is exceeded by large
 *  sells; the excess is always in our favour and lands in router post (MwzBarkFeeBooks.apportion), never in a creator
 *  book. The table is printed by the tolerance test. */
const MEASURED_TOLERANCE_WEI = 45n;
const MEASURED_AGAINST_US_WEI = 1n;
const ROUTER_TIMELOCK = 48n * 3600n;
const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "fixtures", "dogeos", "barkMoneyFlow.json");

type MoneyStack = BarkStack & { community: C };

/** The default stack with a real CommunityRewardsVault (gen-7 contract, same bytecode the stack routes into) as the
 *  splitter's community destination, so route runs can pay squad and airdrop; the other vaults are fixed placeholder
 *  addresses (plain native sends). */
async function moneyStackFixture(): Promise<MoneyStack> {
  await readyFork();
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("contracts/CommunityRewardsVault.sol:CommunityRewardsVault", deployer);
  const community = (await factory.deploy(deployer.address, deployer.address)) as unknown as C;
  await community.waitForDeployment();
  const s = await deployBarkStack({ vaults: { communityRewardsVault: await community.getAddress() } });
  await (await community.connect(deployer).setRouter(await s.splitter.getAddress())).wait();
  return Object.assign(s, { community });
}

// ------------------------------------------------------------------------------------------------- book arithmetic

const sum = (a: readonly bigint[]): bigint => a.reduce((x, y) => x + y, 0n);
const big4 = (r: any): bigint[] => Array.from(r as ArrayLike<any>, (v) => BigInt(v));
const absb = (v: bigint): bigint => (v < 0n ? -v : v);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** MwzBarkFeeBooks.apportion, off chain. */
function apportion(amount: bigint, d: readonly bigint[]): bigint[] {
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
function draw(books: readonly bigint[], used: bigint, pending: bigint, out: bigint): { taken: bigint[]; got: bigint[] } {
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
const nativeOrder = (t: any): bigint[] => [t.bondingNative.creator, t.bondingNative.router, t.postNative.creator, t.postNative.router].map(BigInt);
const coinOrder = (t: any): bigint[] => [t.bondingCoin.creator, t.bondingCoin.router, t.postCoin.creator, t.postCoin.router].map(BigInt);

async function coinBooks(s: BarkStack, coin: string): Promise<bigint[]> {
  const k = await s.launcher.coinFees(coin);
  return [k.creatorBonding, k.routerBonding, k.creatorPost, k.routerPost].map(BigInt);
}

async function balanceOf(token: string, holder: string): Promise<bigint> {
  return (await ethers.getContractAt(IERC20, token)).balanceOf(holder);
}

interface Donations {
  native?: bigint;
  wdoge?: bigint;
  coins?: Record<string, bigint>;
}

/** Spec invariant "books == balances" (audit "Fee books"): native == sum(creatorOwed) + routerOwed + parkedOwed, no
 *  WDOGE at rest, per coin balance == the four pending coin books; plus whatever was donated, which stays inert. */
async function expectBooksEqualBalances(s: BarkStack, coins: string[], label: string, d: Donations = {}): Promise<void> {
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

interface Collected {
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
async function collectChecked(s: BarkStack, L: LaunchResult, caller = s.signers.keeper): Promise<Collected> {
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

interface Converted {
  rc: ContractTransactionReceipt;
  pending: bigint;
  coinsIn: bigint;
  nativeOut: bigint;
  taken: bigint[];
  got: bigint[];
  priceBefore: bigint;
  priceAfter: bigint;
  limit: bigint;
  ev: Record<string, any>;
}

/** convert(coin) with every check of the audit's "convert" entry: the pro-rata draw recomputed, the books and the
 *  bucket moved by exactly the event's amounts, a 0-fee conversion swap, the 1% cap and the F2 floor, and "the full
 *  capped amount": either everything pending was sold or the price stopped exactly at the limit. */
async function convertChecked(s: BarkStack, L: LaunchResult, caller = s.signers.keeper): Promise<Converted> {
  const books = await coinBooks(s, L.coin);
  const pending = sum(books);
  const g0 = await poolState(L.pool);
  const owed0 = BigInt(await s.launcher.creatorOwed(L.coin));
  const router0 = BigInt(await s.launcher.routerOwed());
  const bonding0 = BigInt(await s.launcher.pendingBondingFees());
  const rc = (await (await s.launcher.connect(caller).convert(L.coin, { gasLimit: 3_000_000n })).wait())!;
  const evs = eventsOf(rc, s.launcher, "CoinFeesConverted");
  expect(evs).to.have.length(1);
  const ev = evs[0].args.toObject();
  const coinsIn = BigInt(ev.coinsIn);
  const nativeOut = BigInt(ev.nativeOut);
  expect(ev.coin).to.equal(L.coin);
  expect(ev.pending).to.equal(pending);
  const { taken, got } = draw(books, coinsIn, pending, nativeOut);
  expect(big4(ev.coins), "coins drawn pro rata").to.deep.equal(taken);
  expect(big4(ev.native), "DOGE back pro rata").to.deep.equal(got);
  expect(sum(taken)).to.equal(coinsIn);
  expect(sum(got)).to.equal(nativeOut);
  expect(await coinBooks(s, L.coin)).to.deep.equal(books.map((b, i) => b - taken[i]));
  expect(BigInt(await s.launcher.creatorOwed(L.coin)) - owed0).to.equal(got[0] + got[2]);
  expect(BigInt(await s.launcher.routerOwed()) - router0).to.equal(got[1] + got[3]);
  expect(BigInt(await s.launcher.pendingBondingFees()) - bonding0).to.equal(got[1]);
  // the pool sold exactly coinsIn for nativeOut at 0 fee, as the conversion kind
  const sw = barkSwapOf(s, rc);
  expect([sw.kind, sw.buy, sw.feeUnits, sw.grossFee, sw.netFee, sw.creatorAmount]).to.deep.equal([1n, false, 0n, 0n, 0n, 0n]);
  expect([sw.coinAmount, sw.nativeAmount]).to.deep.equal([coinsIn, nativeOut]);
  const ps = eventsOf(rc, L.poolContract, "Swap")[0].args;
  expect([ps.amount0, ps.amount1, ps.overrideFee, ps.pluginFee]).to.deep.equal([coinsIn, -nativeOut, 0n, 0n]);
  // the limit: max(ceil(sqrtP x f / 1e9), sqrtStart); never below it, never more than 1% of price
  const g1 = await poolState(L.pool);
  let limit = ceilDiv(g0.price * CONVERT_SQRT_FACTOR_E9, 1_000_000_000n);
  if (limit < L.sqrtStart) limit = L.sqrtStart;
  expect(g1.price, "price at or above the conversion limit").to.be.at.least(limit);
  expect(g1.price, "F2: never below the start price").to.be.at.least(L.sqrtStart);
  const impact = BigInt(await s.launcher.CONVERT_IMPACT_BPS());
  expect(g1.price * g1.price * 10_000n, "at most CONVERT_IMPACT_BPS of price").to.be.at.least(g0.price * g0.price * (10_000n - impact));
  if (coinsIn < pending) expect(g1.price, "a partial conversion stops exactly at the limit").to.equal(limit);
  const ts = BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp);
  expect((await s.launcher.launches(L.coin)).lastConvertAt).to.equal(ts);
  expect(await s.launcher.conversionInProgress(L.pool)).to.equal(false);
  return { rc, pending, coinsIn, nativeOut, taken, got, priceBefore: g0.price, priceAfter: g1.price, limit, ev };
}

// ------------------------------------------------------------------------------------------------- inline test actors

const COMPILED: Record<string, { abi: any[]; bytecode: string }> = {};

/** Compiles a small test-only contract from source with the Bark build's solc (0.8.26, cancun). Test actors only (a
 *  flash borrower); nothing here is deployed outside the fork. */
async function compileInline(name: string, source: string): Promise<{ abi: any[]; bytecode: string }> {
  if (COMPILED[name]) return COMPILED[name];
  const solcVersion = "0.8.26";
  const file = `inline/${name}.sol`;
  const input = {
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const build = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });
  const output = build.isSolcJs
    ? await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath })
    : await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath, solcVersion });
  const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length > 0) throw new Error(`${name}: ${errors.map((e: any) => e.formattedMessage).join("\n")}`);
  const out = output.contracts[file][name];
  COMPILED[name] = { abi: out.abi, bytecode: `0x${out.evm.bytecode.object}` };
  return COMPILED[name];
}

/** A flash borrower: borrows from the pool and repays the loan, the pool's flash fee and an optional tip (the contract
 *  is pre-funded with both tokens). Algebra 1.2.1 calls algebraFlashCallback(fee0, fee1, data) on msg.sender. */
const FLASH_PROBE_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface IERC20Min { function transfer(address to, uint256 amount) external returns (bool); }
interface IFlashPool {
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
}
contract BarkFlashProbe {
    address private pool;
    function borrow(address p, uint256 amount0, uint256 amount1, uint256 tip0, uint256 tip1) external {
        pool = p;
        IFlashPool(p).flash(address(this), amount0, amount1, abi.encode(amount0 + tip0, amount1 + tip1));
        pool = address(0);
    }
    function algebraFlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        require(msg.sender == pool, "pool");
        (uint256 r0, uint256 r1) = abi.decode(data, (uint256, uint256));
        if (r0 + fee0 > 0) require(IERC20Min(IFlashPool(msg.sender).token0()).transfer(msg.sender, r0 + fee0), "t0");
        if (r1 + fee1 > 0) require(IERC20Min(IFlashPool(msg.sender).token1()).transfer(msg.sender, r1 + fee1), "t1");
    }
}
`;

// ------------------------------------------------------------------------------------------------- recorded fixture

const FIXTURE_CONTRACTS = ["MwzBarkLauncher", "MwzBarkPlugin", "MwzBarkFeeSplitter"] as const;
type FixtureContract = (typeof FIXTURE_CONTRACTS)[number];

interface MoneyLog {
  step: string;
  contract: FixtureContract;
  event: string;
  address: string;
  blockNumber: number;
  blockTimestamp: number;
  transactionHash: string;
  txFrom: string;
  txTo: string;
  logIndex: number;
  topics: string[];
  data: string;
  args: Record<string, any>;
}

interface CoinReadBack {
  creatorOwed: string;
  coinFees: string[];
  collectedTotals: { native: string[]; coin: string[] };
  pluginTotals: { native: string[]; coin: string[] };
  lastConvertAt: string;
  launcherCoinBalance: string;
}

interface ReadBack {
  coins: Record<string, CoinReadBack>;
  routerOwed: string;
  pendingBondingFees: string;
  pendingGradFees: string;
  parkedOwed: string;
  launcherNative: string;
  routerPaid: { amount: string; bondingFees: string; gradFees: string };
  splitterPending: { total: string; bondingFees: string; gradFees: string };
  splitterRouted: { runs: string; amount: string; bondingFees: string; gradFees: string };
}

interface MoneyStep {
  step: string;
  transactionHash: string;
  blockNumber: number;
  blockTimestamp: number;
  from: string;
  to: string;
  gasUsed: string;
  readBack: ReadBack;
}

interface MoneyFixture {
  description: string;
  recordedBy: string;
  chainId: string;
  forkBlock: number;
  abiSource: string;
  bookOrder: string[];
  contracts: Record<string, string>;
  coins: Array<Record<string, string | number>>;
  initialReadBack: ReadBack;
  steps: MoneyStep[];
  routePlan: {
    step: string;
    note: string;
    runId: string;
    expectedPaid: string;
    pending: { total: string; bondingFees: string; gradFees: string };
    bands: { weekly: string; monthly: string; rsaMin: string; rsaMax: string; squadMax: string };
    recruiter: string;
    squad: string;
    airdrop: string;
    accrualRoot: string;
  };
  logs: MoneyLog[];
}

const s4 = (a: readonly bigint[]): string[] => a.map(String);

async function readBack(s: BarkStack, coins: LaunchResult[]): Promise<ReadBack> {
  const launcher = await s.launcher.getAddress();
  const splitter = await s.splitter.getAddress();
  const out: Record<string, CoinReadBack> = {};
  for (const L of coins) {
    const ct = await s.launcher.collectedTotals(L.coin);
    const pt = await s.plugin.feeTotals(L.pool);
    out[L.coin] = {
      creatorOwed: String(await s.launcher.creatorOwed(L.coin)),
      coinFees: s4(await coinBooks(s, L.coin)),
      collectedTotals: { native: s4(nativeOrder(ct)), coin: s4(coinOrder(ct)) },
      pluginTotals: { native: s4(nativeOrder(pt)), coin: s4(coinOrder(pt)) },
      lastConvertAt: String((await s.launcher.launches(L.coin)).lastConvertAt),
      launcherCoinBalance: String(await balanceOf(L.coin, launcher)),
    };
  }
  const paid = await s.launcher.routerPaid(splitter);
  const pend = await s.splitter.pending();
  return {
    coins: out,
    routerOwed: String(await s.launcher.routerOwed()),
    pendingBondingFees: String(await s.launcher.pendingBondingFees()),
    pendingGradFees: String(await s.launcher.pendingGradFees()),
    parkedOwed: String(await s.launcher.parkedOwed()),
    launcherNative: String(await ethers.provider.getBalance(launcher)),
    routerPaid: { amount: String(paid.amount), bondingFees: String(paid.bondingFees), gradFees: String(paid.gradFees) },
    splitterPending: { total: String(pend[0]), bondingFees: String(pend[1]), gradFees: String(pend[2]) },
    splitterRouted: {
      runs: String(await s.splitter.runs()),
      amount: String(await s.splitter.routedAmount()),
      bondingFees: String(await s.splitter.routedBondingFees()),
      gradFees: String(await s.splitter.routedGradFees()),
    },
  };
}

/** Runs the money-flow scenario for t19 and records every launcher, plugin and splitter log with the book read-backs
 *  after every step: two coins; bonding buys and sells (two traders), collects, the crossing buy (graduation book),
 *  post-graduation buys and sells, collects, conversions, the operator's router claim, a creator claim and one route
 *  run planned against routerPaid. */
async function buildMoneyFixture(s: MoneyStack): Promise<MoneyFixture> {
  const { creator, trader, trader2, keeper, operator } = s.signers;
  const named: Record<FixtureContract, C> = { MwzBarkLauncher: s.launcher, MwzBarkPlugin: s.plugin, MwzBarkFeeSplitter: s.splitter };
  const logs: MoneyLog[] = [];
  const steps: MoneyStep[] = [];
  const X = await launchCoin(s, { name: "Bark Money X", symbol: "BMX", firstBuy: 2n * WAD });
  const Y = await launchCoin(s, { name: "Bark Money Y", symbol: "BMY" });
  const coins = [X, Y];
  const initialReadBack = await readBack(s, coins);
  const record = async (step: string, rc: ContractTransactionReceipt) => {
    const block = (await ethers.provider.getBlock(rc.blockNumber))!;
    for (const name of FIXTURE_CONTRACTS) {
      const c = named[name];
      const addr = String(c.target).toLowerCase();
      for (const log of rc.logs) {
        if (log.address.toLowerCase() !== addr) continue;
        const ev = c.interface.parseLog(log);
        if (!ev) continue;
        logs.push({
          step,
          contract: name,
          event: ev.name,
          address: log.address,
          blockNumber: rc.blockNumber,
          blockTimestamp: block.timestamp,
          transactionHash: rc.hash,
          txFrom: rc.from,
          txTo: rc.to ?? "",
          logIndex: log.index,
          topics: [...log.topics],
          data: log.data,
          args: plainArgs(ev),
        });
      }
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    steps.push({
      step,
      transactionHash: rc.hash,
      blockNumber: rc.blockNumber,
      blockTimestamp: block.timestamp,
      from: rc.from,
      to: rc.to ?? "",
      gasUsed: rc.gasUsed.toString(),
      readBack: await readBack(s, coins),
    });
  };
  const tx = async (p: Promise<any>) => (await (await p).wait())! as ContractTransactionReceipt;

  await time.increaseTo((X.openAt > Y.openAt ? X.openAt : Y.openAt) + 61n);
  await approveRouter(trader, X.coin);
  await approveRouter(trader2, X.coin);
  await approveRouter(trader, Y.coin);
  const bx = await routerBuy(s, trader, X.coin, 20n * WAD);
  await record("X: buy (bonding)", bx);
  const bx2 = await routerBuy(s, trader2, X.coin, 10n * WAD);
  await record("X: buy (bonding, trader2)", bx2);
  await record("X: sell (bonding)", await routerSell(s, trader, X.coin, BigInt(barkSwapOf(s, bx).coinAmount) / 2n));
  const by = await routerBuy(s, trader, Y.coin, 5n * WAD);
  await record("Y: buy (bonding)", by);
  await record("Y: sell (bonding)", await routerSell(s, trader, Y.coin, BigInt(barkSwapOf(s, by).coinAmount) / 3n));
  await record("X: collect", await tx(s.launcher.connect(keeper).collect(X.coin, { gasLimit: 3_000_000n })));
  await record("Y: collect", await tx(s.launcher.connect(keeper).collect(Y.coin, { gasLimit: 3_000_000n })));
  await record("X: buy crossing graduation (inline graduation fee)", await routerBuy(s, trader, X.coin, (raiseOfA(X) * 13n) / 10n));
  await record("X: buy (post-graduation)", await routerBuy(s, trader2, X.coin, 3n * WAD));
  await record("X: sell (post-graduation)", await routerSell(s, trader, X.coin, 2_000_000n * WAD));
  await record("X: sell (post-graduation, trader2)", await routerSell(s, trader2, X.coin, BigInt(barkSwapOf(s, bx2).coinAmount) / 4n));
  await record("X: collect", await tx(s.launcher.connect(keeper).collect(X.coin, { gasLimit: 3_000_000n })));
  await time.increase(600);
  await record("X: convert", await tx(s.launcher.connect(keeper).convert(X.coin, { gasLimit: 3_000_000n })));
  await record("Y: convert", await tx(s.launcher.connect(keeper).convert(Y.coin, { gasLimit: 3_000_000n })));
  await record("claimRouter (operator)", await tx(s.launcher.connect(operator).claimRouter({ gasLimit: 500_000n })));
  await record("X: claimCreator", await tx(s.launcher.connect(creator).claimCreator(X.coin, creator.address, { gasLimit: 500_000n })));

  // the operator's plan: claim first (done), then expectedPaid = routerPaid(splitter).amount and the bands of pending()
  const splitter = await s.splitter.getAddress();
  const expectedPaid = BigInt((await s.launcher.routerPaid(splitter)).amount);
  const [total, B, G] = (await s.splitter.pending()).map(BigInt);
  const b = await s.splitter.bands(B, G);
  const squad = BigInt(b.squadMax) / 2n;
  const airdrop = (BigInt(b.rsaMax) - squad) / 3n;
  const recruiter = BigInt(b.rsaMax) - squad - airdrop;
  const accrualRoot = ethers.id("mwz.dogeos.bark.t9.moneyflow.accrualRoot");
  const runId = BigInt(await s.splitter.runs()) + 1n;
  await record(
    "route (run 1, bands at their maximum)",
    await tx(s.splitter.connect(operator).route(runId, expectedPaid, recruiter, squad, airdrop, accrualRoot, { gasLimit: 1_000_000n })),
  );

  const forking = (network.config as { forking?: { blockNumber?: number } }).forking;
  return {
    description:
      "Recorded on a Chikyu fork by the t9 fork test for t19 (fee accrual, sell attribution and route-run rows): the money " +
      "flow of two coins on Barkswap (Algebra Integral 1.2.1) with the audited MwzBark contracts. logs[] are every " +
      "MwzBarkLauncher, MwzBarkPlugin and MwzBarkFeeSplitter log in order (raw topics/data plus args decoded with " +
      "contracts/dogeos/barkswap/abi). steps[] are the transactions in order with the launcher's and splitter's book " +
      "read-backs after each (strings are wei / coin units; four-element arrays are in bookOrder). routePlan is the " +
      "operator's plan of the one route run (expectedPaid = routerPaid(splitter).amount after the claim; amounts inside " +
      "the bands of splitter.pending()). Per coin, FeesCollected books apportion(received, pluginTotals - " +
      "previous collectedTotals); CoinFeesConverted draws coinsIn / pending from every pending book (spec D1: every " +
      "pending sell row converts by that fraction at nativeOut / coinsIn). Accounts are hardhat's well-known local test " +
      "accounts (fork only).",
    recordedBy: "test/dogeos/barkswap/BarkMoney.fork.spec.ts (MWZ_RECORD_BARK_FIXTURES=1)",
    chainId: DOGEOS_CHIKYU_CHAIN_ID.toString(),
    forkBlock: forking?.blockNumber ?? 0,
    abiSource: "contracts/dogeos/barkswap/abi/{MwzBarkLauncher,MwzBarkPlugin,MwzBarkFeeSplitter}.abi.json",
    bookOrder: ["creatorBonding", "routerBonding", "creatorPost", "routerPost"],
    contracts: {
      MwzBarkLauncher: await s.launcher.getAddress(),
      MwzBarkPlugin: await s.plugin.getAddress(),
      MwzBarkFeeSplitter: splitter,
      CommunityRewardsVault: await s.community.getAddress(),
      WDOGE: BARKSWAP.wdoge,
      SwapRouter: BARKSWAP.swapRouter,
      BarkswapCommunityVault: BARKSWAP.communityVault,
    },
    coins: coins.map((L) => ({
      coin: L.coin,
      pool: L.pool,
      creator: creator.address,
      tickStart: L.tickStart,
      tickGrad: L.tickGrad,
      sqrtStart: L.sqrtStart.toString(),
      sqrtGrad: L.sqrtGrad.toString(),
      liqA: L.liqA.toString(),
      liqB: L.liqB.toString(),
      openAt: L.openAt.toString(),
    })),
    initialReadBack,
    steps,
    routePlan: {
      step: "route (run 1, bands at their maximum)",
      note:
        "squad = squadMax / 2, airdrop = (rsaMax - squad) / 3, recruiter = the rest of rsaMax; league = bands.weekly + " +
        "bands.monthly; protocol = total - league - recruiter - squad - airdrop.",
      runId: runId.toString(),
      expectedPaid: expectedPaid.toString(),
      pending: { total: total.toString(), bondingFees: B.toString(), gradFees: G.toString() },
      bands: {
        weekly: String(b.weekly),
        monthly: String(b.monthly),
        rsaMin: String(b.rsaMin),
        rsaMax: String(b.rsaMax),
        squadMax: String(b.squadMax),
      },
      recruiter: recruiter.toString(),
      squad: squad.toString(),
      airdrop: airdrop.toString(),
      accrualRoot,
    },
    logs,
  };
}

/** gen-8 splitter bands, off chain (MwzBarkFeeSplitter.bands). */
function bandsOf(B: bigint, G: bigint) {
  const league = (B * 3750n) / 10_000n;
  const weekly = (league * 3000n) / 10_000n;
  return {
    weekly,
    monthly: league - weekly,
    rsaMin: (B * 1500n) / 10_000n + (G * 1750n) / 10_000n,
    rsaMax: (B * 1750n) / 10_000n + (G * 2000n) / 10_000n,
    squadMax: ((B + G) * 250n) / 10_000n,
  };
}

/** Checks a recorded money fixture without a chain: every log decodes with the exported ABI to its recorded args; the
 *  launcher's and the plugin's books replayed from the events alone equal the read-back after every step; every collect
 *  is apportion(received, plugin delta), every conversion the pro-rata draw, and the route run is the plan inside the
 *  recomputed bands. Throws on the first mismatch. */
function verifyMoneyFixture(f: MoneyFixture): void {
  const fail = (what: string): never => {
    throw new Error(`barkMoneyFlow.json: ${what}`);
  };
  const eq = (a: unknown, b: unknown, what: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  const ifaces = Object.fromEntries(FIXTURE_CONTRACTS.map((n) => [n, new ethers.Interface(exportedAbi(n))]));
  for (const log of f.logs) {
    if (log.address !== f.contracts[log.contract]) fail(`${log.step} ${log.event}: address`);
    const ev = ifaces[log.contract].parseLog({ topics: log.topics, data: log.data });
    if (!ev || ev.name !== log.event) fail(`${log.step}: ${log.event} does not decode`);
    eq(plainArgs(ev!), log.args, `${log.step} ${log.event} args`);
  }
  const poolToCoin = Object.fromEntries(f.coins.map((c) => [String(c.pool), String(c.coin)]));
  const z4 = () => [0n, 0n, 0n, 0n];
  const st = {
    creatorOwed: {} as Record<string, bigint>,
    coinFees: {} as Record<string, bigint[]>,
    collected: {} as Record<string, { native: bigint[]; coin: bigint[] }>,
    plugin: {} as Record<string, { native: bigint[]; coin: bigint[] }>,
    routerOwed: 0n,
    bonding: 0n,
    grad: 0n,
    paid: { amount: 0n, bondingFees: 0n, gradFees: 0n },
    routed: { runs: 0n, amount: 0n, bondingFees: 0n, gradFees: 0n },
  };
  const init = f.initialReadBack;
  for (const c of f.coins) {
    const coin = String(c.coin);
    const r = init.coins[coin];
    st.creatorOwed[coin] = BigInt(r.creatorOwed);
    st.coinFees[coin] = r.coinFees.map(BigInt);
    st.collected[coin] = { native: r.collectedTotals.native.map(BigInt), coin: r.collectedTotals.coin.map(BigInt) };
    st.plugin[coin] = { native: r.pluginTotals.native.map(BigInt), coin: r.pluginTotals.coin.map(BigInt) };
  }
  st.routerOwed = BigInt(init.routerOwed);
  st.bonding = BigInt(init.pendingBondingFees);
  st.grad = BigInt(init.pendingGradFees);
  const splitter = f.contracts.MwzBarkFeeSplitter;
  for (const step of f.steps) {
    const logs = f.logs.filter((l) => l.transactionHash === step.transactionHash);
    for (const l of logs) {
      const a = l.args;
      if (l.event === "BarkSwap") {
        const coin = poolToCoin[a.pool];
        if (!coin || coin !== a.coin) fail(`${step.step}: BarkSwap pool/coin`);
        const book = a.buy ? st.plugin[coin].native : st.plugin[coin].coin;
        const base = a.phase === "0" ? 0 : 2;
        if (BigInt(a.netFee) > 0n) {
          book[base] += BigInt(a.creatorAmount);
          book[base + 1] += BigInt(a.netFee) - BigInt(a.creatorAmount);
        }
      } else if (l.event === "FeesCollected") {
        const coin = a.coin;
        const dN = st.plugin[coin].native.map((v, i) => v - st.collected[coin].native[i]);
        const dC = st.plugin[coin].coin.map((v, i) => v - st.collected[coin].coin[i]);
        eq(s4(apportion(BigInt(a.native), dN)), a.nativeBooks, `${step.step}: native apportion`);
        eq(s4(apportion(BigInt(a.coins), dC)), a.coinBooks, `${step.step}: coin apportion`);
        st.collected[coin] = { native: [...st.plugin[coin].native], coin: [...st.plugin[coin].coin] };
        const n = a.nativeBooks.map(BigInt);
        st.creatorOwed[coin] += n[0] + n[2];
        st.routerOwed += n[1] + n[3];
        st.bonding += n[1];
        st.coinFees[coin] = st.coinFees[coin].map((v, i) => v + BigInt(a.coinBooks[i]));
      } else if (l.event === "CoinFeesConverted") {
        const coin = a.coin;
        const books = st.coinFees[coin];
        if (BigInt(a.pending) !== sum(books)) fail(`${step.step}: pending`);
        const { taken, got } = draw(books, BigInt(a.coinsIn), BigInt(a.pending), BigInt(a.nativeOut));
        eq(s4(taken), a.coins, `${step.step}: draw coins`);
        eq(s4(got), a.native, `${step.step}: draw native`);
        st.coinFees[coin] = books.map((v, i) => v - taken[i]);
        st.creatorOwed[coin] += got[0] + got[2];
        st.routerOwed += got[1] + got[3];
        st.bonding += got[1];
      } else if (l.event === "GraduationFeeTaken") {
        st.routerOwed += BigInt(a.amount);
        st.grad += BigInt(a.amount);
      } else if (l.event === "CreatorClaimed") {
        if (BigInt(a.amount) !== st.creatorOwed[a.coin]) fail(`${step.step}: CreatorClaimed amount`);
        st.creatorOwed[a.coin] = 0n;
      } else if (l.event === "RouterClaimed") {
        if (a.router !== splitter) fail(`${step.step}: RouterClaimed router`);
        eq([a.amount, a.bondingFees, a.gradFees], [st.routerOwed, st.bonding, st.grad].map(String), `${step.step}: RouterClaimed`);
        st.paid.amount += st.routerOwed;
        st.paid.bondingFees += st.bonding;
        st.paid.gradFees += st.grad;
        st.routerOwed = 0n;
        st.bonding = 0n;
        st.grad = 0n;
      } else if (l.event === "Routed") {
        const p = f.routePlan;
        if (step.step !== p.step) fail("Routed outside the planned step");
        const total = st.paid.amount - st.routed.amount;
        const B = st.paid.bondingFees - st.routed.bondingFees;
        const G = st.paid.gradFees - st.routed.gradFees;
        eq([total, B, G].map(String), [p.pending.total, p.pending.bondingFees, p.pending.gradFees], "route pending");
        if (BigInt(p.expectedPaid) !== st.paid.amount) fail("expectedPaid != routerPaid");
        const bands = bandsOf(B, G);
        eq(Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, String(v)])), p.bands, "route bands");
        const rsa = BigInt(p.recruiter) + BigInt(p.squad) + BigInt(p.airdrop);
        if (rsa < bands.rsaMin || rsa > bands.rsaMax || BigInt(p.squad) > bands.squadMax) fail("plan outside the bands");
        const committed = bands.weekly + bands.monthly + rsa;
        if (committed > total) fail("plan commits more than the run holds (OutOfBand)");
        const run = a.run;
        eq(
          run,
          [total, B, G, bands.weekly, bands.monthly, BigInt(p.recruiter), BigInt(p.squad), BigInt(p.airdrop), total - committed].map(String),
          "Routed run",
        );
        if (a.runId !== p.runId || a.accrualRoot !== p.accrualRoot) fail("Routed id / root");
        st.routed = { runs: BigInt(p.runId), amount: st.paid.amount, bondingFees: st.paid.bondingFees, gradFees: st.paid.gradFees };
      } else if (l.event === "RouterParked") {
        fail("RouterParked is not part of this scenario");
      }
    }
    const r = step.readBack;
    for (const c of f.coins) {
      const coin = String(c.coin);
      const rc = r.coins[coin];
      eq(rc.creatorOwed, String(st.creatorOwed[coin]), `${step.step}: creatorOwed ${coin}`);
      eq(rc.coinFees, s4(st.coinFees[coin]), `${step.step}: coinFees ${coin}`);
      eq(rc.collectedTotals, { native: s4(st.collected[coin].native), coin: s4(st.collected[coin].coin) }, `${step.step}: collectedTotals ${coin}`);
      eq(rc.pluginTotals, { native: s4(st.plugin[coin].native), coin: s4(st.plugin[coin].coin) }, `${step.step}: plugin totals ${coin}`);
      // books == balances: the coin balance is the four pending books (no donation in this scenario)
      eq(rc.launcherCoinBalance, String(sum(st.coinFees[coin])), `${step.step}: coin balance ${coin}`);
    }
    eq([r.routerOwed, r.pendingBondingFees, r.pendingGradFees, r.parkedOwed], [st.routerOwed, st.bonding, st.grad, 0n].map(String), `${step.step}: bucket`);
    const creators = sum(f.coins.map((c) => st.creatorOwed[String(c.coin)]));
    eq(r.launcherNative, String(creators + st.routerOwed), `${step.step}: launcher native == books`);
    eq(r.routerPaid, { amount: String(st.paid.amount), bondingFees: String(st.paid.bondingFees), gradFees: String(st.paid.gradFees) }, `${step.step}: routerPaid`);
    eq(
      r.splitterPending,
      {
        total: String(st.paid.amount - st.routed.amount),
        bondingFees: String(st.paid.bondingFees - st.routed.bondingFees),
        gradFees: String(st.paid.gradFees - st.routed.gradFees),
      },
      `${step.step}: splitter pending`,
    );
    eq(
      r.splitterRouted,
      { runs: String(st.routed.runs), amount: String(st.routed.amount), bondingFees: String(st.routed.bondingFees), gradFees: String(st.routed.gradFees) },
      `${step.step}: splitter routed`,
    );
  }
  const kinds = new Set(f.logs.map((l) => `${l.contract}.${l.event}`));
  for (const k of [
    "MwzBarkPlugin.BarkSwap",
    "MwzBarkLauncher.FeesCollected",
    "MwzBarkLauncher.CoinFeesConverted",
    "MwzBarkLauncher.GraduationFeeTaken",
    "MwzBarkLauncher.RouterClaimed",
    "MwzBarkLauncher.CreatorClaimed",
    "MwzBarkFeeSplitter.Routed",
  ]) {
    if (!kinds.has(k)) fail(`missing ${k}`);
  }
}

// =====================================================================================================================

describe("Bark money flow on the Chikyu fork (t9)", function () {
  let s: MoneyStack;

  beforeEach(async function () {
    s = await loadFixture(moneyStackFixture);
  });

  after(function () {
    printGasTable("BarkMoney.fork.spec.ts");
  });

  /** A launched coin with trading open and the 60 s launch window over. */
  async function openCoin(opts: Parameters<typeof launchCoin>[1] = {}): Promise<LaunchResult> {
    const L = await launchCoin(s, opts);
    await time.increaseTo(L.openAt + 61n);
    return L;
  }

  /** The crossing buy: raiseOfA x 1.3 crosses A into B whatever was bought before. */
  async function graduate(L: LaunchResult, buyer = s.signers.trader) {
    return routerBuy(s, buyer, L.coin, (raiseOfA(L) * 13n) / 10n);
  }

  async function adminPool(L: LaunchResult): Promise<C> {
    const admin = await impersonate(BARKSWAP.admin);
    return L.poolContract.connect(admin) as C;
  }

  /** Round trips by `who` (buy `size`, sell everything bought): sell fees pile up in coins without moving the price. */
  async function churn(L: LaunchResult, rounds: number, size: bigint, who = s.signers.trader) {
    await approveRouter(who, L.coin);
    for (let i = 0; i < rounds; i++) {
      const b = barkSwapOf(s, await routerBuy(s, who, L.coin, size));
      await routerSell(s, who, L.coin, BigInt(b.coinAmount));
    }
  }

  describe("books == balances (spec invariant; audit 'Fee books', I-2)", function () {
    it("holds after every step of a two-coin run, and balance - books == the donation after native, WDOGE and coin donations", async function () {
      const { trader, trader2, operator, creator, outsider } = s.signers;
      const launcher = await s.launcher.getAddress();
      const X = await launchCoin(s, { firstBuy: 3n * WAD });
      const Y = await launchCoin(s, {});
      const coins = [X.coin, Y.coin];
      await expectBooksEqualBalances(s, coins, "after launches");
      await time.increaseTo((X.openAt > Y.openAt ? X.openAt : Y.openAt) + 61n);
      const d: Donations = { native: 0n, wdoge: 0n, coins: {} };
      const step = async (label: string, p: Promise<unknown>) => {
        await p;
        await expectBooksEqualBalances(s, coins, label, d);
      };
      await approveRouter(trader, X.coin);
      await approveRouter(trader, Y.coin);
      const bx = barkSwapOf(s, await routerBuy(s, trader, X.coin, 25n * WAD));
      await step("X buy", Promise.resolve());
      await step("X sell", routerSell(s, trader, X.coin, BigInt(bx.coinAmount) / 2n));
      const by = barkSwapOf(s, await routerBuy(s, trader2, Y.coin, 4n * WAD));
      await approveRouter(trader2, Y.coin);
      await step("Y sell", routerSell(s, trader2, Y.coin, BigInt(by.coinAmount) / 2n));
      await step("X collect", collectChecked(s, X));
      await step("Y collect", collectChecked(s, Y));
      // donations: native forced in (no call), WDOGE and coins transferred straight to the launcher
      d.native = 7n * WAD;
      await setNativeBalance(launcher, (await ethers.provider.getBalance(launcher)) + d.native);
      d.wdoge = 3n * WAD;
      await (await s.barkswap.wdoge.connect(outsider).deposit({ value: d.wdoge })).wait();
      await (await (s.barkswap.wdoge.connect(outsider) as C).transfer(launcher, d.wdoge)).wait();
      d.coins![X.coin] = 1_000n * WAD;
      await (await (X.coinContract.connect(trader) as C).transfer(launcher, d.coins![X.coin])).wait();
      await expectBooksEqualBalances(s, coins, "after donations", d);
      await step("X graduates", graduate(X));
      await step("X post buy", routerBuy(s, trader, X.coin, 2n * WAD));
      await step("X post sell", routerSell(s, trader, X.coin, 3_000_000n * WAD));
      await step("X collect", collectChecked(s, X));
      await time.increase(600);
      // the donated coins are never offered to the pool: convert draws only the booked coins
      const conv = await convertChecked(s, X);
      expect(conv.coinsIn).to.be.at.most(conv.pending);
      await expectBooksEqualBalances(s, coins, "X convert", d);
      await step("Y convert", convertChecked(s, Y));
      await step("claimCreator X", s.launcher.connect(creator).claimCreator(X.coin, creator.address).then((t: any) => t.wait()));
      await step("claimRouter", s.launcher.connect(operator).claimRouter().then((t: any) => t.wait()));
      await routerSell(s, trader, X.coin, 1_000_000n * WAD);
      await step("X collect again", collectChecked(s, X, outsider));
      // the donation is still exactly where it was: nothing booked, paid or swapped it
      expect(await ethers.provider.getBalance(launcher)).to.equal(
        BigInt(await s.launcher.creatorOwed(X.coin)) + BigInt(await s.launcher.creatorOwed(Y.coin)) + BigInt(await s.launcher.routerOwed()) + d.native,
      );
      expect(await s.barkswap.wdoge.balanceOf(launcher)).to.equal(d.wdoge);
      expect(await balanceOf(X.coin, launcher)).to.equal(sum(await coinBooks(s, X.coin)) + d.coins![X.coin]);
    });
  });

  describe("collect: exact books and the measured rounding tolerance (spec 'within a stated rounding tolerance')", function () {
    it("measures |collected - plugin-booked| per swap per book over one-, multi-step and crossing swaps and pins it", async function () {
      const L = await openCoin({ firstBuy: WAD });
      const { trader, trader2 } = s.signers;
      await approveRouter(trader, L.coin);
      await approveRouter(trader2, L.coin);
      await collectChecked(s, L); // the first buy's fee
      const rows: Array<{ label: string; book: string; err: bigint; gross: bigint; steps: number }> = [];
      const one = async (label: string, rc: ContractTransactionReceipt) => {
        const sw = barkSwapOf(s, rc);
        const steps = eventsOf(rc, L.poolContract, "Swap").length;
        const c = await collectChecked(s, L);
        recordGas(`collect after one ${sw.buy ? "buy" : "sell"}`, c.rc.gasUsed);
        const book = `${sw.phase === 0n ? "bonding" : "post"} ${sw.buy ? "WDOGE" : "coin"}`;
        // a swap touches one token's books only
        expect(sw.buy ? c.errC : c.errN, `${label}: other token`).to.equal(0n);
        // the creators never carry rounding: their books are the plugin's gross-based amounts to the wei (B10)
        expect([c.nativeBooks[0], c.nativeBooks[2], c.coinBooks[0], c.coinBooks[2]], `${label}: creators`).to.deep.equal([c.dN[0], c.dN[2], c.dC[0], c.dC[2]]);
        rows.push({ label, book, err: sw.buy ? c.errN : c.errC, gross: BigInt(sw.grossFee), steps });
      };
      const sizes = [10n ** 15n, 3n * 10n ** 17n, WAD, 7n * WAD, 33n * WAD, 120n * WAD];
      for (const size of sizes) {
        const rb = await routerBuy(s, trader2, L.coin, size);
        await one(`bonding buy ${ethers.formatEther(size)} DOGE`, rb);
        const sold = BigInt(barkSwapOf(s, rb).coinAmount) / 3n;
        await one(`bonding sell ${ethers.formatEther(sold)} coins`, await routerSell(s, trader2, L.coin, sold));
      }
      await one("crossing buy (A into B, inline graduation burn)", await graduate(L));
      for (const size of sizes) {
        await one(`post buy ${ethers.formatEther(size)} DOGE`, await routerBuy(s, trader2, L.coin, size));
        const sold = size * 100_000n; // 100 to 12M coins
        await one(`post sell ${ethers.formatEther(sold)} coins`, await routerSell(s, trader, L.coin, sold));
      }
      await one("post sell crossing back into A (multi-step)", await routerSell(s, trader2, L.coin, 300_000_000n * WAD));
      await one("bonding buy crossing up into B again", await routerBuy(s, trader2, L.coin, raiseOfA(L)));

      // a batch: ten swaps, one collect; the error stays within ten per-swap tolerances
      for (let i = 0; i < 5; i++) {
        await routerBuy(s, trader2, L.coin, WAD + BigInt(i) * 10n ** 17n);
        await routerSell(s, trader, L.coin, 2_000_000n * WAD + BigInt(i));
      }
      const batch = await collectChecked(s, L);

      const maxAbs = rows.reduce((m, r) => (absb(r.err) > m ? absb(r.err) : m), 0n);
      const minErr = rows.reduce((m, r) => (r.err < m ? r.err : m), 0n);
      const table = rows.map((r) => `      ${String(r.err).padStart(4)} wei  ${r.book.padEnd(13)} steps ${r.steps}  ${r.label}`).join("\n");
      console.log(
        `\n    Rounding: collected - plugin-booked, per swap per book (t9 measurement)\n${table}\n` +
          `      batch of 10 swaps: WDOGE ${batch.errN} wei, coin ${batch.errC} wei\n` +
          `      measured max |error| per swap per book: ${maxAbs} wei (most against us: ${minErr} wei; audit derived 16)\n`,
      );
      expect(maxAbs, "measured tolerance (pinned)").to.be.at.most(MEASURED_TOLERANCE_WEI);
      expect(minErr, "rounding against us (pinned)").to.be.at.least(-MEASURED_AGAINST_US_WEI);
      expect(absb(batch.errN)).to.be.at.most(5n * MEASURED_TOLERANCE_WEI);
      expect(absb(batch.errC)).to.be.at.most(5n * MEASURED_TOLERANCE_WEI);
      // (the creators carried no rounding in any collect above: asserted per swap in one())
    });

    it("books exactly what it received: creators their plugin amounts, router bonding its amount, router post the rest", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      await approveRouter(trader, L.coin);
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 40n * WAD));
      await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 2n);
      await graduate(L);
      await routerBuy(s, trader, L.coin, 5n * WAD);
      await routerSell(s, trader, L.coin, 2_000_000n * WAD);
      const c = await collectChecked(s, L);
      recordGas("collect (both phases, WDOGE and coin)", c.rc.gasUsed);
      // creators exactly the plugin's amounts (B10); router bonding exactly when the rest covers both router books
      expect([c.nativeBooks[0], c.nativeBooks[2]]).to.deep.equal([c.dN[0], c.dN[2]]);
      expect([c.coinBooks[0], c.coinBooks[2]]).to.deep.equal([c.dC[0], c.dC[2]]);
      expect(absb(c.nativeBooks[3] - c.dN[3])).to.be.at.most(4n * MEASURED_TOLERANCE_WEI);
      // nothing to collect: NothingToCollect, the books unchanged
      await expect(s.launcher.connect(s.signers.keeper).collect(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(
        s.launcher,
        "NothingToCollect",
      );
      await expect(s.launcher.collect(s.signers.outsider.address)).to.be.revertedWithCustomError(s.launcher, "UnknownCoin");
      await expectBooksEqualBalances(s, [L.coin], "after collect");
      // principal untouched: A lost only the graduation burn, B nothing
      const launcher = await s.launcher.getAddress();
      expect(await positionLiquidity(L.pool, launcher, L.tickStart, L.tickGrad)).to.equal(L.liqA - (L.liqA * 200n) / 10_000n);
      expect(await positionLiquidity(L.pool, launcher, L.tickGrad, TICK_MAX)).to.equal(L.liqB);
    });
  });

  describe("creator amounts on the GROSS fee (B10) under Barkswap's community fee (impersonated admin)", function () {
    it("bonding and post: exactly 560 bps / 50% of the gross fee while the cut leaves room (30, 500), capped at the net fee above it (950 / 600), nothing at 1000", async function () {
      const L = await openCoin();
      const { trader, keeper } = s.signers;
      const pool = await adminPool(L);
      await approveRouter(trader, L.coin);
      const phaseRun = async (phase: "bonding" | "post", cf: bigint) => {
        if (BigInt((await poolState(L.pool)).communityFee) !== cf) {
          const rc = (await (await pool.setCommunityFee(cf)).wait())!;
          expect(eventsOf(rc, L.poolContract, "CommunityFee").map((e) => e.args[0])).to.deep.equal([cf]);
        }
        const cw0 = await communityFeesOf(L.pool, BARKSWAP.wdoge);
        const buy = barkSwapOf(s, await routerBuy(s, trader, L.coin, 6n * WAD));
        const cw = (await communityFeesOf(L.pool, BARKSWAP.wdoge)) - cw0;
        const cc0 = await communityFeesOf(L.pool, L.coin);
        const sell = barkSwapOf(s, await routerSell(s, trader, L.coin, BigInt(buy.coinAmount) / 2n));
        const cc = (await communityFeesOf(L.pool, L.coin)) - cc0;
        for (const [sw, cut] of [
          [buy, cw],
          [sell, cc],
        ] as const) {
          const gross = BigInt(sw.grossFee);
          const net = gross - (gross * cf) / 1000n;
          const b10 = phase === "bonding" ? (gross * 560n) / 10_000n : (gross * 50n) / 100n;
          expect(sw.phase).to.equal(phase === "bonding" ? 0n : 1n);
          expect(sw.communityFee, "the cut read at swap time").to.equal(cf);
          expect(sw.netFee).to.equal(net);
          expect(sw.creatorAmount, `${phase} creator at cf ${cf}`).to.equal(b10 < net ? b10 : net);
          // Barkswap's vault got its cut of the pool's per-step fee (>= the plugin's estimate by rounding)
          expect(absb(cut - (gross - net)), `${phase} community cut at cf ${cf}`).to.be.at.most(MEASURED_TOLERANCE_WEI);
        }
        if (cf === 1000n) {
          // nothing reached our positions and the plugin booked nothing
          await expect(s.launcher.connect(keeper).collect(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(
            s.launcher,
            "NothingToCollect",
          );
          return;
        }
        const c = await collectChecked(s, L);
        const ci = phase === "bonding" ? 0 : 2;
        const capped = BigInt(buy.creatorAmount) === BigInt(buy.netFee);
        if (!capped) {
          // B10: the creator's collected amount is the plugin's gross-based amount, to the wei
          expect(c.nativeBooks[ci]).to.equal(BigInt(buy.creatorAmount));
          expect(c.coinBooks[ci]).to.equal(BigInt(sell.creatorAmount));
        } else {
          // the creator takes the whole net fee first; the router books get nothing but rounding
          expect(absb(c.nativeBooks[ci] - BigInt(buy.creatorAmount))).to.be.at.most(MEASURED_TOLERANCE_WEI);
          expect(absb(c.coinBooks[ci] - BigInt(sell.creatorAmount))).to.be.at.most(MEASURED_TOLERANCE_WEI);
          expect(c.dN[ci + 1]).to.equal(0n);
        }
        await expectBooksEqualBalances(s, [L.coin], `${phase} cf ${cf}`);
      };
      for (const cf of [30n, 500n, 950n, 1000n]) await phaseRun("bonding", cf);
      await (await pool.setCommunityFee(30)).wait();
      await graduate(L);
      await collectChecked(s, L);
      for (const cf of [30n, 500n, 600n, 1000n]) await phaseRun("post", cf);
    });
  });

  describe("router post absorbs rounding and unbooked surplus (audit 'Unbooked surplus')", function () {
    async function surplusCase(L: LaunchResult, act: () => Promise<bigint>, label: string) {
      const bondingBefore = BigInt(await s.launcher.pendingBondingFees());
      const expected = await act();
      const c = await collectChecked(s, L);
      // nothing booked by the plugin since the last collect: every received wei is surplus, all in router post
      expect(c.dN.concat(c.dC)).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
      expect([c.nativeBooks[0], c.nativeBooks[1], c.nativeBooks[2]]).to.deep.equal([0n, 0n, 0n]);
      expect(c.nativeBooks[3], `${label}: router post`).to.equal(c.native);
      expect(absb(c.native - expected), `${label}: surplus received`).to.be.at.most(MEASURED_TOLERANCE_WEI);
      // no band grows: the bonding base (B) is untouched by surplus
      expect(BigInt(await s.launcher.pendingBondingFees())).to.equal(bondingBefore);
      await expectBooksEqualBalances(s, [L.coin], label);
      return c;
    }

    it("a flash loan's fee and an overpaid flash land in router post", async function () {
      const L = await openCoin();
      const { trader, outsider } = s.signers;
      await routerBuy(s, trader, L.coin, 30n * WAD);
      await collectChecked(s, L);
      const art = await compileInline("BarkFlashProbe", FLASH_PROBE_SOURCE);
      const probe = (await new ethers.ContractFactory(art.abi, art.bytecode, outsider).deploy()) as unknown as C;
      await probe.waitForDeployment();
      const probeAddr = await probe.getAddress();
      await (await s.barkswap.wdoge.connect(outsider).deposit({ value: 5n * WAD })).wait();
      await (await (s.barkswap.wdoge.connect(outsider) as C).transfer(probeAddr, 5n * WAD)).wait();
      const cf = BigInt((await poolState(L.pool)).communityFee);
      let flashRc: ContractTransactionReceipt | undefined;
      await surplusCase(
        L,
        async () => {
          flashRc = (await (await probe.borrow(L.pool, 0n, 10n * WAD, 0n, WAD)).wait())!;
          const fl = eventsOf(flashRc, L.poolContract, "Flash")[0].args;
          expect(fl.amount1).to.equal(10n * WAD);
          const paid1 = BigInt(fl.paid1);
          expect(paid1, "the flash fee plus the tip").to.be.greaterThan(WAD);
          return paid1 - (paid1 * cf) / 1000n;
        },
        "flash",
      );
      recordGas("flash (probe, 10 DOGE)", flashRc!.gasUsed);
    });

    it("WDOGE and coins sent straight to the pool land in router post (Algebra hands the excess to in-range liquidity)", async function () {
      const L = await openCoin();
      const { trader, outsider } = s.signers;
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 30n * WAD));
      await collectChecked(s, L);
      await (await s.barkswap.wdoge.connect(outsider).deposit({ value: 2n * WAD })).wait();
      const c = await surplusCase(
        L,
        async () => {
          await (await (s.barkswap.wdoge.connect(outsider) as C).transfer(L.pool, 2n * WAD)).wait();
          await (await (L.coinContract.connect(trader) as C).transfer(L.pool, BigInt(b.coinAmount) / 10n)).wait();
          return 2n * WAD;
        },
        "direct transfer",
      );
      expect(c.coinBooks.slice(0, 3)).to.deep.equal([0n, 0n, 0n]);
      expect(absb(c.coins - BigInt(b.coinAmount) / 10n)).to.be.at.most(MEASURED_TOLERANCE_WEI);
    });

    it("fees charged while an admin had the after-swap hook off are unbooked and land in router post; restore books again", async function () {
      const L = await openCoin();
      const { trader } = s.signers;
      await approveRouter(trader, L.coin);
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 30n * WAD));
      await collectChecked(s, L);
      const pool = await adminPool(L);
      await (await pool.setPluginConfig(133)).wait(); // before-swap (fee) + position guard + dynamic fee, no after-swap
      const cf = BigInt((await poolState(L.pool)).communityFee);
      let unbookedSell = 0n;
      await surplusCase(
        L,
        async () => {
          const rb = await routerBuy(s, trader, L.coin, 10n * WAD);
          expect(eventsOf(rb, s.plugin, "BarkSwap")).to.have.length(0);
          const fee = BigInt(eventsOf(rb, L.poolContract, "Swap")[0].args.overrideFee);
          expect(fee).to.equal(19_607n); // charged at the bonding rate, never booked
          const rs = await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 4n);
          const sellIn = BigInt(eventsOf(rs, L.poolContract, "Swap")[0].args.amount0);
          const sellFee = (sellIn * 20_000n) / 1_000_000n;
          unbookedSell = sellFee - (sellFee * cf) / 1000n;
          const gross = (10n * WAD * fee) / 1_000_000n;
          return gross - (gross * cf) / 1000n;
        },
        "hooks off",
      ).then((c) => {
        expect(c.coinBooks.slice(0, 3)).to.deep.equal([0n, 0n, 0n]);
        expect(absb(c.coinBooks[3] - unbookedSell)).to.be.at.most(4n * MEASURED_TOLERANCE_WEI);
      });
      await (await s.launcher.connect(s.signers.keeper).restore(L.coin)).wait();
      const back = barkSwapOf(s, await routerBuy(s, trader, L.coin, WAD));
      const c = await collectChecked(s, L);
      expect(c.nativeBooks[0]).to.equal(BigInt(back.creatorAmount));
    });
  });

  describe("convert (spec Money flow 4, audit 'convert')", function () {
    it("converts the full capped amount: the price stops exactly at the 1% limit (CONVERT_SQRT_FACTOR_E9 pinned to CONVERT_IMPACT_BPS, I-8), the rest waits for the next interval", async function () {
      // I-8: f = ceil(sqrt(1 - CONVERT_IMPACT_BPS / 1e4) x 1e9): f^2 >= 0.99e18 > (f - 1)^2
      const impact = BigInt(await s.launcher.CONVERT_IMPACT_BPS());
      expect(impact).to.equal(100n);
      const target = ((10_000n - impact) * 10n ** 18n) / 10_000n;
      expect(CONVERT_SQRT_FACTOR_E9 * CONVERT_SQRT_FACTOR_E9).to.be.at.least(target);
      expect((CONVERT_SQRT_FACTOR_E9 - 1n) * (CONVERT_SQRT_FACTOR_E9 - 1n)).to.be.lessThan(target);
      expect(await s.launcher.CONVERT_INTERVAL()).to.equal(600n);

      const L = await openCoin();
      await routerBuy(s, s.signers.trader2, L.coin, 200n * WAD); // price well above the start
      await churn(L, 6, 60n * WAD);
      await collectChecked(s, L);
      const first = await convertChecked(s, L);
      recordGas("convert (capped at 1%)", first.rc.gasUsed);
      expect(first.coinsIn, "the cap binds").to.be.lessThan(first.pending);
      // the contract's limit is exactly ceil(sqrtP x f / 1e9): the price ends there
      expect(first.priceAfter).to.equal(ceilDiv(first.priceBefore * CONVERT_SQRT_FACTOR_E9, 1_000_000_000n));
      // the rest waits: refused inside the interval, converted (capped again) after it
      await expect(s.launcher.convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "ConversionTooSoon");
      await time.increase(600);
      const second = await convertChecked(s, L);
      expect(second.pending).to.equal(first.pending - first.coinsIn);
      let last = second;
      for (let i = 0; i < 20 && sum(await coinBooks(s, L.coin)) > 0n; i++) {
        await time.increase(600);
        last = await convertChecked(s, L);
      }
      expect(sum(await coinBooks(s, L.coin)), "everything converts within a few intervals").to.equal(0n);
      recordGas("convert (everything pending, under the cap)", last.rc.gasUsed);
      expect(last.coinsIn).to.equal(last.pending);
      await expectBooksEqualBalances(s, [L.coin], "after conversions");
      await time.increase(600);
      await expect(s.launcher.convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "NothingToConvert");
      await expect(s.launcher.convert(s.signers.outsider.address)).to.be.revertedWithCustomError(s.launcher, "UnknownCoin");
    });

    it("whoever calls converts the same full capped amount: a dust call cannot use up an interval; the interval binds every caller", async function () {
      const L = await openCoin();
      const { keeper, outsider, creator } = s.signers;
      await routerBuy(s, s.signers.trader2, L.coin, 200n * WAD);
      await churn(L, 6, 60n * WAD);
      await collectChecked(s, L);
      const at = (await time.latest()) + 5;
      const snap = await network.provider.send("evm_snapshot", []);
      await time.setNextBlockTimestamp(at);
      const byKeeper = await convertChecked(s, L, keeper);
      await network.provider.send("evm_revert", [snap]);
      await time.setNextBlockTimestamp(at);
      const byOutsider = await convertChecked(s, L, outsider);
      expect([byOutsider.pending, byOutsider.coinsIn, byOutsider.nativeOut]).to.deep.equal([byKeeper.pending, byKeeper.coinsIn, byKeeper.nativeOut]);
      expect(byOutsider.taken).to.deep.equal(byKeeper.taken);
      expect(byOutsider.got).to.deep.equal(byKeeper.got);
      // the interval: 599 s later still refused for anyone, 600 s later open again
      const stamp = BigInt((await s.launcher.launches(L.coin)).lastConvertAt);
      await time.setNextBlockTimestamp(stamp + 599n);
      await expect(s.launcher.connect(creator).convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(
        s.launcher,
        "ConversionTooSoon",
      );
      expect((await s.launcher.launches(L.coin)).lastConvertAt).to.equal(stamp);
      await time.setNextBlockTimestamp(stamp + 600n);
      const next = await convertChecked(s, L, creator);
      expect(next.coinsIn).to.be.greaterThan(0n);
    });

    it("draws the same fraction from all four pending books and returns the DOGE pro rata; CoinFeesConverted carries pending", async function () {
      const L = await openCoin();
      const { trader, trader2 } = s.signers;
      await routerBuy(s, trader2, L.coin, 150n * WAD);
      await churn(L, 4, 50n * WAD);
      await collectChecked(s, L); // bonding coin books
      await graduate(L);
      await approveRouter(trader2, L.coin);
      await churn(L, 4, 80n * WAD, trader2);
      await collectChecked(s, L); // post coin books
      const books = await coinBooks(s, L.coin);
      expect(books.every((b) => b > 0n), "all four coin books pending").to.equal(true);
      const c = await convertChecked(s, L);
      recordGas("convert (four books, capped)", c.rc.gasUsed);
      expect(c.coinsIn).to.be.lessThan(c.pending);
      // the same fraction from every book, within the floors (<= 3 coins placed router post first)
      for (let i = 0; i < 4; i++) {
        const exact = (books[i] * c.coinsIn) / c.pending;
        expect(c.taken[i] - exact).to.be.within(0n, 3n);
      }
      // the event's fields: pending, coinsIn, nativeOut and both per-book arrays (MwzBarkFeeBooks order)
      expect(Object.keys(c.ev)).to.deep.equal(["coin", "pending", "coinsIn", "nativeOut", "coins", "native"]);
      const avg = (c.nativeOut * WAD) / c.coinsIn;
      for (let i = 0; i < 4; i++) {
        if (c.taken[i] > 10n ** 9n) expect(absb((c.got[i] * WAD) / c.taken[i] - avg)).to.be.at.most(avg / 10n ** 6n);
      }
      await expectBooksEqualBalances(s, [L.coin], "after a four-book conversion");
    });

    it("no conversion inside the 60 s launch window: refused at openAt + 59, runs at openAt + 60", async function () {
      const L = await launchCoin(s, { firstBuy: 30n * WAD });
      const { creator } = s.signers;
      await approveRouter(creator, L.coin);
      await time.setNextBlockTimestamp(L.openAt + 10n);
      await routerSell(s, creator, L.coin, 50_000_000n * WAD); // a launch-fee sell (~75%)
      await collectChecked(s, L);
      expect(sum(await coinBooks(s, L.coin))).to.be.greaterThan(0n);
      await time.setNextBlockTimestamp(L.openAt + 59n);
      await expect(s.launcher.convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "ConversionInLaunchWindow");
      await time.setNextBlockTimestamp(L.openAt + 60n);
      const c = await convertChecked(s, L);
      expect(c.coinsIn).to.be.greaterThan(0n);
    });

    it("F2: a conversion near the start price stops exactly at it, then refuses (NothingToConvert) until the price rises", async function () {
      const L = await openCoin();
      const { trader, outsider } = s.signers;
      await churn(L, 4, 5n * WAD); // coin fees pending (each sell leaves its own fee outstanding: ~2% of its coins)
      await collectChecked(s, L);
      // coins from outside the curve (the released 2% reserve, moved to a seller) take the price to just above the
      // start (a round trip never can: every sell leaves its own fee outstanding)
      const lock = await impersonate(await s.reserveLock.getAddress());
      await (await (L.coinContract.connect(lock) as C).transfer(outsider.address, CREATOR_RESERVE)).wait();
      await approveRouter(outsider, L.coin);
      await routerSell(s, outsider, L.coin, CREATOR_RESERVE, { limit: L.sqrtStart + L.sqrtStart / 1000n });
      await collectChecked(s, L);
      const g = await poolState(L.pool);
      expect((g.price * CONVERT_SQRT_FACTOR_E9) / 1_000_000_000n, "within 1% of the start: the floor binds").to.be.lessThan(L.sqrtStart);
      const c = await convertChecked(s, L);
      recordGas("convert (stopped at the start price, F2)", c.rc.gasUsed);
      expect(c.limit).to.equal(L.sqrtStart);
      expect(c.priceAfter).to.equal(L.sqrtStart);
      expect(c.coinsIn).to.be.lessThan(c.pending);
      await time.increase(600);
      await expect(s.launcher.convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, "NothingToConvert");
      await routerBuy(s, trader, L.coin, 20n * WAD);
      const again = await convertChecked(s, L);
      expect(again.coinsIn).to.be.greaterThan(0n);
    });

    it("refuses with a non-zero lastFee (ConversionFeeNotZero) or a foreign plugin (ForeignPlugin); books and stamp unchanged; restore re-enables", async function () {
      const L = await openCoin();
      const { trader, keeper } = s.signers;
      await routerBuy(s, s.signers.trader2, L.coin, 100n * WAD);
      await churn(L, 2, 40n * WAD);
      await collectChecked(s, L);
      const books = await coinBooks(s, L.coin);
      const pool = await adminPool(L);
      const refused = async (err: string) => {
        await expect(s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.launcher, err);
        expect(await coinBooks(s, L.coin)).to.deep.equal(books);
        expect((await s.launcher.launches(L.coin)).lastConvertAt).to.equal(0n);
      };
      // flag off and lastFee 3000
      await (await pool.setPluginConfig(7)).wait();
      await (await pool.setFee(3000)).wait();
      await refused("ConversionFeeNotZero");
      // flag back on with lastFee still 3000 (the override would be 0 for a conversion: the pool would charge 0.3%)
      await (await pool.setPluginConfig(135)).wait();
      await refused("ConversionFeeNotZero");
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();
      // a foreign plugin could tax the sell
      await (await pool.setPlugin(s.signers.outsider.address)).wait();
      await refused("ForeignPlugin");
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();
      const c = await convertChecked(s, L);
      expect(c.pending).to.equal(sum(books));
    });

    for (const phase of ["bonding", "post"] as const) {
      it(`a sandwich around convert loses money (${phase}: the attacker pays ${phase === "bonding" ? "2 x 2%" : "2 x 1%"} against the 1% cap)`, async function () {
        const L = await openCoin();
        const { trader2: attacker, keeper } = s.signers;
        if (phase === "post") await graduate(L);
        await routerBuy(s, s.signers.trader, L.coin, 100n * WAD);
        await churn(L, 6, 60n * WAD);
        await collectChecked(s, L);
        // the attacker holds coins bought earlier
        await approveRouter(attacker, L.coin);
        const held = BigInt(barkSwapOf(s, await routerBuy(s, attacker, L.coin, 60n * WAD)).coinAmount);
        await time.increase(600);
        const roundTrip = async (withConvert: boolean) => {
          const sell = barkSwapOf(s, await routerSell(s, attacker, L.coin, held));
          let conv: Converted | undefined;
          if (withConvert) conv = await convertChecked(s, L, keeper);
          const buy = barkSwapOf(s, await routerBuy(s, attacker, L.coin, BigInt(sell.nativeAmount)));
          return { sell, buy, conv, back: BigInt(buy.coinAmount) };
        };
        const snap = await network.provider.send("evm_snapshot", []);
        const withConv = await roundTrip(true);
        await network.provider.send("evm_revert", [snap]);
        const without = await roundTrip(false);
        expect(withConv.conv!.coinsIn, "the conversion is capped (largest move)").to.be.lessThan(withConv.conv!.pending);
        const gain = withConv.back - without.back;
        // the attacker's fees on both legs, in coins (the buy fee valued at the buy's own average price)
        const fees =
          BigInt(withConv.sell.grossFee) + (BigInt(withConv.buy.grossFee) * withConv.back) / BigInt(withConv.buy.curveAmount);
        console.log(
          `      sandwich (${phase}): sold ${ethers.formatEther(held)}, back ${ethers.formatEther(withConv.back)} ` +
            `(without the conversion ${ethers.formatEther(without.back)}); conversion gain ${ethers.formatEther(gain)} < fees ${ethers.formatEther(fees)}`,
        );
        expect(gain, "the conversion helps the buy-back").to.be.greaterThan(0n);
        expect(gain, "but by less than the attacker's fees").to.be.lessThan(fees);
        expect(withConv.back, "the attacker ends with fewer coins than it sold").to.be.lessThan(held);
      });
    }
  });

  describe("graduation fee: the graduation book only, creator 0%, not cut by the community fee", function () {
    it("at a 50% community fee the burn is credited whole to pendingGradFees and routes as G", async function () {
      const L = await openCoin();
      const pool = await adminPool(L);
      await (await pool.setCommunityFee(500)).wait();
      const owed0 = BigInt(await s.launcher.creatorOwed(L.coin));
      const bonding0 = BigInt(await s.launcher.pendingBondingFees());
      const cw0 = await communityFeesOf(L.pool, BARKSWAP.wdoge);
      const rc = await graduate(L);
      const sw = barkSwapOf(s, rc);
      const taken = eventsOf(rc, s.launcher, "GraduationFeeTaken")[0].args;
      const burnLiq = (L.liqA * 200n) / 10_000n;
      const amount = amount1Delta(L.sqrtStart, L.sqrtGrad, burnLiq, false);
      expect([taken.amount, taken.liquidity, taken.inlineCall]).to.deep.equal([amount, burnLiq, true]);
      // Barkswap's vault got only its cut of the crossing swap's fee, nothing of the burn
      const cw = (await communityFeesOf(L.pool, BARKSWAP.wdoge)) - cw0;
      expect(absb(cw - (BigInt(sw.grossFee) - BigInt(sw.netFee)))).to.be.at.most(MEASURED_TOLERANCE_WEI);
      expect(BigInt(await s.launcher.pendingGradFees())).to.equal(amount);
      expect(BigInt(await s.launcher.routerOwed())).to.equal(amount);
      expect(BigInt(await s.launcher.creatorOwed(L.coin))).to.equal(owed0);
      expect(BigInt(await s.launcher.pendingBondingFees())).to.equal(bonding0);
      // the crossing swap's own fee is a bonding fee (A12), booked at collect, never in the graduation book
      const c = await collectChecked(s, L);
      expect(c.nativeBooks[0]).to.equal(BigInt(sw.creatorAmount));
      expect(BigInt(await s.launcher.pendingGradFees())).to.equal(amount);
      const claim = (await (await s.launcher.connect(s.signers.operator).claimRouter()).wait())!;
      const ev = eventsOf(claim, s.launcher, "RouterClaimed")[0].args;
      expect(ev.gradFees).to.equal(amount);
      expect((await s.launcher.routerPaid(await s.splitter.getAddress())).gradFees).to.equal(amount);
      const [, , G] = await s.splitter.pending();
      expect(G).to.equal(amount);
    });
  });

  describe("B11: a route run never reverts OutOfBand whatever the community fee", function () {
    it("community fee 0, 30 (live) and 1000 (impersonated admin): routes at the band maximum with expectedPaid == routerPaid", async function () {
      const { operator, keeper, trader } = s.signers;
      const splitter = await s.splitter.getAddress();
      let runId = 0n;
      const coins: string[] = [];
      for (const cf of [0n, 30n, 1000n]) {
        const L = await launchCoin(s, {});
        coins.push(L.coin);
        const pool = await adminPool(L);
        if (cf !== 30n) await (await pool.setCommunityFee(cf)).wait();
        await time.increaseTo(L.openAt + 61n);
        await approveRouter(trader, L.coin);
        const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 30n * WAD));
        await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 2n);
        await graduate(L);
        await routerBuy(s, trader, L.coin, 5n * WAD);
        await routerSell(s, trader, L.coin, 5_000_000n * WAD);
        if (cf !== 1000n) {
          await collectChecked(s, L);
          await time.increase(600);
          await convertChecked(s, L);
        } else {
          // nothing reached our positions: the run holds only the (uncut) graduation fee
          await expect(s.launcher.connect(keeper).collect(L.coin, { gasLimit: 3_000_000n })).to.be.revertedWithCustomError(
            s.launcher,
            "NothingToCollect",
          );
        }
        const claim = (await (await s.launcher.connect(operator).claimRouter()).wait())!;
        recordGas(`claimRouter (operator, cf ${cf})`, claim.gasUsed);
        const paid = await s.launcher.routerPaid(splitter);
        const [total, B, G] = (await s.splitter.pending()).map(BigInt);
        if (cf === 1000n) expect(B).to.equal(0n);
        expect(G).to.equal(amount1Delta(L.sqrtStart, L.sqrtGrad, (L.liqA * 200n) / 10_000n, false));
        const bands = await s.splitter.bands(B, G);
        expect(bandsOf(B, G)).to.deep.equal({
          weekly: bands.weekly,
          monthly: bands.monthly,
          rsaMin: bands.rsaMin,
          rsaMax: bands.rsaMax,
          squadMax: bands.squadMax,
        });
        // the worst case for OutOfBand: recruiter + squad + airdrop at the band maximum, squad at its maximum
        const squad = BigInt(bands.squadMax);
        const airdrop = (BigInt(bands.rsaMax) - squad) / 2n;
        const recruiter = BigInt(bands.rsaMax) - squad - airdrop;
        const committed = BigInt(bands.weekly) + BigInt(bands.monthly) + BigInt(bands.rsaMax);
        expect(committed, `cf ${cf}: committed <= total`).to.be.at.most(total);
        runId++;
        // a plan against another cumulative amount is refused (PaidMismatch); the right one routes
        await expect(
          s.splitter.connect(operator).route(runId, BigInt(paid.amount) - 1n, recruiter, squad, airdrop, ethers.ZeroHash),
        ).to.be.revertedWithCustomError(s.splitter, "PaidMismatch");
        const rc = (await (
          await s.splitter.connect(operator).route(runId, paid.amount, recruiter, squad, airdrop, ethers.id(`run-${cf}`), { gasLimit: 1_000_000n })
        ).wait())!;
        recordGas(`route (cf ${cf}, bands at max)`, rc.gasUsed);
        const run = eventsOf(rc, s.splitter, "Routed")[0].args.run;
        expect([run.total, run.bondingFees, run.gradFees, run.recruiter, run.squad, run.airdrop]).to.deep.equal([total, B, G, recruiter, squad, airdrop]);
        expect(run.protocol).to.equal(total - committed);
        expect(await ethers.provider.getBalance(splitter)).to.equal(0n);
        await expectBooksEqualBalances(s, coins, `cf ${cf} after the run`);
      }
    });
  });

  describe("creator claims and the two-step transfer (gen-8 4.6, A13)", function () {
    it("only the coin's feeCreator claims, to any address; the transfer is two-step and carries what was owed before", async function () {
      const L = await openCoin({ firstBuy: 5n * WAD });
      const { creator, trader, outsider, spare } = s.signers;
      const owed = BigInt(barkSwapOf(s, L.receipt).creatorAmount);
      await expect(s.launcher.connect(creator).claimCreator(L.coin, creator.address)).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      await collectChecked(s, L);
      expect(await s.launcher.creatorOwed(L.coin)).to.equal(owed);
      await expect(s.launcher.connect(outsider).claimCreator(L.coin, outsider.address)).to.be.revertedWithCustomError(s.launcher, "NotCreator");
      await expect(s.launcher.connect(creator).claimCreator(L.coin, ethers.ZeroAddress)).to.be.revertedWithCustomError(s.launcher, "ZeroAddress");
      // A13: a recipient that refuses native reverts the claim, the balance stays
      await expect(s.launcher.connect(creator).claimCreator(L.coin, L.coin)).to.be.revertedWithCustomError(s.launcher, "SendFailed");
      expect(await s.launcher.creatorOwed(L.coin)).to.equal(owed);
      const before = await ethers.provider.getBalance(spare.address);
      const rc = (await (await s.launcher.connect(creator).claimCreator(L.coin, spare.address)).wait())!;
      recordGas("claimCreator", rc.gasUsed);
      expect(eventsOf(rc, s.launcher, "CreatorClaimed")[0].args.toObject()).to.deep.equal({ coin: L.coin, to: spare.address, amount: owed });
      expect((await ethers.provider.getBalance(spare.address)) - before).to.equal(owed);
      expect(await s.launcher.creatorOwed(L.coin)).to.equal(0n);

      // two-step transfer
      await routerBuy(s, trader, L.coin, 10n * WAD);
      await collectChecked(s, L);
      const owed2 = BigInt(await s.launcher.creatorOwed(L.coin));
      await expect(s.launcher.connect(outsider).proposeCreator(L.coin, outsider.address)).to.be.revertedWithCustomError(s.launcher, "NotCreator");
      await (await s.launcher.connect(creator).proposeCreator(L.coin, outsider.address)).wait();
      await expect(s.launcher.connect(trader).acceptCreator(L.coin)).to.be.revertedWithCustomError(s.launcher, "NotPendingCreator");
      // cancel (proposal of address 0), then propose again
      await (await s.launcher.connect(creator).proposeCreator(L.coin, ethers.ZeroAddress)).wait();
      await expect(s.launcher.connect(outsider).acceptCreator(L.coin)).to.be.revertedWithCustomError(s.launcher, "NotPendingCreator");
      await (await s.launcher.connect(creator).proposeCreator(L.coin, outsider.address)).wait();
      // until accepted the old creator still claims
      expect((await s.launcher.launches(L.coin)).feeCreator).to.equal(creator.address);
      const acc = (await (await s.launcher.connect(outsider).acceptCreator(L.coin)).wait())!;
      expect(eventsOf(acc, s.launcher, "CreatorTransferred")[0].args.toObject()).to.deep.equal({
        coin: L.coin,
        previous: creator.address,
        next: outsider.address,
      });
      expect(await s.launcher.pendingCreator(L.coin)).to.equal(ethers.ZeroAddress);
      await expect(s.launcher.connect(creator).claimCreator(L.coin, creator.address)).to.be.revertedWithCustomError(s.launcher, "NotCreator");
      await expect(s.launcher.connect(creator).proposeCreator(L.coin, creator.address)).to.be.revertedWithCustomError(s.launcher, "NotCreator");
      const o0 = await ethers.provider.getBalance(outsider.address);
      const c2 = (await (await s.launcher.connect(outsider).claimCreator(L.coin, outsider.address)).wait())!;
      expect((await ethers.provider.getBalance(outsider.address)) - o0 + c2.gasUsed * c2.gasPrice).to.equal(owed2);
      await expectBooksEqualBalances(s, [L.coin], "after claims");
    });

    it("a choice-vault coin's creator amount belongs to the vault: the creator's own key cannot claim it", async function () {
      const L = await openCoin({ firstBuy: 2n * WAD, feeChoice: 4 });
      await collectChecked(s, L);
      expect((await s.launcher.launches(L.coin)).feeCreator).to.equal(await s.choiceVault.getAddress());
      await expect(s.launcher.connect(s.signers.creator).claimCreator(L.coin, s.signers.creator.address)).to.be.revertedWithCustomError(
        s.launcher,
        "NotCreator",
      );
      await expect(s.launcher.connect(s.signers.creator).proposeCreator(L.coin, s.signers.creator.address)).to.be.revertedWithCustomError(
        s.launcher,
        "NotCreator",
      );
    });
  });

  describe("router bucket: claimRouter (F4) and the parked router (F3, A4, A13)", function () {
    async function someFees(L: LaunchResult, size = 20n * WAD) {
      await routerBuy(s, s.signers.trader, L.coin, size);
      await collectChecked(s, L);
    }

    it("F4: only the router, its operator() or the owner claims; a third party cannot move routerPaid", async function () {
      const L = await openCoin();
      const { operator, deployer, outsider, keeper, creator, spare } = s.signers;
      const splitter = await s.splitter.getAddress();
      await expect(s.launcher.connect(operator).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      await someFees(L);
      for (const who of [outsider, keeper, creator]) {
        await expect(s.launcher.connect(who).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      }
      const claim = async (who: any, gasFromRouter = false) => {
        const owed = BigInt(await s.launcher.routerOwed());
        const bonding = BigInt(await s.launcher.pendingBondingFees());
        const p0 = await s.launcher.routerPaid(splitter);
        const b0 = await ethers.provider.getBalance(splitter);
        const rc = (await (await s.launcher.connect(who).claimRouter()).wait())!;
        expect(eventsOf(rc, s.launcher, "RouterClaimed")[0].args.toObject()).to.deep.equal({
          router: splitter,
          amount: owed,
          bondingFees: bonding,
          gradFees: 0n,
        });
        const p1 = await s.launcher.routerPaid(splitter);
        expect([p1.amount - p0.amount, p1.bondingFees - p0.bondingFees, p1.gradFees - p0.gradFees]).to.deep.equal([owed, bonding, 0n]);
        const gas = gasFromRouter ? rc.gasUsed * rc.gasPrice : 0n;
        expect((await ethers.provider.getBalance(splitter)) - b0 + gas).to.equal(owed);
        expect([await s.launcher.routerOwed(), await s.launcher.pendingBondingFees(), await s.launcher.pendingGradFees()]).to.deep.equal([0n, 0n, 0n]);
      };
      await claim(operator); // the splitter's operator()
      await someFees(L);
      await claim(deployer); // the owner
      await someFees(L);
      await claim(await impersonate(splitter), true); // the router itself (it pays its own gas here)
      // the operator is read live from the router: a new operator may claim, the old one no longer
      await (await s.splitter.connect(deployer).setOperator(spare.address)).wait();
      await someFees(L);
      await expect(s.launcher.connect(operator).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      await claim(spare);
    });

    it("F3 / A4: a router change waits 48 h and parks the old bucket for the old router only; payParkedRouter pays it to that router", async function () {
      const L = await openCoin();
      const { deployer, outsider, operator, spare } = s.signers;
      const splitter = await s.splitter.getAddress();
      await graduate(L); // a graduation fee in the bucket
      await someFees(L);
      await expect(s.launcher.connect(outsider).proposeTreasuryRouter(spare.address)).to.be.revertedWithCustomError(s.launcher, "NotOwner");
      await expect(s.launcher.connect(deployer).proposeTreasuryRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(s.launcher, "ZeroAddress");
      await expect(s.launcher.connect(deployer).executeTreasuryRouter()).to.be.revertedWithCustomError(s.launcher, "NoPendingRouter");
      // a cancelled proposal cannot be executed
      await (await s.launcher.connect(deployer).proposeTreasuryRouter(outsider.address)).wait();
      await (await s.launcher.connect(deployer).cancelTreasuryRouter()).wait();
      await expect(s.launcher.connect(deployer).executeTreasuryRouter()).to.be.revertedWithCustomError(s.launcher, "NoPendingRouter");
      const prc = (await (await s.launcher.connect(deployer).proposeTreasuryRouter(spare.address)).wait())!;
      const eta = BigInt((await ethers.provider.getBlock(prc.blockNumber))!.timestamp) + ROUTER_TIMELOCK;
      expect(await s.launcher.routerEta()).to.equal(eta);
      await expect(s.launcher.connect(outsider).executeTreasuryRouter()).to.be.revertedWithCustomError(s.launcher, "NotOwner");
      // (a reverted transaction still mines a block on the fork)
      await time.setNextBlockTimestamp(eta - 1n);
      await expect(s.launcher.connect(deployer).executeTreasuryRouter({ gasLimit: 500_000n })).to.be.revertedWithCustomError(
        s.launcher,
        "TimelockActive",
      );
      const owed = BigInt(await s.launcher.routerOwed());
      const bonding = BigInt(await s.launcher.pendingBondingFees());
      const grad = BigInt(await s.launcher.pendingGradFees());
      expect(grad).to.be.greaterThan(0n);
      await time.setNextBlockTimestamp(eta);
      const erc = (await (await s.launcher.connect(deployer).executeTreasuryRouter()).wait())!;
      expect(eventsOf(erc, s.launcher, "RouterParked")[0].args.toObject()).to.deep.equal({ router: splitter, amount: owed, bondingFees: bonding, gradFees: grad });
      expect(eventsOf(erc, s.launcher, "RouterChanged")[0].args.toObject()).to.deep.equal({ previous: splitter, next: spare.address });
      expect(await s.launcher.treasuryRouter()).to.equal(spare.address);
      expect([await s.launcher.routerOwed(), await s.launcher.parkedOwed()]).to.deep.equal([0n, owed]);
      const parked = await s.launcher.routerParked(splitter);
      expect([parked.amount, parked.bondingFees, parked.gradFees]).to.deep.equal([owed, bonding, grad]);
      await expectBooksEqualBalances(s, [L.coin], "after parking");
      // the old router's operator can no longer claim the (new) bucket
      await someFees(L);
      await expect(s.launcher.connect(operator).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      // anyone pays the parked bucket, only ever to the old router
      const b0 = await ethers.provider.getBalance(splitter);
      const pay = (await (await s.launcher.connect(outsider).payParkedRouter(splitter)).wait())!;
      recordGas("payParkedRouter", pay.gasUsed);
      expect(eventsOf(pay, s.launcher, "RouterClaimed")[0].args.toObject()).to.deep.equal({ router: splitter, amount: owed, bondingFees: bonding, gradFees: grad });
      expect((await ethers.provider.getBalance(splitter)) - b0).to.equal(owed);
      const paid = await s.launcher.routerPaid(splitter);
      expect([paid.amount, paid.bondingFees, paid.gradFees]).to.deep.equal([owed, bonding, grad]);
      expect(await s.launcher.parkedOwed()).to.equal(0n);
      await expect(s.launcher.payParkedRouter(splitter)).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      await expect(s.launcher.payParkedRouter(spare.address)).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      // the new router claims what accrued after the change
      const newOwed = BigInt(await s.launcher.routerOwed());
      const sp0 = await ethers.provider.getBalance(spare.address);
      const c = (await (await s.launcher.connect(spare).claimRouter()).wait())!;
      expect((await ethers.provider.getBalance(spare.address)) - sp0 + c.gasUsed * c.gasPrice).to.equal(newOwed);
      expect((await s.launcher.routerPaid(spare.address)).amount).to.equal(newOwed);
      await expectBooksEqualBalances(s, [L.coin], "after the new router's claim");
    });

    it("F3 caveat (I-4): fees earned under the old router but collected or converted after the change credit the new router", async function () {
      const L = await openCoin();
      const { deployer, trader, spare } = s.signers;
      const splitter = await s.splitter.getAddress();
      await someFees(L);
      // earned now, not collected / not converted yet
      await approveRouter(trader, L.coin);
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 15n * WAD));
      await routerSell(s, trader, L.coin, BigInt(b.coinAmount) / 2n);
      const inBucket = BigInt(await s.launcher.routerOwed());
      await (await s.launcher.connect(deployer).proposeTreasuryRouter(spare.address)).wait();
      await time.increase(ROUTER_TIMELOCK);
      await (await s.launcher.connect(deployer).executeTreasuryRouter()).wait();
      expect((await s.launcher.routerParked(splitter)).amount).to.equal(inBucket);
      const c = await collectChecked(s, L);
      await time.increase(600);
      const v = await convertChecked(s, L);
      // the late-realised router DOGE is in the bucket now paid to the new router; the parked bucket did not grow
      expect(BigInt(await s.launcher.routerOwed())).to.equal(c.nativeBooks[1] + c.nativeBooks[3] + v.got[1] + v.got[3]);
      expect((await s.launcher.routerParked(splitter)).amount).to.equal(inBucket);
      await (await s.launcher.connect(spare).claimRouter()).wait();
      expect((await s.launcher.routerPaid(spare.address)).amount).to.equal(c.nativeBooks[1] + c.nativeBooks[3] + v.got[1] + v.got[3]);
    });

    it("A13: a router that refuses native reverts claimRouter and payParkedRouter; the bucket stays", async function () {
      const L = await openCoin();
      const { deployer, outsider } = s.signers;
      const refusing = await s.plugin.getAddress(); // no receive, no fallback, no operator()
      const splitter = await s.splitter.getAddress();
      await (await s.launcher.connect(deployer).proposeTreasuryRouter(refusing)).wait();
      await time.increase(ROUTER_TIMELOCK);
      await (await s.launcher.connect(deployer).executeTreasuryRouter()).wait();
      await someFees(L);
      const owed = BigInt(await s.launcher.routerOwed());
      await expect(s.launcher.connect(deployer).claimRouter()).to.be.revertedWithCustomError(s.launcher, "SendFailed");
      await expect(s.launcher.connect(outsider).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      expect(await s.launcher.routerOwed()).to.equal(owed);
      // back to the splitter: the bucket parks for the refusing router and stays parked
      await (await s.launcher.connect(deployer).proposeTreasuryRouter(splitter)).wait();
      await time.increase(ROUTER_TIMELOCK);
      await (await s.launcher.connect(deployer).executeTreasuryRouter()).wait();
      expect((await s.launcher.routerParked(refusing)).amount).to.equal(owed);
      await expect(s.launcher.connect(outsider).payParkedRouter(refusing)).to.be.revertedWithCustomError(s.launcher, "SendFailed");
      expect((await s.launcher.routerParked(refusing)).amount).to.equal(owed);
      expect(await s.launcher.parkedOwed()).to.equal(owed);
      await expectBooksEqualBalances(s, [L.coin], "parked for a refusing router");
    });
  });

  describe("recorded fixture for t19 (test/fixtures/dogeos/barkMoneyFlow.json)", function () {
    it("records swaps, collects, conversions, a route plan and the book read-backs; the committed file verifies on its own", async function () {
      const recorded = await buildMoneyFixture(s);
      verifyMoneyFixture(recorded);
      if (process.env.MWZ_RECORD_BARK_FIXTURES === "1") {
        fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
        fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
      }
      const committed: MoneyFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
      verifyMoneyFixture(committed);
      expect(committed.logs.map((l) => `${l.step}:${l.contract}.${l.event}`)).to.deep.equal(recorded.logs.map((l) => `${l.step}:${l.contract}.${l.event}`));
      expect(committed.steps.map((x) => x.step)).to.deep.equal(recorded.steps.map((x) => x.step));
    });
  });
});

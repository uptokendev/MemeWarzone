// RESEARCH ONLY. Local hardhat fork proof: MemeWarzone coins launched into a Barkswap (Algebra Integral v1.2.1)
// CUSTOM pool on DogeOS Chikyu testnet (6281971), with one shared plugin that takes the gen-8 fees, latches
// graduation and blocks outside liquidity. Nothing is sent to a real network: the runner starts
// `npx hardhat node --config hardhat.dogeos-testnet-fork.config.ts` (in-process fork, block gas limit 10M) and
// signs with fresh deterministic research keys funded on the fork only.
//
//   node scripts/research/barkswap-plugin/run-proof.mjs [--port 8681]
//
// Writes results/barkswap-plugin-proof.log (the console output) and results/barkswap-plugin-proof.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import * as gen7 from "../../../frontend/shared/evmGen7Curve.mjs";
import { compileAll } from "./compile.mjs";
import * as TM from "./tickmath.mjs";
import { WAD, Q96, FEE_DENOM, fmt, absDiff, ppm, ceilDiv, pct, token0Delta, token1Delta, liquidityForAmount0, mcFromSqrt, startHardhatFork, killTree, revertOf, repoRootFrom } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = repoRootFrom(here);
const args = process.argv.slice(2);
const argVal = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const PORT = Number(argVal("--port", "8681"));
const CHAIN_ID = 6281971n;
const LOG_LINES = [];
const log = (s) => {
  console.log(s);
  LOG_LINES.push(s);
};

// ------------------------------------------------------------------ constants
const SUPPLY = 1_000_000_000n * WAD;
const COINS_A = 850_000_000n * WAD;
const COINS_B = 130_000_000n * WAD;
const RESERVE = 20_000_000n * WAD;
const DOGE_USD = 10n ** 17n; // $0.10 (1e18 = $1), the brief's assumption; there is no on-chain oracle here
const TARGETS = { "$150": 150n * WAD, "$30K": 30_000n * WAD };
const FEES = { bonding: 20_000, post: 10_000, sniper: 900_000 }; // 1e6 units, gen-8 rates
const CONFIG_BONDING = 135;
const CONFIG_GRADUATED = 133;
const HOUR = 3600n;

const A = {
  factory: "0xF3961157f56C983316657f0267B4C04460beE43f",
  poolDeployer: "0x4151224471B0EeA41eE4295c632cc61779d339C2",
  ep: "0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5",
  router: "0x911E5A1630fD1768e5A1710DAaFAbB865cb79531",
  npm: "0xf596329a6c7E03F0708199cB5435f86783DB4302",
  quoterV2: ethers.getAddress("0x187b41968063cb8a04a5f4d2113844ef2ba21493"),
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
  vault: "0xA305F8BDf7EaA3233b3918A39d1e0867c6116c83",
  admin: "0xFB1525e16FDA109a5180a3Ec23A7146b870E045b",
};
for (const k of Object.keys(A)) A[k] = ethers.getAddress(A[k].toLowerCase());

const POOL_ABI = [
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function plugin() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function communityVault() view returns (address)",
  "function getPluginFeePending() view returns (uint128, uint128)",
  "function getCommunityFeePending() view returns (uint128, uint128)",
  "function lastFeeTransferTimestamp() view returns (uint32)",
  "function positions(bytes32) view returns (uint256 liquidity, uint256, uint256, uint128 fees0, uint128 fees1)",
  "function liquidity() view returns (uint128)",
  "function totalFeeGrowth0Token() view returns (uint256)",
  "function totalFeeGrowth1Token() view returns (uint256)",
  "function initialize(uint160)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 price, uint128 liquidity, int24 tick, uint24 overrideFee, uint24 pluginFee)",
  "event PluginConfig(uint8 newPluginConfig)",
  "error locked()", "error alreadyInitialized()", "error notInitialized()", "error incorrectPluginFee()", "error insufficientInputAmount()",
  "error invalidLimitSqrtPrice()", "error tickIsNotSpaced()", "error notAllowed()", "error dynamicFeeActive()", "error dynamicFeeDisabled()",
  "error invalidHookResponse(bytes4)", "error transferFailed()", "error zeroLiquidityActual()",
];
const FACTORY_ABI = [
  "function createPool(address tokenA, address tokenB, bytes data) returns (address)",
  "function poolByPair(address, address) view returns (address)",
  "function customPoolByPair(address, address, address) view returns (address)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function defaultCommunityFee() view returns (uint16)",
  "function owner() view returns (address)",
  "event CustomPool(address indexed deployer, address indexed token0, address indexed token1, address pool)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, address deployer, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice) params) payable returns (uint256)",
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function unwrapWNativeToken(uint256 amountMinimum, address recipient) payable",
  "function refundNativeToken() payable",
  "function poolDeployer() view returns (address)",
  "function WNativeToken() view returns (address)",
];
const NPM_ABI = [
  "function mint((address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, address deployer, uint160 sqrtPriceX96, bytes data) payable returns (address)",
  "function ownerOf(uint256) view returns (address)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, address deployer, uint256 amountIn, uint160 limitSqrtPrice) params) returns (uint256 amountOut, uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate, uint16 fee)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function deposit() payable",
];
const EP_ABI = ["function factory() view returns (address)", "function createCustomPool(address deployer, address creator, address tokenA, address tokenB, bytes data) returns (address)"];

const coder = ethers.AbiCoder.defaultAbiCoder();
const CUSTOM_POOL_DEPLOYER = ethers.id("CUSTOM_POOL_DEPLOYER");
const POOLS_ADMINISTRATOR = ethers.id("POOLS_ADMINISTRATOR");

// ------------------------------------------------------------------ results
const RESULTS = [];
const GAS = [];
const DATA = {};
let CTX = "setup";
function check(name, pass, detail = "") {
  RESULTS.push({ ctx: CTX, name, pass: !!pass, detail });
  log(`${pass ? "PASS" : "FAIL"} [${CTX}] ${name}${detail ? "  " + detail : ""}`);
  return !!pass;
}
function note(line) {
  log(`     [${CTX}] ${line}`);
}
function gas(step, g, detail = "") {
  GAS.push({ step, gas: Number(g), detail });
  log(`     [gas] ${step}: ${Number(g).toLocaleString("en-US")}${detail ? "  (" + detail + ")" : ""}`);
}

// ------------------------------------------------------------------ curve plan
function nearestGridTick(sqrtP, spacing) {
  const t = TM.getTickAtSqrtRatio(sqrtP);
  const lo = Math.floor(t / spacing) * spacing;
  const hi = lo + spacing;
  return sqrtP - TM.getSqrtRatioAtTick(lo) <= TM.getSqrtRatioAtTick(hi) - sqrtP ? lo : hi;
}

function plan(targetUsd, spacing) {
  const mc = (targetUsd * WAD) / DOGE_USD; // graduation market cap in DOGE wei
  const { virtualNative: vN, virtualToken: vT } = gen7.curveForMarketCap(mc, SUPPLY);
  // coin = token0, price = native per coin. gen-7 price at sold s: vN*vT/(vT-s)^2
  const sqrtStartExact = TM.isqrt((vN * TM.Q192) / vT);
  const sqrtGradExact = TM.isqrt((vN * vT * TM.Q192) / ((vT - COINS_A) * (vT - COINS_A)));
  const tickStart = nearestGridTick(sqrtStartExact, spacing);
  const tickGrad = nearestGridTick(sqrtGradExact, spacing);
  const tickMax = Math.floor(TM.MAX_TICK / spacing) * spacing;
  const sA = TM.getSqrtRatioAtTick(tickStart);
  const sG = TM.getSqrtRatioAtTick(tickGrad);
  const sM = TM.getSqrtRatioAtTick(tickMax);
  const liqA = liquidityForAmount0(sA, sG, COINS_A);
  const liqB = liquidityForAmount0(sG, sM, COINS_B);
  const raiseA = token1Delta(sA, sG, liqA, true); // native that buys out A, before fees
  const gen7Raise = gen7.graduationRaise(vN, vT, COINS_A);
  const gen7StartMc = gen7.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold: 0n, totalSupply: SUPPLY });
  const gen7GradMc = gen7.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold: COINS_A, totalSupply: SUPPLY });
  return {
    targetUsd, spacing, mc, vN, vT, tickStart, tickGrad, tickMax, sA, sG, sM, liqA, liqB, raiseA, gen7Raise,
    startMc: mcFromSqrt(sA, SUPPLY), gradMc: mcFromSqrt(sG, SUPPLY), gen7StartMc, gen7GradMc,
    coinsA: token0Delta(sA, sG, liqA, true), coinsB: token0Delta(sG, sM, liqB, true),
  };
}

// ------------------------------------------------------------------ env
async function setup(C) {
  const { child, provider } = await startHardhatFork(ROOT, "hardhat.dogeos-testnet-fork.config.ts", PORT, CHAIN_ID);
  const env = { child, provider, C };
  const net = await provider.getNetwork();
  const blk = await provider.getBlock("latest");
  env.forkBlock = blk.number;
  check("fork chainId is DogeOS Chikyu 6281971", net.chainId === CHAIN_ID, `block ${blk.number}`);
  check("fork block gas limit is Chikyu's 10,000,000", blk.gasLimit === 10_000_000n, `${blk.gasLimit}`);
  DATA.fork = { chainId: Number(net.chainId), block: blk.number, timestamp: blk.timestamp, gasLimit: Number(blk.gasLimit) };

  // fresh deterministic research keys, funded on the fork only
  const names = ["deployer", "creator", "buyer", "seller", "attacker", "treasury", "keeper", "whale"];
  env.W = {};
  env.addr = {};
  for (const n of names) {
    env.W[n] = new ethers.NonceManager(new ethers.Wallet(ethers.id("mwz-barkswap-plugin-research/" + n), provider));
    env.addr[n] = await env.W[n].getAddress();
    await provider.send("hardhat_setBalance", [env.addr[n], "0x" + (10_000_000n * WAD).toString(16)]);
  }
  for (const [label, a] of Object.entries(A)) {
    if (label === "admin") continue;
    const code = await provider.getCode(a);
    check(`code at Barkswap ${label}`, code.length > 2, `${a} ${(code.length - 2) / 2} bytes`);
  }
  env.factory = new ethers.Contract(A.factory, FACTORY_ABI, provider);
  env.router = new ethers.Contract(A.router, ROUTER_ABI, provider);
  env.npm = new ethers.Contract(A.npm, NPM_ABI, provider);
  env.quoter = new ethers.Contract(A.quoterV2, QUOTER_ABI, provider);
  env.wdoge = new ethers.Contract(A.wdoge, ERC20_ABI, provider);
  env.ep = new ethers.Contract(A.ep, EP_ABI, provider);
  check("EP is the only CUSTOM_POOL_DEPLOYER (no per-deployer grant needed)", (await env.factory.hasRole(CUSTOM_POOL_DEPLOYER, A.ep)) && (await env.factory.getRoleMemberCount(CUSTOM_POOL_DEPLOYER)) === 1n);
  check("EP holds POOLS_ADMINISTRATOR (setTickSpacing / setFee / setPluginConfig forwarders work)", await env.factory.hasRole(POOLS_ADMINISTRATOR, A.ep));
  check("router poolDeployer / WNativeToken match", (await env.router.poolDeployer()) === A.poolDeployer && (await env.router.WNativeToken()) === A.wdoge);
  check("factory defaultCommunityFee = 30 (3% of every swap fee)", (await env.factory.defaultCommunityFee()) === 30n);

  const deploy = async (name, ...a) => {
    const f = new ethers.ContractFactory(C[name].abi, C[name].bytecode, env.W.deployer);
    const c = await f.deploy(...a, { gasLimit: 9_000_000n });
    const rc = await c.deploymentTransaction().wait();
    return { c: new ethers.Contract(await c.getAddress(), C[name].abi, provider), gas: rc.gasUsed };
  };
  const d = await deploy("MwzBarkLauncher", A.ep, A.factory, A.wdoge, A.npm, env.addr.treasury);
  env.D = d.c;
  gas("deploy launcher D (+ shared plugin P in its constructor), once per chain", d.gas, `D runtime ${C.MwzBarkLauncher.runtimeSize} B, P runtime ${C.MwzBarkPlugin.runtimeSize} B`);
  env.P = new ethers.Contract(await env.D.plugin(), C.MwzBarkPlugin.abi, provider);
  check("plugin P deployed by D, P.launcher == D", (await env.P.launcher()) === env.D.target, env.P.target);
  env.minter = (await deploy("DirectMinter")).c;
  env.swapper = (await deploy("DirectSwapper")).c;
  const tk = await deploy("MwzBarkToken", "Standalone", "STD", SUPPLY, env.addr.deployer, ethers.ZeroAddress, ethers.ZeroAddress);
  gas("standalone coin deploy (reference: the coin CREATE inside launch)", tk.gas);
  env.ifaces = [env.P.interface, env.D.interface, new ethers.Interface(C.MwzBarkToken.abi.filter((x) => x.type === "error")), new ethers.Interface(POOL_ABI)];
  return env;
}

async function snapshot(env) {
  return env.provider.send("evm_snapshot", []);
}
async function revertTo(env, id) {
  const ok = await env.provider.send("evm_revert", [id]);
  if (!ok) throw new Error("evm_revert failed");
  for (const w of Object.values(env.W)) w.reset();
  return env.provider.send("evm_snapshot", []);
}
async function now(env) {
  return BigInt((await env.provider.getBlock("latest")).timestamp);
}
async function setNextTs(env, ts) {
  await env.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
}

// ------------------------------------------------------------------ launch
async function launch(env, { target = TARGETS["$150"], spacing = 200, guard = false, useNpm = false, lpFeeMode = false, gradInline = false, firstBuy = 0n, name = "Research Coin", symbol = "RSCH" } = {}) {
  const pl = plan(target, spacing);
  const creator = env.W.creator;
  const creatorAddr = env.addr.creator;
  const tokenArgs = coder.encode(["string", "string", "uint256", "address", "address", "address"], [name, symbol, SUPPLY, env.D.target, guard ? A.factory : ethers.ZeroAddress, env.P.target]);
  const initHash = ethers.keccak256(ethers.concat([env.C.MwzBarkToken.bytecode, tokenArgs]));
  let salt, coinAddr;
  for (let i = BigInt(Date.now() % 100000); ; i++) {
    salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const s = ethers.keccak256(coder.encode(["address", "bytes32"], [creatorAddr, salt]));
    coinAddr = ethers.getCreate2Address(env.D.target, s, initHash);
    if (BigInt(coinAddr) < BigInt(A.wdoge) && (await env.provider.getCode(coinAddr)) === "0x") break;
  }
  const lp = {
    name, symbol, salt, guard, useNpm, lpFeeMode, gradInline,
    tickSpacing: spacing, tickStart: pl.tickStart, tickGrad: pl.tickGrad, tickMax: pl.tickMax,
    sqrtStart: pl.sA, sqrtGrad: pl.sG, liqA: pl.liqA, liqB: pl.liqB,
    bondingFee: FEES.bonding, postFee: FEES.post, sniperStartFee: FEES.sniper, minFirstBuyOut: 0n,
  };
  const tx = await env.D.connect(creator).launch(lp, { value: firstBuy, gasLimit: 9_900_000n });
  const rc = await tx.wait();
  let ev;
  for (const l of rc.logs) {
    if (l.address !== env.D.target) continue;
    const p = env.D.interface.parseLog(l);
    if (p?.name === "Launched") ev = p.args;
  }
  const pool = new ethers.Contract(ev.pool, POOL_ABI, env.provider);
  const coin = new ethers.Contract(ev.coin, ERC20_ABI, env.provider);
  return { pl, lp, rc, gas: rc.gasUsed, coin, pool, coinAddr: ev.coin, poolAddr: ev.pool, ev, openAt: BigInt((await env.provider.getBlock(rc.blockNumber)).timestamp), launchBlock: rc.blockNumber, guard, lpFeeMode, firstBuy };
}

// ------------------------------------------------------------------ fee accounting + trades
async function feeState(env, P) {
  const [pp0, pp1] = await P.pool.getPluginFeePending();
  const [cp0, cp1] = await P.pool.getCommunityFeePending();
  return {
    pp0, pp1, cp0, cp1,
    pr0: await env.P.feesCoin(P.poolAddr),
    pr1: await env.P.feesNative(P.poolAddr),
    v0: await P.coin.balanceOf(A.vault),
    v1: await env.wdoge.balanceOf(A.vault),
    pb0: await P.coin.balanceOf(env.P.target),
    pb1: await env.wdoge.balanceOf(env.P.target),
    fg0: await P.pool.totalFeeGrowth0Token(),
    fg1: await P.pool.totalFeeGrowth1Token(),
  };
}
function feeDelta(b, a) {
  return {
    plugin0: a.pp0 - b.pp0 + (a.pr0 - b.pr0),
    plugin1: a.pp1 - b.pp1 + (a.pr1 - b.pr1),
    community0: a.cp0 - b.cp0 + (a.v0 - b.v0),
    community1: a.cp1 - b.cp1 + (a.v1 - b.v1),
    pushed0: a.pr0 - b.pr0,
    pushed1: a.pr1 - b.pr1,
    vault0: a.v0 - b.v0,
    vault1: a.v1 - b.v1,
    lpGrowth0: a.fg0 - b.fg0,
    lpGrowth1: a.fg1 - b.fg1,
  };
}

function parseSwap(env, P, rc) {
  const out = { swap: null, pluginFeeEvents: [], graduated: null, gradFee: null, inline: null, config: [] };
  for (const l of rc.logs) {
    if (l.address === P.poolAddr) {
      try {
        const e = P.pool.interface.parseLog(l);
        if (e?.name === "Swap") out.swap = e.args;
        if (e?.name === "PluginConfig") out.config.push(Number(e.args[0]));
      } catch {}
    } else if (l.address === env.P.target) {
      const e = env.P.interface.parseLog(l);
      if (e?.name === "PluginFeeReceived") out.pluginFeeEvents.push(e.args);
      if (e?.name === "Graduated") out.graduated = e.args;
      if (e?.name === "InlineGraduationFee") out.inline = e.args.ok;
    } else if (l.address === env.D.target) {
      const e = env.D.interface.parseLog(l);
      if (e?.name === "GraduationFeeTaken") out.gradFee = e.args;
    }
  }
  return out;
}

/** Router buy (native in): exactInputSingle with msg.value; with a price limit, multicall + refundNativeToken. */
async function buy(env, P, wallet, amountIn, { limit = 0n, ts, deployer } = {}) {
  const user = await wallet.getAddress();
  if (ts !== undefined) await setNextTs(env, ts);
  const before = await feeState(env, P);
  const params = [A.wdoge, P.coinAddr, deployer ?? env.D.target, user, 2n ** 40n, amountIn, 0n, limit];
  const r = env.router.connect(wallet);
  const nBefore = await env.provider.getBalance(user);
  const cBefore = await P.coin.balanceOf(user);
  let tx;
  if (limit === 0n) tx = await r.exactInputSingle(params, { value: amountIn, gasLimit: 3_000_000n });
  else tx = await r.multicall([r.interface.encodeFunctionData("exactInputSingle", [params]), r.interface.encodeFunctionData("refundNativeToken", [])], { value: amountIn, gasLimit: 3_000_000n });
  const rc = await tx.wait();
  const after = await feeState(env, P);
  const s = parseSwap(env, P, rc);
  const paid = nBefore - (await env.provider.getBalance(user)) - rc.gasUsed * rc.gasPrice;
  return { rc, gas: rc.gasUsed, ...s, fee: feeDelta(before, after), coinOut: (await P.coin.balanceOf(user)) - cBefore, nativePaid: paid, ts: BigInt((await env.provider.getBlock(rc.blockNumber)).timestamp) };
}

/** Router sell (coin in, native out): multicall(exactInputSingle -> router, unwrapWNativeToken -> seller). */
async function sell(env, P, wallet, amountIn, { ts } = {}) {
  const user = await wallet.getAddress();
  const coin = P.coin.connect(wallet);
  if ((await P.coin.allowance(user, A.router)) < amountIn) await (await coin.approve(A.router, ethers.MaxUint256)).wait();
  if (ts !== undefined) await setNextTs(env, ts);
  const before = await feeState(env, P);
  const r = env.router.connect(wallet);
  const params = [P.coinAddr, A.wdoge, env.D.target, ethers.ZeroAddress, 2n ** 40n, amountIn, 0n, 0n];
  const nBefore = await env.provider.getBalance(user);
  const tx = await r.multicall([r.interface.encodeFunctionData("exactInputSingle", [params]), r.interface.encodeFunctionData("unwrapWNativeToken", [0n, user])], { gasLimit: 3_000_000n });
  const rc = await tx.wait();
  const after = await feeState(env, P);
  const s = parseSwap(env, P, rc);
  const got = (await env.provider.getBalance(user)) - nBefore + rc.gasUsed * rc.gasPrice;
  return { rc, gas: rc.gasUsed, ...s, fee: feeDelta(before, after), nativeOut: got, ts: BigInt((await env.provider.getBlock(rc.blockNumber)).timestamp) };
}

const expectedRate = (P, ts) => {
  const end = P.openAt + 60n;
  if (ts >= end) return BigInt(FEES.bonding);
  return BigInt(FEES.bonding) + ((BigInt(FEES.sniper - FEES.bonding) * (end - ts)) / 60n);
};
const buyCharged = (rate) => (rate * FEE_DENOM) / (FEE_DENOM + rate); // what the plugin returns for a buy

async function gs(P) {
  const g = await P.pool.globalState();
  return { price: g[0], tick: Number(g[1]), lastFee: Number(g[2]), config: Number(g[3]), communityFee: Number(g[4]) };
}
const posKey = (owner, bottom, top) =>
  ethers.toBeHex((BigInt(owner) << 48n) | ((BigInt.asUintN(24, BigInt(bottom))) << 24n) | BigInt.asUintN(24, BigInt(top)), 32);

// ------------------------------------------------------------------ checks
async function check1and2Launch(env) {
  CTX = "1 launch";
  const base = await snapshot(env);
  let snap = base;
  const variants = [
    { label: "direct pool.mint, tickSpacing 200", o: { spacing: 200 } },
    { label: "NPM mint (2 NFTs to D), tickSpacing 200", o: { spacing: 200, useNpm: true } },
    { label: "direct pool.mint, tickSpacing 60 (default, no setTickSpacing)", o: { spacing: 60 } },
    { label: "direct pool.mint, tickSpacing 10", o: { spacing: 10 } },
    { label: "direct pool.mint, tickSpacing 200, coin side-pool guard on", o: { spacing: 200, guard: true } },
    { label: "direct pool.mint, tickSpacing 200, creator first buy 10 DOGE", o: { spacing: 200, firstBuy: 10n * WAD } },
    { label: "direct pool.mint, tickSpacing 200, LP-fee mode (lastFee stays 500)", o: { spacing: 200, lpFeeMode: true } },
  ];
  DATA.launchVariants = [];
  for (const v of variants) {
    const L = await launch(env, v.o);
    gas(`launch tx: ${v.label}`, L.gas);
    DATA.launchVariants.push({ label: v.label, gas: Number(L.gas) });
    check(`launch fits far under the 10M block gas limit (${v.label})`, L.gas < 8_000_000n, `${L.gas} gas, ${(Number(L.gas) / 1e5).toFixed(1)}% of 10M`);
    if (v.o.useNpm) {
      const ia = await env.D.info(L.poolAddr);
      check("NPM variant: both position NFTs owned by D, liquidity recorded", (await env.npm.ownerOf(ia.npmIdA)) === env.D.target && (await env.npm.ownerOf(ia.npmIdB)) === env.D.target && ia.liqA > 0n && ia.liqB > 0n, `ids ${ia.npmIdA}/${ia.npmIdB}`);
    }
    snap = await revertTo(env, snap);
  }

  // The main inspection launch (direct mint, spacing 200)
  const L = await launch(env, { spacing: 200 });
  const g = await gs(L);
  const pl = L.pl;
  check("pool address == factory.computeCustomPoolAddress(D, coin, WDOGE) and registered under D", L.poolAddr === (await env.factory.customPoolByPair(env.D.target, L.coinAddr, A.wdoge)));
  check("coin is token0, WDOGE token1 (launcher enforces, salt picked off chain)", (await L.pool.token0()) === L.coinAddr && (await L.pool.token1()) === A.wdoge);
  check("pool.plugin() == the shared plugin P", (await L.pool.plugin()) === env.P.target);
  check("plugin config 135 = BEFORE_SWAP|AFTER_SWAP|BEFORE_POSITION_MODIFY|DYNAMIC_FEE", g.config === CONFIG_BONDING, `${g.config}`);
  check("tick spacing 200 set through EP.setTickSpacing", (await L.pool.tickSpacing()) === 200n);
  check("lastFee 0 (EP.setFee(0) before DYNAMIC_FEE): LP fee 0, total fee = plugin fee", g.lastFee === 0);
  check("communityFee 30 and vault 0xA305 set by the factory (D cannot change either)", g.communityFee === 30 && (await L.pool.communityVault()) === A.vault);
  check("initialized exactly at the grid start price (tick == tickStart)", g.price === pl.sA && g.tick === pl.tickStart, `tick ${g.tick}`);
  const pA = await L.pool.positions(posKey(env.D.target, pl.tickStart, pl.tickGrad));
  const pB = await L.pool.positions(posKey(env.D.target, pl.tickGrad, pl.tickMax));
  check("position A owned by D with the planned liquidity", pA.liquidity === pl.liqA, `L ${pl.liqA}`);
  check("position B owned by D with the planned liquidity", pB.liquidity === pl.liqB, `L ${pl.liqB}`);
  const poolCoins = await L.coin.balanceOf(L.poolAddr);
  check("pool holds A + B coins (one-sided, coin only), no WDOGE", poolCoins === pl.coinsA + pl.coinsB && (await env.wdoge.balanceOf(L.poolAddr)) === 0n, `${fmt(poolCoins, 0)} coins (A ${fmt(pl.coinsA, 4)} B ${fmt(pl.coinsB, 4)})`);
  const dust = SUPPLY - RESERVE - pl.coinsA - pl.coinsB;
  check("creator got the 20M reserve; rounding dust burned to 0xdEaD; D keeps 0 coins", (await L.coin.balanceOf(env.addr.creator)) === RESERVE && (await L.coin.balanceOf("0x000000000000000000000000000000000000dEaD")) === dust && (await L.coin.balanceOf(env.D.target)) === 0n, `dust ${dust} wei`);
  {
    const mut = env.D.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name).sort();
    check("D's only state-changing functions: launch, callbacks, takeGraduationFee, collectLpFees (no withdraw path for A/B)", mut.join(",") === ["algebraMintCallback", "algebraSwapCallback", "collectLpFees", "launch", "takeGraduationFee"].join(","), mut.join(","));
  }
  // beforeInitialize gate: impersonate the pool and call P.beforeInitialize as a non-launcher sender
  await env.provider.send("hardhat_impersonateAccount", [L.poolAddr]);
  await env.provider.send("hardhat_setBalance", [L.poolAddr, "0x" + (10n ** 18n).toString(16)]);
  const poolSigner = new ethers.JsonRpcSigner(env.provider, L.poolAddr);
  const r1 = await revertOf(() => env.P.connect(poolSigner).beforeInitialize.staticCall(env.addr.attacker, pl.sA), env.ifaces);
  const okSel = await env.P.connect(poolSigner).beforeInitialize.staticCall(env.D.target, pl.sA);
  await env.provider.send("hardhat_stopImpersonatingAccount", [L.poolAddr]);
  check("beforeInitialize reverts for any sender but D (anti front-run), returns the selector for D", r1 === "OnlyLauncherMayInitialize" && okSel === env.P.interface.getFunction("beforeInitialize").selector, `${r1} / ${okSel}`);
  const r2 = await revertOf(() => L.pool.connect(env.W.attacker).initialize.staticCall(pl.sG), env.ifaces);
  check("re-initialize reverts (alreadyInitialized)", r2 === "alreadyInitialized", r2);
  const r3 = await revertOf(() => env.ep.connect(env.W.attacker).createCustomPool.staticCall(env.D.target, env.addr.attacker, L.coinAddr, A.wdoge, "0x"), env.ifaces);
  check("nobody but D can create a custom pool under deployer D (EP: Only deployer)", r3 && r3.includes("Only deployer"), r3);
  snap = await revertTo(env, snap);

  // ------------------------------------------------------------------ 2. curve shape
  CTX = "2 curve";
  DATA.curve = [];
  for (const [tLabel, target] of Object.entries(TARGETS)) {
    for (const spacing of [200, 60, 10]) {
      const p = plan(target, spacing);
      const row = {
        target: tLabel, spacing, tickStart: p.tickStart, tickGrad: p.tickGrad,
        gradMcDoge: fmt(p.gradMc, 4), targetMcDoge: fmt(p.mc, 4), gradMcPpm: ppm(p.gradMc, p.mc),
        startMcDoge: fmt(p.startMc, 4), gen7StartMcDoge: fmt(p.gen7StartMc, 4), startMcPpm: ppm(p.startMc, p.gen7StartMc),
        raiseADoge: fmt(p.raiseA, 6), gen7RaiseDoge: fmt(p.gen7Raise, 6), raisePpm: ppm(p.raiseA, p.gen7Raise),
        coinsAWei: String(p.coinsA), coinsBWei: String(p.coinsB),
      };
      DATA.curve.push(row);
      note(`${tLabel} spacing ${spacing}: ticks ${p.tickStart}..${p.tickGrad}..${p.tickMax}; grad MC ${row.gradMcDoge} DOGE (target ${row.targetMcDoge}, ${row.gradMcPpm} ppm); start MC ${row.startMcDoge} vs gen-7 ${row.gen7StartMcDoge} (${row.startMcPpm} ppm); raise in A ${row.raiseADoge} vs gen-7 ${row.gen7RaiseDoge} (${row.raisePpm} ppm)`);
    }
  }
  const worst = (sp) => Math.max(...DATA.curve.filter((r) => r.spacing === sp).map((r) => Math.max(r.gradMcPpm, r.startMcPpm, r.raisePpm)));
  check("tickSpacing 10: grid rounding keeps grad MC, start MC and raise within 1,000 ppm of gen-7", worst(10) < 1000, `worst ${worst(10)} ppm`);
  check("tickSpacing 60: within 6,000 ppm of gen-7", worst(60) < 6000, `worst ${worst(60)} ppm`);
  check("tickSpacing 200 (Barkswap's usual): within 20,000 ppm (<=1% price step / 2)", worst(200) < 20000, `worst ${worst(200)} ppm (grid step 2.02% in price)`);

  // on-chain: buy exactly A (price limit = graduation price) after the decay window
  for (const [tLabel, target, spacing] of [["$150", TARGETS["$150"], 200], ["$150", TARGETS["$150"], 10], ["$30K", TARGETS["$30K"], 200]]) {
    const P = await launch(env, { target, spacing });
    const ts = P.openAt + 120n;
    const big = (P.pl.raiseA * 105n) / 100n;
    const t = await buy(env, P, env.W.whale, big, { limit: P.pl.sG, ts });
    const g2 = await gs(P);
    const totalIn = t.swap.amount1;
    const fee = t.fee.plugin1 + t.fee.community1;
    const curveIn = totalIn - fee;
    check(`${tLabel} sp ${spacing}: buying all of A stops exactly at the graduation price`, g2.price === P.pl.sG, `tick ${g2.tick} == tickGrad ${P.pl.tickGrad}`);
    check(`${tLabel} sp ${spacing}: coins out == A (850M minus rounding)`, absDiff(-t.swap.amount0, COINS_A) < 10n ** 6n, `${fmt(-t.swap.amount0, 6)}`);
    check(`${tLabel} sp ${spacing}: native into A (ex fee) == planned raise (V3 math) within 2 wei`, absDiff(curveIn, P.pl.raiseA) <= 2n, `${fmt(curveIn, 9)} DOGE vs plan ${fmt(P.pl.raiseA, 9)}; gen-7 R ${fmt(P.pl.gen7Raise, 9)} (${ppm(curveIn, P.pl.gen7Raise)} ppm); at $0.10: $${(Number(curveIn / 10n ** 14n) / 1e4 * 0.1).toFixed(2)}`);
    check(`${tLabel} sp ${spacing}: fee on that buy is the gen-7 2% on top of the curve cost`, absDiff((fee * 1_000_000n) / curveIn, 20_000n) <= 3n, `fee ${fmt(fee, 9)} = ${pct(fee, curveIn)} of curve cost`);
    check(`${tLabel} sp ${spacing}: the latch fires at the graduation price (price >= sqrtGrad)`, !!t.graduated && (await env.P.isGraduated(P.poolAddr)));
    DATA[`buyOutA_${tLabel}_${spacing}`] = { totalIn: fmt(totalIn, 9), curveIn: fmt(curveIn, 9), fee: fmt(fee, 9), plan: fmt(P.pl.raiseA, 9), gen7: fmt(P.pl.gen7Raise, 9), gas: Number(t.gas) };
    gas(`buy out all of A (${tLabel}, sp ${spacing}, crosses into graduation, price-limited multicall)`, t.gas);
    snap = await revertTo(env, snap);
  }
  await revertTo(env, snap); // every revertTo returns to the pre-launch state with a fresh snapshot
}

async function mainFlow(env) {
  // three live pools: M (plugin-fee mode), G (coin guard on), L (LP-fee mode + inline graduation fee)
  CTX = "3 fees";
  const M = await launch(env, { spacing: 200, firstBuy: 10n * WAD, name: "Main", symbol: "MAIN" });
  gas("launch M with creator first buy 10 DOGE (1 tx)", M.gas);
  const fb = parseSwap(env, M, M.rc);
  const fbFee = fb.pluginFeeEvents.length ? fb.pluginFeeEvents[0].fee1 : 0n;
  const fbVault = await env.wdoge.balanceOf(A.vault);
  {
    const total = fb.swap.amount1;
    const commFee = (await M.pool.getCommunityFeePending())[1];
    note(`first buy: in ${fmt(total)} DOGE, coins ${fmt(-fb.swap.amount0, 2)}, Swap.overrideFee ${fb.swap.overrideFee} pluginFee ${fb.swap.pluginFee}`);
    check("creator first buy inside launch pays the bonding rate (2%), not the 90% launch fee", BigInt(fb.swap.pluginFee) === buyCharged(20_000n), `pluginFee ${fb.swap.pluginFee} = 2/102 of input`);
    check("first fee after creation is pushed at once (lastFeeTransferTimestamp was 0): handlePluginFee in the launch tx", fb.pluginFeeEvents.length === 1 && fbFee > 0n && commFee === 0n, `P got ${fmt(fbFee, 9)} WDOGE`);
  }

  // 3a launch decay, sampled in snapshots
  let snap = await snapshot(env);
  DATA.decay = [];
  for (const dt of [1n, 10n, 30n, 45n, 59n, 60n, 61n]) {
    const ts = M.openAt + dt;
    const t = await buy(env, M, env.W.buyer, 1n * WAD, { ts });
    const rate = expectedRate(M, t.ts);
    const fee = t.fee.plugin1 + t.fee.community1;
    const curve = t.swap.amount1 - fee;
    const onTop = (fee * FEE_DENOM) / curve;
    const okRate = BigInt(t.swap.pluginFee) === buyCharged(rate) && Number(t.swap.overrideFee) === 0;
    check(`decay t+${dt}s: plugin fee = gen-7 rate ${Number(rate) / 1e4}% on top (input share ${pct(fee, t.swap.amount1, 2)})`, okRate && absDiff(onTop, rate) <= 3n, `fee ${fmt(fee, 6)} of 1 DOGE, curve ${fmt(curve, 6)}, fee/curve ${Number(onTop) / 1e4}%`);
    DATA.decay.push({ t: Number(dt), rateBps: Number(rate) / 100, pluginFeeReturned: Number(t.swap.pluginFee), feeDoge: fmt(fee, 9), feeShareOfInput: pct(fee, t.swap.amount1, 3) });
    snap = await revertTo(env, snap);
  }
  await env.provider.send("evm_revert", [snap]);
  for (const w of Object.values(env.W)) w.reset();

  const G = await launch(env, { spacing: 200, firstBuy: 10n * WAD, guard: true, name: "Guarded", symbol: "GRD" });
  const Lp = await launch(env, { spacing: 200, firstBuy: 10n * WAD, lpFeeMode: true, gradInline: true, name: "LpMode", symbol: "LPM" });
  DATA.pools = { M: M.poolAddr, G: G.poolAddr, L: Lp.poolAddr, coinM: M.coinAddr, coinG: G.coinAddr, coinL: Lp.coinAddr };

  // after every pool's 60 s window
  let ts = (await now(env)) + 120n;
  const b1 = await buy(env, M, env.W.buyer, 5n * WAD, { ts });
  gas("router buy 5 DOGE (exactInputSingle, native in), bonding, no payout", b1.gas);
  {
    const fee = b1.fee.plugin1 + b1.fee.community1;
    const curve = b1.swap.amount1 - fee;
    check("bonding buy: fee 2% on top of the curve cost (gen-7 definition)", absDiff((fee * FEE_DENOM) / curve, 20_000n) <= 3n, `in ${fmt(b1.swap.amount1)} curve ${fmt(curve, 9)} fee ${fmt(fee, 9)}`);
    check("buy fee is collected in the INPUT token: WDOGE (token1) only", b1.fee.plugin1 > 0n && b1.fee.plugin0 === 0n && b1.fee.community0 === 0n);
    check("community vault share = 3% of the whole fee (plugin keeps 97%)", absDiff(b1.fee.community1, (fee * 30n) / 1000n) <= 1n && absDiff(b1.fee.plugin1, fee - (fee * 30n) / 1000n) <= 1n, `community ${fmt(b1.fee.community1, 9)} plugin ${fmt(b1.fee.plugin1, 9)} = ${pct(b1.fee.plugin1, curve)} of curve volume to us`);
    check("LP fee is 0: totalFeeGrowth unchanged (overrideFee 0 + lastFee 0)", b1.fee.lpGrowth1 === 0n && b1.fee.lpGrowth0 === 0n && Number(b1.swap.overrideFee) === 0);
    check("not pushed yet (8 h timer): fees wait in getPluginFeePending", b1.pluginFeeEvents.length === 0 && b1.fee.pushed1 === 0n);
    DATA.bondingBuy = { in: fmt(b1.swap.amount1, 9), curve: fmt(curve, 9), fee: fmt(fee, 9), plugin: fmt(b1.fee.plugin1, 9), community: fmt(b1.fee.community1, 9), gas: Number(b1.gas) };
  }
  // direct pool trade, no router
  {
    await (await env.wdoge.connect(env.W.buyer).deposit({ value: 5n * WAD })).wait();
    await (await env.wdoge.connect(env.W.buyer).approve(env.swapper.target, ethers.MaxUint256)).wait();
    const tx = await env.swapper.connect(env.W.buyer).swap(M.poolAddr, false, 1n * WAD, TM.MAX_SQRT_RATIO - 1n, { gasLimit: 2_000_000n });
    const rc = await tx.wait();
    gas("direct pool.swap buy 1 WDOGE (helper contract, no router), bonding", rc.gasUsed);
  }
  const sellAmt = 2_000_000n * WAD;
  await (await M.coin.connect(env.W.buyer).transfer(env.addr.seller, sellAmt * 3n)).wait();
  const s1 = await sell(env, M, env.W.seller, sellAmt);
  gas("router sell 2M coins (multicall exactInputSingle + unwrapWNativeToken), bonding", s1.gas);
  {
    const fee0 = s1.fee.plugin0 + s1.fee.community0;
    check("sell fee is collected in the INPUT token: the coin (token0), not native", s1.fee.plugin0 > 0n && s1.fee.plugin1 === 0n && s1.fee.community1 === 0n, `plugin ${fmt(s1.fee.plugin0, 2)} coins, community ${fmt(s1.fee.community0, 2)} coins`);
    check("sell fee = 2% of the coins sold within 1,000 wei (price-step rounding dust lands in the fee; gen-7 takes 2% of the native payout: same value, other token)", absDiff(fee0, (sellAmt * 2n) / 100n) <= 1000n && Number(s1.swap.pluginFee) === 20_000, `fee ${fmt(fee0, 2)} coins of ${fmt(sellAmt, 0)} (diff ${absDiff(fee0, (sellAmt * 2n) / 100n)} wei, pluginFee ${s1.swap.pluginFee}, override ${s1.swap.overrideFee}); seller got ${fmt(s1.nativeOut, 9)} DOGE`);
    DATA.bondingSell = { coinsIn: fmt(sellAmt, 0), feeCoins: fmt(fee0, 6), nativeOut: fmt(s1.nativeOut, 9), gas: Number(s1.gas) };
  }

  // LP-fee mode pool (overrideFee semantics)
  CTX = "3 overrideFee";
  {
    const gL = await gs(Lp);
    const t = await buy(env, Lp, env.W.buyer, 5n * WAD);
    const lpFee = (t.fee.lpGrowth1 * (await Lp.pool.liquidity())) >> 128n; // growth uses the liquidity at the swap
    const total = t.swap.amount1 - (t.swap.amount1 * FEE_DENOM) / (FEE_DENOM + 20_000n); // approx gen-7 fee
    check("LP-fee mode: lastFee stays 500 but overrideFee != 0 replaces it; pluginFee 0", gL.lastFee === 500 && BigInt(t.swap.overrideFee) === buyCharged(20_000n) && Number(t.swap.pluginFee) === 0);
    check("LP-fee mode: nothing goes to plugin pending; fee accrues as LP fee growth to our positions", t.fee.plugin1 === 0n && t.fee.lpGrowth1 > 0n, `LP fee ~${fmt(lpFee, 9)} WDOGE, community ${fmt(t.fee.community1, 9)}`);
    const trBefore = await env.wdoge.balanceOf(env.addr.treasury);
    const tx = await env.D.connect(env.W.keeper).collectLpFees(Lp.poolAddr, { gasLimit: 1_000_000n });
    const rc = await tx.wait();
    const got = (await env.wdoge.balanceOf(env.addr.treasury)) - trBefore;
    gas("LP-fee mode: collectLpFees (poke A+B with burn 0, collect both)", rc.gasUsed);
    check("LP-fee mode: treasury collects the LP fees at once (no 8 h wait, no handlePluginFee)", got > 0n, `${fmt(got, 9)} WDOGE (first-buy + this buy, 97% of fees)`);
    DATA.lpMode = { buyFeeApprox: fmt(total, 9), collected: fmt(got, 9), collectGas: Number(rc.gasUsed) };
  }

  // ------------------------------------------------------------------ 4. outside liquidity
  CTX = "4 LP block";
  {
    const atk = env.W.attacker;
    await (await M.coin.connect(env.W.buyer).transfer(env.addr.attacker, 1_000_000n * WAD)).wait();
    await (await M.coin.connect(atk).approve(A.npm, ethers.MaxUint256)).wait();
    await (await env.wdoge.connect(atk).deposit({ value: 10n * WAD })).wait();
    await (await env.wdoge.connect(atk).approve(A.npm, ethers.MaxUint256)).wait();
    const g = await gs(M);
    const up = M.pl.tickGrad + 2000;
    const mintP = [M.coinAddr, A.wdoge, env.D.target, M.pl.tickGrad, up, 1000n * WAD, 0n, 0n, 0n, env.addr.attacker, 2n ** 40n];
    const r1 = await revertOf(() => env.npm.connect(atk).mint.staticCall(mintP), env.ifaces);
    check("outsider NPM mint (coin-only above price) into our pool reverts LiquidityIsLocked", r1 === "LiquidityIsLocked", r1);
    const lo = Math.floor(g.tick / 200) * 200 - 2000;
    const mintW = [M.coinAddr, A.wdoge, env.D.target, lo, lo + 1000, 0n, 1n * WAD, 0n, 0n, env.addr.attacker, 2n ** 40n];
    const r2 = await revertOf(() => env.npm.connect(atk).mint.staticCall(mintW), env.ifaces);
    check("outsider NPM mint (WDOGE-only below price) reverts LiquidityIsLocked", r2 === "LiquidityIsLocked", r2);
    await (await M.coin.connect(atk).transfer(env.minter.target, 10_000n * WAD)).wait();
    const r3 = await revertOf(() => env.minter.connect(atk).mint.staticCall(M.poolAddr, M.pl.tickGrad, up, 10n ** 18n), env.ifaces);
    check("outsider direct pool.mint (own callback) reverts LiquidityIsLocked", r3 === "LiquidityIsLocked", r3);
    const r4 = await revertOf(() => env.npm.connect(atk).createAndInitializePoolIfNecessary.staticCall(M.coinAddr, A.wdoge, env.D.target, M.pl.sG, "0x"), env.ifaces);
    check("NPM.createAndInitializePoolIfNecessary with deployer D is a no-op on our initialized pool", r4 === null);
    note("D's own mints are proven by every launch (sender == D passes beforeModifyPosition); D's burn in takeGraduationFee below");
  }

  // ------------------------------------------------------------------ 7. router / quoter
  CTX = "7 router";
  {
    const q = await env.quoter.quoteExactInputSingle.staticCall([A.wdoge, M.coinAddr, env.D.target, 3n * WAD, 0n]);
    const t = await buy(env, M, env.W.buyer, 3n * WAD);
    check("QuoterV2.quoteExactInputSingle(deployer = D) quotes our custom pool incl. the plugin fee exactly", q[0] === t.coinOut, `quote ${fmt(q[0], 2)} == got ${fmt(t.coinOut, 2)}`);
    check("router exactInputSingle(deployer = D, native value) swaps in our pool (router wraps DOGE)", t.coinOut > 0n && t.swap && t.nativePaid === 3n * WAD);
    const r = await revertOf(() => env.router.connect(env.W.buyer).exactInputSingle.staticCall([A.wdoge, M.coinAddr, ethers.ZeroAddress, env.addr.buyer, 2n ** 40n, WAD, 0n, 0n], { value: WAD }), env.ifaces);
    check("router with deployer = address(0) targets the (non-existent) default pool and reverts", r !== null, r);
    note("the router derives the pool from (deployer, token0, token1) by CREATE2: custom pools need deployer = D in every swap and quote; multi-hop paths encode tokenIn|deployer|tokenOut");
  }

  // ------------------------------------------------------------------ 5. graduation
  CTX = "5 graduation";
  {
    const r0 = await revertOf(() => env.D.connect(env.W.keeper).takeGraduationFee.staticCall(M.poolAddr), env.ifaces);
    check("takeGraduationFee before the latch reverts NotGraduated", r0 === "NotGraduated", r0);
    const g0 = await gs(M);
    // native left in A to the graduation price
    const remaining = token1Delta(g0.price, M.pl.sG, M.pl.liqA, true);
    const amt = (remaining * 102n) / 100n + 1n * WAD; // crosses into B
    const t = await buy(env, M, env.W.whale, amt);
    const g1 = await gs(M);
    gas("graduation-crossing buy (latch + plugin drops its afterSwap flag)", t.gas);
    check("crossing buy started below the graduation price and ended above it", g0.price < M.pl.sG && g1.price > M.pl.sG, `tick ${g0.tick} -> ${g1.tick} (grad ${M.pl.tickGrad})`);
    check("crossing buy pays the bonding rate (price at swap START was inside A, F1)", BigInt(t.swap.pluginFee) === buyCharged(20_000n));
    const cfg = await env.P.pools(M.poolAddr);
    check("afterSwap latch: graduated = true, graduatedAt = block time, Graduated event", cfg.graduated && cfg.graduatedAt === t.ts && !!t.graduated, `graduatedAt ${cfg.graduatedAt}`);
    check("plugin reconfigured the pool from afterSwap (pool unlocked): config 135 -> 133, afterSwap off", g1.config === CONFIG_GRADUATED && t.config.includes(CONFIG_GRADUATED));
    DATA.graduation = { crossingIn: fmt(t.swap.amount1, 9), crossingGas: Number(t.gas), graduatedAt: Number(cfg.graduatedAt) };

    const b2 = await buy(env, M, env.W.buyer, 2n * WAD);
    gas("post-graduation buy 2 DOGE (1%, no afterSwap call)", b2.gas);
    const fee2 = b2.fee.plugin1 + b2.fee.community1;
    check("post-graduation buy pays 1% on top (price at start >= graduation price)", BigInt(b2.swap.pluginFee) === buyCharged(10_000n) && absDiff((fee2 * FEE_DENOM) / (b2.swap.amount1 - fee2), 10_000n) <= 3n, `fee ${fmt(fee2, 9)}`);

    // 5b graduation fee step (permissionless, separate tx)
    const trB = await env.wdoge.balanceOf(env.addr.treasury);
    const nativeInA = token1Delta(M.pl.sA, M.pl.sG, M.pl.liqA, false);
    const tx = await env.D.connect(env.W.keeper).takeGraduationFee(M.poolAddr, { gasLimit: 1_000_000n });
    const rc = await tx.wait();
    gas("takeGraduationFee (burn 2% of A + collect to treasury), separate permissionless tx", rc.gasUsed);
    const s = parseSwap(env, M, rc);
    const got = (await env.wdoge.balanceOf(env.addr.treasury)) - trB;
    const want = (nativeInA * 200n) / 10000n;
    check("graduation fee step: A returns only native (amount0 0) and the treasury receives it", s.gradFee && s.gradFee.amount0 === 0n && got === s.gradFee.amount1, `${fmt(got, 9)} WDOGE`);
    check("graduation fee == 2% of the native in A within 2 wei (gen-8 one-time 2%)", absDiff(got, want) <= 2n, `want floor(2% of ${fmt(nativeInA, 9)}) = ${fmt(want, 9)}`);
    const pA = await M.pool.positions(posKey(env.D.target, M.pl.tickStart, M.pl.tickGrad));
    check("A keeps 98% of its liquidity; B untouched", pA.liquidity === M.pl.liqA - (M.pl.liqA * 200n) / 10000n);
    const r2 = await revertOf(() => env.D.connect(env.W.keeper).takeGraduationFee.staticCall(M.poolAddr), env.ifaces);
    check("second takeGraduationFee reverts AlreadyTaken", r2 === "AlreadyTaken", r2);
    DATA.graduationFee = { got: fmt(got, 9), want: fmt(want, 9), nativeInA: fmt(nativeInA, 9), gas: Number(rc.gasUsed) };

    // sells: start above grad -> 1%; start inside A -> 2% (F1), latch stays
    const big = 300_000_000n * WAD;
    await (await M.coin.connect(env.W.whale).transfer(env.addr.seller, big)).wait();
    const s2 = await sell(env, M, env.W.seller, big / 2n);
    const g2 = await gs(M);
    check("sell starting at/above the graduation price pays 1% (in coins)", Number(s2.swap.pluginFee) === 10_000 && g2.price < M.pl.sG, `price fell back into A: tick ${g2.tick}`);
    const s3 = await sell(env, M, env.W.seller, 1_000_000n * WAD);
    check("next sell starting inside A pays the bonding 2% again (F1), latch stays set", Number(s3.swap.pluginFee) === 20_000 && (await env.P.isGraduated(M.poolAddr)));
  }

  // pool L: inline graduation fee in afterSwap
  {
    const g0 = await gs(Lp);
    const remaining = token1Delta(g0.price, Lp.pl.sG, Lp.pl.liqA, true);
    const trB = await env.wdoge.balanceOf(env.addr.treasury);
    const t = await buy(env, Lp, env.W.whale, (remaining * 102n) / 100n + 1n * WAD);
    gas("graduation-crossing buy WITH inline 2% graduation fee in afterSwap (pool L)", t.gas);
    const got = (await env.wdoge.balanceOf(env.addr.treasury)) - trB;
    check("inline variant: afterSwap latch calls D.takeGraduationFee in the same swap (pool unlocked, D's burn passes the plugin)", t.inline === true && !!t.gradFee && got === t.gradFee.amount1 && t.gradFee.amount0 === 0n, `${fmt(got, 9)} WDOGE to treasury`);
  }

  // ------------------------------------------------------------------ 6. plugin fee payout
  CTX = "6 payout";
  {
    const last = BigInt(await M.pool.lastFeeTransferTimestamp());
    const pend = await M.pool.getPluginFeePending();
    check("fees from all M swaps since the launch push are pending in both tokens", pend[0] > 0n && pend[1] > 0n, `${fmt(pend[0], 2)} coins + ${fmt(pend[1], 9)} WDOGE`);
    // just before 8 h: no push
    let t = await buy(env, M, env.W.buyer, 1n * WAD, { ts: last + 8n * HOUR - 10n });
    check("a swap 10 s before the 8 h mark does not push (pending grows)", t.pluginFeeEvents.length === 0 && t.fee.pushed1 === 0n);
    // revert switch: a reverting handlePluginFee bricks payout swaps
    let snap = await snapshot(env);
    await (await env.P.connect(env.W.deployer).setResearchRevertHandle(true)).wait();
    const rNo = await revertOf(() => env.router.connect(env.W.buyer).exactInputSingle.staticCall([A.wdoge, M.coinAddr, env.D.target, env.addr.buyer, 2n ** 40n, WAD, 0n, 0n], { value: WAD }), env.ifaces);
    check("with handlePluginFee reverting, swaps before the 8 h mark still work (handler not called)", rNo === null);
    await setNextTs(env, last + 8n * HOUR + 5n);
    await env.provider.send("evm_mine", []);
    const rYes = await revertOf(() => env.router.connect(env.W.buyer).exactInputSingle.staticCall([A.wdoge, M.coinAddr, env.D.target, env.addr.buyer, 2n ** 40n, WAD, 0n, 0n], { value: WAD }), env.ifaces);
    check("a reverting handlePluginFee reverts every payout swap (P must never revert)", rYes === "ResearchRevert", rYes);
    await env.provider.send("evm_revert", [snap]);
    for (const w of Object.values(env.W)) w.reset();

    const st0 = await feeState(env, M);
    const vaultC0 = st0.v0;
    const vaultW0 = st0.v1;
    t = await buy(env, M, env.W.buyer, 1n * WAD, { ts: last + 8n * HOUR + 1n });
    gas("payout swap: buy 1 DOGE that triggers the 8 h push (plugin + community, 2 tokens each)", t.gas);
    const st1 = await feeState(env, M);
    const ev = t.pluginFeeEvents[0];
    check("8 h later the next fee-bearing swap calls P.handlePluginFee(fee0, fee1) once", t.pluginFeeEvents.length === 1, ev ? `fee0 ${fmt(ev.fee0, 2)} coins, fee1 ${fmt(ev.fee1, 9)} WDOGE` : "");
    check("handlePluginFee amounts == pending + this swap's fee; pending now 0", ev && ev.fee0 === st0.pp0 && ev.fee1 === st0.pp1 + t.fee.plugin1 && st1.pp0 === 0n && st1.pp1 === 0n);
    check("P receives BOTH tokens (coin from sells, WDOGE from buys) and its balances move by exactly those amounts", st1.pb0 - st0.pb0 === ev.fee0 && st1.pb1 - st0.pb1 === ev.fee1);
    check("community vault receives its pending 3% in both tokens in the same swap", st1.v0 - vaultC0 === st0.cp0 && st1.v1 - vaultW0 === st0.cp1 + t.fee.community1, `vault +${fmt(st1.v0 - vaultC0, 2)} coins, +${fmt(st1.v1 - vaultW0, 9)} WDOGE`);
    check("lastFeeTransferTimestamp reset to the payout block", BigInt(await M.pool.lastFeeTransferTimestamp()) === t.ts);
    // attribution: P serves M, G and L; per-pool books reconcile with P's balances
    const books = { M: await env.P.feesNative(M.poolAddr), G: await env.P.feesNative(G.poolAddr), L: await env.P.feesNative(Lp.poolAddr) };
    const pW = await env.wdoge.balanceOf(env.P.target);
    check("per-pool attribution (msg.sender = pool): sum of feesNative over our pools == P's WDOGE balance", books.M + books.G + books.L === pW && books.G > 0n && books.L === 0n, `M ${fmt(books.M, 9)} G ${fmt(books.G, 9)} L ${fmt(books.L, 9)} (LP mode) = ${fmt(pW, 9)}`);
    check("per-pool coin books == P's balance of each coin", (await env.P.feesCoin(M.poolAddr)) === (await M.coin.balanceOf(env.P.target)) && (await env.P.feesCoin(G.poolAddr)) === (await G.coin.balanceOf(env.P.target)));
    // lifetime community share
    const allPlugin = (await env.P.feesNative(M.poolAddr));
    note(`lifetime M: P received ${fmt(allPlugin, 9)} WDOGE + ${fmt(await env.P.feesCoin(M.poolAddr), 2)} coins`);

    // convert coin fees to native in the same pool: plugin's own swap skips hooks and pays no fee
    const coinFees = await env.P.feesCoin(M.poolAddr);
    const before = await feeState(env, M);
    const tx = await env.P.connect(env.W.keeper).convertCoinFees(M.poolAddr, { gasLimit: 1_500_000n });
    const rc = await tx.wait();
    const after = await feeState(env, M);
    const cs = parseSwap(env, M, rc);
    gas("convertCoinFees: P sells its coin fees into the pool (hooks skipped)", rc.gasUsed);
    check("P's own swap skips beforeSwap/afterSwap: overrideFee 0, pluginFee 0, no community fee (lastFee 0)", cs.swap && Number(cs.swap.overrideFee) === 0 && Number(cs.swap.pluginFee) === 0 && after.cp0 === before.cp0 && after.pp0 === before.pp0, `sold ${fmt(coinFees, 2)} coins for ${fmt(-cs.swap.amount1, 9)} WDOGE`);
    check("after conversion P holds only WDOGE for M and the books still reconcile", (await env.P.feesCoin(M.poolAddr)) === 0n && (await env.wdoge.balanceOf(env.P.target)) === (await env.P.feesNative(M.poolAddr)) + (await env.P.feesNative(G.poolAddr)));
    DATA.payout = { fee0: fmt(ev.fee0, 6), fee1: fmt(ev.fee1, 9), vaultCoins: fmt(st1.v0 - vaultC0, 6), vaultWdoge: fmt(st1.v1 - vaultW0, 9), payoutGas: Number(t.gas), convertGas: Number(rc.gasUsed) };
  }

  // ------------------------------------------------------------------ 8. side pool + coin guard
  CTX = "8 side pool";
  {
    const atk = env.W.attacker;
    // guard cost: two fresh twins launched back to back (same fee-timer state), one coin without and one with the guard
    const U = await launch(env, { spacing: 200, firstBuy: 10n * WAD, name: "Unguarded", symbol: "UNG" });
    const G = await launch(env, { spacing: 200, firstBuy: 10n * WAD, guard: true, name: "Guarded2", symbol: "GRD2" });
    const t0 = (await now(env)) + 200n;
    const bu = await buy(env, U, env.W.buyer, 2n * WAD, { ts: t0 });
    const bg = await buy(env, G, env.W.buyer, 2n * WAD, { ts: t0 + 1n });
    gas("router buy 2 DOGE, coin WITHOUT guard (twin pool)", bu.gas);
    gas("router buy 2 DOGE, coin WITH side-pool guard", bg.gas, `+${Number(bg.gas - bu.gas)}`);
    await (await U.coin.connect(env.W.buyer).transfer(env.addr.seller, 1_000_000n * WAD)).wait();
    await (await G.coin.connect(env.W.buyer).transfer(env.addr.seller, 1_000_000n * WAD)).wait();
    const su = await sell(env, U, env.W.seller, 500_000n * WAD);
    const sg = await sell(env, G, env.W.seller, 500_000n * WAD);
    gas("router sell 500K coins, coin WITHOUT guard", su.gas);
    gas("router sell 500K coins, coin WITH guard", sg.gas, `+${Number(sg.gas - su.gas)}`);
    const tu = await (await U.coin.connect(env.W.seller).transfer(env.addr.keeper, WAD)).wait();
    const tg = await (await G.coin.connect(env.W.seller).transfer(env.addr.keeper, WAD)).wait();
    gas("plain transfer to an EOA, no guard / guard", tu.gasUsed, `guard ${tg.gasUsed}, +${Number(tg.gasUsed - tu.gasUsed)}`);
    const tuc = await (await U.coin.connect(env.W.seller).transfer(env.minter.target, WAD)).wait();
    const tgc = await (await G.coin.connect(env.W.seller).transfer(env.minter.target, WAD)).wait();
    gas("plain transfer to a contract (not a pool), no guard / guard", tuc.gasUsed, `guard ${tgc.gasUsed}, +${Number(tgc.gasUsed - tuc.gasUsed)}`);
    check("router swaps on our pool keep working with the guarded coin (buy and sell)", bg.coinOut > 0n && sg.nativeOut > 0n);

    // anyone may create the default pool for coin/WDOGE
    for (const [lbl, P] of [["unguarded", U], ["guarded", G]]) {
      const r0 = await env.factory.poolByPair(P.coinAddr, A.wdoge);
      const tx = await env.factory.connect(atk).createPool(P.coinAddr, A.wdoge, "0x", { gasLimit: 9_900_000n });
      const rc = await tx.wait();
      const side = await env.factory.poolByPair(P.coinAddr, A.wdoge);
      gas(`side pool: factory.createPool(coin, WDOGE) by an outsider (${lbl})`, rc.gasUsed, "deploys a BasePluginV1 per pool");
      check(`outsider created a default (side) pool for our ${lbl} coin, next to our custom pool`, r0 === ethers.ZeroAddress && side !== ethers.ZeroAddress && side !== P.poolAddr, side);
      const sp = new ethers.Contract(side, POOL_ABI, env.provider);
      const g = await gs(P);
      await (await sp.connect(atk).initialize(g.price, { gasLimit: 1_000_000n })).wait();
      const bal = await P.coin.balanceOf(env.addr.attacker);
      if (bal < 2000n * WAD) await (await P.coin.connect(env.W.buyer).transfer(env.addr.attacker, 10_000n * WAD)).wait();
      await (await P.coin.connect(atk).approve(A.npm, ethers.MaxUint256)).wait();
      const gt = (await gs({ pool: sp })).tick;
      const lo = Math.ceil((gt + 1) / 60) * 60 + 60;
      const mp = [P.coinAddr, A.wdoge, ethers.ZeroAddress, lo, lo + 6000, 1000n * WAD, 0n, 0n, 0n, env.addr.attacker, 2n ** 40n];
      const r = await revertOf(() => env.npm.connect(atk).mint.staticCall(mp), env.ifaces);
      if (lbl === "unguarded") {
        check("unguarded coin: outsider adds coin liquidity to the side pool (we cannot stop it)", r === null, r ?? "ok");
      } else {
        check("guarded coin: outsider's NPM mint into the side pool reverts (coin refuses the transfer; NPM reports STF)", r !== null && r.includes("STF"), r);
        const r2 = await revertOf(() => P.coin.connect(atk).transfer.staticCall(side, WAD), env.ifaces);
        check("guarded coin: a direct transfer to the side pool reverts SidePoolBlocked", r2 && r2.startsWith("SidePoolBlocked"), r2);
        DATA.sidePool = { side, guardBuyExtraGas: Number(bg.gas - bu.gas), guardSellExtraGas: Number(sg.gas - su.gas), guardEoaTransferExtraGas: Number(tg.gasUsed - tu.gasUsed), guardContractTransferExtraGas: Number(tgc.gasUsed - tuc.gasUsed), createPoolGas: Number(rc.gasUsed) };
        // after graduation the guard lifts
        const gg = await gs(G);
        const remaining = token1Delta(gg.price, G.pl.sG, G.pl.liqA, true);
        await buy(env, G, env.W.whale, (remaining * 102n) / 100n + WAD);
        const r3 = await revertOf(() => env.npm.connect(atk).mint.staticCall(mp), env.ifaces);
        check("guarded coin: after our pool graduates the guard lifts (side-pool mint works)", (await env.P.isGraduated(G.poolAddr)) && r3 === null, r3 ?? "ok");
      }
    }
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const t0 = Date.now();
  log(`Barkswap custom-pool plugin fork proof (research only), ${new Date().toISOString()}`);
  const { contracts: C, solcVersion } = compileAll();
  log(`compiled with solc ${solcVersion}, evm paris, viaIR, optimizer 200: launcher ${C.MwzBarkLauncher.runtimeSize} B, plugin ${C.MwzBarkPlugin.runtimeSize} B, token ${C.MwzBarkToken.runtimeSize} B`);
  check("tickmath self-test", TM.selfTest());
  let env;
  try {
    env = await setup(C);
    await check1and2Launch(env);
    await mainFlow(env);
  } catch (e) {
    CTX = "fatal";
    check("run completed without an exception", false, String(e?.stack || e).slice(0, 1500));
  } finally {
    if (env?.child) killTree(env.child);
  }
  const passed = RESULTS.filter((r) => r.pass).length;
  const failed = RESULTS.length - passed;
  log("");
  log("GAS TABLE");
  for (const g of GAS) log(`  ${String(g.gas).padStart(10)}  ${g.step}${g.detail ? "  (" + g.detail + ")" : ""}`);
  log("");
  log(`RESULT: ${passed}/${RESULTS.length} checks passed, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const outDir = path.join(here, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "barkswap-plugin-proof.log"), LOG_LINES.join("\n") + "\n");
  const json = { generatedAt: new Date().toISOString(), passed, failed, total: RESULTS.length, results: RESULTS, gas: GAS, data: DATA, addresses: A, fees1e6: FEES, dogeUsd: "0.10" };
  fs.writeFileSync(path.join(outDir, "barkswap-plugin-proof.json"), JSON.stringify(json, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  process.exit(failed ? 1 : 0);
}

main();

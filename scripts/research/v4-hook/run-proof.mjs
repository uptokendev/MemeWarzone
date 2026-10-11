// RESEARCH ONLY. Local anvil fork proof: coins launch straight into a canonical Uniswap V4 pool
// (native vs coin, dynamic fee, LP fee 0) with our hook taking every fee in native.
// No real transactions: everything runs against local anvil forks of BSC (56) and Robinhood (4663).
//
//   node run-proof.mjs [--chains bsc,rh] [--targets 30000,50000]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import * as gen7 from "../../../frontend/shared/evmGen7Curve.mjs";
import { compileAll } from "./compile.mjs";
import * as TM from "./tickmath.mjs";
import { WAD, Q96, BPS, readEnvFile, startAnvil, fmt, absDiff, ppm, ceilDiv, amount0Delta, amount1Delta, mcFromSqrt, revertOf } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const CHAINS = argVal("--chains", "bsc,rh").split(",");
const TARGETS = argVal("--targets", "30000,50000").split(",").map((x) => BigInt(x));
const ENV = readEnvFile(process.env.MWZ_ENV_FILE || "/mnt/e/network/Zakelijk/MemeWarzone/.env");

const SUPPLY = 1_000_000_000n * WAD;
const COINS_A = 850_000_000n * WAD;
const COINS_B = 130_000_000n * WAD;
const SPACING = 10;
const HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 6n) | (1n << 5n) | (1n << 3n) | (1n << 2n); // 0x28EC
const CREATE2_PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_U160 = (1n << 160n) - 1n;

const CHAIN_CFG = {
  bsc: {
    label: "BNB Chain mainnet fork (56)",
    chainId: 56n,
    rpc: process.env.BSC_MAINNET_RPC || ENV.BSC_MAINNET_RPC,
    port: 8661,
    oracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    wNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB: display pairs on BNB only
    pm: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    posm: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
    urs: { "UR (docs main)": "0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "UR 2.1.1": "0x8b844f885672f333bc0042cb669255f93a4c1e6b", "UR 2.1.2": "0xDc264714F68d84CF29BC605589405E78bDBE7C9f" },
    quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
  },
  rh: {
    label: "Robinhood Chain mainnet fork (4663)",
    chainId: 4663n,
    rpc: process.env.ROBINHOOD_MAINNET_RPC || ENV.ROBINHOOD_MAINNET_RPC,
    port: 8662,
    oracle: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    pm: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    posm: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    urs: { "UR (docs main)": "0x8876789976decbfcbbbe364623c63652db8c0904", "UR 2.1.2": "0x204FAca1764B154221e35c0d20aBb3c525710498" },
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  },
};

const PM_ABI = [
  "function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function protocolFeeController() view returns (address)",
  "function setProtocolFee((address,address,uint24,int24,address) key, uint24 newProtocolFee)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error PoolNotInitialized()",
  "error PoolAlreadyInitialized()",
  "error CurrencyNotSettled()",
  "error CannotUpdateEmptyPosition()",
  "error TickLiquidityOverflow(int24)",
  "error HookNotImplemented()",
  "error ManagerLocked()",
  "error AlreadyUnlocked()",
];
const SV_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256, uint256)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((( address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
  "function quoteExactOutputSingle((( address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)",
];
const UR_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable", "error ExecutionFailed(uint256 commandIndex, bytes message)", "error V4TooLittleReceived(uint256,uint256)", "error V4TooMuchRequested(uint256,uint256)"];
const POSM_ABI = ["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"];
const ERC20_ABI = ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const PERMIT2_ABI = ["function approve(address token, address spender, uint160 amount, uint48 expiration)"];
const ORACLE_ABI = ["function nativeTargetForUsd(uint256) view returns (uint256)", "function nativeUsdPrice() view returns (uint256)"];

const coder = ethers.AbiCoder.defaultAbiCoder();
const REF = ethers.getAddress("0x00000000000000000000000000000000000ae1e7");
const KEY_T = "tuple(address,address,uint24,int24,address)";

// ------------------------------------------------------------------ results
const RESULTS = [];
let CTX = "";
function check(name, pass, detail = "") {
  RESULTS.push({ ctx: CTX, name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${CTX}] ${name}${detail ? "  " + detail : ""}`);
  return !!pass;
}
function note(line) {
  console.log(`     [${CTX}] ${line}`);
}

// ------------------------------------------------------------------ UR encoding
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_OUT_SINGLE: 0x08, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f, MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d };
function urSingleParams(style, key, zeroForOne, amt, limit, hookData) {
  if (style === "v2.0") return coder.encode([`tuple(${KEY_T},bool,uint128,uint128,bytes)`], [[key, zeroForOne, amt, limit, hookData]]);
  return coder.encode([`tuple(${KEY_T},bool,uint128,uint128,uint256,bytes)`], [[key, zeroForOne, amt, limit, 0n, hookData]]);
}
function urCalldata(style, key, { zeroForOne, exactIn, amount, limit, hookData = "0x" }) {
  const cIn = zeroForOne ? key[0] : key[1];
  const cOut = zeroForOne ? key[1] : key[0];
  const swapAct = exactIn ? ACT.SWAP_EXACT_IN_SINGLE : ACT.SWAP_EXACT_OUT_SINGLE;
  const actions = ethers.solidityPacked(["uint8", "uint8", "uint8"], [swapAct, ACT.SETTLE_ALL, ACT.TAKE_ALL]);
  const params = [
    urSingleParams(style, key, zeroForOne, amount, limit, hookData),
    coder.encode(["address", "uint256"], [cIn, exactIn ? amount : limit]),
    coder.encode(["address", "uint256"], [cOut, exactIn ? limit : amount]),
  ];
  const v4 = coder.encode(["bytes", "bytes[]"], [actions, params]);
  const inputs = [v4];
  let commands = "0x10";
  if (!exactIn && zeroForOne) {
    // refund unspent native: SWEEP(token=native, recipient=MSG_SENDER, amountMin=0)
    commands = "0x1004";
    inputs.push(coder.encode(["address", "address", "uint256"], [ethers.ZeroAddress, "0x0000000000000000000000000000000000000001", 0n]));
  }
  return { commands, inputs };
}

// ------------------------------------------------------------------ chain setup
async function setupChain(name, C) {
  const cfg = CHAIN_CFG[name];
  if (!cfg.rpc) throw new Error(`no RPC for ${name}`);
  CTX = name;
  let child, provider;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ child, provider } = await startAnvil(cfg.rpc, cfg.port, cfg.label, cfg.chainId, process.env[`FORK_BLOCK_${name.toUpperCase()}`]));
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`anvil start attempt ${attempt} failed, retrying: ${String(e.message).slice(0, 120)}`);
    }
  }
  const chainId = (await provider.getNetwork()).chainId;
  const forkBlock = await provider.getBlock("latest");
  check("fork chainId", chainId === cfg.chainId, `chainId ${chainId} block ${forkBlock.number}`);

  // Fresh deterministic keys, funded on the fork only. The well-known anvil keys are EIP-7702
  // delegated to sweeper contracts on BSC mainnet, which forward any native they receive.
  const names = ["deployer", "creator", "buyer", "bot", "attacker", "treasury", "safe", "creator2", "treasury2", "payee"];
  const W = {};
  for (const n of names) W[n] = new ethers.NonceManager(new ethers.Wallet(ethers.id("mwz-v4-hook-research/" + n), provider));
  const { deployer } = W;
  const A = {};
  for (const [k, w] of Object.entries(W)) {
    A[k] = await w.getAddress();
    await provider.send("anvil_setBalance", [A[k], "0x" + (100_000_000n * WAD).toString(16)]);
    check(`test account ${k} has no code on the fork`, (await provider.getCode(A[k])) === "0x", A[k]);
  }

  // canonical contracts have code on the fork
  for (const [label, addr] of [["PoolManager", cfg.pm], ["PositionManager", cfg.posm], ["V4Quoter", cfg.quoter], ["StateView", cfg.stateView], ["Permit2", PERMIT2], ["CREATE2 proxy", CREATE2_PROXY], ["gen-7 GraduationOracle", cfg.oracle], ...Object.entries(cfg.urs)]) {
    const code = await provider.getCode(addr);
    check(`code at ${label}`, code.length > 2, `${addr} ${(code.length - 2) / 2} bytes`);
  }
  const pm = new ethers.Contract(cfg.pm, PM_ABI, provider);
  const sv = new ethers.Contract(cfg.stateView, SV_ABI, provider);
  const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
  const oracle = new ethers.Contract(cfg.oracle, ORACLE_ABI, provider);
  const nativeUsd = await oracle.nativeUsdPrice();
  note(`oracle native/USD at fork block: $${fmt(nativeUsd, 2)}  block gas limit ${forkBlock.gasLimit}`);

  // ---- deploy: display factory (BNB only), hook via CREATE2 with a mined salt, launcher at a predicted nonce
  let displayFactory = null;
  if (cfg.wNative) {
    const F = C.MwzDisplayPairFactory;
    const fc = await new ethers.ContractFactory(F.abi, F.bytecode, deployer).deploy(cfg.wNative);
    await fc.waitForDeployment();
    displayFactory = new ethers.Contract(await fc.getAddress(), F.abi, provider);
  }
  const startNonce = await provider.getTransactionCount(A.deployer);
  const launcherAddr = ethers.getCreateAddress({ from: A.deployer, nonce: startNonce + 1 });
  const H = C.MwzLaunchHook;
  const initCode = ethers.concat([H.bytecode, coder.encode(["address", "address", "address", "address", "address"], [cfg.pm, launcherAddr, A.safe, A.treasury, displayFactory ? displayFactory.target : ethers.ZeroAddress])]);
  const initHash = ethers.keccak256(initCode);
  const t0 = Date.now();
  let salt, hookAddr, tries = 0;
  for (let i = 0n; ; i++) {
    tries++;
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(CREATE2_PROXY, s, initHash);
    if ((BigInt(a) & 0x3fffn) === HOOK_FLAGS) {
      salt = s;
      hookAddr = a;
      break;
    }
  }
  check("hook salt mined for flags 0x28EC", (BigInt(hookAddr) & 0x3fffn) === HOOK_FLAGS, `${hookAddr} after ${tries} tries, ${Date.now() - t0} ms`);
  const txH = await deployer.sendTransaction({ to: CREATE2_PROXY, data: ethers.concat([salt, initCode]), gasLimit: 6_000_000n });
  const rcH = await txH.wait();
  check("hook deployed at mined address", (await provider.getCode(hookAddr)).length > 2, `gas ${rcH.gasUsed}`);
  const hook = new ethers.Contract(hookAddr, H.abi, provider);
  const L = C.MwzV4Launcher;
  const launcherC = await new ethers.ContractFactory(L.abi, L.bytecode, deployer).deploy(cfg.pm, hookAddr, cfg.oracle);
  await launcherC.waitForDeployment();
  check("launcher at predicted address (hook immutable points at it)", (await launcherC.getAddress()) === launcherAddr && (await hook.launcher()) === launcherAddr, launcherAddr);
  const launcher = launcherC.connect(provider);
  if (displayFactory) {
    await (await displayFactory.connect(deployer).setHook(hookAddr)).wait();
    check("display factory wired to the hook (one-time)", (await displayFactory.hook()) === hookAddr);
  }
  check("hook runtime size under the 24,576-byte limit", (C.MwzLaunchHook.runtimeSize) <= 24576, `${C.MwzLaunchHook.runtimeSize} bytes`);
  const deploy = async (n, ...a) => {
    const c = await new ethers.ContractFactory(C[n].abi, C[n].bytecode, deployer).deploy(...a);
    await c.waitForDeployment();
    return new ethers.Contract(await c.getAddress(), C[n].abi, provider);
  };
  const trader = await deploy("V4DirectTrader", cfg.pm);
  const seeder = await deploy("V4PlainSeeder", cfg.pm);
  const attackerC = await deploy("V4Attacker", cfg.pm);
  const rejecter = await deploy("RejectingCreator");

  const ifaces = [hook.interface, launcher.interface, new ethers.Interface(PM_ABI), new ethers.Interface(UR_ABI), new ethers.Interface(["error InvalidHookResponse()", "error HookCallFailed()", "error PartialFill()", "error HookDeltaExceedsSwapAmount()", "error V4TooMuchRequested(uint256,uint256)", "error DeltaNotNegative(address)", "error DeltaNotPositive(address)"])];

  // ---- UR encoding style per router (v2.0 params vs 2.1.x params with minHopPriceX36)
  const urStyles = {};
  return { name, cfg, provider, child, A, W, pm, sv, quoter, oracle, nativeUsd, hook, launcher, trader, seeder, attackerC, rejecter, displayFactory, ifaces, urStyles, forkBlock, C };
}

// ------------------------------------------------------------------ per-pool helpers
function makePool(env, token, tickStart, tickGrad) {
  const key = [ethers.ZeroAddress, token, 0x800000, SPACING, env.hook.target];
  const id = ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], key));
  return { key, id, token, tickStart, tickGrad, coin: new ethers.Contract(token, ERC20_ABI, env.provider) };
}

async function slot0(env, P) {
  const s = await env.sv.getSlot0(P.id);
  return { sqrtP: s[0], tick: Number(s[1]), protocolFee: Number(s[2]), lpFee: Number(s[3]) };
}

async function gasCost(rc) {
  return rc.gasUsed * (rc.gasPrice ?? rc.effectiveGasPrice ?? 0n);
}

/** Executes a trade and returns raw pool amounts (Swap event), the hook fee event, the user's deltas. */
async function trade(env, P, { via, wallet, buy, exactIn, amount, limit, hookData = "0x", urName, sqrtLimit = 0n, ts }) {
  const user = await wallet.getAddress();
  const zeroForOne = buy;
  const coin = P.coin.connect(wallet);
  // approvals first (separate txs), so balances below measure the trade alone
  if (!buy && via === "direct" && (await P.coin.allowance(user, env.trader.target)) < amount * 2n) await (await coin.approve(env.trader.target, ethers.MaxUint256)).wait();
  if (!buy && via === "ur") {
    const urAddr = env.cfg.urs[urName];
    if ((await P.coin.allowance(user, PERMIT2)) < amount * 2n) await (await coin.approve(PERMIT2, ethers.MaxUint256)).wait();
    await (await new ethers.Contract(PERMIT2, PERMIT2_ABI, wallet).approve(P.token, urAddr, MAX_U160, 2n ** 47n)).wait();
  }
  if (ts !== undefined) {
    const latest = BigInt((await env.provider.getBlock("latest")).timestamp);
    await setNextTs(env, ts > latest ? ts : latest + 1n);
  }
  const nBefore = await env.provider.getBalance(user);
  const cBefore = await P.coin.balanceOf(user);
  let tx;
  if (via === "direct") {
    const amountSpecified = exactIn ? -amount : amount;
    let value = 0n;
    if (buy) value = exactIn ? amount : limit;
    tx = await env.trader.connect(wallet).swap(P.key, zeroForOne, amountSpecified, sqrtLimit, hookData, { value, gasLimit: 3_000_000n });
  } else {
    const urAddr = env.cfg.urs[urName];
    const style = env.urStyles[urName];
    const { commands, inputs } = urCalldata(style, P.key, { zeroForOne, exactIn, amount, limit, hookData });
    const value = buy ? (exactIn ? amount : limit) : 0n;
    const urC = new ethers.Contract(urAddr, UR_ABI, wallet);
    const why = await revertOf(() => urC.execute.staticCall(commands, inputs, 2n ** 40n, { value }), env.ifaces);
    if (why) throw Object.assign(new Error(`UR trade reverts: ${why}`), { tradeRevert: why });
    tx = await urC.execute(commands, inputs, 2n ** 40n, { value, gasLimit: 3_000_000n });
  }
  const rc = await tx.wait();
  const cost = await gasCost(rc);
  const nAfter = await env.provider.getBalance(user);
  const cAfter = await P.coin.balanceOf(user);
  let raw0 = 0n, raw1 = 0n, fee = null, gross = null, rate = null, creatorShare = null, referrer = null, graduated = null;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() === env.cfg.pm.toLowerCase()) {
      try {
        const ev = env.pm.interface.parseLog(log);
        if (ev?.name === "Swap" && ev.args.id === P.id) {
          raw0 = ev.args.amount0;
          raw1 = ev.args.amount1;
        }
      } catch {}
    } else if (log.address.toLowerCase() === env.hook.target.toLowerCase()) {
      const ev = env.hook.interface.parseLog(log);
      if (ev?.name === "HookFee") {
        fee = ev.args.fee;
        gross = ev.args.curveAmount;
        rate = ev.args.feeBps;
        creatorShare = ev.args.creatorShare;
        referrer = ev.args.referrer;
      }
      if (ev?.name === "Graduated") graduated = { gradFee: ev.args.gradFeeNative, nativeInA: ev.args.nativeInA, removed: ev.args.liquidityRemoved };
    }
  }
  if (false && !buy) { console.log("DBG", { user, nBefore, nAfter, cost, raw0, fee, logs: rc.logs.length, gas: rc.gasUsed }); const tr = await env.provider.send("debug_traceTransaction", [rc.hash, { tracer: "callTracer" }]); const walk = (c, d) => { console.log(" ".repeat(d * 2) + c.type, c.to, c.input.slice(0, 10), "value", c.value ?? "0x0", c.error ?? ""); for (const s of c.calls ?? []) walk(s, d + 1); }; walk(tr, 0); process.exit(3); }
  return { rc, gas: rc.gasUsed, raw0, raw1, fee, gross, rate, creatorShare, referrer, graduated, userNative: nAfter - nBefore + cost, userCoin: cAfter - cBefore, block: rc.blockNumber };
}

/** Exactness of the hook fee, gen-7 definition: buys pay floor(cost * r) ON TOP of the curve cost,
 *  sells pay floor(payout * r) out of the curve payout. Returns [ok, detail, dustWei]. */
function feeExact(t, buy, exactIn, amount) {
  const r = t.rate;
  const pct = (f, base) => (Number((f * 10n ** 10n) / base) / 1e8).toFixed(6);
  if (buy && exactIn) {
    // the trader sends G; the curve takes cost = floor(G * B / (B + r)); fee = G - cost
    const cost = -t.raw0;
    const g7 = (cost * r) / BPS;
    const dust = t.fee - g7;
    const ok = cost === (amount * BPS) / (BPS + r) && t.fee === amount - cost && dust >= 0n && dust <= 2n && t.gross === cost && -t.userNative === amount && t.userCoin === t.raw1;
    return [ok, `sent ${fmt(amount)} curve ${fmt(cost)} fee ${fmt(t.fee, 9)} = ${pct(t.fee, cost)}% of cost (gen-7 floor ${fmt(g7, 9)}, +${dust} wei)`, dust];
  }
  if (buy && !exactIn) {
    const cost = -t.raw0;
    const ok = t.fee === (cost * r) / BPS && t.gross === cost && -t.userNative === cost + t.fee && t.userCoin === amount && t.raw1 === amount;
    return [ok, `curve ${fmt(cost)} fee ${fmt(t.fee, 9)} = ${pct(t.fee, cost)}% on top (exact gen-7)`, 0n];
  }
  if (!buy && exactIn) {
    const out = t.raw0;
    const ok = t.fee === (out * r) / BPS && t.gross === out && t.userNative === out - t.fee && -t.userCoin === amount;
    return [ok, `curve payout ${fmt(out)} fee ${fmt(t.fee, 9)} = ${pct(t.fee, out)}% (exact gen-7)`, 0n];
  }
  const gross = t.raw0;
  const ok = t.fee === (gross * r) / BPS && gross - t.fee === amount && t.gross === gross && t.userNative === amount;
  return [ok, `net ${fmt(amount)} curve payout ${fmt(gross)} fee ${fmt(t.fee, 9)} = floor(payout*r) exactly`, 0n];
}

async function quote(env, P, buy, exactIn, amount, hookData = "0x") {
  const p = [P.key, buy, amount, hookData];
  const fn = exactIn ? env.quoter.quoteExactInputSingle : env.quoter.quoteExactOutputSingle;
  const [q, gasEst] = await fn.staticCall(p);
  return { q, gasEst };
}

/** what the quote must equal in the executed trade */
function quotedSide(t, buy, exactIn) {
  if (buy && exactIn) return t.userCoin;
  if (buy && !exactIn) return -t.userNative;
  if (!buy && exactIn) return t.userNative;
  return -t.userCoin;
}

async function setNextTs(env, ts) {
  await env.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
}
async function snapshot(env) {
  return env.provider.send("evm_snapshot", []);
}
/** reverts to `id` and returns a fresh snapshot of the same state (anvil consumes snapshots on revert) */
async function revert(env, id) {
  const ok = await env.provider.send("evm_revert", [id]);
  if (!ok) throw new Error("evm_revert failed for " + id);
  for (const w of Object.values(env.W)) w.reset();
  return env.provider.send("evm_snapshot", []);
}
async function owedAll(env, P) {
  return {
    router: await env.hook.routerOwed(),
    creator: P ? await env.hook.creatorOwed(P.id) : 0n,
    claims: await env.pm.balanceOf(env.hook.target, 0n),
  };
}

/** coins sold out of A so far, from the price (exact V4 math) */
function soldFromPrice(P, sqrtP) {
  if (sqrtP <= P.sqrtGrad) return P.mintedA;
  return P.mintedA - amount1Delta(P.sqrtGrad, sqrtP, P.liqA, false);
}

const MIN_USABLE = TM.MIN_TICK + (-TM.MIN_TICK % SPACING);
const FullMulDiv = (a, b, c) => (a * b) / c;
// ------------------------------------------------------------------ the per-target proof
const FEES = [200, 100, 50, 9000]; // bondingBps, postBps, creatorPostBps, sniperStartBps
const V2_IFACE = new ethers.Interface([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function update(address,address,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function init(uint256,uint256)",
  "error NotHook()",
]);
const TOPIC = {
  PairCreated: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
  Sync: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
  Mint: "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f",
  Swap: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
};

/** V2 display events in a receipt, in order, decoded with the canonical Uniswap V2 ABI. */
function displayLogs(rc, pair) {
  return rc.logs
    .filter((l) => pair && l.address.toLowerCase() === pair.toLowerCase())
    .map((l) => ({ topic: l.topics[0], idx: l.index, ev: V2_IFACE.parseLog(l) }));
}

/** Checks one trade's display output: Sync then Swap, V2 shapes, trader amounts, reserves == pool price. */
async function checkDisplay(env, P, t, buy, wallet) {
  if (!P.pair) return [true, "no display pair (Robinhood)"];
  const logs = displayLogs(t.rc, P.pair);
  if (logs.length !== 2 || logs[0].topic !== TOPIC.Sync || logs[1].topic !== TOPIC.Swap) return [false, `logs ${logs.map((l) => l.topic.slice(0, 10)).join(",")}`];
  const sync = logs[0].ev.args;
  const sw = logs[1].ev.args;
  const nIs0 = P.nativeIsToken0;
  const rN = nIs0 ? sync[0] : sync[1];
  const rC = nIs0 ? sync[1] : sync[0];
  const nIn = nIs0 ? sw.amount0In : sw.amount1In;
  const cIn = nIs0 ? sw.amount1In : sw.amount0In;
  const nOut = nIs0 ? sw.amount0Out : sw.amount1Out;
  const cOut = nIs0 ? sw.amount1Out : sw.amount0Out;
  const user = await wallet.getAddress();
  const amountsOk = buy ? nIn === -t.userNative && cOut === t.userCoin && cIn === 0n && nOut === 0n : cIn === -t.userCoin && nOut === t.userNative && nIn === 0n && cOut === 0n;
  const s = await slot0(env, P);
  const priceDiff = ppm(rC * (1n << 192n), rN * s.sqrtP * s.sqrtP);
  const gr = await new ethers.Contract(P.pair, V2_IFACE, env.provider).getReserves();
  const ok = amountsOk && sw.to === user && priceDiff < 0.01 && gr[0] === sync[0] && gr[1] === sync[1];
  return [ok, `Sync r(native ${fmt(rN, 4)}, coin ${fmt(rC, 0)}) price vs pool ${priceDiff.toFixed(6)} ppm; Swap in/out match trader; to=${sw.to === user ? "trader" : sw.to}`];
}

async function launchCoin(env, wallet, target, firstBuy, fees, label = "Research V4 Coin") {
  const txL = await env.launcher.connect(wallet).launch(label, "RV4", target, 0n, fees, { value: firstBuy, gasLimit: 15_000_000n });
  const rcL = await txL.wait();
  const ev = rcL.logs.map((l) => { try { return env.launcher.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Launched");
  const P = makePool(env, ev.args.token, Number(ev.args.tickStart), Number(ev.args.tickGrad));
  P.launchTs = BigInt((await env.provider.getBlock(rcL.blockNumber)).timestamp);
  const st = await env.hook.pools(P.id);
  P.liqA = st.liqA;
  P.liqB = st.liqB;
  P.sqrtGrad = st.sqrtGrad;
  P.sqrtStart = TM.getSqrtRatioAtTick(P.tickStart);
  P.mintedA = amount1Delta(P.sqrtGrad, P.sqrtStart, P.liqA, true);
  P.mintedB = amount1Delta(TM.getSqrtRatioAtTick(MIN_USABLE), P.sqrtGrad, P.liqB, true);
  P.pair = (await env.hook.displayPair(P.id)) === ethers.ZeroAddress ? null : await env.hook.displayPair(P.id);
  if (P.pair) P.nativeIsToken0 = BigInt(env.cfg.wNative) < BigInt(P.token);
  return { P, rcL, ev };
}

/** smallest gross with gross - floor(gross*r/B) == net (mirror of the hook's _grossForNet) */
function grossForNet(net, r) {
  let g = ceilDiv(net * BPS, BPS - r);
  while (g > 0n && g - 1n - ((g - 1n) * r) / BPS >= net) g--;
  return g;
}

/** A price-limited swap: preview, trade, and check fill == preview, fee on the filled part only, price == limit. */
async function partialFill(env, P, { label, buy, amount, limit, wallet }) {
  const r = await env.hook.currentFeeBps(P.id, env.trader.target);
  let spec;
  if (buy) spec = -((amount * BPS) / (BPS + r)); // the curve part of an exact-input buy
  else spec = grossForNet(amount, r); // the curve payout for an exact-output sell
  const preview = await env.hook.previewFill(P.id, buy, spec, limit);
  const full = buy ? -spec : spec;
  const t = await trade(env, P, { via: "direct", wallet, buy, exactIn: buy, amount, limit: buy ? 0n : 10n ** 30n, sqrtLimit: limit });
  const s = await slot0(env, P);
  const fill = buy ? -t.raw0 : t.raw0;
  const fee = (fill * r) / BPS;
  const userOk = buy ? -t.userNative === fill + fee : t.userNative === fill - fee;
  const ok = fill === preview && fill < full && t.fee === fee && t.gross === fill && userOk && s.sqrtP === limit;
  check(`partial fill ${label}: fills to the limit, fee only on the filled part (gen-7 exact), preview exact`, ok, `asked ${fmt(full)} curve, filled ${fmt(fill)} (preview ${fmt(preview)}), fee ${fmt(t.fee, 9)} @${r}bps, price == limit: ${s.sqrtP === limit}`);
  return t;
}

async function runTarget(env, targetUsd) {
  CTX = `${env.name} $${targetUsd / 1000n}K`;
  const out = { chain: env.name, targetUsd: Number(targetUsd), nums: {} };
  const N = out.nums;
  const target = targetUsd * WAD;
  const snapStart = await snapshot(env);

  // ---- plan vs gen-7 (JS mirror of the deployed gen-7 factory math)
  const [mc, vN, vT, tickStart, tickGrad] = await env.launcher.plan(target);
  const g = gen7.gen7CurveFromConfig({ totalSupply: SUPPLY, curveBps: 8500n, liquidityTokenBps: 1300n, marketCapNativeWei: mc });
  check("on-chain curve sizing == gen-7 curveForMarketCap (vN, vT)", g.virtualNative === vN && g.virtualToken === vT, `vN ${fmt(vN)} vT ${fmt(vT, 0)}`);
  const R = gen7.graduationRaise(vN, vT, COINS_A);
  const g7StartMc = gen7.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold: 0n, totalSupply: SUPPLY });
  const g7EndMc = gen7.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold: COINS_A, totalSupply: SUPPLY });
  N.marketCapTargetNative = mc.toString();
  N.gen7 = { vN: vN.toString(), vT: vT.toString(), R: R.toString(), startMc: g7StartMc.toString(), endMc: g7EndMc.toString() };
  note(`target MC ${fmt(mc)} native; gen-7 start MC ${fmt(g7StartMc)} end MC ${fmt(g7EndMc)} raise R ${fmt(R)}; ticks start ${tickStart} grad ${tickGrad}`);

  // ---- front-run: nobody can initialize a pool with our hook
  const nextTokenGuess = ethers.getCreateAddress({ from: env.launcher.target, nonce: 999 });
  const fakeKey = [ethers.ZeroAddress, nextTokenGuess, 0x800000, SPACING, env.hook.target];
  const rInit = await revertOf(() => env.attackerC.connect(env.W.attacker).tryInitialize.staticCall(fakeKey, TM.getSqrtRatioAtTick(Number(tickStart))), env.ifaces);
  check("outside PoolManager.initialize with our hook reverts (launch front-run impossible)", rInit && rInit.includes("OnlyThisHookMayInitialize"), rInit);
  const rCreate = await revertOf(() => env.hook.connect(env.W.attacker).createPool.staticCall(nextTokenGuess, env.A.attacker, tickStart, tickGrad, 1n, 1n, FEES), env.ifaces);
  check("hook.createPool from a non-launcher reverts", rCreate && rCreate.includes("NotLauncher"), rCreate);

  // ---- per-coin rate caps (decision 4)
  for (const [lbl, f] of [
    ["bonding 2.01%", [201, 100, 50, 9000]],
    ["post-grad 1.01%", [200, 101, 50, 9000]],
    ["decay start 90.01%", [200, 100, 50, 9001]],
    ["creator share above post-grad fee", [200, 100, 101, 9000]],
    ["decay start below bonding", [200, 100, 50, 199]],
  ]) {
    const r = await revertOf(() => env.launcher.connect(env.W.creator).launch.staticCall("X", "X", target, 0n, f, { value: 0n }), env.ifaces);
    check(`fee cap enforced at launch: ${lbl} reverts`, r && r.includes("FeeCapExceeded"), r);
  }

  // ---- atomic launch with the creator's first buy (5% of R), gen-7 fee on top
  const firstBuy = R / 20n;
  const o0 = await owedAll(env);
  const { P, rcL, ev } = await launchCoin(env, env.W.creator, target, firstBuy, FEES);
  N.launchGas = rcL.gasUsed.toString();
  check("atomic launch: token + init + A/B mint + first buy (+ display pair on BNB) in one tx", ev.args.firstBuyOut > 0n, `gas ${rcL.gasUsed} (block gas limit ${env.forkBlock.gasLimit})`);
  check("launch gas fits a 32M per-tx cap and the block", rcL.gasUsed < 32_000_000n && rcL.gasUsed < env.forkBlock.gasLimit, `${rcL.gasUsed}`);
  const initLog = rcL.logs.map((l) => { try { return env.pm.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Initialize");
  check("pool initialized in the launch tx: native/coin, dynamic fee, our hook", initLog && initLog.args.id === P.id && initLog.args.currency0 === ethers.ZeroAddress && Number(initLog.args.fee) === 0x800000 && initLog.args.hooks === env.hook.target, `poolId ${P.id}`);
  const s0 = await slot0(env, P);
  check("LP fee is 0 (dynamic pool, never set)", s0.lpFee === 0, `lpFee ${s0.lpFee} protocolFee ${s0.protocolFee}`);
  const o1 = await owedAll(env);
  const fbCost = (firstBuy * BPS) / (BPS + 200n);
  const fbFee = firstBuy - fbCost;
  check("creator first buy: gen-7 fee 2% on top of the curve cost (not the 90% launch rate)", o1.router - o0.router === fbFee && fbFee - (fbCost * 200n) / BPS <= 2n, `sent ${fmt(firstBuy)} = cost ${fmt(fbCost)} + fee ${fmt(fbFee, 9)} (${(Number((fbFee * 10n ** 10n) / fbCost) / 1e8).toFixed(6)}% of cost, ${(Number((fbFee * 10n ** 10n) / firstBuy) / 1e8).toFixed(6)}% of sent)`);
  const creatorCoins = await P.coin.balanceOf(env.A.creator);
  check("creator holds 20M reserve + first-buy coins; hook holds 0 coins", creatorCoins === 20_000_000n * WAD + ev.args.firstBuyOut && (await P.coin.balanceOf(env.hook.target)) === 0n, `creator ${fmt(creatorCoins, 0)}`);
  const posA = await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash);
  const posB = await env.sv.getPositionInfo(P.id, env.hook.target, MIN_USABLE, P.tickGrad, ethers.ZeroHash);
  check("positions A (850M) and B (130M) owned by the hook-locker", posA[0] === P.liqA && posB[0] === P.liqB && absDiff(P.mintedA, COINS_A) < 10n ** 6n && absDiff(P.mintedB, COINS_B) < 10n ** 6n, `liqA ${P.liqA} liqB ${P.liqB}`);
  const stored = (await env.hook.pools(P.id)).fees;
  check("per-coin rates stored at launch", stored.map(Number).join(",") === FEES.join(","), stored.map(Number).join(","));

  // ---- display pair at launch (BNB) / none (Robinhood)
  if (env.cfg.wNative) {
    const pcLog = rcL.logs.find((l) => l.address.toLowerCase() === env.displayFactory.target.toLowerCase() && l.topics[0] === TOPIC.PairCreated);
    const pc = pcLog && V2_IFACE.parseLog(pcLog);
    const [t0, t1] = BigInt(P.token) < BigInt(env.cfg.wNative) ? [P.token, env.cfg.wNative] : [env.cfg.wNative, P.token];
    check("BNB display: factory emits Uniswap V2 PairCreated(token0, token1, pair, length), tokens sorted", pc && pc.args.token0 === t0 && pc.args.token1 === t1 && pc.args.pair === P.pair && pc.args[3] === (await env.displayFactory.allPairsLength()), `pair ${P.pair} token0 ${t0.slice(0, 8)} token1 ${t1.slice(0, 8)}`);
    const dl = displayLogs(rcL, P.pair);
    const sync = dl[0]?.ev.args;
    const mint = dl[1]?.ev.args;
    const [rN0, rC0] = [FullMulDiv(P.liqA, Q96, P.sqrtStart), FullMulDiv(P.liqA, P.sqrtStart, Q96)];
    const syncOk = sync && (P.nativeIsToken0 ? sync[0] === rN0 && sync[1] === rC0 : sync[1] === rN0 && sync[0] === rC0);
    check("BNB display at launch: Sync then Mint (V2 order), sender = hook, initial virtual reserves; then the first buy's Sync + Swap", dl.length === 4 && dl[0].topic === TOPIC.Sync && dl[1].topic === TOPIC.Mint && dl[2].topic === TOPIC.Sync && dl[3].topic === TOPIC.Swap && syncOk && mint.sender === env.hook.target && mint.amount0 === sync[0] && mint.amount1 === sync[1], `native ${fmt(rN0)} coin ${fmt(rC0, 0)}; logs ${dl.map((l) => l.ev.name).join(",")}`);
    check("BNB display reserves at launch == gen-7 virtual reserves (vN, vT) within tick rounding", ppm(rN0, vN) < 600 && ppm(rC0, vT) < 600, `native ${ppm(rN0, vN).toFixed(1)} ppm, coin ${ppm(rC0, vT).toFixed(1)} ppm`);
    const pair = new ethers.Contract(P.pair, V2_IFACE, env.provider);
    const [nm, sy, dc, ts, tk0, tk1, gr] = await Promise.all([pair.name(), pair.symbol(), pair.decimals(), pair.totalSupply(), pair.token0(), pair.token1(), pair.getReserves()]);
    check("BNB display views mirror flap's pairs: name/symbol/decimals/token0/token1/getReserves/totalSupply=sqrt(r0*r1)", nm === "Uniswap V2" && sy === "UNI-V2" && Number(dc) === 18 && tk0 === t0 && tk1 === t1 && ts === TM.isqrt(gr[0] * gr[1]), `${nm} ${sy} ${dc} totalSupply ${fmt(ts, 2)}`);
    const rW = await revertOf(() => pair.connect(env.W.attacker).update.staticCall(env.A.attacker, env.A.attacker, 1n, 0n, 0n, 1n, 1n, 1n), [V2_IFACE, ...env.ifaces]);
    const rI = await revertOf(() => pair.connect(env.W.attacker).init.staticCall(1n, 1n), [V2_IFACE, ...env.ifaces]);
    const rF = await revertOf(() => env.displayFactory.connect(env.W.attacker).createPair.staticCall(env.A.attacker), [env.displayFactory.interface]);
    const rH = await revertOf(() => env.displayFactory.connect(env.W.deployer).setHook.staticCall(env.A.attacker), [env.displayFactory.interface]);
    check("nobody but the hook can write to the display pair or factory", rW?.includes("NotHook") && rI?.includes("NotHook") && rF?.includes("NotHook") && rH?.includes("HookAlreadySet"), `${rW} / ${rI} / ${rF} / ${rH}`);
  } else {
    const anyV2 = rcL.logs.some((l) => [TOPIC.PairCreated, TOPIC.Sync, TOPIC.Mint].includes(l.topics[0]));
    check("Robinhood: no display pair, no V2 events", P.pair === null && !anyV2);
  }

  // ---- market cap path: start
  const v4StartMc = mcFromSqrt(P.sqrtStart, SUPPLY);
  N.mcStart = { v4: v4StartMc.toString(), gen7: g7StartMc.toString(), ppm: ppm(v4StartMc, g7StartMc) };
  check("start MC == gen-7 start MC within tick rounding", ppm(v4StartMc, g7StartMc) <= 501, `v4 ${fmt(v4StartMc)} gen-7 ${fmt(g7StartMc)} diff ${ppm(v4StartMc, g7StartMc).toFixed(1)} ppm`);

  let snapLaunched = await snapshot(env);

  // ---- anti-sniper: start -> bonding over 60 s, buys and sells, gen-7 formula
  const sniper = [];
  for (const dt of [1n, 2n, 10n, 30n, 45n, 59n, 60n, 61n]) {
    for (const buy of [true, false]) {
      const snap = await snapshot(env);
      let t;
      if (buy) t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R / 100n, limit: 0n, ts: P.launchTs + dt });
      else t = await trade(env, P, { via: "direct", wallet: env.W.creator, buy: false, exactIn: true, amount: 1_000_000n * WAD, limit: 0n, ts: P.launchTs + dt });
      const realDt = BigInt((await env.provider.getBlock(t.block)).timestamp) - P.launchTs;
      const left = realDt >= 60n ? 0n : 60n - realDt;
      const expected = 200n + ((9000n - 200n) * left) / 60n;
      const [ok, d] = feeExact(t, buy, true, buy ? R / 100n : 1_000_000n * WAD);
      sniper.push({ dt: Number(realDt), side: buy ? "buy" : "sell", rateBps: Number(t.rate), expectedBps: Number(expected) });
      check(`anti-sniper t+${realDt}s ${buy ? "buy" : "sell"} rate ${expected} bps, gen-7 exact`, t.rate === expected && ok, d);
      await revert(env, snap);
    }
  }
  N.sniper = sniper;

  // ---- after the window: full matrix via UR(s) and direct callback, with V4Quoter equality + display
  snapLaunched = await revert(env, snapLaunched);
  let snapL2 = await snapshot(env);
  {
    const latest = BigInt((await env.provider.getBlock("latest")).timestamp);
    await setNextTs(env, P.launchTs + 61n > latest ? P.launchTs + 61n : latest + 1n);
    await env.provider.send("evm_mine", []);
  }
  await detectUrStyles(env, P);
  const hookDataRef = coder.encode(["address"], [REF]);
  N.trades = [];
  N.exactInBuyDustWei = [];
  const vias = [["direct", null], ...Object.keys(env.cfg.urs).map((n) => ["ur", n])];
  for (const [via, urName] of vias) {
    if (via === "ur" && !env.urStyles[urName]) {
      check(`${urName}: V4_SWAP encoding works`, false, "no encoding style succeeded");
      continue;
    }
    for (const [buy, exactIn] of [[true, true], [true, false], [false, true], [false, false]]) {
      const wallet = env.W.buyer;
      let amount, limit;
      if (buy && exactIn) [amount, limit] = [R / 50n + 12345n, 0n];
      else if (buy && !exactIn) [amount, limit] = [5_000_000n * WAD, R];
      else if (!buy && exactIn) [amount, limit] = [2_000_000n * WAD, 0n];
      else [amount, limit] = [R / 200n + 777n, 100_000_000n * WAD];
      const lbl = `${via === "ur" ? urName : "direct unlock callback"} ${buy ? "BUY" : "SELL"} exact${exactIn ? "In" : "Out"}`;
      const qd = via === "ur" ? hookDataRef : "0x";
      const { q, gasEst } = await quote(env, P, buy, exactIn, amount, qd);
      let t;
      try {
        t = await trade(env, P, { via, urName, wallet, buy, exactIn, amount, limit, hookData: qd });
      } catch (e) {
        if (!e.tradeRevert) throw e;
        check(`${lbl}: trade executes`, false, e.tradeRevert);
        continue;
      }
      const [ok, d, dust] = feeExact(t, buy, exactIn, amount);
      if (buy && exactIn) N.exactInBuyDustWei.push(Number(dust));
      check(`${lbl}: fee in native, gen-7 definition, 2%`, ok && t.rate === 200n, d);
      check(`${lbl}: V4Quoter == executed`, q === quotedSide(t, buy, exactIn), `quote ${q} actual ${quotedSide(t, buy, exactIn)}`);
      if (via === "ur") check(`${lbl}: referrer from hookData emitted`, t.referrer === REF, t.referrer);
      if (P.pair) {
        const [dok, dd] = await checkDisplay(env, P, t, buy, wallet);
        check(`${lbl}: BNB display emits V2 Sync + Swap in the same tx, reserves == pool price`, dok, dd);
      }
      N.trades.push({ via: via === "ur" ? urName : "direct", side: buy ? "buy" : "sell", exactIn, gas: Number(t.gas), quoterGasEstimate: Number(gasEst) });
    }
  }
  // exact-in buy rounding dust over many sizes (gen-7 fee + at most 2 wei)
  {
    let maxDust = 0n;
    for (let i = 1n; i <= 40n; i++) {
      const G = (R * i) / 997n + i * 7919n;
      const r = 200n;
      const cost = (G * BPS) / (BPS + r);
      const d = G - cost - (cost * r) / BPS;
      if (d > maxDust) maxDust = d;
    }
    check("exact-in buy: fee - gen-7 floor(cost*2%) is 0..2 wei over 40 sizes (formula)", maxDust <= 2n, `max ${maxDust} wei`);
  }

  // ---- partial fills inside A (decision 3)
  {
    const snap = await snapshot(env);
    const s = await slot0(env, P);
    await partialFill(env, P, { label: "exact-in BUY, limit inside A", buy: true, amount: R, limit: s.sqrtP - s.sqrtP / 100n, wallet: env.W.bot });
    const s2 = await slot0(env, P);
    await partialFill(env, P, { label: "exact-out SELL, limit inside A", buy: false, amount: R, limit: s2.sqrtP + s2.sqrtP / 200n, wallet: env.W.bot });
    const rq = await revertOf(() => env.quoter.quoteExactInputSingle.staticCall([P.key, true, R, "0x"]), env.ifaces);
    note(`V4Quoter QuoteExactSingleParams has no price limit (poolKey, zeroForOne, exactAmount, hookData), so price-limited partial fills are quoted with hook.previewFill${rq ? " (" + rq + ")" : ""}`);
    await revert(env, snap);
  }
  // crossing partial: from inside A to a limit inside B in one swap (graduates on the way)
  {
    const snap = await snapshot(env);
    const limitB = P.sqrtGrad - P.sqrtGrad / 100n;
    const t = await partialFill(env, P, { label: "exact-in BUY from A across the A/B boundary to a limit inside B", buy: true, amount: R * 3n, limit: limitB, wallet: env.W.bot });
    check("crossing partial fill graduates in the same swap", t.graduated !== null);
    await revert(env, snap);
  }

  // ---- liquidity lock (outside add via own callback + canonical PositionManager, remove, donate)
  {
    const r1 = await revertOf(() => env.attackerC.connect(env.W.attacker).tryAdd.staticCall(P.key, P.tickGrad, P.tickStart, 10n ** 18n), env.ifaces);
    check("outside addLiquidity via own unlock callback reverts", r1 && r1.includes("LiquidityIsLocked"), r1);
    const posm = new ethers.Contract(env.cfg.posm, POSM_ABI, env.W.attacker);
    await (await P.coin.connect(env.W.creator).transfer(env.A.attacker, 1_000_000n * WAD)).wait();
    await (await P.coin.connect(env.W.attacker).approve(PERMIT2, ethers.MaxUint256)).wait();
    await (await new ethers.Contract(PERMIT2, PERMIT2_ABI, env.W.attacker).approve(P.token, env.cfg.posm, MAX_U160, 2n ** 47n)).wait();
    const actions = ethers.solidityPacked(["uint8", "uint8"], [ACT.MINT_POSITION, ACT.SETTLE_PAIR]);
    const params = [
      coder.encode([KEY_T, "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], [P.key, P.tickGrad, P.tickStart, 10n ** 18n, 0n, 10n ** 30n, env.A.attacker, "0x"]),
      coder.encode(["address", "address"], [ethers.ZeroAddress, P.token]),
    ];
    const r2 = await revertOf(() => posm.modifyLiquidities.staticCall(coder.encode(["bytes", "bytes[]"], [actions, params]), 2n ** 40n), env.ifaces);
    check("outside addLiquidity via canonical PositionManager reverts", r2 && r2.includes("LiquidityIsLocked"), r2);
    const r3 = await revertOf(() => env.attackerC.connect(env.W.attacker).tryRemove.staticCall(P.key, P.tickGrad, P.tickStart, 1n), env.ifaces);
    check("nobody can remove A or B (positions keyed by owner = hook)", !!r3, r3);
    const r4 = await revertOf(() => env.attackerC.connect(env.W.attacker).tryDonate.staticCall(P.key, { value: WAD }), env.ifaces);
    check("donate reverts", r4 && r4.includes("DonateDisabled"), r4);
    const amt = 1_234_567n * WAD;
    const before = await P.coin.balanceOf(env.A.payee);
    await (await P.coin.connect(env.W.creator).transfer(env.A.payee, amt)).wait();
    check("wallet-to-wallet transfer is untaxed", (await P.coin.balanceOf(env.A.payee)) - before === amt);
    const urName = Object.keys(env.cfg.urs).find((n) => env.urStyles[n]);
    const bal = await P.coin.balanceOf(env.A.buyer);
    const t = await trade(env, P, { via: "ur", urName, wallet: env.W.buyer, buy: false, exactIn: true, amount: bal, limit: 0n });
    check("selling 100% of a wallet balance via UR works", (await P.coin.balanceOf(env.A.buyer)) === 0n && t.userNative > 0n, `sold ${fmt(bal, 0)}`);
  }

  // ---- BNB display: failures never block a trade; gas added per swap
  if (P.pair) {
    const realCode = await env.provider.getCode(P.pair);
    const once = async (code) => {
      const snap = await snapshot(env);
      if (code) await env.provider.send("anvil_setCode", [P.pair, code]);
      const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R / 100n, limit: 0n });
      const failed = t.rc.logs.some((l) => { try { return env.hook.interface.parseLog(l)?.name === "DisplayUpdateFailed"; } catch { return false; } });
      await revert(env, snap);
      return { t, failed };
    };
    const normal = await once(null);
    const reverting = await once("0x60006000fd");
    const burner = await once("0x5b600056");
    const stop = await once("0x00");
    check("display that REVERTS: the trade still succeeds (DisplayUpdateFailed logged)", reverting.t.rc.status === 1 && reverting.failed && reverting.t.fee === normal.t.fee, `gas ${reverting.t.gas}`);
    check("display that burns ALL its gas (OOG): the trade still succeeds, capped at 60k", burner.t.rc.status === 1 && burner.failed && burner.t.gas - stop.t.gas < 62_000n, `gas ${burner.t.gas} (+${burner.t.gas - stop.t.gas} over an empty display)`);
    N.displayGasPerSwap = Number(normal.t.gas - stop.t.gas);
    check("display gas per swap measured", normal.t.gas > stop.t.gas, `display adds ${normal.t.gas - stop.t.gas} gas per swap (incl. reserve read + call); trade ${normal.t.gas} vs ${stop.t.gas} with an empty display`);
    check("display code restored after the failure tests", (await env.provider.getCode(P.pair)) === realCode);
  }

  // ---- gas baseline: hookless pool with the same shape, same trades
  N.gas = await gasCompare(env, P, tickStart, tickGrad, R);

  // ---- walk the curve: MC path vs gen-7, display reserves vs gen-7 virtual reserves, graduation
  snapL2 = await revert(env, snapL2);
  {
    const latest = BigInt((await env.provider.getBlock("latest")).timestamp);
    await setNextTs(env, P.launchTs + 61n > latest ? P.launchTs + 61n : latest + 1n);
    await env.provider.send("evm_mine", []);
  }
  N.mcPath = [];
  for (const f of [10n, 25n, 50n, 75n, 90n, 99n]) {
    const s = await slot0(env, P);
    const soldNow = soldFromPrice(P, s.sqrtP);
    const want = (COINS_A * f) / 100n;
    if (want > soldNow) await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: want - soldNow, limit: R * 2n });
    const s2 = await slot0(env, P);
    const sold = soldFromPrice(P, s2.sqrtP);
    const v4Mc = mcFromSqrt(s2.sqrtP, SUPPLY);
    const g7Mc = gen7.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold, totalSupply: SUPPLY });
    N.mcPath.push({ pctOfA: Number(f), sold: sold.toString(), v4Mc: v4Mc.toString(), gen7Mc: g7Mc.toString(), ppm: ppm(v4Mc, g7Mc) });
    check(`MC at ${f}% of A == gen-7 MC at the same sold amount (tick rounding)`, ppm(v4Mc, g7Mc) <= 1000, `v4 ${fmt(v4Mc)} gen-7 ${fmt(g7Mc)} diff ${ppm(v4Mc, g7Mc).toFixed(1)} ppm`);
    if (P.pair && f === 50n) {
      const gr = await new ethers.Contract(P.pair, V2_IFACE, env.provider).getReserves();
      const rN = P.nativeIsToken0 ? gr[0] : gr[1];
      const rC = P.nativeIsToken0 ? gr[1] : gr[0];
      const g7N = gen7.curveNative(vN, vT, sold);
      const g7T = vT - sold;
      check("BNB display reserves at 50% of A == gen-7 virtual reserves (Y(s), vT - s) within tick rounding", ppm(rN, g7N) < 1000 && ppm(rC, g7T) < 1000, `native ${fmt(rN)} vs ${fmt(g7N)} (${ppm(rN, g7N).toFixed(1)} ppm); coin ${fmt(rC, 0)} vs ${fmt(g7T, 0)} (${ppm(rC, g7T).toFixed(1)} ppm)`);
    }
  }
  {
    const s = await slot0(env, P);
    const soldNow = soldFromPrice(P, s.sqrtP);
    const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: P.mintedA - soldNow - WAD, limit: R * 2n });
    check("no graduation with 1 coin of A left (latch only at the threshold)", !(await env.hook.pools(P.id)).graduated && t.graduated === null);
  }
  let snapPreGrad = await snapshot(env);
  // variant: cross exactly AT the A/B boundary with a price-limited exact-in buy
  {
    const o2 = await owedAll(env, P);
    const t = await partialFill(env, P, { label: "exact-in BUY with the limit exactly at the A/B boundary", buy: true, amount: R, limit: P.sqrtGrad, wallet: env.W.bot });
    const o3 = await owedAll(env, P);
    check("buy to exactly the A/B boundary graduates (price == top of A)", t.graduated !== null && (await slot0(env, P)).sqrtP === P.sqrtGrad);
    const removed = (P.liqA * 200n) / BPS;
    const expectedGradFee = amount0Delta(P.sqrtGrad, P.sqrtStart, removed, false);
    const nativeInA = amount0Delta(P.sqrtGrad, P.sqrtStart, P.liqA, false);
    if (t.graduated) {
      const gf = t.graduated.gradFee;
      check("graduation fee == native of exactly 2% of A's liquidity (exact V4 math) == floor(2% of A's raise) within 2 wei", gf === expectedGradFee && absDiff(gf, (nativeInA * 200n) / BPS) <= 2n, `${fmt(gf, 9)} vs 2% of ${fmt(nativeInA)} = ${fmt((nativeInA * 200n) / BPS, 9)}`);
      check("graduation fee + crossing swap fee credited to the router bucket", o3.router - o2.router === gf + t.fee);
      N.graduation = { nativeInA: nativeInA.toString(), gen7R: R.toString(), raiseVsRppm: ppm(nativeInA, R), gradFee: gf.toString(), twoPctOfRaise: ((nativeInA * 200n) / BPS).toString(), crossingSwapGas: Number(t.gas) };
    }
    check("native raise in A vs gen-7 R (tick rounding)", ppm(nativeInA, R) <= 1000, `A raise ${fmt(nativeInA)} gen-7 R ${fmt(R)} diff ${ppm(nativeInA, R).toFixed(1)} ppm`);
    const posA2 = await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash);
    check("A keeps exactly 98% of its liquidity; B untouched", posA2[0] === P.liqA - removed);
    const v4TopMc = mcFromSqrt(P.sqrtGrad, SUPPLY);
    N.mcTop = { v4: v4TopMc.toString(), gen7: g7EndMc.toString(), ppmVsGen7: ppm(v4TopMc, g7EndMc) };
    check("top-of-A MC == gen-7 graduation MC within tick rounding", ppm(v4TopMc, g7EndMc) <= 501, `v4 ${fmt(v4TopMc)} gen-7 ${fmt(g7EndMc)} diff ${ppm(v4TopMc, g7EndMc).toFixed(1)} ppm`);
  }
  // ---- post-graduation: 1%, creator exactly 0.5% of volume, partial fills inside B and at the boundary
  const urName = Object.keys(env.cfg.urs).find((n) => env.urStyles[n]);
  N.postGradTrades = [];
  for (const [via, buy, exactIn, amount, limit] of [
    ["direct", true, true, R / 20n + 3n, 0n],
    ["ur", true, false, 3_000_000n * WAD, R],
    ["ur", false, true, 5_000_000n * WAD, 0n],
    ["direct", false, false, R / 100n + 5n, 50_000_000n * WAD],
  ]) {
    const ob = await owedAll(env, P);
    const { q } = await quote(env, P, buy, exactIn, amount);
    const t = await trade(env, P, { via, urName, wallet: env.W.bot, buy, exactIn, amount, limit });
    const oa = await owedAll(env, P);
    const [ok, d] = feeExact(t, buy, exactIn, amount);
    const lbl = `post-grad ${via} ${buy ? "BUY" : "SELL"} exact${exactIn ? "In" : "Out"}`;
    check(`${lbl}: fee 1%, gen-7 definition`, ok && t.rate === 100n, d);
    const cExp = (t.gross * 50n) / BPS;
    check(`${lbl}: creator gets exactly 0.5% of native volume, router bucket the rest`, oa.creator - ob.creator === cExp && oa.router - ob.router === t.fee - cExp, `volume ${fmt(t.gross)} creator ${fmt(oa.creator - ob.creator, 9)} router ${fmt(oa.router - ob.router, 9)}`);
    check(`${lbl}: V4Quoter == executed; no second graduation`, q === quotedSide(t, buy, exactIn) && t.graduated === null, `quote ${q}`);
    if (P.pair) {
      const [dok, dd] = await checkDisplay(env, P, t, buy, env.W.bot);
      check(`${lbl}: BNB display Sync + Swap, reserves == pool price (inside B)`, dok, dd);
    }
    N.postGradTrades.push({ via, buy, exactIn, gas: Number(t.gas) });
  }
  {
    const s = await slot0(env, P);
    await partialFill(env, P, { label: "post-grad exact-in BUY, limit inside B", buy: true, amount: R * 2n, limit: s.sqrtP - s.sqrtP / 50n, wallet: env.W.bot });
    const s2 = await slot0(env, P);
    await partialFill(env, P, { label: "post-grad exact-out SELL, limit inside B", buy: false, amount: R * 2n, limit: s2.sqrtP + (P.sqrtGrad - s2.sqrtP) / 3n, wallet: env.W.bot });
    await partialFill(env, P, { label: "post-grad exact-out SELL, limit exactly at the A/B boundary (from B)", buy: false, amount: R * 2n, limit: P.sqrtGrad, wallet: env.W.bot });
    await partialFill(env, P, { label: "post-grad exact-out SELL from the boundary to a limit inside A", buy: false, amount: R * 5n, limit: P.sqrtGrad + P.sqrtGrad / 20n, wallet: env.W.bot });
    check("after falling back into A: still graduated, still 1%", (await env.hook.pools(P.id)).graduated && (await env.hook.currentFeeBps(P.id, env.A.bot)) === 100n);
    const ob = await owedAll(env, P);
    const t2 = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R, limit: 0n });
    const oa = await owedAll(env, P);
    check("re-crossing the threshold does not graduate again or take another 2%", t2.graduated === null && oa.router - ob.router === t2.fee - (t2.gross * 50n) / BPS && t2.rate === 100n);
  }

  // ---- creator rights (decision 2): ledger per coin, claim(to), two-step transfer, owner has no power
  {
    const id = P.id;
    const owed1 = await env.hook.creatorOwed(id);
    const rSafe = await revertOf(() => env.hook.connect(env.W.safe).claimCreator.staticCall(id, env.A.safe), env.ifaces);
    const rSafeP = await revertOf(() => env.hook.connect(env.W.safe).proposeCreator.staticCall(id, env.A.safe), env.ifaces);
    const rAtt = await revertOf(() => env.hook.connect(env.W.attacker).claimCreator.staticCall(id, env.A.attacker), env.ifaces);
    check("owner (Safe) and strangers cannot claim or move creator rights", rSafe?.includes("NotCreator") && rSafeP?.includes("NotCreator") && rAtt?.includes("NotCreator"), `${rSafe} / ${rSafeP} / ${rAtt}`);
    const pb = await env.provider.getBalance(env.A.payee);
    await (await env.hook.connect(env.W.creator).claimCreator(id, env.A.payee)).wait();
    check("creator claims to ANOTHER address: exactly the owed amount arrives there", (await env.provider.getBalance(env.A.payee)) - pb === owed1 && (await env.hook.creatorOwed(id)) === 0n, `${fmt(owed1)} to payee`);
    await (await env.hook.connect(env.W.creator).proposeCreator(id, env.A.creator2)).wait();
    const rEarly = await revertOf(() => env.hook.connect(env.W.creator2).claimCreator.staticCall(id, env.A.creator2), env.ifaces);
    const rWrong = await revertOf(() => env.hook.connect(env.W.attacker).acceptCreator.staticCall(id), env.ifaces);
    check("proposed creator has no rights before accepting; others cannot accept", rEarly?.includes("NotCreator") && rWrong?.includes("NotPendingCreator"), `${rEarly} / ${rWrong}`);
    await (await env.hook.connect(env.W.creator2).acceptCreator(id)).wait();
    await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R / 10n, limit: 0n });
    const owed2 = await env.hook.creatorOwed(id);
    const rOld = await revertOf(() => env.hook.connect(env.W.creator).claimCreator.staticCall(id, env.A.creator), env.ifaces);
    const rOldP = await revertOf(() => env.hook.connect(env.W.creator).proposeCreator.staticCall(id, env.A.creator), env.ifaces);
    check("after the transfer the OLD creator can no longer claim or propose", rOld?.includes("NotCreator") && rOldP?.includes("NotCreator"), `${rOld}`);
    const c2b = await env.provider.getBalance(env.A.payee);
    await (await env.hook.connect(env.W.creator2).claimCreator(id, env.A.payee)).wait();
    check("NEW creator claims what accrued after the transfer", (await env.provider.getBalance(env.A.payee)) - c2b === owed2 && owed2 > 0n, fmt(owed2));
    // a creator that is a contract rejecting native
    await (await env.hook.connect(env.W.creator2).proposeCreator(id, env.rejecter.target)).wait();
    await (await env.rejecter.connect(env.W.deployer).accept(env.hook.target, id)).wait();
    await trade(env, P, { via: "direct", wallet: env.W.bot, buy: false, exactIn: true, amount: 10_000_000n * WAD, limit: 0n });
    const owed3 = await env.hook.creatorOwed(id);
    const rSelf = await revertOf(() => env.rejecter.connect(env.W.deployer).claimTo.staticCall(env.hook.target, id, env.rejecter.target), env.ifaces);
    const eb = await env.provider.getBalance(env.A.payee);
    await (await env.rejecter.connect(env.W.deployer).claimTo(env.hook.target, id, env.A.payee)).wait();
    check("creator CONTRACT that rejects native: claiming to itself fails, claiming to an EOA works", !!rSelf && (await env.provider.getBalance(env.A.payee)) - eb === owed3 && owed3 > 0n, `self: ${rSelf}; to EOA ${fmt(owed3)}`);
    N.creatorClaims = { first: owed1.toString(), afterTransfer: owed2.toString(), contractCreator: owed3.toString() };
  }

  // ---- per-coin rates (coin 2 with its own lower rates) + router timelock (decision 4)
  {
    const fees2 = [100, 50, 25, 5000];
    const { P: P2 } = await launchCoin(env, env.W.creator2, target, 0n, fees2, "Coin Two");
    const snap = await snapshot(env);
    const t1 = await trade(env, P2, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R / 100n, limit: 0n, ts: P2.launchTs + 1n });
    const realDt = BigInt((await env.provider.getBlock(t1.block)).timestamp) - P2.launchTs;
    const exp1 = 100n + ((5000n - 100n) * (60n - realDt)) / 60n;
    const [ok1] = feeExact(t1, true, true, R / 100n);
    check(`coin 2 own rates: anti-sniper starts at 50% and decays to its 1% bonding rate (t+${realDt}s = ${exp1} bps)`, t1.rate === exp1 && ok1);
    const t2 = await trade(env, P2, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: 1_000_000n * WAD, limit: R, ts: P2.launchTs + 61n });
    const [ok2, d2] = feeExact(t2, true, false, 1_000_000n * WAD);
    check("coin 2 after the window: 1% bonding fee, gen-7 exact", t2.rate === 100n && ok2, d2);
    await revert(env, snap);
    const feesP1 = (await env.hook.pools(P.id)).fees.map(Number).join(",");
    const feesP2 = (await env.hook.pools(P2.id)).fees.map(Number).join(",");

    // router: permissionless claim to the current TreasuryRouter
    const rOwed = await env.hook.routerOwed();
    const tb = await env.provider.getBalance(env.A.treasury);
    await (await env.hook.connect(env.W.attacker).claimRouter()).wait();
    check("claimRouter (anyone) pays the router bucket to the current TreasuryRouter", (await env.provider.getBalance(env.A.treasury)) - tb === rOwed && rOwed > 0n, fmt(rOwed));
    // timelock
    const rNo = await revertOf(() => env.hook.connect(env.W.attacker).proposeTreasuryRouter.staticCall(env.A.attacker), env.ifaces);
    check("non-owner cannot propose a new TreasuryRouter", rNo?.includes("NotOwner"), rNo);
    await (await env.hook.connect(env.W.safe).proposeTreasuryRouter(env.A.treasury2)).wait();
    const eta = await env.hook.routerEta();
    const rNow = await revertOf(() => env.hook.connect(env.W.safe).executeTreasuryRouter.staticCall(), env.ifaces);
    await setNextTs(env, eta - 60n);
    await env.provider.send("evm_mine", []);
    const rAlmost = await revertOf(() => env.hook.connect(env.W.safe).executeTreasuryRouter.staticCall(), env.ifaces);
    check("timelock: execute right away and at 48h - 60s both revert", rNow?.includes("TimelockActive") && rAlmost?.includes("TimelockActive"), `${rNow} / ${rAlmost}`);
    await (await env.hook.connect(env.W.safe).cancelTreasuryRouter()).wait();
    await setNextTs(env, eta + 1n);
    await env.provider.send("evm_mine", []);
    const rCancelled = await revertOf(() => env.hook.connect(env.W.safe).executeTreasuryRouter.staticCall(), env.ifaces);
    check("cancel works: a cancelled proposal cannot be executed later", rCancelled?.includes("NoPendingRouter"), rCancelled);
    await (await env.hook.connect(env.W.safe).proposeTreasuryRouter(env.A.treasury2)).wait();
    const eta2 = await env.hook.routerEta();
    await setNextTs(env, eta2);
    await env.provider.send("evm_mine", []);
    const rStranger = await revertOf(() => env.hook.connect(env.W.attacker).executeTreasuryRouter.staticCall(), env.ifaces);
    await (await env.hook.connect(env.W.safe).executeTreasuryRouter()).wait();
    check("after 48 h only the owner executes; router changed", rStranger?.includes("NotOwner") && (await env.hook.treasuryRouter()) === env.A.treasury2, `eta ${eta2}`);
    const after1 = (await env.hook.pools(P.id)).fees.map(Number).join(",");
    const after2 = (await env.hook.pools(P2.id)).fees.map(Number).join(",");
    check("existing coins keep their stored rates after the router change (owner cannot touch rates)", after1 === feesP1 && after2 === feesP2 && after2 === fees2.join(",") && (await env.hook.currentFeeBps(P.id, env.A.bot)) === 100n && (await env.hook.currentFeeBps(P2.id, env.A.bot)) === 100n, `coin1 [${after1}] (graduated: 1%), coin2 [${after2}] (bonding 1%)`);
    const fnNames = env.hook.interface.fragments.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name);
    check("no function exists that changes rates, liquidity or creator balances for the owner", !fnNames.some((n) => /setFee|setRate|withdraw|rescue|sweep|remove|migrate|setCreator/i.test(n)), fnNames.join(","));
    await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R / 10n, limit: 0n });
    const rOwed2 = await env.hook.routerOwed();
    const t2b = await env.provider.getBalance(env.A.treasury2);
    await (await env.hook.connect(env.W.attacker).claimRouter()).wait();
    check("router bucket now pays the NEW TreasuryRouter", (await env.provider.getBalance(env.A.treasury2)) - t2b === rOwed2 && rOwed2 > 0n, fmt(rOwed2));
    const claims = await env.pm.balanceOf(env.hook.target, 0n);
    const sumOwed = (await env.hook.routerOwed()) + (await env.hook.creatorOwed(P.id)) + (await env.hook.creatorOwed(P2.id));
    check("ERC6909 claims held by the hook == router bucket + creator buckets", claims === sumOwed, fmt(claims));
    check("hook never received coins", (await P.coin.balanceOf(env.hook.target)) === 0n && (await env.pm.balanceOf(env.hook.target, BigInt(P.token))) === 0n);
  }

  // ---- Uniswap governance protocol fee forced on (fork only): fee + quoter + partial-fill simulation stay exact
  snapPreGrad = await revert(env, snapPreGrad);
  {
    const ctrl = await env.pm.protocolFeeController();
    await env.provider.send("anvil_impersonateAccount", [ctrl]);
    await env.provider.send("anvil_setBalance", [ctrl, "0x56BC75E2D63100000"]);
    const signer = await env.provider.getSigner(ctrl);
    await (await env.pm.connect(signer).setProtocolFee(P.key, 1000 | (1000 << 12))).wait();
    await env.provider.send("anvil_stopImpersonatingAccount", [ctrl]);
    const { q } = await quote(env, P, false, true, 1_000_000n * WAD);
    const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: false, exactIn: true, amount: 1_000_000n * WAD, limit: 0n });
    const [ok] = feeExact(t, false, true, 1_000_000n * WAD);
    check("with a 0.1% Uniswap protocol fee forced on: hook fee still gen-7 exact, quoter still exact", ok && q === t.userNative);
    const s = await slot0(env, P);
    await partialFill(env, P, { label: "with the 0.1% protocol fee on: exact-in BUY, limit across into B", buy: true, amount: R, limit: P.sqrtGrad - P.sqrtGrad / 200n, wallet: env.W.bot });
    void s;
  }
  await revert(env, snapStart);
  return out;
}

/** Which ExactInputSingleParams layout each UR accepts: v2.0 (no minHopPriceX36) or v2.1.x (with it).
 *  Decided by a real tx on a snapshot that must succeed AND emit our hookData referrer intact. */
async function detectUrStyles(env, P) {
  for (const [urName, addr] of Object.entries(env.cfg.urs)) {
    if (env.urStyles[urName] !== undefined) continue;
    env.urStyles[urName] = null;
    const tried = [];
    for (const style of ["v2.0", "v2.1"]) {
      const snap = await snapshot(env);
      const { commands, inputs } = urCalldata(style, P.key, { zeroForOne: true, exactIn: true, amount: 10n ** 15n, limit: 0n, hookData: coder.encode(["address"], [REF]) });
      let ok = false;
      try {
        const rc = await (await new ethers.Contract(addr, UR_ABI, env.W.attacker).execute(commands, inputs, 2n ** 40n, { value: 10n ** 15n, gasLimit: 2_000_000n })).wait();
        ok = rc.logs.some((l) => { try { const e = env.hook.interface.parseLog(l); return e?.name === "HookFee" && e.args.referrer === REF; } catch { return false; } });
      } catch {}
      await revert(env, snap);
      tried.push(`${style}:${ok ? "ok" : "revert"}`);
      if (ok) {
        env.urStyles[urName] = style;
        break;
      }
    }
    note(`${urName} ${addr}: V4_SWAP ExactInputSingleParams layout ${env.urStyles[urName] ?? "NONE"} (${tried.join(", ")})`);
  }
}

async function gasCompare(env, P, tickStart, tickGrad, R) {
  const snap = await snapshot(env);
  // hookless twin pool: plain token, same ticks, same A/B
  const tok = await new ethers.ContractFactory(env.C.MwzV4Token.abi, env.C.MwzV4Token.bytecode, env.W.deployer).deploy("Plain", "PLN", SUPPLY, env.seeder.target);
  await tok.waitForDeployment();
  await (await env.seeder.connect(env.W.deployer).seed(await tok.getAddress(), SPACING, tickStart, tickGrad, COINS_A, COINS_B)).wait();
  const plainKey = [ethers.ZeroAddress, await tok.getAddress(), 0, SPACING, ethers.ZeroAddress];
  const plain = { key: plainKey, id: ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], plainKey)), token: await tok.getAddress(), coin: new ethers.Contract(await tok.getAddress(), ERC20_ABI, env.provider) };
  const urName = Object.keys(env.cfg.urs).find((n) => env.urStyles[n]);
  const rows = [];
  for (const [pool, label] of [[P, "hooked"], [plain, "hookless"]]) {
    for (const via of ["direct", "ur"]) {
      // warm-up trades so both pools are measured with the same storage temperature
      await trade(env, pool, { via, urName, wallet: env.W.bot, buy: true, exactIn: true, amount: R / 100n, limit: 0n });
      await trade(env, pool, { via, urName, wallet: env.W.bot, buy: false, exactIn: true, amount: 100n * WAD, limit: 0n });
      const b = await trade(env, pool, { via, urName, wallet: env.W.bot, buy: true, exactIn: true, amount: R / 100n, limit: 0n });
      const s = await trade(env, pool, { via, urName, wallet: env.W.bot, buy: false, exactIn: true, amount: 1_000_000n * WAD, limit: 0n });
      rows.push({ pool: label, via: via === "ur" ? urName : "direct", buyGas: Number(b.gas), sellGas: Number(s.gas) });
    }
  }
  for (const via of ["direct", urName]) {
    const h = rows.find((r) => r.pool === "hooked" && r.via === via);
    const p = rows.find((r) => r.pool === "hookless" && r.via === via);
    note(`gas ${via}: buy hooked ${h.buyGas} vs hookless ${p.buyGas} (+${h.buyGas - p.buyGas}); sell hooked ${h.sellGas} vs hookless ${p.sellGas} (+${h.sellGas - p.sellGas})`);
  }
  check("gas measured for hooked vs hookless pool (direct + UR)", rows.length === 4);
  await revert(env, snap);
  return rows;
}

// ------------------------------------------------------------------ main
async function main() {
  const t0 = Date.now();
  TM.selfTest();
  const { contracts: C, solcVersion } = compileAll();
  console.log(`compiled with solc ${solcVersion}; hook runtime ${C.MwzLaunchHook.runtimeSize} bytes, launcher ${C.MwzV4Launcher.runtimeSize} bytes`);
  const report = { generatedAt: new Date().toISOString(), solcVersion, chains: {} };
  // One fresh fork per (chain, target): BSC full nodes keep only ~1 minute of state history, so each
  // run is kept short and pinned 2 blocks behind the tip.
  for (const name of CHAINS) {
    report.chains[name] = { targets: [] };
    for (const t of TARGETS) {
      let env;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const mark = RESULTS.length;
        try {
          env = await setupChain(name, C);
          Object.assign(report.chains[name], { blockGasLimit: env.forkBlock.gasLimit.toString(), hook: env.hook.target, launcher: env.launcher.target });
          const r = await runTarget(env, t);
          r.forkBlock = env.forkBlock.number;
          r.nativeUsd = env.nativeUsd.toString();
          r.urStyles = env.urStyles;
          report.chains[name].targets.push(r);
          env.child.kill();
          break;
        } catch (e) {
          env?.child.kill();
          const msg = (e?.stack || String(e)).replace(/https?:\/\/\S+/g, "<rpc>");
          const transient = /historical state|header not found|not available|missing trie node|failed to get account|failed to get storage|timeout/i.test(msg);
          if (transient && attempt < 3) {
            console.log(`transient fork error, retrying ${name} $${t} (attempt ${attempt}): ${msg.slice(0, 160)}`);
            RESULTS.splice(mark);
            continue;
          }
          CTX = name;
          check("chain run completed", false, msg.slice(0, 1500));
          break;
        }
      }
    }
  }
  report.results = RESULTS;
  const pass = RESULTS.filter((r) => r.pass).length;
  const fail = RESULTS.length - pass;
  report.summary = { pass, fail, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.mkdirSync(path.join(here, "results"), { recursive: true });
  fs.writeFileSync(path.join(here, "results", `v4-hook-proof-${CHAINS.join("-")}.json`), JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nSUMMARY: ${pass} PASS, ${fail} FAIL in ${report.summary.seconds}s`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.stack || e).replace(/https?:\/\/\S+/g, "<rpc>"));
  process.exit(1);
});

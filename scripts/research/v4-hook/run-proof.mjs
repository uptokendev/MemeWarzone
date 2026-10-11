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
  const keys = ["deployer", "creator", "buyer", "bot", "attacker", "router", "protocol"].map((n) => ethers.id("mwz-v4-hook-research/" + n)).map((k) => new ethers.NonceManager(new ethers.Wallet(k, provider)));
  const [deployer, creator, buyer, bot, attacker, routerEoa, protocolEoa] = keys;
  const A = {};
  for (const [k, w] of Object.entries({ deployer, creator, buyer, bot, attacker, routerEoa, protocolEoa })) {
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

  // ---- deploy: hook via CREATE2 with a mined salt, launcher at the deployer's next nonce
  const startNonce = await provider.getTransactionCount(A.deployer);
  const launcherAddr = ethers.getCreateAddress({ from: A.deployer, nonce: startNonce + 1 });
  const H = C.MwzLaunchHook;
  const initCode = ethers.concat([H.bytecode, coder.encode(["address", "address", "address", "address"], [cfg.pm, launcherAddr, A.routerEoa, A.protocolEoa])]);
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
  const deploy = async (n, ...a) => {
    const c = await new ethers.ContractFactory(C[n].abi, C[n].bytecode, deployer).deploy(...a);
    await c.waitForDeployment();
    return new ethers.Contract(await c.getAddress(), C[n].abi, provider);
  };
  const trader = await deploy("V4DirectTrader", cfg.pm);
  const seeder = await deploy("V4PlainSeeder", cfg.pm);
  const attackerC = await deploy("V4Attacker", cfg.pm);

  const ifaces = [hook.interface, launcher.interface, new ethers.Interface(PM_ABI), new ethers.Interface(UR_ABI), new ethers.Interface(["error InvalidHookResponse()", "error HookCallFailed()", "error PartialFill()", "error HookDeltaExceedsSwapAmount()", "error V4TooMuchRequested(uint256,uint256)", "error DeltaNotNegative(address)", "error DeltaNotPositive(address)"])];

  // ---- UR encoding style per router (v2.0 params vs 2.1.x params with minHopPriceX36)
  const urStyles = {};
  return { name, cfg, provider, child, A, W: { deployer, creator, buyer, bot, attacker, routerEoa, protocolEoa }, pm, sv, quoter, oracle, nativeUsd, hook, launcher, trader, seeder, attackerC, ifaces, urStyles, forkBlock, C };
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
        gross = ev.args.nativeGross;
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

/** Exactness of the hook fee against the trade's own native leg. Returns [ok, detail]. */
function feeExact(t, buy, exactIn, amount) {
  const r = t.rate;
  if (buy && exactIn) {
    // gross = what the trader sent; fee = floor(gross * r); curve got gross - fee
    const ok = t.gross === amount && t.fee === (amount * r) / BPS && -t.raw0 === amount - t.fee && -t.userNative === amount && t.userCoin === t.raw1;
    return [ok, `in ${fmt(amount)} fee ${fmt(t.fee, 9)} = ${(Number((t.fee * 10n ** 8n) / amount) / 1e6).toFixed(6)}% (rate ${r} bps)`];
  }
  if (buy && !exactIn) {
    const cost = -t.raw0;
    const ok = t.fee === ceilDiv(cost * r, BPS - r) && -t.userNative === cost + t.fee && t.userCoin === amount && t.raw1 === amount;
    const exactFloor = ((cost + t.fee) * r) / BPS;
    return [ok && absDiff(t.fee, exactFloor) <= 1n, `paid ${fmt(cost + t.fee)} fee ${fmt(t.fee, 9)} vs ${r}bps of paid ${fmt(exactFloor, 9)} (diff ${absDiff(t.fee, exactFloor)} wei)`];
  }
  if (!buy && exactIn) {
    const out = t.raw0;
    const ok = t.fee === (out * r) / BPS && t.userNative === out - t.fee && -t.userCoin === amount;
    return [ok, `curve out ${fmt(out)} fee ${fmt(t.fee, 9)} = ${(Number((t.fee * 10n ** 8n) / out) / 1e6).toFixed(6)}% (rate ${r} bps)`];
  }
  const net = amount;
  const ok = t.fee === ceilDiv(net * r, BPS - r) && t.raw0 === net + t.fee && t.userNative === net;
  const exactFloor = ((net + t.fee) * r) / BPS;
  return [ok && absDiff(t.fee, exactFloor) <= 1n, `got ${fmt(net)} fee ${fmt(t.fee, 9)} vs ${r}bps of gross ${fmt(exactFloor, 9)} (diff ${absDiff(t.fee, exactFloor)} wei)`];
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
    router: await env.hook.owed(env.A.routerEoa),
    protocol: await env.hook.owed(env.A.protocolEoa),
    creator: await env.hook.owed(env.A.creator),
    claims: await env.pm.balanceOf(env.hook.target, 0n),
  };
}

/** coins sold out of A so far, from the price (exact V4 math) */
function soldFromPrice(P, sqrtP) {
  if (sqrtP <= P.sqrtGrad) return P.mintedA;
  return P.mintedA - amount1Delta(P.sqrtGrad, sqrtP, P.liqA, false);
}

// ------------------------------------------------------------------ the per-target proof
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

  // ---- front-run: nobody can initialize a pool with our hook (before or after launch)
  const nextTokenGuess = ethers.getCreateAddress({ from: env.launcher.target, nonce: 999 });
  const fakeKey = [ethers.ZeroAddress, nextTokenGuess, 0x800000, SPACING, env.hook.target];
  const rInit = await revertOf(() => env.attackerC.connect(env.W.attacker).tryInitialize.staticCall(fakeKey, TM.getSqrtRatioAtTick(Number(tickStart))), env.ifaces);
  check("outside PoolManager.initialize with our hook reverts (launch front-run impossible)", rInit && rInit.includes("OnlyThisHookMayInitialize"), rInit);
  const rCreate = await revertOf(() => env.hook.connect(env.W.attacker).createPool.staticCall(nextTokenGuess, env.A.attacker, tickStart, tickGrad, 1n, 1n), env.ifaces);
  check("hook.createPool from a non-launcher reverts", rCreate && rCreate.includes("NotLauncher"), rCreate);

  // ---- atomic launch with the creator's first buy (5% of R)
  const firstBuy = R / 20n;
  const o0 = await owedAll(env);
  const txL = await env.launcher.connect(env.W.creator).launch("Research V4 Coin", "RV4", target, 0n, { value: firstBuy, gasLimit: 15_000_000n });
  const rcL = await txL.wait();
  const ev = rcL.logs.map((l) => { try { return env.launcher.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Launched");
  const P = makePool(env, ev.args.token, Number(tickStart), Number(tickGrad));
  const launchBlock = await env.provider.getBlock(rcL.blockNumber);
  P.launchTs = BigInt(launchBlock.timestamp);
  N.launchGas = rcL.gasUsed.toString();
  check("atomic launch: token + init + A/B mint + first buy in one tx", ev && ev.args.firstBuyOut > 0n, `gas ${rcL.gasUsed} (block gas limit ${env.forkBlock.gasLimit}; ${(Number(rcL.gasUsed) * 100 / Number(env.forkBlock.gasLimit)).toFixed(2)}%)`);
  check("launch gas fits an Arbitrum-style 32M per-tx cap and the BSC block", rcL.gasUsed < 32_000_000n && rcL.gasUsed < env.forkBlock.gasLimit, `${rcL.gasUsed}`);
  const initLog = rcL.logs.map((l) => { try { return env.pm.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Initialize");
  check("pool initialized in the launch tx: native/coin, dynamic fee, our hook", initLog && initLog.args.id === P.id && initLog.args.currency0 === ethers.ZeroAddress && Number(initLog.args.fee) === 0x800000 && initLog.args.hooks === env.hook.target, `poolId ${P.id}`);
  const st = await env.hook.pools(P.id);
  P.liqA = st.liqA;
  P.liqB = st.liqB;
  P.sqrtGrad = st.sqrtGrad;
  P.sqrtStart = TM.getSqrtRatioAtTick(P.tickStart);
  P.mintedA = amount1Delta(P.sqrtGrad, P.sqrtStart, P.liqA, true);
  P.mintedB = amount1Delta(TM.getSqrtRatioAtTick(TM.MIN_TICK + (-TM.MIN_TICK % SPACING)), P.sqrtGrad, P.liqB, true);
  const s0 = await slot0(env, P);
  check("LP fee is 0 (dynamic pool, never set)", s0.lpFee === 0, `lpFee ${s0.lpFee} protocolFee ${s0.protocolFee}`);
  const firstFee = (firstBuy * 200n) / BPS;
  const o1 = await owedAll(env);
  check("creator first buy pays exactly 2% (not the 90% launch fee)", o1.router - o0.router === firstFee, `first buy ${fmt(firstBuy)} fee ${fmt(o1.router - o0.router, 9)} expected ${fmt(firstFee, 9)}; got ${fmt(ev.args.firstBuyOut, 0)} coins`);
  const creatorCoins = await P.coin.balanceOf(env.A.creator);
  check("creator holds 20M reserve + first-buy coins; hook holds 0 coins", creatorCoins === 20_000_000n * WAD + ev.args.firstBuyOut && (await P.coin.balanceOf(env.hook.target)) === 0n, `creator ${fmt(creatorCoins, 0)}`);
  check("minted A = 850M and B = 130M within rounding (dust burned)", absDiff(P.mintedA, COINS_A) < 10n ** 6n && absDiff(P.mintedB, COINS_B) < 10n ** 6n, `A ${P.mintedA} B ${P.mintedB}`);
  const posA = await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash);
  const posB = await env.sv.getPositionInfo(P.id, env.hook.target, TM.MIN_TICK + (-TM.MIN_TICK % SPACING), P.tickGrad, ethers.ZeroHash);
  check("positions A and B are owned by the hook-locker in the PoolManager", posA[0] === P.liqA && posB[0] === P.liqB, `liqA ${P.liqA} liqB ${P.liqB}`);
  const rInit2 = await revertOf(() => env.attackerC.connect(env.W.attacker).tryInitialize.staticCall(P.key, P.sqrtStart), env.ifaces);
  check("re-initialize of the live pool reverts", !!rInit2, rInit2);

  // ---- market cap path: start
  const v4StartMc = mcFromSqrt(P.sqrtStart, SUPPLY);
  const idealStart = (await env.launcher.curveSqrtPrices(vN, vT))[0];
  N.mcStart = { v4: v4StartMc.toString(), gen7: g7StartMc.toString(), ppm: ppm(v4StartMc, g7StartMc), idealTickRoundingPpm: ppm(mcFromSqrt(idealStart, SUPPLY), g7StartMc) };
  check("start MC == gen-7 start MC within tick rounding (spacing 10 => <= ~500 ppm)", ppm(v4StartMc, g7StartMc) <= 501, `v4 ${fmt(v4StartMc)} gen-7 ${fmt(g7StartMc)} diff ${ppm(v4StartMc, g7StartMc)} ppm`);

  let snapLaunched = await snapshot(env);

  // ---- anti-sniper: 90% -> 2% over 60 s, buys and sells, every caller
  const sniper = [];
  for (const dt of [1n, 2n, 10n, 30n, 45n, 59n, 60n, 61n]) {
    for (const buy of [true, false]) {
      const snap = await snapshot(env);
      let t;
      if (buy) t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R / 100n, limit: 0n, ts: P.launchTs + dt });
      else t = await trade(env, P, { via: "direct", wallet: env.W.creator, buy: false, exactIn: true, amount: 1_000_000n * WAD, limit: 0n, ts: P.launchTs + dt });
      const realDt = BigInt((await env.provider.getBlock(t.block)).timestamp) - P.launchTs;
      const expected = realDt >= 60n ? 200n : 200n + ((9000n - 200n) * (60n - realDt)) / 60n;
      const [ok, d] = feeExact(t, buy, true, buy ? R / 100n : 1_000_000n * WAD);
      sniper.push({ dt: Number(realDt), side: buy ? "buy" : "sell", rateBps: Number(t.rate), expectedBps: Number(expected) });
      check(`anti-sniper t+${realDt}s ${buy ? "buy" : "sell"} rate ${expected} bps and exact`, t.rate === expected && ok, d);
      await revert(env, snap);
    }
  }
  N.sniper = sniper;
  // a second, different caller (UR) in the window pays the same schedule
  {
    const snap = await snapshot(env);
    await detectUrStyles(env, P);
    const urName = Object.keys(env.cfg.urs)[0];
    const t = await trade(env, P, { via: "ur", urName, wallet: env.W.buyer, buy: true, exactIn: true, amount: R / 100n, limit: 0n, ts: P.launchTs + 5n });
    const realDt = BigInt((await env.provider.getBlock(t.block)).timestamp) - P.launchTs;
    const expected = 200n + (8800n * (60n - realDt)) / 60n;
    check(`anti-sniper applies through the UniversalRouter too (t+${realDt}s)`, t.rate === expected, `rate ${t.rate} bps`);
    await revert(env, snap);
  }

  // ---- after the window: full matrix via UR(s) and direct callback, with V4Quoter equality
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
  const vias = [["direct", null], ...Object.keys(env.cfg.urs).map((n) => ["ur", n])];
  for (const [via, urName] of vias) {
    if (via === "ur" && !env.urStyles[urName]) {
      check(`${urName}: V4_SWAP encoding works`, false, "no encoding style succeeded");
      continue;
    }
    for (const [buy, exactIn] of [[true, true], [true, false], [false, true], [false, false]]) {
      const wallet = env.W.buyer;
      let amount, limit;
      if (buy && exactIn) [amount, limit] = [R / 50n, 0n];
      else if (buy && !exactIn) [amount, limit] = [5_000_000n * WAD, R];
      else if (!buy && exactIn) [amount, limit] = [2_000_000n * WAD, 0n];
      else [amount, limit] = [R / 200n, 100_000_000n * WAD];
      const qd = via === "ur" ? hookDataRef : "0x";
      const lbl = `${via === "ur" ? urName : "direct unlock callback"} ${buy ? "BUY" : "SELL"} exact${exactIn ? "In" : "Out"}`;
      const { q, gasEst } = await quote(env, P, buy, exactIn, amount, qd);
      let t;
      try {
        t = await trade(env, P, { via, urName, wallet, buy, exactIn, amount, limit, hookData: qd });
      } catch (e) {
        if (!e.tradeRevert) throw e;
        check(`${lbl}: trade executes`, false, e.tradeRevert);
        continue;
      }
      const [ok, d] = feeExact(t, buy, exactIn, amount);
      check(`${lbl}: fee in native exactly 2% of the native leg`, ok && t.rate === 200n, d);
      check(`${lbl}: V4Quoter == executed`, q === quotedSide(t, buy, exactIn), `quote ${q} actual ${quotedSide(t, buy, exactIn)}`);
      if (via === "ur") check(`${lbl}: referrer from hookData emitted`, t.referrer === REF, t.referrer);
      N.trades.push({ via: via === "ur" ? urName : "direct", side: buy ? "buy" : "sell", exactIn, gas: Number(t.gas), quoterGasEstimate: Number(gasEst) });
    }
  }
  // partial fill with a price limit: exact-in buy is refused (fee was charged on the full input)
  {
    const s = await slot0(env, P);
    const r = await revertOf(() => env.trader.connect(env.W.bot).swap.staticCall(P.key, true, -R, s.sqrtP - s.sqrtP / 100000n, "0x", { value: R }), env.ifaces);
    check("exact-in buy that would only partly fill (price limit) reverts PartialFill", r && r.includes("PartialFill"), r);
  }
  // sell 100% of a balance (UR) and untaxed wallet-to-wallet transfer
  {
    const urName = Object.keys(env.cfg.urs).find((n) => env.urStyles[n]);
    const bal = await P.coin.balanceOf(env.A.buyer);
    const t = await trade(env, P, { via: "ur", urName, wallet: env.W.buyer, buy: false, exactIn: true, amount: bal, limit: 0n });
    check("selling 100% of a wallet balance via UR works", (await P.coin.balanceOf(env.A.buyer)) === 0n && t.userNative > 0n, `sold ${fmt(bal, 0)} got ${fmt(t.userNative)}`);
    const amt = 1_234_567n * WAD;
    const before = await P.coin.balanceOf(env.A.attacker);
    await (await P.coin.connect(env.W.creator).transfer(env.A.attacker, amt)).wait();
    check("wallet-to-wallet transfer is untaxed", (await P.coin.balanceOf(env.A.attacker)) - before === amt, `${fmt(amt, 0)} sent and received`);
  }

  // ---- liquidity lock: outside add (direct + canonical PositionManager), remove, donate
  {
    const r1 = await revertOf(() => env.attackerC.connect(env.W.attacker).tryAdd.staticCall(P.key, P.tickGrad, P.tickStart, 10n ** 18n), env.ifaces);
    check("outside addLiquidity via own unlock callback reverts", r1 && r1.includes("LiquidityIsLocked"), r1);
    const r1b = await revertOf(() => env.attackerC.connect(env.W.attacker).tryAdd.staticCall(P.key, P.tickStart + 10, P.tickStart + 1000, 10n ** 18n, { value: WAD }), env.ifaces);
    check("outside native-side addLiquidity (range above price) reverts", r1b && r1b.includes("LiquidityIsLocked"), r1b);
    const posm = new ethers.Contract(env.cfg.posm, POSM_ABI, env.W.attacker);
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
    check("nobody can remove A (positions are keyed by owner = hook)", !!r3, r3);
    const r3b = await revertOf(() => env.attackerC.connect(env.W.attacker).tryRemove.staticCall(P.key, TM.MIN_TICK + (-TM.MIN_TICK % SPACING), P.tickGrad, 1n), env.ifaces);
    check("nobody can remove B", !!r3b, r3b);
    const r4 = await revertOf(() => env.attackerC.connect(env.W.attacker).tryDonate.staticCall(P.key, { value: WAD }), env.ifaces);
    check("donate reverts (keeps graduation accounting exact)", r4 && r4.includes("DonateDisabled"), r4);
    const fakeParams = [true, -1n, TM.MIN_SQRT_RATIO + 1n];
    const r5 = await revertOf(() => env.hook.connect(env.W.attacker).beforeSwap.staticCall(env.A.attacker, P.key, fakeParams, "0x"), env.ifaces);
    check("hook callbacks callable only by the PoolManager", r5 && r5.includes("NotPoolManager"), r5);
    const r6 = await revertOf(() => env.launcher.connect(env.W.attacker).unlockCallback.staticCall("0x"), env.ifaces);
    check("launcher callback not callable from outside", !!r6, r6);
    const abiFns = env.hook.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name);
    check("hook has no liquidity-removal entry point (state-changing fns)", !abiFns.some((n) => /remove|withdraw|migrate|rescue|sweep|collect/i.test(n)), abiFns.join(","));
  }

  // ---- gas baseline: hookless pool with the same shape, same trades
  const gasRows = await gasCompare(env, P, tickStart, tickGrad, R);
  N.gas = gasRows;

  // ---- walk the curve: MC path vs gen-7, graduation latch, 2% of raise, post-grad split
  snapL2 = await revert(env, snapL2);
  {
    const latest = BigInt((await env.provider.getBlock("latest")).timestamp);
    await setNextTs(env, P.launchTs + 61n > latest ? P.launchTs + 61n : latest + 1n);
    await env.provider.send("evm_mine", []);
  }
  N.mcPath = [];
  let nativeIntoCurve = 0n;
  for (const f of [10n, 25n, 50n, 75n, 90n, 99n]) {
    const s = await slot0(env, P);
    const soldNow = soldFromPrice(P, s.sqrtP);
    const want = (COINS_A * f) / 100n;
    if (want > soldNow) {
      const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: want - soldNow, limit: R * 2n });
      nativeIntoCurve += -t.raw0;
    }
    const s2 = await slot0(env, P);
    const sold = soldFromPrice(P, s2.sqrtP);
    const v4Mc = mcFromSqrt(s2.sqrtP, SUPPLY);
    const g7Mc = gen7.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold, totalSupply: SUPPLY });
    N.mcPath.push({ pctOfA: Number(f), sold: sold.toString(), v4Mc: v4Mc.toString(), gen7Mc: g7Mc.toString(), ppm: ppm(v4Mc, g7Mc) });
    check(`MC at ${f}% of A == gen-7 MC at the same sold amount (tick rounding)`, ppm(v4Mc, g7Mc) <= 1000, `v4 ${fmt(v4Mc)} gen-7 ${fmt(g7Mc)} diff ${ppm(v4Mc, g7Mc)} ppm`);
  }
  // just below the threshold: 1 coin left in A
  {
    const s = await slot0(env, P);
    const soldNow = soldFromPrice(P, s.sqrtP);
    const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: P.mintedA - soldNow - WAD, limit: R * 2n });
    nativeIntoCurve += -t.raw0;
    const g = (await env.hook.pools(P.id)).graduated;
    check("no graduation with 1 coin of A left (latch only at the threshold)", !g && t.graduated === null, `price ${fmt(mcFromSqrt((await slot0(env, P)).sqrtP, SUPPLY))} MC`);
  }
  let snapPreGrad = await snapshot(env);
  // variant: cross with an exact-OUTPUT buy (fee charged in afterSwap) - fee must use the 2% rate
  {
    const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: 2n * WAD, limit: R });
    check("crossing with exact-out buy: graduates in the same swap, swap fee at 2% (pre-grad rate)", t.graduated !== null && t.rate === 200n, `rate ${t.rate}`);
    snapPreGrad = await revert(env, snapPreGrad);
  }
  // main: cross with an exact-input buy via the UR
  const o2 = await owedAll(env);
  const urName = Object.keys(env.cfg.urs).find((n) => env.urStyles[n]);
  const tCross = await trade(env, P, { via: "ur", urName, wallet: env.W.buyer, buy: true, exactIn: true, amount: R / 50n, limit: 0n });
  const o3 = await owedAll(env);
  check("graduation latched in the crossing swap", tCross.graduated !== null && (await env.hook.pools(P.id)).graduated, `crossing swap gas ${tCross.gas}`);
  N.crossingSwapGas = Number(tCross.gas);
  const nativeInA = amount0Delta(P.sqrtGrad, P.sqrtStart, P.liqA, false);
  const removed = (P.liqA * 200n) / BPS;
  const expectedGradFee = amount0Delta(P.sqrtGrad, P.sqrtStart, removed, false);
  if (tCross.graduated) {
    const gf = tCross.graduated.gradFee;
    check("graduation fee == native of exactly 2% of A's liquidity (exact V4 math)", gf === expectedGradFee && tCross.graduated.removed === removed, `${fmt(gf, 9)}`);
    check("graduation fee == 2% of A's native raise (within 2 wei)", absDiff(gf, (nativeInA * 200n) / BPS) <= 2n, `fee ${gf} vs 2% of ${nativeInA} = ${(nativeInA * 200n) / BPS} (diff ${absDiff(gf, (nativeInA * 200n) / BPS)} wei)`);
    check("graduation fee + crossing swap fee credited to the fee router", o3.router - o2.router === gf + tCross.fee, `${fmt(o3.router - o2.router, 9)}`);
    N.graduation = { nativeInA: nativeInA.toString(), gen7R: R.toString(), raiseVsRppm: ppm(nativeInA, R), gradFee: gf.toString(), twoPctOfRaise: ((nativeInA * 200n) / BPS).toString() };
  }
  check("native raise in A vs gen-7 R (tick rounding)", ppm(nativeInA, R) <= 1000, `A raise ${fmt(nativeInA)} gen-7 R ${fmt(R)} diff ${ppm(nativeInA, R)} ppm`);
  const posA2 = await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash);
  check("A keeps exactly 98% of its liquidity; B untouched", posA2[0] === P.liqA - removed && (await env.sv.getPositionInfo(P.id, env.hook.target, TM.MIN_TICK + (-TM.MIN_TICK % SPACING), P.tickGrad, ethers.ZeroHash))[0] === P.liqB, `A ${posA2[0]}`);
  const v4TopMc = mcFromSqrt(P.sqrtGrad, SUPPLY);
  N.mcTop = { v4: v4TopMc.toString(), gen7: g7EndMc.toString(), targetNative: mc.toString(), ppmVsGen7: ppm(v4TopMc, g7EndMc), ppmVsTarget: ppm(v4TopMc, mc) };
  check("top-of-A MC == gen-7 graduation MC within tick rounding", ppm(v4TopMc, g7EndMc) <= 501, `v4 ${fmt(v4TopMc)} gen-7 ${fmt(g7EndMc)} diff ${ppm(v4TopMc, g7EndMc)} ppm; vs USD target ${fmt(mc)} native: ${ppm(v4TopMc, mc)} ppm`);
  check("claims held by hook == sum owed", o3.claims === o3.router + o3.protocol + o3.creator, `${fmt(o3.claims)}`);

  // ---- post-graduation: 1%, creator exactly 0.5%, latch once, still post-grad below threshold
  const postTrades = [];
  for (const [via, buy, exactIn, amount, limit] of [
    ["direct", true, true, R / 20n, 0n],
    ["ur", true, false, 3_000_000n * WAD, R],
    ["ur", false, true, 5_000_000n * WAD, 0n],
    ["direct", false, false, R / 100n, 50_000_000n * WAD],
  ]) {
    const wallet = env.W.bot;
    const ob = await owedAll(env);
    const { q } = await quote(env, P, buy, exactIn, amount);
    const t = await trade(env, P, { via, urName, wallet, buy, exactIn, amount, limit });
    const oa = await owedAll(env);
    const [ok, d] = feeExact(t, buy, exactIn, amount);
    const lbl = `post-grad ${via} ${buy ? "BUY" : "SELL"} exact${exactIn ? "In" : "Out"}`;
    check(`${lbl}: fee exactly 1% of native leg`, ok && t.rate === 100n, d);
    const cExp = (t.gross * 50n) / BPS;
    check(`${lbl}: creator gets exactly 0.5% of native volume, protocol the rest, router 0`, oa.creator - ob.creator === cExp && oa.protocol - ob.protocol === t.fee - cExp && oa.router === ob.router, `volume ${fmt(t.gross)} creator ${fmt(oa.creator - ob.creator, 9)} protocol ${fmt(oa.protocol - ob.protocol, 9)}`);
    check(`${lbl}: V4Quoter == executed`, q === quotedSide(t, buy, exactIn), `quote ${q}`);
    check(`${lbl}: no second graduation`, t.graduated === null);
    postTrades.push({ via, buy, exactIn, gas: Number(t.gas) });
  }
  N.postGradTrades = postTrades;
  // fall back below the threshold: sell enough to push the price back into A
  {
    const bal = await P.coin.balanceOf(env.A.bot);
    const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: false, exactIn: true, amount: bal / 2n, limit: 0n });
    const s = await slot0(env, P);
    const below = s.sqrtP > P.sqrtGrad;
    check("price fell back below the graduation threshold", below, `MC now ${fmt(mcFromSqrt(s.sqrtP, SUPPLY))} vs top ${fmt(v4TopMc)}`);
    check("after falling back: still graduated, still 1%", (await env.hook.pools(P.id)).graduated && t.rate === 100n && (await env.hook.currentFeeBps(P.id, env.A.bot)) === 100n);
    const ob = await owedAll(env);
    const t2 = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: R, limit: 0n });
    const oa = await owedAll(env);
    check("re-crossing the threshold does not graduate again or take another 2%", t2.graduated === null && oa.router === ob.router && t2.rate === 100n, `crossed again: ${(await slot0(env, P)).sqrtP <= P.sqrtGrad}`);
  }
  // ---- payouts from ERC6909 claims
  {
    const o = await owedAll(env);
    for (const [who, addr] of [["fee router", env.A.routerEoa], ["protocol", env.A.protocolEoa], ["creator", env.A.creator]]) {
      const before = await env.provider.getBalance(addr);
      const owedNow = await env.hook.owed(addr);
      const rc = await (await env.hook.connect(env.W.deployer).claim(addr)).wait();
      const after = await env.provider.getBalance(addr);
      check(`claim(${who}) pays exactly what is owed, in native (anyone can trigger)`, after - before === owedNow && (await env.hook.owed(addr)) === 0n, `${fmt(owedNow)} gas ${rc.gasUsed}`);
    }
    check("hook claims fully paid out", (await env.pm.balanceOf(env.hook.target, 0n)) === 0n);
    check("hook never received coins", (await P.coin.balanceOf(env.hook.target)) === 0n && (await env.pm.balanceOf(env.hook.target, BigInt(P.token))) === 0n);
    N.claimTotals = { router: o.router.toString(), protocol: o.protocol.toString(), creator: o.creator.toString() };
  }

  // ---- Uniswap governance protocol fee (fee controller exists on both chains): effect on exactness
  snapPreGrad = await revert(env, snapPreGrad);
  {
    const ctrl = await env.pm.protocolFeeController();
    await env.provider.send("anvil_impersonateAccount", [ctrl]);
    await env.provider.send("anvil_setBalance", [ctrl, "0x56BC75E2D63100000"]);
    const signer = await env.provider.getSigner(ctrl);
    await (await env.pm.connect(signer).setProtocolFee(P.key, 1000 | (1000 << 12))).wait();
    await env.provider.send("anvil_stopImpersonatingAccount", [ctrl]);
    const s = await slot0(env, P);
    const { q } = await quote(env, P, false, true, 1_000_000n * WAD);
    const t = await trade(env, P, { via: "direct", wallet: env.W.bot, buy: false, exactIn: true, amount: 1_000_000n * WAD, limit: 0n });
    const [ok] = feeExact(t, false, true, 1_000_000n * WAD);
    check("with a 0.1% Uniswap protocol fee forced on (fork only): hook fee still exact, quoter still exact", s.protocolFee === (1000 | (1000 << 12)) && ok && q === t.userNative, `protocolFee ${s.protocolFee}`);
    note("the Uniswap protocol fee (max 0.1%/direction, set by the fee controller) would come out of the curve, not out of our fee");
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

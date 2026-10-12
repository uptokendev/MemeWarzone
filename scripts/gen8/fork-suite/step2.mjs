// EVM generation 8, step 2: the fork suite extended (founder go 2026-10-11). Runs on its own fresh fork per
// (chain, target), after the base suite, with the same production contracts (artifacts-gen8) and the same rules:
// local anvil forks only, fresh deterministic keys, no real transaction.
//
// Areas (every check carries its area in the results file):
//   split   MwzFeeSplitter against the REAL gen-7 vaults (destinations read from the gen-7 TreasuryRouterV4 on the
//           fork), run amounts computed the way the indexer will (aggregate sums + bands()), per-trade floor-sum
//           rounding (audit risk 2), band enforcement, arrival in each vault, nothing stuck, accrualRoot, and the
//           D8 alternative (reusing the gen-7 community vault) with the Safe call it needs and what it breaks.
//   choice  MwzCreatorChoiceVault: keep / holders / split / buyback coins, pull, weekly holder batch through a
//           holder distributor stand-in (gen-7 RewardDistributor code, D8), unclaimed re-credit, buyback in our
//           pool to 0xdEaD, every cap.
//   escrow  MwzCreatorEscrow: app-path buys escrowed, 20% at 30 days then weekly (time travel), claims.
//   ur      every UniversalRouter version per chain (BSC 3, Robinhood 2) plus the direct PoolManager callback trader
//           on every path above that swaps.
//   side    side pools: hookless V4, V3 and V2 pools of a gen-8 coin; our pool and fees unaffected; arbitrage keeps
//           prices aligned; the exact events a side-pool watcher must follow, with sample logs (step 3).
//   grad    graduation edge cases: crossing via every router, exact-output crossing, price limit at the boundary,
//           re-crossing, falling back below, display pair continuity (BNB).
//   fixes   the 2026-10-12 fix round (fixes.mjs): the AI-audit PoCs replayed against the fixed contracts.
import { ethers } from "ethers";
import { WAD, Q96, BPS, fmt, absDiff, ppm, amount0Delta, amount1Delta, revertOf } from "./lib.mjs";
import * as TM from "./tickmath.mjs";
import { areaFixes } from "./fixes.mjs";

const coder = ethers.AbiCoder.defaultAbiCoder();
const DEAD = "0x000000000000000000000000000000000000dEaD";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const URC = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, V2_SWAP_EXACT_IN: 0x08, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 };
const PROFILE = { LINKED: 0, UNLINKED: 1, OG: 2 };
const PROFILE_NAME = ["linked", "unlinked", "og"];
// gen-7 TreasuryRouterV4.previewTrade / previewFinalize (recruiter, squad, airdrop bps per profile)
const TRADE_BPS = [
  { rec: 1250n, sq: 250n, air: 0n },
  { rec: 0n, sq: 0n, air: 1500n },
  { rec: 1500n, sq: 250n, air: 0n },
];
const GRAD_BPS = [
  { rec: 1500n, sq: 250n, air: 0n },
  { rec: 0n, sq: 0n, air: 1750n },
  { rec: 1750n, sq: 250n, air: 0n },
];
// gen-7 vault caps per chain (deployments/*/mainnet.gen7.json inputs.caps), used when the live gen-7 vault's
// limits() still reads zero (its Safe batch B is not executed yet)
const GEN7_CAPS = {
  bsc: { maxBuyPerTx: 650000000000000000n, maxBuybackPerCoinWeek: 6500000000000000000n, minBuyInterval: 21600n, maxImpactBps: 50n, maxHolderBatchPerWeek: 32000000000000000000n },
  rh: { maxBuyPerTx: 190000000000000000n, maxBuybackPerCoinWeek: 1900000000000000000n, minBuyInterval: 21600n, maxImpactBps: 50n, maxHolderBatchPerWeek: 9300000000000000000n },
};

const ABI = {
  community: [
    "function router() view returns (address)",
    "function admin() view returns (address)",
    "function setRouter(address)",
    "function setRewardDistributor(address)",
    "function setAirdropOperator(address)",
    "function depositAirdrop() payable",
    "function depositSquadPool() payable",
    "function warzoneAirdropBalance() view returns (uint256)",
    "function squadPoolBalance() view returns (uint256)",
    "function rewardDistributor() view returns (address)",
    "function airdropOperator() view returns (address)",
  ],
  gen7Vault: ["function limits() view returns (bool, uint256, uint256, uint256, uint256, uint256)", "function holderDistributor() view returns (address)", "function admin() view returns (address)"],
  distributor: [
    "function owner() view returns (address)",
    "function batchOperator() view returns (address)",
    "function setBatchOperator(address)",
    "function authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)",
    "function claim(bytes32 batchId, uint256 amount, bytes32[] proof)",
    "function recoverUnclaimed(bytes32 batchId, address recipient)",
    "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)",
    "function unclaimed(bytes32) view returns (uint256)",
  ],
  weth: ["function deposit() payable", "function withdraw(uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
  v2Factory: ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)", "function allPairsLength() view returns (uint256)", "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"],
  v2Pair: [
    "function mint(address to) returns (uint256)",
    "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
    "function getReserves() view returns (uint112, uint112, uint32)",
    "function token0() view returns (address)",
    "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    "event Sync(uint112 reserve0, uint112 reserve1)",
  ],
  v3Factory: ["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)", "function feeAmountTickSpacing(uint24) view returns (int24)", "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"],
  v3Pool: [
    "function initialize(uint160)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool)",
    "function liquidity() view returns (uint128)",
    "event Initialize(uint160 sqrtPriceX96, int24 tick)",
    "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  ],
  npm: [
    "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function refundETH() payable",
    "function multicall(bytes[] data) payable returns (bytes[] results)",
  ],
  pmEvents: [
    "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
    "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  ],
  erc20Events: ["event Transfer(address indexed from, address indexed to, uint256 value)"],
};
const IFACE = Object.fromEntries(Object.entries(ABI).map(([k, v]) => [k, new ethers.Interface(v)]));

// ------------------------------------------------------------------ small utilities
const lc = (a) => a.toLowerCase();
const maxB = (a, b) => (a > b ? a : b);
const minB = (a, b) => (a < b ? a : b);

/** OpenZeppelin StandardMerkleTree-compatible tree (sorted-pair hashing, double-hashed leaves). */
function merkle(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, proof: () => [] };
  const hp = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));
  const layers = [[...leaves]];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hp(cur[i], cur[i + 1]) : cur[i]);
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1][0],
    proof(leaf) {
      let idx = layers[0].indexOf(leaf);
      const out = [];
      for (let l = 0; l < layers.length - 1; l++) {
        const sib = idx ^ 1;
        if (sib < layers[l].length) out.push(layers[l][sib]);
        idx >>= 1;
      }
      return out;
    },
  };
}
const ozLeaf = (types, values) => ethers.keccak256(ethers.keccak256(coder.encode(types, values)));

/** Every value-carrying call frame of a transaction (anvil callTracer). */
async function valueCalls(env, hash) {
  const tr = await env.provider.send("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
  const out = [];
  const walk = (c) => {
    const v = c.value ? BigInt(c.value) : 0n;
    if (v > 0n) out.push({ from: lc(c.from), to: lc(c.to), value: v, sel: (c.input || "0x").slice(0, 10), error: c.error || null });
    for (const s of c.calls ?? []) walk(s);
  };
  walk(tr);
  return out;
}

/** eth_call from `from` with a balance override, so a contract sender with 0 balance can carry value. */
async function callWithValue(env, from, to, data, value) {
  try {
    await env.provider.send("eth_call", [{ from, to, data, value: "0x" + value.toString(16) }, "latest", { [from]: { balance: "0x" + (10n ** 21n).toString(16) } }]);
    return null;
  } catch (e) {
    const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof d === "string" && d.startsWith("0x08c379a0")) return "Error(" + coder.decode(["string"], "0x" + d.slice(10))[0] + ")";
    return (e?.shortMessage || e?.message || String(e)).slice(0, 160);
  }
}

async function impersonate(env, addr) {
  await env.provider.send("anvil_impersonateAccount", [addr]);
  await env.provider.send("anvil_setBalance", [addr, "0x" + (10n ** 21n).toString(16)]);
  return env.provider.getSigner(addr);
}

async function now(env) {
  return BigInt((await env.provider.getBlock("latest")).timestamp);
}
async function warpTo(env, ts) {
  const cur = await now(env);
  await env.provider.send("evm_setNextBlockTimestamp", [Number(ts > cur ? ts : cur + 1n)]);
  await env.provider.send("evm_mine", []);
}

// ------------------------------------------------------------------ the indexer model (step 3 must do exactly this)
/** Rows from the hook's logs in (fromBlock, toBlock]: one per HookFee and per Graduated. */
async function indexRows(env, S, fromBlock, toBlock = "latest") {
  const logs = await env.provider.getLogs({ address: env.hook.target, fromBlock: Number(fromBlock) + 1, toBlock });
  const rows = [];
  for (const log of logs) {
    let ev;
    try {
      ev = env.hook.interface.parseLog(log);
    } catch {
      continue;
    }
    if (!ev) continue;
    if (ev.name === "HookFee") {
      const from = await S.txFrom(log.transactionHash);
      const base = { tx: log.transactionHash, logIndex: BigInt(log.index), block: log.blockNumber, id: ev.args.id, from, fee: ev.args.fee, creatorShare: ev.args.creatorShare, routerPart: ev.args.fee - ev.args.creatorShare, swapSender: ev.args.swapSender };
      if (!ev.args.graduated) rows.push({ ...base, kind: 0, profile: S.profileOf(from), amount: ev.args.fee });
      else rows.push({ ...base, kind: 2, profile: S.profileOf(from), amount: 0n });
    } else if (ev.name === "Graduated") {
      const creator = S.humanCreator.get(ev.args.id);
      rows.push({ tx: log.transactionHash, logIndex: BigInt(log.index), block: log.blockNumber, id: ev.args.id, kind: 1, profile: S.profileOf(creator), amount: ev.args.gradFeeNative, fee: 0n, creatorShare: 0n, routerPart: ev.args.gradFeeNative, from: creator });
    }
  }
  // per-row slices (what goes into the accrual tree and what a per-trade-floor indexer would sum)
  for (const r of rows) {
    const t = r.kind === 0 ? TRADE_BPS[r.profile] : r.kind === 1 ? GRAD_BPS[r.profile] : { rec: 0n, sq: 0n, air: 0n };
    r.rec = (r.amount * t.rec) / BPS;
    r.sq = (r.amount * t.sq) / BPS;
    r.air = (r.amount * t.air) / BPS;
  }
  return rows;
}

function accrualTree(rows) {
  const leaves = rows.map((r) => ozLeaf(["bytes32", "uint256", "uint8", "uint8", "uint256", "uint256", "uint256", "uint256"], [r.tx, r.logIndex, r.kind, r.profile, r.amount, r.rec, r.sq, r.air]));
  return merkle([...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
}

const bandsJs = (B, G) => {
  const league = (B * 3750n) / BPS;
  const weekly = (league * 3000n) / BPS;
  return { weekly, monthly: league - weekly, rsaMin: (B * 1500n) / BPS + (G * 1750n) / BPS, rsaMax: (B * 1750n) / BPS + (G * 2000n) / BPS, squadMax: ((B + G) * 250n) / BPS };
};

/** The aggregate method (recommended for step 3): one floor per pot on the run's summed numerators, then clamp the
 *  recruiter + squad + airdrop total into bands(B, G); the rounding remainder goes to the airdrop pot. */
function aggregateRun(rows, bands) {
  let B = 0n, G = 0n, nRec = 0n, nSq = 0n, nAir = 0n, total = 0n;
  for (const r of rows) {
    total += r.routerPart;
    if (r.kind === 2) continue;
    const t = r.kind === 0 ? TRADE_BPS[r.profile] : GRAD_BPS[r.profile];
    if (r.kind === 0) B += r.amount;
    else G += r.amount;
    nRec += r.amount * t.rec;
    nSq += r.amount * t.sq;
    nAir += r.amount * t.air;
  }
  const b = bands ?? bandsJs(B, G);
  let rsa = (nRec + nSq + nAir) / BPS;
  if (rsa < b.rsaMin) rsa = b.rsaMin;
  if (rsa > b.rsaMax) rsa = b.rsaMax;
  let recruiter = nRec / BPS;
  let squad = nSq / BPS;
  if (squad > b.squadMax) squad = b.squadMax;
  let airdrop = rsa - recruiter - squad;
  if (airdrop < 0n) {
    recruiter += airdrop;
    airdrop = 0n;
  }
  return { B, G, total, recruiter, squad, airdrop, rsa };
}

/** The per-trade method audit risk 2 warns about: floor each trade's slices, then sum. */
function perTradeRun(rows) {
  let recruiter = 0n, squad = 0n, airdrop = 0n;
  for (const r of rows) {
    recruiter += r.rec;
    squad += r.sq;
    airdrop += r.air;
  }
  return { recruiter, squad, airdrop, rsa: recruiter + squad + airdrop };
}

// ------------------------------------------------------------------ UR helpers for V2 / V3 side pools
// UR 2.1.x added per-hop slippage to the V2 / V3 swap commands: (recipient, amountIn, amountOutMin, path, payerIsUser,
// uint256[] maxHopSlippage). The v2.0 layout has no sixth field. Found on the Robinhood fork (SliceOutOfBounds with
// the five-field encoding); the app's V2 / V3 encoder must follow the router version, as for V4_SWAP.
const swapIn = (style, types, values) => (style === "v2.1" ? coder.encode([...types, "uint256[]"], [...values, []]) : coder.encode(types, values));
function urV3Buy(W, coin, fee, amountIn, style) {
  const path = ethers.solidityPacked(["address", "uint24", "address"], [W, fee, coin]);
  return {
    commands: ethers.solidityPacked(["uint8", "uint8"], [URC.WRAP_ETH, URC.V3_SWAP_EXACT_IN]),
    inputs: [coder.encode(["address", "uint256"], [ADDRESS_THIS, amountIn]), swapIn(style, ["address", "uint256", "uint256", "bytes", "bool"], [MSG_SENDER, amountIn, 0n, path, false])],
    value: amountIn,
  };
}
function urV3Sell(W, coin, fee, amountIn, style) {
  const path = ethers.solidityPacked(["address", "uint24", "address"], [coin, fee, W]);
  return {
    commands: ethers.solidityPacked(["uint8", "uint8"], [URC.V3_SWAP_EXACT_IN, URC.UNWRAP_WETH]),
    inputs: [swapIn(style, ["address", "uint256", "uint256", "bytes", "bool"], [ADDRESS_THIS, amountIn, 0n, path, true]), coder.encode(["address", "uint256"], [MSG_SENDER, 0n])],
    value: 0n,
  };
}
function urV2Buy(W, coin, amountIn, style) {
  return {
    commands: ethers.solidityPacked(["uint8", "uint8"], [URC.WRAP_ETH, URC.V2_SWAP_EXACT_IN]),
    inputs: [coder.encode(["address", "uint256"], [ADDRESS_THIS, amountIn]), swapIn(style, ["address", "uint256", "uint256", "address[]", "bool"], [MSG_SENDER, amountIn, 0n, [W, coin], false])],
    value: amountIn,
  };
}
function urV2Sell(W, coin, amountIn, style) {
  return {
    commands: ethers.solidityPacked(["uint8", "uint8"], [URC.V2_SWAP_EXACT_IN, URC.UNWRAP_WETH]),
    inputs: [swapIn(style, ["address", "uint256", "uint256", "address[]", "bool"], [ADDRESS_THIS, amountIn, 0n, [coin, W], true]), coder.encode(["address", "uint256"], [MSG_SENDER, 0n])],
    value: 0n,
  };
}

// ------------------------------------------------------------------ entry
export const STEP2_AREAS = ["split", "choice", "escrow", "side", "grad", "fixes"];

export async function runStep2(env, targetUsd, H, onlyAreas = null) {
  const { check, note } = H;
  const ctx = `${env.name} $${targetUsd / 1000n}K`;
  H.setCtx(ctx);
  const out = { chain: env.name, targetUsd: Number(targetUsd), nums: {}, safeCalls: [], watcher: {} };
  const S = await setupStep2(env, H, out);
  const target = targetUsd * WAD;
  const [, vN, vT] = await env.launcher.plan(target);
  S.R = H.gen7.graduationRaise(vN, vT, H.consts.COINS_A);
  S.target = target;

  // main coin: launched by `creator` (linked profile) with a 5% first buy; after the 60 s window, UR layouts detected
  H.setArea("step2-setup");
  const { P, ev } = await H.launchCoin(env, env.W.creator, target, S.R / 20n, H.consts.FEES, "Gen8 Step2 Coin");
  S.humanCreator.set(P.id, env.A.creator);
  S.launchBlock = ev ? (await env.provider.getBlockNumber()) - 1 : 0;
  await warpTo(env, P.launchTs + 61n);
  await H.detectUrStyles(env, P);
  S.vias = [["direct", null], ...Object.keys(env.cfg.urs).filter((n) => env.urStyles[n]).map((n) => ["ur", n])];
  check("[ur] every UniversalRouter version of the chain has a working V4_SWAP layout", S.vias.length === 1 + Object.keys(env.cfg.urs).length, Object.entries(env.urStyles).map(([k, v]) => `${k}: ${v}`).join(", "));
  const snapMain = await H.snapshot(env);
  S.snapMain = snapMain;

  const areas = [
    ["split", () => areaSplitter(env, H, S, P, out)],
    ["choice", () => areaChoiceVault(env, H, S, out)],
    ["escrow", () => areaEscrow(env, H, S, P, out)],
    ["side", () => areaSidePools(env, H, S, P, out)],
    ["grad", () => areaGraduation(env, H, S, P, out)],
    ["fixes", () => areaFixes(env, H, S, out)], // 2026-10-12 fix round (F1, F2, F3, F6, B): audit PoCs replayed
  ];
  const only = onlyAreas ?? (process.env.STEP2_AREAS ? process.env.STEP2_AREAS.split(",") : null);
  for (const [name, fn] of areas) {
    if (only && !only.includes(name)) continue;
    H.setArea(name);
    H.setCtx(ctx);
    const snap = await H.snapshot(env);
    await fn();
    await H.revert(env, snap);
  }
  return out;
}

// ------------------------------------------------------------------ setup: wallets, profiles, Safe recorder
async function setupStep2(env, H, out) {
  const { check } = H;
  H.setArea("step2-setup");
  const S = { humanCreator: new Map(), txFromCache: new Map() };
  const extra = ["lnk1", "unl1", "unl2", "og1", "sideLp", "sideTrader", "arb", "holderX"];
  for (const n of extra) {
    const w = new ethers.NonceManager(new ethers.Wallet(ethers.id("mwz-gen8-fork-suite/step2/" + n), env.provider));
    env.W[n] = w;
    env.A[n] = await w.getAddress();
    await env.provider.send("anvil_setBalance", [env.A[n], "0x" + (100_000_000n * WAD).toString(16)]);
    check(`test account ${n} has no code on the fork`, (await env.provider.getCode(env.A[n])) === "0x", env.A[n]);
  }
  const prof = new Map();
  for (const n of ["creator", "buyer", "lnk1", "creator2"]) prof.set(lc(env.A[n]), PROFILE.LINKED);
  for (const n of ["og1"]) prof.set(lc(env.A[n]), PROFILE.OG);
  // everyone else (bot, unl1, unl2, attacker, side wallets, contracts) is unlinked: the indexer default
  S.profileOf = (a) => prof.get(lc(a ?? "")) ?? PROFILE.UNLINKED;
  S.txFrom = async (h) => {
    if (!S.txFromCache.has(h)) S.txFromCache.set(h, (await env.provider.getTransaction(h)).from);
    return S.txFromCache.get(h);
  };
  // Safe calls are recorded with their calldata (step 9 Safe batches). Gen-8 contracts are owned by the suite's
  // test Safe key; gen-7 contracts are called from the real Safe, impersonated on the fork.
  S.safeCall = async (label, contract, fn, args, { real = false, value = 0n, record = true, contractName = "" } = {}) => {
    const signer = real ? await impersonate(env, env.cfg.gen7.safe) : env.W.safe;
    const c = contract.connect(signer);
    const tx = await c[fn](...args, { value, gasLimit: 3_000_000n });
    const rc = await tx.wait();
    if (record) {
      out.safeCalls.push({
        label,
        to: contract.target,
        contract: contractName,
        function: contract.interface.getFunction(fn).format("sighash"),
        args: args.map(String),
        value: value.toString(),
        data: contract.interface.encodeFunctionData(fn, args),
        gas: rc.gasUsed.toString(),
        safe: real ? "real Safe 0x1edc (gen-7 contract)" : "Safe (gen-8 contract; test Safe key on the fork)",
      });
    }
    if (real) await env.provider.send("anvil_stopImpersonatingAccount", [env.cfg.gen7.safe]);
    return rc;
  };
  // gen-7 facts on the fork
  const g7 = new ethers.Contract(env.cfg.gen7.router, H.abis.GEN7_ROUTER_ABI, env.provider);
  check("[gen7] gen-7 TreasuryRouterV4 admin is the Safe", (await g7.admin()) === env.cfg.gen7.safe, await g7.admin());
  S.gen7Router = g7;
  return S;
}

// ================================================================== area 1: splitter
async function areaSplitter(env, H, S, P, out) {
  const { check, note } = H;
  const sp = env.splitter;
  const D = env.gen7Dest;
  const N = (out.nums.splitter = { runs: [] });

  // ---- destinations: real gen-7 vaults, and what each needs to accept the splitter
  const dests = [["weekly league vault", D.weekly, await sp.weeklyLeagueVault()], ["monthly league treasury", D.monthly, await sp.monthlyLeagueTreasury()], ["recruiter rewards vault", D.recruiter, await sp.recruiterRewardsVault()], ["protocol revenue vault", D.protocol, await sp.protocolRevenueVault()]];
  for (const [lbl, g7, onSplitter] of dests) {
    const code = await env.provider.getCode(g7);
    check(`splitter ${lbl} == the gen-7 router's ${lbl} (real gen-7 contract on the fork)`, g7 === onSplitter && code.length > 2, `${g7} (${(code.length - 2) / 2} bytes)`);
    const why = await callWithValue(env, sp.target, g7, "0x", 10n ** 15n);
    check(`gen-7 ${lbl} accepts plain native from the splitter address with no Safe call (sender not checked)`, why === null, why ?? "accepted");
  }
  const g7c = new ethers.Contract(D.community, ABI.community, env.provider);
  const whyG7c = await callWithValue(env, sp.target, D.community, IFACE.community.encodeFunctionData("depositAirdrop"), 10n ** 15n);
  const whyNew = await callWithValue(env, sp.target, env.community.target, IFACE.community.encodeFunctionData("depositAirdrop"), 10n ** 15n);
  check("gen-7 community vault refuses depositAirdrop from the splitter (onlyRouter: its router is the gen-7 TreasuryRouterV4)", whyG7c?.includes("not router") && (await g7c.router()) === env.cfg.gen7.router, `${whyG7c}; router ${await g7c.router()}`);
  const cv = new ethers.Contract(env.community.target, ABI.community, env.provider);
  check("D8: the gen-8 community vault (gen-7 code, new deployment) has router == splitter, admin == Safe, and accepts depositAirdrop from the splitter", (await cv.router()) === sp.target && (await cv.admin()) === env.A.safe && (await sp.communityRewardsVault()) === env.community.target && whyNew === null, whyNew ?? "accepted");

  // ---- run 1: bonding fees only, linked + unlinked traders (the lower band edge), every router
  const runFrom = { block: (await env.provider.getBlockNumber()) - 0 };
  // the launch tx (creator first buy) is part of run 1: index from the fork block
  runFrom.block = Number(env.forkBlock.number);
  const G1 = S.R / 97n + 1_234_567n;
  const same = [];
  for (const [via, urName] of S.vias) {
    const lbl = via === "ur" ? urName : "direct";
    const o0 = await H.owedAll(env, P);
    const t1 = await H.trade(env, P, { via, urName, wallet: env.W.unl1, buy: true, exactIn: true, amount: G1, limit: 0n });
    const o1 = await H.owedAll(env, P);
    same.push({ lbl, fee: t1.fee, share: t1.creatorShare, dRouter: o1.router - o0.router, dCreator: o1.creator - o0.creator });
    await H.trade(env, P, { via, urName, wallet: env.W.lnk1, buy: true, exactIn: true, amount: S.R / 131n + 7_777n, limit: 0n });
    await H.trade(env, P, { via, urName, wallet: env.W.unl1, buy: false, exactIn: true, amount: t1.userCoin / 3n + 12_345n, limit: 0n });
    await H.trade(env, P, { via, urName, wallet: env.W.lnk1, buy: false, exactIn: false, amount: S.R / 503n + 999n, limit: 10n ** 30n });
  }
  const s0 = same[0];
  check("[ur] the same exact-in buy through every router books the identical fee, creator share and router bucket", same.every((x) => x.fee === s0.fee && x.share === s0.share && x.dRouter === s0.dRouter && x.dCreator === s0.dCreator && x.dRouter === x.fee - x.share), same.map((x) => `${x.lbl}: fee ${x.fee} router +${x.dRouter} creator +${x.dCreator}`).join("; "));

  let rows = await indexRows(env, S, runFrom.block);
  // make sure the per-trade method is short of the band (risk 2) - add small unlinked trades until it is
  let extraTrades = 0;
  for (;;) {
    const agg = aggregateRun(rows);
    const pt = perTradeRun(rows);
    if (pt.rsa < bandsJs(agg.B, agg.G).rsaMin || extraTrades >= 30) break;
    const [via, urName] = S.vias[extraTrades % S.vias.length];
    await H.trade(env, P, { via, urName, wallet: env.W.unl2, buy: true, exactIn: true, amount: 10n ** 15n + BigInt(extraTrades) * 7_919n + 3n, limit: 0n });
    extraTrades++;
    rows = await indexRows(env, S, runFrom.block);
  }
  const r1 = await runSplit(env, H, S, out, { runId: 1n, rows, label: "run 1 (bonding only, linked + unlinked, every router)", expectPerTradeOut: true });
  N.runs.push(r1);

  // ---- band enforcement on run 2 (bonding + graduation + post-graduation, og + linked + unlinked)
  const fromRun2 = r1.block;
  for (const [via, urName] of S.vias) {
    await H.trade(env, P, { via, urName, wallet: env.W.og1, buy: true, exactIn: true, amount: S.R / 89n + 31n, limit: 0n });
    await H.trade(env, P, { via, urName, wallet: env.W.unl2, buy: true, exactIn: false, amount: 1_234_567n * WAD + 89n, limit: S.R });
    await H.trade(env, P, { via, urName, wallet: env.W.og1, buy: false, exactIn: true, amount: 777_777n * WAD + 1n, limit: 0n });
  }
  // graduate (og trader crosses through the first UR), then post-graduation trades through every router
  const [, urCross] = S.vias[1];
  const tg = await H.trade(env, P, { via: "ur", urName: urCross, wallet: env.W.og1, buy: true, exactIn: true, amount: S.R * 2n, limit: 0n });
  check("run 2 setup: the og trader graduates the coin through a UR", tg.graduated !== null, tg.graduated ? `gradFee ${fmt(tg.graduated.gradFee, 9)}` : "");
  for (const [via, urName] of S.vias) {
    await H.trade(env, P, { via, urName, wallet: env.W.lnk1, buy: true, exactIn: true, amount: S.R / 41n + 5n, limit: 0n });
    await H.trade(env, P, { via, urName, wallet: env.W.unl1, buy: false, exactIn: true, amount: 2_000_000n * WAD + 3n, limit: 0n });
  }
  rows = await indexRows(env, S, fromRun2);
  {
    const snap = await H.snapshot(env);
    const paid = await claimForPlan(env);
    const agg = aggregateRun(rows);
    const b = await sp.bands(agg.B, agg.G);
    const [weekly, monthly, rsaMin, rsaMax, squadMax] = b;
    const op = sp.connect(env.W.operator);
    const root = accrualTree(rows).root;
    const tries = [
      ["recruiter + squad + airdrop one wei under the band", [2n, rsaMin - 1n, 0n, 0n], "OutOfBand"],
      ["one wei over the band", [2n, rsaMax + 1n - squadMax, squadMax, 0n], "OutOfBand"],
      ["squad one wei over its 2.5% cap (total inside the band)", [2n, rsaMin - squadMax - 1n, squadMax + 1n, 0n], "OutOfBand"],
      ["a stale run id (1)", [1n, rsaMin, 0n, 0n], "BadRunId"],
      ["a skipped run id (3)", [3n, rsaMin, 0n, 0n], "BadRunId"],
    ];
    for (const [lbl, [rid, rec, sq, air], want] of tries) {
      const why = await revertOf(() => op.route.staticCall(rid, paid, rec, sq, air, root), env.ifaces);
      check(`bands enforced on a real run: ${lbl} reverts ${want}`, why?.includes(want), why);
    }
    const whyStale = await revertOf(() => op.route.staticCall(2n, paid - 1n, rsaMin, 0n, 0n, root), env.ifaces);
    check("a plan made against another paid total reverts PaidMismatch (the run is pinned to the plan)", whyStale?.includes("PaidMismatch"), whyStale);
    // a fee landing after the plan is not swept in: route still sees the planned total, the late fee waits in the hook
    {
      const s2 = await H.snapshot(env);
      const [tot] = await sp.pending();
      await H.trade(env, P, { via: "direct", wallet: env.W.unl1, buy: true, exactIn: true, amount: S.R / 50n, limit: 0n });
      const late = await env.hook.routerOwed();
      const rcL = await (await op.route(2n, paid, rsaMin, 0n, 0n, root, { gasLimit: 2_000_000n })).wait();
      const evL = rcL.logs.map((l) => { try { return sp.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Routed");
      check("a fee landing between the operator's claim and route stays in the hook for the next run (not swept into protocol)", evL.args.run.total === tot && late > 0n && (await env.hook.routerOwed()) >= late, `planned ${fmt(tot, 9)} routed ${fmt(evL.args.run.total, 9)}, late fee ${fmt(late, 9)} left in the hook`);
      // F4: a third party can no longer claim between plan and route; a second claim of our own (operator or Safe)
      // still makes the stale plan revert, and the re-plan routes
      const paidB = await claimForPlan(env);
      await H.trade(env, P, { via: "direct", wallet: env.W.unl1, buy: true, exactIn: true, amount: S.R / 50n, limit: 0n });
      const whyForeign = await revertOf(() => env.hook.connect(env.W.attacker).claimRouter.staticCall(), env.ifaces);
      check("[F4] a third-party claimRouter between plan and route reverts NotRouterCaller (C-M1 / D-L3)", whyForeign?.includes("NotRouterCaller"), whyForeign);
      await (await env.hook.connect(env.W.safe).claimRouter()).wait();
      const why3 = await revertOf(() => op.route.staticCall(3n, paidB, 0n, 0n, 0n, root), env.ifaces);
      const paidC = await claimForPlan(env);
      const [, B3, G3] = await sp.pending();
      const b3 = await sp.bands(B3, G3);
      const ok3 = await revertOf(() => op.route.staticCall(3n, paidC, b3[2], 0n, 0n, root), env.ifaces);
      check("a second claim of our own (the Safe) between plan and route reverts PaidMismatch; the re-plan routes", why3?.includes("PaidMismatch") && ok3 === null, `${why3} / re-plan ${ok3 ?? "ok"}`);
      await H.revert(env, s2);
    }
    const whyAtt = await revertOf(() => sp.connect(env.W.attacker).route.staticCall(2n, paid, rsaMin, 0n, 0n, root), env.ifaces);
    check("a stranger cannot route (NotOperator)", whyAtt?.includes("NotOperator"), whyAtt);
    const lo = await revertOf(() => op.route.staticCall(2n, paid, rsaMin, 0n, 0n, root), env.ifaces);
    const hi = await revertOf(() => op.route.staticCall(2n, paid, rsaMax - squadMax, squadMax, 0n, root), env.ifaces);
    const adm = await revertOf(() => sp.connect(env.W.safe).route.staticCall(2n, paid, 0n, 0n, rsaMin, root), env.ifaces);
    check("exactly at the band edges the run goes through (operator at rsaMin and at rsaMax with the full squad cap; the Safe can run the same bounded route)", lo === null && hi === null && adm === null, `rsaMin ${rsaMin} rsaMax ${rsaMax} squadMax ${squadMax} weekly ${weekly} monthly ${monthly}`);
    await H.revert(env, snap);
  }
  const r2 = await runSplit(env, H, S, out, { runId: 2n, rows, label: "run 2 (bonding + graduation + post-graduation; og, linked, unlinked; every router)" });
  N.runs.push(r2);

  // ---- run 3: post-graduation only (B = G = 0): everything to protocol, the band is [0, 0]
  for (const [via, urName] of S.vias.slice(0, 2)) await H.trade(env, P, { via, urName, wallet: env.W.bot, buy: true, exactIn: true, amount: S.R / 10n, limit: 0n });
  rows = await indexRows(env, S, r2.block);
  {
    const paid3 = await claimForPlan(env);
    const why = await revertOf(() => sp.connect(env.W.operator).route.staticCall(3n, paid3, 1n, 0n, 0n, accrualTree(rows).root), env.ifaces);
    check("post-graduation-only run: any recruiter / squad / airdrop amount is out of band (B = G = 0)", why?.includes("OutOfBand"), why);
  }
  const r3 = await runSplit(env, H, S, out, { runId: 3n, rows, label: "run 3 (post-graduation only)" });
  N.runs.push(r3);
  const paid4 = await claimForPlan(env);
  const whyEmpty = await revertOf(() => sp.connect(env.W.operator).route.staticCall(4n, paid4, 0n, 0n, 0n, ethers.ZeroHash), env.ifaces);
  check("a run with nothing received reverts NothingToRoute (no empty runs)", whyEmpty?.includes("NothingToRoute"), whyEmpty);

  // ---- the aggregate rule always lands in the band; the per-trade floor sum often does not (JS, exact mirror)
  {
    let seed = 0x5eed1234n ^ BigInt(Number(out.targetUsd));
    const rnd = (mod) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) % mod;
    };
    // mirror check against the deployed splitter
    let mirrorOk = true;
    for (let i = 0; i < 25; i++) {
      const B = rnd(10n ** 20n), G = rnd(10n ** 19n);
      const b = await sp.bands(B, G);
      const j = bandsJs(B, G);
      if (b[0] !== j.weekly || b[1] !== j.monthly || b[2] !== j.rsaMin || b[3] !== j.rsaMax || b[4] !== j.squadMax) mirrorOk = false;
    }
    check("JS mirror of MwzFeeSplitter.bands() == on-chain bands() (25 random inputs)", mirrorOk);
    let aggBad = 0, ptBad = 0, runs = 2000;
    for (let i = 0; i < runs; i++) {
      const n = 1 + Number(rnd(40n));
      const rs = [];
      for (let k = 0; k < n; k++) {
        const kind = rnd(10n) === 0n ? 1 : 0;
        const profile = Number(rnd(3n));
        const amount = 1n + rnd(10n ** 16n);
        const t = kind === 0 ? TRADE_BPS[profile] : GRAD_BPS[profile];
        rs.push({ kind, profile, amount, routerPart: amount, rec: (amount * t.rec) / BPS, sq: (amount * t.sq) / BPS, air: (amount * t.air) / BPS });
      }
      const a = aggregateRun(rs);
      const b = bandsJs(a.B, a.G);
      if (a.rsa < b.rsaMin || a.rsa > b.rsaMax || a.squad > b.squadMax || a.recruiter < 0n || a.airdrop < 0n || a.recruiter + a.squad + a.airdrop !== a.rsa) aggBad++;
      const p = perTradeRun(rs);
      if (p.rsa < b.rsaMin || p.rsa > b.rsaMax || p.squad > b.squadMax) ptBad++;
    }
    check("aggregate method in band for 2,000 random runs (1-40 rows, mixed profiles, graduation rows)", aggBad === 0, `aggregate out of band ${aggBad}/${runs}; per-trade floor sums out of band ${ptBad}/${runs}`);
    N.randomRuns = { runs, aggregateOutOfBand: aggBad, perTradeOutOfBand: ptBad };
  }

  // ---- D8 evidence: reusing the gen-7 community vault needs one Safe call and breaks the gen-7 router
  {
    const snap = await H.snapshot(env);
    const sp2 = await env.deployRaw("MwzFeeSplitter", [env.hook.target, env.A.safe, D.weekly, D.monthly, D.recruiter, D.community, D.protocol, env.A.operator]);
    const paused = await S.gen7Router.forwardingPaused();
    const before = await revertOf(() => S.gen7Router.connect(env.W.bot).routeFinalize.staticCall(1, { value: 10n ** 15n }), env.ifaces);
    await S.safeCall("REJECTED OPTION (D8): reuse the gen-7 community vault for gen-8", g7cWith(env, D.community), "setRouter", [sp2.target], { real: true, contractName: "gen-7 CommunityRewardsVault" });
    const after = await revertOf(() => S.gen7Router.connect(env.W.bot).routeFinalize.staticCall(1, { value: 10n ** 15n }), env.ifaces);
    check("D8: pointing the gen-7 community vault at a gen-8 splitter (Safe setRouter) breaks every gen-7 route with an airdrop or squad part", !paused && before === null && after?.includes("airdrop route failed"), `gen-7 routeFinalize(unlinked) before: ${before ?? "ok"}; after: ${after}`);
    // make sp2 the hook's router (48 h timelock) and run it into the real gen-7 community vault. The coin is launched
    // first: after 48 h of fork time the oracle is stale and launches revert (as they would on mainnet).
    const { P: Q } = await H.launchCoin(env, env.W.creator, S.target, 0n, H.consts.FEES, "D8 variant coin");
    S.humanCreator.set(Q.id, env.A.creator);
    await (await env.hook.connect(env.W.safe).proposeTreasuryRouter(sp2.target)).wait();
    await warpTo(env, (await env.hook.routerEta()) + 1n);
    await (await env.hook.connect(env.W.safe).executeTreasuryRouter()).wait();
    const from = await env.provider.getBlockNumber();
    await H.trade(env, Q, { via: "direct", wallet: env.W.unl1, buy: true, exactIn: true, amount: S.R / 7n, limit: 0n });
    await H.trade(env, Q, { via: "direct", wallet: env.W.lnk1, buy: true, exactIn: true, amount: S.R / 9n, limit: 0n });
    const rowsV = await indexRows(env, S, from);
    const bv = await sp2.bands(...(() => { const a = aggregateRun(rowsV); return [a.B, a.G]; })());
    const av = aggregateRun(rowsV, { weekly: bv[0], monthly: bv[1], rsaMin: bv[2], rsaMax: bv[3], squadMax: bv[4] });
    const a0 = await g7c.warzoneAirdropBalance();
    const q0 = await g7c.squadPoolBalance();
    const paidV = await claimForPlan(env, sp2);
    const rc = await (await sp2.connect(env.W.operator).route(1n, paidV, av.recruiter, av.squad, av.airdrop, accrualTree(rowsV).root, { gasLimit: 2_000_000n })).wait();
    check("D8 variant (fork only, not the plan): once the Safe has set its router, a splitter routes airdrop / squad into the gen-7 community vault", rc.status === 1 && (await g7c.warzoneAirdropBalance()) - a0 === av.airdrop && (await g7c.squadPoolBalance()) - q0 === av.squad && av.airdrop > 0n, `airdrop +${fmt(av.airdrop, 9)} squad +${fmt(av.squad, 9)}`);
    await H.revert(env, snap);
  }
  out.nums.splitter.safeCallsForDeposits = "none: the four gen-7 vaults accept plain native from any sender; the airdrop / squad pot is the new gen-8 community vault (router = splitter at deploy)";
}

function g7cWith(env, addr) {
  return new ethers.Contract(addr, ABI.community, env.provider);
}

/** Claim-first ordering (route never claims): the operator claims the hook bucket if anything is owed, then plans
 *  against the cumulative paid ledger, which route() must see unchanged (expectedPaid). */
async function claimForPlan(env, splitter = env.splitter) {
  if ((await env.hook.treasuryRouter()) === splitter.target && (await env.hook.routerOwed()) > 0n) await (await env.hook.connect(env.W.operator).claimRouter()).wait();
  return (await env.hook.routerPaid(splitter.target)).amount;
}

/** Computes a run the way the indexer will, checks it against the hook, routes it, and proves where every wei went. */
async function runSplit(env, H, S, out, { runId, rows, label, expectPerTradeOut = false }) {
  const { check, note } = H;
  const sp = env.splitter;
  const paid = await claimForPlan(env);
  const [pTot, pB, pG] = await sp.pending();
  const owed = await env.hook.routerOwed();
  const hookB = await env.hook.pendingBondingFees();
  const hookG = await env.hook.pendingGradFees();
  const agg = aggregateRun(rows);
  check(`${label}: indexer sums == the hook's own run totals (B = sum of HookFee.fee with graduated == false, G = sum of Graduated.gradFeeNative, total = sum of router parts)`, agg.B === pB + hookB && agg.G === pG + hookG && agg.total === pTot + owed, `B ${fmt(agg.B)} G ${fmt(agg.G)} total ${fmt(agg.total)}; rows ${rows.length}`);
  const b = await sp.bands(agg.B, agg.G);
  const bands = { weekly: b[0], monthly: b[1], rsaMin: b[2], rsaMax: b[3], squadMax: b[4] };
  const a = aggregateRun(rows, bands);
  const pt = perTradeRun(rows);
  const tree = accrualTree(rows);
  const op = sp.connect(env.W.operator);
  const ptWhy = await revertOf(() => op.route.staticCall(runId, paid, pt.recruiter, pt.squad, pt.airdrop, tree.root), env.ifaces);
  const ptIn = pt.rsa >= bands.rsaMin && pt.rsa <= bands.rsaMax && pt.squad <= bands.squadMax;
  if (expectPerTradeOut) {
    check(`${label}: audit risk 2 reproduced: summing per-trade floors lands ${bands.rsaMin - pt.rsa} wei under the band and the run reverts OutOfBand`, !ptIn && pt.rsa < bands.rsaMin && ptWhy?.includes("OutOfBand"), `per-trade rsa ${pt.rsa} vs rsaMin ${bands.rsaMin} (${rows.length} rows): ${ptWhy}`);
  } else {
    note(`${label}: per-trade floor sums ${ptIn ? "happen to land inside" : "land OUTSIDE"} the band here (rsa ${pt.rsa}, band ${bands.rsaMin}..${bands.rsaMax})${ptWhy ? ": " + ptWhy : ""}`);
  }
  check(`${label}: the aggregate method lands inside the band`, a.rsa >= bands.rsaMin && a.rsa <= bands.rsaMax && a.squad <= bands.squadMax && a.recruiter >= 0n && a.airdrop >= 0n, `recruiter ${fmt(a.recruiter, 9)} squad ${fmt(a.squad, 9)} airdrop ${fmt(a.airdrop, 9)} (band ${fmt(bands.rsaMin, 9)}..${fmt(bands.rsaMax, 9)})`);

  const D = env.gen7Dest;
  const watch = { weekly: D.weekly, monthly: D.monthly, recruiter: D.recruiter, protocol: D.protocol, community: env.community.target, splitter: sp.target };
  const bal0 = {};
  for (const [k, v] of Object.entries(watch)) bal0[k] = await env.provider.getBalance(v);
  const cv = new ethers.Contract(env.community.target, ABI.community, env.provider);
  const air0 = await cv.warzoneAirdropBalance();
  const sq0 = await cv.squadPoolBalance();
  const tx = await op.route(runId, paid, a.recruiter, a.squad, a.airdrop, tree.root, { gasLimit: 2_000_000n });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return sp.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Routed");
  const run = ev.args.run;
  const protocol = run.total - bands.weekly - bands.monthly - a.recruiter - a.squad - a.airdrop;
  check(`${label}: Routed(runId ${runId}) carries the accrualRoot of the indexer's rows and the exact amounts`, ev.args.runId === runId && ev.args.accrualRoot === tree.root && ev.args.caller === env.A.operator && run.total === agg.total && run.bondingFees === agg.B && run.gradFees === agg.G && run.weeklyLeague === bands.weekly && run.monthlyLeague === bands.monthly && run.recruiter === a.recruiter && run.squad === a.squad && run.airdrop === a.airdrop && run.protocol === protocol, `root ${tree.root.slice(0, 18)}.. gas ${rc.gasUsed}`);
  check(`${label}: league is exactly 37.5% of B, split 30 / 70 weekly / monthly`, run.weeklyLeague + run.monthlyLeague === (agg.B * 3750n) / BPS && run.weeklyLeague === (((agg.B * 3750n) / BPS) * 3000n) / BPS);
  // where every wei went (call trace) and what each vault holds
  const calls = await valueCalls(env, rc.hash);
  const fromSp = calls.filter((c) => c.from === lc(sp.target));
  const sent = (to, sel) => fromSp.filter((c) => c.to === lc(to) && (!sel || c.sel === sel)).reduce((s, c) => s + c.value, 0n);
  const selAir = IFACE.community.getFunction("depositAirdrop").selector;
  const selSq = IFACE.community.getFunction("depositSquadPool").selector;
  const arrived = {
    weekly: sent(D.weekly),
    monthly: sent(D.monthly),
    recruiter: sent(D.recruiter),
    protocol: sent(D.protocol),
    airdrop: sent(env.community.target, selAir),
    squad: sent(env.community.target, selSq),
  };
  const bal1 = {};
  for (const [k, v] of Object.entries(watch)) bal1[k] = await env.provider.getBalance(v);
  const onward = calls.filter((c) => c.from === lc(D.protocol)).map((c) => `${fmt(c.value, 9)} -> ${c.to.slice(0, 10)}`);
  const protoDelta = bal1.protocol - bal0.protocol + calls.filter((c) => c.from === lc(D.protocol)).reduce((s, c) => s + c.value, 0n);
  const ok =
    arrived.weekly === run.weeklyLeague && bal1.weekly - bal0.weekly === run.weeklyLeague &&
    arrived.monthly === run.monthlyLeague && bal1.monthly - bal0.monthly === run.monthlyLeague &&
    arrived.recruiter === run.recruiter && bal1.recruiter - bal0.recruiter === run.recruiter &&
    arrived.protocol === run.protocol && protoDelta === run.protocol &&
    arrived.airdrop === run.airdrop && arrived.squad === run.squad && bal1.community - bal0.community === run.airdrop + run.squad &&
    (await cv.warzoneAirdropBalance()) - air0 === run.airdrop && (await cv.squadPoolBalance()) - sq0 === run.squad &&
    fromSp.every((c) => c.error === null) && fromSp.reduce((s, c) => s + c.value, 0n) === run.total;
  check(`${label}: every amount arrives in its real gen-7 vault (call trace and balances), airdrop / squad tracked by the community vault`, ok, `weekly ${fmt(arrived.weekly, 9)} monthly ${fmt(arrived.monthly, 9)} recruiter ${fmt(arrived.recruiter, 9)} protocol ${fmt(arrived.protocol, 9)}${onward.length ? " (protocol vault forwards: " + onward.join(", ") + ")" : ""} airdrop ${fmt(arrived.airdrop, 9)} squad ${fmt(arrived.squad, 9)}`);
  const [qT, qB, qG] = await sp.pending();
  const claims = await env.pm.balanceOf(env.hook.target, 0n);
  check(`${label}: nothing stuck: splitter balance 0, hook router bucket 0, pending() == 0, hook claims == creator ledgers`, bal1.splitter === 0n && (await env.hook.routerOwed()) === 0n && qT === 0n && qB === 0n && qG === 0n && claims === (await sumOtherCreatorOwed(env, S)), `claims ${fmt(claims, 9)}`);
  const whyAgain = await revertOf(() => op.route.staticCall(runId, paid, a.recruiter, a.squad, a.airdrop, tree.root), env.ifaces);
  check(`${label}: replaying the same run id reverts BadRunId`, whyAgain?.includes("BadRunId"), whyAgain);
  return {
    runId: Number(runId), label, rows: rows.length, gas: Number(rc.gasUsed), block: rc.blockNumber,
    total: run.total.toString(), bondingFees: run.bondingFees.toString(), gradFees: run.gradFees.toString(),
    weeklyLeague: run.weeklyLeague.toString(), monthlyLeague: run.monthlyLeague.toString(), recruiter: run.recruiter.toString(), squad: run.squad.toString(), airdrop: run.airdrop.toString(), protocol: run.protocol.toString(),
    perTrade: { recruiter: pt.recruiter.toString(), squad: pt.squad.toString(), airdrop: pt.airdrop.toString(), inBand: ptIn, revert: ptWhy },
    bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, v.toString()])),
    accrualRoot: tree.root,
    protocolOnward: onward,
  };
}

/** Sum of creator ledgers of every pool the hook launched on this fork (PoolLaunched events). */
async function sumOtherCreatorOwed(env, S) {
  const logs = await env.provider.getLogs({ address: env.hook.target, fromBlock: Number(env.forkBlock.number) + 1, toBlock: "latest" });
  const ids = new Set();
  for (const l of logs) {
    try {
      const e = env.hook.interface.parseLog(l);
      if (e?.name === "PoolLaunched") ids.add(e.args.id);
    } catch {}
  }
  let s = 0n;
  for (const id of ids) s += await env.hook.creatorOwed(id);
  return s;
}

// ================================================================== area 2: creator-choice vault
async function areaChoiceVault(env, H, S, out) {
  const { check, note } = H;
  const v = env.vault;
  const N = (out.nums.choice = {});
  // ---- the holder distributor: gen-7 RewardDistributor code as the gen-8 stand-in (D8)
  const g7d = new ethers.Contract(env.cfg.gen7.holderDistributor, ABI.distributor, env.provider);
  const g7dOp = await g7d.batchOperator();
  check("D8: the gen-7 holder distributor has ONE batch operator (the gen-7 vault), so gen-8 needs its own distributor", g7dOp === env.cfg.gen7.vault && (await g7d.owner()) === env.cfg.gen7.safe, `gen-7 distributor ${env.cfg.gen7.holderDistributor} batchOperator ${g7dOp}`);
  const dist = await env.deployRaw("RewardDistributor", [env.A.safe]);
  const distC = new ethers.Contract(dist.target, ABI.distributor, env.provider);
  // caps: the live gen-7 vault's limits(), or the gen-7 deployment inputs when the Safe has not set them yet
  const lim = await new ethers.Contract(env.cfg.gen7.vault, ABI.gen7Vault, env.provider).limits();
  const live = lim[1] > 0n;
  const caps = live ? { maxBuyPerTx: lim[1], maxBuybackPerCoinWeek: lim[2], minBuyInterval: lim[3], maxImpactBps: lim[4], maxHolderBatchPerWeek: lim[5] } : GEN7_CAPS[env.name];
  note(`choice-vault caps copied from ${live ? "the live gen-7 vault limits()" : "the gen-7 deployment inputs (live gen-7 vault limits() still zero)"}: per tx ${fmt(caps.maxBuyPerTx, 3)}, per coin-week ${fmt(caps.maxBuybackPerCoinWeek, 3)}, interval ${caps.minBuyInterval}s, impact ${caps.maxImpactBps} bps, holder batches per week ${fmt(caps.maxHolderBatchPerWeek, 3)}`);
  N.caps = Object.fromEntries(Object.entries(caps).map(([k, x]) => [k, x.toString()]));
  N.capsSource = live ? "gen-7 vault limits()" : "gen-7 deployment inputs";
  await S.safeCall("B: pin the gen-8 holder distributor in the choice vault (once)", v, "setHolderDistributorOnce", [dist.target], { contractName: "MwzCreatorChoiceVault" });
  await S.safeCall("B: choice-vault operator", v, "setOperator", [env.A.operator, false], { contractName: "MwzCreatorChoiceVault" });
  await S.safeCall("B: choice-vault caps (copied from gen-7)", v, "setCaps", [caps.maxBuyPerTx, caps.maxBuybackPerCoinWeek, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek], { contractName: "MwzCreatorChoiceVault" });
  await S.safeCall("B: the choice vault is the distributor's batch operator", distC, "setBatchOperator", [v.target], { contractName: "gen-8 holder distributor (RewardDistributor code)" });

  // ---- coins: keep, holders, split 40%, buyback
  const target = S.target;
  const coins = {};
  for (const [k, choice, pct] of [["keep", 1, 0], ["holders", 2, 0], ["split", 3, 40], ["buyback", 4, 0]]) {
    const { P, ev } = await H.launchCoin(env, env.W.creator2, target, S.R / 40n, H.consts.FEES, `Choice ${k}`, choice, pct);
    S.humanCreator.set(P.id, env.A.creator2);
    coins[k] = P;
    const cfg = await v.cfg(P.id);
    const hc = (await env.hook.pools(P.id)).creator;
    if (choice === 1) check("keep coin: the hook pays the human creator directly; the vault holds no config for it", ev.args.hookCreator === env.A.creator2 && hc === env.A.creator2 && cfg.choice === 0n);
    else check(`${k} coin: Launched.hookCreator == choice vault, hook creator == vault, vault records the human creator and choice ${choice}${pct ? " / " + pct + "%" : ""}`, ev.args.hookCreator === v.target && hc === v.target && cfg.creator === env.A.creator2 && Number(cfg.choice) === choice && Number(cfg.creatorPct) === pct && cfg.token === P.token);
  }
  // the launch window: a fresh buyback coin cannot buy back in its first 60 s (tested now: later warps would make
  // the oracle stale for new launches, as on mainnet)
  {
    const { P: Q } = await H.launchCoin(env, env.W.creator2, target, S.R / 40n, H.consts.FEES, "Choice buyback 2", 4, 0);
    await (await v.connect(env.W.bot).pull(Q.id)).wait();
    const whyWin = await revertOf(() => v.connect(env.W.operator).buyback.staticCall(Q.id, 1n), env.ifaces);
    check("buyback inside the 60 s launch window reverts CurveState", whyWin?.includes("CurveState"), whyWin);
  }
  // past the launch window; trades on every choice coin through every router by several holders
  await warpTo(env, coins.buyback.launchTs + 61n);
  const traders = [env.W.lnk1, env.W.unl1, env.W.og1, env.W.unl2, env.W.holderX];
  for (const k of ["keep", "holders", "split", "buyback"]) {
    const P = coins[k];
    const o0 = await env.hook.creatorOwed(P.id);
    let shares = 0n;
    let i = 0;
    for (const [via, urName] of S.vias) {
      const w = traders[i++ % traders.length];
      const tb = await H.trade(env, P, { via, urName, wallet: w, buy: true, exactIn: true, amount: S.R / 60n + BigInt(i), limit: 0n });
      const ts = await H.trade(env, P, { via, urName, wallet: w, buy: false, exactIn: true, amount: tb.userCoin / 4n, limit: 0n });
      shares += tb.creatorShare + ts.creatorShare;
    }
    check(`[ur] ${k} coin: trades through every router accrue exactly their creator shares to the coin's creator ledger`, (await env.hook.creatorOwed(P.id)) - o0 === shares, `+${fmt(shares, 9)} over ${S.vias.length * 2} trades`);
  }
  // keep: not the vault's business
  const whyKeep = await revertOf(() => v.connect(env.W.attacker).pull.staticCall(coins.keep.id), env.ifaces);
  check("keep coin: pull reverts WrongChoice (the creator claims from the hook)", whyKeep?.includes("WrongChoice"), whyKeep);

  // ---- pull (permissionless) for holders / split / buyback, credited by the choice
  const pulled = {};
  for (const k of ["holders", "split", "buyback"]) {
    const P = coins[k];
    const owed = await env.hook.creatorOwed(P.id);
    const b0 = await env.provider.getBalance(v.target);
    const [c0, h0, bb0] = [await v.creatorBalance(P.id), await v.holderBalance(P.id), await v.buybackBalance(P.id)];
    const rc = await (await v.connect(env.W.attacker).pull(P.id)).wait();
    const [c1, h1, bb1] = [await v.creatorBalance(P.id), await v.holderBalance(P.id), await v.buybackBalance(P.id)];
    const toC = k === "split" ? (owed * 40n) / 100n : 0n;
    const exp = k === "holders" ? [0n, owed, 0n] : k === "split" ? [toC, owed - toC, 0n] : [0n, 0n, owed];
    check(`${k} coin: anyone pulls exactly the hook's creator ledger into the vault, credited by the choice`, (await env.hook.creatorOwed(P.id)) === 0n && (await env.provider.getBalance(v.target)) - b0 === owed && c1 - c0 === exp[0] && h1 - h0 === exp[1] && bb1 - bb0 === exp[2], `pulled ${fmt(owed, 9)} gas ${rc.gasUsed}`);
    pulled[k] = owed;
  }
  const invariant = async () => (await env.provider.getBalance(v.target)) === (await v.totalLiabilities());
  check("vault balance == totalLiabilities after the pulls", await invariant());
  const whyNothing = await revertOf(() => v.pull.staticCall(coins.holders.id), env.ifaces);
  check("pull with nothing owed reverts (hook NothingOwed)", whyNothing?.includes("NothingOwed"), whyNothing);
  // split: the human creator claims their 40% to any address; nobody else can
  {
    const id = coins.split.id;
    const amt = await v.creatorBalance(id);
    const whyAtt = await revertOf(() => v.connect(env.W.attacker).claimCreatorFees.staticCall(id, env.A.attacker), env.ifaces);
    const pb = await env.provider.getBalance(env.A.payee);
    await (await v.connect(env.W.creator2).claimCreatorFees(id, env.A.payee)).wait();
    check("split coin: the human creator claims exactly the 40% part to another address; strangers revert NotCreator", (await env.provider.getBalance(env.A.payee)) - pb === amt && amt > 0n && whyAtt?.includes("NotCreator") && (await invariant()), `${fmt(amt, 9)}; ${whyAtt}`);
  }

  // ---- weekly holder batch (holders + split coins in one batch), through the distributor stand-in
  {
    const census = async (P) => {
      const logs = await env.provider.getLogs({ address: P.token, topics: [IFACE.erc20Events.getEvent("Transfer").topicHash], fromBlock: Number(env.forkBlock.number) + 1, toBlock: "latest" });
      const bal = new Map();
      for (const l of logs) {
        const e = IFACE.erc20Events.parseLog(l);
        bal.set(lc(e.args.from), (bal.get(lc(e.args.from)) ?? 0n) - e.args.value);
        bal.set(lc(e.args.to), (bal.get(lc(e.args.to)) ?? 0n) + e.args.value);
      }
      const excl = new Set([env.cfg.pm, env.hook.target, DEAD, env.launcher.target, env.reserveLock.target, env.escrow.target, v.target, ethers.ZeroAddress].map(lc));
      const rows = [...bal.entries()].filter(([a, b]) => b > 0n && !excl.has(a));
      return rows;
    };
    const plan = new Map();
    const perCoin = [];
    for (const k of ["holders", "split"]) {
      const P = coins[k];
      const hb = await v.holderBalance(P.id);
      const holders = await census(P);
      // check the census against live balances
      let live = true;
      for (const [a, b] of holders) if ((await P.coin.balanceOf(a)) !== b) live = false;
      const sum = holders.reduce((s, [, b]) => s + b, 0n);
      let given = 0n;
      const sorted = holders.sort((x, y) => (x[1] > y[1] ? -1 : 1));
      for (const [a, b] of sorted) {
        const share = (hb * b) / sum;
        given += share;
        plan.set(a, (plan.get(a) ?? 0n) + share);
      }
      plan.set(sorted[0][0], plan.get(sorted[0][0]) + (hb - given)); // rounding remainder to the largest holder
      perCoin.push([P.id, hb]);
      check(`holder census for the ${k} coin from Transfer logs == live balances; excluded: PoolManager, hook, 0xdEaD, launcher, reserve lock, escrow, vault`, live && holders.length >= 3, `${holders.length} holders, ${fmt(sum, 0)} coins`);
    }
    const total = perCoin.reduce((s, [, a]) => s + a, 0n);
    const entries = [...plan.entries()].map(([a, amt]) => ({ a: ethers.getAddress(a), amt, leaf: ozLeaf(["address", "uint256"], [ethers.getAddress(a), amt]) }));
    const tree = merkle(entries.map((e) => e.leaf).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)));
    const batchId = ethers.id(`gen8-holders-${env.name}-${out.targetUsd}-week-1`);
    const t0 = await now(env);
    const deadline = t0 + 30n * 86400n;
    const opV = v.connect(env.W.operator);
    // a batch above the weekly cap is refused (cap tightened by the Safe for the test, then restored)
    await S.safeCall("test only", v, "setCaps", [caps.maxBuyPerTx, caps.maxBuybackPerCoinWeek, caps.minBuyInterval, caps.maxImpactBps, total - 1n], { record: false });
    const whyCap = await revertOf(() => opV.proposeHolderBatch.staticCall(batchId, tree.root, deadline, perCoin.map((x) => x[0]), perCoin.map((x) => x[1])), env.ifaces);
    await S.safeCall("test only", v, "setCaps", [caps.maxBuyPerTx, caps.maxBuybackPerCoinWeek, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek], { record: false });
    check("holder batch above the weekly cap reverts CapExceeded", whyCap?.includes("CapExceeded"), whyCap);
    const whyAttP = await revertOf(() => v.connect(env.W.attacker).proposeHolderBatch.staticCall(batchId, tree.root, deadline, perCoin.map((x) => x[0]), perCoin.map((x) => x[1])), env.ifaces);
    check("only the operator proposes holder batches", whyAttP?.includes("OnlyOperator"), whyAttP);
    await (await opV.proposeHolderBatch(batchId, tree.root, deadline, perCoin.map((x) => x[0]), perCoin.map((x) => x[1]))).wait();
    check("proposed: holder balances moved into the batch, liabilities unchanged until execution", (await v.holderBalance(coins.holders.id)) === 0n && (await v.holderBalance(coins.split.id)) === 0n && (await invariant()));
    await S.safeCall("per batch: authorize the batch on the distributor (max = batch total)", distC, "authorizeBatch", [batchId, total, t0, t0 + 8n * 86400n], { contractName: "gen-8 holder distributor (RewardDistributor code)" });
    const whyUnappr = await revertOf(() => opV.executeHolderBatch.staticCall(batchId), env.ifaces);
    await S.safeCall("per batch: approve the exact root, total and claim deadline in the choice vault (F5)", v, "approveHolderBatch", [batchId, tree.root, total, deadline], { contractName: "MwzCreatorChoiceVault" });
    const whyEarly = await revertOf(() => opV.executeHolderBatch.staticCall(batchId), env.ifaces);
    check("execute before approval reverts NotApproved; before the 24 h delay reverts TooSoon", whyUnappr?.includes("NotApproved") && whyEarly?.includes("TooSoon"), `${whyUnappr} / ${whyEarly}`);
    await warpTo(env, t0 + 86400n + 5n);
    const db0 = await env.provider.getBalance(dist.target);
    const rcX = await (await opV.executeHolderBatch(batchId)).wait();
    const bt = await distC.batches(batchId);
    check("executed after 24 h: the distributor holds the batch (root, total), vault liabilities down by the total", bt.exists && bt.merkleRoot === tree.root && bt.totalFunded === total && (await env.provider.getBalance(dist.target)) - db0 === total && (await invariant()), `total ${fmt(total, 9)} gas ${rcX.gasUsed}`);
    // holders claim (all but the last one, whose part is recovered after the deadline)
    let claimedAll = true;
    const last = entries[entries.length - 1];
    for (const e of entries.slice(0, -1)) {
      const w = Object.entries(env.W).find(([, x]) => lc(x.signer?.address ?? "") === lc(e.a))?.[1];
      if (!w) {
        claimedAll = false;
        continue;
      }
      const b0 = await env.provider.getBalance(e.a);
      const rc = await (await distC.connect(w).claim(batchId, e.amt, tree.proof(e.leaf))).wait();
      const got = (await env.provider.getBalance(e.a)) - b0 + rc.gasUsed * rc.gasPrice;
      if (got !== e.amt) claimedAll = false;
    }
    const firstW = Object.entries(env.W).find(([, x]) => lc(x.signer?.address ?? "") === lc(entries[0].a))?.[1];
    const whyTwice = await revertOf(() => distC.connect(firstW).claim.staticCall(batchId, entries[0].amt, tree.proof(entries[0].leaf)), [new ethers.Interface(["error AlreadyClaimed(bytes32,address)", "error InvalidProof()"])]);
    const whyStranger = await revertOf(() => distC.connect(env.W.attacker).claim.staticCall(batchId, entries[0].amt, tree.proof(entries[0].leaf)), [new ethers.Interface(["error AlreadyClaimed(bytes32,address)", "error InvalidProof()"])]);
    check("holders claim exactly their Merkle amounts; a second claim and a stranger's claim revert", claimedAll && !!whyTwice && !!whyStranger, `${entries.length - 1} claims; ${whyTwice} / ${whyStranger}`);
    // gen-7 E19: unclaimed recovered by the Safe after the deadline is credited back to the same coin's holders
    await warpTo(env, deadline + 1n);
    const sb0 = await env.provider.getBalance(env.A.safe);
    const rcR = await S.safeCall("after the claim deadline: recover unclaimed to the Safe", distC, "recoverUnclaimed", [batchId, env.A.safe], { contractName: "gen-8 holder distributor (RewardDistributor code)" });
    const recovered = (await env.provider.getBalance(env.A.safe)) - sb0 + rcR.gasUsed * rcR.gasPrice;
    const hb0 = await v.holderBalance(coins.holders.id);
    await S.safeCall("then credit it back to the same coin's holders (E19)", v, "creditUnclaimedHolders", [[coins.holders.id], [recovered]], { value: recovered, contractName: "MwzCreatorChoiceVault" });
    check("unclaimed part recovered after the deadline and re-credited to the coin's holders (E19)", recovered === last.amt && (await v.holderBalance(coins.holders.id)) - hb0 === recovered && (await invariant()), fmt(recovered, 9));
    // veto: a proposed batch vetoed by the Safe returns every amount; the week counter frees up
    const hb = await v.holderBalance(coins.holders.id);
    const vetoId = ethers.id(`gen8-holders-${env.name}-${out.targetUsd}-veto`);
    await (await opV.proposeHolderBatch(vetoId, tree.root, deadline + 30n * 86400n, [coins.holders.id], [hb])).wait();
    const used = await v.holderProposedInWeek();
    await S.safeCall("Safe veto (not part of the batch)", v, "vetoHolderBatch", [vetoId], { record: false });
    check("veto returns the batch to the coin's holder balance and frees the weekly cap", (await v.holderBalance(coins.holders.id)) === hb && (await v.holderProposedInWeek()) === used - hb && (await invariant()));
    N.holderBatch = { coins: perCoin.length, holders: entries.length, total: total.toString(), executeGas: Number(rcX.gasUsed) };
  }

  // ---- buyback in our own pool, coins to 0xdEaD; every guard
  {
    const P = coins.buyback;
    const id = P.id;
    const opV = v.connect(env.W.operator);
    // volume so the buyback balance is worth testing (round trips by the bot)
    for (let i = 0; i < 6; i++) {
      const [via, urName] = S.vias[i % S.vias.length];
      const tb = await H.trade(env, P, { via, urName, wallet: env.W.bot, buy: true, exactIn: true, amount: S.R / 5n, limit: 0n });
      await H.trade(env, P, { via, urName, wallet: env.W.bot, buy: false, exactIn: true, amount: tb.userCoin, limit: 0n });
    }
    await (await v.connect(env.W.bot).pull(id)).wait();
    const bal = await v.buybackBalance(id);
    note(`buyback balance after volume: ${fmt(bal, 9)}`);
    // wrong coin / stranger / paused operator
    const whyWrong = await revertOf(() => opV.buyback.staticCall(coins.holders.id, 1n), env.ifaces);
    const whyAtt = await revertOf(() => v.connect(env.W.attacker).buyback.staticCall(id, 1n), env.ifaces);
    await S.safeCall("test only", v, "setOperator", [env.A.operator, true], { record: false });
    const whyPaused = await revertOf(() => opV.buyback.staticCall(id, 1n), env.ifaces);
    await S.safeCall("test only", v, "setOperator", [env.A.operator, false], { record: false });
    check("buyback guards: a non-buyback coin (WrongChoice), a stranger and a paused operator (OnlyOperator) revert", whyWrong?.includes("WrongChoice") && whyAtt?.includes("OnlyOperator") && whyPaused?.includes("OnlyOperator"), `${whyWrong} / ${whyAtt} / ${whyPaused}`);
    const whyOver = await revertOf(() => opV.buyback.staticCall(id, bal + 1n), env.ifaces);
    const whyTx = await revertOf(() => opV.buyback.staticCall(id, caps.maxBuyPerTx + 1n), env.ifaces);
    check("buyback above the coin's buyback balance reverts Insufficient; above the per-tx cap reverts (Insufficient or CapExceeded, whichever binds first)", whyOver?.includes("Insufficient") && (whyTx?.includes("CapExceeded") || whyTx?.includes("Insufficient")), `${whyOver} / ${whyTx}`);
    // a small buyback fills completely: coins to 0xdEaD, fee paid like any trade, creator share back to the vault
    const small = bal / 50n;
    const s0 = await H.slot0(env, P);
    const dead0 = await P.coin.balanceOf(DEAD);
    const owed0 = await env.hook.creatorOwed(id);
    const rc1 = await (await opV.buyback(id, small, { gasLimit: 3_000_000n })).wait();
    const e1 = rc1.logs.map((l) => { try { return v.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Buyback");
    const hf = rc1.logs.map((l) => { try { return env.hook.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "HookFee");
    const s1 = await H.slot0(env, P);
    const priceMoveBps = Number(((s0.sqrtP * s0.sqrtP - s1.sqrtP * s1.sqrtP) * 1_000_000n) / (s0.sqrtP * s0.sqrtP)) / 100;
    check("buyback (small): fills fully in our pool, coins land at 0xdEaD, pays the 2% hook fee, its creator share accrues back to the vault", e1 && e1.args.nativeSpent === small && (await P.coin.balanceOf(DEAD)) - dead0 === e1.args.coinsBurned && hf.args.swapSender === v.target && hf.args.feeBps === 200n && (await env.hook.creatorOwed(id)) - owed0 === hf.args.creatorShare && (await invariant()), `spent ${fmt(small, 9)} burned ${fmt(e1?.args.coinsBurned ?? 0n, 0)} coins, price moved ${priceMoveBps.toFixed(3)} bps, gas ${rc1.gasUsed}`);
    N.buybackSmall = { spent: small.toString(), burned: e1?.args.coinsBurned.toString(), gas: Number(rc1.gasUsed) };
    const whySoon = await revertOf(() => opV.buyback.staticCall(id, small), env.ifaces);
    check("a second buyback inside the 6 h interval reverts TooSoon", whySoon?.includes("TooSoon"), whySoon);
    // impact cap: a large buyback stops at the price limit (partial fill), the rest is credited back
    await warpTo(env, (await now(env)) + caps.minBuyInterval + 1n);
    const big = minB(await v.buybackBalance(id), caps.maxBuyPerTx);
    const s2 = await H.slot0(env, P);
    const lim = (s2.sqrtP * TM.isqrt(BPS * 10n ** 36n)) / TM.isqrt((BPS + caps.maxImpactBps) * 10n ** 36n);
    const bb0 = await v.buybackBalance(id);
    const rc2 = await (await opV.buyback(id, big, { gasLimit: 3_000_000n })).wait();
    const e2 = rc2.logs.map((l) => { try { return v.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Buyback");
    const s3 = await H.slot0(env, P);
    const partial = e2.args.nativeSpent < big;
    const impact = Number(((s2.sqrtP * s2.sqrtP - s3.sqrtP * s3.sqrtP) * 10n ** 8n) / (s2.sqrtP * s2.sqrtP)) / 1e4;
    check(`buyback (large, ${fmt(big, 6)}): ${partial ? "stops exactly at the 50 bps price limit, unfilled part credited back" : "fully filled inside the impact cap"}`, (partial ? s3.sqrtP === lim : s3.sqrtP >= lim) && bb0 - (await v.buybackBalance(id)) === e2.args.nativeSpent && (await invariant()), `spent ${fmt(e2.args.nativeSpent, 9)} of ${fmt(big, 9)}, price impact ${impact.toFixed(2)} bps (cap ${caps.maxImpactBps}), gas ${rc2.gasUsed}`);
    N.buybackLarge = { asked: big.toString(), spent: e2.args.nativeSpent.toString(), burned: e2.args.coinsBurned.toString(), impactBps: impact, partial, gas: Number(rc2.gasUsed) };
    // weekly cap per coin
    await warpTo(env, (await now(env)) + caps.minBuyInterval + 1n);
    const spentWeek = await v.buybackSpentInWeek(id);
    await S.safeCall("test only", v, "setCaps", [caps.maxBuyPerTx, spentWeek + 1n, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek], { record: false });
    const whyWeek = await revertOf(() => opV.buyback.staticCall(id, 2n), env.ifaces);
    await S.safeCall("test only", v, "setCaps", [caps.maxBuyPerTx, caps.maxBuybackPerCoinWeek, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek], { record: false });
    check("buyback over the per-coin weekly cap reverts CapExceeded", whyWeek?.includes("CapExceeded"), whyWeek);
    // 95% curve guard: a buyback may never take A past 95% of its native target (it can never graduate a coin)
    const st = await env.hook.pools(id);
    const sqrtStart = TM.getSqrtRatioAtTick(Number(st.tickStart));
    const tgt = amount0Delta(st.sqrtGrad, sqrtStart, st.liqA, false);
    const raisedAt = (sq) => (sq >= sqrtStart ? 0n : amount0Delta(sq < st.sqrtGrad ? st.sqrtGrad : sq, sqrtStart, st.liqA, false));
    const bbNow = await v.buybackBalance(id);
    const x = minB(bbNow, caps.maxBuyPerTx) / 2n;
    let r0 = raisedAt((await H.slot0(env, P)).sqrtP);
    const goal = (tgt * 9500n) / BPS - x / 2n;
    if (goal > r0) await H.trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: ((goal - r0) * (BPS + 200n)) / BPS, limit: 0n });
    r0 = raisedAt((await H.slot0(env, P)).sqrtP);
    const whyCurve = await revertOf(() => opV.buyback.staticCall(id, x), env.ifaces);
    check("buyback that would take A past 95% of its native target reverts CurveState (a buyback can never graduate a coin)", (r0 + x) * BPS > tgt * 9500n && r0 * BPS < tgt * 9500n && whyCurve?.includes("CurveState"), `raised ${(Number((r0 * 10000n) / tgt) / 100).toFixed(2)}% of target, buyback ${fmt(x, 9)}: ${whyCurve}`);
    // after graduation the guard is gone
    await H.trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: true, amount: S.R, limit: 0n });
    check("buyback coin graduated by a trader", (await env.hook.pools(id)).graduated);
    const rc3 = await (await opV.buyback(id, x, { gasLimit: 3_000_000n })).wait();
    const e3 = rc3.logs.map((l) => { try { return v.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Buyback");
    check("after graduation the buyback works (no curve guard), coins to 0xdEaD, invariant holds", !!e3 && e3.args.coinsBurned > 0n && (await invariant()), `spent ${fmt(e3?.args.nativeSpent ?? 0n, 9)}`);
    const whyRescue = await revertOf(() => v.connect(env.W.safe).rescueExcessNative.staticCall(env.A.safe, 1n), env.ifaces);
    check("rescue above liabilities: nothing to rescue (Insufficient); the Safe cannot touch creator / holder / buyback money", whyRescue?.includes("Insufficient") && (await invariant()), whyRescue);
  }
}

// ================================================================== area 3: creator escrow
async function areaEscrow(env, H, S, P, out) {
  const { check } = H;
  const esc = env.escrow;
  const N = (out.nums.escrow = {});
  const w = env.W.creator;
  const me = env.A.creator;
  const DAY = 86400n;
  // app-path buys: the escrow swaps in our pool and holds the coins for msg.sender
  const buy = async (value) => {
    const { q } = await H.quote(env, P, true, true, value);
    const c0 = await P.coin.balanceOf(me);
    const rc = await (await esc.connect(w).buy(P.token, 1n, { value, gasLimit: 3_000_000n })).wait();
    const ev = rc.logs.map((l) => { try { return esc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "EscrowBuy");
    const hf = rc.logs.map((l) => { try { return env.hook.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "HookFee");
    const sw = rc.logs.map((l) => { try { return env.pm.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Swap" && e.args.id === P.id);
    const ts = BigInt((await env.provider.getBlock(rc.blockNumber)).timestamp);
    const cost = (value * BPS) / (BPS + 200n);
    const ok = ev && ev.args.beneficiary === me && ev.args.nativeSpent === value && ev.args.coinsEscrowed === sw.args.amount1 && ev.args.coinsEscrowed === q && hf.args.swapSender === esc.target && hf.args.feeBps === 200n && -sw.args.amount0 === cost && (await P.coin.balanceOf(me)) === c0;
    return { ok, coins: ev?.args.coinsEscrowed ?? 0n, ts, gas: rc.gasUsed };
  };
  const x1 = await buy(S.R / 23n + 101n);
  check("escrow buy 1: swaps in our pool (2% hook fee, swap sender = escrow), coins == V4Quoter quote, held for the buyer, nothing to the wallet", x1.ok, `${fmt(x1.coins, 0)} coins, gas ${x1.gas}`);
  const escrowedByTs = [[x1.ts, x1.coins]];
  await warpTo(env, x1.ts + 10n * DAY);
  const x2 = await buy(S.R / 37n + 7n);
  check("escrow buy 2 (10 days later) is escrowed on its own schedule", x2.ok, `${fmt(x2.coins, 0)} coins`);
  escrowedByTs.push([x2.ts, x2.coins]);
  N.buys = [{ coins: x1.coins.toString(), gas: Number(x1.gas) }, { coins: x2.coins.toString(), gas: Number(x2.gas) }];
  check("escrow holds exactly the escrowed coins; escrowedTotal == sum", (await P.coin.balanceOf(esc.target)) === x1.coins + x2.coins && (await esc.escrowedTotal(P.token, me)) === x1.coins + x2.coins);
  // guards
  const whyZero = await revertOf(() => esc.connect(w).buy.staticCall(P.token, 0n, { value: 0n }), env.ifaces);
  const whyUnknown = await revertOf(() => esc.connect(w).buy.staticCall(env.A.attacker, 0n, { value: WAD }), env.ifaces);
  const whySlip = await revertOf(() => esc.connect(w).buy.staticCall(P.token, 10n ** 30n, { value: WAD }), env.ifaces);
  check("escrow guards: zero value (ZeroAmount), a token without our pool (UnknownPool), minOut not met (Slippage)", whyZero?.includes("ZeroAmount") && whyUnknown?.includes("UnknownPool") && whySlip?.includes("Slippage"), `${whyZero} / ${whyUnknown} / ${whySlip}`);
  // a creator buy elsewhere (any UR) is not escrowed (D5, accepted)
  for (const [via, urName] of S.vias.filter(([v]) => v === "ur")) {
    const t = await H.trade(env, P, { via, urName, wallet: w, buy: true, exactIn: true, amount: S.R / 200n, limit: 0n });
    check(`[ur] ${urName}: a creator buy outside the app is not escrowed (D5); coins go to the wallet`, t.userCoin > 0n && (await esc.escrowedTotal(P.token, me)) === x1.coins + x2.coins);
  }
  // schedule: a/5 at s + 30 d + 7 d * k
  const expectVested = (t) => {
    let v = 0n;
    for (let k = 0n; k < 5n; k++) {
      const off = 30n * DAY + k * 7n * DAY;
      if (t < off) break;
      for (const [s, a] of escrowedByTs) if (s <= t - off) v += a;
    }
    return v / 5n;
  };
  const points = [
    ["day 30 - 1 s", x1.ts + 30n * DAY - 1n],
    ["day 30 (20% of buy 1)", x1.ts + 30n * DAY],
    ["day 37 (40% of buy 1)", x1.ts + 37n * DAY],
    ["day 40 (40% of buy 1 + 20% of buy 2)", x1.ts + 40n * DAY + 5n],
    ["day 52 (80% of buy 1 + 40% of buy 2)", x1.ts + 52n * DAY],
    ["day 58 (100% of buy 1 + 60% of buy 2)", x1.ts + 58n * DAY],
    ["day 68 (everything)", x1.ts + 68n * DAY + 1n],
  ];
  let claimedSum = 0n;
  const sched = [];
  for (const [lbl, t] of points) {
    await warpTo(env, t);
    const tNow = await now(env);
    const vested = await esc.vested(P.token, me, tNow);
    const exp = expectVested(tNow);
    const claimable = await esc.claimable(P.token, me);
    let got = 0n;
    if (claimable > 0n) {
      const b0 = await P.coin.balanceOf(me);
      await (await esc.connect(w).claim(P.token)).wait();
      got = (await P.coin.balanceOf(me)) - b0;
      claimedSum += got;
    } else {
      const why = await revertOf(() => esc.connect(w).claim.staticCall(P.token), env.ifaces);
      got = why?.includes("NothingToClaim") ? 0n : -1n;
    }
    sched.push({ at: lbl, vested: vested.toString(), claimed: got.toString() });
    check(`escrow schedule ${lbl}: vested == gen-7 formula, claim pays exactly the released part`, vested === exp && got === (claimable > 0n ? claimable : 0n) && (await esc.claimed(P.token, me)) === claimedSum, `vested ${fmt(vested, 0)} (${(Number((vested * 10000n) / (x1.coins + x2.coins)) / 100).toFixed(2)}%), claimed now ${fmt(got, 0)}`);
  }
  N.schedule = sched;
  const whyOther = await revertOf(() => esc.connect(env.W.attacker).claim.staticCall(P.token), env.ifaces);
  check("all released and claimed; the escrow holds nothing for the buyer; a stranger has nothing to claim", claimedSum === x1.coins + x2.coins && (await P.coin.balanceOf(esc.target)) === 0n && whyOther?.includes("NothingToClaim"), whyOther);
  // released coins sell through every router
  const part = claimedSum / BigInt(S.vias.length + 1);
  for (const [via, urName] of S.vias) {
    const t = await H.trade(env, P, { via, urName, wallet: w, buy: false, exactIn: true, amount: part, limit: 0n });
    const [ok, d] = H.feeExact(t, false, true, part);
    check(`[ur] ${via === "ur" ? urName : "direct"}: released escrow coins sell normally, fee exact`, ok, d);
  }
}

// ================================================================== area 5: side pools
async function areaSidePools(env, H, S, P, out) {
  const { check, note } = H;
  const pv = env.provider;
  const Wn = env.cfg.wrapped;
  const weth = (s) => new ethers.Contract(Wn, ABI.weth, s);
  const coinAddr = P.token;
  const lp = env.W.sideLp;
  const LP = env.A.sideLp;
  const watcher = (out.watcher = { rules: [], samples: [], factories: {} });
  // the side LP buys coins in our pool first (pays our fee like anyone)
  await H.trade(env, P, { via: "direct", wallet: env.W.sideLp, buy: true, exactIn: true, amount: S.R / 4n, limit: 0n });
  const ours0 = {
    slot: await H.slot0(env, P),
    posA: (await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash))[0],
    posB: (await env.sv.getPositionInfo(P.id, env.hook.target, H.consts.MIN_USABLE, P.tickGrad, ethers.ZeroHash))[0],
    owed: await H.owedAll(env, P),
  };
  const coinsPerNative = (sqrt) => Number((sqrt * sqrt * 10n ** 12n) >> 192n) / 1e12;
  const sideNative = S.R / 20n;
  const created = [];
  const sample = (kind, factory, rc, iface, evName) => {
    const log = rc.logs.find((l) => { try { return iface.parseLog(l)?.name === evName; } catch { return false; } });
    if (log) watcher.samples.push({ kind, emitter: log.address, factory, topics: log.topics, data: log.data, tx: rc.hash, block: rc.blockNumber });
    return log ? iface.parseLog(log) : null;
  };

  // ---- 1. hookless V4 pool, created through the canonical PoolManager, liquidity via the canonical PositionManager
  const key4 = [ethers.ZeroAddress, coinAddr, 3000, 60, ethers.ZeroAddress];
  const id4 = ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], key4));
  {
    const pmS = env.pm.connect(lp);
    const rcI = await (await pmS.initialize(key4, ours0.slot.sqrtP)).wait();
    const ini = sample("Uniswap V4 hookless (PoolManager Initialize)", env.cfg.pm, rcI, IFACE.pmEvents, "Initialize");
    check("side V4: anyone initializes a hookless native/coin pool in the canonical PoolManager (Initialize: currency1 = coin, hooks = 0)", ini && ini.args.currency1 === coinAddr && ini.args.hooks === ethers.ZeroAddress && ini.args.id === id4);
    const tick = Number(ini.args.tick);
    const tl = Math.floor((tick - 20000) / 60) * 60, tu = Math.ceil((tick + 20000) / 60) * 60;
    const [sL, sU, sP] = [TM.getSqrtRatioAtTick(tl), TM.getSqrtRatioAtTick(tu), ours0.slot.sqrtP];
    const L = (sideNative * 10n ** 18n) / amount0Delta(sP, sU, 10n ** 18n, true);
    const a0 = amount0Delta(sP, sU, L, true), a1 = amount1Delta(sL, sP, L, true);
    await (await P.coin.connect(lp).approve(H.consts.PERMIT2, ethers.MaxUint256)).wait();
    await (await new ethers.Contract(H.consts.PERMIT2, H.abis.PERMIT2_ABI, lp).approve(coinAddr, env.cfg.posm, H.consts.MAX_U160, 2n ** 47n)).wait();
    const actions = ethers.solidityPacked(["uint8", "uint8", "uint8"], [0x02, 0x0d, 0x14]);
    const params = [
      coder.encode([H.consts.KEY_T, "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], [key4, tl, tu, L, a0 + a0 / 100n + 1n, a1 + a1 / 100n + 1n, LP, "0x"]),
      coder.encode(["address", "address"], [ethers.ZeroAddress, coinAddr]),
      coder.encode(["address", "address"], [ethers.ZeroAddress, LP]),
    ];
    const rcM = await (await new ethers.Contract(env.cfg.posm, H.abis.POSM_ABI, lp).modifyLiquidities(coder.encode(["bytes", "bytes[]"], [actions, params]), 2n ** 40n, { value: a0 + a0 / 100n + 1n, gasLimit: 3_000_000n })).wait();
    const ml = sample("Uniswap V4 hookless (ModifyLiquidity)", env.cfg.pm, rcM, IFACE.pmEvents, "ModifyLiquidity");
    check("side V4: liquidity added through the canonical PositionManager (ModifyLiquidity on the side pool id)", ml && ml.args.id === id4 && (await env.sv.getLiquidity(id4)) === L, `L ${L}, ${fmt(a0, 4)} native + ${fmt(a1, 0)} coins`);
    created.push({ kind: "v4", key: key4, id: id4 });
  }
  const side4 = { key: key4, id: id4, token: coinAddr, coin: P.coin };

  // ---- 2. V3 pools (UR's own factory with liquidity via its NPM; other known factories: creation only)
  const [t0, t1] = BigInt(Wn) < BigInt(coinAddr) ? [Wn, coinAddr] : [coinAddr, Wn];
  const wIs0 = t0 === Wn;
  const v3Sqrt = wIs0 ? ours0.slot.sqrtP : (1n << 192n) / ours0.slot.sqrtP;
  let v3 = null;
  for (const f of env.cfg.sideV3) {
    const fac = new ethers.Contract(f.factory, ABI.v3Factory, lp);
    const code = await pv.getCode(f.factory);
    if (code.length <= 2) {
      check(`side V3 ${f.name}: factory has code`, false, f.factory);
      continue;
    }
    const fee = 10000;
    let rc;
    if (f.npm) {
      const npm = new ethers.Contract(f.npm, ABI.npm, lp);
      rc = await (await npm.createAndInitializePoolIfNecessary(t0, t1, fee, v3Sqrt, { gasLimit: 6_000_000n })).wait();
    } else {
      rc = await (await fac.createPool(t0, t1, fee, { gasLimit: 6_000_000n })).wait();
    }
    const pc = sample(`${f.name} (PoolCreated)`, f.factory, rc, IFACE.v3Factory, "PoolCreated");
    const pool = pc?.args.pool;
    check(`side V3 ${f.name}: PoolCreated(token0, token1, fee, tickSpacing, pool) from factory ${f.factory.slice(0, 10)}..`, pc && pc.args.token0 === t0 && pc.args.token1 === t1 && Number(pc.args.fee) === fee && pool === (await fac.getPool(t0, t1, fee)), `pool ${pool}`);
    watcher.factories[`${f.name} V3`] = f.factory;
    if (!f.npm || !pool) continue;
    // liquidity via the NonfungiblePositionManager (WETH side paid in native)
    const npm = new ethers.Contract(f.npm, ABI.npm, lp);
    await (await P.coin.connect(lp).approve(f.npm, ethers.MaxUint256)).wait();
    const tick = Number((await new ethers.Contract(pool, ABI.v3Pool, pv).slot0()).tick);
    const sp = Number(await fac.feeAmountTickSpacing(fee));
    const tl = Math.floor((tick - 20000) / sp) * sp, tu = Math.ceil((tick + 20000) / sp) * sp;
    const coinsHave = await P.coin.balanceOf(LP);
    const nat = sideNative;
    const coinsWant = coinsHave / 4n;
    const mintParams = [t0, t1, fee, tl, tu, wIs0 ? nat : coinsWant, wIs0 ? coinsWant : nat, 0n, 0n, LP, 2n ** 40n];
    const data = [npm.interface.encodeFunctionData("mint", [mintParams]), npm.interface.encodeFunctionData("refundETH", [])];
    const rcM = await (await npm.multicall(data, { value: nat, gasLimit: 6_000_000n })).wait();
    const mt = sample(`${f.name} pool (Mint)`, pool, rcM, IFACE.v3Pool, "Mint");
    check(`side V3 ${f.name}: liquidity minted through its NonfungiblePositionManager`, !!mt && (await new ethers.Contract(pool, ABI.v3Pool, pv).liquidity()) > 0n, `liquidity ${await new ethers.Contract(pool, ABI.v3Pool, pv).liquidity()}`);
    v3 = { pool, fee, name: f.name };
  }

  // ---- 3. V2 pairs on the known factories (UR's own + others), liquidity minted directly
  let v2 = null;
  for (const f of env.cfg.sideV2) {
    const fac = new ethers.Contract(f.factory, ABI.v2Factory, lp);
    if ((await pv.getCode(f.factory)).length <= 2) {
      check(`side V2 ${f.name}: factory has code`, false, f.factory);
      continue;
    }
    const n0 = await fac.allPairsLength();
    const rc = await (await fac.createPair(coinAddr, Wn, { gasLimit: 6_000_000n })).wait();
    const pcLog = sample(`${f.name} (PairCreated)`, f.factory, rc, IFACE.v2Factory, "PairCreated");
    const pair = pcLog?.args.pair;
    check(`side V2 ${f.name}: PairCreated(token0, token1, pair, n) from factory ${f.factory.slice(0, 10)}..`, pcLog && pcLog.args.token0 === t0 && pcLog.args.token1 === t1 && pcLog.args[3] === n0 + 1n && pair === (await fac.getPair(coinAddr, Wn)), `pair ${pair}`);
    watcher.factories[`${f.name} V2`] = f.factory;
    // liquidity at our pool's price: native n, coins n * coinsPerNative
    const n = sideNative;
    const s = (await H.slot0(env, P)).sqrtP;
    const c = (n * s * s) >> 192n;
    await (await weth(lp).deposit({ value: n })).wait();
    await (await weth(lp).transfer(pair, n)).wait();
    await (await P.coin.connect(lp).transfer(pair, c)).wait();
    const rcM = await (await new ethers.Contract(pair, ABI.v2Pair, lp).mint(LP, { gasLimit: 1_000_000n })).wait();
    const mint = sample(`${f.name} pair (Mint + Sync)`, pair, rcM, IFACE.v2Pair, "Mint");
    check(`side V2 ${f.name}: liquidity minted at our pool's price (Mint, Sync)`, !!mint, `${fmt(n, 4)} native + ${fmt(c, 0)} coins`);
    if (f.ur && !v2) v2 = { pair, feeBps: f.feeBps, name: f.name };
  }

  // ---- 4. BNB only: Topaz (Solidly-style factory) and PancakeSwap Infinity CL (its own PoolManager): creation events
  const extraRules = [];
  for (const f of env.cfg.sideSolidly ?? []) {
    const fac = new ethers.Contract(f.factory, ["function createPool(address,address,bool) returns (address)", "function createPair(address,address,bool) returns (address)"], lp);
    let rc = null, how = "";
    for (const fn of ["createPool", "createPair"]) {
      const why = await revertOf(() => fac[fn].staticCall(coinAddr, Wn, false), []);
      if (why === null) {
        rc = await (await fac[fn](coinAddr, Wn, false, { gasLimit: 8_000_000n })).wait();
        how = fn;
        break;
      }
    }
    const log = rc?.logs.find((l) => lc(l.address) === lc(f.factory));
    const SOL = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)", "event PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint256)"]);
    let parsed = null;
    try {
      parsed = log ? SOL.parseLog(log) : null;
    } catch {}
    if (log) watcher.samples.push({ kind: `${f.name} (${how}(coin, wrapped, stable=false))`, emitter: log.address, factory: f.factory, topics: log.topics, data: log.data, tx: rc.hash, block: rc.blockNumber, decoded: parsed ? parsed.signature : "unknown signature" });
    check(`side ${f.name} (Solidly-style, the gen-7 BNB graduation DEX): anyone creates a volatile pool for the coin; creation event recorded`, !!log && (log.topics[1] === ethers.zeroPadValue(t0, 32).toLowerCase() || log.topics[1] === ethers.zeroPadValue(t0, 32)), parsed ? `${parsed.signature} topic0 ${log.topics[0]} pool ${parsed.args[3]}` : `topic0 ${log?.topics[0]} (raw sample recorded)`);
    if (log) {
      extraRules.push({ event: parsed ? parsed.signature : "unknown (see sample)", topic0: log.topics[0], emitter: `${f.name} factory ${f.factory}`, filter: "topic1 == coin OR topic2 == coin" });
      watcher.factories[`${f.name}`] = f.factory;
    }
  }
  if (env.cfg.sideInfinity) {
    const inf = env.cfg.sideInfinity;
    const IINF = new ethers.Interface(["function initialize((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) key, uint160 sqrtPriceX96) returns (int24)", "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)"]);
    const c = new ethers.Contract(inf.pm, IINF, lp);
    const params = ethers.zeroPadValue(ethers.toBeHex(60n << 16n), 32); // tickSpacing 60, no hook bitmap
    const key = [ethers.ZeroAddress, coinAddr, ethers.ZeroAddress, inf.pm, 3000, params];
    const why = await revertOf(() => c.initialize.staticCall(key, ours0.slot.sqrtP), []);
    let ev = null;
    if (!why) {
      const rc = await (await c.initialize(key, ours0.slot.sqrtP, { gasLimit: 3_000_000n })).wait();
      ev = sample(`${inf.name} (Initialize)`, inf.pm, rc, IINF, "Initialize");
    }
    check(`side ${inf.name}: anyone initializes a native/coin pool in Pancake's own CL PoolManager (Initialize: currency1 = coin)`, ev && ev.args.currency1 === coinAddr, why ?? `topic0 ${IINF.getEvent("Initialize").topicHash}`);
    if (ev) extraRules.push({ event: IINF.getEvent("Initialize").format("full"), topic0: IINF.getEvent("Initialize").topicHash, emitter: `${inf.name} PoolManager ${inf.pm}`, filter: "topic1 == coin OR topic2 == coin" });
  }

  // ---- side trades through every router: our pool, our fees, our liquidity untouched
  const st = env.W.sideTrader;
  await H.trade(env, P, { via: "direct", wallet: st, buy: true, exactIn: true, amount: S.R / 10n, limit: 0n }); // coins to sell on side pools
  const ours1 = { slot: await H.slot0(env, P), owed: await H.owedAll(env, P) };
  const hookLogsIn = (rc) => rc.logs.filter((l) => lc(l.address) === lc(env.hook.target)).length + rc.logs.filter((l) => { try { const e = env.pm.interface.parseLog(l); return e?.name === "Swap" && e.args.id === P.id; } catch { return false; } }).length;
  const urExec = async (urName, call) => {
    const ur = new ethers.Contract(env.cfg.urs[urName], H.abis.UR_ABI, st);
    const why = await revertOf(() => ur.execute.staticCall(call.commands, call.inputs, 2n ** 40n, { value: call.value }), env.ifaces);
    if (why && process.env.STEP2_DEBUG) {
      const data = ur.interface.encodeFunctionData("execute", [call.commands, call.inputs, 2n ** 40n]);
      const tr = await env.provider.send("debug_traceCall", [{ from: env.A.sideTrader, to: ur.target, data, value: "0x" + call.value.toString(16), gas: "0x2dc6c0" }, "latest", { tracer: "callTracer" }]);
      const walk = (c, d) => { console.log(" ".repeat(d * 2) + c.type, c.to, (c.input || "").slice(0, 10), c.error ?? "", (c.output || "").slice(0, 74)); for (const x of c.calls ?? []) walk(x, d + 1); };
      walk(tr, 0);
      console.log("INPUTS", call.commands, call.inputs);
    }
    if (why) return { why };
    return { rc: await (await ur.execute(call.commands, call.inputs, 2n ** 40n, { value: call.value, gasLimit: 3_000_000n })).wait() };
  };
  await (await P.coin.connect(st).approve(H.consts.PERMIT2, ethers.MaxUint256)).wait();
  for (const urName of Object.keys(env.cfg.urs).filter((n) => env.urStyles[n])) {
    await (await new ethers.Contract(H.consts.PERMIT2, H.abis.PERMIT2_ABI, st).approve(coinAddr, env.cfg.urs[urName], H.consts.MAX_U160, 2n ** 47n)).wait();
    const res = [];
    // V4 hookless
    const b4 = await H.trade(env, side4, { via: "ur", urName, wallet: st, buy: true, exactIn: true, amount: sideNative / 50n, limit: 0n });
    const s4 = await H.trade(env, side4, { via: "ur", urName, wallet: st, buy: false, exactIn: true, amount: b4.userCoin / 2n, limit: 0n });
    res.push(["V4 hookless", b4.userCoin > 0n && s4.userNative > 0n && hookLogsIn(b4.rc) + hookLogsIn(s4.rc) === 0]);
    if (v3) {
      const rb = await urExec(urName, urV3Buy(Wn, coinAddr, v3.fee, sideNative / 50n, env.urStyles[urName]));
      const rs = rb.rc ? await urExec(urName, urV3Sell(Wn, coinAddr, v3.fee, (await P.coin.balanceOf(env.A.sideTrader)) / 50n, env.urStyles[urName])) : { why: "skipped" };
      if (rb.rc) sample(`${v3.name} pool (Swap)`, v3.pool, rb.rc, IFACE.v3Pool, "Swap");
      res.push([`${v3.name}`, !!rb.rc && !!rs.rc && hookLogsIn(rb.rc) + hookLogsIn(rs.rc) === 0, rb.why || rs.why]);
    }
    if (v2) {
      const rb = await urExec(urName, urV2Buy(Wn, coinAddr, sideNative / 50n, env.urStyles[urName]));
      const rs = rb.rc ? await urExec(urName, urV2Sell(Wn, coinAddr, (await P.coin.balanceOf(env.A.sideTrader)) / 50n, env.urStyles[urName])) : { why: "skipped" };
      if (rb.rc) sample(`${v2.name} pair (Swap + Sync)`, v2.pair, rb.rc, IFACE.v2Pair, "Swap");
      res.push([`${v2.name}`, !!rb.rc && !!rs.rc && hookLogsIn(rb.rc) + hookLogsIn(rs.rc) === 0, rb.why || rs.why]);
    }
    check(`[ur] ${urName}: buys and sells on the side pools (${res.map((r) => r[0]).join(", ")}) work and touch neither our pool nor our hook`, res.every((r) => r[1]), res.map((r) => `${r[0]} ${r[1] ? "ok" : "FAIL " + (r[2] ?? "")}`).join("; "));
  }
  const ours2 = { slot: await H.slot0(env, P), owed: await H.owedAll(env, P), posA: (await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash))[0], posB: (await env.sv.getPositionInfo(P.id, env.hook.target, H.consts.MIN_USABLE, P.tickGrad, ethers.ZeroHash))[0] };
  check("side-pool activity leaves our pool untouched: same price, same positions A / B, same router and creator ledgers, same claims", ours2.slot.sqrtP === ours1.slot.sqrtP && ours2.posA === ours0.posA && ours2.posB === ours0.posB && ours2.owed.router === ours1.owed.router && ours2.owed.creator === ours1.owed.creator && ours2.owed.claims === ours1.owed.claims);

  // ---- arbitrage: a big side-pool buy makes the coin dearer there; an arbitrageur aligns the prices through our pool
  const arbW = env.W.arb;
  const ourRate = await env.lens.currentFeeBps(P.id, env.trader.target);
  const arbV4 = async () => {
    await H.trade(env, side4, { via: "direct", wallet: st, buy: true, exactIn: true, amount: sideNative / 3n, limit: 0n });
    const gap = async () => coinsPerNative((await H.slot0(env, P)).sqrtP) / coinsPerNative((await env.sv.getSlot0(id4))[0]) - 1;
    const g0 = await gap();
    let x = sideNative / 10n;
    let steps = 0, ourFees = [];
    for (let i = 0; i < 40 && (await gap()) > (Number(ourRate) + 30) / 10000 + 0.002; i++) {
      const snap = await H.snapshot(env);
      const tb = await H.trade(env, P, { via: "direct", wallet: arbW, buy: true, exactIn: true, amount: x, limit: 0n });
      await H.trade(env, side4, { via: "direct", wallet: arbW, buy: false, exactIn: true, amount: tb.userCoin, limit: 0n });
      if ((await gap()) < 0) {
        await H.revert(env, snap);
        x /= 2n;
        continue;
      }
      const [ok] = H.feeExact(tb, true, true, x);
      ourFees.push(ok);
      steps++;
    }
    return { g0, g1: await gap(), steps, feesOk: ourFees.every(Boolean) && ourFees.length > 0 };
  };
  const a4 = await arbV4();
  check("arbitrage V4 hookless <-> our pool: the price gap closes to within the two fees (our 2% bonding + 0.3%); every arbitrage leg in our pool pays the exact hook fee", a4.g0 > 0.03 && a4.g1 <= (Number(ourRate) + 30) / 10000 + 0.004 && a4.g1 >= 0 && a4.feesOk, `gap ${(a4.g0 * 100).toFixed(2)}% -> ${(a4.g1 * 100).toFixed(2)}% in ${a4.steps} round trips`);
  if (v2) {
    const pair = new ethers.Contract(v2.pair, ABI.v2Pair, pv);
    const pairPrice = async () => {
      const [r0, r1] = await pair.getReserves();
      return wIs0 ? Number(r1) / Number(r0) : Number(r0) / Number(r1);
    };
    const urName = Object.keys(env.cfg.urs).find((n) => env.urStyles[n]);
    await (await new ethers.Contract(H.consts.PERMIT2, H.abis.PERMIT2_ABI, arbW).approve(coinAddr, env.cfg.urs[urName], H.consts.MAX_U160, 2n ** 47n)).wait();
    await (await P.coin.connect(arbW).approve(H.consts.PERMIT2, ethers.MaxUint256)).wait();
    const urA = new ethers.Contract(env.cfg.urs[urName], H.abis.UR_ABI, arbW);
    const urS = new ethers.Contract(env.cfg.urs[urName], H.abis.UR_ABI, st);
    const c = urV2Buy(Wn, coinAddr, sideNative / 3n, env.urStyles[urName]);
    await (await urS.execute(c.commands, c.inputs, 2n ** 40n, { value: c.value, gasLimit: 3_000_000n })).wait();
    const gap = async () => coinsPerNative((await H.slot0(env, P)).sqrtP) / (await pairPrice()) - 1;
    const g0 = await gap();
    let x = sideNative / 10n, steps = 0;
    for (let i = 0; i < 40 && (await gap()) > (Number(ourRate) + Number(v2.feeBps)) / 10000 + 0.002; i++) {
      const snap = await H.snapshot(env);
      const tb = await H.trade(env, P, { via: "direct", wallet: arbW, buy: true, exactIn: true, amount: x, limit: 0n });
      const s = urV2Sell(Wn, coinAddr, tb.userCoin, env.urStyles[urName]);
      await (await urA.execute(s.commands, s.inputs, 2n ** 40n, { gasLimit: 3_000_000n })).wait();
      if ((await gap()) < 0) {
        await H.revert(env, snap);
        x /= 2n;
        continue;
      }
      steps++;
    }
    const g1 = await gap();
    check(`arbitrage ${v2.name} pair <-> our pool (through ${urName}): the gap closes to within the two fees`, g0 > 0.03 && g1 >= 0 && g1 <= (Number(ourRate) + Number(v2.feeBps)) / 10000 + 0.004, `gap ${(g0 * 100).toFixed(2)}% -> ${(g1 * 100).toFixed(2)}% in ${steps} round trips`);
  }
  const fin = await H.owedAll(env, P);
  check("after side pools and arbitrage: hook claims == router bucket + creator ledgers; hook holds no coins; positions A / B unchanged", fin.claims === fin.router + (await sumOtherCreatorOwed(env, S)) && (await P.coin.balanceOf(env.hook.target)) === 0n && (await env.sv.getPositionInfo(P.id, env.hook.target, P.tickGrad, P.tickStart, ethers.ZeroHash))[0] === ours0.posA);

  // ---- the watcher's rules, checked against what happened on this fork
  const ourLaunch = (await env.provider.getLogs({ address: env.cfg.pm, topics: [IFACE.pmEvents.getEvent("Initialize").topicHash], fromBlock: Number(env.forkBlock.number) + 1, toBlock: "latest" })).map((l) => IFACE.pmEvents.parseLog(l));
  const coinTopic = ethers.zeroPadValue(coinAddr, 32);
  const matches = ourLaunch.filter((e) => (e.args.currency0 === coinAddr || e.args.currency1 === coinAddr) && e.args.hooks !== env.hook.target);
  check("watcher rule V4: PoolManager Initialize with the coin as currency0 or currency1 (topic1 / topic2) and hooks != our hook finds exactly the side pool, not our own", matches.length === 1 && matches[0].args.id === id4 && ourLaunch.some((e) => e.args.id === P.id), `${ourLaunch.length} Initialize logs on the fork, ${matches.length} side`);
  watcher.rules = [
    { event: "Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)", topic0: IFACE.pmEvents.getEvent("Initialize").topicHash, emitter: `PoolManager ${env.cfg.pm}`, filter: `topic1 == coin OR topic2 == coin (padded ${coinTopic.slice(0, 12)}..), then hooks != our hook ${env.hook.target}` },
    { event: "PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)", topic0: IFACE.v3Factory.getEvent("PoolCreated").topicHash, emitter: env.cfg.sideV3.map((f) => `${f.name} ${f.factory}`).join("; "), filter: "topic1 == coin OR topic2 == coin" },
    { event: "PairCreated(address indexed token0, address indexed token1, address pair, uint256)", topic0: IFACE.v2Factory.getEvent("PairCreated").topicHash, emitter: env.cfg.sideV2.map((f) => `${f.name} ${f.factory}`).join("; "), filter: "topic1 == coin OR topic2 == coin" },
    ...extraRules,
    { event: "per side pool, liquidity / volume", topic0: "V4 ModifyLiquidity " + IFACE.pmEvents.getEvent("ModifyLiquidity").topicHash + " and Swap " + IFACE.pmEvents.getEvent("Swap").topicHash + " (PoolManager, topic1 == side pool id); V3 Mint " + IFACE.v3Pool.getEvent("Mint").topicHash + " / Swap " + IFACE.v3Pool.getEvent("Swap").topicHash + " (pool address); V2 Sync " + IFACE.v2Pair.getEvent("Sync").topicHash + " / Swap " + IFACE.v2Pair.getEvent("Swap").topicHash + " (pair address)", emitter: "the side pool", filter: "address / pool id from the creation event" },
  ];
  out.nums.side = { created: created.length + (v3 ? 1 : 0) + (v2 ? 1 : 0), v3: v3?.pool ?? null, v2: v2?.pair ?? null, arbV4: a4 };
}

// ================================================================== area 6: graduation edge cases
async function areaGraduation(env, H, S, P, out) {
  const { check, note } = H;
  const N = (out.nums.grad = { crossings: [] });
  const pair0 = P.pair;
  const nPairs0 = env.displayFactory ? await env.displayFactory.allPairsLength() : 0n;
  // walk to 99% of A (exact-output buys, as in the base suite)
  const s = await H.slot0(env, P);
  const want = (H.consts.COINS_A * 99n) / 100n - H.soldFromPrice(P, s.sqrtP);
  if (want > 0n) await H.trade(env, P, { via: "direct", wallet: env.W.bot, buy: true, exactIn: false, amount: want, limit: S.R * 2n });
  const preBlock = await env.provider.getBlockNumber();
  const snapPre = await H.snapshot(env);
  const removed = (P.liqA * 200n) / BPS;
  const gradFeeExp = amount0Delta(P.sqrtGrad, P.sqrtStart, removed, false);
  const hookData = coder.encode(["address"], [H.consts.REF]);
  // native that still fits in A, plus the fee on top, plus R/50 into B: an exact-input buy of this size crosses
  const crossIn = async () => {
    const sq = (await H.slot0(env, P)).sqrtP;
    const left = sq > P.sqrtGrad ? amount0Delta(P.sqrtGrad, sq, P.liqA, true) : 0n;
    return (left * (BPS + 200n)) / BPS + S.R / 50n;
  };
  let snap = snapPre;
  for (const [via, urName] of S.vias) {
    for (const exactIn of [true, false]) {
      snap = await H.revert(env, snap);
      const lbl = `${via === "ur" ? urName : "direct"} exact-${exactIn ? "input" : "output"}`;
      const left = P.mintedA - H.soldFromPrice(P, (await H.slot0(env, P)).sqrtP);
      const amount = exactIn ? await crossIn() : left + 5_000_000n * WAD;
      const qd = via === "ur" ? hookData : "0x";
      const { q } = await H.quote(env, P, true, exactIn, amount, qd);
      const o0 = await H.owedAll(env, P);
      const t = await H.trade(env, P, { via, urName, wallet: env.W.og1, buy: true, exactIn, amount, limit: exactIn ? 0n : S.R });
      const o1 = await H.owedAll(env, P);
      const [ok, d] = H.feeExact(t, true, exactIn, amount);
      const st = await env.hook.pools(P.id);
      const sl = await H.slot0(env, P);
      const fine = t.graduated && t.graduated.gradFee === gradFeeExp && t.rate === 200n && ok && o1.router - o0.router === gradFeeExp + t.fee - t.creatorShare && o1.creator - o0.creator === t.creatorShare && q === H.quotedSide(t, true, exactIn) && st.graduated && sl.sqrtP < P.sqrtGrad;
      check(`[ur] crossing via ${lbl}: graduates once in the swap, graduation fee exact, crossing fee at the 2% bonding rate, router + creator ledgers exact, V4Quoter == executed`, fine, `${d}; gradFee ${fmt(t.graduated?.gradFee ?? 0n, 9)}; gas ${t.gas}`);
      N.crossings.push({ via: via === "ur" ? urName : "direct", exactIn, gas: Number(t.gas), gradFee: (t.graduated?.gradFee ?? 0n).toString() });
      if (P.pair) {
        const [dok, dd] = await H.checkDisplay(env, P, t, true, env.W.og1);
        check(`crossing via ${lbl}: BNB display Sync + Swap in the crossing tx, reserves == pool price inside B`, dok, dd);
      }
    }
  }
  // price limit at the boundary (direct callback; UR V4 swaps carry no price limit)
  snap = await H.revert(env, snap);
  {
    const t1 = await H.trade(env, P, { via: "direct", wallet: env.W.og1, buy: true, exactIn: true, amount: S.R, limit: 0n, sqrtLimit: P.sqrtGrad + 1n });
    const s1 = await H.slot0(env, P);
    check("exact-in buy with the limit one unit above the boundary stops there and does NOT graduate", s1.sqrtP === P.sqrtGrad + 1n && t1.graduated === null && !(await env.hook.pools(P.id)).graduated);
    const t2 = await H.trade(env, P, { via: "direct", wallet: env.W.og1, buy: true, exactIn: true, amount: 10n ** 12n, limit: 0n });
    check("the next tiny buy crosses and graduates (latch at price <= top of A)", t2.graduated !== null && t2.graduated.gradFee === gradFeeExp && (await H.slot0(env, P)).sqrtP <= P.sqrtGrad);
  }
  snap = await H.revert(env, snap);
  {
    const left = P.mintedA - H.soldFromPrice(P, (await H.slot0(env, P)).sqrtP);
    const t = await H.trade(env, P, { via: "direct", wallet: env.W.og1, buy: true, exactIn: false, amount: left + 10_000_000n * WAD, limit: S.R, sqrtLimit: P.sqrtGrad });
    const s1 = await H.slot0(env, P);
    check("exact-output buy across the boundary with the limit exactly at the boundary: partial fill to the boundary, graduates, fee on the filled part", s1.sqrtP === P.sqrtGrad && t.graduated !== null && t.fee === (-t.raw0 * 200n) / BPS && t.userCoin < left + 10_000_000n * WAD, `got ${fmt(t.userCoin, 0)} of ${fmt(left + 10_000_000n * WAD, 0)} coins`);
  }
  // fall back below and re-cross through every router: no second graduation, 1% rate
  snap = await H.revert(env, snap);
  {
    const tc = await H.trade(env, P, { via: "direct", wallet: env.W.og1, buy: true, exactIn: true, amount: await crossIn(), limit: 0n });
    check("graduated by a direct crossing", tc.graduated !== null);
    const bought = tc.userCoin;
    let i = 0;
    for (const [via, urName] of S.vias) {
      const lbl = via === "ur" ? urName : "direct";
      // fall back into A: sell more than was bought into B
      const ts = await H.trade(env, P, { via, urName, wallet: env.W.bot, buy: false, exactIn: true, amount: bought + 3_000_000n * WAD + BigInt(i), limit: 0n });
      const above = (await H.slot0(env, P)).sqrtP > P.sqrtGrad;
      // display check right after each trade (it compares with the pool price now)
      const [d1, dd1] = P.pair ? await H.checkDisplay(env, P, ts, false, env.W.bot) : [true, ""];
      const ob = await H.owedAll(env, P);
      const tb = await H.trade(env, P, { via, urName, wallet: env.W.og1, buy: true, exactIn: true, amount: (await crossIn()) + BigInt(i++), limit: 0n });
      const oa = await H.owedAll(env, P);
      const below = (await H.slot0(env, P)).sqrtP < P.sqrtGrad;
      const cs = (tb.fee * 560n) / BPS;
      check(`[ur] ${lbl}: fall back below the boundary (sell at 1%, it starts past graduation) and re-cross (buy at 2%, it starts in A: F1): no second graduation, no second 2% graduation fee, creator 5.6% of the fee`, above && below && ts.rate === 100n && tb.rate === 200n && tb.graduated === null && ts.graduated === null && tb.creatorShare === cs && oa.router - ob.router === tb.fee - cs && oa.creator - ob.creator === cs, `above after sell ${above}, below after buy ${below}, rates ${ts.rate}/${tb.rate}, graduated events ${ts.graduated !== null}/${tb.graduated !== null}, router +${fmt(oa.router - ob.router, 9)} creator +${fmt(oa.creator - ob.creator, 9)}`);
      if (P.pair) {
        const [d2, dd2] = await H.checkDisplay(env, P, tb, true, env.W.og1);
        check(`${lbl}: BNB display follows the fall-back and the re-cross (Sync + Swap, reserves == pool price)`, d1 && d2, `fall-back sell: ${dd1} | re-cross buy: ${dd2}`);
      }
    }
  }
  // display continuity over the whole sequence (BNB): one pair, no new pair, every Sync == pool price at its block
  if (P.pair) {
    const logs = await env.provider.getLogs({ address: P.pair, topics: [H.consts.TOPIC.Sync], fromBlock: preBlock + 1, toBlock: "latest" });
    let ok = true, worst = 0;
    for (const l of logs) {
      const e = H.abis.V2_IFACE.parseLog(l);
      const [rN, rC] = P.nativeIsToken0 ? [e.args[0], e.args[1]] : [e.args[1], e.args[0]];
      const sq = (await env.sv.getSlot0(P.id, { blockTag: l.blockNumber }))[0];
      const d = ppm(rC * (1n << 192n), rN * sq * sq);
      worst = Math.max(worst, d);
      if (d >= 0.01) ok = false;
    }
    const gr = await new ethers.Contract(P.pair, H.abis.V2_IFACE, env.provider).getReserves();
    const last = H.abis.V2_IFACE.parseLog(logs[logs.length - 1]);
    check("BNB display continuity across graduation, fall-back and re-crossing: same pair address, no new pair, every Sync == pool price at its block, reserves == last Sync", ok && logs.length >= 2 * S.vias.length + 1 && (await env.hook.displayPair(P.id)) === pair0 && (await env.displayFactory.allPairsLength()) === nPairs0 && gr[0] === last.args[0] && gr[1] === last.args[1], `${logs.length} Sync logs, worst ${worst.toFixed(6)} ppm`);
  } else {
    check("Robinhood: no display pair before or after graduation", (await env.hook.displayPair(P.id)) === ethers.ZeroAddress);
  }
  await H.revert(env, snap);
}

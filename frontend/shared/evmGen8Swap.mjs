/**
 * EVM generation 8 swaps through Uniswap's UniversalRouter (design 6.2): one V4_SWAP command with the actions
 * SWAP_EXACT_IN_SINGLE (or SWAP_EXACT_OUT_SINGLE) + SETTLE_ALL + TAKE_ALL in the coin's own pool (native vs coin, our
 * hook). Native in for buys. A sell pulls the coin through Permit2: the first sell of a coin approves Permit2 for the
 * maximum and sets one allowance for our router; every later sell is only the swap. A signed exact permit still
 * encodes, for a caller that already has one.
 *
 * One encoder for the app (it builds its own trades) and the API (it builds the swap widget's trades and records the
 * partner fingerprint of what it built). Plain ESM, ethers only, no network.
 *
 * UniversalRouter versions encode the V4 single-hop params differently (proven on the BSC 56 and Robinhood 4663
 * forks, scripts/research/v4-hook/results/v4-hook-proof.log on build/evm-gen8):
 *   layout v2.0  ExactInputSingleParams(PoolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)
 *   layout v2.1  ExactInputSingleParams(PoolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum,
 *                uint256 minHopPriceX36, bytes hookData)   (exact output: uint256 maxHopPriceX36; 0 = no check)
 * Sending one layout to a router of the other reverts, so every router address is pinned to its layout here and an
 * unknown router needs its layout named in the env.
 */
import { AbiCoder, Interface, getAddress, getBytes, solidityPacked, zeroPadValue } from "ethers";

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** UniversalRouter recipient sentinel: Constants.MSG_SENDER (address(1)) pays out to the caller of execute(). */
export const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001";
/** UniversalRouter / V4 native sentinel: Constants.ETH = address(0) (SWEEP of address(0) sends the router's native). */
export const UR_NATIVE = "0x0000000000000000000000000000000000000000";
const NATIVE = UR_NATIVE;

/** UniversalRouter command bytes (Commands.sol). */
export const UR_COMMANDS = Object.freeze({ SWEEP: 0x04, PERMIT2_PERMIT: 0x0a, V4_SWAP: 0x10 });
/** V4Router action bytes (Actions.sol). */
export const V4_ACTIONS = Object.freeze({ SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_OUT_SINGLE: 0x08, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f });

/**
 * Every UniversalRouter the gen-8 proof ran against, with its V4_SWAP params layout. The first entry per chain is the
 * default the app and the API use when no env names a router.
 *   56    2.1.2 (layout v2.1, design 6.2 "layout v2.1"); docs main 0x1906 is v2.0, 2.1.1 is v2.1
 *   4663  docs main 0x8876 (layout v2.1; the router the Robinhood import route already uses), 2.1.2 is v2.1
 */
export const GEN8_KNOWN_ROUTERS = Object.freeze({
  56: Object.freeze([
    Object.freeze({ address: getAddress("0xDc264714F68d84CF29BC605589405E78bDBE7C9f"), layout: "v2.1", label: "UniversalRouter 2.1.2" }),
    Object.freeze({ address: getAddress("0x1906c1d672b88cd1b9ac7593301ca990f94eae07"), layout: "v2.0", label: "UniversalRouter (docs main)" }),
    Object.freeze({ address: getAddress("0x8b844f885672f333bc0042cb669255f93a4c1e6b"), layout: "v2.1", label: "UniversalRouter 2.1.1" }),
  ]),
  4663: Object.freeze([
    Object.freeze({ address: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"), layout: "v2.1", label: "UniversalRouter (docs main)" }),
    Object.freeze({ address: getAddress("0x204FAca1764B154221e35c0d20aBb3c525710498"), layout: "v2.1", label: "UniversalRouter 2.1.2" }),
  ]),
});

/** Uniswap V4Quoter per mainnet (design 2.1). Testnets and local chains: env only. */
export const GEN8_V4_QUOTER = Object.freeze({
  56: getAddress("0x9f75dd27d6664c475b90e105573e550ff69437b0"),
  4663: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
});

export const GEN8_LAYOUTS = Object.freeze(["v2.0", "v2.1"]);

/** Swap deadline the app and the API put on a router call: 20 minutes. */
export const GEN8_SWAP_DEADLINE_SECONDS = 20 * 60;
/** Permit2 permit for a sell: valid 30 minutes, for exactly the sell amount (robinhoodImportSwap.mjs). */
export const GEN8_PERMIT_SECONDS = 30 * 60;
/** Standing Permit2 allowance the app and the widget set for our router. One year, then one refresh. */
export const GEN8_ROUTER_ALLOWANCE_SECONDS = 365 * 24 * 60 * 60;
const MAX_U256 = (1n << 256n) - 1n;

/**
 * hookData = one 32-byte word the hook emits as HookFee.referrer (analytics only, never money). The app tags its own
 * trades "mwz" and the swap widget's builds "mwzw", so pool trades from our surfaces are visible next to bots and
 * aggregators. Partner attribution never relies on it (the build fingerprint does, as for imports).
 */
export const GEN8_REFERRER_APP = getAddress("0x00000000000000000000000000000000006d777a");
export const GEN8_REFERRER_WIDGET = getAddress("0x000000000000000000000000000000006d777a77");

const coder = AbiCoder.defaultAbiCoder();
const KEY_T = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const SINGLE_V20 = `tuple(${KEY_T} poolKey,bool zeroForOne,uint128 amount,uint128 limit,bytes hookData)`;
const SINGLE_V21 = `tuple(${KEY_T} poolKey,bool zeroForOne,uint128 amount,uint128 limit,uint256 hopPriceX36,bytes hookData)`;
const PERMIT_SINGLE_T = "tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)";
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;

export const UNIVERSAL_ROUTER_ABI = Object.freeze([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error TransactionDeadlinePassed()",
]);
const UR_IFACE = new Interface(UNIVERSAL_ROUTER_ABI);

export const V4_QUOTER_ABI = Object.freeze([
  `function quoteExactInputSingle(((${KEY_T.slice(6, -1)}) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
  `function quoteExactOutputSingle(((${KEY_T.slice(6, -1)}) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)`,
]);

export const PERMIT2_ABI = Object.freeze([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const ERC20_APPROVE_IFACE = new Interface(["function approve(address spender, uint256 value) returns (bool)"]);
const PERMIT2_IFACE = new Interface(PERMIT2_ABI);

function permit2Parts(allowance) {
  if (allowance == null) return { amount: 0n, expiration: 0n };
  const amount = allowance.amount ?? allowance[0] ?? 0n;
  const expiration = allowance.expiration ?? allowance[1] ?? 0n;
  return { amount: BigInt(amount), expiration: BigInt(expiration) };
}

/**
 * True when the router's Permit2 allowance can pay this sell, and still will at the swap deadline.
 * `allowance` is Permit2.allowance(owner, token, router): { amount, expiration } or the ethers Result.
 */
export function gen8RouterAllowanceCovers(allowance, amountIn, nowSec) {
  const { amount, expiration } = permit2Parts(allowance);
  return amount >= BigInt(amountIn) && expiration > BigInt(nowSec) + BigInt(GEN8_SWAP_DEADLINE_SECONDS);
}

/**
 * The transactions that make the next sells of this coin one signature, or null when the swap can be sent alone.
 * `approval` is ERC20 approve(Permit2, max). `permit2Approval` is Permit2.approve(router) for one year at the uint160 max.
 * Nothing here is a signature. The swap itself is built separately, with no permit, after these are mined.
 */
export function gen8SellSetup({ token, router, erc20Allowance, permit2Allowance, amountIn, nowSec }) {
  const coin = getAddress(token);
  const spender = getAddress(router);
  const now = BigInt(nowSec);
  const approval = BigInt(erc20Allowance) === MAX_U256 ? null : {
    to: coin,
    data: ERC20_APPROVE_IFACE.encodeFunctionData("approve", [PERMIT2_ADDRESS, MAX_U256]),
    value: "0",
  };
  const permit2Approval = gen8RouterAllowanceCovers(permit2Allowance, amountIn, nowSec) ? null : {
    to: PERMIT2_ADDRESS,
    data: PERMIT2_IFACE.encodeFunctionData("approve", [coin, spender, MAX_U160, now + BigInt(GEN8_ROUTER_ALLOWANCE_SECONDS)]),
    value: "0",
  };
  if (!approval && !permit2Approval) return null;
  return { approval, permit2Approval };
}

function envValue(env, name) {
  const v = env?.[`VITE_${name}`] ?? env?.[name];
  return String(v ?? "").trim();
}

const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || "")) && !/^0x0{40}$/i.test(String(v || ""));

/**
 * The chain's router and its layout: EVM_GEN8_UNIVERSAL_ROUTER_<id> (VITE_ prefixed in the app) when set, else the
 * default above. A router not in GEN8_KNOWN_ROUTERS needs EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_<id> = v2.0 | v2.1.
 * Returns { address, layout, label } or null (no router for the chain: no gen-8 trades there).
 */
export function gen8RouterFor(chainId, env = {}) {
  const id = Number(chainId);
  const known = GEN8_KNOWN_ROUTERS[id] || [];
  const raw = envValue(env, `EVM_GEN8_UNIVERSAL_ROUTER_${id}`);
  const layoutEnv = envValue(env, `EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_${id}`).toLowerCase();
  if (raw) {
    if (!isAddr(raw)) return null;
    const address = getAddress(raw);
    const hit = known.find((r) => r.address === address);
    const layout = layoutEnv || hit?.layout || "";
    if (!GEN8_LAYOUTS.includes(layout)) return null;
    // A known router named with the wrong layout would revert every swap: the table wins over a contradicting env.
    if (hit && hit.layout !== layout) return { address, layout: hit.layout, label: hit.label };
    return { address, layout, label: hit?.label || "UniversalRouter" };
  }
  return known[0] ? { address: known[0].address, layout: known[0].layout, label: known[0].label } : null;
}

/** EVM_GEN8_V4_QUOTER_<id> (VITE_ in the app) or the canonical V4Quoter; null when neither exists. */
export function gen8QuoterFor(chainId, env = {}) {
  const raw = envValue(env, `EVM_GEN8_V4_QUOTER_${Number(chainId)}`);
  if (raw) return isAddr(raw) ? getAddress(raw) : null;
  return GEN8_V4_QUOTER[Number(chainId)] || null;
}

export function gen8HookData(referrer = GEN8_REFERRER_APP) {
  return zeroPadValue(getAddress(referrer), 32);
}

/** amount x (10000 - slippage) / 10000, floor. */
export function gen8MinOut(amount, slippageBps) {
  const bps = BigInt(Math.trunc(Number(slippageBps)));
  if (bps < 0n || bps > 5000n) throw new Error("slippage must be between 0 and 50%");
  return (BigInt(amount) * (10_000n - bps)) / 10_000n;
}

function keyTuple(poolKey) {
  const k = Array.isArray(poolKey) ? { currency0: poolKey[0], currency1: poolKey[1], fee: poolKey[2], tickSpacing: poolKey[3], hooks: poolKey[4] } : poolKey;
  if (getAddress(k.currency0) !== NATIVE) throw new Error("gen-8 pools are native vs coin: currency0 must be native");
  return [getAddress(k.currency0), getAddress(k.currency1), Number(k.fee), Number(k.tickSpacing), getAddress(k.hooks)];
}

function u128(v, label) {
  const n = BigInt(v);
  if (n < 0n || n > MAX_U128) throw new Error(`${label} out of range`);
  return n;
}

/**
 * The V4_SWAP input (abi.encode(bytes actions, bytes[] params)) for one swap in a gen-8 pool.
 *   side "buy": native -> coin (zeroForOne); "sell": coin -> native.
 *   exactIn true: `amount` in, `limit` = minimum out.  exactIn false: `amount` out, `limit` = maximum in.
 */
export function encodeGen8V4SwapInput({ layout, poolKey, side, exactIn = true, amount, limit, hookData = gen8HookData() }) {
  if (!GEN8_LAYOUTS.includes(layout)) throw new Error(`unknown UniversalRouter layout ${layout}`);
  if (side !== "buy" && side !== "sell") throw new Error("side must be buy or sell");
  const key = keyTuple(poolKey);
  const zeroForOne = side === "buy";
  const amt = u128(amount, "amount");
  const lim = u128(limit, "limit");
  if (amt === 0n) throw new Error("amount must be positive");
  const cIn = zeroForOne ? key[0] : key[1];
  const cOut = zeroForOne ? key[1] : key[0];
  const swapAction = exactIn ? V4_ACTIONS.SWAP_EXACT_IN_SINGLE : V4_ACTIONS.SWAP_EXACT_OUT_SINGLE;
  const actions = solidityPacked(["uint8", "uint8", "uint8"], [swapAction, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]);
  const single = layout === "v2.0"
    ? coder.encode([SINGLE_V20], [[key, zeroForOne, amt, lim, hookData]])
    : coder.encode([SINGLE_V21], [[key, zeroForOne, amt, lim, 0n, hookData]]);
  const params = [
    single,
    // SETTLE_ALL(currency, maxAmount): what the router may take from the payer; TAKE_ALL(currency, minAmount).
    coder.encode(["address", "uint256"], [cIn, exactIn ? amt : lim]),
    coder.encode(["address", "uint256"], [cOut, exactIn ? lim : amt]),
  ];
  return coder.encode(["bytes", "bytes[]"], [actions, params]);
}

/** PERMIT2_PERMIT input: abi.encode(PermitSingle, bytes signature). */
export function encodePermit2PermitInput(permit) {
  const p = permit.permitSingle;
  const d = p.details;
  const tuple = [[getAddress(d.token), BigInt(d.amount), BigInt(d.expiration), BigInt(d.nonce)], getAddress(p.spender), BigInt(p.sigDeadline)];
  return coder.encode([PERMIT_SINGLE_T, "bytes"], [tuple, permit.signature]);
}

/**
 * The whole router call for a gen-8 swap: { to, data, value, commands, inputs, deadline }.
 *   buy exact in:   [V4_SWAP], value = amount
 *   buy exact out:  [V4_SWAP, SWEEP(native -> msg.sender)], value = limit (unspent native comes back)
 *   sell:           [PERMIT2_PERMIT?, V4_SWAP], value = 0
 */
export function buildGen8RouterCall({ router, layout, poolKey, side, exactIn = true, amount, limit, deadline, hookData = gen8HookData(), permit = null }) {
  const commands = [];
  const inputs = [];
  if (permit) {
    if (side !== "sell") throw new Error("a Permit2 permit belongs to a sell");
    commands.push(UR_COMMANDS.PERMIT2_PERMIT);
    inputs.push(encodePermit2PermitInput(permit));
  }
  commands.push(UR_COMMANDS.V4_SWAP);
  inputs.push(encodeGen8V4SwapInput({ layout, poolKey, side, exactIn, amount, limit, hookData }));
  if (side === "buy" && !exactIn) {
    commands.push(UR_COMMANDS.SWEEP);
    inputs.push(coder.encode(["address", "address", "uint256"], [NATIVE, UR_MSG_SENDER, 0n]));
  }
  const commandBytes = `0x${commands.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const dl = BigInt(deadline);
  const data = UR_IFACE.encodeFunctionData("execute", [commandBytes, inputs, dl]);
  const value = side === "buy" ? BigInt(exactIn ? amount : limit) : 0n;
  return { to: getAddress(router), data, value, commands: commandBytes, inputs, deadline: dl };
}

/**
 * Decodes a router call built above (tests, and the API's check of what it is about to hand out). Returns
 * { commands: number[], deadline, permit, swap: { exactIn, zeroForOne, poolKey, amount, limit, hopPriceX36, hookData,
 * settle: { currency, amount }, take: { currency, amount } }, sweep }.
 */
export function decodeGen8RouterCall(data, layout) {
  const [commandBytes, inputs, deadline] = UR_IFACE.decodeFunctionData("execute", data);
  const commands = Array.from(getBytes(commandBytes));
  const out = { commands, deadline: BigInt(deadline), permit: null, swap: null, sweep: null };
  commands.forEach((cmd, i) => {
    const input = inputs[i];
    if (cmd === UR_COMMANDS.PERMIT2_PERMIT) {
      const [p, signature] = coder.decode([PERMIT_SINGLE_T, "bytes"], input);
      out.permit = {
        permitSingle: {
          details: { token: getAddress(p.details.token), amount: BigInt(p.details.amount), expiration: BigInt(p.details.expiration), nonce: BigInt(p.details.nonce) },
          spender: getAddress(p.spender),
          sigDeadline: BigInt(p.sigDeadline),
        },
        signature,
      };
    } else if (cmd === UR_COMMANDS.V4_SWAP) {
      const [actions, params] = coder.decode(["bytes", "bytes[]"], input);
      const acts = Array.from(getBytes(actions));
      const exactIn = acts[0] === V4_ACTIONS.SWAP_EXACT_IN_SINGLE;
      if (!exactIn && acts[0] !== V4_ACTIONS.SWAP_EXACT_OUT_SINGLE) throw new Error(`unexpected V4 action ${acts[0]}`);
      if (acts[1] !== V4_ACTIONS.SETTLE_ALL || acts[2] !== V4_ACTIONS.TAKE_ALL || acts.length !== 3) throw new Error("unexpected V4 action list");
      const single = layout === "v2.0" ? coder.decode([SINGLE_V20], params[0])[0] : coder.decode([SINGLE_V21], params[0])[0];
      const [settleCurrency, settleAmount] = coder.decode(["address", "uint256"], params[1]);
      const [takeCurrency, takeAmount] = coder.decode(["address", "uint256"], params[2]);
      const k = single.poolKey;
      out.swap = {
        exactIn,
        zeroForOne: Boolean(single.zeroForOne),
        poolKey: { currency0: getAddress(k.currency0), currency1: getAddress(k.currency1), fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: getAddress(k.hooks) },
        amount: BigInt(single.amount),
        limit: BigInt(single.limit),
        hopPriceX36: layout === "v2.0" ? null : BigInt(single.hopPriceX36),
        hookData: single.hookData,
        settle: { currency: getAddress(settleCurrency), amount: BigInt(settleAmount) },
        take: { currency: getAddress(takeCurrency), amount: BigInt(takeAmount) },
      };
    } else if (cmd === UR_COMMANDS.SWEEP) {
      const [token, recipient, amountMin] = coder.decode(["address", "address", "uint256"], input);
      out.sweep = { token: getAddress(token), recipient: getAddress(recipient), amountMin: BigInt(amountMin) };
    } else {
      throw new Error(`unexpected UniversalRouter command 0x${cmd.toString(16)}`);
    }
  });
  return out;
}

/**
 * F14: an exact-output buy pays `limit` native up front and the swap settles only what it costs, so the rest stays in
 * the router unless the same call sweeps it back. Every such call must end with SWEEP(native, msg.sender, 0). Throws
 * on a decoded call (decodeGen8RouterCall) that would leave native behind; exact-input and sell calls pass.
 */
export function assertGen8NativeRefund(decoded) {
  const s = decoded?.swap;
  if (!s || s.exactIn || !s.zeroForOne) return;
  const w = decoded.sweep;
  const last = decoded.commands[decoded.commands.length - 1];
  if (!w || last !== UR_COMMANDS.SWEEP || w.token !== NATIVE || w.recipient !== UR_MSG_SENDER || w.amountMin !== 0n) {
    throw new Error("an exact-output native buy must sweep unspent native back to the payer");
  }
}

/** EIP-712 typed data of a Permit2 PermitSingle (AllowanceTransfer), for wallet.signTypedData. */
export function gen8PermitTypedData({ chainId, token, amount, nonce, spender, nowSec, seconds = GEN8_PERMIT_SECONDS }) {
  const a = BigInt(amount);
  if (a <= 0n || a > MAX_U160) throw new Error("permit amount out of range");
  const expiration = BigInt(nowSec) + BigInt(seconds);
  const permitSingle = {
    details: { token: getAddress(token), amount: a, expiration, nonce: BigInt(nonce) },
    spender: getAddress(spender),
    sigDeadline: expiration,
  };
  return {
    domain: { name: "Permit2", chainId: Number(chainId), verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    primaryType: "PermitSingle",
    message: permitSingle,
  };
}

/** JSON-safe copy of a permit (bigints as strings) and back. */
export function permitToJson(permit) {
  const p = permit.permitSingle;
  return {
    permitSingle: {
      details: { token: p.details.token, amount: String(p.details.amount), expiration: String(p.details.expiration), nonce: String(p.details.nonce) },
      spender: p.spender,
      sigDeadline: String(p.sigDeadline),
    },
    signature: permit.signature,
  };
}

export function permitFromJson(json) {
  const p = json?.permitSingle;
  if (!p?.details || !json?.signature) throw new Error("permit is incomplete");
  return {
    permitSingle: {
      details: { token: getAddress(p.details.token), amount: BigInt(p.details.amount), expiration: BigInt(p.details.expiration), nonce: BigInt(p.details.nonce) },
      spender: getAddress(p.spender),
      sigDeadline: BigInt(p.sigDeadline),
    },
    signature: String(json.signature),
  };
}

// ------------------------------------------------------------------ fee arithmetic for quotes (MwzFeeMath)

/** Exact-input buy of g native at `rateBps`: curve cost and fee, exactly as the hook splits it. */
export function gen8BuyFeeSplit(valueWei, rateBps) {
  const g = BigInt(valueWei);
  const cost = (g * 10_000n) / (10_000n + BigInt(rateBps));
  return { curveWei: cost, feeWei: g - cost };
}

/**
 * Exact-input sell: the quoter returns the net native out. The hook charged floor(payout x rate / 10000) on the payout,
 * so payout is the smallest p with p - floor(p x rate / 10000) == net (MwzFeeMath.grossForNet); fee = payout - net.
 */
export function gen8SellFeeSplit(netWei, rateBps) {
  const net = BigInt(netWei);
  const r = BigInt(rateBps);
  if (net <= 0n) return { curveWei: 0n, feeWei: 0n };
  let p = (net * 10_000n) / (10_000n - r);
  while (p - (p * r) / 10_000n < net) p += 1n;
  while (p > 0n && p - 1n - ((p - 1n) * r) / 10_000n >= net) p -= 1n;
  return { curveWei: p, feeWei: p - net };
}

/** What the coin's creator gets from one trade's fee: bonding = creatorBondingBps of the fee, after = creatorPostBps of the curve amount. */
export function gen8CreatorShareWei({ graduated, curveWei, feeWei, creatorBondingBps = 560, creatorPostBps = 50 }) {
  if (graduated) {
    const s = (BigInt(curveWei) * BigInt(creatorPostBps)) / 10_000n;
    return s > BigInt(feeWei) ? BigInt(feeWei) : s;
  }
  return (BigInt(feeWei) * BigInt(creatorBondingBps)) / 10_000n;
}

// ------------------------------------------------------------------ price impact and slippage (F13)

/** Default slippage of a gen-8 trade where it is not sized (Robinhood, and any trade without a price impact): 1%. */
export const GEN8_DEFAULT_SLIPPAGE_BPS = 100;
/**
 * Chains whose gen-8 trades get slippage sized from the quote's price impact (F13, audit D-M2): BNB Chain and its
 * testnet, where a public mempool lets a searcher sandwich a buy for a profit that grows with the slippage allowed.
 * Robinhood Chain orders first come first served, so it keeps the flat default.
 */
export const GEN8_SIZED_SLIPPAGE_CHAIN_IDS = Object.freeze([56, 97]);
/**
 * Sized slippage = clamp(BASE + priceImpact / IMPACT_DIVISOR, MIN, MAX), in bps:
 *   0.30% for a trade that does not move the price, +0.1% per 1% of its own price impact, at most 1% (the flat
 *   default before F13, so no trade allows a sandwich more room than before).
 * Audit D (scripts/audit/D/results/econ-model.txt): on BSC every slippage above 0.05% is profitable to sandwich and the
 * attacker's profit is about linear in it ($1,000 buy at $30K: $11 at 0.5%, $22 at 1%, $104 at 5%), so the default is
 * the smallest that still covers normal movement between the quote and the block. The quote already contains the
 * trade's own impact; the impact term covers a thin pool, where someone else's ordinary trade landing first moves the
 * price more. The user can always pick another slippage.
 */
export const GEN8_SIZED_SLIPPAGE = Object.freeze({ baseBps: 30, impactDivisor: 10, minBps: 30, maxBps: 100 });

/** True when gen-8 trades on this chain use the sized slippage. */
export function gen8UsesSizedSlippage(chainId) {
  return GEN8_SIZED_SLIPPAGE_CHAIN_IDS.includes(Number(chainId));
}

/**
 * The default slippage of a gen-8 trade in bps: sized from `priceImpactBps` on BNB Chain (56, 97), the flat 1%
 * elsewhere or when the impact is unknown (null).
 */
export function gen8SizedSlippageBps({ chainId, priceImpactBps }) {
  if (!gen8UsesSizedSlippage(chainId) || priceImpactBps == null || !Number.isFinite(Number(priceImpactBps))) return GEN8_DEFAULT_SLIPPAGE_BPS;
  const { baseBps, impactDivisor, minBps, maxBps } = GEN8_SIZED_SLIPPAGE;
  const raw = baseBps + Math.ceil(Math.max(0, Number(priceImpactBps)) / impactDivisor);
  return Math.min(maxBps, Math.max(minBps, raw));
}

/**
 * The small reference trade a price impact is measured against: 1/1000 of the trade (its own impact is about 1/1000
 * of the trade's), or null when that is too small to price to 0.01% (under 1e9 base units).
 */
export function gen8ReferenceAmount(amountIn) {
  const ref = BigInt(amountIn) / 1000n;
  return ref >= 1_000_000_000n ? ref : null;
}

/**
 * Price impact of a trade in bps: how much worse its average price is than the pool's price just before it, both
 * read from quotes of the same pool in the same block (the trade, and a reference trade of 1/1000 of it). Both quotes
 * pay the same fee rate, so the fee cancels out and the result is the curve's movement only.
 *   impact = 1 - (amountOut / amountIn) / (refOut / refIn), floored at 0, at most 10000. null without a reference.
 */
export function gen8PriceImpactBps({ amountIn, amountOut, refIn, refOut }) {
  if (refIn == null || refOut == null) return null;
  const aIn = BigInt(amountIn);
  const aOut = BigInt(amountOut);
  const rIn = BigInt(refIn);
  const rOut = BigInt(refOut);
  if (aIn <= 0n || rIn <= 0n || rOut <= 0n) return null;
  if (aOut <= 0n) return 10_000;
  // Under 10,000 wei, one wei is coarser than 1 bp. A ~60 wei reference made a 0.001 sell look like 1.65%.
  if (aOut < 10_000n || rOut < 10_000n) return 0;
  // execution rate / reference rate, in bps (rounded down)
  const ratioBps = (aOut * rIn * 10_000n) / (rOut * aIn);
  const impact = 10_000n - ratioBps;
  if (impact <= 0n) return 0;
  return Number(impact > 10_000n ? 10_000n : impact);
}

export { gen8FormatAmount } from "./gen8FormatAmount.mjs";

/** "2.45%" for the panel and the widget; "<0.01%" under one bp; "-" when unknown. */
export function gen8FormatPriceImpact(bps) {
  if (bps == null) return "-";
  if (Number(bps) < 1) return "<0.01%";
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

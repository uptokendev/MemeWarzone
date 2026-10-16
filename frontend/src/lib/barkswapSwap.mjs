/**
 * Barkswap trades and launches for EVM generation 8 coins on DogeOS (6281971; barkswap plan t22, spec section 4 App).
 * A Bark coin trades in its own Barkswap (Algebra Integral 1.2.1) custom pool, before and after graduation: deployer =
 * our MwzBarkLauncher, plugin = MwzBarkPlugin, coin = token0, WDOGE = token1. The app reaches it through Barkswap's
 * SwapRouter and quotes it with Barkswap's QuoterV2 with the same `deployer` (quote == execution, proven on the Chikyu
 * fork: test/dogeos/barkswap/BarkPlugin.fork.spec.ts "exactInputSingle executes exactly what QuoterV2 quotes"):
 *
 *   buy   SwapRouter.exactInputSingle{value: amountIn}(WDOGE -> coin, deployer = launcher, recipient = the buyer). No
 *         price limit, so the whole input fills (position B runs to the top tick) and no DOGE stays in the router. A
 *         price-limited buy is multicall(exactInputSingle, refundNativeToken): the unfilled DOGE comes back (gen-8 F14).
 *   sell  approve(router, amountIn), then multicall(exactInputSingle(coin -> WDOGE, recipient 0 = the router),
 *         unwrapWNativeToken(minOut, seller)): the seller receives native DOGE. limitSqrtPrice = the coin's start price
 *         (sqrtAtTick(tickStart), the plugin's sqrtStart), so a sell larger than the pool can take back stops there and
 *         the router pulls only the coins it used, instead of reverting in the plugin (F2 PriceBelowStart).
 *
 * There is no trade authorization (D3 signs creates only); the fee is the plugin's, charged by the pool on the input
 * (MwzBarkPlugin.algebraFee). The fragments below are human-readable copies of contracts/dogeos/barkswap/abi/*.abi.json
 * (the app ships from frontend/ without them); barkswapSwap.test.mjs checks every one against the exported ABI.
 *
 * Plain ESM over ethers, no React and no app globals: every function takes its provider and addresses explicitly, and
 * no function here reads anything but the DogeOS contracts it is given.
 */
import { Contract, Interface, ZeroAddress, getAddress } from "ethers";
import { GEN8_RATES, GEN8_REVERTS, GEN8_VENUE_BARKSWAP, gen8FeeRate, gen8VenueFor, sqrtAtTick } from "../../shared/evmGen8.mjs";
import {
  GEN8_DEFAULT_SLIPPAGE_BPS,
  gen8MinOut,
  gen8PriceImpactBps,
  gen8ReferenceAmount,
  gen8SizedSlippageBps,
} from "../../shared/evmGen8Swap.mjs";
import { BARK_FEE_DENOMINATOR, barkAlgebraFee, barkFirstBuyEstimate } from "../../shared/evmGen8Bark.mjs";

// ------------------------------------------------------------------ contract fragments (checked against the ABIs)

const LAUNCH_REQUEST_T =
  "(string name,string symbol,string logoURI,string xAccount,string website,string extraLink,bytes32 metadataHash,uint256 targetUsd,uint8 feeChoice,uint8 feeCreatorPct,uint256 firstBuyValue,uint256 minFirstBuyOut,uint256 salt,uint64 openAt)";

/** Barkswap SwapRouter (Algebra Integral 1.2.1 periphery). */
export const BARKSWAP_SWAP_ROUTER_ABI = Object.freeze([
  "function exactInputSingle((address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice) params) payable returns (uint256)",
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function refundNativeToken() payable",
  "function unwrapWNativeToken(uint256 amountMinimum, address recipient) payable",
  "function WNativeToken() view returns (address)",
]);
/** Barkswap QuoterV2. Its `fee` output is uint16 and so cannot carry a launch-window fee; the fee comes from the lens. */
export const BARKSWAP_QUOTER_V2_ABI = Object.freeze([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,address deployer,uint256 amountIn,uint160 limitSqrtPrice) params) payable returns (uint256 amountOut, uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate, uint16 fee)",
]);
/** MwzBarkLauncher: the create, the coin's launch record and the creator ledger (keyed by the coin address). */
export const BARK_LAUNCHER_APP_ABI = Object.freeze([
  `function launch(${LAUNCH_REQUEST_T} req, (uint64 deadline, bytes signature) auth) payable returns (address coin, address pool, uint256 firstBuyOut)`,
  "function plan(uint256 targetUsd) view returns ((uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB))",
  "function launches(address coin) view returns (address pool, uint40 openAt, int24 tickStart, int24 tickGrad, bool gradFeeTaken, address feeCreator, uint40 lastConvertAt, uint128 liqA, uint128 liqB, uint256 graduationFee)",
  "function claimCreator(address coin, address to) returns (uint256 amount)",
  "function proposeCreator(address coin, address next)",
  "function acceptCreator(address coin)",
  "event Launched(address indexed coin, address indexed pool, address indexed creator, address feeCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut, uint40 openAt)",
  "error CoinNotBelowWNative()",
  "error UnknownCoin()",
]);
/** MwzBarkPlugin: the pool's launch record. */
export const BARK_PLUGIN_APP_ABI = Object.freeze([
  "function pools(address pool) view returns (uint160 sqrtGrad, uint40 openAt, bool graduated, uint40 graduatedAt, bool gradBurnDone, address coin, int24 tickStart, int24 tickGrad, uint160 sqrtStart)",
  "error PriceBelowStart()",
  "error TradingNotOpen()",
]);
/** MwzBarkLaunchLens: the fee a swap pays now and bonding progress (the sell cap), keyed by the coin. */
export const BARK_LENS_APP_ABI = Object.freeze([
  "function currentFeeBps(address coin, address sender) view returns (uint256)",
  "function progress(address coin) view returns ((bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
]);
/** The Bark creator-side contracts, keyed by the coin address (gen-8 keyed them by pool id). */
export const BARK_CHOICE_VAULT_APP_ABI = Object.freeze([
  "function pull(address coin) returns (uint256 amount)",
  "function claimCreatorFees(address coin, address to) returns (uint256 amount)",
  "function proposeCreator(address coin, address next)",
  "function acceptCreator(address coin)",
]);
export const BARK_RESERVE_LOCK_APP_ABI = Object.freeze(["function release(address coin) returns (uint256 amount)"]);

const ROUTER_IFACE = new Interface(BARKSWAP_SWAP_ROUTER_ABI);

/** A sell while the price sits at the launch price: QuoterV2 / the router refuse a limit equal to the price. */
export const BARK_NOTHING_TO_SELL = "No coins can be sold back at the launch price yet.";
/** A buy the pool cannot fill in full: never sent, so no DOGE can stay in the router. */
export const BARK_BUY_NOT_FILLED = "Only part of this buy can fill in the pool now. Buy a smaller amount.";
const LAUNCHER_IFACE = new Interface(BARK_LAUNCHER_APP_ABI);

// ------------------------------------------------------------------ Barkswap periphery per chain

/**
 * Barkswap's periphery on Chikyu (docs/dogeos/barkswap-facts.md "Addresses", bytecode-matched to Algebra 1.2.1):
 * the SwapRouter, QuoterV2 and WDOGE (the router's and quoters' WNativeToken()).
 */
export const BARKSWAP_PERIPHERY = Object.freeze({
  6281971: Object.freeze({
    router: getAddress("0x911e5a1630fd1768e5a1710daafabb865cb79531"),
    quoter: getAddress("0x187b41968063cb8a04a5f4d2113844ef2ba21493"),
    wNative: getAddress("0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae"),
  }),
});

const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || "")) && !/^0x0{40}$/i.test(String(v || ""));

function envValue(env, name) {
  return String(env?.[`VITE_${name}`] ?? env?.[name] ?? "").trim().split("@")[0].trim();
}

/**
 * The chain's Barkswap router, quoter and wrapped native: EVM_GEN8_BARKSWAP_ROUTER_<id> / _QUOTER_<id> /
 * EVM_GEN8_WNATIVE_<id> (VITE_ prefixed in the app) when set, else BARKSWAP_PERIPHERY. A set but malformed value is
 * null (fail closed: no trade), never the default. Null for a chain that is not on the Barkswap venue.
 */
export function barkswapPeripheryFor(chainId, env = {}) {
  const id = Number(chainId);
  if (gen8VenueFor(id) !== GEN8_VENUE_BARKSWAP) return null;
  const known = BARKSWAP_PERIPHERY[id] || {};
  const pick = (name, fallback) => {
    const raw = envValue(env, `${name}_${id}`);
    if (raw) return isAddr(raw) ? getAddress(raw) : null;
    return fallback || null;
  };
  return {
    router: pick("EVM_GEN8_BARKSWAP_ROUTER", known.router),
    quoter: pick("EVM_GEN8_BARKSWAP_QUOTER", known.quoter),
    wNative: pick("EVM_GEN8_WNATIVE", known.wNative),
  };
}

// ------------------------------------------------------------------ calldata (pure)

function positive(v, label) {
  const n = BigInt(v);
  if (n <= 0n) throw new Error(`${label} must be above zero.`);
  return n;
}

/** The ExactInputSingleParams of one Bark swap. side "buy": WDOGE in; "sell": coin in. */
export function barkSwapParams({ side, wNative, coin, launcher, recipient, deadline, amountIn, minOut = 0n, limitSqrtPrice = 0n }) {
  const buy = side === "buy";
  if (!buy && side !== "sell") throw new Error(`Unknown trade side ${side}.`);
  return {
    tokenIn: getAddress(buy ? wNative : coin),
    tokenOut: getAddress(buy ? coin : wNative),
    deployer: getAddress(launcher),
    recipient: getAddress(recipient),
    deadline: BigInt(deadline),
    amountIn: positive(amountIn, "The amount"),
    amountOutMinimum: BigInt(minOut),
    limitSqrtPrice: BigInt(limitSqrtPrice),
  };
}

/**
 * A buy: { to: router, data, value: amountIn }. Without a price limit one exactInputSingle (the whole input fills);
 * with one, multicall(exactInputSingle, refundNativeToken) so the unfilled DOGE is refunded in the same transaction.
 */
export function buildBarkBuyCall({ router, wNative, coin, launcher, recipient, amountIn, minOut, deadline, limitSqrtPrice = 0n }) {
  const params = barkSwapParams({ side: "buy", wNative, coin, launcher, recipient, deadline, amountIn, minOut, limitSqrtPrice });
  const swap = ROUTER_IFACE.encodeFunctionData("exactInputSingle", [params]);
  const data =
    params.limitSqrtPrice === 0n ? swap : ROUTER_IFACE.encodeFunctionData("multicall", [[swap, ROUTER_IFACE.encodeFunctionData("refundNativeToken", [])]]);
  return { to: getAddress(router), data, value: params.amountIn };
}

/**
 * A sell: { to: router, data, value: 0 } = multicall(exactInputSingle(coin -> WDOGE to the router, price limit),
 * unwrapWNativeToken(minOut, seller)). The router must be approved for the coins first. The price limit is required:
 * the coin's start price (barkSellLimitSqrtPrice), so an oversized sell is cut there (F2).
 */
export function buildBarkSellCall({ router, wNative, coin, launcher, seller, amountIn, minOut, deadline, limitSqrtPrice }) {
  if (limitSqrtPrice == null || BigInt(limitSqrtPrice) <= 0n) throw new Error("A Barkswap sell needs the coin's start price as its price limit.");
  // Recipient 0: Algebra's router reads it as itself, then unwrapWNativeToken pays the seller native DOGE.
  const params = barkSwapParams({ side: "sell", wNative, coin, launcher, recipient: ZeroAddress, deadline, amountIn, minOut, limitSqrtPrice });
  const swap = ROUTER_IFACE.encodeFunctionData("exactInputSingle", [params]);
  const unwrap = ROUTER_IFACE.encodeFunctionData("unwrapWNativeToken", [params.amountOutMinimum, getAddress(seller)]);
  return { to: getAddress(router), data: ROUTER_IFACE.encodeFunctionData("multicall", [[swap, unwrap]]), value: 0n };
}

/** Decodes a router call built above: { calls: [{ name, args }], swap: params, unwrap, refund }. Throws on anything else. */
export function decodeBarkRouterCall(data) {
  const top = ROUTER_IFACE.parseTransaction({ data });
  if (!top) throw new Error("Not a Barkswap SwapRouter call.");
  const inner = top.name === "multicall" ? Array.from(top.args[0]) : [data];
  const calls = inner.map((d) => {
    const p = ROUTER_IFACE.parseTransaction({ data: d });
    if (!p) throw new Error("Not a Barkswap SwapRouter call.");
    return { name: p.name, args: p.args };
  });
  const swaps = calls.filter((c) => c.name === "exactInputSingle");
  if (swaps.length !== 1) throw new Error("A Barkswap trade has exactly one swap.");
  const s = swaps[0].args[0];
  const swap = {
    tokenIn: getAddress(s.tokenIn),
    tokenOut: getAddress(s.tokenOut),
    deployer: getAddress(s.deployer),
    recipient: getAddress(s.recipient),
    deadline: BigInt(s.deadline),
    amountIn: BigInt(s.amountIn),
    amountOutMinimum: BigInt(s.amountOutMinimum),
    limitSqrtPrice: BigInt(s.limitSqrtPrice),
  };
  const u = calls.find((c) => c.name === "unwrapWNativeToken");
  return {
    multicall: top.name === "multicall",
    calls: calls.map((c) => c.name),
    swap,
    unwrap: u ? { amountMinimum: BigInt(u.args[0]), recipient: getAddress(u.args[1]) } : null,
    refund: calls.some((c) => c.name === "refundNativeToken"),
  };
}

/**
 * gen-8 F14 on Barkswap: a native buy with a price limit must end in refundNativeToken (else the unfilled DOGE stays in
 * the router for anyone to take); a sell must end in unwrapWNativeToken to a wallet, swapping to the router itself.
 */
export function assertBarkTradeShape(decoded, { side, wNative }) {
  const w = getAddress(wNative);
  if (side === "buy") {
    if (decoded.swap.tokenIn !== w) throw new Error("A Barkswap buy pays in WDOGE.");
    if (decoded.swap.limitSqrtPrice !== 0n && (!decoded.refund || decoded.calls.at(-1) !== "refundNativeToken")) {
      throw new Error("A price-limited Barkswap buy must refund the unfilled DOGE.");
    }
    if (decoded.unwrap) throw new Error("A Barkswap buy does not unwrap.");
    return;
  }
  if (decoded.swap.tokenOut !== w) throw new Error("A Barkswap sell pays out WDOGE.");
  if (decoded.swap.recipient !== ZeroAddress || !decoded.unwrap || decoded.calls.at(-1) !== "unwrapWNativeToken" || decoded.unwrap.recipient === ZeroAddress) {
    throw new Error("A Barkswap sell must unwrap the DOGE to the seller.");
  }
  if (decoded.swap.limitSqrtPrice === 0n) throw new Error("A Barkswap sell needs the coin's start price as its price limit.");
}

/** The sell price limit: the coin's start price, sqrtAtTick(tickStart) (= MwzBarkPlugin pools(pool).sqrtStart). */
export function barkSellLimitSqrtPrice(tickStart) {
  if (tickStart == null || !Number.isFinite(Number(tickStart))) throw new Error("The coin's start price is unknown.");
  return sqrtAtTick(Number(tickStart));
}

/** QuoterV2.quoteExactInputSingle params for the same swap (deployer = our launcher). */
export function barkQuoteParams({ side, wNative, coin, launcher, amountIn, limitSqrtPrice = 0n }) {
  const p = barkSwapParams({ side, wNative, coin, launcher, recipient: ZeroAddress, deadline: 0n, amountIn, limitSqrtPrice });
  return { tokenIn: p.tokenIn, tokenOut: p.tokenOut, deployer: p.deployer, amountIn: p.amountIn, limitSqrtPrice: p.limitSqrtPrice };
}

/**
 * The router call for a quote (quoteBarkTrade): the same tokens, deployer, amount and price limit the quote used, the
 * quote's minOut, the trader as recipient (buy) or unwrap recipient (sell). Asserts the shape before returning.
 */
export function buildBarkTradeCall({ cfg, quote, account, deadline }) {
  if (!cfg?.router?.address || !cfg?.wNative || !cfg?.launcher) throw new Error("Trading on Barkswap is not set up on this chain yet.");
  if (quote.side === "buy" && quote.partial) throw new Error(BARK_BUY_NOT_FILLED);
  const common = { router: cfg.router.address, wNative: cfg.wNative, coin: quote.coin, launcher: cfg.launcher, amountIn: quote.amountIn, minOut: quote.minOut, deadline, limitSqrtPrice: quote.limitSqrtPrice };
  const call = quote.side === "buy" ? buildBarkBuyCall({ ...common, recipient: account }) : buildBarkSellCall({ ...common, seller: account });
  assertBarkTradeShape(decodeBarkRouterCall(call.data), { side: quote.side, wNative: cfg.wNative });
  return call;
}

// ------------------------------------------------------------------ fees and the sell cap (pure)

/**
 * The fee of a Bark swap for the panel. The pool charges `feeUnits` (MwzBarkPlugin.algebraFee of the rate) on the
 * input: on a buy in DOGE (curve = amountIn x (1e6 - units) / 1e6, as the plugin books it), on a sell in coins
 * (feeCoins = amountIn x units / 1e6); feeWei of a sell is those coins in DOGE at the sell's own price
 * (amountOut x units / (1e6 - units)). The creator's part follows the plugin: 5.6% of the fee in bonding, half after.
 */
export function barkTradeFee({ side, amountIn, amountOut, rateBps, postPhase }) {
  const units = BigInt(barkAlgebraFee(rateBps, side === "buy"));
  const inAmt = BigInt(amountIn);
  let feeWei;
  let curveWei;
  let feeCoins = 0n;
  if (side === "buy") {
    curveWei = (inAmt * (BARK_FEE_DENOMINATOR - units)) / BARK_FEE_DENOMINATOR;
    feeWei = inAmt - curveWei;
  } else {
    feeCoins = (inAmt * units) / BARK_FEE_DENOMINATOR;
    curveWei = BigInt(amountOut);
    feeWei = units >= BARK_FEE_DENOMINATOR ? 0n : (curveWei * units) / (BARK_FEE_DENOMINATOR - units);
  }
  const creatorShareWei = postPhase
    ? (feeWei * BigInt(GEN8_RATES.creatorPostBps)) / BigInt(GEN8_RATES.postBps)
    : (feeWei * BigInt(GEN8_RATES.creatorBondingBps)) / 10_000n;
  return { feeUnits: Number(units), feeWei, curveWei, feeCoins, creatorShareWei };
}

/**
 * The sell cap from the lens (MwzBarkLaunchLens.progress; spec "capped from the lens"): while the price is in the
 * bonding range, the coins the pool takes back before the start price are coinsSoldFromA plus the plugin's fee on
 * them (a sell pays the rate on its input). Null once the price is at or past graduation (position B holds coins too;
 * the sell's start-price limit still cuts an oversized sell).
 */
export function barkMaxSellableFromProgress(progress, rateBps) {
  if (!progress) return null;
  if (progress.postPhase) return null;
  const sold = BigInt(progress.coinsSoldFromA ?? 0n);
  if (sold <= 0n) return 0n;
  const units = BigInt(barkAlgebraFee(rateBps, false));
  if (units >= BARK_FEE_DENOMINATOR) return sold;
  return (sold * BARK_FEE_DENOMINATOR) / (BARK_FEE_DENOMINATOR - units);
}

// ------------------------------------------------------------------ chain reads (DogeOS contracts only)

/**
 * The launcher's and the plugin's record of a coin (launcher.launches(coin), plugin.pools(pool)), or null when the
 * token is not a coin of this launcher. Same field names as the V4 pool record where they mean the same thing.
 */
export async function readBarkPoolRecord({ provider, cfg, token }) {
  const coin = getAddress(token);
  const l = await new Contract(cfg.launcher, BARK_LAUNCHER_APP_ABI, provider).launches(coin);
  const pool = l.pool ?? l[0];
  if (!pool || pool === ZeroAddress) return null;
  const p = await new Contract(cfg.plugin, BARK_PLUGIN_APP_ABI, provider).pools(pool);
  const openAt = Number(l.openAt);
  const graduatedAt = Number(p.graduatedAt);
  return {
    venue: GEN8_VENUE_BARKSWAP,
    poolId: null,
    poolKey: null,
    pool: getAddress(pool),
    coin,
    creator: getAddress(l.feeCreator),
    openAt,
    launchTime: openAt,
    graduated: Boolean(p.graduated),
    graduatedAt: graduatedAt > 0 ? graduatedAt : null,
    tickStart: Number(l.tickStart),
    tickGrad: Number(l.tickGrad),
    liqA: BigInt(l.liqA),
    sqrtStart: BigInt(p.sqrtStart),
    sqrtGrad: BigInt(p.sqrtGrad),
    // MwzBarkPlugin.feeConfig() is compile-time and equal to gen-8's (shared GEN8_RATES)
    fees: { ...GEN8_RATES },
  };
}

/**
 * The coin's pool record from the API's Barkswap state (GET /api/evm/campaign-state: token, openAt, latched,
 * gen8.pool / tickStart / tickGrad), so a quote per keystroke reads no launcher or plugin. These fields are fixed at
 * launch (latched only changes once); null for anything that is not a complete Barkswap state.
 */
export function barkRecordFromState(state) {
  const g = state?.gen8;
  if (g?.venue !== GEN8_VENUE_BARKSWAP || !isAddr(g.pool) || !isAddr(state?.token) || g.tickStart == null || g.tickGrad == null) return null;
  const openAt = Number(state.openAt ?? state.tradeFee?.openAt ?? 0);
  return {
    venue: GEN8_VENUE_BARKSWAP,
    poolId: null,
    poolKey: null,
    pool: getAddress(g.pool),
    coin: getAddress(state.token),
    openAt,
    launchTime: openAt,
    graduated: Boolean(state.latched),
    tickStart: Number(g.tickStart),
    tickGrad: Number(g.tickGrad),
    fees: { ...GEN8_RATES },
  };
}

/** lens.progress(coin) with its fields as BigInt / boolean, or null without a lens or when it does not answer. */
export async function readBarkProgress({ provider, cfg, coin }) {
  if (!cfg?.lens) return null;
  try {
    const p = await new Contract(cfg.lens, BARK_LENS_APP_ABI, provider).progress(getAddress(coin));
    return {
      graduated: Boolean(p.graduated),
      postPhase: Boolean(p.postPhase),
      sqrtPriceX96: BigInt(p.sqrtPriceX96),
      coinsSoldFromA: BigInt(p.coinsSoldFromA),
      coinsInA: BigInt(p.coinsInA),
    };
  } catch {
    return null;
  }
}

/** The rate (bps) a swap from `sender` pays now: the lens (the plugin's own math), else the same rule from the record. */
export async function readBarkFeeBps({ provider, cfg, coin, sender, record = null, postPhase = null }) {
  if (cfg?.lens) {
    try {
      return Number(await new Contract(cfg.lens, BARK_LENS_APP_ABI, provider).currentFeeBps(getAddress(coin), getAddress(sender)));
    } catch {
      // fall through to the computed rate
    }
  }
  const r = record || (await readBarkPoolRecord({ provider, cfg, token: coin }));
  const now = Number((await provider.getBlock("latest")).timestamp);
  return gen8FeeRate({ postPhase: postPhase ?? r.graduated, openAt: r.openAt, nowTs: now, fees: r.fees });
}

/** The coins a sell can hand back now before the start price (barkMaxSellableFromProgress); null = no cap known. */
export async function barkMaxSellable({ provider, cfg, coin, sender = null }) {
  const progress = await readBarkProgress({ provider, cfg, coin });
  if (!progress) return null;
  if (progress.postPhase) return null;
  const rate = await readBarkFeeBps({ provider, cfg, coin, sender: sender || cfg.router?.address || ZeroAddress, postPhase: false });
  return barkMaxSellableFromProgress(progress, rate);
}

const QUOTE_FIELDS = ["amountOut", "amountIn", "sqrtPriceX96After", "initializedTicksCrossed", "gasEstimate", "fee"];

/** QuoterV2's answer as named BigInts. */
export function barkQuoteResult(raw) {
  return Object.fromEntries(QUOTE_FIELDS.map((k, i) => [k, BigInt(raw?.[k] ?? raw?.[i] ?? 0n)]));
}

/**
 * Exact-input quote of a Bark trade through QuoterV2 (deployer = our launcher), with the fee split for the panel.
 * side "buy": amountIn DOGE; "sell": amountIn coins, price-limited at the start price, so `amountInUsed` (what the pool
 * takes) can be below `amountIn` (partial = true). The price impact comes from a second quote of 1/1000 of the amount
 * in the same block (null when that cannot be quoted). Returns the V4 quote's fields plus venue, coin, pool,
 * limitSqrtPrice, amountInUsed, partial, feeCoins, sqrtPriceX96After, postPhase and maxSellable (sell, null = no cap).
 */
export async function quoteBarkTrade({ provider, cfg, token, side, amountIn, slippageBps = GEN8_DEFAULT_SLIPPAGE_BPS, sender = null, record = null }) {
  if (!cfg?.quoter || !cfg?.wNative || !cfg?.launcher) throw new Error("No Barkswap quoter is configured for this chain.");
  if (side !== "buy" && side !== "sell") throw new Error(`Unknown trade side ${side}.`);
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new Error("Enter an amount.");
  const pool = record || (await readBarkPoolRecord({ provider, cfg, token }));
  if (!pool) throw new Error("This token has no MemeWarzone pool on this chain.");
  const now = Number((await provider.getBlock("latest")).timestamp);
  if (now < Number(pool.openAt || 0)) throw new Error(GEN8_REVERTS["0xe09f0331"].message);
  const swapSender = sender || cfg.router?.address || ZeroAddress;
  const progress = await readBarkProgress({ provider, cfg, coin: pool.coin });
  const postPhase = progress ? progress.postPhase : pool.graduated;
  const limitSqrtPrice = side === "sell" ? barkSellLimitSqrtPrice(pool.tickStart) : 0n;
  // At the launch price a sell has nothing to fill (and a limit equal to the price reverts in QuoterV2 and the router).
  if (side === "sell" && progress && !progress.postPhase && (progress.coinsSoldFromA === 0n || progress.sqrtPriceX96 <= limitSqrtPrice)) {
    throw new Error(BARK_NOTHING_TO_SELL);
  }
  const quoter = new Contract(cfg.quoter, BARKSWAP_QUOTER_V2_ABI, provider);
  const params = (n) => barkQuoteParams({ side, wNative: cfg.wNative, coin: pool.coin, launcher: cfg.launcher, amountIn: n, limitSqrtPrice });
  const refIn = gen8ReferenceAmount(amount);
  const [feeBps, quotedRaw, refRaw] = await Promise.all([
    readBarkFeeBps({ provider, cfg, coin: pool.coin, sender: swapSender, record: pool, postPhase }),
    quoter.quoteExactInputSingle.staticCall(params(amount)).catch((error) => {
      // without a lens the launch-price case shows up here, as QuoterV2's revert on the sell's limit
      if (side === "sell") throw new Error(BARK_NOTHING_TO_SELL);
      throw error;
    }),
    refIn == null ? null : quoter.quoteExactInputSingle.staticCall(params(refIn)).catch(() => null),
  ]);
  const quoted = barkQuoteResult(quotedRaw);
  const ref = refRaw ? barkQuoteResult(refRaw) : null;
  const amountInUsed = quoted.amountIn > 0n && quoted.amountIn < amount ? quoted.amountIn : amount;
  if (side === "buy" && amountInUsed < amount) throw new Error(BARK_BUY_NOT_FILLED);
  if (side === "sell" && (quoted.amountIn === 0n || quoted.amountOut === 0n)) throw new Error(BARK_NOTHING_TO_SELL);
  const priceImpactBps = gen8PriceImpactBps({ amountIn: amountInUsed, amountOut: quoted.amountOut, refIn: ref ? ref.amountIn : null, refOut: ref ? ref.amountOut : null });
  const slippageAuto = slippageBps === "auto";
  const slippage = slippageAuto ? gen8SizedSlippageBps({ chainId: cfg.chainId, priceImpactBps }) : Number(slippageBps);
  const fee = barkTradeFee({ side, amountIn: amountInUsed, amountOut: quoted.amountOut, rateBps: feeBps, postPhase });
  return {
    venue: GEN8_VENUE_BARKSWAP,
    side,
    amountIn: amount,
    amountInUsed,
    partial: amountInUsed < amount,
    amountOut: quoted.amountOut,
    minOut: gen8MinOut(quoted.amountOut, slippage),
    slippageBps: slippage,
    slippageAuto,
    priceImpactBps,
    feeBps,
    feeUnits: fee.feeUnits,
    feeWei: fee.feeWei,
    feeCoins: fee.feeCoins,
    curveWei: fee.curveWei,
    creatorShareWei: fee.creatorShareWei,
    graduated: pool.graduated,
    postPhase,
    poolId: null,
    poolKey: null,
    pool: pool.pool,
    coin: pool.coin,
    limitSqrtPrice,
    sqrtPriceX96After: quoted.sqrtPriceX96After,
    maxSellable: side === "sell" && progress ? barkMaxSellableFromProgress(progress, feeBps) : null,
  };
}

// ------------------------------------------------------------------ create (pure)

/** launcher.plan(target) as the app's plan shape, tagged with the venue (the first-buy estimate needs liqA). */
export async function readBarkLaunchPlan({ provider, launcher, targetUsd }) {
  const p = await new Contract(launcher, BARK_LAUNCHER_APP_ABI, provider).plan(BigInt(targetUsd));
  const v = p.mc !== undefined ? p : p[0];
  return {
    venue: GEN8_VENUE_BARKSWAP,
    marketCapNative: BigInt(v.mc ?? v[0]),
    virtualNative: BigInt(v.vN ?? v[1]),
    virtualToken: BigInt(v.vT ?? v[2]),
    tickStart: Number(v.tickStart ?? v[3]),
    tickGrad: Number(v.tickGrad ?? v[4]),
    liqA: BigInt(v.liqA ?? v[5]),
    liqB: BigInt(v.liqB ?? v[6]),
  };
}

/** The first-buy estimate on a Bark plan (shared/evmGen8Bark.mjs, the API's own estimate). */
export function barkFirstBuyOnPlan({ valueWei, plan }) {
  return barkFirstBuyEstimate({ valueWei, tickStart: plan.tickStart, tickGrad: plan.tickGrad, liqA: plan.liqA });
}

/**
 * Checks a Barkswap create authorization (POST /api/routing/create-authorization on 6281971, frontend/api/dev-fix/
 * evmGen8CreateAuthorization.js) against the app's Bark config: venue barkswap, our plugin, and a coin address that
 * sorts below WDOGE (launch() reverts CoinNotBelowWNative otherwise). Returns the predicted coin.
 */
export function assertBarkCreateAuthorization(auth, cfg) {
  if (auth?.venue !== GEN8_VENUE_BARKSWAP || (auth?.generation?.venue && auth.generation.venue !== GEN8_VENUE_BARKSWAP)) {
    throw new Error("The create authorization is not for a Barkswap launch.");
  }
  if (auth.hook) throw new Error("The create authorization names a Uniswap hook; DogeOS launches on Barkswap.");
  if (!isAddr(auth.plugin) || getAddress(auth.plugin) !== getAddress(cfg.plugin)) throw new Error("The create authorization names another pool plugin.");
  const coin = auth?.coin?.address;
  if (!isAddr(coin)) throw new Error("The create authorization has no coin address.");
  if (cfg.wNative && BigInt(getAddress(coin)) >= BigInt(getAddress(cfg.wNative))) {
    throw new Error("The coin address in the create authorization does not sort below WDOGE. Press Deploy again.");
  }
  return getAddress(coin);
}

/** The coin a Bark launch created, from its Launched event, or null. */
export function parseBarkLaunch(receipt, launcher) {
  for (const log of receipt?.logs || []) {
    if (launcher && String(log.address).toLowerCase() !== String(launcher).toLowerCase()) continue;
    let parsed = null;
    try {
      parsed = LAUNCHER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null; // other contracts' logs in the same transaction
    }
    if (parsed?.name !== "Launched") continue;
    const a = parsed.args;
    return {
      venue: GEN8_VENUE_BARKSWAP,
      token: getAddress(a.coin),
      coin: getAddress(a.coin),
      pool: getAddress(a.pool),
      poolId: null,
      creator: getAddress(a.creator),
      hookCreator: getAddress(a.feeCreator),
      feeCreator: getAddress(a.feeCreator),
      firstBuyIn: BigInt(a.firstBuyIn),
      firstBuyOut: BigInt(a.firstBuyOut),
      tickStart: Number(a.tickStart),
      tickGrad: Number(a.tickGrad),
      liqA: BigInt(a.liqA),
      liqB: BigInt(a.liqB),
      openAt: Number(a.openAt),
    };
  }
  return null;
}

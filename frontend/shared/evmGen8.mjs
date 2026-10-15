/**
 * EVM launch generation 8 (Uniswap V4 pool with the MemeWarzone hook; docs/evm-launch/EVM_GEN8_V4_DESIGN.md on
 * build/evm-gen8). Plain ESM, no dependencies besides ethers' ABI coder and keccak, so the API, the app and the node
 * tests share one implementation of:
 *
 *   - the pool key and pool id of a coin (GEN8_INTERNAL_AUDIT.md 10: keccak256(abi.encode(address(0), token,
 *     0x800000, 10, hook)));
 *   - the pool maths (currency0 = native, currency1 = coin): price and fully diluted market cap from sqrtPriceX96,
 *     bonding progress from the pool price and position A (the same integer maths as the indexer's evmGen8Math.ts
 *     and MwzLaunchLens.progress);
 *   - the launcher's create authorization (MwzV4Launcher.hashRequest / authorizationDigest, EIP-191 personal_sign);
 *   - the creator first buy estimate (exact-input V4 swap in position A at the bonding rate).
 *
 * Every function is integer-exact against the Solidity it names. Nothing here touches a network.
 */
import { AbiCoder, getAddress, id as keccakId, keccak256, toUtf8Bytes } from "ethers";

export const EVM_GEN8_FACTORY_GENERATION = 8;
export const EVM_GEN8_CAMPAIGN_GENERATION = 8;
/** curve_trades.venue and dex_trades.execution_source written by the gen-8 indexer (evmGen8Store.ts). */
export const GEN8_CURVE_VENUE = "gen8";
export const GEN8_EXECUTION_SOURCE = "gen8_v4";
/** reward_events.matched_activity_source of gen-8 HookFee / Graduated rows. */
export const GEN8_REWARD_SOURCE = "gen8_hook";
/** What the API answers for "which trade path does this coin use" (D9: never the import route). */
export const GEN8_TRADE_PATH = "gen8_pool";

export const WAD = 10n ** 18n;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const BPS = 10_000n;
export const GEN8_TOTAL_SUPPLY = 1_000_000_000n * WAD;
export const GEN8_COINS_A = 850_000_000n * WAD;
export const GEN8_COINS_B = 130_000_000n * WAD;
export const GEN8_CREATOR_RESERVE = 20_000_000n * WAD;
export const GEN8_FIRST_BUY_MAX = 700_000_000n * WAD;
export const GEN8_TICK_SPACING = 10;
export const GEN8_DYNAMIC_FEE_FLAG = 0x800000;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_USABLE_TICK = -887270;

/** MwzV4Launcher L1 / D13 constants (bps). */
export const GEN8_RATES = Object.freeze({
  bondingBps: 200,
  postBps: 100,
  creatorPostBps: 50,
  sniperStartBps: 9000,
  creatorBondingBps: 560,
  sniperWindowSeconds: 60,
  graduationFeeBps: 200,
});

/** MwzV4Launcher L2 targets (USD, 18 decimals). The $150 one exists on testnets and local chains only. */
export const GEN8_TARGET_FAST_USD = 30_000n * WAD;
export const GEN8_TARGET_DEFAULT_USD = 50_000n * WAD;
export const GEN8_TARGET_TEST_USD = 150n * WAD;
/** Testnets and the local chain. DogeOS Chikyu (6281971) launches at the $150 target (barkswap spec section 2). */
export const GEN8_TEST_TARGET_CHAIN_IDS = Object.freeze([97, 46630, 31337, 6281971]);

/**
 * The pool venue of each gen-8 chain (barkswap spec section 4, B7): `v4` = Uniswap V4 pools with MwzLaunchHook
 * (BNB, Robinhood, the local chain), `barkswap` = Barkswap (Algebra Integral) custom pools with MwzBarkLauncher and
 * MwzBarkPlugin (DogeOS). Rows keep the gen-8 identity on both venues (venue 'gen8', execution_source 'gen8_v4');
 * the venue only selects which contracts the API, app and indexer talk to. The indexer keeps the same map in
 * realtime-indexer/src/evm/evmGen8Config.ts (GEN8_CHAIN_VENUE, without the local chain).
 */
export const GEN8_VENUE_V4 = "v4";
export const GEN8_VENUE_BARKSWAP = "barkswap";
export const GEN8_CHAIN_VENUE = Object.freeze({ 56: GEN8_VENUE_V4, 97: GEN8_VENUE_V4, 4663: GEN8_VENUE_V4, 46630: GEN8_VENUE_V4, 31337: GEN8_VENUE_V4, 6281971: GEN8_VENUE_BARKSWAP });

/** The chain's gen-8 venue ("v4" | "barkswap"), or null for a chain without gen-8. */
export function gen8VenueFor(chainId) {
  const id = Number(chainId);
  return Number.isInteger(id) && Object.hasOwn(GEN8_CHAIN_VENUE, id) ? GEN8_CHAIN_VENUE[id] : null;
}

export const GEN8_FEE_CHOICES = Object.freeze({ keep: 1, holders: 2, split: 3, buyback: 4 });
export const GEN8_FEE_CHOICE_NAMES = Object.freeze({ 1: "keep", 2: "holders", 3: "split", 4: "buyback" });

export const GEN8_CREATE_AUTH_TYPE = keccakId("MWZ_GEN8_CREATE_AUTH");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const coder = AbiCoder.defaultAbiCoder();

export function isGen8TargetAllowed(chainId, targetUsdWad) {
  let t;
  try {
    t = BigInt(targetUsdWad);
  } catch {
    return false;
  }
  if (t === GEN8_TARGET_FAST_USD || t === GEN8_TARGET_DEFAULT_USD) return true;
  return t === GEN8_TARGET_TEST_USD && GEN8_TEST_TARGET_CHAIN_IDS.includes(Number(chainId));
}

/** True for a campaigns row (or API item) of generation 8. */
export function isGen8Generation(factoryGeneration) {
  return Number(factoryGeneration) === EVM_GEN8_FACTORY_GENERATION;
}

// ------------------------------------------------------------------ pool key and id

/** MwzLaunchHook.poolKeyFor(token): native vs coin, dynamic fee, spacing 10, our hook. */
export function gen8PoolKey(token, hook) {
  return {
    currency0: ZERO_ADDRESS,
    currency1: getAddress(token),
    fee: GEN8_DYNAMIC_FEE_FLAG,
    tickSpacing: GEN8_TICK_SPACING,
    hooks: getAddress(hook),
  };
}

/** PoolId = keccak256(abi.encode(PoolKey)), lower-case 0x hex (the indexer's evm_gen8_pools.pool_id). */
export function gen8PoolId(token, hook) {
  const k = gen8PoolKey(token, hook);
  return keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks])).toLowerCase();
}

// ------------------------------------------------------------------ TickMath and pool maths

const MAX_UINT256 = (1n << 256n) - 1n;
const TICK_C = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** TickMath.getSqrtPriceAtTick (v4-core), BigInt port. */
export function sqrtAtTick(tick) {
  const t = Number(tick);
  const absTick = Math.abs(t);
  if (!Number.isInteger(t) || absTick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, c] of TICK_C) if ((absTick & bit) !== 0) ratio = (ratio * c) >> 128n;
  if (t > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Native wei per whole coin at sqrtPriceX96 (V4 price = coins per native). Floor. */
export function nativePerCoinWei(sqrtPriceX96) {
  const s = BigInt(sqrtPriceX96);
  if (s <= 0n) return 0n;
  return (Q192 * WAD) / (s * s);
}

/** Fully diluted market cap in native wei: price x 1B (gen-6/7 rule, factory_generation >= 6). */
export function gen8MarketCapWei(sqrtPriceX96) {
  return (nativePerCoinWei(sqrtPriceX96) * GEN8_TOTAL_SUPPLY) / WAD;
}

/**
 * Bonding progress (design 6.4: coins sold from A / A's coins) from the pool price, exactly as MwzLaunchLens.progress:
 * capacity = getAmount1Delta(sqrtGrad, sqrtStart, liqA, roundUp), sold = capacity - getAmount1Delta(sqrtGrad, price,
 * liqA, roundDown). liqA is the launch liquidity (PoolLaunched.liqA), so the 2% graduation fee does not move it. (The
 * indexer's token_stats.sold_tokens floors both ends and can be 1 wei lower.) Graduated = complete.
 */
export function gen8Progress({ liqA, tickStart, tickGrad, sqrtPriceX96, graduated = false }) {
  const L = BigInt(liqA);
  const sqrtStart = sqrtAtTick(tickStart);
  const sqrtGrad = sqrtAtTick(tickGrad);
  const span = L * (sqrtStart - sqrtGrad);
  const capacityRaw = span / Q96 + (span % Q96 === 0n ? 0n : 1n);
  const s = sqrtPriceX96 == null ? null : BigInt(sqrtPriceX96);
  if (graduated || (s !== null && s <= sqrtGrad)) return { soldRaw: capacityRaw, capacityRaw, bps: 10_000, pct: 100, complete: true };
  if (s === null || s >= sqrtStart) return { soldRaw: 0n, capacityRaw, bps: 0, pct: 0, complete: false };
  const soldRaw = capacityRaw - (L * (s - sqrtGrad)) / Q96;
  const bps = capacityRaw > 0n ? Math.min(10_000, Number((soldRaw * 10_000n) / capacityRaw)) : 0;
  return { soldRaw, capacityRaw, bps, pct: bps / 100, complete: false };
}

/**
 * F1 (2026-10-12): the pool's current phase from its price, as MwzLaunchLens.progress.postPhase and the indexer's
 * gen8PricePhase: post when sqrtPriceX96 <= sqrtAtTick(tickGrad) (V4 price is coins per native, so the coin price is at
 * or past the graduation price), else bonding. Null price (no swap read) = null.
 */
export function gen8PostPhase(sqrtPriceX96, tickGrad) {
  if (sqrtPriceX96 == null || tickGrad == null) return null;
  return BigInt(sqrtPriceX96) <= sqrtAtTick(Number(tickGrad));
}

/**
 * The platform status of a gen-8 coin (founder 2026-10-12, the indexer's gen8PlatformStatus): 'graduated' only when
 * the one-time latch is set (Graduated event, evm_gen8_pools.graduated_block, hook pools().graduated) AND the pool is
 * in its post phase now; a latched coin whose price fell back into range A is 'bonding' again.
 */
export function gen8PlatformStatus({ latched, postPhase }) {
  return latched && postPhase === true ? "graduated" : "bonding";
}

/** MwzReserveLock.RESERVE_RELEASE_DELAY: the creator reserve releases no earlier than graduatedAt + 1 h. */
export const GEN8_RESERVE_RELEASE_DELAY_SECONDS = 3600;

/** LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, amount1) (v4-periphery). */
export function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  let a = BigInt(sqrtA);
  let b = BigInt(sqrtB);
  if (a > b) [a, b] = [b, a];
  return (BigInt(amount1) * Q96) / (b - a);
}

/** SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp(sqrtP, L, amountIn, add = true). */
function nextSqrtFromAmount0In(sqrtP, L, amountIn) {
  if (amountIn === 0n) return sqrtP;
  const numerator1 = L << 96n;
  const product = amountIn * sqrtP;
  const denominator = numerator1 + product;
  // mulDivRoundingUp(numerator1, sqrtP, denominator)
  const n = numerator1 * sqrtP;
  return n / denominator + (n % denominator === 0n ? 0n : 1n);
}

// ------------------------------------------------------------------ fees

/**
 * MwzFeeMath.rate: the bps a swap pays now (launcher's first buy: the bonding rate). F1 (2026-10-12): the post rate
 * applies when the swap STARTS at or past the graduation price (`postPhase`, see gen8PostPhase), not when the latch is
 * set; `graduated` is the older name of the same input. B: the 60 s launch decay runs from `openAt` (older name
 * `launchTime`).
 */
export function gen8FeeRate({ graduated = false, postPhase, isLauncher = false, launchTime, openAt, nowTs, fees = GEN8_RATES }) {
  if (postPhase ?? graduated) return Number(fees.postBps);
  if (isLauncher) return Number(fees.bondingBps);
  const end = Number(openAt ?? launchTime) + GEN8_RATES.sniperWindowSeconds;
  if (Number(nowTs) >= end) return Number(fees.bondingBps);
  let left = end - Number(nowTs);
  if (left > GEN8_RATES.sniperWindowSeconds) left = GEN8_RATES.sniperWindowSeconds;
  return Number(fees.bondingBps) + Math.floor(((Number(fees.sniperStartBps) - Number(fees.bondingBps)) * left) / GEN8_RATES.sniperWindowSeconds);
}

/** Exact-input buy at `rate`: curve cost = floor(g * B / (B + rate)), fee = the rest (MwzLaunchHook beforeSwap). */
export function gen8ExactInBuySplit(valueWei, rateBps) {
  const g = BigInt(valueWei);
  const cost = (g * BPS) / (BPS + BigInt(rateBps));
  return { costWei: cost, feeWei: g - cost };
}

/** SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, L, roundUp). */
function amount0Delta(sqrtA, sqrtB, L, roundUp) {
  let a = sqrtA;
  let b = sqrtB;
  if (a > b) [a, b] = [b, a];
  const numerator1 = L << 96n;
  const numerator2 = b - a;
  if (roundUp) {
    const n = numerator1 * numerator2;
    const x = n / b + (n % b === 0n ? 0n : 1n);
    return x / a + (x % a === 0n ? 0n : 1n);
  }
  return (numerator1 * numerator2) / b / a;
}

/** SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, L, roundUp = false). */
function amount1DeltaDown(sqrtA, sqrtB, L) {
  const d = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  return (L * d) / Q96;
}

const floorDiv = (a, b) => Math.floor(a / b);

/**
 * TickBitmap.nextInitializedTickWithinOneWord(tick, spacing, lte = true) over a known set of initialized ticks:
 * the highest initialized tick at or below `tick` in the same 256-bit word, else the word's first tick.
 */
function nextInitializedTickLte(tick, initialized) {
  const compressed = floorDiv(tick, GEN8_TICK_SPACING);
  const bitPos = ((compressed % 256) + 256) % 256;
  const wordStart = compressed - bitPos;
  let best = null;
  for (const t of initialized) {
    const c = t / GEN8_TICK_SPACING;
    if (c <= compressed && c >= wordStart && (best === null || c > best)) best = c;
  }
  return best !== null ? { tickNext: best * GEN8_TICK_SPACING, initialized: true } : { tickNext: wordStart * GEN8_TICK_SPACING, initialized: false };
}

/**
 * An exact-input buy (native in, zeroForOne, no price limit, LP fee 0) of `amountIn` native into a freshly launched
 * pool at sqrtAtTick(tickStart): the Pool.swap loop of v4-core step by step (bitmap words, SwapMath.computeSwapStep
 * rounding, the unspent dust of the last step kept by the pool), positions A [tickGrad, tickStart] with liquidity
 * liqA and B [MIN_USABLE_TICK, tickGrad] with liqB. Returns the coins out.
 */
export function gen8SimulateFreshExactInBuy({ amountIn, tickStart, tickGrad, liqA, liqB = 0n }) {
  const ticks = [tickStart, tickGrad, MIN_USABLE_TICK];
  // liquidityNet per initialized tick (lower +L, upper -L)
  const net = new Map([[tickStart, -liqA], [tickGrad, liqA - liqB], [MIN_USABLE_TICK, liqB]]);
  let sqrtP = sqrtAtTick(tickStart);
  let tick = tickStart;
  let liq = 0n; // the pool starts at A's upper tick, where A is not yet active
  let remaining = BigInt(amountIn);
  let out = 0n;
  for (let guard = 0; remaining > 0n && guard < 100_000; guard += 1) {
    let { tickNext, initialized } = nextInitializedTickLte(tick, ticks);
    if (tickNext < MIN_TICK) tickNext = MIN_TICK;
    const sqrtTarget = sqrtAtTick(tickNext);
    let sqrtNext;
    let stepIn;
    const maxIn = liq > 0n ? amount0Delta(sqrtTarget, sqrtP, liq, true) : 0n;
    if (liq === 0n || remaining >= maxIn) {
      sqrtNext = sqrtTarget;
      stepIn = maxIn;
    } else {
      sqrtNext = nextSqrtFromAmount0In(sqrtP, liq, remaining);
      stepIn = remaining; // the rest of the input (SwapMath: amountIn + the dust kept as fee)
    }
    if (liq > 0n) out += amount1DeltaDown(sqrtNext, sqrtP, liq);
    remaining -= stepIn;
    if (sqrtNext === sqrtTarget) {
      if (initialized) liq -= net.get(tickNext) ?? 0n;
      tick = tickNext - 1;
      if (tickNext === MIN_TICK) break;
    }
    sqrtP = sqrtNext;
  }
  return out;
}

/**
 * The creator's first buy inside launch(): exact input of msg.value at the bonding rate (2%) into position A, which
 * starts at sqrtAtTick(tickStart) and holds COINS_A over [tickGrad, tickStart]. Returns the curve cost, the fee and the
 * coins out (the V4 swap replayed step by step, so it equals Launched.firstBuyOut). 0 value = no first buy.
 */
export function gen8FirstBuyEstimate({ valueWei, tickStart, tickGrad }) {
  const value = BigInt(valueWei);
  if (value <= 0n) return { costWei: 0n, feeWei: 0n, coinsOut: 0n, withinA: true, overCap: false };
  const sqrtStart = sqrtAtTick(tickStart);
  const sqrtGrad = sqrtAtTick(tickGrad);
  const L = liquidityForAmount1(sqrtGrad, sqrtStart, GEN8_COINS_A);
  const { costWei, feeWei } = gen8ExactInBuySplit(value, GEN8_RATES.bondingBps);
  // Past the top of A the first buy would take more than A (more than 70% of supply): the launch reverts.
  const withinA = costWei <= amount0Delta(sqrtGrad, sqrtStart, L, true);
  const coinsOut = withinA ? gen8SimulateFreshExactInBuy({ amountIn: costWei, tickStart, tickGrad, liqA: L }) : (L * (sqrtStart - sqrtGrad)) / Q96;
  return { costWei, feeWei, coinsOut, withinA, overCap: !withinA || coinsOut > GEN8_FIRST_BUY_MAX, liquidityA: L };
}

// ------------------------------------------------------------------ create authorization (D3)

/**
 * B scheduled open (MwzV4Launcher.MAX_OPEN_DELAY): a launch whose openAt is later than block time + 30 days reverts
 * OpenAtTooFar; openAt 0 or not after the block time opens trading at once.
 */
export const GEN8_MAX_OPEN_DELAY_SECONDS = 30 * 24 * 60 * 60;

/** The LaunchRequest fields in MwzV4Launcher order (openAt last); values normalised (strings, bigint, numbers). */
export function normalizeGen8LaunchRequest(r) {
  return {
    name: String(r.name ?? ""),
    symbol: String(r.symbol ?? ""),
    logoURI: String(r.logoURI ?? ""),
    xAccount: String(r.xAccount ?? ""),
    website: String(r.website ?? ""),
    extraLink: String(r.extraLink ?? ""),
    metadataHash: String(r.metadataHash ?? "").toLowerCase(),
    targetUsd: BigInt(r.targetUsd),
    feeChoice: Number(r.feeChoice),
    feeCreatorPct: Number(r.feeCreatorPct ?? 0),
    firstBuyValue: BigInt(r.firstBuyValue ?? 0),
    minFirstBuyOut: BigInt(r.minFirstBuyOut ?? 0),
    salt: BigInt(r.salt),
    openAt: BigInt(r.openAt ?? 0),
  };
}

/** MwzV4Launcher.hashRequest: abi.encode of the 13 gen-8 words, then uint64 openAt (B, 2026-10-12). */
export function gen8HashRequest(request) {
  const r = normalizeGen8LaunchRequest(request);
  const h = (s) => keccak256(toUtf8Bytes(s));
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint8", "uint8", "uint256", "uint256", "uint256", "uint64"],
      [h(r.name), h(r.symbol), h(r.logoURI), h(r.xAccount), h(r.website), h(r.extraLink), r.metadataHash, r.targetUsd, r.feeChoice, r.feeCreatorPct, r.firstBuyValue, r.minFirstBuyOut, r.salt, r.openAt],
    ),
  );
}

/**
 * The 32-byte payload the API signer personal-signs; MwzV4Launcher.authorizationDigest is its EIP-191 hash:
 * keccak256(abi.encode(CREATE_AUTH_TYPE, chainId, launcher, creator, hashRequest(req), deadline)).
 */
export function gen8AuthorizationPayload({ chainId, launcher, creator, request, deadline }) {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "address", "bytes32", "uint64"],
      [GEN8_CREATE_AUTH_TYPE, BigInt(chainId), getAddress(launcher), getAddress(creator), gen8HashRequest(request), BigInt(deadline)],
    ),
  );
}

/** The LaunchRequest as the tuple launcher.launch() takes (strings for the uints, JSON-safe). */
export function gen8LaunchRequestJson(request) {
  const r = normalizeGen8LaunchRequest(request);
  return {
    name: r.name,
    symbol: r.symbol,
    logoURI: r.logoURI,
    xAccount: r.xAccount,
    website: r.website,
    extraLink: r.extraLink,
    metadataHash: r.metadataHash,
    targetUsd: r.targetUsd.toString(),
    feeChoice: r.feeChoice,
    feeCreatorPct: r.feeCreatorPct,
    firstBuyValue: r.firstBuyValue.toString(),
    minFirstBuyOut: r.minFirstBuyOut.toString(),
    salt: r.salt.toString(),
    openAt: r.openAt.toString(),
  };
}

/**
 * Hash of the off-chain metadata record that LaunchMetadata carries (bytes32). The API computes it from the record it
 * signs, so the coin's description and links can be checked against the chain later: keccak256 of the canonical JSON
 * (fixed key order, strings) of the six on-chain fields plus the description.
 */
export function gen8MetadataHash({ name, symbol, logoURI, xAccount, website, extraLink, description = "" }) {
  const record = { v: 1, name: String(name ?? ""), symbol: String(symbol ?? ""), logoURI: String(logoURI ?? ""), xAccount: String(xAccount ?? ""), website: String(website ?? ""), extraLink: String(extraLink ?? ""), description: String(description ?? "") };
  return keccak256(toUtf8Bytes(JSON.stringify(record))).toLowerCase();
}

// ------------------------------------------------------------------ revert reasons (fix round 2026-10-12)

/**
 * Custom errors of the gen-8 contracts the API and the app explain to a user, by selector (bytes4 of
 * keccak256("Name()"); pinned against contracts/gen8/abi at build/evm-gen8 20d95e0a in shared/evmGen8.test.mjs).
 * The fix round added OpenAtTooFar / BadOpenAt / TradingNotOpen (B), PriceAboveStart (F2), PriceBelowGraduation /
 * PoolManagerUnlocked / ReserveTooEarly (F1 reserve lock), NotRouterCaller (F4) and BadClaimDeadline (F5).
 */
export const GEN8_REVERTS = Object.freeze({
  "0xd795d50f": { name: "OpenAtTooFar", contract: "MwzV4Launcher", message: "Trading can open at most 30 days after the launch." },
  "0xc8a77a2c": { name: "BadOpenAt", contract: "MwzLaunchHook", message: "The trading open time is outside the allowed window (now to 30 days ahead)." },
  "0xe09f0331": { name: "TradingNotOpen", contract: "MwzLaunchHook", message: "Trading on this coin has not opened yet." },
  "0x2fcb916e": { name: "PriceAboveStart", contract: "MwzLaunchHook", message: "This sell is larger than the bonding range can take back. Sell a smaller amount." },
  "0x40ffbed0": { name: "PriceBelowGraduation", contract: "MwzReserveLock", message: "The creator reserve unlocks only while the price is at or past the graduation price." },
  "0x0e1475a4": { name: "PoolManagerUnlocked", contract: "MwzReserveLock", message: "The creator reserve cannot be released inside a swap. Send the release as its own transaction." },
  "0x7710b1e4": { name: "ReserveTooEarly", contract: "MwzReserveLock", message: "The creator reserve unlocks one hour after graduation." },
  "0x544df468": { name: "NotRouterCaller", contract: "MwzLaunchHook", message: "Only the fee router, its operator or the owner can claim the router fees." },
  "0x289c4adf": { name: "BadClaimDeadline", contract: "MwzCreatorChoiceVault", message: "The holder batch claim deadline must be at least 7 days after it becomes executable and at most 365 days ahead." },
  "0xd66173a5": { name: "NotGraduated", contract: "MwzReserveLock", message: "The creator reserve unlocks after graduation." },
  "0x2d4e6abe": { name: "CreatePaused", contract: "MwzV4Launcher", message: "New generation 8 launches are paused." },
  "0x0f05f5bf": { name: "AuthorizationExpired", contract: "MwzV4Launcher", message: "The create authorization expired. Request a new one." },
  "0x22be437f": { name: "AuthorizationReplayed", contract: "MwzV4Launcher", message: "This create authorization was already used. Request a new one." },
  "0x2ce87eeb": { name: "InvalidAuthorization", contract: "MwzV4Launcher", message: "The create authorization does not match this launch request." },
  "0xc4747426": { name: "FirstBuyTooLarge", contract: "MwzV4Launcher", message: "The first buy is above 70% of the supply." },
  "0xae0f6505": { name: "FirstBuyTooSmall", contract: "MwzV4Launcher", message: "The first buy returns fewer coins than the slippage bound. Request a new authorization." },
  "0xb4b5c195": { name: "OraclePriceUnavailable", contract: "MwzV4Launcher", message: "The graduation oracle has no fresh price right now." },
  "0x6fe5b27e": { name: "OraclePriceOutOfBand", contract: "MwzV4Launcher", message: "The graduation oracle price is outside the launcher's band." },
  "0xf7139e33": { name: "UnknownPool", contract: "MwzLaunchHook", message: "This coin has no generation 8 pool." },
});

const V4_WRAPPED_ERROR = "0x90bfb865"; // WrappedError(address target, bytes4 selector, bytes reason, bytes details), v4-core CustomRevert

function revertDataOf(errorOrData) {
  if (typeof errorOrData === "string") return errorOrData;
  const e = errorOrData || {};
  for (const v of [e.data, e.error?.data, e.info?.error?.data, e.revert?.data]) {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v)) return v;
  }
  const m = String(e.shortMessage || e.message || "").match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : null;
}

/**
 * The gen-8 custom error behind a revert: { selector, name, contract, message } or null. Takes the revert data (0x
 * hex) or an ethers error. A hook revert inside a swap arrives wrapped by the PoolManager (WrappedError); its inner
 * reason is unwrapped.
 */
export function gen8RevertReason(errorOrData) {
  const data = revertDataOf(errorOrData);
  if (!data || data.length < 10) return null;
  let selector = data.slice(0, 10).toLowerCase();
  if (selector === V4_WRAPPED_ERROR) {
    try {
      const [, , reason] = coder.decode(["address", "bytes4", "bytes", "bytes"], `0x${data.slice(10)}`);
      if (typeof reason === "string" && reason.length >= 10) selector = reason.slice(0, 10).toLowerCase();
    } catch {
      return null;
    }
  }
  const hit = GEN8_REVERTS[selector];
  return hit ? { selector, ...hit } : null;
}

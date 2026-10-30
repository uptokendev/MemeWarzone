/**
 * EVM generation 8 on Barkswap (DogeOS; docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md). The pool
 * maths of the Barkswap venue, next to shared/evmGen8.mjs (the V4 venue), for the API and the app:
 *
 *   - orientation: the coin is token0 and WDOGE token1 (MwzBarkLauncher sorts the coin below WDOGE with the CREATE2
 *     salt), so the Algebra price is WDOGE per coin and RISES on buys; position A = [tickStart, tickGrad] holds only
 *     coins at the start price (V4 is the mirror image: native = currency0, the price falls on buys);
 *   - bonding progress from the pool price, exactly as MwzBarkLaunchLens.progress (v4-core SqrtPriceMath, which the
 *     lens uses);
 *   - the fee: the plugin returns the gen-7 rate as Algebra's overrideFee, charged on the input
 *     (MwzBarkPlugin.algebraFee: r on a sell, r / (1 + r) on a buy, in 1e6 units);
 *   - the creator first buy inside launch(): exact input of msg.value as WDOGE into A from the start price, price limit
 *     the graduation price. One Algebra swap step (A is the only liquidity between tickStart and tickGrad), following
 *     Algebra Integral's PriceMovementMath for an exact input of token1. It sets the slippage bound (the signed
 *     minFirstBuyOut) and the 70% check; on t8's fork recording (test/fixtures/dogeos/barkSwapEvent.json) it equals
 *     Launched.firstBuyOut to the wei (api/lib/evmGen8BarkCreate.test.mjs).
 *
 * Everything is BigInt and touches no network.
 */
import { GEN8_FIRST_BUY_MAX, GEN8_RATES, GEN8_TOTAL_SUPPLY, Q96, WAD, sqrtAtTick } from "./evmGen8.mjs";

const Q192 = Q96 * Q96;
/** Algebra fee units: 1e6 = 100% (MwzBarkPlugin.FEE_DENOMINATOR). */
export const BARK_FEE_DENOMINATOR = 1_000_000n;
const BPS_TO_FEE_UNITS = 100n;

const divUp = (a, b) => a / b + (a % b === 0n ? 0n : 1n);

/** MwzBarkPlugin.algebraFee(rateBps, buy): the Algebra fee (1e6 units, on the input) for a gen-7 rate in bps. */
export function barkAlgebraFee(rateBps, buy) {
  let units = BigInt(rateBps) * BPS_TO_FEE_UNITS;
  if (buy) units = (units * BARK_FEE_DENOMINATOR) / (BARK_FEE_DENOMINATOR + units);
  return Number(units);
}

/** v4-core SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, L, roundUp) (the lens's call). */
function amount0Delta(sqrtA, sqrtB, L, roundUp) {
  let a = BigInt(sqrtA);
  let b = BigInt(sqrtB);
  if (a > b) [a, b] = [b, a];
  const n1 = BigInt(L) << 96n;
  const n2 = b - a;
  if (roundUp) return divUp(divUp(n1 * n2, b), a);
  return (n1 * n2) / b / a;
}

/** WDOGE wei per whole coin at sqrtPriceX96 (Algebra price = token1 per token0 = WDOGE per coin). Floor. */
export function barkPriceNativeWeiPerCoin(sqrtPriceX96) {
  const s = BigInt(sqrtPriceX96);
  if (s <= 0n) return 0n;
  return (s * s * WAD) / Q192;
}

/** Fully diluted market cap in native wei: price x 1B (the gen-8 rule). */
export function barkMarketCapWei(sqrtPriceX96) {
  return (barkPriceNativeWeiPerCoin(sqrtPriceX96) * GEN8_TOTAL_SUPPLY) / WAD;
}

/**
 * F1 on Barkswap (MwzBarkPlugin / MwzBarkLaunchLens.progress.postPhase): post when the price is at or past the
 * graduation price, sqrtPriceX96 >= sqrtAtTick(tickGrad). Null price = null.
 */
export function barkPostPhase(sqrtPriceX96, tickGrad) {
  if (sqrtPriceX96 == null || tickGrad == null) return null;
  return BigInt(sqrtPriceX96) >= sqrtAtTick(Number(tickGrad));
}

/**
 * Bonding progress (coins sold from A / A's coins) from the pool price, as MwzBarkLaunchLens.progress: capacity =
 * getAmount0Delta(sqrtStart, sqrtGrad, liqA, roundUp), sold = capacity - getAmount0Delta(min(price, sqrtGrad), sqrtGrad,
 * liqA, roundDown); 0 at or below the start price, complete at or past the graduation price. liqA is the launch
 * liquidity (Launched.liqA). Same return shape as gen8Progress.
 */
export function barkProgress({ liqA, tickStart, tickGrad, sqrtPriceX96, graduated = false }) {
  const L = BigInt(liqA);
  const sqrtStart = sqrtAtTick(tickStart);
  const sqrtGrad = sqrtAtTick(tickGrad);
  const capacityRaw = amount0Delta(sqrtStart, sqrtGrad, L, true);
  const s = sqrtPriceX96 == null ? null : BigInt(sqrtPriceX96);
  if (graduated || (s !== null && s >= sqrtGrad)) return { soldRaw: capacityRaw, capacityRaw, bps: 10_000, pct: 100, complete: true };
  if (s === null || s <= sqrtStart) return { soldRaw: 0n, capacityRaw, bps: 0, pct: 0, complete: false };
  const soldRaw = capacityRaw - amount0Delta(s, sqrtGrad, L, false);
  const bps = capacityRaw > 0n ? Math.min(10_000, Number((soldRaw * 10_000n) / capacityRaw)) : 0;
  return { soldRaw, capacityRaw, bps, pct: bps / 100, complete: false };
}

/**
 * The creator's first buy inside MwzBarkLauncher.launch (estimate, see the header): msg.value of WDOGE in at the
 * bonding rate (the launcher's swap pays the 2% bonding rate, as Algebra fee units on a buy), one step in A from
 * sqrtAtTick(tickStart) towards sqrtAtTick(tickGrad):
 *   afterFee = value x (1e6 - fee) / 1e6; if afterFee reaches the graduation price the launch reverts (FirstBuyTooLarge:
 *   the swap stops at its limit); else price' = price + afterFee x 2^96 / liqA (rounded down), curve cost =
 *   getToken1Delta(price, price', liqA, roundUp), fee = value - cost, coins out = getToken0Delta(price, price', liqA,
 *   roundDown). Over 70% of supply (700M) also reverts.
 */
export function barkFirstBuyEstimate({ valueWei, tickStart, tickGrad, liqA }) {
  const value = BigInt(valueWei);
  if (value <= 0n) return { costWei: 0n, feeWei: 0n, coinsOut: 0n, withinA: true, overCap: false, feeUnits: 0 };
  const L = BigInt(liqA);
  const feeUnits = barkAlgebraFee(GEN8_RATES.bondingBps, true);
  const fee = BigInt(feeUnits);
  const sqrtStart = sqrtAtTick(tickStart);
  const sqrtGrad = sqrtAtTick(tickGrad);
  const afterFee = (value * (BARK_FEE_DENOMINATOR - fee)) / BARK_FEE_DENOMINATOR;
  const toGrad = divUp((sqrtGrad - sqrtStart) * L, Q96);
  if (afterFee >= toGrad) {
    // the swap would stop at the graduation price with input left over: the launcher reverts the launch
    const all = amount0Delta(sqrtStart, sqrtGrad, L, false);
    return { costWei: toGrad, feeWei: value - toGrad, coinsOut: all, withinA: false, overCap: true, feeUnits };
  }
  const next = sqrtStart + (afterFee << 96n) / L;
  const costWei = next === sqrtStart ? 0n : divUp((next - sqrtStart) * L, Q96);
  const coinsOut = amount0Delta(sqrtStart, next, L, false);
  return { costWei, feeWei: value - costWei, coinsOut, withinA: true, overCap: coinsOut > GEN8_FIRST_BUY_MAX, feeUnits };
}

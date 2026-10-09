/**
 * The indexer's copy of the parts of frontend/shared/evmGen7Curve.mjs it needs: EVM launch generation 7
 * (factory 7 / campaign 6), the constant-product curve with virtual reserves of contracts/gen7
 * (docs/evm-launch/EVM_GEN7_V2_PLAN.md). src/tests/evmGen7Curve.test.ts compares every function here
 * with the shared module, integer for integer.
 *
 *   Y(s)   = ceil(vN * vT / (vT - s))            native the curve holds at `s` tokens sold (plus vN)
 *   buy a  = Y(s + a) - Y(s)                     sell a = Y(s) - Y(s - a)
 *   price  = floor(Y(s) * 1e18 / (vT - s))       wei per whole token (LaunchCampaignGen7._currentPrice)
 *
 * Gen-6 coins (factory 6 / campaign 5) keep the linear curve; nothing here applies to them.
 */

export const EVM_GEN7_FACTORY_GENERATION = 7;
export const EVM_GEN7_CAMPAIGN_GENERATION = 6;

/** LaunchCampaignGen7.ANTI_SNIPER_START_BPS: 90% falling to the base fee over 60 s (G6). Gen-6: 5000. */
export const GEN7_ANTI_SNIPER_START_BPS = 9_000n;

const WAD = 10n ** 18n;

/** A campaign generation that runs the gen-7 contracts (LaunchCampaignGen7 and its quote/stock variants). */
export function isEvmGen7CampaignGeneration(campaignGeneration: number | null | undefined): boolean {
  return Number(campaignGeneration) === EVM_GEN7_CAMPAIGN_GENERATION;
}

function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}

/** LaunchCampaignGen7._curveNative: Y(s), rounded up. Throws when `s` is outside [0, vT). */
export function gen7CurveNative(virtualNative: bigint, virtualToken: bigint, sold: bigint): bigint {
  if (sold < 0n || sold >= virtualToken) throw new Error("sold outside the curve");
  return mulDivCeil(virtualNative, virtualToken, virtualToken - sold);
}

/** Native cost before fee of buying `amount` at `sold` (LaunchCampaignGen7._quoteBuyNoFee). */
export function gen7BuyCostNoFee(virtualNative: bigint, virtualToken: bigint, sold: bigint, amount: bigint): bigint {
  return gen7CurveNative(virtualNative, virtualToken, sold + amount) - gen7CurveNative(virtualNative, virtualToken, sold);
}

/** Native payout before fee of selling `amount` at `sold` (LaunchCampaignGen7._quoteSellNoFee). */
export function gen7SellPayoutNoFee(virtualNative: bigint, virtualToken: bigint, sold: bigint, amount: bigint): bigint {
  return gen7CurveNative(virtualNative, virtualToken, sold) - gen7CurveNative(virtualNative, virtualToken, sold - amount);
}

/** LaunchCampaignGen7._currentPrice: wei per whole token (1e18 units) at `sold`. */
export function gen7SpotPrice(virtualNative: bigint, virtualToken: bigint, sold: bigint): bigint {
  return (gen7CurveNative(virtualNative, virtualToken, sold) * WAD) / (virtualToken - sold);
}

/** LaunchCampaignGen7.graduationNativeTarget: what the curve raises when it sells out. */
export function gen7GraduationRaise(virtualNative: bigint, virtualToken: bigint, curveSupply: bigint): bigint {
  return gen7CurveNative(virtualNative, virtualToken, curveSupply) - gen7CurveNative(virtualNative, virtualToken, 0n);
}

/**
 * Spot price after a buy on the gen-7 curve, from the quote alone (the creator-choice pass's impact
 * estimate). On a constant-product curve the average price of a buy is the geometric mean of the price
 * before and after (cost / tokens = k / ((vT - s)(vT - s - a))), so after = avg^2 / before. Never below
 * `priceBefore`. The linear-curve counterpart (gen-6) is evmCreatorChoice.linearCurvePriceAfter.
 */
export function gen7CurvePriceAfter(priceBefore: bigint, costNoFee: bigint, tokensOut: bigint): bigint {
  if (tokensOut <= 0n || priceBefore <= 0n) return priceBefore;
  const avg = (costNoFee * WAD) / tokensOut;
  const after = (avg * avg) / priceBefore;
  return after > priceBefore ? after : priceBefore;
}

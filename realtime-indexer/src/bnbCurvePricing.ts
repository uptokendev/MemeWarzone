/** Bonding-curve spot and mcap. Matches LaunchCampaign._currentPrice: basePrice + priceSlope * sold / WAD. */

export const BNB_WAD = 1_000_000_000_000_000_000n;

export type BnbCurveState = {
  soldRaw: bigint;
  spotNative: number;
  soldWhole: number;
  mcapNative: number;
};

export function bigintRatio(value: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const whole = value / denominator;
  const remainder = value % denominator;
  return Number(whole) + Number(remainder) / Number(denominator);
}

export function bnbCurveState(
  basePriceRaw: bigint,
  priceSlopeRaw: bigint,
  soldRaw: bigint,
): BnbCurveState {
  const safeSold = soldRaw > 0n ? soldRaw : 0n;
  const spotRaw = basePriceRaw + (priceSlopeRaw * safeSold) / BNB_WAD;
  const spotNative = bigintRatio(spotRaw, BNB_WAD);
  const soldWhole = bigintRatio(safeSold, BNB_WAD);
  const mcapNative = spotNative * soldWhole;
  return {
    soldRaw: safeSold,
    spotNative: Number.isFinite(spotNative) ? spotNative : 0,
    soldWhole: Number.isFinite(soldWhole) ? soldWhole : 0,
    mcapNative: Number.isFinite(mcapNative) && mcapNative > 0 ? mcapNative : 0,
  };
}

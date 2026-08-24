/** Bonding-curve spot and mcap. Matches LaunchCampaign._currentPrice: basePrice + priceSlope * sold / WAD. */

export const BNB_WAD = 1_000_000_000_000_000_000n;

export type BnbCurveState = {
  soldRaw: bigint;
  spotNative: number;
  soldWhole: number;
  mcapNative: number;
};

export function parseRawTokenAmount(value: unknown): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  const text = String(value ?? "0").trim();
  if (!text || text === "0") return 0n;
  const intish = text.match(/^(-?\d+)(?:\.0+)?$/);
  if (intish) {
    try {
      const parsed = BigInt(intish[1]);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }
  const sci = text.match(/^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
  if (sci) {
    const digits = `${sci[2]}${sci[3] || ""}`;
    const exp = Number(sci[4]) - (sci[3] ? sci[3].length : 0);
    if (!Number.isFinite(exp)) return 0n;
    try {
      const magnitude =
        exp >= 0 ? BigInt(digits) * 10n ** BigInt(exp) : BigInt(digits) / 10n ** BigInt(-exp);
      const parsed = sci[1] === "-" ? -magnitude : magnitude;
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }
  const head = text.split(".")[0];
  if (/^-?\d+$/.test(head)) {
    try {
      const parsed = BigInt(head);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }
  return 0n;
}

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

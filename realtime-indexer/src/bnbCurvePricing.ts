/**
 * Bonding-curve spot and mcap. Linear (gen-6 and older): LaunchCampaign._currentPrice, basePrice +
 * priceSlope * sold / WAD. Constant product (gen-7, LaunchCampaignGen7._currentPrice):
 * floor(Y(s) * WAD / (virtualToken - s)) with Y(s) = ceil(virtualNative * virtualToken / (virtualToken - s)).
 * Both report mcap as spot x sold (the same basis for every generation).
 */
import { gen7SpotPrice } from "./evm/evmGen7Curve.js";

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

/** The curve parameters a campaign answers: basePrice/priceSlope (linear) or virtualNative/virtualToken (gen-7). */
export type BnbCurveParams =
  | { kind: "linear"; base: bigint; slope: bigint }
  | { kind: "cp"; virtualNative: bigint; virtualToken: bigint };

/**
 * Gen-7 constant-product state: exact bigint spot (LaunchCampaignGen7._currentPrice), mcap = spot x sold as
 * bnbCurveState. Sold at or beyond virtualToken (never reachable on chain, sold <= curveSupply < vT) or
 * non-positive reserves give a zero spot and mcap, so callers fall back as they do for a missing curve.
 */
export function bnbCpCurveState(
  virtualNative: bigint,
  virtualToken: bigint,
  soldRaw: bigint,
): BnbCurveState {
  const safeSold = soldRaw > 0n ? soldRaw : 0n;
  const soldWholeRaw = bigintRatio(safeSold, BNB_WAD);
  const soldWhole = Number.isFinite(soldWholeRaw) ? soldWholeRaw : 0;
  if (virtualNative <= 0n || virtualToken <= 0n || safeSold >= virtualToken) {
    return { soldRaw: safeSold, spotNative: 0, soldWhole, mcapNative: 0 };
  }
  const spotRaw = gen7SpotPrice(virtualNative, virtualToken, safeSold);
  const spotNative = bigintRatio(spotRaw, BNB_WAD);
  const mcapNative = spotNative * soldWhole;
  return {
    soldRaw: safeSold,
    spotNative: Number.isFinite(spotNative) ? spotNative : 0,
    soldWhole,
    mcapNative: Number.isFinite(mcapNative) && mcapNative > 0 ? mcapNative : 0,
  };
}

/** bnbCurveState for linear params (unchanged), bnbCpCurveState for gen-7 params. */
export function bnbCurveStateFor(params: BnbCurveParams, soldRaw: bigint): BnbCurveState {
  return params.kind === "cp"
    ? bnbCpCurveState(params.virtualNative, params.virtualToken, soldRaw)
    : bnbCurveState(params.base, params.slope, soldRaw);
}

/** The campaign views readBnbCurveParams calls (an ethers Contract with BNB_CURVE_PARAM_FRAGMENTS). */
export type BnbCurveParamReader = {
  basePrice(): Promise<bigint>;
  priceSlope(): Promise<bigint>;
  virtualNative(): Promise<bigint>;
  virtualToken(): Promise<bigint>;
};

/** View fragments for readBnbCurveParams: the linear pair (gen-6 and older) and the gen-7 virtual reserves. */
export const BNB_CURVE_PARAM_FRAGMENTS = [
  "function basePrice() view returns (uint256)",
  "function priceSlope() view returns (uint256)",
  "function virtualNative() view returns (uint256)",
  "function virtualToken() view returns (uint256)",
] as const;

/**
 * Reads a campaign's curve: basePrice()/priceSlope() first, exactly as before gen-7. Only when that fails
 * are virtualNative()/virtualToken() tried (LaunchCampaignGen7 has no linear params). When both fail, the
 * linear read's error is thrown, so callers report what they reported before.
 */
export async function readBnbCurveParams(contract: BnbCurveParamReader): Promise<BnbCurveParams> {
  try {
    const [base, slope] = await Promise.all([contract.basePrice(), contract.priceSlope()]);
    return { kind: "linear", base: BigInt(base), slope: BigInt(slope) };
  } catch (linearError) {
    const cp = await Promise.all([contract.virtualNative(), contract.virtualToken()]).catch(() => null);
    if (!cp || BigInt(cp[1]) <= 0n) throw linearError;
    return { kind: "cp", virtualNative: BigInt(cp[0]), virtualToken: BigInt(cp[1]) };
  }
}

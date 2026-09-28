import { DBC_FIRST_BUY_MAX_BPS, DBC_TRADE_FEE_BPS } from "../../../shared/dbcEconomics.mjs";
import { quoteAlongDbcCurve } from "./dbcLaunchConfigParams.mjs";

/**
 * Tokens a first buy of `quoteLamports` receives on this config's curve (D11).
 * The launch first buy pays the 2% min fee (`enableFirstSwapWithMinFee`).
 */
export function quoteFirstBuyOnConfig(configParams, quoteLamports) {
  const paid = BigInt(quoteLamports);
  if (paid <= 0n) {
    return { tokensOut: 0n, totalSupply: totalSupplyOf(configParams), bps: 0n, afterFeeLamports: 0n };
  }
  const afterFee = (paid * BigInt(10_000 - DBC_TRADE_FEE_BPS)) / 10_000n;
  const totalSupply = totalSupplyOf(configParams);
  let lo = 0n;
  let hi = totalSupply;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const cost = quoteAlongDbcCurve(configParams, mid);
    if (cost <= afterFee) lo = mid;
    else hi = mid - 1n;
  }
  const bps = totalSupply > 0n ? (lo * 10_000n) / totalSupply : 0n;
  return { tokensOut: lo, totalSupply, bps, afterFeeLamports: afterFee };
}

export function firstBuyExceedsCap(quote, maxBps = DBC_FIRST_BUY_MAX_BPS) {
  return quote.bps > BigInt(maxBps);
}

function totalSupplyOf(configParams) {
  return BigInt(configParams?.tokenSupply?.preMigrationTokenSupply?.toString?.() || "0");
}

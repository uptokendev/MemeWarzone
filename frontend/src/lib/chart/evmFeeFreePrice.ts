/**
 * Fee-free price of an EVM curve trade (gen-6 / gen-7 LaunchCampaign).
 *
 * TokensPurchased.cost includes the trade fee (launch fee 50% on gen-6, 90% on gen-7, falling to the
 * base fee over 60 s) and TokensSold.payout is net of it, so native / tokens (the stored price_bnb)
 * is not a price the curve quoted. The indexer stores the fee-free amount as curve_trades.gross_raw;
 * gross_raw / tokens is what the chart draws. Pure: no aliases, no network.
 */

export const EVM_FEE_MAX_BPS = 10_000;
export const EVM_LAUNCH_FEE_WINDOW_SECONDS = 60;
/** Anti-sniper start fee: gen-6 LaunchCampaign 5000, gen-7 LaunchCampaignGen7 9000. */
export const EVM_GEN6_LAUNCH_FEE_START_BPS = 5_000;
export const EVM_GEN7_LAUNCH_FEE_START_BPS = 9_000;

function rawBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+)(?:\.0+)?$/);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(whole) + Number(remainder) / Number(denominator);
}

/**
 * gross_raw / tokens in native per whole token. Null when gross_raw is missing or not a positive
 * integer, or there are no tokens. Both sides use 18 decimals on EVM, so they cancel unless told otherwise.
 */
export function evmFeeFreeTradePrice(
  grossRaw: unknown,
  tokensWei: bigint,
  tokenDecimals = 18,
  nativeDecimals = 18,
): number | null {
  const gross = rawBigInt(grossRaw);
  if (gross == null || gross <= 0n || tokensWei <= 0n) return null;
  const shift = tokenDecimals - nativeDecimals;
  const price = ratio(gross, tokensWei) * 10 ** shift;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** LaunchCampaign(Gen7).currentTradeFeeBps at block time `t` (seconds), integer arithmetic. */
export function evmTradeFeeBpsAt(input: { launchAt: number; t: number; baseFeeBps: number; startBps: number }): number {
  const base = Math.trunc(input.baseFeeBps);
  const end = Math.trunc(input.launchAt) + EVM_LAUNCH_FEE_WINDOW_SECONDS;
  const t = Math.trunc(input.t);
  if (t >= end) return base;
  const left = Math.min(end - t, EVM_LAUNCH_FEE_WINDOW_SECONDS);
  return base + Math.floor(((Math.trunc(input.startBps) - base) * left) / EVM_LAUNCH_FEE_WINDOW_SECONDS);
}

/**
 * The fee-free native amount behind an event amount: buy cost = c + floor(c * bps / 1e4), sell
 * payout = g - floor(g * bps / 1e4). Exact to within a wei of the contract's floor; good for a chart.
 */
export function evmGrossFromEventAmount(side: "buy" | "sell", amountWei: bigint, bps: number): bigint | null {
  const b = BigInt(Math.trunc(bps));
  const max = BigInt(EVM_FEE_MAX_BPS);
  if (amountWei < 0n || b < 0n || b >= max) return null;
  return side === "buy" ? (amountWei * max) / (max + b) : (amountWei * max) / (max - b);
}

/** The price a chart point or pin draws: Solana curve state first (caller), then fee-free EVM, then the fill. */
export function chartTradePrice(
  trade: { pricePerToken?: unknown; feeFreePricePerToken?: unknown },
  solana: boolean,
): number | null {
  const pick = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  if (!solana) {
    const feeFree = trade.feeFreePricePerToken == null ? null : pick(trade.feeFreePricePerToken);
    if (feeFree != null) return feeFree;
  }
  return pick(trade.pricePerToken);
}

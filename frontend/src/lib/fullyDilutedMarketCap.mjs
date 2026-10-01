/**
 * Market cap basis for the new launch generations (founder decision 2026-10-01).
 *
 * EVM generation 6/5 (BNB, Robinhood) and Meteora DBC coins are valued fully diluted: price x the
 * token's total supply, like pump.fun and Jupiter. Older coins (Solana launchpad, EVM gen <= 5) keep
 * price x curve sold, so their history does not jump. A fully diluted coin opens at its curve start
 * price x supply, never at 0: price x sold is 0 before the first buy, which drew every new coin's
 * first candle as one bar from $0.
 */

const WAD = 10n ** 18n;

/** Whole tokens from a raw totalSupply; null when unknown or not positive. */
export function fullyDilutedSupplyWhole(totalSupplyRaw, decimals = 18) {
  if (totalSupplyRaw == null) return null;
  let raw;
  try {
    raw = BigInt(totalSupplyRaw);
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  const whole = Number(raw) / 10 ** Number(decimals);
  return Number.isFinite(whole) && whole > 0 ? whole : null;
}

/** Linear curve spot (wei per whole token) at `soldRaw`: LaunchCampaign._currentPrice. */
export function evmCurveSpotWei(basePriceWei, priceSlopeWei, soldRaw) {
  const sold = BigInt(soldRaw) > 0n ? BigInt(soldRaw) : 0n;
  return BigInt(basePriceWei) + (BigInt(priceSlopeWei) * sold) / WAD;
}

/**
 * Price change per window from the curve spot, for a bonding EVM generation-6 coin.
 *
 * Fills are not prices: a buy's fill is the average across the curve plus the fee, so the old
 * fill-to-fill change showed -3.92% on a BNB coin whose spot was back exactly at its start price.
 * Sold is anchored at its on-chain value now and walked back through the trades, so a trade list that
 * starts mid-history still gives exact spots. A window that starts before the first trade starts at the
 * spot before that trade (the curve's start price for a new coin).
 *
 * @param {{ trades: Array<{ timestamp: number, type: string, tokensWei: bigint }>, soldNowRaw: bigint,
 *   basePriceWei: bigint, priceSlopeWei: bigint, nowSec: number, windows: Record<string, number> }} input
 * @returns {Record<string, number | null>} percent change per window key
 */
export function evmCurveSpotChanges({ trades, soldNowRaw, basePriceWei, priceSlopeWei, nowSec, windows }) {
  const out = {};
  const base = BigInt(basePriceWei ?? 0n);
  if (base <= 0n) {
    for (const key of Object.keys(windows)) out[key] = null;
    return out;
  }
  const ordered = [...(trades || [])]
    .filter((t) => Number(t?.timestamp) > 0)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  // Walk back from today's sold: sold before a trade = sold after it minus its signed amount.
  const soldAfter = new Array(ordered.length);
  let sold = BigInt(soldNowRaw ?? 0n);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    soldAfter[i] = sold;
    const amount = BigInt(ordered[i].tokensWei ?? 0n);
    sold = ordered[i].type === "sell" ? sold + amount : sold - amount;
  }
  const soldBeforeFirst = sold;
  const spot = (soldRaw) => Number(evmCurveSpotWei(base, priceSlopeWei ?? 0n, soldRaw));
  const end = spot(soldNowRaw ?? 0n);
  for (const [key, seconds] of Object.entries(windows)) {
    const startTs = Number(nowSec) - Number(seconds);
    let lastBefore = -1;
    for (let i = 0; i < ordered.length; i += 1) if (Number(ordered[i].timestamp) <= startTs) lastBefore = i;
    const start = lastBefore >= 0 ? spot(soldAfter[lastBefore]) : spot(soldBeforeFirst);
    out[key] = start > 0 && Number.isFinite(end) ? ((end - start) / start) * 100 : null;
  }
  return out;
}

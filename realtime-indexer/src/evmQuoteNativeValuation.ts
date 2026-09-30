/**
 * Native (BNB / ETH) valuation of a MEME/QUOTE post-graduation pool.
 *
 * A quote-bound coin (BNB: MEME/USDT on Topaz; Robinhood: MEME/STOCK on Uniswap V3) trades against a
 * token that is not the wrapped native. Every downstream reader (market_stats *_bnb, token_candles,
 * market_trades_v "nativeAmountRaw"/"priceBnb", the API's native x native-USD conversion) expects
 * native units, so the pool indexers convert the quote leg here and keep the quote leg in the quote_*
 * columns. The quote token's decimals are always read on chain by the caller, never assumed.
 *
 * Pure helpers only: no database, no RPC.
 */

const SCALE = 36;
const TEN = 10n;

function pow10(decimals: number): bigint {
  return TEN ** BigInt(decimals);
}

function validDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
}

/** Non-negative decimal string -> integer scaled by 10^SCALE (truncating beyond SCALE digits). */
function parseScaled(value: unknown): bigint | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * pow10(SCALE) + BigInt(fraction.slice(0, SCALE).padEnd(SCALE, "0") || "0");
}

function formatScaled(value: bigint): string {
  const whole = value / pow10(SCALE);
  const fraction = (value % pow10(SCALE)).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function positiveRaw(value: unknown): bigint | null {
  try {
    const parsed = typeof value === "bigint" ? value : BigInt(String(value ?? ""));
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whole native per whole quote token, from a quote/wrapped-native V2 pool's reserves
 * (e.g. the canonical Topaz volatile USDT/WBNB pool the BNB quote adapter acquires through).
 */
export function nativePerQuoteFromReserves(input: {
  reserveQuoteRaw: unknown;
  reserveNativeRaw: unknown;
  quoteDecimals: number;
  nativeDecimals?: number;
}): string | null {
  const quote = positiveRaw(input.reserveQuoteRaw);
  const native = positiveRaw(input.reserveNativeRaw);
  const nativeDecimals = input.nativeDecimals ?? 18;
  if (!quote || !native || !validDecimals(input.quoteDecimals) || !validDecimals(nativeDecimals)) return null;
  const scaled = (native * pow10(input.quoteDecimals) * pow10(SCALE)) / (quote * pow10(nativeDecimals));
  return scaled > 0n ? formatScaled(scaled) : null;
}

/** Whole native per whole quote token, from two USD references (quote/USD and native/USD). */
export function nativePerQuoteFromUsd(quoteUsd: unknown, nativeUsd: unknown): string | null {
  const quote = parseScaled(quoteUsd);
  const native = parseScaled(nativeUsd);
  if (!quote || !native) return null;
  const scaled = (quote * pow10(SCALE)) / native;
  return scaled > 0n ? formatScaled(scaled) : null;
}

/** Quote-token raw amount -> native raw amount (wei), given whole native per whole quote. */
export function quoteRawToNativeRaw(input: {
  quoteAmountRaw: unknown;
  quoteDecimals: number;
  nativePerQuote: unknown;
  nativeDecimals?: number;
}): bigint | null {
  const amount = positiveRaw(input.quoteAmountRaw);
  const rate = parseScaled(input.nativePerQuote);
  const nativeDecimals = input.nativeDecimals ?? 18;
  if (!amount || !rate || !validDecimals(input.quoteDecimals) || !validDecimals(nativeDecimals)) return null;
  const value = (amount * rate * pow10(nativeDecimals)) / (pow10(input.quoteDecimals) * pow10(SCALE));
  return value > 0n ? value : null;
}

/** Price in whole quote per whole MEME -> whole native per whole MEME. */
export function quotePriceToNative(priceQuote: unknown, nativePerQuote: unknown): string | null {
  const price = parseScaled(priceQuote);
  const rate = parseScaled(nativePerQuote);
  if (!price || !rate) return null;
  const scaled = (price * rate) / pow10(SCALE);
  return scaled > 0n ? formatScaled(scaled) : null;
}

/**
 * A pool's raw price ratio (paired raw per MEME raw, the contracts' startPriceWad / 1e18) as whole
 * quote per whole MEME. Graduation stores initial_dex_price_bnb this way for quote pools.
 */
export function rawRatioToWholePrice(ratio: unknown, baseDecimals: number, quoteDecimals: number): string | null {
  const scaled = parseScaled(ratio);
  if (!scaled || !validDecimals(baseDecimals) || !validDecimals(quoteDecimals)) return null;
  const adjusted = baseDecimals >= quoteDecimals
    ? scaled * pow10(baseDecimals - quoteDecimals)
    : scaled / pow10(quoteDecimals - baseDecimals);
  return adjusted > 0n ? formatScaled(adjusted) : null;
}

/** Wad-scaled raw ratio (paired raw per MEME raw x 1e18) converted into native wei per MEME raw x 1e18. */
export function quoteWadRatioToNativeWad(input: {
  ratioWad: unknown;
  reserveQuoteRaw: unknown;
  reserveNativeRaw: unknown;
}): bigint | null {
  const ratio = positiveRaw(input.ratioWad);
  const quote = positiveRaw(input.reserveQuoteRaw);
  const native = positiveRaw(input.reserveNativeRaw);
  if (!ratio || !quote || !native) return null;
  const value = (ratio * native) / quote;
  return value > 0n ? value : null;
}

/** Native raw amount a quote raw amount is worth at a quote/native V2 pool's reserves (decimals cancel). */
export function quoteRawToNativeRawViaReserves(input: {
  quoteAmountRaw: unknown;
  reserveQuoteRaw: unknown;
  reserveNativeRaw: unknown;
}): bigint | null {
  const amount = positiveRaw(input.quoteAmountRaw);
  const quote = positiveRaw(input.reserveQuoteRaw);
  const native = positiveRaw(input.reserveNativeRaw);
  if (!amount || !quote || !native) return null;
  const value = (amount * native) / quote;
  return value > 0n ? value : null;
}

/** Whole-unit decimal string for a raw amount. */
export function rawToDecimal(raw: unknown, decimals: number): string | null {
  const value = typeof raw === "bigint" ? raw : /^\d+$/.test(String(raw ?? "")) ? BigInt(String(raw)) : null;
  if (value == null || !validDecimals(decimals)) return null;
  const whole = value / pow10(decimals);
  const fraction = decimals === 0 ? "" : (value % pow10(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

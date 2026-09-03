const INTERNAL_SCALE = 36;
const OUTPUT_SCALE = 18;

export const ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION = "robinhood_relative_return_v1";

export type RobinhoodBeatTheMarketMetric = {
  formulaVersion: typeof ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION;
  startMemeUsd: string;
  endMemeUsd: string;
  startQuoteUsd: string;
  endQuoteUsd: string;
  memeReturn: string;
  quoteAssetReturn: string;
  relativeReturn: string;
  percentagePointDifference: string;
  healthy: true;
};

export type RobinhoodBeatTheMarketResult = RobinhoodBeatTheMarketMetric | {
  formulaVersion: typeof ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION;
  healthy: false;
  error: string;
};

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function parsePositiveDecimal(value: unknown, scale = INTERNAL_SCALE): bigint | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const scaled = BigInt(whole) * pow10(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, "0") || "0");
  return scaled > 0n ? scaled : null;
}

function formatSigned(value: bigint, scale = OUTPUT_SCALE): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const denominator = pow10(scale);
  const whole = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const fraction = remainder.toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

function ratioReturn(end: bigint, start: bigint): bigint {
  return ((end * pow10(OUTPUT_SCALE)) / start) - pow10(OUTPUT_SCALE);
}

/**
 * RH-S13 relative performance.
 *
 * relativeReturn = (1 + memeReturn) / (1 + quoteAssetReturn) - 1
 *                = (endMeme/startMeme) / (endQuote/startQuote) - 1
 *
 * Inputs are normalized USD prices from the shared RH-S12 valuation layer.
 * No raw Stock Token balance or display-only equity price is accepted here.
 */
export function calculateRobinhoodBeatTheMarket(input: {
  startMemeUsd: unknown;
  endMemeUsd: unknown;
  startQuoteUsd: unknown;
  endQuoteUsd: unknown;
}): RobinhoodBeatTheMarketResult {
  const startMeme = parsePositiveDecimal(input.startMemeUsd);
  const endMeme = parsePositiveDecimal(input.endMemeUsd);
  const startQuote = parsePositiveDecimal(input.startQuoteUsd);
  const endQuote = parsePositiveDecimal(input.endQuoteUsd);

  if (startMeme == null || endMeme == null || startQuote == null || endQuote == null) {
    return {
      formulaVersion: ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION,
      healthy: false,
      error: "Beat the Market requires positive normalized MEME/USD and quote-asset/USD prices at both window boundaries.",
    };
  }

  const memeReturnScaled = ratioReturn(endMeme, startMeme);
  const quoteReturnScaled = ratioReturn(endQuote, startQuote);
  const relativeRatioNumerator = endMeme * startQuote;
  const relativeRatioDenominator = startMeme * endQuote;
  if (relativeRatioDenominator <= 0n) {
    return {
      formulaVersion: ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION,
      healthy: false,
      error: "Beat the Market quote-asset return denominator is invalid.",
    };
  }
  const relativeReturnScaled = ((relativeRatioNumerator * pow10(OUTPUT_SCALE)) / relativeRatioDenominator) - pow10(OUTPUT_SCALE);
  const percentagePointDifferenceScaled = memeReturnScaled - quoteReturnScaled;

  return {
    formulaVersion: ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION,
    startMemeUsd: String(input.startMemeUsd),
    endMemeUsd: String(input.endMemeUsd),
    startQuoteUsd: String(input.startQuoteUsd),
    endQuoteUsd: String(input.endQuoteUsd),
    memeReturn: formatSigned(memeReturnScaled),
    quoteAssetReturn: formatSigned(quoteReturnScaled),
    relativeReturn: formatSigned(relativeReturnScaled),
    percentagePointDifference: formatSigned(percentagePointDifferenceScaled),
    healthy: true,
  };
}

export const robinhoodBeatTheMarketInternals = {
  parsePositiveDecimal,
  formatSigned,
  ratioReturn,
};

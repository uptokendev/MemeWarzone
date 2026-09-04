import { getRobinhoodNativeUsdReference } from "./robinhoodNativeUsdOracle.js";
import { getRobinhoodQuoteAssetPrice } from "./robinhoodStockTokenRegistry.js";

const INTERNAL_SCALE = 36;
const OUTPUT_SCALE = 18;
const CACHE_TTL_MS = 5_000;

export type RobinhoodValuationQuoteAssetType = "WRAPPED_NATIVE" | "STOCK_TOKEN" | "OTHER";

export type RobinhoodQuoteUsdReference = {
  chainId: number;
  quoteTokenAddress: string;
  quoteAssetType: RobinhoodValuationQuoteAssetType;
  priceUsd: string | null;
  updatedAt: string | null;
  source: string | null;
  healthy: boolean;
  error: string | null;
};

export type RobinhoodUsdValuation = {
  priceUsd: string | null;
  volumeUsd: string | null;
  marketCapUsd: string | null;
  liquidityUsd: string | null;
};

type CachedReference = { expiresAt: number; value: RobinhoodQuoteUsdReference };
const quoteReferenceCache = new Map<string, CachedReference>();

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function normalizeDecimalInput(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [wholeRaw, fractionRaw = ""] = raw.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseDecimal(value: unknown, scale = INTERNAL_SCALE): bigint | null {
  const normalized = normalizeDecimalInput(value);
  if (!normalized) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const padded = fraction.slice(0, scale).padEnd(scale, "0");
  return BigInt(whole) * pow10(scale) + BigInt(padded || "0");
}

function formatDecimal(value: bigint, scale = OUTPUT_SCALE): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const denominator = pow10(scale);
  const whole = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const fraction = remainder.toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function multiplyDecimalStrings(left: unknown, right: unknown, outputScale = OUTPUT_SCALE): string | null {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (a == null || b == null) return null;
  const denominatorPower = INTERNAL_SCALE * 2 - outputScale;
  const scaled = denominatorPower >= 0
    ? (a * b) / pow10(denominatorPower)
    : (a * b) * pow10(-denominatorPower);
  return formatDecimal(scaled, outputScale);
}

export function rawAmountToDecimal(raw: unknown, decimals: number): string | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return formatDecimal(BigInt(text), decimals);
}

function multiplyByInteger(value: unknown, multiplier: bigint): string | null {
  const parsed = parseDecimal(value, OUTPUT_SCALE);
  if (parsed == null) return null;
  return formatDecimal(parsed * multiplier, OUTPUT_SCALE);
}

/**
 * Shared Robinhood USD normalization.
 * priceQuote is quote-token units per one MEME/base token.
 * Liquidity intentionally follows the accepted WTR/Topaz convention of
 * 2x quote-side pool value, while using the actual registered quote asset.
 */
export function deriveRobinhoodUsdValuation(input: {
  priceQuote: unknown;
  quotePriceUsd: unknown;
  quoteTradeAmount?: unknown;
  postBurnTotalSupplyRaw?: unknown;
  baseDecimals?: number;
  reserveQuoteRaw?: unknown;
  quoteDecimals?: number;
}): RobinhoodUsdValuation {
  const priceUsd = multiplyDecimalStrings(input.priceQuote, input.quotePriceUsd);
  const volumeUsd = input.quoteTradeAmount == null
    ? null
    : multiplyDecimalStrings(input.quoteTradeAmount, input.quotePriceUsd);

  const supply = input.postBurnTotalSupplyRaw == null
    ? null
    : rawAmountToDecimal(input.postBurnTotalSupplyRaw, input.baseDecimals ?? 18);
  const marketCapUsd = priceUsd && supply ? multiplyDecimalStrings(priceUsd, supply) : null;

  const quoteReserve = input.reserveQuoteRaw == null
    ? null
    : rawAmountToDecimal(input.reserveQuoteRaw, input.quoteDecimals ?? 18);
  const quoteReserveUsd = quoteReserve ? multiplyDecimalStrings(quoteReserve, input.quotePriceUsd) : null;
  const liquidityUsd = quoteReserveUsd ? multiplyByInteger(quoteReserveUsd, 2n) : null;

  return { priceUsd, volumeUsd, marketCapUsd, liquidityUsd };
}

function cacheKey(chainId: number, quoteTokenAddress: string, quoteAssetType: RobinhoodValuationQuoteAssetType) {
  return `${Number(chainId)}:${quoteAssetType}:${String(quoteTokenAddress || "").toLowerCase()}`;
}

export async function resolveRobinhoodQuoteUsdReference(input: {
  chainId: number;
  quoteTokenAddress: string;
  quoteAssetType: RobinhoodValuationQuoteAssetType;
  nowMs?: number;
  bypassCache?: boolean;
}): Promise<RobinhoodQuoteUsdReference> {
  const nowMs = input.nowMs ?? Date.now();
  const key = cacheKey(input.chainId, input.quoteTokenAddress, input.quoteAssetType);
  const cached = quoteReferenceCache.get(key);
  if (!input.bypassCache && cached && cached.expiresAt > nowMs) return cached.value;

  let value: RobinhoodQuoteUsdReference;
  if (input.quoteAssetType === "STOCK_TOKEN") {
    const stock = await getRobinhoodQuoteAssetPrice({
      chainId: input.chainId,
      quoteToken: input.quoteTokenAddress,
    });
    value = {
      chainId: input.chainId,
      quoteTokenAddress: input.quoteTokenAddress,
      quoteAssetType: input.quoteAssetType,
      priceUsd: stock.priceUsd,
      updatedAt: stock.updatedAt,
      source: stock.source ? `stock_oracle:${stock.source}` : null,
      healthy: stock.healthy && Boolean(stock.priceUsd),
      error: stock.error,
    };
  } else if (input.quoteAssetType === "WRAPPED_NATIVE") {
    const native = await getRobinhoodNativeUsdReference(input.chainId);
    value = {
      chainId: input.chainId,
      quoteTokenAddress: input.quoteTokenAddress,
      quoteAssetType: input.quoteAssetType,
      priceUsd: native.priceUsd,
      updatedAt: native.updatedAt,
      source: native.source ? `native_oracle:${native.source}` : null,
      healthy: native.healthy && Boolean(native.priceUsd),
      error: native.error,
    };
  } else {
    value = {
      chainId: input.chainId,
      quoteTokenAddress: input.quoteTokenAddress,
      quoteAssetType: input.quoteAssetType,
      priceUsd: null,
      updatedAt: null,
      source: null,
      healthy: false,
      error: "Robinhood quote asset type is not approved for USD valuation.",
    };
  }

  quoteReferenceCache.set(key, { value, expiresAt: nowMs + CACHE_TTL_MS });
  return value;
}

export const robinhoodMarketValuationInternals = {
  normalizeDecimalInput,
  parseDecimal,
  formatDecimal,
  multiplyByInteger,
  quoteReferenceCache,
};

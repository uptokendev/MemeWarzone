export type RobinhoodQuoteAssetType = "WRAPPED_NATIVE" | "STOCK_TOKEN" | "OTHER";

export type RobinhoodPairDescriptor = {
  baseTokenAddress: string;
  quoteTokenAddress: string;
  quoteAssetType: RobinhoodQuoteAssetType;
  baseDecimals: number;
  quoteDecimals: number;
};

export type RobinhoodNormalizedPairSwap = {
  side: "buy" | "sell";
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
};

function ident(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function power10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function formatUnitsExact(value: bigint, decimals: number): string {
  const scale = power10(decimals);
  const whole = value / scale;
  const remainder = value % scale;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fraction}`;
}

function formatPriceQuote(input: {
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  precision?: number;
}): string {
  const precision = input.precision ?? 18;
  const numerator = input.quoteAmountRaw * power10(input.baseDecimals) * power10(precision);
  const denominator = input.baseAmountRaw * power10(input.quoteDecimals);
  if (denominator <= 0n) throw new Error("Pair swap base amount must be positive");
  const scaled = numerator / denominator;
  if (scaled <= 0n) throw new Error("Pair swap price must be positive");
  return formatUnitsExact(scaled, precision);
}

export function normalizePairDescriptor(input: {
  campaignTokenAddress: string;
  token0Address: string;
  token1Address: string;
  wrappedNativeAddress?: string | null;
  stockTokenAddresses?: Iterable<string>;
  baseDecimals?: number | null;
  quoteDecimals?: number | null;
}): RobinhoodPairDescriptor {
  const base = ident(input.campaignTokenAddress);
  const token0 = ident(input.token0Address);
  const token1 = ident(input.token1Address);
  if (!base || !token0 || !token1) throw new Error("Robinhood pair identity is incomplete");
  if (token0 === token1) throw new Error("Robinhood pair token0/token1 must differ");
  if (base !== token0 && base !== token1) throw new Error("Robinhood pair does not contain campaign token");

  const quote = base === token0 ? token1 : token0;
  const wrapped = ident(input.wrappedNativeAddress);
  const stock = new Set(Array.from(input.stockTokenAddresses || [], (value) => ident(value)).filter(Boolean));
  const quoteAssetType: RobinhoodQuoteAssetType =
    wrapped && quote === wrapped ? "WRAPPED_NATIVE" : stock.has(quote) ? "STOCK_TOKEN" : "OTHER";

  const baseDecimals = Number(input.baseDecimals ?? 18);
  const quoteDecimals = Number(input.quoteDecimals ?? 18);
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 36) throw new Error("Invalid base decimals");
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) throw new Error("Invalid quote decimals");

  return {
    baseTokenAddress: base,
    quoteTokenAddress: quote,
    quoteAssetType,
    baseDecimals,
    quoteDecimals,
  };
}

export function normalizeMockPairSwap(input: {
  descriptor: RobinhoodPairDescriptor;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
}): RobinhoodNormalizedPairSwap | null {
  const tokenIn = ident(input.tokenIn);
  const tokenOut = ident(input.tokenOut);
  const base = ident(input.descriptor.baseTokenAddress);
  const quote = ident(input.descriptor.quoteTokenAddress);
  if (tokenIn === quote && tokenOut === base) {
    return { side: "buy", baseAmountRaw: input.amountOut, quoteAmountRaw: input.amountIn };
  }
  if (tokenIn === base && tokenOut === quote) {
    return { side: "sell", baseAmountRaw: input.amountIn, quoteAmountRaw: input.amountOut };
  }
  return null;
}

export function normalizeCanonicalPairSwap(input: {
  descriptor: RobinhoodPairDescriptor;
  token0Address: string;
  amount0: bigint;
  amount1: bigint;
}): RobinhoodNormalizedPairSwap | null {
  const token0 = ident(input.token0Address);
  const base = ident(input.descriptor.baseTokenAddress);
  const baseDelta = token0 === base ? input.amount0 : input.amount1;
  const quoteDelta = token0 === base ? input.amount1 : input.amount0;

  if (baseDelta < 0n && quoteDelta > 0n) {
    return { side: "buy", baseAmountRaw: abs(baseDelta), quoteAmountRaw: quoteDelta };
  }
  if (baseDelta > 0n && quoteDelta < 0n) {
    return { side: "sell", baseAmountRaw: baseDelta, quoteAmountRaw: abs(quoteDelta) };
  }
  return null;
}

export function formatPairExecution(input: {
  descriptor: RobinhoodPairDescriptor;
  swap: RobinhoodNormalizedPairSwap;
}): {
  baseAmount: string;
  quoteAmount: string;
  priceQuote: string;
} {
  if (input.swap.baseAmountRaw <= 0n || input.swap.quoteAmountRaw <= 0n) {
    throw new Error("Pair swap amounts must be positive");
  }
  return {
    baseAmount: formatUnitsExact(input.swap.baseAmountRaw, input.descriptor.baseDecimals),
    quoteAmount: formatUnitsExact(input.swap.quoteAmountRaw, input.descriptor.quoteDecimals),
    priceQuote: formatPriceQuote({
      baseAmountRaw: input.swap.baseAmountRaw,
      quoteAmountRaw: input.swap.quoteAmountRaw,
      baseDecimals: input.descriptor.baseDecimals,
      quoteDecimals: input.descriptor.quoteDecimals,
    }),
  };
}

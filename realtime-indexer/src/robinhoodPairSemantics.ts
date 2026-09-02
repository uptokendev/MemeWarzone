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
  const baseScale = 10 ** input.descriptor.baseDecimals;
  const quoteScale = 10 ** input.descriptor.quoteDecimals;
  const baseAmount = Number(input.swap.baseAmountRaw) / baseScale;
  const quoteAmount = Number(input.swap.quoteAmountRaw) / quoteScale;
  if (!(baseAmount > 0) || !(quoteAmount > 0)) throw new Error("Pair swap amounts must be positive");
  return {
    baseAmount: baseAmount.toString(),
    quoteAmount: quoteAmount.toString(),
    priceQuote: (quoteAmount / baseAmount).toString(),
  };
}

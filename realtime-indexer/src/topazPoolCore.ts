export type NormalizedTopazSwap = {
  side: "buy" | "sell";
  tokenAmountRaw: bigint;
  nativeAmountRaw: bigint;
};

export type TopazSwapAmounts = {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
};

export function normalizeTopazSwap(
  token0IsLaunchToken: boolean,
  amounts: TopazSwapAmounts,
): NormalizedTopazSwap | null {
  const tokenIn = token0IsLaunchToken ? amounts.amount0In : amounts.amount1In;
  const tokenOut = token0IsLaunchToken ? amounts.amount0Out : amounts.amount1Out;
  const nativeIn = token0IsLaunchToken ? amounts.amount1In : amounts.amount0In;
  const nativeOut = token0IsLaunchToken ? amounts.amount1Out : amounts.amount0Out;

  if (tokenOut > 0n && nativeIn > 0n && tokenIn === 0n && nativeOut === 0n) {
    return { side: "buy", tokenAmountRaw: tokenOut, nativeAmountRaw: nativeIn };
  }

  if (tokenIn > 0n && nativeOut > 0n && tokenOut === 0n && nativeIn === 0n) {
    return { side: "sell", tokenAmountRaw: tokenIn, nativeAmountRaw: nativeOut };
  }

  return null;
}

export function priceBnbFromRaw(
  tokenAmountRaw: bigint,
  nativeAmountRaw: bigint,
  tokenDecimals = 18,
  nativeDecimals = 18,
): string | null {
  if (tokenAmountRaw <= 0n || nativeAmountRaw <= 0n) return null;

  const precision = 36;
  const numerator = nativeAmountRaw * 10n ** BigInt(tokenDecimals + precision);
  const denominator = tokenAmountRaw * 10n ** BigInt(nativeDecimals);
  if (denominator === 0n) return null;

  const scaled = numerator / denominator;
  const whole = scaled / 10n ** BigInt(precision);
  const fraction = (scaled % 10n ** BigInt(precision)).toString().padStart(precision, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Pool's paired token (the side that is not the campaign token). */
export function pairedTokenOf(p: { tokenAddress: string; token0Address: string; token1Address: string }): string {
  return p.token0Address === p.tokenAddress ? p.token1Address : p.token0Address;
}

/** True when the pool pairs the campaign token with the wrapped native (every pre-quote coin). */
export function isNativePairedPool(p: {
  tokenAddress: string;
  token0Address: string;
  token1Address: string;
  wrappedNativeAddress: string;
}): boolean {
  return pairedTokenOf(p) === p.wrappedNativeAddress;
}

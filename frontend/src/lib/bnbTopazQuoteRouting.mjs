const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function sameAddress(a, b) {
  return normalize(a) !== "" && normalize(a) === normalize(b);
}

export function effectiveBnbQuoteToken(authoritativeQuoteToken, wrappedNativeAddress) {
  const quote = normalize(authoritativeQuoteToken);
  return !quote || quote === ZERO_ADDRESS ? String(wrappedNativeAddress) : String(authoritativeQuoteToken);
}

export function isNativeBnbQuote(authoritativeQuoteToken, wrappedNativeAddress) {
  return sameAddress(effectiveBnbQuoteToken(authoritativeQuoteToken, wrappedNativeAddress), wrappedNativeAddress);
}

export function assertBnbMarketQuoteIdentity({
  authoritativeQuoteToken,
  marketQuoteToken,
  wrappedNativeAddress,
}) {
  const expected = effectiveBnbQuoteToken(authoritativeQuoteToken, wrappedNativeAddress);
  if (marketQuoteToken && !sameAddress(marketQuoteToken, expected)) {
    throw new Error("Authoritative Graduation Market quote identity mismatch.");
  }
  return expected;
}

export function buildBnbTopazBuyRoute({
  wrappedNativeAddress,
  quoteTokenAddress,
  tokenAddress,
  factoryAddress,
}) {
  const nativeQuote = sameAddress(quoteTokenAddress, wrappedNativeAddress);
  if (nativeQuote) {
    return [
      {
        from: wrappedNativeAddress,
        to: tokenAddress,
        stable: false,
        factory: factoryAddress,
      },
    ];
  }
  return [
    {
      from: wrappedNativeAddress,
      to: quoteTokenAddress,
      stable: false,
      factory: factoryAddress,
    },
    {
      from: quoteTokenAddress,
      to: tokenAddress,
      stable: false,
      factory: factoryAddress,
    },
  ];
}

export function reverseBnbTopazRoute(route) {
  return [...route].reverse().map((leg) => ({
    ...leg,
    from: leg.to,
    to: leg.from,
  }));
}

export function assertBnbRequiredPools({
  finalPairAddress,
  resolvedFinalPairAddress,
  acquisitionPairAddress,
  quoteTokenAddress,
  wrappedNativeAddress,
}) {
  if (!resolvedFinalPairAddress || normalize(resolvedFinalPairAddress) === ZERO_ADDRESS) {
    throw new Error("Selected QUOTE/MEME Topaz route is unavailable.");
  }
  if (!sameAddress(resolvedFinalPairAddress, finalPairAddress)) {
    throw new Error("Selected QUOTE/MEME Topaz pool identity mismatch.");
  }
  if (!sameAddress(quoteTokenAddress, wrappedNativeAddress)) {
    if (!acquisitionPairAddress || normalize(acquisitionPairAddress) === ZERO_ADDRESS) {
      throw new Error("Required WBNB/QUOTE Topaz route is unavailable.");
    }
  }
}

export const _bnbTopazQuoteRoutingTestInternals = {
  ZERO_ADDRESS,
  normalize,
  sameAddress,
};

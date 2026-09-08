export const GRADUATION_MARKET_CATEGORIES = Object.freeze([
  { id: "POPULAR", label: "Popular" },
  { id: "STABLECOINS", label: "Stablecoins" },
  { id: "STOCKS_ETFS", label: "Stocks & ETFs" },
  { id: "PRE_IPO", label: "Pre-IPO" },
  { id: "COMMODITIES", label: "Commodities" },
  { id: "CRYPTO", label: "Crypto" },
  { id: "MEMEWARZONE", label: "MemeWarzone" },
  { id: "COMMUNITY", label: "Community" },
]);

const API_CATEGORY_TO_CREATOR = Object.freeze({
  CORE: "POPULAR",
  STABLES_CURRENCIES: "STABLECOINS",
  STOCKS: "STOCKS_ETFS",
  ETFS: "STOCKS_ETFS",
  PRE_IPO: "PRE_IPO",
  RWA_COMMODITIES: "COMMODITIES",
  ECOSYSTEM: "CRYPTO",
  MEMEWARZONE: "MEMEWARZONE",
  COMMUNITY: "COMMUNITY",
  POPULAR: "POPULAR",
  STABLECOINS: "STABLECOINS",
  STOCKS_ETFS: "STOCKS_ETFS",
  COMMODITIES: "COMMODITIES",
  CRYPTO: "CRYPTO",
});

export const WRAPPED_DISPLAY_SYMBOLS = Object.freeze({
  WSOL: "SOL",
  WBNB: "BNB",
  WETH: "ETH",
});

export const MOVING_QUOTE_NOTICE =
  "This quote asset has its own market price. After graduation, your token's USD price can move because of both your token market and the quote asset.";

export const ROBINHOOD_STOCK_PROVIDER_KEY = "robinhood-stock-token";
export const ROBINHOOD_STOCK_COMPAT_PREFIX = "rh-stock:";

const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);

export function nativeSymbol(chainId) {
  const n = Number(chainId);
  if (n === 101) return "SOL";
  if (ROBINHOOD_CHAIN_IDS.has(n)) return "ETH";
  return "BNB";
}

export function bondingCurrency(chainId) {
  return nativeSymbol(chainId);
}

export function chainGraduationCopy(chainId) {
  const bonding = bondingCurrency(chainId);
  return {
    bonding,
    title: "GRADUATION MARKET",
    lines: [
      `Bonding stays in ${bonding}.`,
      "Choose the asset your token will be paired with when it graduates.",
    ],
  };
}

export function displayQuoteSymbol(asset, options = {}) {
  const technical = options.technical === true;
  const raw = String(asset?.symbol || "").trim();
  if (technical) return raw || nativeSymbol(asset?.chainId);
  if (isNativeQuote(asset)) return nativeSymbol(asset?.chainId);
  const mapped = WRAPPED_DISPLAY_SYMBOLS[raw.toUpperCase()];
  return mapped || raw || nativeSymbol(asset?.chainId);
}

export function providerLabel(asset) {
  const key = String(asset?.provider?.key || "").toLowerCase();
  if (key.includes("robinhood")) return "Robinhood";
  const chainId = Number(asset?.chainId);
  if (chainId === 101 || key.includes("solana")) return "Solana";
  if (chainId === 56 || chainId === 97 || key.includes("bnb") || key.includes("bsc")) return "BNB";
  const displayName = String(asset?.provider?.displayName || "").trim();
  return displayName || "MemeWarzone";
}

export function isRobinhoodStockQuote(asset) {
  const key = String(asset?.provider?.key || "");
  const id = String(asset?.id || "");
  const assetClass = String(asset?.assetClass || "").toUpperCase();
  return (
    key === ROBINHOOD_STOCK_PROVIDER_KEY ||
    id.startsWith(ROBINHOOD_STOCK_COMPAT_PREFIX) ||
    (assetClass === "PROVIDER_RWA" && key.includes("robinhood"))
  );
}

export function isNativeQuote(asset) {
  if (!asset) return false;
  const identityKind = String(asset.identityKind || "").toUpperCase();
  const assetClass = String(asset.assetClass || "").toUpperCase();
  const id = String(asset.id || "");
  const symbol = String(asset.symbol || "").toUpperCase();
  if (identityKind === "NATIVE" || assetClass === "NATIVE" || id.startsWith("native:")) return true;
  const chainNative = nativeSymbol(asset.chainId);
  return symbol === chainNative || symbol === `W${chainNative}`;
}

export function isStablecoinQuote(asset) {
  return String(asset?.assetClass || "").toUpperCase() === "STABLECOIN";
}

export function isMovingQuoteAsset(asset) {
  if (!asset || isNativeQuote(asset) || isStablecoinQuote(asset)) return false;
  return true;
}

export function categoryForQuoteAsset(asset) {
  if (isNativeQuote(asset)) return "POPULAR";
  const apiCategory = String(asset?.category || "").trim().toUpperCase();
  if (API_CATEGORY_TO_CREATOR[apiCategory]) return API_CATEGORY_TO_CREATOR[apiCategory];
  if (isRobinhoodStockQuote(asset) || String(asset?.assetClass || "").toUpperCase() === "PROVIDER_RWA" || String(asset?.assetClass || "").toUpperCase() === "PUBLIC_RWA") {
    return "STOCKS_ETFS";
  }
  const assetClass = String(asset?.assetClass || "").toUpperCase();
  if (assetClass === "STABLECOIN") return "STABLECOINS";
  if (assetClass === "PRE_IPO_RWA") return "PRE_IPO";
  if (assetClass === "COMMODITY") return "COMMODITIES";
  if (assetClass === "CRYPTO") return "CRYPTO";
  if (assetClass === "MWZ_NATIVE") return "MEMEWARZONE";
  if (assetClass === "COMMUNITY") return "COMMUNITY";
  return "CRYPTO";
}

export function enabledQuoteAssets(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.newGraduationEligible === true);
}

export function groupQuoteAssetsByCategory(items) {
  const enabled = enabledQuoteAssets(items);
  const grouped = new Map(GRADUATION_MARKET_CATEGORIES.map((category) => [category.id, []]));
  for (const item of enabled) {
    const categoryId = categoryForQuoteAsset(item);
    const bucket = grouped.get(categoryId);
    if (bucket) bucket.push(item);
  }
  return GRADUATION_MARKET_CATEGORIES
    .map((category) => ({ ...category, items: grouped.get(category.id) || [] }))
    .filter((category) => category.items.length > 0);
}

export function nativeProviderKey(chainId) {
  const n = Number(chainId);
  if (n === 101) return "solana-basic";
  if (ROBINHOOD_CHAIN_IDS.has(n)) return "robinhood-basic";
  return "bnb-basic";
}

export function nativeDefaultQuoteAsset(chainId) {
  const symbol = nativeSymbol(chainId);
  const chain = String(chainId);
  return {
    id: `native:${chain}`,
    assetId: null,
    provider: {
      key: nativeProviderKey(chainId),
      displayName: providerLabel({ chainId, provider: { key: nativeProviderKey(chainId) } }),
      authorityMode: "CHAIN_NATIVE_DEFAULT",
      providerClass: "NATIVE",
    },
    chainId: chain,
    identityKind: "NATIVE",
    contractAddressOrMint: `native:${chain}`,
    assetClass: "NATIVE",
    symbol,
    displayName: symbol,
    logoUrl: null,
    stateVersion: 0,
    identityStatus: "verified",
    securityStatus: "pending",
    marketHealthStatus: "healthy",
    newGraduationEligible: true,
    existingMarketSupport: true,
    adminState: "enabled",
    policy: {
      authority: "presentation-default",
      policyKey: "chain-native-default",
      version: null,
    },
    presentationDefault: true,
  };
}

export function catalogQuoteAssetsOnly(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && item.presentationDefault !== true);
}

export function directDeployBindPath(asset) {
  if (!asset || asset.newGraduationEligible !== true) return null;
  if (asset.presentationDefault === true) {
    return Number(asset?.chainId) === 56 && isNativeQuote(asset) ? "native" : null;
  }
  if (isRobinhoodStockQuote(asset)) return "robinhood-stock";
  if (isNativeQuote(asset)) return "native";
  // BNB BASIC uses the same launchpad client surface as native creation. The client consumes the
  // remembered opaque catalog deployment id and switches to createBasicQuoteCampaignAuthorized
  // only after the server returns a signed BNB_BASIC_QUOTE binding.
  if (Number(asset?.chainId) === 56) return "native";
  return null;
}

export function formatTokenTicker(ticker) {
  const raw = String(ticker || "").trim().replace(/^\$+/, "").toUpperCase();
  return raw ? `$${raw}` : "$TOKEN";
}

export function selectedMarketSummary({ ticker, asset, chainId }) {
  const token = formatTokenTicker(ticker);
  const quote = displayQuoteSymbol(asset);
  const pair = `${token} / ${quote}`;
  return {
    pair,
    bonding: bondingCurrency(chainId ?? asset?.chainId),
    postGraduationMarket: pair,
    provider: providerLabel(asset),
    quoteAsset: quote,
    moving: isMovingQuoteAsset(asset),
  };
}

export function draftGraduationSelection(asset, chainId) {
  const resolvedChainId = Number(asset?.chainId || chainId);
  if (resolvedChainId === 56 && asset?.presentationDefault === true && isNativeQuote(asset)) {
    return {
      graduationQuoteAssetId: "",
      graduationQuoteStateVersion: 0,
      policyVersion: "chain-native-default",
      chainId: resolvedChainId,
    };
  }
  const policyVersion =
    asset?.policy?.version != null && String(asset.policy.version).trim() !== ""
      ? String(asset.policy.version)
      : String(asset?.policy?.policyKey || "");
  return {
    graduationQuoteAssetId: String(asset?.id || ""),
    graduationQuoteStateVersion: Number(asset?.stateVersion || 0),
    policyVersion,
    chainId: resolvedChainId,
  };
}

export function robinhoodLegacyMarketKind(asset) {
  if (isRobinhoodStockQuote(asset)) return "STOCK_TOKEN";
  if (isNativeQuote(asset)) return "NATIVE";
  return null;
}

export function buildCreateDraftGraduationFields(asset, chainId) {
  const selection = draftGraduationSelection(asset, chainId);
  const fields = {
    graduationQuoteAssetId: selection.graduationQuoteAssetId,
    graduationQuoteStateVersion: selection.graduationQuoteStateVersion,
    graduationMarketPolicyVersion: selection.policyVersion,
  };
  const n = Number(chainId);
  if (!ROBINHOOD_CHAIN_IDS.has(n)) return fields;
  const legacyKind = robinhoodLegacyMarketKind(asset);
  if (!legacyKind) return fields;
  return {
    ...fields,
    graduationMarketKind: legacyKind,
    graduationQuoteAsset: legacyKind === "STOCK_TOKEN" ? String(asset?.contractAddressOrMint || "") : null,
    graduationMarketPolicyVersion: "robinhood_market_v1",
  };
}

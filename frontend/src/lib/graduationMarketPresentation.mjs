// Tabs of the Graduation Market picker (stonk.xyz-style browse by asset
// kind). Only tabs holding an eligible asset on the selected chain render.
export const GRADUATION_MARKET_CATEGORIES = Object.freeze([
  { id: "POPULAR", label: "POPULAR" },
  { id: "STABLECOINS", label: "STABLES & CURRENCIES" },
  { id: "STOCKS_ETFS", label: "STOCKS & ETFs" },
  { id: "PRE_IPO", label: "PRE-IPO" },
  { id: "COMMODITIES", label: "COMMODITIES" },
  { id: "CRYPTO", label: "CRYPTO" },
  { id: "LEVERAGE", label: "LEVERAGE" },
  { id: "COLLECTIBLES", label: "COLLECTIBLES" },
  { id: "COMMUNITY", label: "COMMUNITY" },
  { id: "OTHER_APPROVED", label: "OTHER APPROVED" },
  { id: "CUSTOM", label: "CUSTOM" },
]);

/** Product-facing provider names; anything else falls back to the catalog display name. */
export const PROVIDER_LABELS = Object.freeze({
  xstocks: "xStocks",
  "canonical-stable": "Stablecoin",
  jupiter: "Jupiter",
  pyth: "Pyth",
  jito: "Jito",
  orca: "Orca",
  "binance-peg": "Binance-Peg",
  "first-digital": "First Digital",
  pancakeswap: "PancakeSwap",
});

/** Fixed ordering for the POPULAR row when the catalog carries no POPULAR tag. */
const POPULAR_SYMBOL_PRIORITY = Object.freeze(["USDC", "USDT", "SPYX", "SPY", "QQQX", "QQQ", "NVDAX", "NVDA", "TSLAX", "TSLA", "AAPLX", "AAPL", "GOOGLX", "GOOGL", "AMZNX", "AMZN", "MSFTX", "MSFT"]);

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
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
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

const CATALOG_CATEGORY_TO_TAB = Object.freeze({
  STABLES_CURRENCIES: "STABLECOINS",
  STOCKS: "STOCKS_ETFS",
  ETFS: "STOCKS_ETFS",
  RWA_COMMODITIES: "COMMODITIES",
  ECOSYSTEM: "CRYPTO",
  MEMEWARZONE: "CRYPTO",
  COMMUNITY: "COMMUNITY",
});

const ASSET_CLASS_TO_TAB = Object.freeze({
  STABLECOIN: "STABLECOINS",
  PROVIDER_RWA: "STOCKS_ETFS",
  PUBLIC_RWA: "STOCKS_ETFS",
  PRE_IPO_RWA: "PRE_IPO",
  COMMODITY: "COMMODITIES",
  CRYPTO: "CRYPTO",
  MWZ_NATIVE: "CRYPTO",
  LEVERAGED_OR_YIELD: "LEVERAGE",
  COLLECTIBLE: "COLLECTIBLES",
  COMMUNITY: "COMMUNITY",
});

export function categoryForQuoteAsset(asset) {
  if (isNativeQuote(asset)) return "POPULAR";
  if (isRobinhoodStockQuote(asset)) return "STOCKS_ETFS";
  const assetClass = String(asset?.assetClass || "").toUpperCase();
  // Pre-IPO and commodity classes are more specific than the catalog category.
  if (assetClass === "PRE_IPO_RWA" || assetClass === "COMMODITY") return ASSET_CLASS_TO_TAB[assetClass];
  const category = String(asset?.category || "").toUpperCase();
  if (CATALOG_CATEGORY_TO_TAB[category]) return CATALOG_CATEGORY_TO_TAB[category];
  if (ASSET_CLASS_TO_TAB[assetClass]) return ASSET_CLASS_TO_TAB[assetClass];
  return "OTHER_APPROVED";
}

/** Text a creator can search by: symbol, name, provider, category, tags, underlying id. */
export function quoteAssetSearchText(asset) {
  return [
    asset?.symbol,
    displayQuoteSymbol(asset),
    asset?.displayName,
    asset?.providerAssetId,
    asset?.provider?.key,
    asset?.provider?.displayName,
    providerLabel(asset),
    asset?.category,
    ...(Array.isArray(asset?.tags) ? asset.tags : []),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" ");
}

/**
 * The POPULAR row: catalog POPULAR tags first, then the chain native, the
 * stablecoins and the best-known stocks / ETFs, up to `limit`. Presentation
 * order only; eligibility is the catalog's.
 */
export function popularQuoteAssets(items, { limit = 6 } = {}) {
  const enabled = enabledQuoteAssets(items);
  const rank = (asset) => {
    const tags = (Array.isArray(asset?.tags) ? asset.tags : []).map((t) => String(t).toUpperCase());
    if (tags.includes("POPULAR")) return 0;
    if (isNativeQuote(asset)) return 1;
    const symbol = String(asset?.symbol || "").toUpperCase();
    const index = POPULAR_SYMBOL_PRIORITY.indexOf(symbol);
    if (index >= 0) return 10 + index;
    if (isStablecoinQuote(asset)) return 100;
    return 1000;
  };
  return enabled
    .map((asset, index) => ({ asset, index, rank: rank(asset) }))
    .filter((entry) => entry.rank < 1000)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.asset);
}

/** Providers present in a list, for the secondary filter chips. */
export function providerFacets(items) {
  const counts = new Map();
  for (const asset of enabledQuoteAssets(items)) {
    const key = String(asset?.provider?.key || "").toLowerCase() || "unknown";
    const current = counts.get(key) || { key, label: providerLabel(asset), count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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

/**
 * Launch-day native market choice for the EVM chains. Native BNB / native ETH
 * is deliberately not a Quote Asset Catalog deployment: selecting it keeps the
 * legacy/native createCampaignAuthorized path and never sends a quote id. Until
 * 2026-09-24 only chain 56 got this default, so a Robinhood creator saw an empty
 * picker (the catalog's WETH row is a wrapped duplicate the verifier does not
 * activate) and could not pass the market step at all.
 */
export const EVM_NATIVE_LAUNCH_CHAIN_IDS = Object.freeze(new Set([56, 97, 4663, 46630]));

export function evmNativeLaunchQuote(chainId) {
  const n = Number(chainId);
  if (!EVM_NATIVE_LAUNCH_CHAIN_IDS.has(n)) return null;
  return nativeDefaultQuoteAsset(n);
}

export function isEvmNativeLaunchQuote(asset) {
  if (!asset || asset.presentationDefault !== true) return false;
  const n = Number(asset.chainId);
  return (
    EVM_NATIVE_LAUNCH_CHAIN_IDS.has(n) &&
    String(asset.identityKind || "").toUpperCase() === "NATIVE" &&
    String(asset.contractAddressOrMint || "") === `native:${n}`
  );
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
    return isEvmNativeLaunchQuote(asset) ? "native" : null;
  }
  if (isRobinhoodStockQuote(asset)) return "robinhood-stock";
  if (isNativeQuote(asset)) return "native";
  // BNB BASIC uses the same launchpad client surface as native creation. The client consumes the
  // remembered opaque catalog deployment id and switches to createBasicQuoteCampaignAuthorized
  // only after the server returns a signed BNB_BASIC_QUOTE binding.
  if (Number(asset?.chainId) === 56) return "native";
  // Solana: the direct-create authorization carries the catalog id and the
  // finalize step binds it to the campaign (campaign_graduation_quote_bindings).
  if (Number(asset?.chainId) === 101) return "solana-quote";
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
  if (isEvmNativeLaunchQuote(asset) || (resolvedChainId === 56 && asset?.presentationDefault === true && isNativeQuote(asset))) {
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

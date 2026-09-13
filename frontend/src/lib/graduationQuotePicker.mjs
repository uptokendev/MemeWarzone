import {
  categoryForQuoteAsset,
  displayQuoteSymbol,
  GRADUATION_MARKET_CATEGORIES,
  isNativeQuote,
  providerLabel,
} from "./graduationMarketPresentation.mjs";

export const CREATOR_QUOTE_CATEGORIES = GRADUATION_MARKET_CATEGORIES;

function normalizedChainId(value) {
  return String(value ?? "").trim();
}

function normalizedProviderKey(asset) {
  return String(asset?.provider?.key || "").trim().toLowerCase();
}

function normalizedContractOrMint(chainId, value) {
  const raw = String(value || "").trim();
  return normalizedChainId(chainId) === "101" ? raw : raw.toLowerCase();
}

export function creatorQuoteIdentityKey(asset) {
  const chainId = normalizedChainId(asset?.chainId);
  const provider = normalizedProviderKey(asset);
  const exactIdentity = normalizedContractOrMint(chainId, asset?.contractAddressOrMint);
  const id = String(asset?.id || "").trim();
  if (!chainId || !provider || !exactIdentity || !id) return "";
  return `${chainId}:${provider}:${exactIdentity}:${id}`;
}

export function sameAuthoritativeQuoteIdentity(left, right) {
  const leftKey = creatorQuoteIdentityKey(left);
  const rightKey = creatorQuoteIdentityKey(right);
  return Boolean(leftKey) && leftKey === rightKey;
}

export function quoteVersionUnchanged(selected, catalogItem) {
  if (!selected || !catalogItem) return false;
  if (selected.stateVersion != null && catalogItem.stateVersion != null
    && Number(selected.stateVersion) !== Number(catalogItem.stateVersion)) {
    return false;
  }
  const selectedPolicy = selected?.policy?.version;
  const catalogPolicy = catalogItem?.policy?.version;
  if (selectedPolicy != null && String(selectedPolicy).trim() !== ""
    && catalogPolicy != null && String(catalogPolicy).trim() !== ""
    && String(selectedPolicy) !== String(catalogPolicy)) {
    return false;
  }
  return true;
}

export function isCreatorQuoteSelectable(asset) {
  if (!asset || asset.newGraduationEligible !== true) return false;
  if (String(asset.adminState || "enabled").toLowerCase() === "disabled") return false;
  if (asset.presentationDefault === true) {
    return Number(asset.chainId) === 56 && isNativeQuote(asset);
  }
  return Boolean(creatorQuoteIdentityKey(asset));
}

export function creatorQuoteAvailabilityLabel(asset) {
  if (isCreatorQuoteSelectable(asset)) return "Available";
  return "Not currently available";
}

export function quoteHasTrendingDisplayMetadata(asset) {
  return (Array.isArray(asset?.tags) ? asset.tags : []).some((tag) => String(tag).toUpperCase() === "TRENDING");
}

function searchHaystack(asset) {
  const categoryId = categoryForQuoteAsset(asset);
  const category = CREATOR_QUOTE_CATEGORIES.find((item) => item.id === categoryId);
  return [
    asset?.symbol,
    asset?.displayName,
    displayQuoteSymbol(asset),
    asset?.provider?.displayName,
    asset?.provider?.key,
    providerLabel(asset),
    asset?.assetClass,
    asset?.category,
    categoryId,
    category?.label,
  ];
}

export function filterCreatorQuoteAssets(items, { chainId, query = "", category = "ALL" } = {}) {
  const wantedChain = chainId == null ? "" : normalizedChainId(chainId);
  const wantedCategory = String(category || "ALL").trim().toUpperCase();
  const needle = String(query || "").trim().toLowerCase();
  return (Array.isArray(items) ? items : [])
    .filter(isCreatorQuoteSelectable)
    .filter((asset) => !wantedChain || normalizedChainId(asset.chainId) === wantedChain)
    .filter((asset) => wantedCategory === "ALL" || categoryForQuoteAsset(asset) === wantedCategory)
    .filter((asset) => {
      if (!needle) return true;
      return searchHaystack(asset).some((value) => String(value || "").toLowerCase().includes(needle));
    });
}

export function availableCreatorQuoteCategories(items, chainId) {
  const visible = filterCreatorQuoteAssets(items, { chainId });
  const present = new Set(visible.map(categoryForQuoteAsset));
  return CREATOR_QUOTE_CATEGORIES.filter((category) => present.has(category.id));
}

export function defaultNativeQuoteAsset(items, chainId) {
  return filterCreatorQuoteAssets(items, { chainId }).find((item) => isNativeQuote(item)) || null;
}

export function reconcileGraduationMarketSelection({ selected, items, chainId }) {
  const chainItems = filterCreatorQuoteAssets(items, { chainId });
  const selectedForChain = selected && normalizedChainId(selected.chainId) === normalizedChainId(chainId)
    ? selected
    : null;

  if (selectedForChain) {
    const match = chainItems.find((item) => sameAuthoritativeQuoteIdentity(selectedForChain, item));
    if (!match) {
      return { selected: null, items: chainItems, expired: true, reason: "missing_or_ineligible", defaulted: false };
    }
    if (!quoteVersionUnchanged(selectedForChain, match)) {
      return { selected: null, items: chainItems, expired: true, reason: "version_changed", defaulted: false };
    }
    return { selected: match, items: chainItems, expired: false, reason: null, defaulted: false };
  }

  const native = defaultNativeQuoteAsset(chainItems, chainId);
  return {
    selected: native,
    items: chainItems,
    expired: false,
    reason: native ? "default_native" : "empty",
    defaulted: Boolean(native),
  };
}

export const CREATOR_QUOTE_CATEGORIES = Object.freeze([
  { id: "CORE", label: "Core" },
  { id: "STABLES_CURRENCIES", label: "Stables & currencies" },
  { id: "STOCKS", label: "Stocks" },
  { id: "ETFS", label: "ETFs" },
  { id: "RWA_COMMODITIES", label: "RWA & commodities" },
  { id: "ECOSYSTEM", label: "Ecosystem" },
  { id: "MEMEWARZONE", label: "MemeWarzone" },
  { id: "COMMUNITY", label: "Community" },
]);

export const CREATOR_QUOTE_CATEGORY_IDS = new Set(CREATOR_QUOTE_CATEGORIES.map((item) => item.id));

export function normalizedCreatorQuoteCategory(asset) {
  const category = String(asset?.category || "").trim().toUpperCase();
  if (CREATOR_QUOTE_CATEGORY_IDS.has(category)) return category;
  return "ECOSYSTEM";
}

export function isCreatorQuoteSelectable(asset) {
  if (!asset || asset.newGraduationEligible !== true) return false;
  if (String(asset.adminState || "enabled").toLowerCase() === "disabled") return false;
  const catalogState = String(asset.catalogState || "ACTIVE").toUpperCase();
  if (["PENDING", "REJECTED", "DISABLED", "SUPPORT_ONLY"].includes(catalogState)) return false;
  return true;
}

export function creatorQuoteIdentityKey(asset) {
  const chainId = String(asset?.chainId || "").trim();
  const provider = String(asset?.provider?.key || "").trim().toLowerCase();
  const exactIdentity = String(asset?.contractAddressOrMint || "").trim();
  const id = String(asset?.id || "").trim();
  if (!chainId || !provider || !exactIdentity || !id) return "";
  const normalizedIdentity = chainId === "101" ? exactIdentity : exactIdentity.toLowerCase();
  return `${chainId}:${provider}:${normalizedIdentity}:${id}`;
}

export function filterCreatorQuoteAssets(items, { chainId, query = "", category = "ALL" } = {}) {
  const wantedChain = chainId == null ? "" : String(chainId);
  const wantedCategory = String(category || "ALL").toUpperCase();
  const needle = String(query || "").trim().toLowerCase();
  return (Array.isArray(items) ? items : [])
    .filter(isCreatorQuoteSelectable)
    .filter((asset) => !wantedChain || String(asset.chainId) === wantedChain)
    .filter((asset) => wantedCategory === "ALL" || normalizedCreatorQuoteCategory(asset) === wantedCategory)
    .filter((asset) => {
      if (!needle) return true;
      return [
        asset.symbol,
        asset.displayName,
        asset.provider?.displayName,
        asset.provider?.key,
        normalizedCreatorQuoteCategory(asset),
      ].some((value) => String(value || "").toLowerCase().includes(needle));
    });
}

export function availableCreatorQuoteCategories(items, chainId) {
  const visible = filterCreatorQuoteAssets(items, { chainId });
  const present = new Set(visible.map(normalizedCreatorQuoteCategory));
  return CREATOR_QUOTE_CATEGORIES.filter((category) => present.has(category.id));
}

export function quoteHasTrendingDisplayMetadata(asset) {
  return (Array.isArray(asset?.tags) ? asset.tags : []).some((tag) => String(tag).toUpperCase() === "TRENDING");
}

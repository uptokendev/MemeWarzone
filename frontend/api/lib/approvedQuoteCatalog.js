import fs from "node:fs";

const manifestUrl = new URL("../data/approved-quote-catalog.v1.json", import.meta.url);
export const APPROVED_QUOTE_CATALOG = Object.freeze(JSON.parse(fs.readFileSync(manifestUrl, "utf8")));

export const QUOTE_CATEGORIES = Object.freeze([
  "CORE",
  "STABLES_CURRENCIES",
  "STOCKS",
  "ETFS",
  "RWA_COMMODITIES",
  "ECOSYSTEM",
  "MEMEWARZONE",
  "COMMUNITY",
]);

function normalizedAddress(chainId, value) {
  const raw = String(value || "").trim();
  return String(chainId) === "101" ? raw : raw.toLowerCase();
}

export function quoteIdentityKey({ chainId, provider, address }) {
  const chain = String(chainId || "").trim();
  const providerKey = String(provider || "").trim().toLowerCase();
  const identity = normalizedAddress(chain, address);
  if (!chain || !providerKey || !identity) throw new Error("chain, provider and exact address/mint are required");
  return `${chain}:${providerKey}:${identity}`;
}

const manifestByIdentity = new Map(
  APPROVED_QUOTE_CATALOG.assets.map((asset) => [
    quoteIdentityKey({ chainId: asset.chainId, provider: asset.provider, address: asset.address }),
    asset,
  ]),
);

export function findManifestAsset({ chainId, provider, address }) {
  if (String(chainId) === "102") return null;
  return manifestByIdentity.get(quoteIdentityKey({ chainId, provider, address })) || null;
}

export function assertManifestIdentity({ chainId, provider, address, expectedChainId, expectedProvider }) {
  if (String(chainId) !== String(expectedChainId)) throw new Error("WRONG_CHAIN_QUOTE_IDENTITY");
  if (String(chainId) === "102") throw new Error("LEGACY_SOLANA_CHAIN_NOT_CURRENT_AUTHORITY");
  if (String(provider).toLowerCase() !== String(expectedProvider).toLowerCase()) throw new Error("QUOTE_PROVIDER_MISMATCH");
  const asset = findManifestAsset({ chainId, provider, address });
  if (!asset) throw new Error("QUOTE_IDENTITY_NOT_IN_APPROVED_CATALOG");
  return asset;
}

export function evidenceIsFresh(lastVerifiedAt, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!lastVerifiedAt) return false;
  const checked = new Date(lastVerifiedAt).getTime();
  return Number.isFinite(checked) && now - checked <= maxAgeMs;
}

export function candidateCanActivate(candidate, { now = Date.now(), maxAgeMs } = {}) {
  if (!candidate || String(candidate.chainId) === "102") return false;
  if (candidate.adminState !== "enabled" || candidate.proposedState !== "ACTIVE") return false;
  if (candidate.identity !== "VERIFIED" || candidate.transferability !== "VERIFIED" || candidate.security !== "VERIFIED") return false;
  if (candidate.route !== "VERIFIED" || candidate.price !== "VERIFIED" || candidate.lp !== "VERIFIED") return false;
  return evidenceIsFresh(candidate.lastVerifiedAt, { now, maxAgeMs });
}

function inferredCategory(item) {
  if (item.assetClass === "NATIVE") return "CORE";
  if (item.assetClass === "STABLECOIN") return "STABLES_CURRENCIES";
  if (item.assetClass === "COMMODITY") return "RWA_COMMODITIES";
  if (item.assetClass === "MWZ_NATIVE") return "MEMEWARZONE";
  if (item.assetClass === "COMMUNITY") return "COMMUNITY";
  if (item.assetClass === "PROVIDER_RWA" || item.assetClass === "PUBLIC_RWA" || item.assetClass === "PRE_IPO_RWA") return "STOCKS";
  return "ECOSYSTEM";
}

export function decorateQuoteAsset(item) {
  const manifest = findManifestAsset({
    chainId: item.chainId,
    provider: item.provider?.key,
    address: item.contractAddressOrMint,
  });
  return {
    ...item,
    category: manifest?.category || inferredCategory(item),
    tags: manifest?.tags || [],
    providerAssetId: manifest?.providerAssetId || null,
    catalogState: manifest?.proposedState || (item.newGraduationEligible ? "ACTIVE" : "CANDIDATE"),
    chainFamily: APPROVED_QUOTE_CATALOG.chains[String(item.chainId)]?.family || null,
    decimals: manifest?.decimals ?? null,
    evidence: manifest?.evidence || [],
  };
}

export function filterCreatorGraduationAssets(items, { category, provider, search } = {}) {
  const normalizedCategory = String(category || "").trim().toUpperCase();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const needle = String(search || "").trim().toLowerCase();
  return items
    .filter((item) => String(item?.chainId) !== "102" && item?.newGraduationEligible === true)
    .map(decorateQuoteAsset)
    .filter((item) => !normalizedCategory || item.category === normalizedCategory)
    .filter((item) => !normalizedProvider || String(item.provider?.key || "").toLowerCase() === normalizedProvider)
    .filter((item) => {
      if (!needle) return true;
      return [item.symbol, item.displayName, item.provider?.displayName, item.provider?.key, item.category, ...(item.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
}

export function summarizeCandidateInventory() {
  const result = {};
  for (const asset of APPROVED_QUOTE_CATALOG.assets) {
    const chain = String(asset.chainId);
    result[chain] ||= { researched: 0, identityVerified: 0, activeSnapshot: 0, pending: 0, rejected: 0 };
    result[chain].researched += 1;
    if (asset.identity === "VERIFIED") result[chain].identityVerified += 1;
    if (asset.proposedState === "ACTIVE") result[chain].activeSnapshot += 1;
    else if (asset.proposedState === "REJECTED") result[chain].rejected += 1;
    else result[chain].pending += 1;
  }
  return result;
}

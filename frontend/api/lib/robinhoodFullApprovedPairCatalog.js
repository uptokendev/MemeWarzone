import { APPROVED_QUOTE_CATALOG } from "./approvedQuoteCatalog.js";
import {
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_STOCK_PROVIDER,
  ROBINHOOD_STOCK_PROVIDER_AUTHORITY,
} from "./robinhoodStockRuntimeCertification.js";

export const ROBINHOOD_BASIC_PROVIDER_KEY = "robinhood-basic";
export const ROBINHOOD_CHAIN_CANONICAL_AUTHORITY = "ROBINHOOD_CHAIN_CANONICAL";

const FORBIDDEN_SOLANA_PROVIDER_KEYS = new Set([
  "xstocks",
  "prestocks",
  "sunrise",
]);

function isRobinhoodAsset(asset) {
  return String(asset?.chainId) === String(ROBINHOOD_MAINNET_CHAIN_ID);
}

export function classifyRobinhoodPairCandidate(asset) {
  if (!asset) return "OTHER_CANONICAL";
  if (asset.assetClass === "NATIVE") return "ETH_NATIVE";
  if (asset.assetClass === "STABLECOIN") return "STABLECOIN";
  if (asset.assetClass === "PRE_IPO_RWA") return "PRE_IPO";
  if (asset.category === "ETFS") return "ETF";
  if (asset.assetClass === "COMMODITY" || asset.category === "RWA_COMMODITIES") return "PROVIDER_RWA";
  if (asset.assetClass === "PUBLIC_RWA" || asset.assetClass === "PROVIDER_RWA") return "STOCK";
  if (asset.assetClass === "CRYPTO") return "CRYPTO";
  if (asset.assetClass === "LEVERAGED_OR_YIELD") return "LEVERAGE_YIELD";
  if (asset.assetClass === "COLLECTIBLE") return "COLLECTIBLE";
  return asset.category === "STABLES_CURRENCIES" ? "CURRENCY" : "OTHER_CANONICAL";
}

export function providerAuthorityForRobinhoodAsset(asset) {
  if (asset?.provider === ROBINHOOD_STOCK_PROVIDER) return ROBINHOOD_STOCK_PROVIDER_AUTHORITY;
  if (asset?.provider === ROBINHOOD_BASIC_PROVIDER_KEY) return ROBINHOOD_CHAIN_CANONICAL_AUTHORITY;
  return String(asset?.provider || "UNKNOWN").toUpperCase();
}

export function assertNoSolanaProviderAssumptions(asset) {
  if (!isRobinhoodAsset(asset)) return;
  const provider = String(asset?.provider || "").trim().toLowerCase();
  if (FORBIDDEN_SOLANA_PROVIDER_KEYS.has(provider)) {
    throw new Error(`SOLANA_PROVIDER_NOT_ROBINHOOD_AUTHORITY:${provider}`);
  }
}

function routeProjection(asset) {
  const category = classifyRobinhoodPairCandidate(asset);
  if (asset.symbol === "WETH") {
    return {
      priceAuthority: "native ETH/USD runtime authority",
      ethAcquisitionRoute: "ETH -> WETH canonical wrap",
      graduationRoute: "STANDARD_NATIVE",
      v3Venue: "Robinhood V3 + PermanentV3PositionLocker",
    };
  }
  if (asset.provider === ROBINHOOD_STOCK_PROVIDER) {
    return {
      priceAuthority: `${asset.symbol}/USD oracle from Stock Graduation Adapter`,
      ethAcquisitionRoute: `ETH -> WETH -> ${asset.symbol} via configured canonical V3 acquisition pool`,
      graduationRoute: "STOCK_BATTLEFIELD",
      v3Venue: "Robinhood V3 + PermanentV3PositionLocker",
    };
  }
  if (category === "STABLECOIN" || category === "CURRENCY") {
    return {
      priceAuthority: `${asset.symbol}/USD authority required`,
      ethAcquisitionRoute: `ETH -> WETH -> ${asset.symbol} executable route required`,
      graduationRoute: "GENERIC_QUOTE_PENDING_RUNTIME",
      v3Venue: "Robinhood V3 required",
    };
  }
  return {
    priceAuthority: "provider/oracle authority required",
    ethAcquisitionRoute: `ETH -> WETH -> ${asset.symbol} executable route required`,
    graduationRoute: "GENERIC_QUOTE_PENDING_RUNTIME",
    v3Venue: "Robinhood V3 required",
  };
}

export function listRobinhoodManifestPairCandidates() {
  return APPROVED_QUOTE_CATALOG.assets
    .filter(isRobinhoodAsset)
    .map((asset) => {
      assertNoSolanaProviderAssumptions(asset);
      const route = routeProjection(asset);
      return {
        asset: asset.symbol,
        displayName: asset.displayName,
        category: classifyRobinhoodPairCandidate(asset),
        contract: asset.address,
        provider: providerAuthorityForRobinhoodAsset(asset),
        providerKey: asset.provider,
        decimals: Number(asset.decimals),
        priceAuthority: route.priceAuthority,
        ethAcquisitionRoute: route.ethAcquisitionRoute,
        graduationRoute: route.graduationRoute,
        v3Venue: route.v3Venue,
        liquidity: "PENDING_RUNTIME_CERTIFICATION",
        capacity: "PENDING_RUNTIME_CERTIFICATION",
        health: asset.provider === ROBINHOOD_STOCK_PROVIDER ? "PENDING_STOCK_RUNTIME" : "PENDING_GENERIC_RUNTIME",
        disposition: "PENDING",
        manifestState: asset.proposedState,
        identityStatus: asset.identity,
        evidence: asset.evidence || [],
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.asset.localeCompare(b.asset));
}

export function summarizeRobinhoodManifestPairCandidates() {
  const candidates = listRobinhoodManifestPairCandidates();
  const categories = {};
  for (const candidate of candidates) categories[candidate.category] = (categories[candidate.category] || 0) + 1;
  return {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    candidates: candidates.length,
    categories,
    active: candidates.filter((item) => item.disposition === "ACTIVE").length,
    pending: candidates.filter((item) => item.disposition !== "ACTIVE").length,
  };
}

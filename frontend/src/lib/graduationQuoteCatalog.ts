import { apiFetch } from "@/lib/apiBase";
import type { RobinhoodStockToken } from "@/lib/marketContinuityApi";
import { fetchRobinhoodStockGraduationAssets } from "@/lib/robinhoodStockCreate";
import {
  catalogQuoteAssetsOnly,
  isRobinhoodStockQuote,
} from "@/lib/graduationMarketPresentation.mjs";

export type GraduationQuoteAsset = {
  id: string;
  assetId?: string | null;
  provider?: {
    id?: string;
    key?: string;
    displayName?: string;
    authorityMode?: string;
    providerClass?: string;
  };
  providerAssetId?: string | null;
  chainId: string;
  chainFamily?: string | null;
  identityKind?: string;
  contractAddressOrMint?: string;
  assetClass?: string;
  category?: string;
  tags?: string[];
  catalogState?: string;
  decimals?: number | null;
  symbol?: string;
  displayName?: string;
  logoUrl?: string | null;
  stateVersion?: number;
  identityStatus?: string;
  securityStatus?: string;
  marketHealthStatus?: string;
  newGraduationEligible?: boolean;
  existingMarketSupport?: boolean;
  adminState?: string;
  policy?: {
    authority?: string;
    source?: string;
    policyKey?: string | null;
    version?: number | string | null;
    active?: boolean;
    basicApproved?: boolean;
  };
  lastVerifiedAt?: string | null;
  presentationDefault?: boolean;
};

let lastFreshSelection: GraduationQuoteAsset | null = null;

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String((body as { error?: string; message?: string } | null)?.error || (body as { message?: string } | null)?.message || `Request failed (${response.status})`));
  }
  return body as T;
}

export async function fetchGraduationQuoteAssets(chainId: number): Promise<GraduationQuoteAsset[]> {
  const response = await apiFetch(
    `/api/graduation/quote-assets?chainId=${encodeURIComponent(String(chainId))}`,
    { method: "GET", cache: "no-store" },
  );
  const body = await readJson<{ items?: GraduationQuoteAsset[] }>(response);
  return catalogQuoteAssetsOnly(Array.isArray(body?.items) ? body.items : [])
    .filter((item) => item.newGraduationEligible === true && String(item.chainId) === String(chainId));
}

export async function fetchGraduationQuoteAssetDetail(id: string): Promise<GraduationQuoteAsset> {
  const response = await apiFetch(
    `/api/graduation/quote-assets/${encodeURIComponent(String(id))}`,
    { method: "GET", cache: "no-store" },
  );
  const body = await readJson<{ item?: GraduationQuoteAsset }>(response);
  if (!body?.item?.id) throw new Error("Graduation quote asset not found.");
  return body.item;
}

export async function assertFreshGraduationQuote(asset: GraduationQuoteAsset): Promise<GraduationQuoteAsset> {
  const id = String(asset?.id || "").trim();
  if (!id || asset?.presentationDefault === true) {
    lastFreshSelection = null;
    throw new Error("Choose a currently approved Graduation Market before continuing.");
  }
  const fresh = await fetchGraduationQuoteAssetDetail(id);
  const sameChain = String(fresh.chainId) === String(asset.chainId);
  const sameProvider = String(fresh.provider?.key || "").toLowerCase() === String(asset.provider?.key || "").toLowerCase();
  const sourceIdentity = String(asset.contractAddressOrMint || "");
  const freshIdentity = String(fresh.contractAddressOrMint || "");
  const sameIdentity = String(fresh.chainId) === "101"
    ? freshIdentity === sourceIdentity
    : freshIdentity.toLowerCase() === sourceIdentity.toLowerCase();
  if (!sameChain || !sameProvider || !sameIdentity || fresh.newGraduationEligible !== true) {
    lastFreshSelection = null;
    throw new Error("That Graduation Market is no longer approved. Select another currently available market.");
  }
  lastFreshSelection = fresh;
  return fresh;
}

export function lastFreshGraduationQuote(chainId?: number): GraduationQuoteAsset | null {
  if (!lastFreshSelection) return null;
  if (chainId != null && String(lastFreshSelection.chainId) !== String(chainId)) return null;
  return lastFreshSelection;
}

export function clearFreshGraduationQuote() {
  lastFreshSelection = null;
}

export async function resolveRobinhoodStockTokenForQuote(
  chainId: number,
  asset: GraduationQuoteAsset,
): Promise<RobinhoodStockToken> {
  if (!isRobinhoodStockQuote(asset)) {
    throw new Error("Selected Graduation Market is not a Robinhood Stock Token.");
  }
  const wanted = String(asset.contractAddressOrMint || "").toLowerCase();
  const items = await fetchRobinhoodStockGraduationAssets(chainId);
  const found = items.find((item) => String(item.contractAddress || "").toLowerCase() === wanted);
  if (!found) throw new Error("Selected Stock Token is not in the Robinhood registry.");
  return found;
}

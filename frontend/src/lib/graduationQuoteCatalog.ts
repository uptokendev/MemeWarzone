import { apiFetch } from "@/lib/apiBase";
import type { RobinhoodStockToken } from "@/lib/marketContinuityApi";
import { fetchRobinhoodStockGraduationAssets } from "@/lib/robinhoodStockCreate";
import {
  isRobinhoodStockQuote,
  mergeCatalogWithNativeDefault,
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
  chainId: string;
  identityKind?: string;
  contractAddressOrMint?: string;
  assetClass?: string;
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
  return mergeCatalogWithNativeDefault(chainId, Array.isArray(body?.items) ? body.items : []);
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
  if (asset?.presentationDefault) return asset;
  const id = String(asset?.id || "").trim();
  if (!id) throw new Error("Choose a Graduation Market before continuing.");
  const fresh = await fetchGraduationQuoteAssetDetail(id);
  if (fresh.newGraduationEligible !== true) {
    throw new Error("Graduation Market is no longer eligible. Choose another quote asset.");
  }
  return fresh;
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

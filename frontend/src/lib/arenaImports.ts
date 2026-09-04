import { apiFetch } from "@/lib/apiBase";
import { appendAuthToSearchParams, type WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ArenaImportStatus = "scanning" | "passed" | "needs_review" | "declined";

export type ArenaImportItem = {
  id: string;
  chainId: number;
  tokenAddress: string;
  ownerWallet: string;
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  website?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  verifiedAt?: string | null;
  metadataUpdatedAt?: string | null;
  status: ArenaImportStatus;
  scan?: Record<string, unknown>;
  reviewRequestedAt?: string | null;
  reviewReason?: string | null;
};

export type ArenaTokenProfile = {
  identity: string;
  chainId: number;
  origin: "native" | "import" | string;
  tokenAddress: string | null;
  campaignAddress: string | null;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  creatorWallet: string | null;
  creatorDisplay: string | null;
  description: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
  verifiedAt?: string | null;
  metadataUpdatedAt?: string | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  volume24hUsd: number | null;
  holders: number | null;
  liquidityUsd: number | null;
  marketDataUpdatedAt: string | null;
  marketDataSource: string;
  marketDataHealthy: boolean;
  marketDataReasons: string[];
};

async function readJson(res: Response) {
  return res.json().catch(() => ({})) as Promise<any>;
}

export async function fetchArenaImports(wallet: string, chainId?: number | null): Promise<ArenaImportItem[]> {
  const params = new URLSearchParams({ wallet });
  if (chainId) params.set("chainId", String(chainId));
  const res = await apiFetch(`/api/arena/imports?${params.toString()}`, { cache: "no-store" });
  const json = await readJson(res);
  return Array.isArray(json?.items) ? json.items : [];
}

export async function lookupArenaImport(tokenAddress: string, chainId: number): Promise<ArenaImportItem | null> {
  const params = new URLSearchParams({ token: tokenAddress, chainId: String(chainId) });
  const res = await apiFetch(`/api/arena/imports/lookup?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = await readJson(res);
  return json?.item || null;
}

export async function fetchArenaTokenProfile(tokenAddress: string, chainId: number, signal?: AbortSignal): Promise<ArenaTokenProfile | null> {
  const params = new URLSearchParams({ token: tokenAddress, chainId: String(chainId) });
  const res = await apiFetch(`/api/arena/imports/profile?${params.toString()}`, { cache: "no-store", signal });
  if (!res.ok) return null;
  const json = await readJson(res);
  return json?.profile || null;
}

export async function submitArenaImport(input: {
  tokenAddress: string;
  chainId: number;
  walletAddress: string;
  auth: WalletActionAuthPayload;
}): Promise<ArenaImportItem> {
  const res = await apiFetch("/api/arena/imports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await readJson(res);
  if (!res.ok || json?.ok === false) throw new Error(String(json?.error || json?.reason || `Import failed (${res.status})`));
  return json.item;
}

export async function uploadArenaImportImage(input: {
  item: ArenaImportItem;
  file: File;
  auth: WalletActionAuthPayload;
}): Promise<{ url: string; metadataUpdatedAt?: string | null; verifiedAt?: string | null }> {
  const form = new FormData();
  form.append("file", input.file);
  const params = new URLSearchParams({
    kind: "arena_import",
    importId: input.item.id,
    chainId: String(input.item.chainId),
  });
  appendAuthToSearchParams(params, input.auth);
  const res = await apiFetch(`/api/upload?${params.toString()}`, { method: "POST", body: form });
  const json = await readJson(res);
  if (!res.ok || !json?.url || json?.persistedArenaImportImage !== true) {
    throw new Error(String(json?.error || json?.message || `Image upload failed (${res.status})`));
  }
  return {
    url: String(json.url),
    metadataUpdatedAt: json.metadataUpdatedAt || null,
    verifiedAt: json.verifiedAt || null,
  };
}

export async function requestArenaImportReview(id: string, auth: WalletActionAuthPayload, reason?: string): Promise<ArenaImportItem> {
  const res = await apiFetch(`/api/arena/imports/${encodeURIComponent(id)}/request-review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, reason }),
  });
  const json = await readJson(res);
  if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `Review request failed (${res.status})`));
  return json.item;
}

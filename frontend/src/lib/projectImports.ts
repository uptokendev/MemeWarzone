import { apiFetch } from "@/lib/apiBase";
import { appendAuthToSearchParams, type WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ProjectImportStatus = "scanning" | "passed" | "needs_review" | "declined";

export type ProjectImportItem = {
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
  status: ProjectImportStatus;
  reviewRequestedAt?: string | null;
  reviewReason?: string | null;
};

async function readJson(res: Response) {
  return res.json().catch(() => ({})) as Promise<any>;
}

export async function lookupProjectImport(tokenAddress: string, chainId: number): Promise<ProjectImportItem | null> {
  const params = new URLSearchParams({ token: tokenAddress, chainId: String(chainId) });
  const res = await apiFetch(`/api/arena/imports/lookup?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = await readJson(res);
  return json?.item || null;
}

export async function createProjectImport(input: {
  tokenAddress: string;
  chainId: number;
  walletAddress: string;
  auth: WalletActionAuthPayload;
}): Promise<{ item: ProjectImportItem; ownershipVerified: boolean }> {
  const res = await apiFetch("/api/arena/imports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await readJson(res);
  if (!res.ok || json?.ok === false || !json?.item) {
    throw new Error(String(json?.error || json?.reason || `Project import failed (${res.status})`));
  }
  return { item: json.item, ownershipVerified: Boolean(json.ownershipVerified || json.item?.verifiedAt) };
}

export async function requestProjectClaim(id: string, auth: WalletActionAuthPayload): Promise<ProjectImportItem> {
  const res = await apiFetch(`/api/arena/imports/${encodeURIComponent(id)}/request-review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, reason: "Project ownership claim requested from import onboarding." }),
  });
  const json = await readJson(res);
  if (!res.ok || json?.ok === false || !json?.item) {
    throw new Error(String(json?.error || `Project claim request failed (${res.status})`));
  }
  return json.item;
}

export async function updateProjectImportProfile(input: {
  item: ProjectImportItem;
  auth: WalletActionAuthPayload;
  description: string;
  website: string;
  xUrl: string;
  telegramUrl: string;
}): Promise<ProjectImportItem> {
  const res = await apiFetch(`/api/arena/imports/${encodeURIComponent(input.item.id)}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      auth: input.auth,
      description: input.description,
      website: input.website,
      xUrl: input.xUrl,
      telegramUrl: input.telegramUrl,
    }),
  });
  const json = await readJson(res);
  if (!res.ok || json?.ok === false || !json?.item) {
    throw new Error(String(json?.error || `Project profile update failed (${res.status})`));
  }
  return json.item;
}

export async function uploadProjectImportImage(input: {
  item: ProjectImportItem;
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

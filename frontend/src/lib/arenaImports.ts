import { apiFetch } from "@/lib/apiBase";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ArenaImportStatus = "scanning" | "passed" | "needs_review" | "declined";

export type ArenaImportItem = {
  id: string;
  chainId: number;
  tokenAddress: string;
  ownerWallet: string;
  name?: string | null;
  symbol?: string | null;
  status: ArenaImportStatus;
  scan?: Record<string, unknown>;
  reviewRequestedAt?: string | null;
  reviewReason?: string | null;
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

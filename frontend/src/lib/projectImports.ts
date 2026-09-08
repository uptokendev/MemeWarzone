import { apiFetch } from "@/lib/apiBase";
import { appendAuthToSearchParams, type WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ProjectOwnershipStatus = "ownership_pending" | "ownership_verified" | "ownership_manual_review" | "ownership_suspended";
export type ProjectImportItem = {
  id: string;
  chainId: number;
  tokenAddress: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  totalSupply?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  website?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  ownershipStatus: ProjectOwnershipStatus;
  projectOwnerWallet?: string | null;
  ownershipVerifiedAt?: string | null;
  manualClaimWallet?: string | null;
  manualClaimRequestedAt?: string | null;
  metadataUpdatedAt?: string | null;
  arenaStatus?: string | null;
  createdAt?: string | null;
};
export type ProjectResolveResult = {
  chainId: number;
  tokenAddress: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  totalSupply?: string | null;
  automaticOwnershipAvailable: boolean;
  currentAuthority?: string | null;
  signedWalletMatchesAuthority: boolean;
};

async function readJson(res: Response) { return res.json().catch(() => ({})) as Promise<any>; }
function stable(value: any): any { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
async function sha256HexBytes(bytes: ArrayBuffer | Uint8Array) { const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); const digest = await crypto.subtle.digest("SHA-256", data); return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function sha256HexText(text: string) { return sha256HexBytes(new TextEncoder().encode(text)); }
function canonicalToken(chainId: number, token: string) { const raw = String(token || "").trim(); return chainId === 101 ? raw : raw.toLowerCase(); }
export async function projectImportIntentLines(input: { action: string; chainId: number; token: string; projectId?: string | null; body?: unknown; imageDigest?: string | null }) {
  const intent = { action: input.action, chainId: Number(input.chainId), token: canonicalToken(input.chainId, input.token), projectId: input.projectId ? String(input.projectId) : null, body: input.body == null ? null : stable(input.body), imageDigest: input.imageDigest ? String(input.imageDigest).toLowerCase() : null };
  const digest = await sha256HexText(JSON.stringify(stable(intent)));
  return [`Project token: ${intent.token}`, `Project import intent: ${digest}`];
}
export async function projectImportImageDigest(file: File) { return sha256HexBytes(await file.arrayBuffer()); }

export async function lookupProjectImport(tokenAddress: string, chainId: number): Promise<ProjectImportItem | null> {
  const params = new URLSearchParams({ tokenAddress, chainId: String(chainId) });
  const res = await apiFetch(`/api/project-imports?${params.toString()}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Project lookup failed (${res.status})`)); return json.project;
}
export async function listRecentProjectImports(limit = 24): Promise<ProjectImportItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await apiFetch(`/api/project-imports?${params.toString()}`, { cache: "no-store" });
  const json = await readJson(res);
  if (!res.ok) throw new Error(String(json?.error || `Imported project list failed (${res.status})`));
  return Array.isArray(json?.items) ? json.items : [];
}
export async function resolveProjectImport(input: { tokenAddress: string; chainId: number; auth: WalletActionAuthPayload }): Promise<ProjectResolveResult> {
  const res = await apiFetch("/api/project-imports/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const json = await readJson(res); if (!res.ok || !json?.resolved) throw new Error(String(json?.error || `Project resolve failed (${res.status})`)); return json.resolved;
}
export async function createProjectImport(input: { tokenAddress: string; chainId: number; auth: WalletActionAuthPayload }): Promise<{ project: ProjectImportItem; created: boolean; ownershipEvidence?: ProjectResolveResult }> {
  const res = await apiFetch("/api/project-imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Project import failed (${res.status})`)); return { project: json.project, created: Boolean(json.created), ownershipEvidence: json.ownershipEvidence };
}
export async function claimProjectImport(input: { item: ProjectImportItem; auth: WalletActionAuthPayload }): Promise<ProjectImportItem> {
  const res = await apiFetch("/api/project-imports/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: input.item.chainId, tokenAddress: input.item.tokenAddress, auth: input.auth }) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Project ownership claim failed (${res.status})`)); return json.project;
}
export async function requestProjectClaim(input: { item: ProjectImportItem; auth: WalletActionAuthPayload; note?: string }): Promise<ProjectImportItem> {
  const res = await apiFetch("/api/project-imports/manual-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: input.item.chainId, tokenAddress: input.item.tokenAddress, note: input.note || null, auth: input.auth }) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Project claim request failed (${res.status})`)); return json.project;
}
export async function updateProjectImportProfile(input: { item: ProjectImportItem; auth: WalletActionAuthPayload; description: string; website: string; xUrl: string; telegramUrl: string }): Promise<ProjectImportItem> {
  const metadata = { description: input.description, website: input.website, x_url: input.xUrl, telegram_url: input.telegramUrl };
  const res = await apiFetch("/api/project-imports", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: input.item.chainId, tokenAddress: input.item.tokenAddress, metadata, auth: input.auth }) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Project profile update failed (${res.status})`)); return json.project;
}
export async function uploadProjectImportImage(input: { item: ProjectImportItem; file: File; auth: WalletActionAuthPayload }): Promise<ProjectImportItem> {
  const form = new FormData(); form.append("file", input.file);
  const params = new URLSearchParams({ chainId: String(input.item.chainId), tokenAddress: input.item.tokenAddress }); appendAuthToSearchParams(params, input.auth);
  const res = await apiFetch(`/api/project-imports/image?${params.toString()}`, { method: "POST", body: form });
  const json = await readJson(res); if (!res.ok || !json?.project) throw new Error(String(json?.error || `Image upload failed (${res.status})`)); return json.project;
}
export async function uploadProjectRegistrationImage(input: { item: ProjectImportItem; file: File; auth: WalletActionAuthPayload }): Promise<ProjectImportItem> {
  return uploadProjectImportImage(input);
}

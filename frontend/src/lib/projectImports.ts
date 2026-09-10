import { normalizeRouteWallet } from "@/lib/address";
import { apiFetch } from "@/lib/apiBase";
import { appendAuthToSearchParams, type WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ProjectOwnershipStatus = "ownership_pending" | "ownership_verified" | "ownership_manual_review" | "ownership_suspended";
export type ProjectImportSecurityRisk = { code: string; label: string };
export type ProjectImportSecurity = {
  status: "pass" | "review" | "blocked";
  provider: string;
  criticalRisks: ProjectImportSecurityRisk[];
  reviewRisks: ProjectImportSecurityRisk[];
  details?: Record<string, unknown>;
};
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
export type ImportAssessment = {
  decision: string; checkedAt: string; policyVersion: string;
  automaticImportAllowed: boolean; manualRequestAllowed: boolean; canVerifyOwner: boolean;
  checks: { key: string; status: string; title: string; finding: string; meaning: string; nextAction: string }[];
};
export type ProjectResolveResult = {
  assessment?: ImportAssessment;
  retainedPageOnly?: boolean;
  market?: {phase:string;verified:boolean;reason?:string;platform?:string;requiresLaunchReview?:boolean};
  projectAuthorityEvidence?: {authorityType:string;relationships?:{kind:string;shareBps?:number;wallet:string}[]};
  chainId: number;
  tokenAddress: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  totalSupply?: string | null;
  automaticOwnershipAvailable: boolean;
  currentAuthority?: string | null;
  signedWalletMatchesAuthority: boolean;
  security?: ProjectImportSecurity;
  authoritySource?: string | null;
  authorityEvidenceAccount?: string | null;
  ownershipReason?: string | null;
  mintAuthority?: string | null;
  ownershipProofSource?: string | null;
  ownershipProofTxSignature?: string | null;
};
export type PumpOwnershipChallenge = { id:string; chainId:number; tokenAddress:string; creatorWallet:string; claimantWallet:string; lamports:string; solAmount:string; createdAt:string; expiresAt:string; verifiedAt?:string|null; txSignature?:string|null; status:"pending"|"verified"|"expired" };

async function readJson(res: Response) { return res.json().catch(() => ({})) as Promise<any>; }
function importRequestError(res: Response, json: any, fallback: string) {
  return Object.assign(new Error(String(json?.error || fallback)), { status: res.status, code: json?.code || null, currentAuthority: json?.currentAuthority || null });
}
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
  const json = await readJson(res);
  // Compatibility with the explicit legacy empty-lookup response only.
  if (res.status === 404 && json?.code === "PROJECT_NOT_FOUND") return null;
  if (!res.ok || !Object.hasOwn(json, "project")) throw importRequestError(res, json, `Project lookup failed (${res.status})`);
  return json.project ?? null;
}
export async function listRecentProjectImports(limit = 24): Promise<ProjectImportItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await apiFetch(`/api/project-imports?${params.toString()}`, { cache: "no-store" });
  const json = await readJson(res);
  if (!res.ok) throw importRequestError(res, json, `Imported project list failed (${res.status})`);
  return Array.isArray(json?.items) ? json.items : [];
}
export async function listUserProjectImports(walletAddress: string, chainId: number): Promise<ProjectImportItem[]> {
  const params = new URLSearchParams({ wallet: walletAddress, chainId: String(chainId) });
  const res = await apiFetch(`/api/project-imports?${params.toString()}`, { cache: "no-store" });
  const json = await readJson(res);
  if (!res.ok) throw importRequestError(res, json, `Imported project wallet lookup failed (${res.status})`);
  return Array.isArray(json?.items) ? json.items : [];
}
export function commandCenterImportPath(wallet?: string | null): string {
  const normalized = normalizeRouteWallet(wallet);
  if (!normalized) return "/profile?import=1";
  return `/profile/${encodeURIComponent(normalized)}/command/coins?import=1`;
}
export async function resolveProjectImport(input: { tokenAddress: string; chainId: number; auth: WalletActionAuthPayload }): Promise<ProjectResolveResult> {
  return (await resolveProjectImportWithProject(input)).resolved;
}
export async function resolveProjectImportWithProject(input: { tokenAddress: string; chainId: number; auth: WalletActionAuthPayload }): Promise<{ resolved: ProjectResolveResult; project: ProjectImportItem | null }> {
  const res = await apiFetch("/api/project-imports/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const json = await readJson(res);
  if (!res.ok || !json?.resolved) throw importRequestError(res, json, `Project resolve failed (${res.status})`);
  return { resolved: json.resolved, project: json.project ?? null };
}
export async function createProjectImport(input: { tokenAddress: string; chainId: number; auth: WalletActionAuthPayload }): Promise<{ project: ProjectImportItem; created: boolean; ownershipEvidence?: ProjectResolveResult }> {
  const res = await apiFetch("/api/project-imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw importRequestError(res, json, `Project import failed (${res.status})`); return { project: json.project, created: Boolean(json.created), ownershipEvidence: json.ownershipEvidence };
}
export async function claimProjectImport(input: { item: ProjectImportItem; auth: WalletActionAuthPayload }): Promise<ProjectImportItem> {
  const res = await apiFetch("/api/project-imports/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: input.item.chainId, tokenAddress: input.item.tokenAddress, auth: input.auth }) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw importRequestError(res, json, `Project ownership claim failed (${res.status})`); return json.project;
}
export async function requestProjectClaim(input: { item: ProjectImportItem; auth: WalletActionAuthPayload; note?: string }): Promise<ProjectImportItem> {
  return requestProjectManualCheck({ chainId: input.item.chainId, tokenAddress: input.item.tokenAddress, auth: input.auth, note: input.note });
}
export async function requestProjectManualCheck(input: { chainId: number; tokenAddress: string; auth: WalletActionAuthPayload; note?: string }): Promise<ProjectImportItem> {
  const res = await apiFetch("/api/project-imports/manual-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: input.chainId, tokenAddress: input.tokenAddress, note: input.note || null, auth: input.auth }) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw importRequestError(res, json, `Project manual check request failed (${res.status})`); return json.project;
}
export async function updateProjectImportProfile(input: { item: ProjectImportItem; auth: WalletActionAuthPayload; description: string; website: string; xUrl: string; telegramUrl: string }): Promise<ProjectImportItem> {
  const metadata = { description: input.description, website: input.website, x_url: input.xUrl, telegram_url: input.telegramUrl };
  const res = await apiFetch("/api/project-imports", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: input.item.chainId, tokenAddress: input.item.tokenAddress, metadata, auth: input.auth }) });
  const json = await readJson(res); if (!res.ok || !json?.project) throw importRequestError(res, json, `Project profile update failed (${res.status})`); return json.project;
}
export async function uploadProjectImportImage(input: { item: ProjectImportItem; file: File; auth: WalletActionAuthPayload }): Promise<ProjectImportItem> {
  const form = new FormData(); form.append("file", input.file);
  const params = new URLSearchParams({ chainId: String(input.item.chainId), tokenAddress: input.item.tokenAddress }); appendAuthToSearchParams(params, input.auth);
  const res = await apiFetch(`/api/project-imports/image?${params.toString()}`, { method: "POST", body: form });
  const json = await readJson(res); if (!res.ok || !json?.project) throw importRequestError(res, json, `Image upload failed (${res.status})`); return json.project;
}
export async function uploadProjectRegistrationImage(input: { item: ProjectImportItem; file: File; auth: WalletActionAuthPayload }): Promise<ProjectImportItem> {
  return uploadProjectImportImage(input);
}

export async function startPumpOwnershipChallenge(input: { tokenAddress:string; chainId:number; auth:WalletActionAuthPayload }): Promise<PumpOwnershipChallenge> {
  const res=await apiFetch("/api/project-imports/pump-challenge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const json=await readJson(res); if(!res.ok||!json?.challenge) throw importRequestError(res,json,`Pump.fun verification could not start (${res.status})`); return json.challenge;
}
export async function checkPumpOwnershipChallenge(input: { tokenAddress:string; chainId:number; challengeId:string; auth:WalletActionAuthPayload }): Promise<{challenge:PumpOwnershipChallenge;resolved:ProjectResolveResult;project:ProjectImportItem|null}> {
  const res=await apiFetch("/api/project-imports/pump-challenge/check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const json=await readJson(res); if(!res.ok||!json?.challenge||!json?.resolved) throw importRequestError(res,json,`Pump.fun verification check failed (${res.status})`); return {challenge:json.challenge,resolved:json.resolved,project:json.project??null};
}

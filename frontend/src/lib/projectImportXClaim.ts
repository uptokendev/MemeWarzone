import { apiFetch } from "@/lib/apiBase";
import type { ProjectImportItem } from "@/lib/projectImports";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ProjectXIdentity = { available: true; username: string; xUrl: string; source: string; imageUrl?: string | null };
export type ProjectEvmAuthority = { available: boolean; currentAuthority: string | null; matchesConnected: boolean; authoritySource?: string | null; creationTx?: string | null; launchpad?: string | null; safe?: { address: string; threshold: number } | null };

/** A tx hash from a pasted hash or explorer link (BscScan, Blockscout), or "". */
export function parseCreationTxInput(value: string) {
  const match = String(value || "").match(/0x[0-9a-fA-F]{64}/);
  return match ? match[0] : "";
}

async function readJson(res: Response) { return res.json().catch(() => ({})) as Promise<any>; }
function requestError(res: Response, json: any, fallback: string) {
  return Object.assign(new Error(String(json?.error || fallback)), { status: res.status, code: json?.code || null, currentAuthority: json?.currentAuthority || null });
}

export async function resolveProjectEvmAuthority(item: ProjectImportItem, walletAddress?: string | null, creationTx?: string | null): Promise<ProjectEvmAuthority> {
  const res = await apiFetch("/api/project-imports/image/x/authority", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: item.chainId, tokenAddress: item.tokenAddress, walletAddress: walletAddress || null, creationTx: creationTx || null }),
  });
  const json = await readJson(res);
  if (!res.ok) throw requestError(res, json, "Current owner wallet could not be resolved.");
  return { available: Boolean(json?.available), currentAuthority: json?.currentAuthority || null, matchesConnected: Boolean(json?.matchesConnected), authoritySource: json?.authoritySource || null, creationTx: json?.creationTx || null, launchpad: json?.launchpad || null, safe: json?.safe || null };
}

export async function resolveProjectXIdentity(item: ProjectImportItem): Promise<ProjectXIdentity> {
  const res = await apiFetch("/api/project-imports/image/x/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: item.chainId, tokenAddress: item.tokenAddress }),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.available || !json?.username) throw requestError(res, json, "Official X account could not be resolved.");
  return json as ProjectXIdentity;
}

export async function startProjectXClaim(item: ProjectImportItem, auth: WalletActionAuthPayload): Promise<{ authorizeUrl: string; expectedUsername: string | null; xUrl: string | null; source: string | null }> {
  const res = await apiFetch("/api/project-imports/image/x/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: item.chainId, tokenAddress: item.tokenAddress, auth }),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.authorizeUrl) throw requestError(res, json, "X verification could not start.");
  return json;
}

import { apiFetch } from "@/lib/apiBase";
import type { ProjectImportItem } from "@/lib/projectImports";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type ProjectXIdentity = { available: true; username: string; xUrl: string; source: string };

async function readJson(res: Response) { return res.json().catch(() => ({})) as Promise<any>; }
function requestError(res: Response, json: any, fallback: string) {
  return Object.assign(new Error(String(json?.error || fallback)), { status: res.status, code: json?.code || null });
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

export async function startProjectXClaim(item: ProjectImportItem, auth: WalletActionAuthPayload): Promise<{ authorizeUrl: string; expectedUsername: string; xUrl: string; source: string }> {
  const res = await apiFetch("/api/project-imports/image/x/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: item.chainId, tokenAddress: item.tokenAddress, auth }),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.authorizeUrl) throw requestError(res, json, "X verification could not start.");
  return json;
}

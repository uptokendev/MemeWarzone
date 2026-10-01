import { apiFetch } from "@/lib/apiBase";
import { signWalletAction, type WalletActionAuthPayload } from "@/lib/walletActionAuth";

export const ABUSE_SESSION_ACTION = "abuse_open_session";

export type AbuseCategory = "impersonation" | "stolen_content" | "fake_project" | "phishing" | "other";
export type AbuseEntityType = "profile" | "campaign" | "token" | "wallet" | "external_account" | "external_website" | "other";

export type AbuseReportSummary = {
  id: string;
  category: AbuseCategory | string;
  categoryLabel: string;
  subject: string;
  status: string;
  statusLabel: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AbuseMessage = {
  id: string;
  senderType: "reporter" | "admin" | string;
  message: string;
  createdAt: string | null;
};

export type AbuseEvidence = {
  id: string;
  messageId: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string | null;
};

export type AbuseReportDetail = AbuseReportSummary & {
  description: string;
  entityType: string;
  reportedWallet: string;
  reportedProfileId: string;
  reportedCampaignAddress: string;
  reportedTokenAddress: string;
  reportedUrl: string;
  messages: AbuseMessage[];
  evidence: AbuseEvidence[];
};

export type CreateAbuseReportInput = {
  category: AbuseCategory;
  email: string;
  description: string;
  subject?: string;
  entityType?: AbuseEntityType | "";
  reportedWallet?: string;
  reportedProfileId?: string;
  reportedCampaignAddress?: string;
  reportedTokenAddress?: string;
  reportedUrl?: string;
};

function sessionKey(walletAddress: string, chainId: number) {
  return `mwz:abuse-session:v1:${chainId}:${walletAddress}`;
}

export function readStoredAbuseSession(walletAddress: string, chainId: number): string {
  try {
    return String(sessionStorage.getItem(sessionKey(walletAddress, chainId)) || "");
  } catch {
    return "";
  }
}

export function storeAbuseSession(walletAddress: string, chainId: number, token: string) {
  try {
    sessionStorage.setItem(sessionKey(walletAddress, chainId), token);
  } catch {}
}

export function clearAbuseSession(walletAddress: string, chainId: number) {
  try {
    sessionStorage.removeItem(sessionKey(walletAddress, chainId));
  } catch {}
}

async function readPayload(res: Response) {
  return await res.json().catch(() => ({})) as { ok?: boolean; error?: string; code?: string } & Record<string, unknown>;
}

export async function openAbuseSession(input: {
  walletAddress: string;
  chainId: number;
  auth: WalletActionAuthPayload;
}) {
  const res = await apiFetch("/api/abuse/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.auth),
  });
  const json = await readPayload(res);
  if (!res.ok || !json?.token) {
    throw new Error(String(json.error || "Could not open an abuse session."));
  }
  const token = String(json.token);
  storeAbuseSession(input.walletAddress, input.chainId, token);
  return token;
}

async function abuseFetch(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await apiFetch(path, { ...init, headers });
  const json = await readPayload(res);
  if (res.status === 401 && json.code === "ABUSE_SESSION_REQUIRED") {
    const error = new Error(String(json.error || "Abuse session required."));
    (error as Error & { code?: string }).code = "ABUSE_SESSION_REQUIRED";
    throw error;
  }
  if (!res.ok) {
    const error = new Error(String(json.error || `Request failed (${res.status})`)) as Error & {
      code?: string;
      reportId?: string;
    };
    if (json.code) error.code = String(json.code);
    if (json.reportId) error.reportId = String(json.reportId);
    throw error;
  }
  return json;
}

export async function listAbuseReports(token: string): Promise<AbuseReportSummary[]> {
  const json = await abuseFetch("/api/abuse/reports", token);
  return Array.isArray(json.reports) ? json.reports as AbuseReportSummary[] : [];
}

export async function getAbuseReport(token: string, reportId: string): Promise<AbuseReportDetail> {
  const json = await abuseFetch(`/api/abuse/reports/${encodeURIComponent(reportId)}`, token);
  return json.report as AbuseReportDetail;
}

export async function createAbuseReport(token: string, input: CreateAbuseReportInput): Promise<AbuseReportDetail> {
  const json = await abuseFetch("/api/abuse/reports", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return json.report as AbuseReportDetail;
}

export async function replyToAbuseReport(token: string, reportId: string, message: string) {
  return abuseFetch(`/api/abuse/reports/${encodeURIComponent(reportId)}/messages`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export async function uploadAbuseEvidence(token: string, reportId: string, file: File, messageId?: string) {
  const fd = new FormData();
  fd.append("file", file);
  if (messageId) fd.append("messageId", messageId);
  return abuseFetch(`/api/abuse/reports/${encodeURIComponent(reportId)}/evidence`, token, {
    method: "POST",
    body: fd,
  });
}

export async function signAbuseSession(input: {
  walletAddress: string;
  chainId: number;
  signer?: Parameters<typeof signWalletAction>[0]["signer"];
  signMessage?: (message: string) => Promise<string>;
  walletType?: "evm" | "solana";
}) {
  return signWalletAction({
    action: ABUSE_SESSION_ACTION,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    signer: input.signer,
    signMessage: input.signMessage,
    walletType: input.walletType,
  });
}

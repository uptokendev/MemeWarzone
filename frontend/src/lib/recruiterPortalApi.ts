import { apiFetch } from "@/lib/apiBase";
import type { SolanaRewardLaneClaim } from "@/lib/solanaRewardLaneClaim";

export type RecruiterPortalRecruiter = {
  id: number;
  name: string;
  x_handle: string;
  telegram_handle: string;
  wallet_address: string;
  status: string;
  focus: string | null;
  recruiter_code: string;
  squad_image_url?: string | null;
  squadImageUrl?: string | null;
  approved_at?: string | null;
};

export type RecruiterPortalSquadRow = {
  wallet_address: string;
  recruiter_id: number;
  recruiter_code: string;
  role: string;
  source: string;
  bound_at: string;
};

export type RecruiterPortalData = {
  recruiter: RecruiterPortalRecruiter;
  squad: {
    imageUrl?: string | null;
    image_url?: string | null;
    counts: { total: number; creators: number; traders: number; unknown: number };
    rows: RecruiterPortalSquadRow[];
  };
};

export type RecruiterAuthNonceResponse = { nonce: string; message: string };

export type RecruiterPayoutBalance = {
  chain: "bnb" | "solana" | "robinhood";
  token: "BNB" | "SOL" | "ETH";
  claimableRaw: string;
  pendingRaw: string;
  payoutWallet: string | null;
  status: "missing_payout_wallet" | "claimable" | "pending_finality" | string;
};

export type RecruiterNativeClaim = {
  id: string;
  chain: "bnb" | "solana";
  token: "BNB" | "SOL";
  amountRaw: string;
  payoutWallet: string;
  status: string;
  txHash?: string | null;
  error?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type RecruiterNativeClaimIntent = {
  ok: boolean;
  claim: RecruiterNativeClaim;
  solanaClaim?: SolanaRewardLaneClaim;
  message?: string;
};

export type RecruiterNativePayouts = {
  recruiterId: string;
  code: string | null;
  displayName: string | null;
  totalEstimatedUsd: number;
  balances: RecruiterPayoutBalance[];
  claims: RecruiterNativeClaim[];
};

export type RecruiterPayoutWalletChallenge = { error?: string; code?: string; nonce: string; message: string };

const PORTAL_CREDENTIALS: RequestCredentials = "include";
const PORTAL_TOKEN_KEY = "mwz:recruiterPortal:sessionToken";
const PORTAL_TOKEN_KEY_PREFIX = "mwz:recruiterPortal:sessionToken:";

function normalizeWalletKey(value?: string | null): string {
  const raw = String(value || "").trim();
  return raw.startsWith("0x") ? raw.toLowerCase() : raw;
}
function portalTokenKey(walletAddress?: string | null): string {
  const key = normalizeWalletKey(walletAddress);
  return key ? `${PORTAL_TOKEN_KEY_PREFIX}${key}` : PORTAL_TOKEN_KEY;
}
function decodePortalToken(token: string): { walletAddress?: string; exp?: number } | null {
  try {
    const payload = String(token || "").split(".")[0];
    if (!payload) return null;
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    return JSON.parse(atob(b64));
  } catch { return null; }
}
function tokenMatchesWallet(token: string, walletAddress?: string | null): boolean {
  const expected = normalizeWalletKey(walletAddress);
  if (!expected) return false;
  const decoded = decodePortalToken(token);
  const tokenWallet = normalizeWalletKey(decoded?.walletAddress);
  if (!tokenWallet || tokenWallet !== expected) return false;
  if (decoded?.exp && Date.now() > Number(decoded.exp)) return false;
  return true;
}
function getPortalSessionToken(walletAddress?: string | null): string {
  const expected = normalizeWalletKey(walletAddress);
  if (!expected) return "";
  try {
    const scoped = String(window.localStorage.getItem(portalTokenKey(expected)) || "").trim();
    if (scoped && (tokenMatchesWallet(scoped, expected) || !decodePortalToken(scoped))) return scoped;
    const legacy = String(window.localStorage.getItem(PORTAL_TOKEN_KEY) || "").trim();
    if (legacy && (tokenMatchesWallet(legacy, expected) || !decodePortalToken(legacy))) {
      window.localStorage.setItem(portalTokenKey(expected), legacy);
      window.localStorage.removeItem(PORTAL_TOKEN_KEY);
      return legacy;
    }
    if (scoped && !tokenMatchesWallet(scoped, expected)) window.localStorage.removeItem(portalTokenKey(expected));
    window.localStorage.removeItem(PORTAL_TOKEN_KEY);
  } catch {}
  return "";
}
export function hasRecruiterPortalSession(walletAddress?: string | null): boolean { return Boolean(getPortalSessionToken(walletAddress)); }
function setPortalSessionToken(walletAddress: string, token: string) {
  try {
    const key = normalizeWalletKey(walletAddress);
    const clean = String(token || "").trim();
    if (!key || !clean) return;
    window.localStorage.setItem(portalTokenKey(key), clean);
    window.localStorage.removeItem(PORTAL_TOKEN_KEY);
  } catch {}
}
function clearPortalSessionToken(walletAddress?: string | null) {
  try {
    const key = normalizeWalletKey(walletAddress);
    if (key) window.localStorage.removeItem(portalTokenKey(key));
    window.localStorage.removeItem(PORTAL_TOKEN_KEY);
  } catch {}
}
function portalHeaders(walletAddress?: string | null, extra?: HeadersInit): HeadersInit {
  const token = getPortalSessionToken(walletAddress);
  return { ...(extra || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function parseJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.ok === false) throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  return json as any;
}
async function parseJsonAllowingChallenge(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (res.status === 400 && json?.message && json?.nonce && /missing signature/i.test(String(json?.error || ""))) return json as RecruiterPayoutWalletChallenge;
  if (!res.ok || (json as any)?.ok === false) throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  return json as any;
}

export function getPortalSquadImageUrl(portal?: RecruiterPortalData | null): string {
  return String(portal?.squad?.imageUrl || portal?.squad?.image_url || portal?.recruiter?.squadImageUrl || portal?.recruiter?.squad_image_url || "").trim();
}

export async function fetchRecruiterPortal(walletAddress?: string | null): Promise<RecruiterPortalData | null> {
  if (!hasRecruiterPortalSession(walletAddress)) return null;
  const res = await apiFetch("/api/recruiter-portal", { credentials: PORTAL_CREDENTIALS, cache: "no-store", headers: portalHeaders(walletAddress) });
  if (res.status === 401) { clearPortalSessionToken(walletAddress); return null; }
  return parseJson(res) as Promise<RecruiterPortalData>;
}

export async function requestRecruiterAuthNonce(address: string): Promise<RecruiterAuthNonceResponse> {
  clearPortalSessionToken(address);
  const res = await apiFetch(`/api/recruiter-auth-nonce?address=${encodeURIComponent(address)}`, { credentials: PORTAL_CREDENTIALS, headers: portalHeaders(address) });
  const json = await parseJson(res);
  if (!json?.nonce || !json?.message) throw new Error("Recruiter login challenge missing from response.");
  return { nonce: String(json.nonce), message: String(json.message) };
}

export async function verifyRecruiterAuth(address: string, signature: string) {
  const res = await apiFetch("/api/recruiter-auth-verify", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(address, { "Content-Type": "application/json" }), body: JSON.stringify({ address, signature }) });
  const json = await parseJson(res);
  if (json?.sessionToken) setPortalSessionToken(address, String(json.sessionToken));
  return json;
}

export async function updateRecruiterPortalCode(code: string, walletAddress?: string | null): Promise<{ recruiter_code: string }> {
  const res = await apiFetch("/api/recruiter-portal", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(walletAddress, { "Content-Type": "application/json" }), body: JSON.stringify({ action: "setCode", code }) });
  const json = await parseJson(res);
  return { recruiter_code: String(json?.recruiter_code || code) };
}

export async function updateRecruiterPortalSquadImage(imageUrl: string, walletAddress?: string | null): Promise<{ squad_image_url: string }> {
  const res = await apiFetch("/api/recruiter-portal", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(walletAddress, { "Content-Type": "application/json" }), body: JSON.stringify({ action: "setSquadImage", imageUrl }) });
  const json = await parseJson(res);
  return { squad_image_url: String(json?.squad_image_url || json?.squadImageUrl || imageUrl) };
}

export async function fetchRecruiterNativePayouts(walletAddress?: string | null): Promise<RecruiterNativePayouts | null> {
  if (!hasRecruiterPortalSession(walletAddress)) return null;
  const res = await apiFetch("/api/recruiters/me/payouts", { credentials: PORTAL_CREDENTIALS, cache: "no-store", headers: portalHeaders(walletAddress) });
  if (res.status === 401) { clearPortalSessionToken(walletAddress); return null; }
  return parseJson(res) as Promise<RecruiterNativePayouts>;
}

export async function requestRecruiterPayoutWalletChallenge(chain: "bnb" | "solana", walletAddress: string, sessionWalletAddress?: string | null): Promise<RecruiterPayoutWalletChallenge> {
  const res = await apiFetch("/api/recruiters/me/wallets/link", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(sessionWalletAddress, { "Content-Type": "application/json" }), body: JSON.stringify({ chain, walletAddress }) });
  const json = await parseJsonAllowingChallenge(res);
  if (!json?.message || !json?.nonce) throw new Error("Payout wallet challenge missing from response.");
  return { nonce: String(json.nonce), message: String(json.message), error: json.error, code: json.code };
}

export async function verifyRecruiterPayoutWallet(chain: "bnb" | "solana", walletAddress: string, nonce: string, signature: string, sessionWalletAddress?: string | null) {
  const res = await apiFetch("/api/recruiters/me/wallets/link", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(sessionWalletAddress, { "Content-Type": "application/json" }), body: JSON.stringify({ chain, walletAddress, nonce, signature }) });
  return parseJson(res);
}

export async function createRecruiterNativeClaim(chain: "bnb" | "solana", sessionWalletAddress?: string | null): Promise<RecruiterNativeClaimIntent> {
  const res = await apiFetch("/api/recruiters/me/claims", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(sessionWalletAddress, { "Content-Type": "application/json" }), body: JSON.stringify({ chain }) });
  return parseJson(res) as Promise<RecruiterNativeClaimIntent>;
}

export async function recordRecruiterSolanaClaim(claimId: string, txHash: string, sessionWalletAddress?: string | null) {
  const res = await apiFetch("/api/recruiters/me/claims", {
    method: "POST",
    credentials: PORTAL_CREDENTIALS,
    headers: portalHeaders(sessionWalletAddress, { "Content-Type": "application/json" }),
    body: JSON.stringify({ action: "recordSolanaClaim", chain: "solana", claimId, txHash }),
  });
  return parseJson(res);
}

export async function logoutRecruiterPortal(walletAddress?: string | null) {
  clearPortalSessionToken(walletAddress);
  const res = await apiFetch("/api/recruiter-logout", { method: "POST", credentials: PORTAL_CREDENTIALS, headers: portalHeaders(walletAddress) });
  return parseJson(res).catch(() => ({ ok: true }));
}
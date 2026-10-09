import { apiFetch } from "@/lib/apiBase";
import { getRecruiterSession, squadJoinAuth } from "@/lib/recruiterApi";
import { forgetSessionToken, storedSessionToken } from "@/lib/sessionActions";

const MEMBER_ROLE_KEY = "mwz:recruiter:memberRole";

export type RecruiterJoinRole = "creator" | "trader" | "both";

function normalizeRole(value?: string | null): RecruiterJoinRole | null {
  const role = String(value || "").trim().toLowerCase();
  return role === "creator" || role === "trader" || role === "both" ? role : null;
}

export function getRecruiterJoinRole(): RecruiterJoinRole | null {
  try {
    return normalizeRole(window.localStorage.getItem(MEMBER_ROLE_KEY));
  } catch {
    return null;
  }
}

export function setRecruiterJoinRole(role: RecruiterJoinRole) {
  try {
    window.localStorage.setItem(MEMBER_ROLE_KEY, role);
  } catch {
    // Storage is convenience only; the selected React state remains authoritative.
  }
}

export function clearRecruiterJoinRole() {
  try {
    window.localStorage.removeItem(MEMBER_ROLE_KEY);
  } catch {
    // ignore storage failures
  }
}

export async function syncRecruiterJoinRole(walletAddress: string, role: RecruiterJoinRole) {
  const session = getRecruiterSession();
  const response = await apiFetch("/api/attribution/wallet-connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress,
      sessionToken: session.sessionToken,
      clientFingerprint: session.clientFingerprint,
      memberRole: role,
      auth: squadJoinAuth(walletAddress),
    }),
  });
  const json = await response.json().catch(() => ({}));
  // A stored sign-in the server turns down (expired, revoked, other wallet): drop it and ask again.
  if (response.status === 401 && (json?.code === "FEED_SESSION_REQUIRED" || json?.code === "WALLET_MISMATCH")) {
    forgetSessionToken(storedSessionToken(walletAddress));
    return { linked: false, needsSignIn: true, code: json.code, reason: json.error };
  }
  if (!response.ok) {
    throw new Error(String(json?.error || json?.message || `Request failed (${response.status})`));
  }
  if (json?.linked) clearRecruiterJoinRole();
  return json;
}

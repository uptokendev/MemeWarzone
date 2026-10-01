import { apiFetch } from "@/lib/apiBase";
import { signWalletAction, type WalletActionAuthPayload } from "@/lib/walletActionAuth";

export const FEED_SESSION_ACTION = "feed_open_session";
export const FEED_SESSION_SCOPE = "Scope: fire,repost,reply";


function sessionKey(walletAddress: string, chainId: number) {
  return `mwz:feed-session:v1:${chainId}:${walletAddress}`;
}

export function readStoredFeedSession(walletAddress: string, chainId: number): string {
  try {
    return String(sessionStorage.getItem(sessionKey(walletAddress, chainId)) || "");
  } catch {
    return "";
  }
}

export function storeFeedSession(walletAddress: string, chainId: number, token: string) {
  try {
    sessionStorage.setItem(sessionKey(walletAddress, chainId), token);
  } catch {}
}

export function clearFeedSession(walletAddress: string, chainId: number) {
  try {
    sessionStorage.removeItem(sessionKey(walletAddress, chainId));
  } catch {}
}

export async function openFeedSession(input: {
  walletAddress: string;
  chainId: number;
  auth: WalletActionAuthPayload;
}) {
  const res = await apiFetch("/api/feed/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...input.auth,
      extraLines: [FEED_SESSION_SCOPE],
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !json?.token) {
    throw new Error(String(json.error || "Could not open a feed session."));
  }
  const token = String(json.token);
  storeFeedSession(input.walletAddress, input.chainId, token);
  return token;
}

export async function signFeedSession(input: {
  walletAddress: string;
  chainId: number;
  signer?: Parameters<typeof signWalletAction>[0]["signer"];
  signMessage?: (message: string) => Promise<string>;
  walletType?: "evm" | "solana";
}) {
  return signWalletAction({
    action: FEED_SESSION_ACTION,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    extraLines: [FEED_SESSION_SCOPE],
    signer: input.signer,
    signMessage: input.signMessage,
    walletType: input.walletType,
  });
}

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useWallet } from "@/contexts/WalletContext";
import { useFeedSession } from "@/hooks/useFeedSession";
import { isSolanaAddress } from "@/lib/address";
import { readStoredFeedSession } from "@/lib/feedSession";
import { FEED_SESSION_INVALID_EVENT } from "@/lib/apiBase";
import { forgetSessionToken, storedSessionToken } from "@/lib/sessionActions";
import { syncWalletRecruiterAttribution, WALLET_SIGNED_IN_EVENT } from "@/lib/recruiterApi";

const DECLINED_PREFIX = "mwz:sign-in-declined:";

function declinedKey(chainId: number, account: string) {
  return `${DECLINED_PREFIX}${chainId}:${account}`;
}

function wasDeclined(chainId: number, account: string) {
  try {
    return sessionStorage.getItem(declinedKey(chainId, account)) === "1";
  } catch {
    return false;
  }
}

function markDeclined(chainId: number, account: string) {
  try {
    sessionStorage.setItem(declinedKey(chainId, account), "1");
  } catch {}
}

/**
 * Sign-in at connect (founder, 2026-10-06): as soon as a wallet is connected without a 30-day
 * sign-in, ask for it once. After that posts, follows, profile, username, settings, votes and
 * check-ins need no wallet prompt; money, deploys and on-chain actions still sign. Declining is
 * remembered for this tab, and those actions then ask when used, as before.
 */
export function WalletSignInGate() {
  const wallet = useWallet() as { signer?: unknown };
  const { account, chainId, ensureSession } = useFeedSession();
  const asked = useRef(new Set<string>());
  const solana = isSolanaAddress(account);
  const signerReady = solana || Boolean(wallet.signer);

  useEffect(() => {
    if (!account || !signerReady) return;
    const key = `${chainId}:${account}`;
    if (asked.current.has(key)) return;
    if (readStoredFeedSession(account, chainId) || wasDeclined(chainId, account)) return;

    // Let the wallet's connect sheet close first.
    const timer = window.setTimeout(() => {
      if (asked.current.has(key) || readStoredFeedSession(account, chainId)) return;
      asked.current.add(key);
      const toastId = toast("Sign in with your wallet: one signature, valid for 30 days. No transaction, no fee.", { duration: 15_000 });
      ensureSession()
        .then(() => toast.success("Signed in for 30 days.", { id: toastId }))
        .catch(() => {
          markDeclined(chainId, account);
          toast.message("Not signed in. Posting, following and profile changes will ask for a signature.", { id: toastId });
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [account, chainId, signerReady, ensureSession]);

  // The server turned a stored sign-in down (expired or revoked): forget it, so the next action
  // signs normally and the next visit asks to sign in again.
  useEffect(() => {
    const onInvalid = () => {
      if (!account) return;
      forgetSessionToken(storedSessionToken(account, chainId));
      asked.current.delete(`${chainId}:${account}`);
    };
    window.addEventListener(FEED_SESSION_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(FEED_SESSION_INVALID_EVENT, onInvalid);
  }, [account, chainId]);

  // A squad join needs the sign-in (founder, 2026-10-09): the connect-time sync ran before it, so
  // retry once the wallet is signed in. The invite page (/r/:code) retries on its own.
  useEffect(() => {
    const onSignedIn = (event: Event) => {
      const walletAddress = String((event as CustomEvent<{ walletAddress?: string }>).detail?.walletAddress || "");
      if (!walletAddress || window.location.pathname.startsWith("/r/")) return;
      void syncWalletRecruiterAttribution(walletAddress).catch(() => {});
    };
    window.addEventListener(WALLET_SIGNED_IN_EVENT, onSignedIn);
    return () => window.removeEventListener(WALLET_SIGNED_IN_EVENT, onSignedIn);
  }, []);

  return null;
}

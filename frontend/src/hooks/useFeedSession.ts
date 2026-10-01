import { useCallback, useState } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isSolanaAddress } from "@/lib/address";
import { getActiveChainId, isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import {
  clearFeedSession,
  openFeedSession,
  readStoredFeedSession,
  signFeedSession,
} from "@/lib/feedSession";
import { signSolanaMessage } from "@/lib/solanaWallet";

export function useFeedSession() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const [busy, setBusy] = useState(false);

  const account = String(solanaWallet.solanaAccount || wallet.account || "").trim();
  const chainId = isSolanaAddress(account)
    ? SOLANA_CHAIN_ID
    : getActiveChainId((wallet as { chainId?: number })?.chainId) || 56;

  const ensureSession = useCallback(async () => {
    if (!account) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      throw new Error("Connect a wallet first.");
    }
    const existing = readStoredFeedSession(account, chainId);
    if (existing) return existing;

    setBusy(true);
    try {
      const solana = isSolanaChainId(chainId) || isSolanaAddress(account);
      const auth = await signFeedSession({
        walletAddress: account,
        chainId,
        walletType: solana ? "solana" : "evm",
        signMessage: solana
          ? async (message) => (await signSolanaMessage(message, account)).signature
          : undefined,
        signer: solana ? undefined : wallet.signer,
      });
      return await openFeedSession({ walletAddress: account, chainId, auth });
    } catch (error) {
      clearFeedSession(account, chainId);
      throw error;
    } finally {
      setBusy(false);
    }
  }, [account, chainId, wallet.signer]);

  const withSession = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      const token = await ensureSession();
      try {
        return await fn(token);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== "FEED_SESSION_REQUIRED") throw error;
        clearFeedSession(account, chainId);
        const next = await ensureSession();
        return fn(next);
      }
    },
    [account, chainId, ensureSession],
  );

  return { account, chainId, busy, ensureSession, withSession };
}

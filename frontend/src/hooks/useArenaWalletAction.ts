import { useCallback } from "react";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";

export function useArenaWalletAction() {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useActiveFeedWallet();

  const signAuth = useCallback(
    (
      action: string,
      extraLines: string[],
      overrides?: { walletAddress?: string | null; chainId?: number | null },
    ) =>
      signArenaWalletAction({
        action,
        extraLines,
        walletAddress: String(overrides?.walletAddress || feed.address || ""),
        chainId: overrides?.chainId ?? feed.chainId,
        evmWallet: wallet,
        solanaAccount,
      }),
    [feed.address, feed.chainId, solanaAccount, wallet],
  );

  return { signAuth, walletAddress: feed.address, chainId: feed.chainId };
}

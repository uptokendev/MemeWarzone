import { useCallback, useMemo } from "react";

import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveChainId, isEvmChainId, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { signSolanaMessage } from "@/lib/solanaWallet";

export type RecruiterWalletChain = "bnb" | "solana";

export type RecruiterWalletCandidate = {
  chain: RecruiterWalletChain;
  address: string;
  chainId: number;
  label: string;
  canSign: boolean;
};

export type RecruiterWalletController = {
  activeWallet: RecruiterWalletCandidate | null;
  connectedWallets: RecruiterWalletCandidate[];
  bnbAddress: string;
  solanaAddress: string;
  bnbChainId?: number;
  connecting: boolean;
  connect: (chain?: RecruiterWalletChain) => Promise<string>;
  disconnect: (chain?: RecruiterWalletChain) => Promise<void>;
  signMessage: (chain: RecruiterWalletChain, address: string, message: string) => Promise<string>;
};

function sameAddress(chain: RecruiterWalletChain, left?: string | null, right?: string | null): boolean {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  return chain === "bnb" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function evmRecruiterLabel(chainId?: number | null) {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID ? "Robinhood" : "BNB";
}

export function useRecruiterWallet(): RecruiterWalletController {
  const bnbWallet = useWallet();
  const solanaWallet = useSolanaWallet();

  const bnbAddress = String(bnbWallet.account || "").trim();
  const solanaAddress = String(solanaWallet.solanaAccount || "").trim();
  const bnbChainId = bnbWallet.chainId;

  const connectedWallets = useMemo<RecruiterWalletCandidate[]>(() => {
    const wallets: RecruiterWalletCandidate[] = [];
    if (solanaAddress) {
      wallets.push({
        chain: "solana",
        address: solanaAddress,
        chainId: 101,
        label: solanaWallet.solanaWalletName || "Solana",
        canSign: true,
      });
    }
    if (bnbAddress) {
      const actualEvmChainId = isEvmChainId(bnbChainId) ? Number(bnbChainId) : Number(getActiveChainId(bnbChainId));
      wallets.push({
        // Keep the legacy "bnb" discriminator for EVM signing compatibility; the
        // actual EVM network is carried by chainId and the user-facing label.
        chain: "bnb",
        address: bnbAddress,
        chainId: actualEvmChainId,
        label: evmRecruiterLabel(actualEvmChainId),
        canSign: Boolean(bnbWallet.signer),
      });
    }
    return wallets;
  }, [bnbAddress, bnbChainId, bnbWallet.signer, solanaAddress, solanaWallet.solanaWalletName]);

  const connect = useCallback(async (chain?: RecruiterWalletChain) => {
    if (chain === "solana") {
      const result = await solanaWallet.connectSolana();
      return result.publicKey;
    }
    await bnbWallet.connect();
    return bnbAddress;
  }, [bnbAddress, bnbWallet, solanaWallet]);

  const disconnect = useCallback(async (chain?: RecruiterWalletChain) => {
    if (chain === "solana") {
      await solanaWallet.disconnectSolana();
      return;
    }
    if (chain === "bnb") {
      await bnbWallet.disconnect();
      return;
    }
    await Promise.allSettled([bnbWallet.disconnect(), solanaWallet.disconnectSolana()]);
  }, [bnbWallet, solanaWallet]);

  const signMessage = useCallback(async (chain: RecruiterWalletChain, address: string, message: string) => {
    if (chain === "solana") {
      return (await signSolanaMessage(message, address)).signature;
    }
    if (!bnbWallet.signer || !bnbAddress) throw new Error("Connect your EVM wallet before signing.");
    if (!sameAddress("bnb", bnbAddress, address)) throw new Error("Connected EVM wallet does not match the selected wallet.");
    return bnbWallet.signer.signMessage(message);
  }, [bnbAddress, bnbWallet.signer]);

  return {
    activeWallet: connectedWallets[0] || null,
    connectedWallets,
    bnbAddress,
    solanaAddress,
    bnbChainId,
    connecting: Boolean(bnbWallet.connecting || solanaWallet.connectingSolana),
    connect,
    disconnect,
    signMessage,
  };
}

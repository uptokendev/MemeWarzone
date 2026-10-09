/**
 * Wallet balances on an imported coin's page: the chain's native coin and the coin itself, read every
 * 15 s from the coin's own chain (never through the wallet). Display only: the trade card's Balance row
 * and the Your Position card. Swaps do not read these.
 */
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";

import { isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";

export type ImportWalletBalances = { nativeRaw: bigint; tokenRaw: bigint };

export function useImportWalletBalances({ chainId, tokenAddress, account }: { chainId: number; tokenAddress: string; account: string | null }) {
  const [balances, setBalances] = useState<ImportWalletBalances | null>(null);
  useEffect(() => {
    if (!account) {
      setBalances(null);
      return;
    }
    const solana = isSolanaChainId(chainId);
    let readProvider: ethers.Provider | null = null;
    if (!solana) {
      try {
        readProvider = getReadProvider(chainId as SupportedChainId);
      } catch {
        readProvider = null;
      }
    }
    let cancelled = false;
    const load = async () => {
      try {
        let nativeRaw: bigint;
        let tokenRaw = 0n;
        if (solana) {
          const connection = getSolanaReadConnection();
          const owner = new PublicKey(account);
          const [lamports, accounts] = await Promise.all([
            connection.getBalance(owner, "confirmed"),
            connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(tokenAddress) }, "confirmed"),
          ]);
          nativeRaw = BigInt(lamports);
          for (const entry of accounts.value) tokenRaw += BigInt((entry.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount || "0");
        } else {
          if (!readProvider) return;
          const erc20 = new ethers.Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], readProvider);
          const [native, token] = await Promise.all([readProvider.getBalance(account), erc20.balanceOf(account) as Promise<bigint>]);
          nativeRaw = BigInt(native);
          tokenRaw = BigInt(token);
        }
        if (!cancelled) setBalances({ nativeRaw, tokenRaw });
      } catch {
        if (!cancelled) setBalances(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [account, chainId, tokenAddress]);
  return balances;
}

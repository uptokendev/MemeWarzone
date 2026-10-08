import { useEffect, useState } from "react";
import { ethers } from "ethers";

import { cp } from "@/components/token/coinPageStyles";
import { getNativeSymbol, isRobinhoodChainId, isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { readImportTokenDecimals } from "@/lib/importSwap";
import { useImportWalletBalances } from "@/lib/useImportWalletBalances";

const fmt = (raw: bigint, decimals: number, digits: number) => Number(ethers.formatUnits(raw, decimals)).toLocaleString(undefined, { maximumFractionDigits: digits });

/** "Your Position" on an imported coin, the same card as on a launched coin, plus the value of the tokens. Display only. */
export function ImportPositionCard({ chainId, tokenAddress, symbol, account, priceUsd }: { chainId: number; tokenAddress: string; symbol?: string | null; account: string | null; priceUsd?: number | null }) {
  const solana = isSolanaChainId(chainId);
  const native = getNativeSymbol(chainId);
  const balances = useImportWalletBalances({ chainId, tokenAddress, account });
  const [decimals, setDecimals] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let provider: ethers.Provider | null = null;
    if (!isSolanaChainId(chainId)) {
      try {
        provider = getReadProvider(chainId as SupportedChainId);
      } catch {
        provider = null;
      }
    }
    void readImportTokenDecimals(chainId, tokenAddress, provider).then((value) => {
      if (!cancelled && value !== null) setDecimals(value);
    });
    return () => {
      cancelled = true;
    };
  }, [chainId, tokenAddress]);

  const tokenAmount = balances && decimals != null ? Number(ethers.formatUnits(balances.tokenRaw, decimals)) : null;
  const valueUsd = tokenAmount != null && priceUsd ? tokenAmount * priceUsd : null;
  const walletLabel = solana ? "SOL" : isRobinhoodChainId(chainId) ? "Robinhood" : "BNB";

  return (
    <section aria-label="Your position" className={`${cp.card} p-4`} data-import-position="true">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className={`${cp.title} m-0`}>Your Position</h3>
        <span className="text-xs text-mw-muted">Wallet view</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-mw-muted">{native} balance</p>
          <p className="mt-1 break-words font-mw-mono text-mw-text">{balances ? fmt(balances.nativeRaw, solana ? 9 : 18, 4) : "—"}</p>
        </div>
        <div>
          <p className="text-mw-muted">Token balance</p>
          <p className="mt-1 break-words font-mw-mono text-mw-text">{balances && decimals != null ? `${fmt(balances.tokenRaw, decimals, 2)} ${symbol || ""}`.trim() : "—"}</p>
        </div>
      </div>
      {valueUsd != null && tokenAmount ? (
        <p className="mb-0 mt-2 text-sm text-mw-muted">
          Value <span className="font-mw-mono text-mw-text">${valueUsd.toLocaleString(undefined, { maximumFractionDigits: valueUsd < 1 ? 4 : 2 })}</span>
        </p>
      ) : null}
      {account ? null : <p className="mt-2 text-xs text-amber-300">Connect a {walletLabel} wallet to trade this coin.</p>}
    </section>
  );
}

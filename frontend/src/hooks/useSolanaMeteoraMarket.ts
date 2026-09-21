import { useEffect, useRef, useState } from "react";

import {
  fetchSolanaOnChainHolders,
  type SolanaOnChainHolderDistribution,
} from "@/lib/solanaMeteoraMarket";
import {
  fetchSolanaMeteoraPoolSnapshot,
  type SolanaMeteoraPoolSnapshot,
} from "@/lib/solanaMeteoraTrade";

const SPOT_POLL_MS = 20_000;
const HOLDERS_POLL_MS = 90_000;

export function useSolanaMeteoraMarket(input: {
  mint?: string;
  tokenDecimals: number;
  campaignTokenVault?: string | null;
  /** Quote side of the pool (creator's Graduation Market). Omitted: derived from poolAddress, else WSOL. */
  quoteMint?: string | null;
  quoteDecimals?: number | null;
  poolAddress?: string | null;
  enabled: boolean;
  /** Optional: bump after a confirmed trade to refresh spot only — never holders. */
  refreshToken?: number;
}) {
  const [spot, setSpot] = useState<SolanaMeteoraPoolSnapshot | null>(null);
  const [holders, setHolders] = useState<SolanaOnChainHolderDistribution | null>(null);
  const vaultRef = useRef<string | null>(null);

  useEffect(() => {
    const mint = String(input.mint || "").trim();
    if (!input.enabled || !mint) {
      setSpot(null);
      setHolders(null);
      vaultRef.current = null;
      return;
    }

    let cancelled = false;

    const loadSpot = async () => {
      try {
        const nextSpot = await fetchSolanaMeteoraPoolSnapshot({
          mint,
          tokenDecimals: input.tokenDecimals,
          quoteMint: input.quoteMint ?? null,
          quoteDecimals: input.quoteDecimals ?? null,
          poolAddress: input.poolAddress ?? null,
        });
        if (cancelled) return null;
        vaultRef.current = nextSpot.tokenVault;
        setSpot(nextSpot);
        return nextSpot;
      } catch (error) {
        console.warn("[solana-meteora] spot", error);
        return null;
      }
    };

    const loadHolders = async (poolTokenVault?: string | null) => {
      try {
        const nextHolders = await fetchSolanaOnChainHolders({
          mint,
          poolTokenVault: poolTokenVault ?? vaultRef.current,
          campaignTokenVault: input.campaignTokenVault,
        });
        if (!cancelled) setHolders(nextHolders);
      } catch (error) {
        console.warn("[solana-meteora] holders", error);
      }
    };

    void loadSpot();
    // Holder scan uses getTokenLargestAccounts — public RPCs 429 this method first.
    // Defer it so curve/spot/quote can reserve the first request window for trading.
    const holderDelay = window.setTimeout(() => void loadHolders(), 3_000);

    const spotTimer = window.setInterval(() => void loadSpot(), SPOT_POLL_MS);
    const holderTimer = window.setInterval(() => void loadHolders(), HOLDERS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(holderDelay);
      window.clearInterval(spotTimer);
      window.clearInterval(holderTimer);
    };
  }, [input.campaignTokenVault, input.enabled, input.mint, input.poolAddress, input.quoteDecimals, input.quoteMint, input.tokenDecimals]);

  return { spot, holders };
}

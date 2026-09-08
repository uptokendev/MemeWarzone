import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import type { CurveTradePoint } from "@/hooks/useCurveTrades";
import { getReadProvider } from "@/lib/readProvider";
import { fetchTopazMarketSnapshot, type TopazMarketSnapshot } from "@/lib/topazMarketData";
import { BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, type SupportedChainId } from "@/lib/chainConfig";

function isBnbTopazChain(chainId: number): boolean {
  return chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID;
}

export function useTopazMarket(input: {
  campaignAddress?: string;
  tokenAddress?: string;
  chainId: number;
  enabled?: boolean;
  pollMs?: number;
}) {
  const campaignAddress = String(input.campaignAddress || "").trim().toLowerCase();
  const tokenAddress = String(input.tokenAddress || "").trim().toLowerCase();
  const enabled =
    (input.enabled ?? true) &&
    isBnbTopazChain(Number(input.chainId)) &&
    ethers.isAddress(campaignAddress) &&
    Number.isFinite(input.chainId) &&
    input.chainId > 0;

  const [snapshot, setSnapshot] = useState<TopazMarketSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const provider = getReadProvider(input.chainId as SupportedChainId);
      const next = await fetchTopazMarketSnapshot({
        provider,
        campaignAddress,
        chainId: input.chainId,
        expectedTokenAddress: tokenAddress || undefined,
        signal,
      });
      if (requestId !== requestRef.current || signal?.aborted) return;
      setSnapshot(next);
      setError(null);
    } catch (caught: any) {
      if (caught?.name === "AbortError" || signal?.aborted) return;
      if (requestId !== requestRef.current) return;
      setError(caught?.shortMessage || caught?.message || "Topaz market data unavailable.");
    } finally {
      if (requestId === requestRef.current && !signal?.aborted) setLoading(false);
    }
  }, [campaignAddress, enabled, input.chainId, tokenAddress]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const pollMs = Math.max(5_000, Number(input.pollMs || 8_000));
    const timer = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, input.pollMs, refresh]);

  const trades: CurveTradePoint[] = snapshot?.trades || [];

  return useMemo(
    () => ({
      enabled,
      loading,
      error,
      snapshot,
      trades,
      priceBnb: snapshot?.priceBnb ?? null,
      marketCapBnb: snapshot?.marketCapBnb ?? null,
      liquidityBnb: snapshot?.liquidityBnb ?? null,
      feeBps: snapshot?.feeBps ?? null,
      pairAddress: snapshot?.resolved.pairAddress ?? null,
      routerAddress: snapshot?.resolved.routerAddress ?? null,
      refresh,
    }),
    [enabled, error, loading, refresh, snapshot, trades],
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMarketCandles,
  fetchMarketSummary,
  type MarketCandle,
} from "@/lib/marketContinuityApi";
import {
  EMBED_CHART_POLL_MS,
  liveNativeFromSummary,
  nativeUsdFromSummary,
  type EmbedChartIdentity,
  type EmbedChartResolution,
} from "@/lib/embedChart";

type EmbedChartMarket = {
  candles: MarketCandle[];
  graduationMarker: {
    time: string;
    txHash?: string | null;
    finalCurvePriceBnb?: string | null;
    initialDexPriceBnb?: string | null;
    pairAddress?: string | null;
  } | null;
  nativeUsd: number;
  livePriceNative: number | null;
  liveMcapNative: number | null;
  serverTime: string | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: EmbedChartMarket = {
  candles: [],
  graduationMarker: null,
  nativeUsd: 0,
  livePriceNative: null,
  liveMcapNative: null,
  serverTime: null,
  loading: false,
  error: null,
};

export function useEmbedChartMarket(
  identity: EmbedChartIdentity | null,
  resolution: EmbedChartResolution,
): EmbedChartMarket {
  const [state, setState] = useState<EmbedChartMarket>(EMPTY);
  const requestRef = useRef(0);
  const chainId = identity?.chainId ?? null;
  const token = identity?.token ?? null;

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (chainId == null || !token) {
        setState(EMPTY);
        return;
      }
      const requestId = ++requestRef.current;
      setState((current) => ({ ...current, loading: current.candles.length === 0, error: null }));
      try {
        const [candles, summary] = await Promise.all([
          fetchMarketCandles(token, chainId, resolution, { limit: 2500, signal }),
          fetchMarketSummary(token, chainId, signal).catch(() => null),
        ]);
        if (signal?.aborted || requestId !== requestRef.current) return;
        const summaryRecord = summary as unknown as Record<string, unknown> | null;
        const live = liveNativeFromSummary(summaryRecord);
        setState({
          candles: candles.items || [],
          graduationMarker: candles.graduationMarker || null,
          nativeUsd: nativeUsdFromSummary(summaryRecord),
          livePriceNative: live.priceNative,
          liveMcapNative: live.mcapNative,
          serverTime: candles.serverTime || null,
          loading: false,
          error: null,
        });
      } catch (caught: unknown) {
        if (signal?.aborted || requestId !== requestRef.current) return;
        const message = caught instanceof Error ? caught.message : "Chart feed unavailable";
        setState((current) => ({
          ...current,
          loading: false,
          error: current.candles.length ? null : message,
        }));
      }
    },
    [chainId, token, resolution],
  );

  useEffect(() => {
    if (chainId == null || !token) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), EMBED_CHART_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [chainId, token, refresh]);

  return state;
}

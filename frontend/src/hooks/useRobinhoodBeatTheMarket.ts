import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/apiBase";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";

export type RobinhoodBeatWindow = "1h" | "24h" | "7d" | "30d";

export type RobinhoodBeatTheMarketPayload = {
  chainId: number;
  campaignAddress: string;
  quoteTokenAddress?: string | null;
  window: RobinhoodBeatWindow;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  valuationSource?: string | null;
  formulaVersion?: string | null;
  healthy: boolean;
  error?: string | null;
  metric?: {
    formulaVersion?: string | null;
    healthy?: boolean;
    startMemeUsd?: number | string | null;
    endMemeUsd?: number | string | null;
    startQuoteUsd?: number | string | null;
    endQuoteUsd?: number | string | null;
    memeReturn?: number | string | null;
    quoteAssetReturn?: number | string | null;
    relativeReturn?: number | string | null;
    percentagePointDifference?: number | string | null;
  } | null;
};

function isRobinhoodChain(chainId: number) {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

export function useRobinhoodBeatTheMarket(input: {
  chainId: number;
  campaignAddress?: string | null;
  window?: RobinhoodBeatWindow;
  enabled?: boolean;
  refreshMs?: number;
}) {
  const chainId = Number(input.chainId);
  const campaignAddress = String(input.campaignAddress || "").trim();
  const window = input.window || "24h";
  const enabled = input.enabled !== false && isRobinhoodChain(chainId) && Boolean(campaignAddress);
  const refreshMs = Math.max(15_000, Number(input.refreshMs || 60_000));

  const [data, setData] = useState<RobinhoodBeatTheMarketPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const endpoint = useMemo(() => {
    if (!enabled) return null;
    const qs = new URLSearchParams({ chainId: String(chainId), window });
    return apiUrl(`/api/token/${encodeURIComponent(campaignAddress)}/beat-the-market?${qs.toString()}`);
  }, [campaignAddress, chainId, enabled, window]);

  const refresh = useCallback(async () => {
    if (!endpoint) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(endpoint, { headers: { accept: "application/json" } });
      const payload = (await response.json().catch(() => null)) as RobinhoodBeatTheMarketPayload | null;
      if (!response.ok) {
        throw new Error(String(payload?.error || `Beat the Market request failed (${response.status}).`));
      }
      if (!payload) throw new Error("Beat the Market returned an empty response.");
      setData(payload);
      setError(null);
      setUpdatedAt(new Date().toISOString());
    } catch (err) {
      setData(null);
      setError(String((err as Error)?.message || err || "Beat the Market is temporarily unavailable."));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, refreshMs);
    return () => window.clearInterval(timer);
  }, [enabled, refresh, refreshMs]);

  return { data, loading, error, updatedAt, refresh };
}

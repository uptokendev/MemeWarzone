import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { useAblyTokenChannel } from "@/hooks/useAblyTokenChannel";

const API_BASE = String(import.meta.env.VITE_REALTIME_API_BASE || "").replace(/\/$/, "");
const ENABLE_TOKEN_POLLING = String(import.meta.env.VITE_ENABLE_TOKEN_POLLING || "").trim() === "1";

export type TokenStatsRealtime = {
  lastPriceBnb: number | null; // native/token (BNB or SOL; legacy field name)
  marketcapBnb: number | null; // native market cap (BNB or SOL; legacy field name)
  vol24hBnb: number; // native 24h volume (legacy field name)
  soldTokens: number | null;
  graduated?: boolean;
  dex?: string | null;
  dexPool?: string | null;
  dexPosition?: string | null;
  graduationLiquidityNative?: number | null;
  graduatedAt?: string | null;
  updatedAt?: string;
};

async function fetchJson(url: string, signal?: AbortSignal) {
  const r = await fetch(url, { method: "GET", signal });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(text || `HTTP ${r.status}`);
  }
  return r.json();
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  const value = String(v ?? "").trim();
  return value ? value : null;
}

function normalizeCampaign(chainId: number, value: string) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

function impliedSoldTokens(price: number | null, marketCap: number | null): number | null {
  if (price == null || marketCap == null || !Number.isFinite(price) || !Number.isFinite(marketCap) || price <= 0 || marketCap < 0) {
    return null;
  }
  const sold = marketCap / price;
  return Number.isFinite(sold) && sold >= 0 ? sold : null;
}

function updatedAtMs(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function keepLiveNumber(incoming: number | null, prev: number | null | undefined): number | null {
  if (incoming == null || !Number.isFinite(incoming) || incoming === 0) {
    if (prev != null && Number.isFinite(prev) && prev !== 0) return prev;
    if (incoming == null && prev != null && Number.isFinite(prev)) return prev;
  }
  return incoming ?? prev ?? null;
}

function statsFromSummaryRow(row: any): TokenStatsRealtime {
  const lastPriceBnb = num(row?.last_price_bnb ?? row?.lastPriceBnb);
  const marketcapBnb = num(row?.marketcap_bnb ?? row?.marketcapBnb);
  return {
    lastPriceBnb,
    marketcapBnb,
    vol24hBnb: Number(num(row?.vol_24h_bnb ?? row?.vol24hBnb) ?? 0),
    soldTokens: num(row?.sold_tokens ?? row?.soldTokens) ?? impliedSoldTokens(lastPriceBnb, marketcapBnb),
    graduated: row?.graduated === true ? true : false,
    dex: str(row?.dex),
    dexPool: str(row?.dexPool ?? row?.dex_pool),
    dexPosition: str(row?.dexPosition ?? row?.dex_position),
    graduationLiquidityNative: num(
      row?.graduationLiquiditySol ?? row?.graduation_liquidity_sol ?? row?.graduationLiquidityNative,
    ),
    graduatedAt: str(row?.graduatedAt ?? row?.graduated_at),
    updatedAt: String(row?.updated_at ?? row?.updatedAt ?? ""),
  };
}

function isEmptySummary(row: unknown): boolean {
  if (row == null || typeof row !== "object") return true;
  const next = statsFromSummaryRow(row);
  return (
    (next.lastPriceBnb == null || next.lastPriceBnb === 0) &&
    (next.marketcapBnb == null || next.marketcapBnb === 0) &&
    (next.soldTokens == null || next.soldTokens === 0) &&
    !next.vol24hBnb &&
    !next.graduated &&
    !next.dex &&
    !String(next.updatedAt || "").trim()
  );
}

/** REST may lag Ably. Never replace valid live stats with empty/zero/stale summary. */
function mergeRestStats(prev: TokenStatsRealtime | null, incoming: TokenStatsRealtime): TokenStatsRealtime {
  if (!prev) return incoming;
  const prevMs = updatedAtMs(prev.updatedAt);
  const incomingMs = updatedAtMs(incoming.updatedAt);
  if (prevMs > 0 && (incomingMs === 0 || incomingMs < prevMs)) {
    return prev;
  }
  return {
    lastPriceBnb: keepLiveNumber(incoming.lastPriceBnb, prev.lastPriceBnb),
    marketcapBnb: keepLiveNumber(incoming.marketcapBnb, prev.marketcapBnb),
    vol24hBnb: incoming.vol24hBnb || prev.vol24hBnb,
    soldTokens: keepLiveNumber(incoming.soldTokens, prev.soldTokens) ?? prev.soldTokens ?? null,
    graduated: incoming.graduated === true ? true : prev.graduated,
    dex: incoming.dex ?? prev.dex ?? null,
    dexPool: incoming.dexPool ?? prev.dexPool ?? null,
    dexPosition: incoming.dexPosition ?? prev.dexPosition ?? null,
    graduationLiquidityNative: incoming.graduationLiquidityNative ?? prev.graduationLiquidityNative ?? null,
    graduatedAt: incoming.graduatedAt ?? prev.graduatedAt ?? null,
    updatedAt: incoming.updatedAt || prev.updatedAt || "",
  };
}

export function useTokenStatsRealtime(campaignAddress?: string, chainId?: number, enabled = true) {
  const [stats, setStats] = useState<TokenStatsRealtime | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoadedRef = useRef(false);

  const cid = useMemo<SupportedChainId>(() => {
    const n = Number(chainId ?? 56);
    if (n === 56 || n === 97 || isSolanaChainId(n)) return n as SupportedChainId;
    const addr = String(campaignAddress || "");
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) && !addr.startsWith("0x")) return 101;
    return 56;
  }, [campaignAddress, chainId]);

  const url = useMemo(() => {
    if (!API_BASE || !campaignAddress) return "";
    const campaign = normalizeCampaign(cid, campaignAddress);
    return `${API_BASE}/api/token/${encodeURIComponent(campaign)}/summary?chainId=${cid}`;
  }, [campaignAddress, cid]);

  const pull = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !campaignAddress) {
      setStats(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (!url) {
      setError("Missing VITE_REALTIME_API_BASE");
      setLoading(false);
      return;
    }
    try {
      if (!initialLoadedRef.current) setLoading(true);
      const row = await fetchJson(url, signal);
      if (!row || isEmptySummary(row)) {
        // Empty /summary must not wipe Ably or on-chain live stats.
        setError(null);
        initialLoadedRef.current = true;
        return;
      }
      const incoming = statsFromSummaryRow(row);
      setStats((prev) => mergeRestStats(prev, incoming));
      setError(null);
      initialLoadedRef.current = true;
    } catch (e: any) {
      setError(String(e?.message || "Failed to load token stats"));
    } finally {
      setLoading(false);
    }
  }, [enabled, campaignAddress, url]);

  useEffect(() => {
    const ac = new AbortController();
    initialLoadedRef.current = false;
    setStats(null);
    setError(null);
    setLoading(true);
    pull(ac.signal);

    if (!enabled || !campaignAddress || !ENABLE_TOKEN_POLLING) return () => ac.abort();
    const t = setInterval(() => pull(ac.signal), 60_000);
    return () => {
      clearInterval(t);
      ac.abort();
    };
  }, [enabled, campaignAddress, cid, pull]);

  const ably = useAblyTokenChannel({ enabled: enabled && !!campaignAddress, chainId: cid, campaignAddress });
  useEffect(() => {
    if (!enabled || !campaignAddress) return;
    if (ably.missingBase || !ably.channel || !ably.client) return;

    const onStats = (msg: any) => {
      const data: any = msg?.data;
      if (!data) return;
      if ((msg?.name || "") !== "stats_patch" && String(data.type || "") !== "stats_patch") return;

      setStats((prev) => {
        const lastPriceBnb = num(data.lastPriceBnb ?? data.last_price_bnb) ?? prev?.lastPriceBnb ?? null;
        const marketcapBnb = num(data.marketcapBnb ?? data.marketcap_bnb) ?? prev?.marketcapBnb ?? null;
        const explicitSold = num(data.soldTokens ?? data.sold_tokens);
        return {
          lastPriceBnb,
          marketcapBnb,
          vol24hBnb: Number(num(data.vol24hBnb ?? data.vol_24h_bnb) ?? prev?.vol24hBnb ?? 0),
          soldTokens: explicitSold ?? impliedSoldTokens(lastPriceBnb, marketcapBnb) ?? prev?.soldTokens ?? null,
          graduated: data.graduated === true ? true : prev?.graduated,
          dex: data.dex != null ? String(data.dex) : prev?.dex ?? null,
          dexPool: data.dexPool != null ? String(data.dexPool) : prev?.dexPool ?? null,
          dexPosition: data.dexPosition != null ? String(data.dexPosition) : prev?.dexPosition ?? null,
          graduationLiquidityNative:
            num(data.graduationLiquiditySol) ?? prev?.graduationLiquidityNative ?? null,
          graduatedAt:
            data.graduatedAt != null ? String(data.graduatedAt) : prev?.graduatedAt ?? null,
          updatedAt: String(data.updatedAt ?? data.updated_at ?? prev?.updatedAt ?? ""),
        };
      });
    };

    const onConn = (c: any) => {
      if (c?.current === "connected") pull();
    };

    try { ably.client.connection.on(onConn); } catch {}
    try { ably.channel.subscribe("stats_patch", onStats); } catch {}

    return () => {
      try { ably.channel.unsubscribe("stats_patch", onStats); } catch {}
      try { ably.client.connection.off(onConn); } catch {}
    };
  }, [enabled, campaignAddress, cid, pull, ably.channel, ably.client, ably.missingBase]);

  return { stats, loading, error };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import { apiFetch } from "@/lib/apiBase";
import {
  coerceSupportedChainId,
  isEvmChainId,
  isSolanaChainId,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { useAblyTokenChannel } from "@/hooks/useAblyTokenChannel";
import { getBlockTimestamps, scanContractLogs } from "@/lib/rpcLogScan";
import { loadCachedTradeHistory, saveCachedTradeHistory } from "@/lib/tradeHistoryCache";
import { indexerRowToCurvePoint } from "@/lib/chart/normalizeTrade";
import {
  isValidTradeTxHash,
  mergeTradePoints,
  normalizeTradeTxHash,
} from "@/lib/tradeDedupe";

function resolveRealtimeApiBase(): string {
  const candidates = [
    import.meta.env.VITE_TOKEN_API_BASE,
    import.meta.env.VITE_RAILWAY_TOKEN_API_BASE,
    import.meta.env.RAILWAY_TOKEN_API_BASE_URL,
    import.meta.env.VITE_REALTIME_API_BASE,
  ];
  for (const value of candidates) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw || /\{\{/.test(raw) || /%7B%7B/i.test(raw)) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^\/\//.test(raw)) return `https:${raw}`;
  }
  return "";
}

const API_BASE = resolveRealtimeApiBase();
const ENABLE_TOKEN_POLLING = String(import.meta.env.VITE_ENABLE_TOKEN_POLLING || "").trim() === "1";
const ENABLE_TRADE_POLL = String(import.meta.env.VITE_DISABLE_TRADE_POLL || "").trim() !== "1";
const ENABLE_ONCHAIN_TRADE_FALLBACK =
  String(import.meta.env.VITE_ENABLE_ONCHAIN_TRADE_FALLBACK || "").trim() === "1" &&
  String(import.meta.env.VITE_DISABLE_ONCHAIN_TRADE_FALLBACK || "").trim() !== "1";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type RealtimeChannel = any;

export type CurveTradePoint = {
  type: "buy" | "sell";
  from: string;
  to: string;
  tokensWei: bigint; // raw token units (name retained for existing callers)
  nativeWei: bigint; // wei on BNB, lamports on Solana
  /**
   * Average execution price of the fill.
   * Kept for EVM compatibility and legacy Solana rows.
   * Solana bonding charts must prefer soldTokensAfterRaw + curve pricing.
   */
  pricePerToken: number; // native coin per whole token
  /** Authoritative post-trade curve sold supply, in raw token units. */
  soldTokensAfterRaw?: bigint | null;
  /** Solana prints: curve fill vs DAMM v2 swap. Omitted on EVM. */
  venue?: "curve" | "dex";
  timestamp: number;
  txHash: string;
  blockNumber: number; // EVM block / Solana slot
  logIndex: number; // EVM log index / Anchor event index
};

type UseCurveTradesOptions = {
  enabled?: boolean;
  chainId?: number;
  limit?: number;
  reconcileMs?: number;
  /** ERC-20 mint when the public URL is the token, not the LaunchCampaign. */
  tokenAddress?: string;
};

const CAMPAIGN_ABI = LaunchCampaignArtifact.abi as ethers.InterfaceAbi;

function normalizeAddress(chainId: number, value: unknown) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

function isTradeCampaignAddress(campaignAddress: string | undefined, chainId: number) {
  const raw = normalizeAddress(chainId, campaignAddress || "");
  if (isSolanaChainId(chainId)) return SOLANA_ADDRESS_RE.test(raw);
  return isEvmChainId(chainId) && ethers.isAddress(raw);
}

function isAbortError(error: unknown): boolean {
  const candidate = error as any;
  return candidate?.name === "AbortError" || String(candidate?.message || candidate || "").toLowerCase().includes("aborted");
}

function toTimestampSec(v: unknown): number {
  try {
    if (v instanceof Date) return Math.floor(v.getTime() / 1000);
    if (typeof v === "number") return Math.floor(v > 1e12 ? v / 1000 : v);
    if (typeof v === "string") {
      const s = v.trim();
      if (/^\d+(?:\.\d+)?$/.test(s)) {
        const n = Number(s);
        return Number.isFinite(n) ? Math.floor(n > 1e12 ? n / 1000 : n) : 0;
      }
      const ms = new Date(s).getTime();
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
    }
    const ms = new Date(String(v)).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  } catch {
    return 0;
  }
}

function parseAmount(rawValue: unknown, decimalValue: unknown, decimals: number): bigint {
  const raw = String(rawValue ?? "").trim();
  if (/^\d+$/.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      // fall through
    }
  }
  try {
    return ethers.parseUnits(String(decimalValue ?? "0"), decimals);
  } catch {
    return 0n;
  }
}

function numberFromRaw(raw: bigint, decimals: number): number {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function fetchIndexerTrades(campaignAddress: string, chainId: number, limit: number, signal?: AbortSignal) {
  const campaign = normalizeAddress(chainId, campaignAddress);
  const path = `/api/token/${encodeURIComponent(campaign)}/trades?chainId=${chainId}&limit=${limit}`;
  const timeout = new AbortController();
  const onParentAbort = () => timeout.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => timeout.abort(), isSolanaChainId(chainId) ? 7_000 : 5_000);
  try {
    try {
      const r = await apiFetch(path, { method: "GET", signal: timeout.signal, cache: "no-store" as RequestCache });
      if (r.ok) {
        const body = await r.json();
        if (Array.isArray(body)) return body;
        if (Array.isArray(body?.items)) return body.items;
      }
    } catch {
      // fall through to absolute indexer URL
    }

    if (!API_BASE) return [];
    const absolute = `${API_BASE}/api/token/${encodeURIComponent(campaign)}/trades?chainId=${chainId}&limit=${limit}`;
    const r = await fetch(absolute, { method: "GET", signal: timeout.signal, cache: "no-store" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(text || `HTTP ${r.status}`);
    }
    const body = await r.json();
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

const EVM_TRADE_IFACES = [
  // Live LaunchCampaign (3-arg).
  new ethers.Interface([
    "event TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost)",
    "event TokensSold(address indexed seller, uint256 amountIn, uint256 payout)",
  ]),
  // Older campaigns that also indexed newSold.
  new ethers.Interface([
    "event TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost, uint256 newSold)",
    "event TokensSold(address indexed seller, uint256 amountIn, uint256 payout, uint256 newSold)",
  ]),
  new ethers.Interface(CAMPAIGN_ABI),
];

function evmTradeTopics() {
  const buys = new Set<string>();
  const sells = new Set<string>();
  for (const iface of EVM_TRADE_IFACES) {
    try {
      const buy = iface.getEvent("TokensPurchased")?.topicHash;
      const sell = iface.getEvent("TokensSold")?.topicHash;
      if (buy) buys.add(buy);
      if (sell) sells.add(sell);
    } catch {
      // ignore ABI variants that are not present
    }
  }
  return { buys: [...buys], sells: [...sells] };
}

function parseEvmTradeLog(log: ethers.Log, campaignAddress: string): Omit<CurveTradePoint, "timestamp"> | null {
  for (const iface of EVM_TRADE_IFACES) {
    try {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      const isSell = parsed.name === "TokensSold";
      if (parsed.name !== "TokensPurchased" && !isSell) continue;
      const tokensWei = BigInt(String(isSell ? parsed.args.amountIn : parsed.args.amountOut));
      const nativeWei = BigInt(String(isSell ? parsed.args.payout : parsed.args.cost));
      const tokens = numberFromRaw(tokensWei, 18);
      const native = numberFromRaw(nativeWei, 18);
      const txHash = normalizeTradeTxHash(log.transactionHash);
      if (!txHash) return null;
      return {
        type: isSell ? "sell" : "buy",
        from: String(isSell ? parsed.args.seller : parsed.args.buyer).toLowerCase(),
        to: campaignAddress,
        tokensWei,
        nativeWei,
        pricePerToken: tokens > 0 ? native / tokens : 0,
        txHash,
        blockNumber: Number(log.blockNumber ?? 0),
        logIndex: Number(log.index ?? 0),
      };
    } catch {
      // try next ABI
    }
  }
  return null;
}

async function fetchOnChainTradeSnapshot(
  campaignAddress: string,
  chainId: SupportedChainId,
  limit: number,
  signal?: AbortSignal,
  lookbackBlocks = 50_000,
  fromBlock?: number,
): Promise<CurveTradePoint[]> {
  // Solana history comes from the dedicated program indexer; never send base58
  // addresses through EVM getLogs recovery.
  if (!isEvmChainId(chainId) || !ethers.isAddress(campaignAddress)) return [];

  const { buys, sells } = evmTradeTopics();
  if (!buys.length || !sells.length) return [];

  const address = campaignAddress.toLowerCase();
  // Separate buy/sell scans (some RPCs mishandle topic OR), sequential so we
  // do not rate-limit ourselves. Each scan retries every chunk on every RPC.
  const buyLogs = await scanContractLogs({
    chainId,
    address,
    topics: [buys],
    lookbackBlocks,
    fromBlock,
    chunkSize: 2_500,
    signal,
  });
  const sellLogs = await scanContractLogs({
    chainId,
    address,
    topics: [sells],
    lookbackBlocks,
    fromBlock,
    chunkSize: 2_500,
    signal,
  });
  const allLogs = [...buyLogs, ...sellLogs]
    .sort((a, b) => a.blockNumber - b.blockNumber || Number(a.index ?? 0) - Number(b.index ?? 0))
    .slice(-limit);

  const timestamps = await getBlockTimestamps(chainId, allLogs.map((log) => Number(log.blockNumber || 0)), signal);
  const out: CurveTradePoint[] = [];
  for (const log of allLogs) {
    if (signal?.aborted) break;
    const parsed = parseEvmTradeLog(log, address);
    if (!parsed || parsed.blockNumber <= 0) continue;
    const timestamp = timestamps.get(parsed.blockNumber) || 0;
    if (!timestamp) continue;
    out.push({ ...parsed, timestamp });
  }
  return out.filter((t) => isValidTradeTxHash(t.txHash) && t.blockNumber > 0 && t.timestamp > 0);
}

/**
 * Curve trades backed by:
 *  1) Railway realtime-indexer REST snapshot (BNB + Solana)
 *  2) EVM-only getLogs fallback
 *  3) Ably token channel
 *  4) Light HTTP polling for convergence
 */
export function useCurveTrades(campaignAddress?: string, opts?: UseCurveTradesOptions) {
  const enabled = opts?.enabled ?? true;
  const [points, setPoints] = useState<CurveTradePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevCampaignRef = useRef<string>("");

  const chainId = useMemo<SupportedChainId>(() => {
    const addr = String(campaignAddress || "");
    const explicit = coerceSupportedChainId(opts?.chainId);
    // A 0x market is never Solana, even if Token Details passed a latched 101.
    if (/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      return isEvmChainId(explicit) ? explicit : 56;
    }
    if (explicit) return explicit;
    if (SOLANA_ADDRESS_RE.test(addr)) return 101;
    return 56;
  }, [campaignAddress, opts?.chainId]);

  const inFlightRef = useRef(false);
  const tipInFlightRef = useRef(false);
  const initialLoadedRef = useRef(false);
  const highestBlockScannedRef = useRef(0);
  const reconcileMs = opts?.reconcileMs ?? 4_000;
  const limit = Math.min(Math.max(Number(opts?.limit ?? 200), 1), 200);
  const canLoadTrades = enabled && isTradeCampaignAddress(campaignAddress, chainId);

  const applySnapshot = useCallback((rows: any[]) => {
    const tokenDecimals = isSolanaChainId(chainId) ? 6 : 18;
    const nativeDecimals = isSolanaChainId(chainId) ? 9 : 18;
    const target = normalizeAddress(chainId, campaignAddress || "");

    const next: CurveTradePoint[] = (rows || [])
      .map((r: any) =>
        indexerRowToCurvePoint(r, chainId, target, { token: tokenDecimals, native: nativeDecimals }),
      )
      .filter((t): t is CurveTradePoint => Boolean(t) && isValidTradeTxHash(t?.txHash) && Number.isFinite(Number(t?.blockNumber)));

    // Empty indexer/REST snapshot must not wipe points Ably already applied.
    if (!next.length) return 0;

    setPoints((prev) => {
      const merged = mergeTradePoints(prev, next);
      if (campaignAddress && merged.length) saveCachedTradeHistory(chainId, campaignAddress, merged);
      return merged;
    });
    return next.length;
  }, [campaignAddress, chainId]);

  const pullSnapshot = useCallback(async (
    signal?: AbortSignal,
    mode: "full" | "tip" = "full",
  ) => {
    if (!canLoadTrades || !campaignAddress) {
      setPoints([]);
      setLoading(false);
      setError(null);
      initialLoadedRef.current = true;
      return;
    }
    const lock = mode === "tip" ? tipInFlightRef : inFlightRef;
    if (lock.current) return;
    lock.current = true;
    try {
      if (!initialLoadedRef.current && mode === "full") setLoading(true);
      let apiRows: any[] = [];
      try {
        const tokenAddress = String(opts?.tokenAddress || "").trim();
        const lookups = [campaignAddress];
        if (tokenAddress && tokenAddress.toLowerCase() !== String(campaignAddress).toLowerCase()) {
          lookups.push(tokenAddress);
        }
        const pages = await Promise.all(lookups.map((addr) => fetchIndexerTrades(addr, chainId, limit, signal)));
        apiRows = pages.flat();
        if (signal?.aborted) return;
        if (apiRows.length) {
          applySnapshot(apiRows);
          setLoading(false);
          initialLoadedRef.current = true;
          
          // If the indexer API successfully returned data, skip the aggressive 
          // on-chain fallback entirely.
          setError(null);
          return;
        }
        // Empty trades snapshot: keep Ably/cached points. Do not setPoints([]).
      } catch (apiError: any) {
        if (isAbortError(apiError)) return;
        console.warn("[useCurveTrades] indexer trade API failed", apiError);
      }

      // EVM-only getLogs recovery. Do not enable this globally — Solana uses
      // Ably `trade` + Token Details 5s curve read when the indexer is stuck.
      if (isEvmChainId(chainId) && ENABLE_ONCHAIN_TRADE_FALLBACK) {
        try {
          const isDelta = highestBlockScannedRef.current > 0;
          const fallbackRows = await fetchOnChainTradeSnapshot(
            campaignAddress,
            chainId,
            limit,
            signal,
            mode === "tip" && isDelta ? 10_000 : 200_000,
            isDelta ? highestBlockScannedRef.current + 1 : undefined,
          );
          if (signal?.aborted) return;
          if (fallbackRows.length) {
            applySnapshot(fallbackRows);
            const maxBlock = Math.max(...fallbackRows.map(r => r.blockNumber));
            if (maxBlock > highestBlockScannedRef.current) {
              highestBlockScannedRef.current = maxBlock;
            }
          }
        } catch (fallbackError) {
          if (!isAbortError(fallbackError)) console.warn("[useCurveTrades] on-chain trade recovery skipped/failed", fallbackError);
        }
      }

      setError(null);
      initialLoadedRef.current = true;
    } catch (snapshotError: any) {
      if (!isAbortError(snapshotError)) {
        console.warn("[useCurveTrades] trade snapshot failed", snapshotError);
        setError(null);
        initialLoadedRef.current = true;
      }
    } finally {
      setLoading(false);
      lock.current = false;
    }
  }, [canLoadTrades, campaignAddress, applySnapshot, chainId, limit, opts?.tokenAddress]);

  useEffect(() => {
    const ac = new AbortController();
    const curr = canLoadTrades ? `${chainId}:${normalizeAddress(chainId, campaignAddress || "")}` : "";
    const prev = prevCampaignRef.current;
    if (curr !== prev) {
      prevCampaignRef.current = curr;
      const cached = curr ? loadCachedTradeHistory(chainId, campaignAddress || "") : [];
      setPoints(cached.filter((point) => point.tokensWei > 0n));
      setLoading(canLoadTrades && cached.length === 0);
      setError(null);
      initialLoadedRef.current = false;
    }

    void pullSnapshot(ac.signal, "full");
    if (!canLoadTrades || (!ENABLE_TRADE_POLL && !ENABLE_TOKEN_POLLING)) return () => ac.abort();
    const timer = setInterval(() => void pullSnapshot(ac.signal, "tip"), reconcileMs);
    return () => {
      clearInterval(timer);
      ac.abort();
    };
  }, [canLoadTrades, campaignAddress, chainId, pullSnapshot, reconcileMs]);

  useEffect(() => {
    if (!canLoadTrades || !campaignAddress) return;
    const current = normalizeAddress(chainId, campaignAddress);
    const onConfirmed = (event: Event) => {
      const detail = (event as CustomEvent)?.detail || {};
      const kind = String(detail?.kind || "").toLowerCase();
      const confirmedCampaign = normalizeAddress(chainId, detail?.campaignAddress || "");
      const tokenKey = normalizeAddress(chainId, opts?.tokenAddress || "");
      if (
        (kind !== "buy" && kind !== "sell") ||
        (confirmedCampaign !== current && (!tokenKey || confirmedCampaign !== tokenKey))
      ) return;
      if (Array.isArray(detail?.trades) && detail.trades.length) applySnapshot(detail.trades);
      void pullSnapshot(undefined, "tip");
      window.setTimeout(() => void pullSnapshot(undefined, "tip"), 1_500);
      window.setTimeout(() => void pullSnapshot(undefined, "tip"), 4_000);
      window.setTimeout(() => void pullSnapshot(undefined, "tip"), 8_000);
    };
    window.addEventListener("memewarzone:txConfirmed", onConfirmed as EventListener);
    return () => window.removeEventListener("memewarzone:txConfirmed", onConfirmed as EventListener);
  }, [canLoadTrades, campaignAddress, chainId, applySnapshot, pullSnapshot]);

  const ably = useAblyTokenChannel({ enabled: canLoadTrades, chainId, campaignAddress });
  useEffect(() => {
    if (!canLoadTrades || ably.missingBase || !ably.channel) return;
    const channel: RealtimeChannel = ably.channel;
    const onTrade = (msg: any) => {
      const data = msg?.data;
      if (Array.isArray(data)) applySnapshot(data);
      else if (data && typeof data === "object") applySnapshot([data]);
    };
    try {
      channel.subscribe("trade", onTrade);
    } catch {
      // HTTP polling remains authoritative when realtime is unavailable.
    }
    return () => {
      try {
        channel.unsubscribe("trade", onTrade);
      } catch {
        // ignore
      }
    };
  }, [canLoadTrades, ably.channel, ably.missingBase, applySnapshot]);

  return { points, loading, error };
}

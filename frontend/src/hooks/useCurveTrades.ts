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
import { indexerRowToCurvePoint } from "@/lib/chart/normalizeTrade";
import { notifyIndexerFills } from "@/lib/indexerTradeIngest";
import { fetchSolanaOnChainTrades } from "@/lib/solanaOnChainTrades";
import {
  parseIndexerTradeBody,
  shouldRunSolanaHistoryFallback,
  shouldRunSolanaTipReconcile,
} from "@/lib/indexerTradeSnapshot";
import {
  isValidTradeTxHash,
  mergeIndexerSnapshot,
  mergeTradePoints,
  normalizeTradeTxHash,
  tradeDedupeKey,
  unionIndexedAndLive,
} from "@/lib/tradeDedupe";

const ENABLE_TOKEN_POLLING = String(import.meta.env.VITE_ENABLE_TOKEN_POLLING || "").trim() === "1";
const ENABLE_TRADE_POLL = String(import.meta.env.VITE_DISABLE_TRADE_POLL || "").trim() !== "1";
const ENABLE_ONCHAIN_TRADE_FALLBACK =
  String(import.meta.env.VITE_ENABLE_ONCHAIN_TRADE_FALLBACK || "").trim() === "1" &&
  String(import.meta.env.VITE_DISABLE_ONCHAIN_TRADE_FALLBACK || "").trim() !== "1";
const ENABLE_SOLANA_ONCHAIN_TRADE_FALLBACK =
  String(import.meta.env.VITE_DISABLE_SOLANA_ONCHAIN_TRADE_FALLBACK || "").trim() !== "1";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_INDEXER_BACKOFF_MS = 60_000;

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

type IndexerTradeSnapshot = {
  items: any[];
  historyComplete: boolean | null;
  repairState: string | null;
  campaignAddress: string | null;
  lastIndexedSlot: number | null;
  source: "relative";
};

async function fetchIndexerTrades(campaignAddress: string, chainId: number, limit: number, signal?: AbortSignal): Promise<IndexerTradeSnapshot> {
  const campaign = normalizeAddress(chainId, campaignAddress);
  const path = `/api/token/${encodeURIComponent(campaign)}/trades?chainId=${chainId}&limit=${limit}`;
  const timeout = new AbortController();
  const onParentAbort = () => timeout.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => timeout.abort(), isSolanaChainId(chainId) ? 7_000 : 5_000);
  try {
    // apiFetch is the canonical router for indexer-only token endpoints. Do not
    // retry the same configured indexer URL here: when the upstream is 5xx that
    // doubled every browser request and made a transient outage much noisier.
    const r = await apiFetch(path, { method: "GET", signal: timeout.signal, cache: "no-store" as RequestCache });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(text || `Indexer trades HTTP ${r.status}`);
    }
    const body = await r.json();
    return { ...parseIndexerTradeBody(body, chainId), source: "relative" };
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
 *  1) Indexer REST snapshot (authoritative history)
 *  2) Solana campaign-PDA decode when that snapshot is empty or missing txs
 *  3) EVM getLogs fallback (opt-in)
 *  4) Ably / txConfirmed session-live rows not yet in the snapshot
 */
export function useCurveTrades(campaignAddress?: string, opts?: UseCurveTradesOptions) {
  const enabled = opts?.enabled ?? true;
  const [indexedPoints, setIndexedPoints] = useState<CurveTradePoint[]>([]);
  const [livePoints, setLivePoints] = useState<CurveTradePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevCampaignRef = useRef<string>("");
  const indexedKeysRef = useRef<Set<string>>(new Set());
  const indexedTxRef = useRef<Set<string>>(new Set());
  const livePointsRef = useRef<CurveTradePoint[]>([]);

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
  const indexerFailureCountRef = useRef(0);
  const indexerBackoffUntilRef = useRef(0);
  const reconcileMs = opts?.reconcileMs ?? 4_000;
  const limit = Math.min(Math.max(Number(opts?.limit ?? 200), 1), 200);
  const canLoadTrades = enabled && isTradeCampaignAddress(campaignAddress, chainId);

  const rowsToPoints = useCallback((rows: any[]): CurveTradePoint[] => {
    const tokenDecimals = isSolanaChainId(chainId) ? 6 : 18;
    const nativeDecimals = isSolanaChainId(chainId) ? 9 : 18;
    const target = normalizeAddress(chainId, campaignAddress || "");
    return (rows || [])
      .map((r: any) =>
        indexerRowToCurvePoint(r, chainId, target, { token: tokenDecimals, native: nativeDecimals }),
      )
      .filter((t): t is CurveTradePoint => Boolean(t) && isValidTradeTxHash(t?.txHash) && Number.isFinite(Number(t?.blockNumber)));
  }, [campaignAddress, chainId]);

  const applyIndexerSnapshot = useCallback((rows: any[]) => {
    const incoming = rowsToPoints(rows);
    setIndexedPoints((prev) => {
      const merged = mergeIndexerSnapshot(prev, incoming);
      const keys = new Set(merged.map((point) => tradeDedupeKey(point)).filter(Boolean));
      indexedKeysRef.current = keys;
      indexedTxRef.current = new Set(merged.map((point) => normalizeTradeTxHash(point.txHash)).filter(Boolean));
      return merged;
    });
    setLivePoints((prev) =>
      prev.filter((point) => {
        const key = tradeDedupeKey(point);
        return Boolean(key) && !indexedKeysRef.current.has(key);
      }),
    );
    return incoming.length;
  }, [rowsToPoints]);

  const applyLivePoints = useCallback((incoming: CurveTradePoint[]) => {
    if (!incoming.length) return 0;
    setLivePoints((prev) => {
      const extras = incoming.filter((point) => {
        const key = tradeDedupeKey(point);
        return Boolean(key) && !indexedKeysRef.current.has(key);
      });
      if (!extras.length) return prev;
      return mergeTradePoints(prev, extras);
    });
    return incoming.length;
  }, []);

  const applyLiveRows = useCallback((rows: any[]) => applyLivePoints(rowsToPoints(rows)), [applyLivePoints, rowsToPoints]);

  const pullSnapshot = useCallback(async (
    signal?: AbortSignal,
    mode: "full" | "tip" = "full",
  ) => {
    if (!canLoadTrades || !campaignAddress) {
      indexedKeysRef.current = new Set();
      indexedTxRef.current = new Set();
      livePointsRef.current = [];
      setIndexedPoints([]);
      setLivePoints([]);
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
      let indexerOk = false;
      let indexerRows = 0;
      let indexerLatencyMs = 0;
      let historyComplete: boolean | null = null;
      let repairState: string | null = null;
      let lastIndexedSlot: number | null = null;
      let fallbackRan = false;
      let fallbackRows = 0;
      let fallbackLatencyMs = 0;
      const indexerBackoffActive = mode === "tip" && Date.now() < indexerBackoffUntilRef.current;

      if (!indexerBackoffActive) {
        try {
          const lookups = [campaignAddress];
          if (
            opts?.tokenAddress &&
            String(opts.tokenAddress).trim() &&
            String(opts.tokenAddress).trim() !== String(campaignAddress).trim()
          ) {
            lookups.push(String(opts.tokenAddress).trim());
          }
          const started = Date.now();
          const pages = await Promise.all(lookups.map((addr) => fetchIndexerTrades(addr, chainId, limit, signal)));
          indexerLatencyMs = Date.now() - started;
          if (signal?.aborted) return;
          const snapshotItems = pages.flatMap((page) => page.items || []);
          applyIndexerSnapshot(snapshotItems);
          indexerRows = snapshotItems.length;
          historyComplete = pages.reduce<boolean | null>((best, page) => {
            if (page.historyComplete === true) return true;
            if (best == null) return page.historyComplete;
            return best;
          }, null);
          repairState = pages.map((page) => page.repairState).find(Boolean) || null;
          lastIndexedSlot = pages.reduce<number | null>((best, page) => {
            const slot = page.lastIndexedSlot;
            if (slot == null) return best;
            return best == null ? slot : Math.max(best, slot);
          }, null);
          indexerOk = true;
          indexerFailureCountRef.current = 0;
          indexerBackoffUntilRef.current = 0;
          const maxIndexedBlock = Math.max(
            0,
            ...snapshotItems.map((row: any) => Number(row?.block_number ?? row?.blockNumber ?? 0)),
          );
          if (maxIndexedBlock > highestBlockScannedRef.current) highestBlockScannedRef.current = maxIndexedBlock;
        } catch (apiError: any) {
          if (isAbortError(apiError)) return;
          const failures = Math.min(indexerFailureCountRef.current + 1, 5);
          indexerFailureCountRef.current = failures;
          const backoffMs = Math.min(MAX_INDEXER_BACKOFF_MS, reconcileMs * 2 ** failures);
          indexerBackoffUntilRef.current = Date.now() + backoffMs;
          if (mode === "full" || failures === 1) {
            console.warn("[useCurveTrades] indexer trade API failed; backing off", {
              error: apiError,
              backoffMs,
              failures,
            });
          }
        }
      } else {
        repairState = "indexer-backoff";
      }

      if (indexerRows > 0) setLoading(false);

      const fullHistoryFallback = shouldRunSolanaHistoryFallback({
        fallbackEnabled: ENABLE_SOLANA_ONCHAIN_TRADE_FALLBACK,
        indexerOk,
        historyComplete,
        indexerRows,
      });
      const tipReconcile = shouldRunSolanaTipReconcile({
        fallbackEnabled: ENABLE_SOLANA_ONCHAIN_TRADE_FALLBACK,
        indexerOk,
        indexerRows,
      });
      const runSolanaCheck =
        !indexerBackoffActive &&
        isSolanaChainId(chainId) &&
        Boolean(campaignAddress) &&
        (mode === "full" || !indexerOk) &&
        (fullHistoryFallback || tipReconcile || indexerOk);
      const verifySolana = async () => {
        if (!runSolanaCheck || !campaignAddress) return 0;
        const known = new Set<string>([
          ...indexedTxRef.current,
          ...livePointsRef.current.map((point) => normalizeTradeTxHash(point.txHash)).filter(Boolean),
        ]);
        const knownIdentities = new Set<string>([
          ...indexedKeysRef.current,
          ...livePointsRef.current.map((point) => tradeDedupeKey(point)).filter(Boolean),
        ]);
        const chainRows = await fetchSolanaOnChainTrades(campaignAddress, {
          knownTxHashes: known,
          knownIdentities,
          minSlot: lastIndexedSlot,
          maxFetch: 8,
          signal,
          limit: 20,
        });
        if (signal?.aborted) return 0;
        if (chainRows.length) {
          applyLivePoints(chainRows);
          notifyIndexerFills({
            chainId,
            campaignAddress,
            txHashes: chainRows.map((row) => row.txHash),
          });
        }
        return chainRows.length;
      };
      if (runSolanaCheck) {
        fallbackRan = true;
        if (indexerRows > 0) {
          void verifySolana()
            .then((n) => {
              fallbackRows = n;
            })
            .catch((chainError) => {
              if (!isAbortError(chainError)) {
                console.warn("[useCurveTrades] Solana on-chain trade fallback failed", chainError);
              }
            });
        } else {
          try {
            const started = Date.now();
            fallbackRows = await verifySolana();
            fallbackLatencyMs = Date.now() - started;
          } catch (chainError) {
            if (!isAbortError(chainError)) {
              console.warn("[useCurveTrades] Solana on-chain trade fallback failed", chainError);
            }
          }
        }
      }

      if (mode === "full" || !indexerBackoffActive) {
        console.info("[useCurveTrades] snapshot", {
          chainId,
          campaign: campaignAddress,
          mode,
          indexerOk,
          indexerRows,
          indexerLatencyMs,
          historyComplete,
          repairState,
          fallbackRan,
          fallbackRows,
          fallbackLatencyMs,
          finalRows: indexedKeysRef.current.size + livePointsRef.current.length,
        });
      }

      if (isEvmChainId(chainId) && !indexerBackoffActive && (mode === "full" || !indexerOk)) {
        try {
          const isDelta = highestBlockScannedRef.current > 0;
          const deepHistory = ENABLE_ONCHAIN_TRADE_FALLBACK && !indexerOk && mode === "full";
          const chainRows = await fetchOnChainTradeSnapshot(
            campaignAddress,
            chainId,
            limit,
            signal,
            deepHistory ? 200_000 : 4_000,
            isDelta ? highestBlockScannedRef.current + 1 : undefined,
          );
          if (signal?.aborted) return;
          const extras = chainRows.filter((row) => {
            const key = tradeDedupeKey(row);
            return Boolean(key) && !indexedKeysRef.current.has(key);
          });
          if (extras.length) {
            applyLivePoints(extras);
            notifyIndexerFills({
              chainId,
              campaignAddress,
              txHashes: extras.map((row) => row.txHash),
            });
          }
          if (chainRows.length) {
            const maxBlock = Math.max(...chainRows.map((row) => row.blockNumber));
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
  }, [canLoadTrades, campaignAddress, applyIndexerSnapshot, applyLivePoints, chainId, limit, opts?.tokenAddress, reconcileMs]);

  useEffect(() => {
    livePointsRef.current = livePoints;
  }, [livePoints]);

  useEffect(() => {
    const ac = new AbortController();
    const curr = canLoadTrades ? `${chainId}:${normalizeAddress(chainId, campaignAddress || "")}` : "";
    const prev = prevCampaignRef.current;
    if (curr !== prev) {
      prevCampaignRef.current = curr;
      indexedKeysRef.current = new Set();
      indexedTxRef.current = new Set();
      livePointsRef.current = [];
      highestBlockScannedRef.current = 0;
      indexerFailureCountRef.current = 0;
      indexerBackoffUntilRef.current = 0;
      setIndexedPoints([]);
      setLivePoints([]);
      setLoading(canLoadTrades);
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
      if (Array.isArray(detail?.trades) && detail.trades.length) applyLiveRows(detail.trades);
      void pullSnapshot(undefined, "tip");
      window.setTimeout(() => void pullSnapshot(undefined, "tip"), 1_500);
      window.setTimeout(() => void pullSnapshot(undefined, "tip"), 4_000);
      window.setTimeout(() => void pullSnapshot(undefined, "tip"), 8_000);
    };
    window.addEventListener("memewarzone:txConfirmed", onConfirmed as EventListener);
    return () => window.removeEventListener("memewarzone:txConfirmed", onConfirmed as EventListener);
  }, [canLoadTrades, campaignAddress, chainId, applyLiveRows, pullSnapshot, opts?.tokenAddress]);

  const ably = useAblyTokenChannel({ enabled: canLoadTrades, chainId, campaignAddress });
  useEffect(() => {
    if (!canLoadTrades || ably.missingBase || !ably.channel) return;
    const channel: RealtimeChannel = ably.channel;
    const onTrade = (msg: any) => {
      const data = msg?.data;
      if (Array.isArray(data)) applyLiveRows(data);
      else if (data && typeof data === "object") applyLiveRows([data]);
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
  }, [canLoadTrades, ably.channel, ably.missingBase, applyLiveRows]);

  const points = useMemo(
    () => unionIndexedAndLive(indexedPoints, livePoints),
    [indexedPoints, livePoints],
  );

  return { points, loading, error, indexedPoints, livePoints };
}

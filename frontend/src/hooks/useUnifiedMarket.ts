import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAblyTokenChannel } from "@/hooks/useAblyTokenChannel";
import {
  fetchMarketCandles,
  fetchMarketState,
  fetchMarketSummary,
  fetchMarketTrades,
  type MarketCandle,
  type MarketState,
  type MarketSummary,
  type MarketTrade,
  type MarketTradeSource,
} from "@/lib/marketContinuityApi";
import { campaignKey, isCampaignAddress, isTradeTxId } from "@/lib/chart/normalizeTrade";
import { normalizeTradeTxHash } from "@/lib/tradeDedupe";

export type MarketResolution = "1s" | "5s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

function tradeKey(trade: Pick<MarketTrade, "txHash" | "logIndex">) {
  const tx = normalizeTradeTxHash(trade.txHash) || String(trade.txHash || "").trim();
  const logIndex = Number(trade.logIndex ?? 0);
  if (!Number.isFinite(logIndex) || logIndex <= 0 || logIndex >= 1_000_000) return `${tx}:synthetic`;
  return `${tx}:${logIndex}`;
}

function mergeTrades(current: MarketTrade[], incoming: MarketTrade[], chainId: number) {
  const map = new Map<string, MarketTrade>();
  const realTx = new Set<string>();
  const prefer = (a: MarketTrade, b: MarketTrade) => {
    const aReal = Number(a.logIndex) > 0 && Number(a.logIndex) < 1_000_000;
    const bReal = Number(b.logIndex) > 0 && Number(b.logIndex) < 1_000_000;
    if (aReal !== bReal) return bReal ? b : a;
    return Number(b.logIndex || 0) >= Number(a.logIndex || 0) ? b : a;
  };
  for (const trade of [...current, ...incoming]) {
    const tx = normalizeTradeTxHash(trade.txHash);
    if (!tx || !isTradeTxId(chainId, tx)) continue;
    const logIndex = Number(trade.logIndex ?? 0);
    if (Number.isFinite(logIndex) && logIndex > 0 && logIndex < 1_000_000) realTx.add(tx);
    const key = tradeKey(trade);
    const prev = map.get(key);
    map.set(key, prev ? prefer(prev, trade) : trade);
  }
  return Array.from(map.values())
    .filter((trade) => {
      const tx = normalizeTradeTxHash(trade.txHash);
      const logIndex = Number(trade.logIndex ?? 0);
      const synthetic = !Number.isFinite(logIndex) || logIndex <= 0 || logIndex >= 1_000_000;
      return !(synthetic && tx && realTx.has(tx));
    })
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .slice(-500);
}

function candleKey(candle: MarketCandle) {
  return new Date(candle.bucket_start).getTime();
}

function mergeCandles(current: MarketCandle[], incoming: MarketCandle[]) {
  const map = new Map<number, MarketCandle>();
  for (const candle of current) map.set(candleKey(candle), candle);
  for (const candle of incoming) map.set(candleKey(candle), candle);
  return Array.from(map.values()).sort((a, b) => candleKey(a) - candleKey(b));
}

function applyRestCandles(current: MarketCandle[], incoming: MarketCandle[]): MarketCandle[] {
  if (!incoming.length) return current.length ? current : incoming;
  const merged = mergeCandles(current, incoming);
  const lastLocal = current[current.length - 1];
  const lastIncoming = incoming[incoming.length - 1];
  if (!lastLocal || !lastIncoming) return merged;
  const localKey = candleKey(lastLocal);
  const incomingKey = candleKey(lastIncoming);
  if (!Number.isFinite(localKey) || localKey <= incomingKey) return merged;
  const lastMerged = merged[merged.length - 1];
  if (!lastMerged || candleKey(lastMerged) < localKey) return [...merged, lastLocal];
  if (candleKey(lastMerged) === localKey) merged[merged.length - 1] = lastLocal;
  return merged;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function realtimeCandle(data: any, resolution: MarketResolution): MarketCandle | null {
  const tf = String(data?.resolution || data?.timeframe || data?.tf || "").trim();
  if (tf && tf !== resolution) return null;
  const bucketRaw = data?.bucket_start ?? data?.bucketStart ?? data?.time ?? data?.bucket;
  let bucketMs = 0;
  if (typeof bucketRaw === "number" || /^\d+(?:\.\d+)?$/.test(String(bucketRaw || ""))) {
    const numeric = Number(bucketRaw);
    bucketMs = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  } else {
    bucketMs = new Date(String(bucketRaw || "")).getTime();
  }
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return null;
  const o = data?.open ?? data?.o;
  const h = data?.high ?? data?.h;
  const l = data?.low ?? data?.l;
  const c = data?.close ?? data?.c;
  const volume = data?.volume_bnb ?? data?.volumeBnb ?? data?.volume_native ?? data?.volumeNative ?? data?.volume;
  const tradesCount = numberOrNull(data?.trades_count ?? data?.tradesCount);
  if ([o, h, l, c, volume].some((value) => value == null || value === "") || tradesCount == null) return null;
  return {
    bucket_start: new Date(bucketMs).toISOString(),
    o: String(o), h: String(h), l: String(l), c: String(c),
    price_o: stringOrNull(data?.price_o ?? data?.priceOpen),
    price_h: stringOrNull(data?.price_h ?? data?.priceHigh),
    price_l: stringOrNull(data?.price_l ?? data?.priceLow),
    price_c: stringOrNull(data?.price_c ?? data?.priceClose),
    mcap_o: stringOrNull(data?.mcap_o ?? data?.marketCapOpen),
    mcap_h: stringOrNull(data?.mcap_h ?? data?.marketCapHigh),
    mcap_l: stringOrNull(data?.mcap_l ?? data?.marketCapLow),
    mcap_c: stringOrNull(data?.mcap_c ?? data?.marketCapClose),
    canonical_version: numberOrNull(data?.canonical_version ?? data?.canonicalVersion),
    canonical_updated_at: stringOrNull(data?.canonical_updated_at ?? data?.canonicalUpdatedAt),
    volume_bnb: String(volume),
    trades_count: Math.max(0, Math.trunc(tradesCount)),
    source_mask: Math.max(0, Math.trunc(numberOrNull(data?.source_mask ?? data?.sourceMask) ?? 1)),
    bonding_trade_count: Math.max(0, Math.trunc(numberOrNull(data?.bonding_trade_count ?? data?.bondingTradeCount) ?? tradesCount)),
    dex_trade_count: Math.max(0, Math.trunc(numberOrNull(data?.dex_trade_count ?? data?.dexTradeCount) ?? 0)),
    bonding_volume_bnb: String(data?.bonding_volume_bnb ?? data?.bondingVolumeBnb ?? volume),
    dex_volume_bnb: String(data?.dex_volume_bnb ?? data?.dexVolumeBnb ?? "0"),
    last_block_number: numberOrNull(data?.last_block_number ?? data?.lastBlockNumber ?? data?.lastBlock),
    last_log_index: numberOrNull(data?.last_log_index ?? data?.lastLogIndex),
  };
}

function normalizeMarketTradeSource(value: unknown): MarketTradeSource {
  const source = String(value || "").trim().toLowerCase();
  if (source === "bonding") return "bonding";
  if (source === "robinhood_v3") return "robinhood_v3";
  return "topaz";
}

function realtimeTrade(data: any, chainId: number): MarketTrade | null {
  const txHash = normalizeTradeTxHash(data?.txHash || data?.tx_hash);
  const blockNumber = Number(data?.blockNumber || data?.block_number || 0);
  if (!txHash || !isTradeTxId(chainId, txHash) || !Number.isInteger(blockNumber) || blockNumber <= 0) return null;
  const source = normalizeMarketTradeSource(data?.source);
  return {
    chainId: Number(data.chainId || chainId || 0),
    campaignAddress: campaignKey(chainId, data.campaignAddress || data.campaign_address || ""),
    tokenAddress: campaignKey(chainId, data.tokenAddress || data.token_address || ""),
    pairAddress: data.pairAddress || data.pair_address ? campaignKey(chainId, data.pairAddress || data.pair_address) : null,
    marketStage: String(data.marketStage || (source === "robinhood_v3" ? "DEX" : source === "topaz" ? "TOPAZ" : "BONDING")),
    source,
    side: String(data.side || "buy") === "sell" ? "sell" : "buy",
    wallet: campaignKey(chainId, data.wallet || ""),
    recipient: data.recipient ? campaignKey(chainId, data.recipient) : null,
    tokenAmountRaw: String(data.tokenAmountRaw || "0"),
    nativeAmountRaw: String(data.nativeAmountRaw || "0"),
    priceBnb: data.priceBnb == null ? null : String(data.priceBnb),
    txHash,
    logIndex: Number(data.logIndex || 0),
    blockNumber,
    blockTime: String(data.blockTime || new Date().toISOString()),
    status: String(data.status || "confirmed"),
  };
}

export function useUnifiedMarket(input: { campaignAddress?: string; chainId: number; resolution?: MarketResolution; enabled?: boolean }) {
  const campaignAddress = campaignKey(input.chainId, input.campaignAddress || "");
  const resolution = input.resolution ?? "1m";
  const enabled = (input.enabled ?? true) && isCampaignAddress(input.chainId, campaignAddress);
  const apiEnabled = enabled;
  const [state, setState] = useState<MarketState | null>(null);
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [graduationMarker, setGraduationMarker] = useState<any | null>(null);
  const [serverTime, setServerTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousStageRef = useRef<string | null>(null);
  const [stageTransition, setStageTransition] = useState<{ from: string | null; to: string; at: number } | null>(null);

  const realtime = useAblyTokenChannel({ enabled: apiEnabled, chainId: input.chainId, campaignAddress });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!apiEnabled) { setLoading(false); return; }
    const requestId = ++requestRef.current;
    try {
      const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
        return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
      };
      const emptyTrades = { items: [] as MarketTrade[], nextCursor: null as string | null };
      const emptyCandles = { items: [] as MarketCandle[], graduationMarker: null, marketStage: "BONDING" as const, serverTime: null as string | null };
      const [nextState, nextSummary, nextTrades, nextCandles] = await Promise.all([
        withTimeout(fetchMarketState(campaignAddress, input.chainId, signal).catch(() => null), 4_000, null),
        withTimeout(fetchMarketSummary(campaignAddress, input.chainId, signal).catch(() => null), 4_000, null),
        withTimeout(fetchMarketTrades(campaignAddress, input.chainId, { limit: 500, signal }).catch(() => emptyTrades), 4_000, emptyTrades),
        withTimeout(fetchMarketCandles(campaignAddress, input.chainId, resolution, { limit: 5000, signal }).catch(() => emptyCandles), 4_000, emptyCandles),
      ]);
      if (requestId !== requestRef.current || signal?.aborted) return;
      if (!nextState && !nextSummary) {
        setTrades((current) => mergeTrades(current, nextTrades?.items || [], input.chainId));
        setCandles((current) => applyRestCandles(current, nextCandles?.items || []));
        setGraduationMarker(nextCandles?.graduationMarker || null);
        setServerTime(nextCandles?.serverTime || null);
        setState((prev) => prev || {
          chainId: input.chainId, campaignAddress, tokenAddress: campaignAddress, factoryAddress: null, campaignGeneration: null,
          marketStage: "BONDING", graduation: null, pairAddress: null, routerAddress: null, dexFactoryAddress: null,
          wrappedNativeAddress: null, stable: null, feeBps: null, poolVerified: false, supportEnabled: true, bondingActive: true,
          tradingEnabled: true,
          indexingStatus: { enabled: true, poolEnabled: false, lastIndexedBlock: null, lastFinalizedBlock: null, lastSwapAt: null, lastSyncAt: null, dataLagSeconds: null },
          reserves: { tokenRaw: null, nativeRaw: null }, lastVerifiedAt: null, lastError: null,
        });
        setError(null); setLoading(false); return;
      }
      const previousStage = previousStageRef.current;
      const stage = nextState?.marketStage || nextSummary?.marketStage || previousStage;
      if (previousStage && stage && previousStage !== stage) setStageTransition({ from: previousStage, to: stage, at: Date.now() });
      if (stage) previousStageRef.current = stage;
      if (nextState) setState(nextState);
      if (nextSummary) setSummary(nextSummary);
      setTrades((current) => mergeTrades(current, nextTrades?.items || [], input.chainId));
      setCandles((current) => applyRestCandles(current, nextCandles?.items || []));
      setGraduationMarker(nextCandles?.graduationMarker || null);
      setServerTime(nextCandles?.serverTime || null);
      setError(null);
    } catch (caught: any) {
      if (caught?.name === "AbortError" || signal?.aborted || requestId !== requestRef.current) return;
      setError(null);
    } finally {
      if (requestId === requestRef.current && !signal?.aborted) setLoading(false);
    }
  }, [apiEnabled, campaignAddress, input.chainId, resolution]);

  const scheduleRefresh = useCallback((delay = 120) => {
    if (!apiEnabled) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; void refresh(); }, delay);
  }, [apiEnabled, refresh]);

  useEffect(() => {
    if (!apiEnabled) {
      setState(null); setSummary(null); setTrades([]); setCandles([]); setGraduationMarker(null); setServerTime(null); setLoading(false); setError(null); previousStageRef.current = null;
      return;
    }
    const controller = new AbortController();
    setTrades([]); setCandles([]); setLoading(true); void refresh(controller.signal);
    return () => controller.abort();
  }, [apiEnabled, refresh]);

  useEffect(() => {
    const channel = realtime.channel;
    if (!apiEnabled || !channel) return;
    const revealLiveTradeFallback = () => scheduleRefresh(2_500);
    const onStage = (message: any) => {
      const data = message?.data || {};
      const nextStage = String(data.marketStage || data.to || "");
      if (nextStage) {
        const previousStage = previousStageRef.current;
        if (previousStage !== nextStage) { setStageTransition({ from: previousStage, to: nextStage, at: Date.now() }); previousStageRef.current = nextStage; }
        setState((current) => current ? { ...current, marketStage: nextStage as any } : current);
      }
      scheduleRefresh(50);
    };
    const onTrade = (message: any) => { const trade = realtimeTrade(message?.data, input.chainId); if (trade) setTrades((current) => mergeTrades(current, [trade], input.chainId)); revealLiveTradeFallback(); };
    const onLegacyTrade = () => revealLiveTradeFallback();
    const onCandle = (message: any) => {
      const candle = realtimeCandle(message?.data, resolution);
      if (!candle) { scheduleRefresh(80); return; }
      setCandles((current) => {
        if (!current.length) { scheduleRefresh(300); return current; }
        const incomingKey = candleKey(candle); const lastKey = candleKey(current[current.length - 1]);
        if (!Number.isFinite(incomingKey) || incomingKey <= 0 || incomingKey < lastKey) { scheduleRefresh(0); return current; }
        return mergeCandles(current, [candle]);
      });
    };
    const onStats = (message: any) => { const patch = message?.data || {}; setSummary((current) => current ? { ...current, ...patch } : current); };
    const onHealth = () => scheduleRefresh(100);
    channel.subscribe("trade", onLegacyTrade);
    channel.subscribe("market_stage_changed", onStage);
    channel.subscribe("market_trade", onTrade);
    channel.subscribe("market_candle_upsert", onCandle);
    channel.subscribe("market_stats_patch", onStats);
    channel.subscribe("market_health_changed", onHealth);
    const onConnected = () => scheduleRefresh(0);
    realtime.client?.connection?.on?.("connected", onConnected);
    return () => {
      try { channel.unsubscribe("trade", onLegacyTrade); } catch {}
      try { channel.unsubscribe("market_stage_changed", onStage); } catch {}
      try { channel.unsubscribe("market_trade", onTrade); } catch {}
      try { channel.unsubscribe("market_candle_upsert", onCandle); } catch {}
      try { channel.unsubscribe("market_stats_patch", onStats); } catch {}
      try { channel.unsubscribe("market_health_changed", onHealth); } catch {}
      try { realtime.client?.connection?.off?.("connected", onConnected); } catch {}
    };
  }, [apiEnabled, input.chainId, realtime.channel, realtime.client, resolution, scheduleRefresh]);

  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  const topazActive = state?.marketStage === "TOPAZ_ACTIVE";
  const dexActive = state?.marketStage === "DEX_ACTIVE";
  const postGradActive = topazActive || dexActive;
  const degraded = state?.marketStage === "TOPAZ_DEGRADED" || state?.marketStage === "DEX_DEGRADED" || Boolean(error);
  const dataLagSeconds = state?.indexingStatus?.dataLagSeconds ?? summary?.dataLagSeconds ?? null;

  return useMemo(() => ({
    enabled, state, summary, trades, candles, graduationMarker, serverTime, stageTransition,
    topazActive, dexActive, postGradActive, degraded, dataLagSeconds, loading, error, refresh,
  }), [enabled,state,summary,trades,candles,graduationMarker,serverTime,stageTransition,topazActive,dexActive,postGradActive,degraded,dataLagSeconds,loading,error,refresh]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { ethers } from "ethers";
import type { CurveTradePoint } from "@/hooks/useCurveTrades";
import type { MarketCandle, MarketState } from "@/lib/marketContinuityApi";
import { buildCandles, type CurveTradePoint as ChartPoint } from "@/lib/chart/buildCandles";
import { fetchUserProfile } from "@/lib/profileApi";
import { resolveImageUri } from "@/lib/media";
import { getDefaultChainId, isSolanaChainId } from "@/lib/chainConfig";
import {
  solanaMarginalSpotSol,
  type SolanaCurvePricingState,
} from "@/lib/solanaCampaignRead";
import { isSyntheticLogIndex, isValidTradeTxHash } from "@/lib/tradeDedupe";
import { timestampSec } from "@/lib/chart/normalizeTrade";
import {
  assembleMarketCapCandles,
  marketCandlesForChart,
  patchActiveLatestBucket,
  shouldEstablishChartRange,
} from "@/lib/chart/canonicalChartCandles";

export type UnifiedChartResolution = "1s" | "5s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type UnifiedChartMetric = "marketcap" | "price";
export type UnifiedChartDenomination = "USD" | "BNB";

const TIMEFRAMES: Array<{ key: UnifiedChartResolution; seconds: number }> = [
  { key: "1s", seconds: 1 },
  { key: "5s", seconds: 5 },
  { key: "1m", seconds: 60 },
  { key: "5m", seconds: 300 },
  { key: "15m", seconds: 900 },
  { key: "30m", seconds: 1800 },
  { key: "1h", seconds: 3600 },
  { key: "4h", seconds: 14400 },
  { key: "1d", seconds: 86400 },
];

const DESIRED_BAR_PX = 12;
const MIN_BAR_SPACING = 3;
const MIN_VISIBLE_SLOTS = 28;
const MAX_VISIBLE_SLOTS = 320;

export type UnifiedMarketChartProps = {
  curvePoints: CurveTradePoint[];
  marketCandles: MarketCandle[];
  marketState: MarketState | null;
  graduationMarker?: {
    time: string;
    txHash?: string | null;
    finalCurvePriceBnb?: string | null;
    initialDexPriceBnb?: string | null;
    pairAddress?: string | null;
  } | null;
  creatorAddress?: string | null;
  creatorAvatarUrl?: string | null;
  creatorDisplayName?: string | null;
  chainId?: number;
  currentBondingSoldRaw?: bigint | null;
  solanaCurvePricing?: SolanaCurvePricingState | null;
  solanaGraduated?: boolean;
  livePriceNative?: number | null;
  liveSupplyWhole?: number | null;
  /** Header current mcap in native units. Chart live close must use this, not a second formula. */
  liveMcapNative?: number | null;
  nativeUsdPrice?: number | null;
  resolution: UnifiedChartResolution;
  onResolutionChange: (resolution: UnifiedChartResolution) => void;
  denomination?: UnifiedChartDenomination;
  loading?: boolean;
  error?: string | null;
  /** True after the first durable candle snapshot has arrived. Do not fit before this. */
  historyReady?: boolean;
  marketKey?: string;
  serverTime?: string | null;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

type CreatorTradePin = {
  id: string;
  timeSec: number;
  value: number;
  side: "buy" | "sell";
  tokensWei: bigint;
  nativeWei: bigint;
  priceNative: number;
  mcapUsd: number | null;
  txHash: string;
  timestamp: number;
};

type PlacedCreatorPin = CreatorTradePin & {
  x: number;
  y: number;
  stackIndex: number;
  stackCount: number;
};

type CandleRow = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatUnitsNumber(value: bigint | null | undefined, decimals: number): number {
  try {
    const parsed = Number(ethers.formatUnits(value ?? 0n, decimals));
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function postBurnSupply(state: MarketState | null, tokenDecimals: number): number {
  try {
    const raw = state?.graduation?.postBurnTotalSupplyRaw;
    if (!raw || !/^\d+$/.test(raw)) return 0;
    const parsed = Number(ethers.formatUnits(raw, tokenDecimals));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function isGraduatedStage(state: MarketState | null): boolean {
  const stage = String(state?.marketStage || "").toUpperCase();
  return stage === "TOPAZ_ACTIVE" || stage === "TOPAZ_DEGRADED" || stage === "TOPAZ_PENDING" || stage === "GRADUATING";
}

function normalizedWallet(chainId: number, value?: string | null) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

function validWallet(chainId: number, value?: string | null) {
  const raw = normalizedWallet(chainId, value);
  return isSolanaChainId(chainId)
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)
    : /^0x[a-f0-9]{40}$/.test(raw);
}

function sameAddr(chainId: number, a?: string | null, b?: string | null): boolean {
  const x = normalizedWallet(chainId, a);
  const y = normalizedWallet(chainId, b);
  return Boolean(x && y && x === y && validWallet(chainId, x));
}

function isSolanaDexPrint(trade: CurveTradePoint, graduated: boolean, graduationTimeSec: number): boolean {
  if (trade.venue === "dex") return true;
  if (trade.venue === "curve") return false;
  if (trade.soldTokensAfterRaw != null) return false;
  if (!graduated) return false;
  const ts = Number(trade.timestamp || 0);
  return graduationTimeSec > 0 && ts >= graduationTimeSec;
}

function authoritativeSolanaTradeState(
  trade: CurveTradePoint,
  pricing?: SolanaCurvePricingState | null,
): { priceNative: number; supplyWhole: number } | null {
  if (!pricing || trade.soldTokensAfterRaw == null) return null;
  const soldRaw = trade.soldTokensAfterRaw;
  if (soldRaw < 0n) return null;
  const priceNative = solanaMarginalSpotSol(pricing, soldRaw);
  const supplyWhole = formatUnitsNumber(soldRaw, pricing.tokenDecimals);
  if (!Number.isFinite(priceNative) || priceNative <= 0 || !Number.isFinite(supplyWhole) || supplyWhole < 0) return null;
  return { priceNative, supplyWhole };
}

function chainOrder(a: CurveTradePoint, b: CurveTradePoint): number {
  const aBlk = Number(a.blockNumber || 0);
  const bBlk = Number(b.blockNumber || 0);
  const aSyn = aBlk <= 0 || isSyntheticLogIndex(a.logIndex);
  const bSyn = bBlk <= 0 || isSyntheticLogIndex(b.logIndex);
  if (aSyn !== bSyn) return aSyn ? 1 : -1;
  if (!aSyn && aBlk !== bBlk) return aBlk - bBlk;
  const logCmp = Number(a.logIndex || 0) - Number(b.logIndex || 0);
  if (logCmp) return logCmp;
  return timestampSec(a.timestamp) - timestampSec(b.timestamp);
}

function tradeSeriesPoints(
  trades: CurveTradePoint[],
  metric: UnifiedChartMetric,
  denomination: UnifiedChartDenomination,
  nativeUsd: number,
  marketState: MarketState | null,
  graduationTimeSec: number,
  chainId: number,
  currentBondingSoldRaw?: bigint | null,
  solanaCurvePricing?: SolanaCurvePricingState | null,
  solanaGraduated?: boolean,
  liveSupplyWhole?: number | null,
): ChartPoint[] {
  const solana = isSolanaChainId(chainId);
  const tokenDecimals = solana ? Number(solanaCurvePricing?.tokenDecimals ?? 6) : 18;
  const nativeDecimals = solana ? 9 : 18;
  const sorted = [...(trades || [])].sort(chainOrder);
  const fixedGradSupply = postBurnSupply(marketState, tokenDecimals);
  const marketAlreadyGraduated = isGraduatedStage(marketState) || Boolean(solana && solanaGraduated);
  void liveSupplyWhole;
  void currentBondingSoldRaw;
  let circulating = 0;
  let peakCirc = 0;
  const points: ChartPoint[] = [];

  for (const trade of sorted) {
    const reportedTimeSec = timestampSec(trade.timestamp);
    const dexPrint = solana && isSolanaDexPrint(trade, Boolean(solanaGraduated), graduationTimeSec);
    const authoritative = solana && !dexPrint ? authoritativeSolanaTradeState(trade, solanaCurvePricing) : null;
    const priceNative = authoritative?.priceNative ?? finite(trade.pricePerToken);
    if (!priceNative || reportedTimeSec <= 0) continue;

    const tokenAmount = formatUnitsNumber(trade.tokensWei, tokenDecimals);
    const afterGrad =
      dexPrint ||
      (graduationTimeSec > 0 && reportedTimeSec >= graduationTimeSec) ||
      (!solana && marketAlreadyGraduated && graduationTimeSec <= 0 && fixedGradSupply > 0);
    if (!afterGrad) {
      circulating += trade.type === "sell" ? -tokenAmount : tokenAmount;
      circulating = Math.max(0, circulating);
      peakCirc = Math.max(peakCirc, circulating);
    }

    const soldAfter = trade.soldTokensAfterRaw != null ? formatUnitsNumber(trade.soldTokensAfterRaw, tokenDecimals) : 0;
    // Never multiply a historical price by *current* live supply — that put
    // chart mcap at ATH while the headline used live spot × sold.
    const supplyForMcap = solana
      ? !dexPrint && authoritative && authoritative.supplyWhole > 0
        ? authoritative.supplyWhole
        : soldAfter > 0
          ? soldAfter
          : Math.max(circulating, 0)
      : soldAfter > 0
        ? soldAfter
        : afterGrad && fixedGradSupply > 0
          ? fixedGradSupply
          : afterGrad && peakCirc > 0
            ? peakCirc
            : Math.max(circulating, 0);

    const valueNative = metric === "marketcap" ? priceNative * Math.max(supplyForMcap, 1e-18) : priceNative;
    const value = denomination === "USD" ? valueNative * nativeUsd : valueNative;
    if (!Number.isFinite(value) || value <= 0) continue;
    const volumeNative = formatUnitsNumber(trade.nativeWei, nativeDecimals);
    points.push({
      ts: reportedTimeSec * 1000,
      value,
      volume: Number.isFinite(volumeNative) ? volumeNative : 0,
      side: trade.type === "sell" ? "sell" : "buy",
      wallet: normalizedWallet(chainId, trade.from),
    });
  }
  return points;
}

function timeToSec(time: Time): number {
  if (typeof time === "number") return time;
  if (time && typeof time === "object" && "year" in time) return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
  return 0;
}

function formatTickLabel(time: Time, intervalSec: number): string {
  const sec = timeToSec(time);
  if (!sec) return "";
  const date = new Date(sec * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  if (intervalSec <= 5) return `${hh}:${mm}:${ss}`;
  if (intervalSec <= 60) return `${hh}:${mm}`;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  if (intervalSec < 86400) return `${day} ${month} ${hh}:${mm}`;
  return `${day} ${month}`;
}

function formatCrosshairTime(time: Time): string {
  const sec = timeToSec(time);
  if (!sec) return "";
  return `${new Date(sec * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })} UTC`;
}

function toChartRows(rows: Array<{ time: number; open: number; high: number; low: number; close: number }>): CandleRow[] {
  return rows.map((row) => ({
    time: row.time as Time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));
}

function candlePolarity(row: CandleRow | undefined): number {
  if (!row) return 0;
  if (row.close > row.open) return 1;
  if (row.close < row.open) return -1;
  return 0;
}

function sameCandle(a: CandleRow | undefined, b: CandleRow | undefined): boolean {
  if (!a || !b) return false;
  return Number(a.time) === Number(b.time) && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

function canUpdateIncrementally(previous: CandleRow[], next: CandleRow[]): boolean {
  if (!previous.length || !next.length) return false;
  if (next.length === previous.length) {
    for (let i = 0; i < previous.length - 1; i += 1) if (!sameCandle(previous[i], next[i])) return false;
    return Number(previous[previous.length - 1].time) === Number(next[next.length - 1].time);
  }
  if (next.length === previous.length + 1) {
    for (let i = 0; i < previous.length; i += 1) if (!sameCandle(previous[i], next[i])) return false;
    return Number(next[next.length - 1].time) > Number(previous[previous.length - 1].time);
  }
  return false;
}

function trimFixed(value: number, decimals: number) {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatValue(value: number, metric: UnifiedChartMetric, denomination: UnifiedChartDenomination, nativeSymbol: string) {
  if (!Number.isFinite(value)) return "";
  const prefix = denomination === "USD" ? "$" : "";
  const suffix = denomination === "USD" ? "" : ` ${nativeSymbol}`;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${prefix}${(value / 1_000_000_000).toFixed(2)}B${suffix}`;
  if (abs >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(2)}M${suffix}`;
  if (abs >= 1_000) return `${prefix}${(value / 1_000).toFixed(2)}K${suffix}`;
  if (metric === "price" && abs > 0 && abs < 0.01) return `${prefix}${trimFixed(value, nativeSymbol === "SOL" ? 12 : 10)}${suffix}`;
  if (metric === "marketcap" && denomination === "USD") {
    if (abs >= 1) return `$${value.toFixed(2)}`;
    if (abs >= 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(6)}`;
  }
  if (metric === "marketcap" && abs > 0 && abs < 1) return `${trimFixed(value, nativeSymbol === "SOL" ? 6 : 5)}${suffix}`;
  return `${prefix}${value.toFixed(metric === "price" && abs < 1 ? 8 : 2)}${suffix}`;
}

function nearestCandleTime(data: CandleRow[], targetSec: number): Time | null {
  if (!data.length) return null;
  let best = data[0];
  let bestDist = Math.abs(Number(best.time) - targetSec);
  for (const row of data) {
    const distance = Math.abs(Number(row.time) - targetSec);
    if (distance < bestDist) { best = row; bestDist = distance; }
  }
  return best.time;
}

function shortenAddr(addr: string) {
  const value = String(addr || "");
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatTokenAmt(raw: bigint, decimals: number): string {
  const n = formatUnitsNumber(raw, decimals);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return trimFixed(n, 6) || "0";
}

function formatNativeAmt(raw: bigint, decimals: number, symbol: string): string {
  const n = formatUnitsNumber(raw, decimals);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1) return `${n.toFixed(3)} ${symbol}`;
  if (n >= 0.001) return `${n.toFixed(4)} ${symbol}`;
  return `${trimFixed(n, symbol === "SOL" ? 9 : 8)} ${symbol}`;
}

function explorerTxUrl(chainId: number, txHash: string): string {
  if (isSolanaChainId(chainId)) {
    const cluster = Number(chainId) === 102 ? "?cluster=devnet" : "";
    return `https://explorer.solana.com/tx/${encodeURIComponent(txHash)}${cluster}`;
  }
  const base = Number(chainId) === 56 ? "https://bscscan.com" : "https://testnet.bscscan.com";
  return `${base}/tx/${txHash}`;
}

export function UnifiedMarketChart({
  curvePoints,
  marketCandles,
  marketState,
  graduationMarker,
  creatorAddress,
  creatorAvatarUrl,
  creatorDisplayName,
  chainId = getDefaultChainId(),
  currentBondingSoldRaw,
  solanaCurvePricing,
  solanaGraduated = false,
  livePriceNative = null,
  liveSupplyWhole = null,
  liveMcapNative = null,
  nativeUsdPrice,
  resolution,
  onResolutionChange,
  denomination = "USD",
  loading,
  error,
  historyReady = true,
  marketKey = "default",
  serverTime = null,
  expanded,
  onExpandedChange,
}: UnifiedMarketChartProps) {
  const solana = isSolanaChainId(chainId);
  const nativeSymbol = solana ? "SOL" : "BNB";
  const tokenDecimals = solana ? Number(solanaCurvePricing?.tokenDecimals ?? 6) : 18;
  const nativeDecimals = solana ? 9 : 18;
  const [metric, setMetric] = useState<UnifiedChartMetric>("marketcap");
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [autoScaleEnabled, setAutoScaleEnabled] = useState(true);
  const [serverNowMs, setServerNowMs] = useState(Date.now());
  const serverOffsetRef = useRef(0);
  const isExpanded = expanded ?? internalExpanded;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markerPluginRef = useRef<ReturnType<typeof createSeriesMarkers> | null>(null);
  const previousDataRef = useRef<CandleRow[]>([]);
  const initialRangeSetRef = useRef(false);
  const userInteractedRef = useRef(false);
  const programmaticRangeRef = useRef(false);
  const creatorPinsRef = useRef<CreatorTradePin[]>([]);
  const [placedPins, setPlacedPins] = useState<PlacedCreatorPin[]>([]);
  const [hoverPinId, setHoverPinId] = useState<string | null>(null);
  const [resolvedAvatar, setResolvedAvatar] = useState<string | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const hideTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeUsd = nativeUsdPrice != null && Number.isFinite(Number(nativeUsdPrice)) && Number(nativeUsdPrice) > 0 ? Number(nativeUsdPrice) : 0;
  const intervalSeconds = TIMEFRAMES.find((item) => item.key === resolution)?.seconds ?? 60;
  const desiredBarPx = intervalSeconds <= 1 ? 5 : intervalSeconds <= 5 ? 8 : DESIRED_BAR_PX;

  const clearHideTooltipTimer = useCallback(() => {
    if (hideTooltipTimerRef.current) { clearTimeout(hideTooltipTimerRef.current); hideTooltipTimerRef.current = null; }
  }, []);
  const openCreatorTooltip = useCallback((pinId: string) => { clearHideTooltipTimer(); setHoverPinId(pinId); }, [clearHideTooltipTimer]);
  const scheduleHideCreatorTooltip = useCallback(() => {
    clearHideTooltipTimer();
    hideTooltipTimerRef.current = setTimeout(() => { setHoverPinId(null); hideTooltipTimerRef.current = null; }, 1000);
  }, [clearHideTooltipTimer]);
  useEffect(() => () => clearHideTooltipTimer(), [clearHideTooltipTimer]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(`mwz:chart-expanded:${marketKey}`);
      if (expanded == null && stored != null) setInternalExpanded(stored === "1");
    } catch { /* storage unavailable */ }
  }, [expanded, marketKey]);

  useEffect(() => {
    const parsed = Date.parse(String(serverTime || ""));
    if (Number.isFinite(parsed) && parsed > 0) serverOffsetRef.current = parsed - Date.now();
    const tick = () => setServerNowMs(Date.now() + serverOffsetRef.current);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [serverTime]);

  const toggleExpanded = useCallback(() => {
    const next = !isExpanded;
    if (expanded == null) setInternalExpanded(next);
    onExpandedChange?.(next);
    try { window.localStorage.setItem(`mwz:chart-expanded:${marketKey}`, next ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [expanded, isExpanded, marketKey, onExpandedChange]);

  useEffect(() => {
    if (!hoverPinId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const root = overlayRef.current;
      if (root && root.contains(target)) return;
      setHoverPinId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [clearHideTooltipTimer, hoverPinId]);

  const graduationTimeSec = useMemo(() => {
    if (graduationMarker?.time) {
      const ms = new Date(graduationMarker.time).getTime();
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
    if (!solanaGraduated) return 0;
    const dexTimes = (curvePoints || []).filter((trade) => trade.venue === "dex").map((trade) => Number(trade.timestamp || 0)).filter((ts) => Number.isFinite(ts) && ts > 0);
    if (dexTimes.length) return Math.min(...dexTimes);
    const lastCurve = (curvePoints || []).filter((trade) => trade.soldTokensAfterRaw != null && !String(trade.txHash || "").startsWith("solana-seed-")).map((trade) => Number(trade.timestamp || 0)).filter((ts) => Number.isFinite(ts) && ts > 0);
    return lastCurve.length ? Math.max(...lastCurve) + 1 : 0;
  }, [curvePoints, graduationMarker?.time, solanaGraduated]);

  const seriesPoints = useMemo(() => {
    const usdRate = nativeUsd > 0 ? nativeUsd : 0;
    const chartDenomination = denomination === "USD" && usdRate <= 0 ? "BNB" : denomination;
    const chartUsd = usdRate > 0 ? usdRate : 1;
    return tradeSeriesPoints(curvePoints, metric, chartDenomination, chartUsd, marketState, graduationTimeSec, chainId, currentBondingSoldRaw, solanaCurvePricing, solanaGraduated, liveSupplyWhole);
  }, [chainId, currentBondingSoldRaw, solanaCurvePricing, solanaGraduated, liveSupplyWhole, curvePoints, denomination, graduationTimeSec, marketState, metric, nativeUsd]);

  const waitingForUsd = denomination === "USD" && nativeUsd <= 0;

  const data = useMemo(() => {
    if (!historyReady || waitingForUsd) return [] as CandleRow[];

    const livePrice = Number(livePriceNative);
    const liveSupply = Number(liveSupplyWhole);
    const headerMcap = Number(liveMcapNative);
    const canLiveMcap =
      Number.isFinite(livePrice) &&
      livePrice > 0 &&
      Number.isFinite(liveSupply) &&
      liveSupply >= 0;
    // Prefer the same native mcap the Token Details header already computed.
    // Bonding: spot × sold. Graduated Solana: Meteora spot × sold. Do not patch
    // graduated BNB with curve sold × DEX price — that is a different market.
    const overlayMcapNative = Number.isFinite(headerMcap) && headerMcap > 0
      ? headerMcap
      : !canLiveMcap
        ? null
        : solana || !isGraduatedStage(marketState)
          ? livePrice * liveSupply
          : null;

    const tradeFallback = buildCandles(seriesPoints, intervalSeconds, {
      extendToNow: false,
      maxGapFillBuckets: 0,
      genesisFromZero: metric === "marketcap",
    }).candles.map((row) => ({
      time: Number(row.time),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }));

    if (metric === "marketcap") {
      return toChartRows(
        assembleMarketCapCandles({
          marketCandles,
          denomination,
          nativeUsd,
          historyReady,
          liveMcapNative: overlayMcapNative,
          intervalSeconds,
          fallbackRows: tradeFallback,
        }),
      );
    }

    const fromServer = toChartRows(marketCandlesForChart(marketCandles, metric, denomination, nativeUsd));
    const fromTrades = toChartRows(tradeFallback);
    const authoritative = fromServer.length ? fromServer : fromTrades;
    const canPatchLivePrice =
      Number.isFinite(livePrice) && livePrice > 0 && (denomination !== "USD" || nativeUsd > 0);
    if (!canPatchLivePrice) return authoritative;
    const liveValue = denomination === "USD" && nativeUsd > 0 ? livePrice * nativeUsd : livePrice;
    return toChartRows(
      patchActiveLatestBucket(
        authoritative.map((row) => ({
          time: timeToSec(row.time),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
        })),
        liveValue,
        intervalSeconds,
        Math.floor(Date.now() / 1000),
      ),
    );
  }, [
    denomination,
    historyReady,
    intervalSeconds,
    liveMcapNative,
    livePriceNative,
    liveSupplyWhole,
    marketCandles,
    marketState,
    metric,
    nativeUsd,
    seriesPoints,
    solana,
    waitingForUsd,
  ]);

  const graduationMarkers = useMemo((): SeriesMarker<Time>[] => {
    if (!data.length || graduationTimeSec <= 0) return [];
    const time = nearestCandleTime(data, graduationTimeSec);
    if (time == null) return [];
    return [{ time, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", text: "Graduated" }];
  }, [data, graduationTimeSec]);

  const creatorPins = useMemo((): CreatorTradePin[] => {
    const creator = normalizedWallet(chainId, creatorAddress);
    if (!validWallet(chainId, creator) || !data.length) return [];
    const fixedGradSupply = postBurnSupply(marketState, tokenDecimals);
    const marketGrad = isGraduatedStage(marketState);
    const frozenLiveSupply = Number.isFinite(Number(liveSupplyWhole)) && Number(liveSupplyWhole) > 0 ? Number(liveSupplyWhole) : 0;
    let circulating = 0;
    let peakCirc = 0;
    const pins: CreatorTradePin[] = [];
    const sorted = [...(curvePoints || [])].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || (a.blockNumber ?? 0) - (b.blockNumber ?? 0) || Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0));

    for (const trade of sorted) {
      const dexPrint = solana && isSolanaDexPrint(trade, solanaGraduated, graduationTimeSec);
      const authoritative = solana && !dexPrint ? authoritativeSolanaTradeState(trade, solanaCurvePricing) : null;
      const priceNative = authoritative?.priceNative ?? finite(trade.pricePerToken);
      const ts = timestampSec(trade.timestamp);
      if (!priceNative || ts <= 0) continue;
      const tokenAmount = formatUnitsNumber(trade.tokensWei, tokenDecimals);
      const afterGrad = dexPrint || (graduationTimeSec > 0 && ts >= graduationTimeSec) || (!solana && marketGrad && graduationTimeSec <= 0 && fixedGradSupply > 0);
      if (!afterGrad) {
        circulating += trade.type === "sell" ? -tokenAmount : tokenAmount;
        circulating = Math.max(0, circulating);
        peakCirc = Math.max(peakCirc, circulating);
      }
      const soldAfter = trade.soldTokensAfterRaw != null ? formatUnitsNumber(trade.soldTokensAfterRaw, tokenDecimals) : 0;
      const supplyForMcap = afterGrad && solana && frozenLiveSupply > 0 ? frozenLiveSupply : !afterGrad && authoritative ? authoritative.supplyWhole : soldAfter > 0 ? soldAfter : afterGrad && fixedGradSupply > 0 ? fixedGradSupply : frozenLiveSupply > 0 ? frozenLiveSupply : afterGrad && peakCirc > 0 ? peakCirc : Math.max(circulating, 0);
      if (!sameAddr(chainId, trade.from, creator)) continue;
      const valueNative = metric === "marketcap" ? priceNative * Math.max(supplyForMcap, 1e-18) : priceNative;
      const value = denomination === "USD" ? valueNative * (nativeUsd || 1) : valueNative;
      if (!Number.isFinite(value) || value <= 0) continue;
      const candleTime = nearestCandleTime(data, ts);
      const timeSec = candleTime != null ? Number(candleTime) : ts;
      const side = trade.type === "sell" ? "sell" : "buy";
      const txHash = String(trade.txHash || "").trim();
      const mcapUsd = priceNative * Math.max(supplyForMcap, 0) * (nativeUsd || 0);
      pins.push({ id: `${txHash || timeSec}:${side}:${trade.logIndex ?? 0}`, timeSec, value, side, tokensWei: trade.tokensWei ?? 0n, nativeWei: trade.nativeWei ?? 0n, priceNative, mcapUsd: Number.isFinite(mcapUsd) && mcapUsd > 0 ? mcapUsd : null, txHash, timestamp: ts });
    }
    return pins.slice(-24);
  }, [chainId, creatorAddress, curvePoints, data, denomination, graduationTimeSec, liveSupplyWhole, marketState, metric, nativeUsd, solana, solanaCurvePricing, solanaGraduated, tokenDecimals]);

  creatorPinsRef.current = creatorPins;

  useEffect(() => {
    const fromProp = resolveImageUri(creatorAvatarUrl || "") || null;
    if (fromProp) { setResolvedAvatar(fromProp); setResolvedName(creatorDisplayName?.trim() || null); return; }
    const addr = normalizedWallet(chainId, creatorAddress);
    if (!addr) { setResolvedAvatar(null); setResolvedName(null); return; }
    let cancelled = false;
    void fetchUserProfile(Number(chainId || getDefaultChainId()), addr)
      .then((profile) => { if (!cancelled) { setResolvedAvatar(resolveImageUri(profile?.avatarUrl || "") || null); setResolvedName(profile?.displayName?.trim() || creatorDisplayName?.trim() || null); } })
      .catch(() => { if (!cancelled) { setResolvedAvatar(null); setResolvedName(creatorDisplayName?.trim() || null); } });
    return () => { cancelled = true; };
  }, [chainId, creatorAddress, creatorAvatarUrl, creatorDisplayName]);

  const repositionCreatorPins = useCallback(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) { setPlacedPins([]); return; }
    const raw: Array<CreatorTradePin & { x: number; y: number }> = [];
    for (const pin of creatorPinsRef.current) {
      const x = chart.timeScale().timeToCoordinate(pin.timeSec as Time);
      const y = series.priceToCoordinate(pin.value);
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      raw.push({ ...pin, x, y });
    }
    const groups: Array<Array<(typeof raw)[number]>> = [];
    raw.sort((a, b) => a.x - b.x || a.timestamp - b.timestamp);
    for (const pin of raw) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(last[0].x - pin.x) <= 12) last.push(pin); else groups.push([pin]);
    }
    const liftPx = 44;
    const next: PlacedCreatorPin[] = [];
    const overlayWidth = overlayRef.current?.clientWidth || 0;
    for (const group of groups) {
      group.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      const stackCount = group.length;
      const anchorY = Math.min(...group.map((pin) => pin.y));
      const anchorX = group.reduce((sum, pin) => sum + pin.x, 0) / stackCount;
      const safeX = overlayWidth > 0 ? Math.min(Math.max(anchorX, 18), overlayWidth - 18) : anchorX;
      group.forEach((pin, stackIndex) => next.push({
        ...pin,
        x: safeX,
        y: Math.max(30, anchorY - liftPx - stackIndex * 30),
        stackIndex,
        stackCount,
      }));
    }
    setPlacedPins(next);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const chart = createChart(element, {
      width: Math.max(10, rect.width || element.clientWidth || 10),
      height: Math.max(140, rect.height || element.clientHeight || 260),
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "rgba(255,255,255,0.75)" },
      grid: { vertLines: { visible: false }, horzLines: { visible: true, color: "rgba(255,255,255,0.06)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { visible: true, autoScale: true, borderVisible: true, borderColor: "rgba(255,255,255,0.18)", ticksVisible: true, minimumWidth: 88, scaleMargins: { top: 0.20, bottom: 0.12 } },
      timeScale: { borderVisible: true, borderColor: "rgba(255,255,255,0.12)", timeVisible: true, secondsVisible: intervalSeconds <= 60, rightOffset: 10, barSpacing: desiredBarPx, minBarSpacing: MIN_BAR_SPACING, lockVisibleTimeRangeOnResize: false },
      localization: { locale: typeof navigator !== "undefined" ? navigator.language : undefined, timeFormatter: (time: Time) => formatCrosshairTime(time), tickMarkFormatter: (time: Time) => formatTickLabel(time, intervalSeconds) },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: true,
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "custom", minMove: metric === "price" ? (solana ? 0.000000000001 : 0.00000001) : 0.01, formatter: (value: number) => formatValue(value, metric, denomination, nativeSymbol) },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markerPluginRef.current = createSeriesMarkers(series, []);
    const onVisible = () => {
      if (initialRangeSetRef.current && !programmaticRangeRef.current) userInteractedRef.current = true;
      repositionCreatorPins();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisible);
    chart.timeScale().subscribeVisibleTimeRangeChange(onVisible);
    const observer = new ResizeObserver(() => {
      const target = containerRef.current;
      if (!target || !chartRef.current) return;
      const bounds = target.getBoundingClientRect();
      chartRef.current.applyOptions({ width: Math.max(10, bounds.width || target.clientWidth || 10), height: Math.max(140, bounds.height || target.clientHeight || 260) });
      repositionCreatorPins();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisible); chart.timeScale().unsubscribeVisibleTimeRangeChange(onVisible); } catch { /* ignore */ }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markerPluginRef.current = null;
      previousDataRef.current = [];
      initialRangeSetRef.current = false;
      userInteractedRef.current = false;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { secondsVisible: intervalSeconds <= 60, barSpacing: desiredBarPx, minBarSpacing: MIN_BAR_SPACING },
      localization: { locale: typeof navigator !== "undefined" ? navigator.language : undefined, timeFormatter: (time: Time) => formatCrosshairTime(time), tickMarkFormatter: (time: Time) => formatTickLabel(time, intervalSeconds) },
    });
  }, [desiredBarPx, intervalSeconds]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: !autoScaleEnabled } },
    });
    try {
      chart.priceScale("right").applyOptions({ autoScale: autoScaleEnabled, scaleMargins: { top: 0.20, bottom: 0.12 } });
    } catch { /* chart may be disposing */ }
  }, [autoScaleEnabled]);

  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: {
        type: "custom",
        minMove: metric === "price" ? (solana ? 0.000000000001 : 0.00000001) : denomination === "USD" ? 0.01 : solana ? 0.000001 : 0.00001,
        formatter: (value: number) => formatValue(value, metric, denomination, nativeSymbol),
      },
    });
  }, [denomination, metric, nativeSymbol, solana]);

  useEffect(() => {
    initialRangeSetRef.current = false;
    userInteractedRef.current = false;
    previousDataRef.current = [];
  }, [intervalSeconds, marketKey, metric, denomination]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const previous = previousDataRef.current;
    const visibleBefore = initialRangeSetRef.current ? chart.timeScale().getVisibleLogicalRange() : null;
    const wasFollowingRealtime = !visibleBefore || !previous.length || visibleBefore.to >= previous.length - 2;
    const appendedBar = previous.length > 0 && data.length === previous.length + 1 && Number(data[data.length - 1]?.time || 0) > Number(previous[previous.length - 1]?.time || 0);
    const polarityFlipped = candlePolarity(previous[previous.length - 1]) !== candlePolarity(data[data.length - 1]);
    const incremental = canUpdateIncrementally(previous, data) && !polarityFlipped;
    const rangePlan = shouldEstablishChartRange({
      historyReady,
      candleCount: data.length,
      initialHistoryFitted: initialRangeSetRef.current,
      userInteracted: userInteractedRef.current,
      previousCandleCount: previous.length,
      previousFirstTime: previous.length ? timeToSec(previous[0].time) : null,
      nextFirstTime: data.length ? timeToSec(data[0].time) : null,
    });

    if (!historyReady || data.length === 0) {
      if (previous.length) {
        try { series.setData([]); } catch { /* keep last painted snapshot */ }
      }
      previousDataRef.current = data;
      initialRangeSetRef.current = false;
      setPlacedPins([]);
      return;
    }

    try {
      if (incremental && !rangePlan.fit) {
        series.update(data[data.length - 1] as any);
      } else {
        series.setData(data as any);
        if (initialRangeSetRef.current && visibleBefore && !rangePlan.fit) {
          programmaticRangeRef.current = true;
          try { chart.timeScale().setVisibleLogicalRange(visibleBefore); } catch { /* invalidated by snapshot/timeframe */ }
          requestAnimationFrame(() => { programmaticRangeRef.current = false; });
        }
      }
    } catch {
      try { series.setData(data as any); } catch { /* keep last painted snapshot */ }
    }
    previousDataRef.current = data;

    // Hard launch invariant: while Auto is enabled, every incoming candle body + wick
    // must remain inside the visible price scale. Reassert autoscale on every canonical
    // update so a sudden buy/sell cannot shoot outside the chart.
    if (autoScaleEnabled && data.length > 0) {
      try { chart.priceScale("right").applyOptions({ autoScale: true, scaleMargins: { top: 0.20, bottom: 0.12 } }); } catch { /* ignore */ }
    }

    if (rangePlan.fit) {
      const width = containerRef.current?.getBoundingClientRect().width || 800;
      const slotsThatFit = Math.max(MIN_VISIBLE_SLOTS, Math.min(MAX_VISIBLE_SLOTS, Math.floor(width / desiredBarPx)));
      programmaticRangeRef.current = true;
      chart.timeScale().applyOptions({ barSpacing: desiredBarPx, minBarSpacing: MIN_BAR_SPACING, rightOffset: 10 });
      chart.timeScale().setVisibleLogicalRange({ from: data.length - slotsThatFit, to: data.length + 6 });
      initialRangeSetRef.current = true;
      requestAnimationFrame(() => { programmaticRangeRef.current = false; });
    } else if (appendedBar && wasFollowingRealtime && !userInteractedRef.current) {
      programmaticRangeRef.current = true;
      try { chart.timeScale().scrollToRealTime(); } catch { /* ignore */ }
      requestAnimationFrame(() => { programmaticRangeRef.current = false; });
    }
    requestAnimationFrame(() => repositionCreatorPins());
  }, [autoScaleEnabled, data, desiredBarPx, historyReady, repositionCreatorPins]);

  useEffect(() => { markerPluginRef.current?.setMarkers(graduationMarkers); }, [graduationMarkers]);
  useEffect(() => { repositionCreatorPins(); }, [creatorPins, denomination, metric, repositionCreatorPins]);

  const hoverPin = hoverPinId ? placedPins.find((pin) => pin.id === hoverPinId) : null;
  const avatarSrc = resolvedAvatar || "/placeholder.svg";
  const displayName = resolvedName || shortenAddr(String(creatorAddress || ""));
  const hasData = data.length > 0;
  const showChartLoading = Boolean(loading) || !historyReady || waitingForUsd;
  const serverClock = new Date(serverNowMs).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const showTrailingRange = (seconds: number) => {
    const chart = chartRef.current;
    if (!chart || !data.length) return;
    const bars = Math.max(20, Math.min(data.length, Math.ceil(seconds / Math.max(1, intervalSeconds))));
    userInteractedRef.current = true;
    programmaticRangeRef.current = true;
    try { chart.timeScale().setVisibleLogicalRange({ from: data.length - bars - 1, to: data.length + 6 }); } catch { /* ignore */ }
    requestAnimationFrame(() => {
      programmaticRangeRef.current = false;
      repositionCreatorPins();
    });
  };

  const goLive = () => {
    userInteractedRef.current = true;
    programmaticRangeRef.current = true;
    try { chartRef.current?.timeScale().scrollToRealTime(); } catch { /* ignore */ }
    if (autoScaleEnabled) {
      try { chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); } catch { /* ignore */ }
    }
    requestAnimationFrame(() => {
      programmaticRangeRef.current = false;
      repositionCreatorPins();
    });
  };

  return (
    <div
      data-chart-expanded={isExpanded ? "true" : "false"}
      className={`relative flex w-full flex-col transition-[min-height] duration-200 ${isExpanded ? "min-h-[560px] md:min-h-[640px]" : "h-full min-h-0"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2 shrink-0">
        <div className="flex items-center gap-1 rounded-md border border-orange-400/25 bg-black/30 p-0.5">
          <button type="button" onClick={() => setMetric("marketcap")} className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${metric === "marketcap" ? "bg-orange-500/25 text-orange-300" : "text-muted-foreground hover:text-orange-200"}`}>Market Cap</button>
          <button type="button" onClick={() => setMetric("price")} className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${metric === "price" ? "bg-orange-500/25 text-orange-300" : "text-muted-foreground hover:text-orange-200"}`}>Price ({denomination === "USD" ? "USD" : nativeSymbol})</button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {creatorAddress ? <div className="hidden items-center gap-2 text-[9px] text-muted-foreground sm:flex"><span className="inline-flex items-center gap-1"><img src={avatarSrc} alt="" className="h-3.5 w-3.5 rounded-full border border-orange-400/80 object-cover" />Creator trades</span></div> : null}
          <div className="flex flex-wrap justify-end gap-1">
            {TIMEFRAMES.map((item) => <button type="button" key={item.key} onClick={() => onResolutionChange(item.key)} className={`rounded border px-2 py-1 text-[10px] font-semibold transition-colors ${resolution === item.key ? "border-orange-400/50 bg-orange-500/25 text-orange-300" : "border-border/60 text-muted-foreground hover:text-orange-200"}`}>{item.key}</button>)}
          </div>
          <button type="button" onClick={toggleExpanded} className="rounded border border-border/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:border-orange-400/40 hover:text-orange-200" title={isExpanded ? "Collapse chart" : "Expand chart"}>{isExpanded ? "Collapse" : "Expand"}</button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
          {placedPins.map((pin) => {
            const active = hoverPinId === pin.id;
            return (
              <button
                key={pin.id}
                type="button"
                title={`Creator ${pin.side}${pin.stackCount > 1 ? ` (${pin.stackIndex + 1}/${pin.stackCount} in this bar)` : ""}`}
                className={`pointer-events-auto absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-black/90 p-0 transition-transform hover:z-30 hover:scale-125 ${pin.side === "buy" ? "border-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.55)]" : "border-red-400 shadow-[0_0_14px_rgba(248,113,113,0.55)]"} ${active ? "z-30 scale-125" : ""}`}
                style={{ left: pin.x, top: pin.y, zIndex: 10 + pin.stackIndex }}
                onMouseEnter={() => openCreatorTooltip(pin.id)}
                onMouseLeave={scheduleHideCreatorTooltip}
                onFocus={() => openCreatorTooltip(pin.id)}
                onBlur={scheduleHideCreatorTooltip}
                onClick={(event) => { event.stopPropagation(); clearHideTooltipTimer(); setHoverPinId((current) => current === pin.id ? null : pin.id); }}
                aria-label={`Creator ${pin.side}`}
              >
                <span className="relative block h-full w-full">
                  <img src={avatarSrc} alt="" className="h-full w-full rounded-full object-cover" draggable={false} />
                  <span className={`absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-black px-0.5 text-[7px] font-black text-black ${pin.side === "buy" ? "bg-emerald-400" : "bg-red-400"}`}>{pin.side === "buy" ? "B" : "S"}</span>
                </span>
              </button>
            );
          })}

          {hoverPin ? (
            <div
              role="dialog"
              aria-label={`Creator ${hoverPin.side} details`}
              className="pointer-events-auto absolute z-30 w-[228px] rounded-xl border border-orange-400/45 bg-[#120a04]/97 p-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.6)] backdrop-blur-sm"
              style={{
      left:
        hoverPin.x + 16 + 228 <= (overlayRef.current?.clientWidth || 400) - 8
          ? hoverPin.x + 16
          : Math.max(8, hoverPin.x - 16 - 228),
      top: Math.max(
        8,
        Math.min(
          hoverPin.y - 24,
          Math.max(8, (overlayRef.current?.clientHeight || 320) - 210),
        ),
      ),
    }}
              onMouseEnter={() => openCreatorTooltip(hoverPin.id)}
              onMouseLeave={scheduleHideCreatorTooltip}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-300"><span className="h-1.5 w-1.5 rounded-full bg-orange-400" />Creator {hoverPin.side}</div>
              <div className="mb-2 flex items-center gap-2">
                <img src={avatarSrc} alt="" className="h-7 w-7 rounded-full border border-orange-400/40 object-cover" />
                <div className="min-w-0"><div className="truncate text-xs font-semibold text-white">{displayName}</div><div className="truncate text-[10px] text-orange-200/70">{hoverPin.side === "buy" ? "Bought" : "Sold"} by {shortenAddr(String(creatorAddress || ""))}</div></div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div className="rounded-lg border border-orange-400/15 bg-orange-500/[0.06] px-2 py-1.5"><div className="text-orange-200/55">{nativeSymbol} size</div><div className="font-semibold text-white">{formatNativeAmt(hoverPin.nativeWei, nativeDecimals, nativeSymbol)}</div></div>
                <div className="rounded-lg border border-orange-400/15 bg-orange-500/[0.06] px-2 py-1.5"><div className="text-orange-200/55">Token size</div><div className="font-semibold text-white">{formatTokenAmt(hoverPin.tokensWei, tokenDecimals)}</div></div>
                <div className="rounded-lg border border-orange-400/15 bg-orange-500/[0.06] px-2 py-1.5"><div className="text-orange-200/55">Market cap</div><div className="font-semibold text-white">{hoverPin.mcapUsd != null ? formatValue(hoverPin.mcapUsd, "marketcap", "USD", nativeSymbol) : "—"}</div></div>
                <div className="rounded-lg border border-orange-400/15 bg-orange-500/[0.06] px-2 py-1.5"><div className="text-orange-200/55">Price</div><div className="font-semibold text-white">{formatValue(denomination === "USD" ? hoverPin.priceNative * (nativeUsd || 1) : hoverPin.priceNative, "price", denomination, nativeSymbol)}</div></div>
              </div>
              {isValidTradeTxHash(hoverPin.txHash) ? <a href={explorerTxUrl(Number(chainId || getDefaultChainId()), hoverPin.txHash)} target="_blank" rel="noreferrer" className="mt-2 flex w-full items-center justify-center rounded-lg border border-orange-400/45 bg-orange-500/15 px-2 py-1.5 text-[10px] font-semibold text-orange-200 hover:bg-orange-500/25 hover:text-orange-100" onMouseEnter={() => openCreatorTooltip(hoverPin.id)} onClick={(event) => event.stopPropagation()}>View tx</a> : null}
            </div>
          ) : null}
        </div>

        {!hasData && <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">{showChartLoading ? "Loading market history…" : error ? error : "No trades in the loaded window yet. Buys/sells appear as continuous candles once history is recovered."}</div>}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 px-2 py-1.5 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          {[
            ["1D", 86400],
            ["5D", 5 * 86400],
            ["1M", 30 * 86400],
            ["3M", 90 * 86400],
            ["1Y", 365 * 86400],
          ].map(([label, seconds]) => (
            <button key={String(label)} type="button" onClick={() => showTrailingRange(Number(seconds))} className="rounded px-1.5 py-1 font-semibold text-muted-foreground hover:bg-white/5 hover:text-foreground">{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={goLive} className="rounded px-1.5 py-1 font-semibold text-muted-foreground hover:bg-white/5 hover:text-orange-200">LIVE</button>
          <span className="tabular-nums text-foreground/90" title={serverTime ? "Synchronized to MemeWarzone server UTC" : "UTC clock; server sync pending"}>{serverClock} UTC</span>
          <button type="button" onClick={() => setAutoScaleEnabled((current) => !current)} className={`rounded px-1.5 py-1 font-semibold ${autoScaleEnabled ? "text-emerald-300" : "text-muted-foreground hover:text-foreground"}`}>auto</button>
        </div>
      </div>
    </div>
  );
}

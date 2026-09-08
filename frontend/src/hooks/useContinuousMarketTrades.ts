import { useEffect, useMemo, useState } from "react";
import { Contract, ethers } from "ethers";
import { useCurveTrades, type CurveTradePoint } from "@/hooks/useCurveTrades";
import { useTopazMarket } from "@/hooks/useTopazMarket";
import { useUnifiedMarket, type MarketResolution } from "@/hooks/useUnifiedMarket";
import { campaignKey, isCampaignAddress, marketTradeToCurvePoint } from "@/lib/chart/normalizeTrade";
import { BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, isEvmChainId, isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { TOPAZ_FILL_EVENT, type TopazFillDetail } from "@/lib/recordTopazFill";
import { fetchTopazTradeReports } from "@/lib/topazTradeReports";
import { mergeTradePoints } from "@/lib/tradeDedupe";

const CAMPAIGN_GRAD_ABI = [
  "function launched() view returns (bool)",
  "function getGraduationState() view returns (address dexPair,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 graduatedLiquidityTokens,uint256 graduatedLiquidityBnb,uint256 graduatedLiquidityLp,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 postBurnTotalSupply,uint256 graduationBalance,uint256 graduationOvershoot)",
] as const;

function isBnbChain(chainId: number) {
  return chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID;
}

/**
 * Shared continuous trade stream for Token Details + War Room:
 * bonding indexer history + chain-specific post-grad indexers.
 * BNB keeps the browser Topaz fallback; Robinhood consumes indexed V3 trades only.
 */
export function useContinuousMarketTrades(input: {
  campaignAddress?: string;
  tokenAddress?: string;
  chainId: number;
  resolution?: MarketResolution;
  enabled?: boolean;
  /** When false, never enable browser Topaz pair scan. Default true on BNB only. */
  enableTopazScan?: boolean;
}) {
  const chainId = Number(input.chainId || 97);
  const campaignAddress = campaignKey(chainId, input.campaignAddress || "");
  const tokenAddress = campaignKey(chainId, input.tokenAddress || "");
  const enabled = (input.enabled ?? true) && isCampaignAddress(chainId, campaignAddress);
  const evm = isEvmChainId(chainId);
  const bnb = isBnbChain(chainId);
  const resolution = input.resolution ?? "1m";

  const { points: curvePoints, loading: curveLoading, error: curveError } = useCurveTrades(
    enabled ? campaignAddress : undefined,
    { chainId, enabled, tokenAddress: tokenAddress || undefined },
  );

  const [localTopazTrades, setLocalTopazTrades] = useState<CurveTradePoint[]>([]);
  const [onChainLaunched, setOnChainLaunched] = useState(false);
  const [onChainPair, setOnChainPair] = useState("");

  useEffect(() => {
    if (!enabled || !campaignAddress || !evm) {
      setOnChainLaunched(false);
      setOnChainPair("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const provider = getReadProvider(chainId as SupportedChainId);
        const c = new Contract(campaignAddress, CAMPAIGN_GRAD_ABI, provider) as any;
        const [launched, graduation] = await Promise.all([
          c.launched().catch(() => false),
          c.getGraduationState().catch(() => null),
        ]);
        if (cancelled) return;
        const pair = String(graduation?.[0] ?? graduation?.dexPair ?? "").toLowerCase();
        const pairOk = ethers.isAddress(pair) && pair !== ethers.ZeroAddress.toLowerCase();
        setOnChainLaunched(Boolean(launched) || pairOk);
        setOnChainPair(pairOk ? pair : "");
      } catch {
        if (!cancelled) {
          setOnChainLaunched(false);
          setOnChainPair("");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, campaignAddress, chainId, evm]);

  useEffect(() => {
    if (!enabled || !bnb) {
      setLocalTopazTrades([]);
      return;
    }
    setLocalTopazTrades([]);
    let cancelled = false;
    void (async () => {
      try {
        const remote = await fetchTopazTradeReports({ chainId, campaignAddress, limit: 100 });
        if (cancelled || !remote.length) return;
        setLocalTopazTrades((prev) => mergeTradePoints(prev, remote));
      } catch {
        // optional BNB-only compatibility source
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, bnb, campaignAddress, chainId]);

  const unifiedMarket = useUnifiedMarket({
    campaignAddress: enabled ? campaignAddress : undefined,
    chainId,
    resolution,
    enabled,
  });

  const stage = String(unifiedMarket.state?.marketStage || "").toUpperCase();
  const apiPair = String(unifiedMarket.state?.pairAddress || "").toLowerCase();
  const apiPairOk = /^0x[a-f0-9]{40}$/.test(apiPair) && apiPair !== ethers.ZeroAddress.toLowerCase();
  const graduatedFromApi =
    stage === "TOPAZ_ACTIVE" ||
    stage === "TOPAZ_DEGRADED" ||
    stage === "TOPAZ_PENDING" ||
    stage === "DEX_ACTIVE" ||
    stage === "DEX_DEGRADED" ||
    stage === "DEX_PENDING" ||
    stage === "GRADUATING";

  const isPostGrad = graduatedFromApi || onChainLaunched || apiPairOk || Boolean(onChainPair);

  // Topaz is a BNB fallback only. Robinhood post-grad is supplied by unified
  // robinhood_v3 trades/candles, so it must never query Topaz contracts.
  const topazScanEnabledResolved =
    enabled &&
    bnb &&
    input.enableTopazScan !== false &&
    (graduatedFromApi || onChainLaunched || apiPairOk || Boolean(onChainPair));

  const topazMarket = useTopazMarket({
    campaignAddress: enabled && bnb ? campaignAddress : undefined,
    tokenAddress: bnb ? tokenAddress || undefined : undefined,
    chainId,
    enabled: topazScanEnabledResolved,
    pollMs: 8_000,
  });

  useEffect(() => {
    if (!enabled || !bnb) return;
    const onFill = (event: Event) => {
      const detail = (event as CustomEvent<TopazFillDetail>).detail;
      if (!detail) return;
      if (Number(detail.chainId) !== chainId) return;
      if (campaignKey(chainId, detail.campaignAddress) !== campaignAddress) return;
      setLocalTopazTrades((prev) => mergeTradePoints(prev, [detail.point]));
      void topazMarket.refresh?.();
    };
    window.addEventListener(TOPAZ_FILL_EVENT, onFill as EventListener);
    return () => window.removeEventListener(TOPAZ_FILL_EVENT, onFill as EventListener);
  }, [enabled, bnb, campaignAddress, chainId, topazMarket]);

  const tradePoints = useMemo(() => {
    const curve = Array.isArray(curvePoints) ? curvePoints : [];
    const postGrad =
      isPostGrad ||
      (bnb && Boolean(topazMarket.pairAddress)) ||
      (bnb && Array.isArray(topazMarket.trades) && topazMarket.trades.length > 0) ||
      (bnb && localTopazTrades.length > 0);

    if (!postGrad) return mergeTradePoints(curve);

    const unifiedAsPoints: CurveTradePoint[] = (unifiedMarket.trades || [])
      .map((trade) => marketTradeToCurvePoint(trade, chainId))
      .filter((point): point is CurveTradePoint => Boolean(point));

    return mergeTradePoints(
      curve,
      bnb ? topazMarket.trades : [],
      bnb ? localTopazTrades : [],
      unifiedAsPoints,
    );
  }, [curvePoints, topazMarket.trades, topazMarket.pairAddress, localTopazTrades, unifiedMarket.trades, isPostGrad, chainId, bnb]);

  const stableTradePoints = tradePoints;
  const loading = stableTradePoints.length > 0 ? false : curveLoading || unifiedMarket.loading || (bnb && topazMarket.loading);
  const error = stableTradePoints.length > 0 ? null : curveError || unifiedMarket.error || (bnb ? topazMarket.error : null);

  return {
    campaignAddress: enabled ? campaignAddress : "",
    tradePoints: stableTradePoints,
    localTopazTrades,
    setLocalTopazTrades,
    curvePoints: Array.isArray(curvePoints) ? curvePoints : [],
    curveLoading,
    curveError,
    topazMarket,
    unifiedMarket,
    loading,
    error,
    onChainLaunched,
    onChainPair: onChainPair || null,
    isDexStage: isPostGrad || (bnb && Boolean(topazMarket.pairAddress)) || Boolean(unifiedMarket.state?.pairAddress),
  };
}

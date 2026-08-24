import { useEffect, useMemo, useState } from "react";
import { Contract, ethers } from "ethers";
import { useCurveTrades, type CurveTradePoint } from "@/hooks/useCurveTrades";
import { useTopazMarket } from "@/hooks/useTopazMarket";
import { useUnifiedMarket, type MarketResolution } from "@/hooks/useUnifiedMarket";
import { campaignKey, isCampaignAddress, marketTradeToCurvePoint } from "@/lib/chart/normalizeTrade";
import { isEvmChainId, isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { TOPAZ_FILL_EVENT, type TopazFillDetail } from "@/lib/recordTopazFill";
import { fetchTopazTradeReports } from "@/lib/topazTradeReports";
import { mergeTradePoints } from "@/lib/tradeDedupe";

const CAMPAIGN_GRAD_ABI = [
  "function launched() view returns (bool)",
  "function getGraduationState() view returns (address dexPair,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 graduatedLiquidityTokens,uint256 graduatedLiquidityBnb,uint256 graduatedLiquidityLp,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 postBurnTotalSupply,uint256 graduationBalance,uint256 graduationOvershoot)",
] as const;

/**
 * Shared continuous trade stream for Token Details + War Room:
 * bonding indexer history + Topaz on-chain scan + wallet reports + unified market API.
 *
 * Topaz scan enablement matches Token Details: use market API stage when available,
 * but also open on-chain launched/pair so CMS lag (stuck BONDING) does not blank War Room.
 */
export function useContinuousMarketTrades(input: {
  campaignAddress?: string;
  tokenAddress?: string;
  chainId: number;
  resolution?: MarketResolution;
  enabled?: boolean;
  /** When false, never enable browser Topaz pair scan. Default true. */
  enableTopazScan?: boolean;
}) {
  const chainId = Number(input.chainId || 97);
  const campaignAddress = campaignKey(chainId, input.campaignAddress || "");
  const tokenAddress = campaignKey(chainId, input.tokenAddress || "");
  const enabled = (input.enabled ?? true) && isCampaignAddress(chainId, campaignAddress);
  const evm = isEvmChainId(chainId);
  const resolution = input.resolution ?? "1m";

  const { points: curvePoints, loading: curveLoading, error: curveError } = useCurveTrades(
    enabled ? campaignAddress : undefined,
    { chainId, enabled, tokenAddress: tokenAddress || undefined },
  );

  const [localTopazTrades, setLocalTopazTrades] = useState<CurveTradePoint[]>([]);

  // On-chain graduation independent of campaign_market_state (same idea as TokenDetails).
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
    return () => {
      cancelled = true;
    };
  }, [enabled, campaignAddress, chainId, evm]);

  useEffect(() => {
    if (!enabled) {
      setLocalTopazTrades([]);
      return;
    }
    setLocalTopazTrades([]);

    let cancelled = false;
    void (async () => {
      if (isSolanaChainId(chainId)) return;
      try {
        const remote = await fetchTopazTradeReports({
          chainId,
          campaignAddress,
          limit: 100,
        });
        if (cancelled || !remote.length) return;
        setLocalTopazTrades((prev) => mergeTradePoints(prev, remote));
      } catch {
        // optional
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, campaignAddress, chainId]);

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
    stage === "GRADUATING";

  // Post-grad if API says so, CMS has a pair, or on-chain launched/pair (CMS lag path).
  const isPostGrad =
    graduatedFromApi ||
    onChainLaunched ||
    apiPairOk ||
    Boolean(onChainPair);

  // Scan Topaz once graduated — including CMS lag (API still BONDING, on-chain launched).
  // Do not scan pure bonding (no API post-grad, no on-chain launch/pair).
  const topazScanEnabledResolved =
    enabled &&
    evm &&
    input.enableTopazScan !== false &&
    (graduatedFromApi || onChainLaunched || apiPairOk || Boolean(onChainPair));

  const topazMarket = useTopazMarket({
    campaignAddress: enabled ? campaignAddress : undefined,
    tokenAddress: tokenAddress || undefined,
    chainId,
    enabled: topazScanEnabledResolved,
    pollMs: 8_000,
  });

  // War Room / Token Details post-fill: merge optimistic trade without full page reload.
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, campaignAddress, chainId, topazMarket]);

  const tradePoints = useMemo(() => {
    const curve = Array.isArray(curvePoints) ? curvePoints : [];
    const postGrad =
      isPostGrad ||
      Boolean(topazMarket.pairAddress) ||
      (Array.isArray(topazMarket.trades) && topazMarket.trades.length > 0) ||
      localTopazTrades.length > 0;

    // Bonding-only: never mix DEX/unified rows into circulating mcap walks.
    if (!postGrad) {
      return mergeTradePoints(curve);
    }

    const unifiedAsPoints: CurveTradePoint[] = (unifiedMarket.trades || [])
      .map((trade) => marketTradeToCurvePoint(trade, chainId))
      .filter((point): point is CurveTradePoint => Boolean(point));
    return mergeTradePoints(
      curve,
      evm ? topazMarket.trades : [],
      localTopazTrades,
      unifiedAsPoints,
    );
  }, [
    curvePoints,
    topazMarket.trades,
    topazMarket.pairAddress,
    localTopazTrades,
    unifiedMarket.trades,
    isPostGrad,
    chainId,
    evm,
  ]);

  const stableTradePoints = tradePoints;

  const loading =
    stableTradePoints.length > 0
      ? false
      : curveLoading || unifiedMarket.loading || topazMarket.loading;

  const error =
    stableTradePoints.length > 0
      ? null
      : curveError || unifiedMarket.error || topazMarket.error;

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
    isDexStage:
      isPostGrad ||
      Boolean(topazMarket.pairAddress) ||
      Boolean(unifiedMarket.state?.pairAddress),
  };
}

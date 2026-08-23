import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  UnifiedMarketChart,
  type UnifiedChartDenomination,
  type UnifiedChartResolution,
} from "@/components/token/UnifiedMarketChart";
import { useContinuousMarketTrades } from "@/hooks/useContinuousMarketTrades";
import { useSolanaMeteoraMarket } from "@/hooks/useSolanaMeteoraMarket";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import { isSolanaChainId } from "@/lib/chainConfig";
import {
  fetchSolanaCampaignCurveState,
  solanaMarginalSpotSol,
  type SolanaCampaignCurveState,
} from "@/lib/solanaCampaignRead";

type ContinuousMarketChartPanelProps = {
  campaignAddress?: string;
  tokenAddress?: string;
  /** Creator wallet — avatar pins on the continuous chart. */
  creatorAddress?: string | null;
  creatorAvatarUrl?: string | null;
  creatorDisplayName?: string | null;
  chainId: number;
  /** Compact War Room chrome vs full Token Details controls. */
  compact?: boolean;
  className?: string;
  showDenomToggle?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

/**
 * Same continuous chart stack as Token Details:
 * bonding history + Topaz scans/reports + optional market API candles.
 * Used by War Room so expanded rows don't fall back to bonding-only CurvePriceChart.
 */
export function ContinuousMarketChartPanel({
  campaignAddress,
  tokenAddress,
  creatorAddress,
  creatorAvatarUrl,
  creatorDisplayName,
  chainId,
  compact = false,
  className,
  showDenomToggle = true,
  expanded: controlledExpanded,
  onExpandedChange,
}: ContinuousMarketChartPanelProps) {
  const [resolution, setResolution] = useState<UnifiedChartResolution>("1m");
  const [denomination, setDenomination] = useState<UnifiedChartDenomination>("USD");
  const [internalExpanded, setInternalExpanded] = useState(false);
  const chartExpanded = controlledExpanded ?? internalExpanded;
  const handleExpandedChange = (next: boolean) => {
    if (controlledExpanded == null) setInternalExpanded(next);
    onExpandedChange?.(next);
  };
  const solana = isSolanaChainId(chainId);
  const nativeSymbol = solana ? "SOL" : "BNB";
  const { price: nativeUsd } = useNativeUsdPrice(chainId);
  const [solanaCurve, setSolanaCurve] = useState<SolanaCampaignCurveState | null>(null);

  useEffect(() => {
    const addr = String(campaignAddress || "").trim();
    if (!solana || !addr) {
      setSolanaCurve(null);
      return;
    }
    let cancelled = false;
    void fetchSolanaCampaignCurveState(addr).then((next) => {
      if (!cancelled) setSolanaCurve(next);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignAddress, solana]);

  const tokenDecimals = Number(solanaCurve?.tokenDecimals ?? 6);
  const meteora = useSolanaMeteoraMarket({
    mint: String(solanaCurve?.mint || tokenAddress || ""),
    tokenDecimals,
    campaignTokenVault: solanaCurve?.tokenVault ?? null,
    enabled: Boolean(solana && solanaCurve?.graduated),
  });

  const solanaSpot = useMemo(() => {
    if (!solanaCurve || solanaCurve.economicsVersion < 2) return null;
    const spot = solanaMarginalSpotSol(solanaCurve, solanaCurve.soldTokens);
    return spot > 0 ? spot : null;
  }, [solanaCurve]);

  const livePriceNative = (solanaCurve?.graduated ? meteora.spot?.priceSol : null) ?? solanaSpot;
  const liveSupplyWhole = useMemo(() => {
    if (!solanaCurve || solanaCurve.soldTokens <= 0n) return null;
    const scale = 10 ** Number(solanaCurve.tokenDecimals || 6);
    const whole = Number(solanaCurve.soldTokens) / scale;
    return Number.isFinite(whole) && whole > 0 ? whole : null;
  }, [solanaCurve]);

  const market = useContinuousMarketTrades({
    campaignAddress,
    tokenAddress,
    chainId,
    resolution,
    enabled: Boolean(campaignAddress),
    enableTopazScan: true,
  });

  return (
    <div className={`${className ?? "flex h-full min-h-[220px] w-full flex-col"} ${chartExpanded ? "!h-auto !min-h-[560px] md:!min-h-[640px]" : ""}`}>
      {showDenomToggle ? (
        <div className={`flex shrink-0 items-center justify-end gap-1 ${compact ? "mb-1" : "mb-2"}`}>
          <Button
            type="button"
            size="sm"
            variant={denomination === "USD" ? "secondary" : "ghost"}
            className={`h-6 px-2.5 text-[10px] ${
              denomination === "USD"
                ? "border border-orange-400/40 bg-orange-500/20 text-orange-300 hover:bg-orange-500/30"
                : "text-muted-foreground hover:text-orange-200"
            }`}
            onClick={() => setDenomination("USD")}
          >
            USD
          </Button>
          <Button
            type="button"
            size="sm"
            variant={denomination === "BNB" ? "secondary" : "ghost"}
            className={`h-6 px-2.5 text-[10px] ${
              denomination === "BNB"
                ? "border border-orange-400/40 bg-orange-500/20 text-orange-300 hover:bg-orange-500/30"
                : "text-muted-foreground hover:text-orange-200"
            }`}
            onClick={() => setDenomination("BNB")}
          >
            {nativeSymbol}
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <UnifiedMarketChart
          curvePoints={market.tradePoints}
          marketCandles={market.unifiedMarket.candles}
          marketState={market.unifiedMarket.state}
          serverTime={market.unifiedMarket.serverTime}
          graduationMarker={market.unifiedMarket.graduationMarker}
          creatorAddress={creatorAddress}
          creatorAvatarUrl={creatorAvatarUrl}
          creatorDisplayName={creatorDisplayName}
          chainId={chainId}
          currentBondingSoldRaw={solanaCurve?.soldTokens ?? null}
          solanaCurvePricing={solana ? solanaCurve : null}
          solanaGraduated={Boolean(solana && solanaCurve?.graduated)}
          livePriceNative={solana ? livePriceNative : null}
          liveSupplyWhole={solana ? liveSupplyWhole : null}
          nativeUsdPrice={nativeUsd}
          resolution={resolution}
          onResolutionChange={setResolution}
          denomination={denomination}
          historyReady={!market.unifiedMarket.loading}
          loading={market.unifiedMarket.loading}
          error={market.error}
          marketKey={`${chainId}:${campaignAddress || tokenAddress || ""}`}
          expanded={chartExpanded}
          onExpandedChange={handleExpandedChange}
        />
      </div>
    </div>
  );
}

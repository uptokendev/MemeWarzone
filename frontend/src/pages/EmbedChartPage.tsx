import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { UnifiedMarketChart, type UnifiedChartResolution } from "@/components/token/UnifiedMarketChart";
import { useEmbedChartMarket } from "@/hooks/useEmbedChartMarket";
import {
  EMBED_CHART_DEFAULT_RESOLUTION,
  parseEmbedChartPath,
  parseEmbedChartResolution,
} from "@/lib/embedChart";

/**
 * Chart-only partner iframe. Mounted outside the wallet/RPC shell.
 * Data path is indexer candles + summary, polled; no chain RPC.
 */
export default function EmbedChartPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const identity = useMemo(() => {
    const fromPath = parseEmbedChartPath(location.pathname);
    if (fromPath) return fromPath;
    return parseEmbedChartPath(`/embed/chart/${params.chainId || ""}/${params.token || ""}`);
  }, [location.pathname, params.chainId, params.token]);
  const resolution = useMemo(
    () => parseEmbedChartResolution(location.search),
    [location.search],
  );
  const market = useEmbedChartMarket(identity, resolution);

  if (!identity) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black px-4 text-center text-xs text-muted-foreground">
        Unknown token.
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-black p-2" data-embed-chart="true">
      <UnifiedMarketChart
        curvePoints={[]}
        marketCandles={market.candles}
        marketState={null}
        graduationMarker={market.graduationMarker}
        chainId={identity.chainId}
        livePriceNative={market.livePriceNative}
        liveMcapNative={market.liveMcapNative}
        nativeUsdPrice={market.nativeUsd}
        marketKey={`embed:${identity.chainId}:${identity.token}`}
        resolution={resolution as UnifiedChartResolution}
        onResolutionChange={(next) => {
          const search = new URLSearchParams(location.search);
          if (next === EMBED_CHART_DEFAULT_RESOLUTION) search.delete("interval");
          else search.set("interval", next);
          const qs = search.toString();
          navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
        }}
        denomination="USD"
        historyReady={!market.loading || market.candles.length > 0}
        loading={market.loading}
        error={market.error}
        serverTime={market.serverTime}
        showExpand={false}
      />
    </div>
  );
}

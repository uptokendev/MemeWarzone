import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ShoppingCart } from "lucide-react";

import { ImportedTradePanel } from "@/components/arena/ImportedTradePanel";
import { setSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { WAR_ROOM_MARKET_GRID } from "@/components/postgrad/WarRoomCampaignRow";
import { UnifiedMarketChart, type UnifiedChartResolution } from "@/components/token/UnifiedMarketChart";
import { formatCompactCount, formatCompactUsd } from "@/features/postgrad/warRoomMetrics";
import {
  IMPORT_CHART_DEFAULT_RESOLUTION,
  clampImportResolution,
  importUsdCandlesToChart,
  presentImportChart,
} from "@/lib/arena/importChartPresentation.mjs";
import { fetchArenaImportCandles, type ArenaImportCandleResponse, type ArenaImportItem, type ArenaImportMarketRow } from "@/lib/arenaImports";
import { isSolanaChainId } from "@/lib/chainConfig";
import { resolveImageUri } from "@/lib/media";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

/**
 * An imported coin in the War Trade Room (CO-1). Same row and expanded layout as a launched coin
 * (WarRoomCampaignRow); underneath, the trade runs on the coin's own DEX through ImportedTradePanel,
 * never through our launchpad panels.
 */

const DEX_NAMES: Record<string, string> = {
  pancakeswap: "PancakeSwap",
  uniswap: "Uniswap",
  raydium: "Raydium",
  pumpswap: "PumpSwap",
  pumpfun: "Pump.fun",
  meteora: "Meteora",
  orca: "Orca",
  topaz: "Topaz",
};

export function importDexLabel(row: Pick<ArenaImportMarketRow, "dexId" | "chainId">): string {
  const id = String(row.dexId || "").trim().toLowerCase();
  if (id && DEX_NAMES[id]) return DEX_NAMES[id];
  if (id) return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (isSolanaChainId(row.chainId)) return "Jupiter";
  return Number(row.chainId) === 4663 || Number(row.chainId) === 46630 ? "Uniswap" : "PancakeSwap";
}

/** The panel takes the import record shape; a listed import is status 'passed'. */
export function importMarketRowToArenaItem(row: ArenaImportMarketRow): ArenaImportItem {
  return {
    id: row.id,
    chainId: Number(row.chainId),
    tokenAddress: row.tokenAddress,
    ownerWallet: "",
    name: row.name,
    symbol: row.symbol,
    imageUrl: row.imageUrl,
    website: row.website,
    xUrl: row.xUrl,
    telegramUrl: row.telegramUrl,
    status: "passed",
  };
}

function formatAge(value?: string | null) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function resolveExternalHref(raw?: string | null) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

const card = "rounded-[14px] border border-mw-border bg-mw-input";
const cardTitle = "font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text";
const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
const smallButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text";
const chip = "inline-flex h-5 shrink-0 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-[11px] font-semibold text-mw-accent-soft";

function MobileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-mw-border bg-mw-input px-2.5 py-1.5">
      <div className={`${lbl} text-[11px]`}>{label}</div>
      <div className="font-mw-mono text-sm font-bold text-mw-text">{value}</div>
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-mw-muted">{label}</span>
      <span className="truncate font-mw-mono">{value}</span>
    </div>
  );
}

/** The import's own DEX pool history (USD), the same source and chart as its coin page. */
function ImportRowChart({ row, nativeUsd }: { row: ArenaImportMarketRow; nativeUsd: number }) {
  const [resolution, setResolution] = useState<UnifiedChartResolution>(IMPORT_CHART_DEFAULT_RESOLUTION as UnifiedChartResolution);
  const [usdCandles, setUsdCandles] = useState<ArenaImportCandleResponse["items"]>([]);
  const [state, setState] = useState<{ loading: boolean; reason?: string }>({ loading: true });

  // Same loop as the coin page: a rate-limited answer (shared GeckoTerminal budget) retries in 20 s
  // instead of leaving the chart empty; otherwise refresh each minute.
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    setUsdCandles([]);
    setState({ loading: true });
    const load = () => {
      void fetchArenaImportCandles(row.tokenAddress, row.chainId, resolution, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          if (payload?.items?.length) setUsdCandles(payload.items);
          setState({ loading: Boolean(payload?.rateLimited && !payload.items?.length), reason: payload?.reason });
          timer = window.setTimeout(load, payload?.rateLimited ? 20_000 : 60_000);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setState({ loading: false });
          timer = window.setTimeout(load, 30_000);
        });
    };
    load();
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [resolution, row.chainId, row.tokenAddress]);

  const candles = importUsdCandlesToChart(usdCandles, nativeUsd);
  const chart = presentImportChart(row, candles, row.chainId, row.tokenAddress, state);
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {chart.emptyNote ? <p className="m-0 px-1 text-xs text-mw-muted">{chart.emptyNote}</p> : null}
      <div className="min-h-0 flex-1">
        <UnifiedMarketChart
          curvePoints={[]}
          marketCandles={chart.candles}
          marketState={chart.marketState as any}
          chainId={row.chainId}
          livePriceNative={row.priceUsd && nativeUsd ? row.priceUsd / nativeUsd : null}
          liveMcapNative={row.marketCapUsd && nativeUsd ? row.marketCapUsd / nativeUsd : null}
          nativeUsdPrice={nativeUsd}
          marketKey={`${row.chainId}:${row.tokenAddress}`}
          resolution={resolution}
          onResolutionChange={(next) => setResolution(clampImportResolution(next) as UnifiedChartResolution)}
          denomination="USD"
          historyReady
          loading={false}
          error={null}
        />
      </div>
    </div>
  );
}

export function WarRoomImportRow({
  row,
  nativeUsd = 0,
  expanded,
  onToggleExpand,
}: {
  row: ArenaImportMarketRow;
  nativeUsd?: number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const chainId = Number(row.chainId);
  const dex = importDexLabel(row);
  const ticker = row.symbol ? `$${String(row.symbol).replace(/^\$/, "")}` : "";
  const marketCapLabel = formatCompactUsd(Number(row.marketCapUsd || 0));
  const liquidityLabel = formatCompactUsd(Number(row.liquidityUsd || 0));
  const volumeLabel = formatCompactUsd(Number(row.volume24hUsd || 0));
  const holdersLabel = formatCompactCount(Number(row.holders || 0));
  // ATH can never be below today's market cap, whatever the feed has stored so far.
  const athLabel = formatCompactUsd(Math.max(Number(row.athMarketCapUsd || 0), Number(row.marketCapUsd || 0)));
  const age = formatAge(row.createdAt);
  const tokenRoute = tokenDetailsPath({ tokenAddress: row.tokenAddress, chainId }, { chainId });
  const websiteHref = resolveExternalHref(row.website);
  const xHref = resolveExternalHref(row.xUrl);
  const logo = resolveImageUri(row.imageUrl) || row.imageUrl || "/placeholder.svg";
  const followTokenRoute = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    setSelectedFeedChainId(chainId as any);
  };
  const chevron = (
    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true">
      <ChevronDown className="h-4 w-4" />
    </span>
  );

  return (
    <div className={`border-t border-[#1E2329] font-mw-body text-mw-text first:border-t-0 ${expanded ? "bg-mw-accent-fill" : ""}`} data-war-room-import-row="true">
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${row.name || row.symbol || "coin"}`}
        className={`mw-focus grid w-full grid-cols-1 gap-2 px-3.5 py-3 text-left transition-colors ${expanded ? "" : "hover:bg-[#171B20]"} lg:items-center lg:gap-3 lg:px-4 ${WAR_ROOM_MARKET_GRID}`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src={logo}
            alt=""
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).src = "/placeholder.svg";
            }}
            className="h-10 w-10 shrink-0 rounded-[10px] border border-mw-border object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-bold">{row.name || row.symbol}</span>
              <span className={chip} data-import-dex-chip="true">{dex}</span>
            </div>
            <div className="truncate text-xs text-mw-muted lg:text-[13px]">
              {ticker ? <span className="font-mw-mono">{ticker}</span> : null}
              {ticker ? " · " : null}
              <span className="text-[#8FB7FF]">Imported</span>
              {age ? ` · ${age}` : null}
            </div>
          </div>
          <span className="shrink-0 text-right lg:hidden">
            <span className="block font-mw-mono font-bold">{marketCapLabel}</span>
            <span className="font-mw-mono text-xs text-mw-muted">vol {volumeLabel}</span>
          </span>
          <span className="lg:hidden">{chevron}</span>
        </div>
        <div className="hidden lg:contents">
          <div className="text-right font-mw-mono font-bold">{marketCapLabel}</div>
          <div className="text-right font-mw-mono">{liquidityLabel}</div>
          <div className="text-right font-mw-mono">{volumeLabel}</div>
          <div className="text-right font-mw-mono">{holdersLabel}</div>
          <div className="text-right font-mw-mono">{athLabel}</div>
        </div>
        <span className="hidden justify-self-end lg:flex">{chevron}</span>
      </button>

      {expanded ? (
        <div className="grid gap-3 px-3.5 pb-4 md:grid-cols-2 lg:px-4 xl:grid-cols-[minmax(0,1fr)_260px_320px]">
          <div className={`${card} flex h-[300px] flex-col p-2.5 md:col-span-2 md:h-[380px] xl:col-span-1`}>
            <ImportRowChart row={row} nativeUsd={nativeUsd} />
          </div>

          <div className="grid grid-cols-3 gap-1.5 md:hidden">
            <MobileMetric label="Liq" value={liquidityLabel} />
            <MobileMetric label="Holders" value={holdersLabel} />
            <MobileMetric label="DEX" value={dex} />
          </div>

          <div className={`${card} hidden flex-col gap-2 p-3.5 md:flex`}>
            <span className={cardTitle}>Token details</span>
            <DetailLine label="MCap" value={marketCapLabel} />
            <DetailLine label="Liq" value={liquidityLabel} />
            <DetailLine label="Vol" value={volumeLabel} />
            <DetailLine label="Holders" value={holdersLabel} />
            <DetailLine label="ATH" value={athLabel} />
            <DetailLine label="Trades on" value={dex} />
            <DetailLine label="Token" value={`${row.tokenAddress.slice(0, 6)}…${row.tokenAddress.slice(-4)}`} />
            <div className="mt-auto flex flex-col gap-1.5 pt-1">
              <Link to={tokenRoute} onClick={followTokenRoute} className={smallButton}>
                <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                Open token details
              </Link>
              {websiteHref || xHref ? (
                <div className="flex gap-1.5">
                  {websiteHref ? (
                    <a href={websiteHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`${smallButton} flex-1`}>
                      Website
                    </a>
                  ) : null}
                  {xHref ? (
                    <a href={xHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`${smallButton} flex-1`}>
                      X
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-w-0">
            <div className={`${card} p-3.5`} data-war-room-import-trade="true">
              {row.tradingBlocked ? (
                <p className="m-0 text-sm text-mw-muted">Trading is unavailable while the security scan reports a honeypot or blocked transfer.</p>
              ) : (
                <ImportedTradePanel item={importMarketRowToArenaItem(row)} />
              )}
            </div>
          </div>

          <div className="flex gap-1.5 md:hidden">
            <Link to={tokenRoute} onClick={followTokenRoute} className={`${smallButton} flex-[2]`}>
              Token details
            </Link>
            {websiteHref ? (
              <a href={websiteHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`${smallButton} flex-1`}>
                Website
              </a>
            ) : null}
            {xHref ? (
              <a href={xHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`${smallButton} flex-1`}>
                X
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

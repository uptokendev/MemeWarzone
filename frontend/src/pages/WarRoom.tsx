import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { ChainFeedSwitch, useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { WAR_ROOM_DRAFT_GRID, WAR_ROOM_MARKET_GRID, WarRoomCampaignRow } from "@/components/postgrad/WarRoomCampaignRow";
import { WarRoomImportRow, importDexLabel } from "@/components/postgrad/WarRoomImportRow";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { RadarLoader } from "@/components/ui/RadarLoader";
import { getWarRoomCampaignMetrics } from "@/features/postgrad/warRoomMetrics";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import {
  useWarRoomCampaignFeed,
  warRoomCampaignMatchesSearch,
  type WarRoomCampaign,
  type WarRoomMode,
} from "@/hooks/useWarRoomCampaignFeed";
import { getDefaultChainId } from "@/lib/chainConfig";
import { useLaunchpad } from "@/lib/launchpadClient";
import { resolveImageUri } from "@/lib/media";
import { compareLiveCampaigns, type LiveRankRow } from "@/lib/liveCampaignRank";
import { useLiveListMotion } from "@/hooks/useLiveListMotion";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { fetchArenaImportMarket, type ArenaImportMarketRow } from "@/lib/arenaImports";

type SortKey = "marketCap" | "liquidity" | "volume" | "holders" | "ath" | "follows" | "optIns" | "comments";
type SortDirection = "desc" | "asc";

/** CO-1: "imported" lists imported coins only; Trending ranks them together with our own coins. */
type TradeRoomMode = WarRoomMode | "imported";

const terminalModes: Array<{ key: TradeRoomMode; label: string }> = [
  { key: "trending", label: "Trending" },
  { key: "new", label: "New" },
  { key: "graduated", label: "Graduated" },
  { key: "imported", label: "Imported" },
  { key: "draft", label: "Drafts" },
];

/** One row in the list: a launched coin, or an imported coin trading on its own DEX. */
type TradeRoomEntry =
  | { kind: "campaign"; key: string; campaign: WarRoomCampaign }
  | { kind: "import"; key: string; row: ArenaImportMarketRow };

const IMPORT_REFRESH_MS = 30_000;

function entryKey(chainId: number, address: string) {
  return `${chainId}:${chainId === 101 || chainId === 102 ? address : address.toLowerCase()}`;
}

/** Imports carry USD from the import feed; the shared ranking reads native units like our coins. */
function importRankRow(row: ArenaImportMarketRow, nativeUsd: number): LiveRankRow {
  const usd = nativeUsd > 0 ? nativeUsd : 0;
  const createdMs = Date.parse(String(row.createdAt || ""));
  return {
    chainId: Number(row.chainId),
    campaignAddress: String(row.tokenAddress || ""),
    createdAt: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
    lastActivityAt: 0,
    vol24hBnb: usd ? Number(row.volume24hUsd || 0) / usd : 0,
    votes24h: 0,
    holderCount: Number(row.holders || 0),
    marketcapBnb: usd ? Number(row.marketCapUsd || 0) / usd : 0,
    progressPct: 0,
    etaSec: null,
    isDexTrading: true,
    voteTrendingScore: 0,
    graduatedAt: 0,
  };
}

function importSortValue(row: ArenaImportMarketRow, sortKey: SortKey) {
  switch (sortKey) {
    case "marketCap":
      return Number(row.marketCapUsd || 0);
    case "liquidity":
      return Number(row.liquidityUsd || 0);
    case "volume":
      return Number(row.volume24hUsd || 0);
    case "holders":
      return Number(row.holders || 0);
    case "ath":
      return Math.max(Number(row.athMarketCapUsd || 0), Number(row.marketCapUsd || 0));
    default:
      return 0;
  }
}

function importMatchesSearch(row: ArenaImportMarketRow, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [row.name, row.symbol, row.tokenAddress, importDexLabel(row)]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

/** Listed imports on the selected chain, refreshed like the market stats behind them. */
function useWarRoomImports(chainId: number, enabled: boolean) {
  const [rows, setRows] = useState<ArenaImportMarketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setRows([]);
    if (!enabled || !chainId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    setLoading(true);
    const load = () => {
      void fetchArenaImportMarket(chainId, controller.signal)
        .then((items) => {
          if (controller.signal.aborted) return;
          setRows(items.filter((item) => Number(item.chainId) === chainId));
          setError(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          setLoading(false);
          timer = window.setTimeout(load, IMPORT_REFRESH_MS);
        });
    };
    load();
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [chainId, enabled]);
  return { rows, loading, error };
}

const marketSortButtons: Array<{ key: SortKey; label: string }> = [
  { key: "marketCap", label: "Market Cap" },
  { key: "liquidity", label: "Liquidity" },
  { key: "volume", label: "Volume" },
  { key: "holders", label: "Holders" },
  { key: "ath", label: "All-time high" },
];

const draftSortButtons: Array<{ key: SortKey; label: string }> = [
  { key: "follows", label: "Follows" },
  { key: "optIns", label: "Opt-Ins" },
  { key: "comments", label: "Comments" },
];

function draftMetricValue(campaign: WarRoomCampaign, key: "follows" | "optIns" | "comments") {
  const rich = campaign as any;
  const value =
    key === "follows"
      ? rich.draftFollowCount
      : key === "optIns"
        ? rich.draftOptInCount
        : rich.draftCommentCount;
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toRankRow(campaign: WarRoomCampaign, chainId: number): LiveRankRow {
  const rich = campaign as any;
  const graduatedAtRaw = rich.graduatedAtChain ?? rich.graduatedAt ?? 0;
  const graduatedAt =
    typeof graduatedAtRaw === "number"
      ? graduatedAtRaw
      : Math.floor(Date.parse(String(graduatedAtRaw || "")) / 1000) || 0;
  return {
    chainId: Number(campaign.chainId || chainId),
    campaignAddress: String(campaign.campaign || ""),
    createdAt: Number(campaign.createdAt || 0),
    lastActivityAt: Number(rich.lastActivityAt || 0),
    vol24hBnb: Number(rich.rtVol24hBnb ?? rich.vol24hBnb ?? rich.volumeBnb ?? 0) || 0,
    votes24h: Number(rich.votes24h ?? 0) || 0,
    holderCount: Number(rich.holdersCount ?? rich.holderCount ?? 0) || 0,
    marketcapBnb: Number(rich.rtMarketcapBnb ?? rich.marketcapBnb ?? rich.marketCapBnb ?? 0) || 0,
    progressPct: Number(rich.progressPct ?? 0) || 0,
    etaSec: rich.etaSec == null ? null : Number(rich.etaSec),
    isDexTrading: Boolean(rich.isDexTrading || rich.status === "graduated"),
    voteTrendingScore: Number(rich.voteTrendingScore ?? 0) || 0,
    graduatedAt,
  };
}

function getSortValue(campaign: WarRoomCampaign, nativeUsd: number, sortKey: SortKey) {
  const metrics = getWarRoomCampaignMetrics(campaign, nativeUsd);
  switch (sortKey) {
    case "marketCap":
      return metrics.marketCapUsd;
    case "liquidity":
      return metrics.liquidityUsd;
    case "volume":
      return metrics.volumeUsd;
    case "holders":
      return metrics.holdersCount;
    case "ath":
      return metrics.athMarketCapUsd;
    case "follows":
      return draftMetricValue(campaign, "follows");
    case "optIns":
      return draftMetricValue(campaign, "optIns");
    case "comments":
      return draftMetricValue(campaign, "comments");
    default:
      return 0;
  }
}

const WarRoom = () => {
  const [selectedChainId] = useSelectedFeedChainId();
  const { price: nativeUsd } = useNativeUsdPrice(selectedChainId);
  const [search, setSearch] = useState("");
  const [activeMode, setActiveMode] = useState<TradeRoomMode>("trending");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [listFrozen, setListFrozen] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const importsOnly = activeMode === "imported";
  const feedChainId = Number(selectedChainId || getDefaultChainId());
  const { campaigns: rawCampaigns, loading: feedLoading, error: feedError, source } = useWarRoomCampaignFeed({
    activeMode: importsOnly ? "trending" : activeMode,
    activeChainId: feedChainId,
    bnbUsd: nativeUsd,
  });
  // Imports trade in the Imported tab and rank with our own coins in Trending (founder, CO-1).
  const showImports = importsOnly || activeMode === "trending";
  const { rows: importRows, loading: importsLoading, error: importsError } = useWarRoomImports(feedChainId, showImports);
  const loading = importsOnly ? importsLoading && !importRows.length : feedLoading;
  const error = importsOnly ? importsError && !importRows.length : feedError;

  const [logoCache, setLogoCache] = useState<Record<string, string>>({});
  const { fetchCampaignLogoURI } = useLaunchpad();
  const metricButtons = activeMode === "draft" ? draftSortButtons : marketSortButtons;

  useEffect(() => {
    setLogoCache({});
  }, [selectedChainId]);

  useEffect(() => {
    let cancelled = false;
    const missing = (rawCampaigns || [])
      .filter((c) => !String((c as any).campaign || "").startsWith("draft:"))
      .map((c) => c.campaign?.toLowerCase())
      .filter((addr): addr is string => !!addr)
      .filter((addr) => !logoCache[addr])
      .slice(0, 12);

    if (!missing.length) return;

    (async () => {
      try {
        const next: Record<string, string> = {};
        for (const addr of missing) {
          if (cancelled) return;
          const uri = await fetchCampaignLogoURI(addr).catch(() => null);
          if (uri) next[addr] = uri;
        }
        if (cancelled || !Object.keys(next).length) return;
        setLogoCache((prev) => ({ ...prev, ...next }));
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawCampaigns, fetchCampaignLogoURI]);

  const campaigns = useMemo(() => {
    return (rawCampaigns || []).map((c) => {
      const key = c.campaign?.toLowerCase();
      const hydratedLogo = key && logoCache[key] ? logoCache[key] : c.logoURI;
      return {
        ...c,
        chainId: Number((c as any).chainId || selectedChainId),
        logoURI: resolveImageUri(hydratedLogo) || c.logoURI || "/placeholder.svg",
      };
    });
  }, [rawCampaigns, logoCache, selectedChainId]);

  const liveOrder = useMemo(() => {
    const usd = nativeUsd ?? 0;
    const entries: TradeRoomEntry[] = [];
    if (!importsOnly) {
      for (const campaign of campaigns) {
        if (!warRoomCampaignMatchesSearch(campaign, search)) continue;
        const chainId = Number(campaign.chainId || selectedChainId || 0);
        const addr = String(campaign.campaign || "").trim();
        entries.push({ kind: "campaign", key: addr ? entryKey(chainId, addr) : "", campaign });
      }
    }
    if (showImports) {
      const own = new Set(entries.map((entry) => entry.key));
      for (const row of importRows) {
        if (!importMatchesSearch(row, search)) continue;
        const key = `import:${entryKey(Number(row.chainId), String(row.tokenAddress || ""))}`;
        if (!own.has(key)) entries.push({ kind: "import", key, row });
      }
    }
    const rankRow = (entry: TradeRoomEntry) =>
      entry.kind === "campaign" ? toRankRow(entry.campaign, selectedChainId) : importRankRow(entry.row, usd);
    const sortValue = (entry: TradeRoomEntry, key: SortKey) =>
      entry.kind === "campaign" ? getSortValue(entry.campaign, usd, key) : importSortValue(entry.row, key);
    const rankTab = importsOnly ? "trending" : activeMode;

    return entries.sort((left, right) => {
      if (sortKey) {
        const delta = sortValue(right, sortKey) - sortValue(left, sortKey);
        if (delta !== 0) return sortDirection === "desc" ? delta : -delta;
        return compareLiveCampaigns(rankRow(left), rankRow(right), { tab: rankTab, sort: "created_desc", context: "wtr" });
      }

      if (activeMode === "draft" && left.kind === "campaign" && right.kind === "campaign") {
        const followsDelta = draftMetricValue(right.campaign, "follows") - draftMetricValue(left.campaign, "follows");
        if (followsDelta !== 0) return followsDelta;
        return compareLiveCampaigns(rankRow(left), rankRow(right), { tab: "new", sort: "created_desc", context: "wtr" });
      }

      return compareLiveCampaigns(rankRow(left), rankRow(right), { tab: rankTab, sort: "default", context: "wtr" });
    });
  }, [activeMode, importsOnly, showImports, importRows, nativeUsd, campaigns, search, selectedChainId, sortDirection, sortKey]);

  const { items: filteredEntries, containerRef: listRef } = useLiveListMotion({
    items: liveOrder,
    identity: (entry) => entry.key,
    frozen: listFrozen,
    reducedMotion,
    snapToken: `${selectedChainId}|${activeMode}|${search}|${sortKey || ""}|${sortDirection}`,
  });

  const handleSortClick = (nextKey: SortKey) => {
    setListFrozen(false);
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection("desc");
  };

  const handleModeClick = (nextMode: TradeRoomMode) => {
    setActiveMode(nextMode);
    setSortKey(null);
    setSortDirection("desc");
    setListFrozen(false);
    setExpandedCampaign(null);
  };

  const handleToggleExpand = (campaignKey: string) => {
    setExpandedCampaign((current) => {
      if (current === campaignKey) {
        if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = setTimeout(() => {
          setListFrozen(false);
          collapseTimerRef.current = null;
        }, reducedMotion ? 0 : 220);
        return null;
      }
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      setListFrozen(true);
      return campaignKey;
    });
  };

  useEffect(() => {
    setListFrozen(false);
    setExpandedCampaign(null);
  }, [selectedChainId]);

  const sortLabel = (button: { key: SortKey; label: string }) =>
    `${button.label}${sortKey === button.key ? (sortDirection === "desc" ? " ↓" : " ↑") : ""}`;
  const activeSortButton = metricButtons.find((button) => button.key === sortKey) || null;

  return (
    <ContentContainer className="flex flex-col gap-3.5 px-1 pb-10 font-mw-body text-mw-text md:px-2">
      <div className="flex flex-wrap items-end gap-3.5">
        <div className="min-w-0">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Trade</div>
          <h1 className="m-0 font-mw-cond text-[30px] font-bold leading-none lg:text-[40px]">War Trade Room</h1>
        </div>
        <span className="hidden flex-1 sm:block" />
        <ChainFeedSwitch />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative block min-w-0 flex-1 sm:min-w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#7C858F]" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by ticker, name, creator, token or campaign address"
            aria-label="Filter coins"
            className="mw-focus h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input pl-10 pr-3 text-[15px] text-mw-text outline-none placeholder:text-[#7C858F]"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div role="tablist" aria-label="War Trade Room mode" className="flex w-full gap-1 overflow-x-auto rounded-xl border border-[#2A3038] bg-mw-input p-1 sm:w-auto">
          {terminalModes.map((mode) => {
            const active = activeMode === mode.key;
            return (
              <button
                key={mode.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleModeClick(mode.key)}
                className={`mw-focus min-h-10 flex-1 shrink-0 rounded-lg border px-2.5 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] sm:flex-none sm:px-4 ${active ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Phones and tablets: one sort control (artboard), same handler as the column headers. */}
      <div className="flex items-center gap-2 lg:hidden">
        <span className="flex-1 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Sort by</span>
        <select
          aria-label="Sort column"
          value={sortKey ?? ""}
          onChange={(event) => {
            if (event.target.value) handleSortClick(event.target.value as SortKey);
          }}
          className="mw-focus h-[38px] rounded-[10px] border border-mw-edge bg-mw-input px-3 text-sm text-mw-text"
        >
          <option value="" disabled>Default order</option>
          {metricButtons.map((button) => (
            <option key={button.key} value={button.key}>{sortLabel(button)}</option>
          ))}
        </select>
        {activeSortButton ? (
          <button
            type="button"
            onClick={() => handleSortClick(activeSortButton.key)}
            aria-label={`Sort ${sortDirection === "desc" ? "ascending" : "descending"}`}
            className="mw-focus h-[38px] w-[38px] rounded-[10px] border border-mw-edge bg-mw-raised font-mw-mono text-mw-text"
          >
            {sortDirection === "desc" ? "↓" : "↑"}
          </button>
        ) : null}
      </div>

      {error ? (
        <div role="status" className="rounded-[14px] border border-[#5A3416] bg-mw-accent-fill px-4 py-3 text-sm">
          Trade data is temporarily unavailable. Please try again shortly.
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface">
        <div className={`hidden gap-3 border-b border-mw-border px-4 py-2.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted lg:grid ${activeMode === "draft" ? WAR_ROOM_DRAFT_GRID : WAR_ROOM_MARKET_GRID}`}>
          <div className="self-center">Coin info</div>
          {metricButtons.map((button) => {
            const active = sortKey === button.key;
            return (
              <button
                key={button.key}
                type="button"
                onClick={() => handleSortClick(button.key)}
                aria-sort={active ? (sortDirection === "desc" ? "descending" : "ascending") : undefined}
                className={`mw-focus min-h-7 justify-self-end rounded-md px-1 text-right uppercase tracking-[0.08em] transition-colors ${active ? "text-mw-accent-soft" : "text-mw-muted hover:text-mw-text"}`}
              >
                {sortLabel(button)}
              </button>
            );
          })}
          <div />
        </div>
        <div ref={listRef}>
          {loading ? (
            <div className="flex min-h-[320px] items-center justify-center py-14">
              <RadarLoader label="Scanning trade radar…" size="md" />
            </div>
          ) : filteredEntries.length ? (
            filteredEntries.map((entry, index) => {
              if (entry.kind === "import") {
                // Imports trade on their own DEX: ImportedTradePanel inside the row, never WarRoomTradePanel.
                return (
                  <div key={entry.key} data-live-id={entry.key}>
                    <WarRoomImportRow
                      row={entry.row}
                      nativeUsd={nativeUsd ?? 0}
                      expanded={expandedCampaign === entry.key}
                      onToggleExpand={() => handleToggleExpand(entry.key)}
                    />
                  </div>
                );
              }
              const campaign = entry.campaign;
              const campaignKey = String(campaign.campaign || "");
              const chainId = Number(campaign.chainId || selectedChainId || 0);
              const rowKey = entry.key || `row:${chainId}:${index}`;
              return (
                <div
                  key={rowKey}
                  data-live-id={rowKey}
                >
                <WarRoomCampaignRow
                  campaign={campaign}
                  bnbUsd={nativeUsd ?? 0}
                  expanded={expandedCampaign === campaignKey}
                  onToggleExpand={() => handleToggleExpand(campaignKey)}
                />
                </div>
              );
            })
          ) : (
            <div className="px-4 py-10 text-center text-sm text-mw-muted">
              {importsOnly
                ? search.trim() ? "No imported coins match your filters." : "No imported coins are listed on this chain yet."
                : source === "empty"
                ? activeMode === "draft" ? "No public drafts are available on this chain yet." : "Coin data isn't available right now."
                : search.trim()
                  ? "No coins match your filters."
                  : "No coins are available right now."}
            </div>
          )}
        </div>
      </section>
    </ContentContainer>
  );
};

export default WarRoom;

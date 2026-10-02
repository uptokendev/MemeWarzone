import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { ChainFeedSwitch, useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { WAR_ROOM_DRAFT_GRID, WAR_ROOM_MARKET_GRID, WarRoomCampaignRow } from "@/components/postgrad/WarRoomCampaignRow";
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

type SortKey = "marketCap" | "liquidity" | "volume" | "holders" | "ath" | "follows" | "optIns" | "comments";
type SortDirection = "desc" | "asc";

const terminalModes: Array<{ key: WarRoomMode; label: string }> = [
  { key: "trending", label: "Trending" },
  { key: "new", label: "New" },
  { key: "graduated", label: "Graduated" },
  { key: "draft", label: "Drafts" },
];

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
  const [activeMode, setActiveMode] = useState<WarRoomMode>("trending");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [listFrozen, setListFrozen] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const { campaigns: rawCampaigns, loading, error, source } = useWarRoomCampaignFeed({
    activeMode,
    activeChainId: Number(selectedChainId || getDefaultChainId()),
    bnbUsd: nativeUsd,
  });

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
    const filtered = campaigns.filter((campaign) => warRoomCampaignMatchesSearch(campaign, search));

    return filtered.slice().sort((left, right) => {
      if (sortKey) {
        const leftValue = getSortValue(left, nativeUsd ?? 0, sortKey);
        const rightValue = getSortValue(right, nativeUsd ?? 0, sortKey);
        const delta = rightValue - leftValue;
        if (delta !== 0) return sortDirection === "desc" ? delta : -delta;
        return compareLiveCampaigns(
          toRankRow(left, selectedChainId),
          toRankRow(right, selectedChainId),
          { tab: activeMode, sort: "created_desc", context: "wtr" },
        );
      }

      if (activeMode === "draft") {
        const followsDelta = draftMetricValue(right, "follows") - draftMetricValue(left, "follows");
        if (followsDelta !== 0) return followsDelta;
        return compareLiveCampaigns(
          toRankRow(left, selectedChainId),
          toRankRow(right, selectedChainId),
          { tab: "new", sort: "created_desc", context: "wtr" },
        );
      }

      return compareLiveCampaigns(
        toRankRow(left, selectedChainId),
        toRankRow(right, selectedChainId),
        { tab: activeMode, sort: "default", context: "wtr" },
      );
    });
  }, [activeMode, nativeUsd, campaigns, search, selectedChainId, sortDirection, sortKey]);

  const { items: filteredCampaigns, containerRef: listRef } = useLiveListMotion({
    items: liveOrder,
    identity: (campaign) => {
      const chainId = Number(campaign.chainId || selectedChainId || 0);
      const addr = String(campaign.campaign || "").trim();
      if (!addr) return "";
      return `${chainId}:${chainId === 101 || chainId === 102 ? addr : addr.toLowerCase()}`;
    },
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

  const handleModeClick = (nextMode: WarRoomMode) => {
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
        <div role="tablist" aria-label="War Trade Room mode" className="flex w-full gap-1 rounded-xl border border-[#2A3038] bg-mw-input p-1 sm:w-auto">
          {terminalModes.map((mode) => {
            const active = activeMode === mode.key;
            return (
              <button
                key={mode.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleModeClick(mode.key)}
                className={`mw-focus min-h-10 flex-1 rounded-lg border px-3 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] sm:flex-none sm:px-4 ${active ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
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
          ) : filteredCampaigns.length ? (
            filteredCampaigns.map((campaign, index) => {
              const campaignKey = String(campaign.campaign || "");
              const chainId = Number(campaign.chainId || selectedChainId || 0);
              const rowKey = campaignKey
                ? `${chainId}:${chainId === 101 || chainId === 102 ? campaignKey : campaignKey.toLowerCase()}`
                : `row:${chainId}:${index}`;
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
              {source === "empty"
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

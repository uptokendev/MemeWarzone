import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { ChainFeedSwitch, useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { WarRoomCampaignRow } from "@/components/postgrad/WarRoomCampaignRow";
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
import { useLaunchpad } from "@/lib/launchpadClient";
import { resolveImageUri } from "@/lib/media";

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
  const frozenOrderKeysRef = useRef<string[] | null>(null);

  const { campaigns: rawCampaigns, loading, error, source } = useWarRoomCampaignFeed({
    activeMode,
    activeChainId: Number(selectedChainId || 97),
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
      }

      if (activeMode === "new") {
        const createdDelta = Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0);
        if (createdDelta !== 0) return createdDelta;
        return String(left.campaign || "").localeCompare(String(right.campaign || ""));
      }

      if (activeMode === "draft") {
        const followsDelta = draftMetricValue(right, "follows") - draftMetricValue(left, "follows");
        if (followsDelta !== 0) return followsDelta;
        return String(left.campaign || "").localeCompare(String(right.campaign || ""));
      }

      const leftMetrics = getWarRoomCampaignMetrics(left, nativeUsd ?? 0);
      const rightMetrics = getWarRoomCampaignMetrics(right, nativeUsd ?? 0);
      if (rightMetrics.trendScore !== leftMetrics.trendScore) {
        return rightMetrics.trendScore - leftMetrics.trendScore;
      }
      if (rightMetrics.volumeUsd !== leftMetrics.volumeUsd) return rightMetrics.volumeUsd - leftMetrics.volumeUsd;
      if (rightMetrics.marketCapUsd !== leftMetrics.marketCapUsd) return rightMetrics.marketCapUsd - leftMetrics.marketCapUsd;
      const createdDelta = Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0);
      if (createdDelta !== 0) return createdDelta;
      return String(left.campaign || "").localeCompare(String(right.campaign || ""));
    });
  }, [activeMode, nativeUsd, campaigns, search, sortDirection, sortKey]);

  const liveOrderRef = useRef(liveOrder);
  liveOrderRef.current = liveOrder;

  const filteredCampaigns = useMemo(() => {
    const frozenKeys = expandedCampaign ? frozenOrderKeysRef.current : null;
    if (!expandedCampaign || !frozenKeys?.length) return liveOrder;

    const byKey = new Map<string, WarRoomCampaign>();
    for (const campaign of liveOrder) {
      byKey.set(String(campaign.campaign || ""), campaign);
    }

    const seen = new Set<string>();
    const frozen: WarRoomCampaign[] = [];
    for (const key of frozenKeys) {
      const row = byKey.get(key);
      if (!row) continue;
      frozen.push(row);
      seen.add(key);
    }
    for (const campaign of liveOrder) {
      const key = String(campaign.campaign || "");
      if (seen.has(key)) continue;
      frozen.push(campaign);
      seen.add(key);
    }
    return frozen;
  }, [expandedCampaign, liveOrder]);

  useEffect(() => {
    if (!expandedCampaign) return;
    const stillVisible = liveOrder.some((campaign) => String(campaign.campaign || "") === expandedCampaign);
    if (stillVisible) return;
    frozenOrderKeysRef.current = null;
    setExpandedCampaign(null);
  }, [expandedCampaign, liveOrder]);

  const handleSortClick = (nextKey: SortKey) => {
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
    frozenOrderKeysRef.current = null;
    setExpandedCampaign(null);
  };

  const handleToggleExpand = (campaignKey: string) => {
    setExpandedCampaign((current) => {
      if (current === campaignKey) {
        frozenOrderKeysRef.current = null;
        return null;
      }
      if (!current) {
        frozenOrderKeysRef.current = liveOrderRef.current.map((campaign) => String(campaign.campaign || ""));
      }
      return campaignKey;
    });
  };

  useEffect(() => {
    frozenOrderKeysRef.current = null;
    setExpandedCampaign(null);
  }, [selectedChainId]);

  return (
    <ContentContainer className="space-y-4 px-3 pb-10 pt-20 md:px-5 md:pt-24 lg:pt-24">
      <section className="mwz-hud-frame px-4 py-4 md:px-6 md:py-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.28em] text-orange-400">Trade War Room</div>
              <h1 className="mt-2 text-2xl font-semibold uppercase tracking-[0.08em] text-white md:text-3xl">War Trade Room</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ChainFeedSwitch />
            </div>
          </div>

          <label className="flex items-center gap-3 border border-[var(--mwz-flat-card-border)] bg-black/25 px-3 py-2.5 text-white/70 focus-within:border-orange-400/50">
            <Search className="h-4 w-4 text-white/45" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by ticker, name, creator, token or campaign address"
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/35"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {terminalModes.map((mode) => {
              const active = activeMode === mode.key && !sortKey;
              return (
                <button
                  key={mode.key}
                  type="button"
                  onClick={() => handleModeClick(mode.key)}
                  className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${active ? "border-orange-400/60 bg-orange-500/10 text-orange-300" : "border-[var(--mwz-flat-card-border)] bg-black/20 text-white/58 hover:border-[var(--mwz-flat-card-border-strong)] hover:bg-white/[0.035] hover:text-white"}`}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {metricButtons.map((button) => {
              const active = sortKey === button.key;
              const directionLabel = active ? (sortDirection === "desc" ? "↓" : "↑") : "";
              return (
                <button
                  key={button.key}
                  type="button"
                  onClick={() => handleSortClick(button.key)}
                  className={`shrink-0 border px-3 py-1.5 text-[11px] font-medium transition-colors ${active ? "border-orange-400/60 bg-orange-500/10 text-orange-200" : "border-[var(--mwz-flat-card-border)] bg-black/20 text-white/65 hover:border-[var(--mwz-flat-card-border-strong)] hover:text-white"}`}
                >
                  {button.label} {directionLabel}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {error ? (
        <div className="mwz-card border-orange-300/25 bg-orange-500/10 px-4 py-3 text-sm text-orange-100">
          Trade data is temporarily unavailable. Please try again shortly.
        </div>
      ) : null}

      <section className="mwz-hud-frame overflow-hidden">
        <div className={activeMode === "draft"
          ? "hidden grid-cols-[minmax(320px,1.55fr)_110px_110px_110px] gap-3 border-b border-[var(--mwz-flat-card-border)] px-4 py-3 text-xs font-medium uppercase tracking-[0.08em] text-white/58 lg:grid"
          : "hidden grid-cols-[minmax(320px,1.55fr)_110px_110px_110px_90px_130px_28px] gap-3 border-b border-[var(--mwz-flat-card-border)] px-4 py-3 text-xs font-medium uppercase tracking-[0.08em] text-white/58 lg:grid"}
        >
          <div>Coin info</div>
          {metricButtons.map((button) => {
            const active = sortKey === button.key;
            const directionLabel = active ? (sortDirection === "desc" ? "↓" : "↑") : "";
            return (
              <button
                key={button.key}
                type="button"
                onClick={() => handleSortClick(button.key)}
                className={`flex items-center gap-1 text-left transition-colors ${active ? "text-orange-300" : "text-white/58 hover:text-white"}`}
              >
                <span>{button.label}</span>
                <span className="text-[10px] text-white/45">{directionLabel}</span>
              </button>
            );
          })}
          {activeMode !== "draft" ? <div /> : null}
        </div>
        <div>
          {loading ? (
            <div className="flex min-h-[320px] items-center justify-center bg-black py-14">
              <RadarLoader label="Scanning trade radar…" size="md" />
            </div>
          ) : filteredCampaigns.length ? (
            filteredCampaigns.map((campaign) => {
              const campaignKey = String(campaign.campaign || "");
              return (
                <WarRoomCampaignRow
                  key={campaignKey}
                  campaign={campaign}
                  bnbUsd={nativeUsd ?? 0}
                  expanded={expandedCampaign === campaignKey}
                  onToggleExpand={() => handleToggleExpand(campaignKey)}
                />
              );
            })
          ) : (
            <div className="py-10 text-center text-sm text-white/55">
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

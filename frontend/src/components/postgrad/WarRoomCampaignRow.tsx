import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, ExternalLink, Globe, Megaphone, ShoppingCart } from "lucide-react";
import type { CampaignInfo } from "@/lib/launchpadClient";
import { Button } from "@/components/ui/button";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { ContinuousMarketChartPanel } from "@/components/token/ContinuousMarketChartPanel";
import { AthBar } from "@/components/token/AthBar";
import { WarRoomTradePanel } from "@/components/postgrad/WarRoomTradePanel";
import { getPostGradTokenDetailRoute } from "@/features/postgrad/identityRoutes";
import { getWarRoomCampaignMetrics } from "@/features/postgrad/warRoomMetrics";
import { isSolanaAddress } from "@/lib/address";
import { getChainLabel } from "@/lib/chainConfig";

function shortenAddress(value?: string | null) {
  const input = String(value ?? "").trim();
  if (!input) return "—";
  if (input.length <= 10) return input;
  return `${input.slice(0, 6)}…${input.slice(-4)}`;
}

function resolveExternalHref(raw?: string | null) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function formatAge(value?: number) {
  const createdAt = Number(value ?? 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return "new";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatStatus(value?: unknown) {
  const raw = String(value || "draft").replace(/_/g, " ").trim();
  return raw ? raw.replace(/^./, (letter) => letter.toUpperCase()) : "Draft";
}

function formatCompactNumber(value: unknown) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.trunc(n));
}

function MobileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5">
      <div className="text-[8px] uppercase tracking-[0.16em] text-white/35">{label}</div>
      <div className="mt-0.5 text-xs font-semibold text-white">{value}</div>
    </div>
  );
}

function DraftInfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="text-[9px] uppercase tracking-[0.18em] text-white/35">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-white/85">{value}</div>
    </div>
  );
}

function DraftTextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="text-[9px] uppercase tracking-[0.18em] text-white/35">{label}</div>
      <p className="mt-1.5 text-sm leading-6 text-white/68">{value}</p>
    </div>
  );
}

export function WarRoomCampaignRow({
  campaign,
  bnbUsd = 0,
  expanded: expandedProp,
  onToggleExpand,
}: {
  campaign: CampaignInfo;
  bnbUsd?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = typeof expandedProp === "boolean";
  const expanded = isControlled ? expandedProp : internalExpanded;
  const [chartExpanded, setChartExpanded] = useState(false);

  const handleToggleExpand = () => {
    if (onToggleExpand) onToggleExpand();
    if (!isControlled) setInternalExpanded((value) => !value);
  };

  const tokenRoute = getPostGradTokenDetailRoute(campaign.token || campaign.campaign);
  const websiteHref = resolveExternalHref(campaign.website);
  const xHref = campaign.xAccount ? `https://x.com/${campaign.xAccount.replace(/^@/, "")}` : null;
  const extraHref = resolveExternalHref(campaign.extraLink);
  const metrics = getWarRoomCampaignMetrics(campaign, bnbUsd);
  const isDraft = metrics.status === "draft";
  const rich = campaign as any;
  const isScheduledDraft =
    Boolean(rich.isScheduled) || String(rich.draftStatus || "").toLowerCase() === "scheduled";
  const statusLabel =
    metrics.status === "graduated"
      ? "Graduated"
      : metrics.status === "bonding"
        ? "Bonding"
        : isScheduledDraft
          ? "Scheduled"
          : "Draft";
  const statusTone =
    metrics.status === "graduated" ? "success" : metrics.status === "bonding" ? "hot" : isScheduledDraft ? "sponsored" : "default";
  const chartSourceLabel =
    metrics.status === "graduated"
      ? "TOPAZ"
      : metrics.status === "bonding"
        ? "BONDING"
        : "CHART";
  const promotionHref = String(rich.promotionHref || (rich.draftSlug ? `/prepare/${rich.draftSlug}` : rich.draftId ? `/drafts/${rich.draftId}` : ""));
  const draftDescription = String(rich.draftDescription || "No promotion description has been added yet.");
  const founderNote = String(rich.draftFounderNote || "No founder note has been added yet.");
  const draftStatus = formatStatus(rich.draftStatus || (isScheduledDraft ? "scheduled" : "draft"));
  const inferredChainId = Number(rich.chainId);
  const rowChainId = isSolanaAddress(campaign.campaign)
    ? 101
    : inferredChainId === 56 || inferredChainId === 97
      ? inferredChainId
      : 56;
  const chainLabel = getChainLabel(rowChainId) || `Chain ${rowChainId || "unknown"}`;
  const draftFollows = formatCompactNumber(rich.draftFollowCount);
  const draftOptIns = formatCompactNumber(rich.draftOptInCount);
  const draftComments = formatCompactNumber(rich.draftCommentCount);

  const createdLabel = useMemo(() => formatAge(campaign.createdAt), [campaign.createdAt]);

  return (
    <div className="border-b border-white/8 last:border-b-0">
      {/* Entire collapsed bar is the expand/collapse control */}
      <button
        type="button"
        onClick={handleToggleExpand}
        className={
          isDraft
            ? "grid w-full grid-cols-1 gap-2 px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.035] lg:grid-cols-[minmax(320px,1.55fr)_110px_110px_110px] lg:items-center lg:gap-3 lg:px-4 lg:py-2.5"
            : "grid w-full grid-cols-1 gap-2 px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.035] lg:grid-cols-[minmax(320px,1.55fr)_110px_110px_110px_90px_130px_28px] lg:items-center lg:gap-3 lg:px-4 lg:py-2.5"
        }
      >
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src={campaign.logoURI || "/placeholder.svg"}
              alt={campaign.name}
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).src = "/placeholder.svg";
              }}
              className="h-9 w-9 shrink-0 rounded-lg border border-white/10 object-cover lg:h-10 lg:w-10"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="truncate text-[13px] font-semibold text-white lg:text-[15px]">{campaign.symbol || campaign.name}</div>
                <div className="truncate text-[11px] font-semibold text-white/45 lg:text-sm">{campaign.name}</div>
                <TacticalTag label={statusLabel} tone={statusTone} />
                {!isDraft && !metrics.hasRichStats ? <TacticalTag label="Syncing" tone="default" /> : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-white/55 lg:text-[11px]">
                <span className="text-orange-300">{createdLabel}</span>
                <span>→</span>
                {isDraft ? <span className="text-yellow-300">Promotion page</span> : <span className="text-yellow-300">ATH {metrics.athLabel}</span>}
                <span>{shortenAddress(campaign.campaign)}</span>
                <span className="hidden sm:inline">Creator {shortenAddress(campaign.creator)}</span>
              </div>
            </div>
            {/* Mobile collapsed bar: only MCap on the right (desktop uses table columns). */}
            {!isDraft ? (
              <div className="ml-1 shrink-0 text-right lg:hidden">
                <div className="text-[8px] uppercase tracking-[0.14em] text-white/35">MCap</div>
                <div className="text-xs font-semibold text-white">{metrics.marketCapLabel}</div>
              </div>
            ) : null}
            {!isDraft ? (
              <span className="shrink-0 text-white/50 lg:hidden" aria-hidden>
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </span>
            ) : null}
          </div>

        {isDraft ? (
          <div className="grid grid-cols-3 gap-1.5 text-sm lg:contents">
            <div className="lg:block">
              <div className="lg:hidden"><MobileMetric label="Follows" value={draftFollows} /></div>
              <div className="hidden font-semibold text-white lg:block">{draftFollows}</div>
            </div>
            <div className="lg:block">
              <div className="lg:hidden"><MobileMetric label="Opt-Ins" value={draftOptIns} /></div>
              <div className="hidden font-semibold text-white lg:block">{draftOptIns}</div>
            </div>
            <div className="lg:block">
              <div className="lg:hidden"><MobileMetric label="Comments" value={draftComments} /></div>
              <div className="hidden font-semibold text-white lg:block">{draftComments}</div>
            </div>
          </div>
        ) : (
          /* Desktop metric columns only — mobile metrics live inside the expanded panel. */
          <div className="hidden lg:contents">
            <div className="font-semibold text-white">{metrics.marketCapLabel}</div>
            <div className="font-semibold text-white">{metrics.liquidityLabel}</div>
            <div className="font-semibold text-white">{metrics.volumeLabel}</div>
            <div className="font-semibold text-white">{metrics.holdersLabel}</div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs text-white/65">
                <span>{metrics.athLabel}</span>
                <span>{metrics.athProgressPct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[linear-gradient(90deg,#fb923c,#22c55e)]" style={{ width: `${metrics.athProgressPct}%` }} />
              </div>
            </div>
          </div>
        )}

        {!isDraft ? (
          <div className="hidden lg:flex lg:justify-self-end">
            <span className="inline-flex h-8 w-8 items-center justify-center text-white/70">
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          </div>
        ) : null}
      </button>

      {expanded ? (
        isDraft ? (
          <div className="mx-2.5 mb-2.5 grid gap-3 rounded-[18px] border border-white/10 bg-[linear-gradient(180deg,rgba(16,18,24,0.88),rgba(8,9,12,0.94))] p-2.5 md:mx-3 md:mb-3 md:gap-4 md:p-4 xl:grid-cols-[0.52fr_1.48fr]">
            <div className="overflow-hidden rounded-[16px] border border-white/10 bg-black/35">
              <img
                src={campaign.logoURI || "/placeholder.svg"}
                alt={campaign.name}
                onError={(event) => {
                  (event.currentTarget as HTMLImageElement).src = "/placeholder.svg";
                }}
                className="h-40 w-full object-cover md:h-52 xl:h-full xl:min-h-[260px]"
              />
            </div>

            <div className="space-y-3">
              <div className="rounded-[18px] border border-white/10 bg-white/[0.04] p-3 md:rounded-[20px] md:p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h3 className="text-2xl font-semibold text-white">{campaign.name}</h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <TacticalTag label="Not launched yet" tone="default" />
                      <TacticalTag label={draftStatus} tone="sponsored" />
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <DraftInfoTile label="Ticker" value={campaign.symbol || "Draft"} />
                  <DraftInfoTile label="Chain" value={chainLabel} />
                  <DraftInfoTile label="Creator" value={shortenAddress(campaign.creator)} />
                  <DraftInfoTile label="Status" value={draftStatus} />
                </div>

                <div className="mt-3 grid gap-2 lg:grid-cols-2">
                  <DraftTextBlock label="Short description" value={draftDescription} />
                  <DraftTextBlock label="Founder note" value={founderNote} />
                </div>
              </div>

              <div className="rounded-[18px] border border-white/10 bg-white/[0.04] p-3 md:rounded-[20px] md:p-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {promotionHref ? (
                    <Button asChild size="sm" className="justify-between text-[11px] md:text-sm sm:col-span-2">
                      <Link to={promotionHref}>
                        Open promotion
                        <Megaphone className="h-4 w-4" />
                      </Link>
                    </Button>
                  ) : null}
                  {websiteHref ? (
                    <Button asChild size="sm" variant="outline" className="justify-between text-[11px] md:text-sm">
                      <a href={websiteHref} target="_blank" rel="noreferrer">
                        Website
                        <Globe className="h-4 w-4" />
                      </a>
                    </Button>
                  ) : null}
                  {xHref ? (
                    <Button asChild size="sm" variant="outline" className="justify-between text-[11px] md:text-sm">
                      <a href={xHref} target="_blank" rel="noreferrer">
                        X account
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  ) : null}
                  {extraHref ? (
                    <Button asChild size="sm" variant="outline" className="justify-between text-[11px] md:text-sm">
                      <a href={extraHref} target="_blank" rel="noreferrer">
                        Extra link
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-2.5 mb-2.5 grid gap-3 rounded-[18px] border border-white/10 bg-[linear-gradient(180deg,rgba(16,18,24,0.88),rgba(8,9,12,0.94))] p-2.5 md:mx-3 md:mb-3 md:gap-4 md:p-4 xl:grid-cols-[1.35fr_0.65fr]">
            {/* Mobile expand order: metrics text → chart → buy/sell (+ links). Desktop: chart | trade. */}
            <div className="order-1 col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/8 pb-2 text-[10px] text-white/70 xl:hidden">
              <span><span className="text-white/40">MCap</span> {metrics.marketCapLabel}</span>
              <span><span className="text-white/40">Liq</span> {metrics.liquidityLabel}</span>
              <span><span className="text-white/40">Vol</span> {metrics.volumeLabel}</span>
              <span><span className="text-white/40">Holders</span> {metrics.holdersLabel}</span>
              <span><span className="text-white/40">ATH</span> {metrics.athLabel}</span>
            </div>

            <div className={`order-2 flex flex-col rounded-[16px] border border-white/10 bg-black/30 p-2 md:rounded-[18px] md:p-3 xl:order-1 ${chartExpanded ? "h-auto min-h-[580px] md:min-h-[660px]" : "h-[300px] md:h-[380px]"}`}>
              <div className="mb-1.5 flex shrink-0 items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-orange-300">
                  {chartSourceLabel}
                </div>
              </div>
              <div className="mb-2 shrink-0 px-0.5">
                <AthBar
                  currentLabel={metrics.marketCapLabel}
                  canonicalAthUsd={metrics.athMarketCapUsd > 0 ? metrics.athMarketCapUsd : null}
                  storageKey={`ath:${rowChainId}:${String(campaign.campaign || "")}:wtr`}
                  className="w-full min-w-0 text-[10px] text-white/80"
                />
              </div>
              <ContinuousMarketChartPanel
                campaignAddress={campaign.campaign}
                tokenAddress={campaign.token}
                creatorAddress={(campaign as any).creator || (campaign as any).creatorAddress}
                chainId={rowChainId}
                compact
                expanded={chartExpanded}
                onExpandedChange={setChartExpanded}
                className="flex min-h-0 w-full flex-1 flex-col"
              />
            </div>

            <div className="order-3 space-y-2.5 md:space-y-3 xl:order-2">
              {/* Token details / links sit above buy-sell so they are seen first */}
              <div className="rounded-[18px] border border-white/10 bg-white/[0.04] p-3 md:rounded-[20px] md:p-4">
                <div className="text-[10px] uppercase tracking-[0.24em] text-accent/80">Token details</div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 md:mt-4">
                  {tokenRoute ? (
                    <Button asChild size="sm" variant="outline" className="justify-between text-[11px] md:text-sm sm:col-span-2">
                      <Link to={tokenRoute} onClick={(e) => e.stopPropagation()}>
                        Open token details
                        <ShoppingCart className="h-4 w-4" />
                      </Link>
                    </Button>
                  ) : null}
                  {websiteHref ? (
                    <Button asChild size="sm" variant="outline" className="justify-between text-[11px] md:text-sm">
                      <a href={websiteHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        Website
                        <Globe className="h-4 w-4" />
                      </a>
                    </Button>
                  ) : null}
                  {xHref ? (
                    <Button asChild size="sm" variant="outline" className="justify-between text-[11px] md:text-sm">
                      <a href={xHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        X account
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>

              <WarRoomTradePanel campaign={campaign} />
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

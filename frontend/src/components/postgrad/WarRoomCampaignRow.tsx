import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ExternalLink, Globe, Megaphone, ShoppingCart } from "lucide-react";
import type { CampaignInfo } from "@/lib/launchpadClient";
import { ContinuousMarketChartPanel } from "@/components/token/ContinuousMarketChartPanel";
import { AthBar } from "@/components/token/AthBar";
import { WarRoomTradePanel } from "@/components/postgrad/WarRoomTradePanel";
import { RobinhoodWarRoomTradePanel } from "@/components/postgrad/RobinhoodWarRoomTradePanel";
import { setSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { getWarRoomCampaignMetrics } from "@/features/postgrad/warRoomMetrics";
import { isSolanaAddress } from "@/lib/address";
import { getChainLabel, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";

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

const card = "rounded-[14px] border border-mw-border bg-mw-input";
const cardTitle = "font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text";
const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
const smallButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text";
const accentButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-3 text-sm font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02]";
/** Row grid: the header in WarRoom.tsx uses the same templates. */
export const WAR_ROOM_MARKET_GRID = "lg:grid-cols-[minmax(280px,1.6fr)_repeat(5,minmax(84px,1fr))_44px]";
export const WAR_ROOM_DRAFT_GRID = "lg:grid-cols-[minmax(280px,1.6fr)_repeat(3,minmax(96px,1fr))_44px]";

function MobileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-mw-border bg-mw-input px-2.5 py-1.5">
      <div className={`${lbl} text-[11px]`}>{label}</div>
      <div className="font-mw-mono text-sm font-bold text-mw-text">{value}</div>
    </div>
  );
}

function DraftInfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-mw-border bg-mw-surface px-3 py-2.5">
      <div className={lbl}>{label}</div>
      <div className="mt-0.5 truncate text-sm font-bold text-mw-text">{value}</div>
    </div>
  );
}

function DraftTextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-mw-border bg-mw-surface px-3 py-2.5">
      <div className={lbl}>{label}</div>
      <p className="m-0 mt-1 text-sm leading-6 text-mw-muted">{value}</p>
    </div>
  );
}

function DetailLine({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-mw-muted">{label}</span>
      <span className={`truncate ${mono ? "font-mw-mono" : ""}`}>{value}</span>
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

  const websiteHref = resolveExternalHref(campaign.website);
  const xHref = campaign.xAccount ? `https://x.com/${campaign.xAccount.replace(/^@/, "")}` : null;
  const extraHref = resolveExternalHref(campaign.extraLink);
  const metrics = getWarRoomCampaignMetrics(campaign, bnbUsd);
  const isDraft = metrics.status === "draft";
  const rich = campaign as any;
  const inferredChainId = Number(rich.chainId);
  const rowChainId = isSolanaAddress(campaign.campaign)
    ? 101
    : inferredChainId === 56 || inferredChainId === 97 || inferredChainId === ROBINHOOD_CHAIN_ID || inferredChainId === ROBINHOOD_TESTNET_CHAIN_ID
      ? inferredChainId
      : 56;
  const isRobinhoodRow = rowChainId === ROBINHOOD_CHAIN_ID || rowChainId === ROBINHOOD_TESTNET_CHAIN_ID;
  const tokenRoute = tokenDetailsPath(
    { tokenAddress: campaign.token, campaignAddress: campaign.campaign, chainId: rowChainId },
    { chainId: rowChainId },
  );
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
      ? isRobinhoodRow ? "ROBINHOOD V3" : "TOPAZ"
      : metrics.status === "bonding"
        ? "BONDING"
        : "CHART";
  const promotionHref = String(rich.promotionHref || (rich.draftSlug ? `/prepare/${rich.draftSlug}` : rich.draftId ? `/drafts/${rich.draftId}` : ""));
  const draftDescription = String(rich.draftDescription || "No promotion description has been added yet.");
  const founderNote = String(rich.draftFounderNote || "No founder note has been added yet.");
  const draftStatus = formatStatus(rich.draftStatus || (isScheduledDraft ? "scheduled" : "draft"));
  const chainLabel = getChainLabel(rowChainId) || `Chain ${rowChainId || "unknown"}`;
  const draftFollows = formatCompactNumber(rich.draftFollowCount);
  const draftOptIns = formatCompactNumber(rich.draftOptInCount);
  const draftComments = formatCompactNumber(rich.draftCommentCount);

  const createdLabel = useMemo(() => formatAge(campaign.createdAt), [campaign.createdAt]);

  const ticker = campaign.symbol ? `$${String(campaign.symbol).replace(/^\$/, "")}` : "";
  const statusClass = metrics.status === "graduated" ? "text-[#6EE7A0]" : metrics.status === "bonding" ? "text-[#FFB27A]" : "text-mw-muted";
  const followTokenRoute = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (
      rowChainId === 56 ||
      rowChainId === 97 ||
      rowChainId === ROBINHOOD_CHAIN_ID ||
      rowChainId === ROBINHOOD_TESTNET_CHAIN_ID ||
      rowChainId === 101
    ) {
      setSelectedFeedChainId(rowChainId);
    }
  };
  const hasTokenRoute = Boolean(tokenRoute && tokenRoute !== "/");
  const chevron = (
    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true">
      <ChevronDown className="h-4 w-4" />
    </span>
  );

  return (
    <div className={`border-t border-[#1E2329] font-mw-body text-mw-text first:border-t-0 ${expanded ? "bg-mw-accent-fill" : ""}`}>
      {/* Entire collapsed bar is the expand/collapse control */}
      <button
        type="button"
        onClick={handleToggleExpand}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${campaign.name || campaign.symbol || "coin"}`}
        className={`mw-focus grid w-full grid-cols-1 gap-2 px-3.5 py-3 text-left transition-colors ${expanded ? "" : "hover:bg-[#171B20]"} lg:items-center lg:gap-3 lg:px-4 ${isDraft ? WAR_ROOM_DRAFT_GRID : WAR_ROOM_MARKET_GRID}`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src={campaign.logoURI || "/placeholder.svg"}
            alt=""
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).src = "/placeholder.svg";
            }}
            className="h-10 w-10 shrink-0 rounded-[10px] border border-mw-border object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-bold">{campaign.name || campaign.symbol}</span>
              {!isDraft && !metrics.hasRichStats ? (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-mw-edge px-2 text-[11px] font-semibold text-mw-muted">Syncing</span>
              ) : null}
            </div>
            <div className="truncate text-xs text-mw-muted lg:text-[13px]">
              {ticker ? <span className="font-mw-mono">{ticker}</span> : null}
              {ticker ? " · " : null}
              <span className={statusClass}>{statusLabel}</span>
              {" · "}
              {createdLabel}
            </div>
          </div>
          {!isDraft ? (
            <span className="shrink-0 text-right lg:hidden">
              <span className="block font-mw-mono font-bold">{metrics.marketCapLabel}</span>
              <span className="font-mw-mono text-xs text-mw-muted">vol {metrics.volumeLabel}</span>
            </span>
          ) : null}
          <span className="lg:hidden">{chevron}</span>
        </div>

        {isDraft ? (
          <div className="grid grid-cols-3 gap-1.5 lg:contents">
            <div className="lg:text-right">
              <div className="lg:hidden"><MobileMetric label="Follows" value={draftFollows} /></div>
              <div className="hidden font-mw-mono font-bold lg:block">{draftFollows}</div>
            </div>
            <div className="lg:text-right">
              <div className="lg:hidden"><MobileMetric label="Opt-Ins" value={draftOptIns} /></div>
              <div className="hidden font-mw-mono font-bold lg:block">{draftOptIns}</div>
            </div>
            <div className="lg:text-right">
              <div className="lg:hidden"><MobileMetric label="Comments" value={draftComments} /></div>
              <div className="hidden font-mw-mono font-bold lg:block">{draftComments}</div>
            </div>
          </div>
        ) : (
          <div className="hidden lg:contents">
            <div className="text-right font-mw-mono font-bold">{metrics.marketCapLabel}</div>
            <div className="text-right font-mw-mono">{metrics.liquidityLabel}</div>
            <div className="text-right font-mw-mono">{metrics.volumeLabel}</div>
            <div className="text-right font-mw-mono">{metrics.holdersLabel}</div>
            <div className="text-right font-mw-mono">{metrics.athLabel}</div>
          </div>
        )}

        <span className="hidden justify-self-end lg:flex">{chevron}</span>
      </button>

      {expanded ? (
        isDraft ? (
          <div className="grid gap-3 px-3.5 pb-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:px-4">
            <div className={`${card} overflow-hidden`}>
              <img
                src={campaign.logoURI || "/placeholder.svg"}
                alt={campaign.name}
                onError={(event) => {
                  (event.currentTarget as HTMLImageElement).src = "/placeholder.svg";
                }}
                className="h-40 w-full object-cover md:h-52 lg:h-full lg:min-h-[240px]"
              />
            </div>

            <div className={`${card} flex flex-col gap-3 p-3.5`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={`${cardTitle} m-0`}>{campaign.name}</h3>
                <span className="inline-flex h-6 items-center rounded-full border border-mw-edge px-2.5 text-xs font-semibold text-mw-muted">Not launched yet</span>
                <span className="inline-flex h-6 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2.5 text-xs font-semibold text-mw-accent-soft">{draftStatus}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <DraftInfoTile label="Ticker" value={campaign.symbol || "Draft"} />
                <DraftInfoTile label="Chain" value={chainLabel} />
                <DraftInfoTile label="Creator" value={shortenAddress(campaign.creator)} />
                <DraftInfoTile label="Status" value={draftStatus} />
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                <DraftTextBlock label="Short description" value={draftDescription} />
                <DraftTextBlock label="Founder note" value={founderNote} />
              </div>
              <div className="flex flex-wrap gap-2">
                {promotionHref ? (
                  <Link to={promotionHref} className={accentButton}>
                    <Megaphone className="h-4 w-4" aria-hidden="true" />
                    Open promotion
                  </Link>
                ) : null}
                {websiteHref ? (
                  <a href={websiteHref} target="_blank" rel="noreferrer" className={smallButton}>
                    <Globe className="h-4 w-4" aria-hidden="true" />
                    Website
                  </a>
                ) : null}
                {xHref ? (
                  <a href={xHref} target="_blank" rel="noreferrer" className={smallButton}>
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    X
                  </a>
                ) : null}
                {extraHref ? (
                  <a href={extraHref} target="_blank" rel="noreferrer" className={smallButton}>
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Extra link
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 px-3.5 pb-4 md:grid-cols-2 lg:px-4 xl:grid-cols-[minmax(0,1fr)_260px_320px]">
            <div className={`${card} flex flex-col p-2.5 md:col-span-2 xl:col-span-1 ${chartExpanded ? "h-auto min-h-[580px] md:min-h-[660px]" : "h-[300px] md:h-[380px]"}`}>
              <ContinuousMarketChartPanel
                campaignAddress={campaign.campaign}
                tokenAddress={campaign.token}
                creatorAddress={(campaign as any).creator || (campaign as any).creatorAddress}
                chainId={rowChainId}
                fixedSupplyWhole={Number(rich.fullyDilutedSupply) > 0 ? Number(rich.fullyDilutedSupply) : null}
                compact
                expanded={chartExpanded}
                onExpandedChange={setChartExpanded}
                className="flex min-h-0 w-full flex-1 flex-col"
              />
            </div>

            {/* Phones (artboard): three tiles and a link row; the full details card from md up. */}
            <div className="grid grid-cols-3 gap-1.5 md:hidden">
              <MobileMetric label="Liq" value={metrics.liquidityLabel} />
              <MobileMetric label="Holders" value={metrics.holdersLabel} />
              <MobileMetric label="ATH" value={metrics.athLabel} />
            </div>

            <div className={`${card} hidden flex-col gap-2 p-3.5 md:flex`}>
              <span className={cardTitle}>Token details</span>
              <DetailLine label="MCap" value={metrics.marketCapLabel} />
              <DetailLine label="Liq" value={metrics.liquidityLabel} />
              <DetailLine label="Vol" value={metrics.volumeLabel} />
              <DetailLine label="Holders" value={metrics.holdersLabel} />
              <DetailLine label="ATH" value={metrics.athLabel} />
              <AthBar
                currentLabel={metrics.marketCapLabel}
                canonicalAthUsd={metrics.athMarketCapUsd > 0 ? metrics.athMarketCapUsd : null}
                storageKey={`ath:${rowChainId}:${String(campaign.campaign || "")}:wtr`}
                className="w-full min-w-0 text-[11px] text-mw-muted"
              />
              <DetailLine label="Campaign" value={shortenAddress(campaign.campaign)} />
              <DetailLine label="Creator" value={shortenAddress(campaign.creator)} />
              <div className="mt-auto flex flex-col gap-1.5 pt-1">
                {hasTokenRoute ? (
                  <Link to={tokenRoute} onClick={followTokenRoute} className={smallButton}>
                    <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                    Open token details
                  </Link>
                ) : null}
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
              {isRobinhoodRow && metrics.status === "graduated" ? (
                <RobinhoodWarRoomTradePanel campaign={campaign} />
              ) : isRobinhoodRow ? (
                // WarRoomTradePanel trades on BNB only: for a Robinhood coin it showed "Connect BNB wallet",
                // priced in BNB and resolved the campaign on chain 97. Robinhood bonding trades run on the
                // token page, which already uses ETH and the Robinhood chain.
                <div className={`${card} p-3.5`} data-testid="war-room-robinhood-bonding-trade">
                  <span className={cardTitle}>Trade</span>
                  <p className="m-0 mt-1.5 text-sm text-mw-muted">
                    This coin trades in ETH on Robinhood Chain. Buy and sell it on its token page.
                  </p>
                  {hasTokenRoute ? (
                    <Link
                      to={tokenRoute}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFeedChainId(rowChainId);
                      }}
                      className={`${accentButton} mt-3 min-h-11 w-full`}
                    >
                      <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                      Trade {campaign.symbol ? `$${String(campaign.symbol).replace(/^\$/, "")}` : "this coin"} with ETH
                    </Link>
                  ) : null}
                </div>
              ) : (
                <WarRoomTradePanel campaign={campaign} />
              )}
            </div>

            <div className="flex gap-1.5 md:hidden">
              {hasTokenRoute ? (
                <Link to={tokenRoute} onClick={followTokenRoute} className={`${smallButton} flex-[2]`}>
                  Token details
                </Link>
              ) : null}
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
        )
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { Link } from "react-router-dom";
import { Flame, Radio, ShieldCheck, Star } from "lucide-react";

import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import {
  fetchPublicCampaignDrafts,
  type DraftPopularity,
} from "@/lib/draftApi";
import {
  BNB_CHAIN_ID,
  BNB_TESTNET_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from "@/lib/chainConfig";
import { resolveImageUri } from "@/lib/media";
import { timestampSeconds, type CampaignDraftLifecycle } from "@/lib/scheduledLaunchApi";
import { cn } from "@/lib/utils";
import type { HomeQuery } from "./CampaignGrid";

/** Keep draft discovery isolated by product chain. BNB alone retains its legacy 56+97 merge. */
function draftFeedChainIds(selectedChainId: number): number[] {
  if (selectedChainId === SOLANA_CHAIN_ID) return [SOLANA_CHAIN_ID];
  if (selectedChainId === ROBINHOOD_CHAIN_ID) return [ROBINHOOD_CHAIN_ID];
  if (selectedChainId === ROBINHOOD_TESTNET_CHAIN_ID) return [ROBINHOOD_TESTNET_CHAIN_ID];
  if (selectedChainId === BNB_CHAIN_ID || selectedChainId === BNB_TESTNET_CHAIN_ID) {
    return [BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID];
  }
  return [selectedChainId];
}

type DraftCampaignVM = {
  draft: CampaignDraftLifecycle;
  mission: string;
  popularity: DraftPopularity | null;
};

const PUBLIC_DRAFT_STATUSES = new Set(["promotion_published", "ready_to_launch", "scheduled"]);

function shortAddr(value?: string | null) {
  const address = String(value || "");
  return address.length > 10 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address || "—";
}

function ageLabel(value?: string | null) {
  const created = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(created)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - created) / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readiness(status: string) {
  if (status === "scheduled") return "Scheduled";
  if (status === "ready_to_launch") return "Ready to launch";
  return "Promotion live";
}

function scheduledLaunchSeconds(draft: CampaignDraftLifecycle) {
  return timestampSeconds(draft.scheduledLaunchAt);
}

function isScheduledDraft(draft: CampaignDraftLifecycle) {
  return String(draft.status) === "scheduled";
}

function isFutureScheduledDraft(draft: CampaignDraftLifecycle, nowMs = Date.now()) {
  const launchAt = scheduledLaunchSeconds(draft);
  return Boolean(
    isScheduledDraft(draft) &&
      draft.campaignAddress &&
      launchAt &&
      launchAt > Math.floor(nowMs / 1000),
  );
}

/**
 * Pre-launch scheduled drafts only. Once launchAt is past (or missing with a live
 * campaign address), the token belongs in bonding/trending — not Drafts.
 */
function isDiscoverableScheduledDraft(draft: CampaignDraftLifecycle, nowMs = Date.now()) {
  if (!isScheduledDraft(draft)) return false;
  const launchAt = scheduledLaunchSeconds(draft);
  const hasCampaign = Boolean(draft.campaignAddress);
  if (hasCampaign) {
    // Armed future launch still counts as Drafts; past/unknown launch with address does not.
    if (!launchAt || launchAt <= Math.floor(nowMs / 1000)) return false;
    return true;
  }
  // Scheduled without campaign address yet (armed but not deployed) — keep visible.
  return Boolean(launchAt);
}

function formatLaunchDate(value?: string | number | null) {
  const seconds = timestampSeconds(value);
  if (!seconds) return "Launch time unavailable";
  return "Launch " + new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

function matchesSearch(item: DraftCampaignVM, search?: string) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return true;
  return [
    item.draft.name,
    item.draft.ticker,
    item.draft.description,
    item.draft.creatorWallet,
    item.mission,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function sortDrafts(items: DraftCampaignVM[], sort: HomeQuery["sort"] | undefined, nowMs: number) {
  const created = (item: DraftCampaignVM) => String(item.draft.draftCreatedAt || item.draft.createdAt || "");
  const active = items.filter((item) => {
    if (String(item.draft.status) === "deployed") return false;
    if (String(item.draft.status) === "scheduled") return isDiscoverableScheduledDraft(item.draft, nowMs);
    return true;
  });

  if (sort === "progress_desc") {
    return active
      .filter((item) => isFutureScheduledDraft(item.draft, nowMs) || isDiscoverableScheduledDraft(item.draft, nowMs))
      .sort((a, b) => {
        const launchDiff = Number(scheduledLaunchSeconds(a.draft) || Number.MAX_SAFE_INTEGER)
          - Number(scheduledLaunchSeconds(b.draft) || Number.MAX_SAFE_INTEGER);
        return launchDiff || created(b).localeCompare(created(a));
      });
  }

  if (sort === "popular_desc") {
    const score = (item: DraftCampaignVM) => {
      const pop = item.popularity;
      const ranked = Number(pop?.rankingScore ?? 0);
      if (Number.isFinite(ranked) && ranked > 0) return ranked;
      const pct = Number(pop?.popularityPercentage ?? 0);
      const follows = Number(pop?.follows ?? 0);
      const comments = Number(pop?.comments ?? 0);
      return pct * 10 + follows * 3 + comments;
    };
    return active.slice().sort((a, b) => {
      const diff = score(b) - score(a);
      return diff || created(b).localeCompare(created(a));
    });
  }

  if (sort === "created_asc") return active.slice().sort((a, b) => created(a).localeCompare(created(b)));
  return active.slice().sort((a, b) => created(b).localeCompare(created(a)));
}

function isDiscoverableDraft(draft: CampaignDraftLifecycle, nowMs = Date.now()) {
  const status = String(draft.status);
  if (!PUBLIC_DRAFT_STATUSES.has(status)) return false;
  if (status === "scheduled") return isDiscoverableScheduledDraft(draft, nowMs);
  // Un-deployed prepare pages only (armed timed launches use status=scheduled).
  return !draft.campaignAddress;
}

function draftChainLabel(chainId: number) {
  if (chainId === SOLANA_CHAIN_ID) return "Solana";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "Robinhood";
  return "BNB";
}

function draftChainBadgeClass(chainId: number) {
  if (chainId === SOLANA_CHAIN_ID) return "border-violet-400/60 bg-violet-400/10 text-violet-300";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    return "border-sky-400/60 bg-sky-400/10 text-sky-300";
  }
  return "border-amber-400/60 bg-amber-400/10 text-amber-300";
}

export function DraftCampaignGrid({ className, query }: { className?: string; query: HomeQuery & { tab?: string } }) {
  const [chainId] = useSelectedFeedChainId();
  const [items, setItems] = useState<DraftCampaignVM[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent)?.detail || {};
      const eventChainId = Number(detail.chainId ?? NaN);
      if (Number.isFinite(eventChainId) && eventChainId !== Number(chainId)) return;
      setRefreshNonce((value) => value + 1);
    };
    window.addEventListener("memewarzone:scheduledLaunchReached", refresh as EventListener);
    return () => window.removeEventListener("memewarzone:scheduledLaunchReached", refresh as EventListener);
  }, [chainId]);

  useEffect(() => {
    if (!items.some((item) => String(item.draft.status) === "scheduled")) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const chainIds = draftFeedChainIds(chainId);
        // One list request per chain (enriched with mission + popularity). No per-card /api/drafts/:id.
        const pages = await Promise.all(
          chainIds.map((id) => fetchPublicCampaignDrafts({ chainId: id, limit: 50 })),
        );
        const drafts = pages.flat() as Array<
          CampaignDraftLifecycle & {
            mission?: string | null;
            missionStatement?: string | null;
            creatorNote?: string | null;
            popularity?: DraftPopularity | null;
          }
        >;
        const seen = new Set<string>();
        const candidates = drafts
          .filter((draft) => {
            const id = String(draft.id || "");
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .filter((draft) => chainIds.includes(Number(draft.chainId)))
          .filter((draft) => draft.visibility === "public")
          .filter((draft) => isDiscoverableDraft(draft, Date.now()))
          .slice(0, 40);

        const mapped: DraftCampaignVM[] = candidates.map((draft) => ({
          draft,
          mission:
            String(draft.mission || draft.missionStatement || draft.creatorNote || draft.description || "").trim() ||
            "Creator is preparing the campaign before the battlefield opens.",
          popularity: draft.popularity || null,
        }));

        if (!cancelled) setItems(mapped);
      } catch (reason: any) {
        if (!cancelled) setError(reason?.message || "Failed to load draft campaigns.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chainId, refreshNonce]);

  const visible = useMemo(
    () => sortDrafts(items.filter((item) => matchesSearch(item, query.search)), query.sort, nowMs),
    [items, query.search, query.sort, nowMs],
  );

  const gridClass = "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3";
  const chip = "inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full border px-2 text-xs font-semibold";

  return (
    <div className={cn("w-full font-mw-body text-mw-text", className)}>
      <div className="mb-3 text-sm text-mw-muted">Showing {visible.length} draft campaigns</div>

      {loading && !visible.length ? (
        <div className={gridClass}>
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-[260px] animate-pulse rounded-[14px] border border-mw-border bg-mw-surface" />
          ))}
        </div>
      ) : error ? (
        <div className="py-10 text-center text-sm text-mw-muted">{error}</div>
      ) : !visible.length ? (
        <div className="py-10 text-center text-sm text-mw-muted">
          No public draft campaigns yet. Published Prepare Pages and timed on-chain launches appear here.
        </div>
      ) : (
        <div className={gridClass}>
          {visible.map(({ draft, mission, popularity }) => {
            const logo = resolveImageUri(draft.logoUrl) || "/placeholder.svg";
            const heat = popularity?.heatLabel || "Cold";
            const follows = Number(popularity?.follows || 0);
            const popularityPct = Number(popularity?.popularityPercentage || 0);
            const scheduled = isDiscoverableScheduledDraft(draft);
            const launchDate = scheduled
              ? (scheduledLaunchSeconds(draft)
                  ? formatLaunchDate(draft.scheduledLaunchAt)
                  : "On-chain launch armed")
              : "";
            const draftChainId = Number(draft.chainId);

            return (
              <article key={draft.id} className="flex flex-col gap-2 rounded-[14px] border border-mw-border bg-mw-surface p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn(chip, "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft")}>
                    <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                    {scheduled ? "Scheduled" : "Prepare Mode"}
                  </span>
                  <span className={cn(chip, "border-mw-edge bg-[#171B20] text-[#C9CED4]")}>{draftChainLabel(draftChainId)}</span>
                  <span className="ml-auto inline-flex items-center gap-1 text-[13px] text-mw-muted">
                    <Flame className="h-3 w-3" aria-hidden="true" />
                    {heat}
                  </span>
                </div>

                <Link to={`/prepare/${encodeURIComponent(draft.slug)}`} className="mw-focus group flex items-center gap-2.5 text-mw-text hover:text-mw-text">
                  <img src={logo} alt={draft.name} className="h-12 w-12 shrink-0 rounded-[10px] bg-[#1F252C] object-cover" draggable={false} loading="lazy" />
                  <span className="min-w-0">
                    <b className="block truncate group-hover:text-mw-accent-soft">{draft.name}</b>
                    <span className="block truncate font-mw-mono text-[13px] text-mw-muted">
                      {draft.ticker ? `$${draft.ticker}` : ""}
                      {scheduled ? ` · launch ${launchDate}` : ""}
                      {` · ${ageLabel(draft.draftCreatedAt || draft.createdAt)}`}
                    </span>
                  </span>
                </Link>

                <div className="text-[13px] text-mw-muted">
                  by{" "}
                  <Link
                    to={`/profile/${encodeURIComponent(draft.creatorWallet)}`}
                    className="font-mw-mono text-mw-accent-soft hover:text-[#FFD0A8]"
                    title={draft.creatorWallet}
                  >
                    <WalletLabel wallet={draft.creatorWallet} />
                  </Link>
                </div>

                <p className="m-0 line-clamp-3 text-sm text-mw-muted">{mission}</p>

                <div className="flex flex-wrap items-center justify-between gap-2 font-mw-mono text-[13px] text-mw-muted">
                  <span>Readiness <b className="text-mw-text">{readiness(String(draft.status))}</b></span>
                  <span className="inline-flex items-center gap-1"><Star className="h-3 w-3" aria-hidden="true" />Watchlist <b className="text-mw-text">{follows}</b></span>
                  <span className="inline-flex items-center gap-1"><Radio className="h-3 w-3" aria-hidden="true" />Popularity <b className="text-mw-text">{Number.isFinite(popularityPct) ? `${popularityPct}%` : "0%"}</b></span>
                </div>

                <Link to={`/prepare/${encodeURIComponent(draft.slug)}`} className="mw-focus mt-auto inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text">
                  View promotion page
                </Link>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

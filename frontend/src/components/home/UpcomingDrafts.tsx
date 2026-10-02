import { useEffect, useMemo, useState } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { Link } from "react-router-dom";
import { Flame, Radio, ShieldCheck, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveImageUri } from "@/lib/media";
import { useLaunchpad } from "@/lib/launchpadClient";
import {
  fetchCampaignDraft,
  fetchPublicCampaignDrafts,
  type CampaignDraft,
  type DraftPopularity,
} from "@/lib/draftApi";

type UpcomingDraftVM = {
  draft: CampaignDraft;
  mission: string;
  popularity: DraftPopularity | null;
};

const UPCOMING_STATUSES = new Set(["promotion_published", "ready_to_launch", "scheduled"]);

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  const a = String(addr);
  return a.length > 10 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

function readinessLabel(status: string) {
  if (status === "ready_to_launch") return "Ready to launch";
  if (status === "promotion_published") return "Promotion live";
  return "Preparing";
}

function formatCreatedAt(value?: string | null) {
  if (!value) return "—";

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";

  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60000);

  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

function heatClass(label?: string) {
  if (label === "On Fire") return "border-orange-400/70 text-orange-300";
  if (label === "Hot") return "border-orange-400/60 text-orange-400";
  if (label === "Warming") return "border-orange-400/50 text-orange-300";
  return "border-orange-400/40 text-orange-300";  // Cold - now orange for visibility on black bg
}

export function UpcomingDrafts({ className }: { className?: string }) {
  const { activeChainId } = useLaunchpad();
  const [items, setItems] = useState<UpcomingDraftVM[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function loadDrafts() {
      setLoading(true);
      setErr(null);

      try {
        const drafts = await fetchPublicCampaignDrafts({
          chainId: activeChainId,
          limit: 12,
        });

        const candidates = drafts
          .filter((draft) => Number(draft.chainId) === Number(activeChainId))
          .filter((draft) => draft.visibility === "public")
          .filter((draft) => UPCOMING_STATUSES.has(draft.status))
          // Keep unarmed prepare pages and armed timed launches; only drop fully deployed.
          .filter((draft) => draft.status !== "deployed")
          .filter((draft) => draft.status === "scheduled" || !draft.campaignAddress)
          .slice(0, 8);

        const hydrated = await Promise.all(
          candidates.map(async (draft) => {
            try {
              const bundle = await fetchCampaignDraft(draft.id);

              return {
                draft: bundle.draft,
                mission:
                  bundle.promotion?.missionStatement ||
                  bundle.promotion?.creatorNote ||
                  bundle.draft.description ||
                  "Creator is preparing the campaign before the battlefield opens.",
                popularity: bundle.popularity ?? null,
              };
            } catch {
              return {
                draft,
                mission:
                  draft.description ||
                  "Creator is preparing the campaign before the battlefield opens.",
                popularity: null,
              };
            }
          })
        );

        const sorted = hydrated.sort((a, b) => {
          const ar = Number(a.popularity?.rankingScore ?? 0);
          const br = Number(b.popularity?.rankingScore ?? 0);

          if (br !== ar) return br - ar;

          return String(b.draft.createdAt).localeCompare(String(a.draft.createdAt));
        });

        if (alive) setItems(sorted);
      } catch (e: any) {
        if (alive) setErr(e?.message || "Failed to load upcoming drafts.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    loadDrafts();

    return () => {
      alive = false;
    };
  }, [activeChainId]);

  const content = useMemo(() => {
    if (loading && items.length === 0) {
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-[260px] animate-pulse border border-success/20 bg-black/40"
            />
          ))}
        </div>
      );
    }

    if (err) {
      return (
        <div className="border border-red-500/30 bg-red-950/20 p-4 text-sm text-red-200">
          {err}
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="border border-success/20 bg-black/40 p-5 text-sm text-success/65">
          No public Prepare Mode drafts yet. When creators publish their promotion pages, they
          will appear here before trading goes live.
        </div>
      );
    }

    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map(({ draft, mission, popularity }) => {
          const heat = popularity?.heatLabel || "Cold";
          const follows = Number(popularity?.follows ?? 0);
          const popularityPct = Number(popularity?.popularityPercentage ?? 0);
          const logo = resolveImageUri(draft.logoUrl) || "/placeholder.svg";

          return (
            <article
              key={draft.id}
              className="mwz-hud-frame group flex min-h-[280px] flex-col border-success/30"
            >
              <Link to={`/prepare/${encodeURIComponent(draft.slug)}`} className="block">
                <div className="relative aspect-[16/10] overflow-hidden border-b border-success/25 bg-black/40">
                  <div className="absolute inset-0 z-10 mwz-stat-grid opacity-25 pointer-events-none" />

                  <img
                    src={logo}
                    alt={draft.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    draggable={false}
                    loading="lazy"
                  />

                  <div className="absolute inset-0 z-20 bg-[linear-gradient(180deg,rgba(56,58,58,0.05),transparent_42%,rgba(56,58,58,0.72))]" />

                  <div className="absolute left-2 top-2 z-30 inline-flex items-center gap-1 border border-success/55 bg-black px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-orange-400">
                    <ShieldCheck className="h-3 w-3" />
                    Prepare Mode
                  </div>

                  <div
                    className={cn(
                      "absolute right-2 top-2 z-30 inline-flex items-center gap-1 border bg-black px-2 py-1 text-[10px] uppercase tracking-[0.12em]",
                      heatClass(heat)
                    )}
                  >
                    <Flame className="h-3 w-3" />
                    {heat}
                  </div>
                </div>
              </Link>

              <div className="flex flex-1 flex-col p-3 text-success">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/prepare/${encodeURIComponent(draft.slug)}`} className="block">
                      <div className="mwz-section-title truncate text-lg leading-none hover:text-orange-400">
                        {draft.name}
                      </div>
                    </Link>

                    <div className="mt-1 truncate text-sm text-success/70">
                      {draft.ticker ? `$${draft.ticker}` : ""}
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-[10px] uppercase tracking-[0.16em] text-success/50">
                    {formatCreatedAt(draft.createdAt)}
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 border-y border-success/20 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-success/45">
                      Creator
                    </div>
                    <div className="truncate text-success/75">
                      <WalletLabel wallet={draft.creatorWallet} />
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-success/45">
                      Readiness
                    </div>
                    <div className="text-success">{readinessLabel(draft.status)}</div>
                  </div>
                </div>

                <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-success/70">
                  {mission}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="border border-success/20 bg-black/40 p-2">
                    <div className="flex items-center gap-1 text-success/50">
                      <Star className="h-3 w-3" />
                      Watchlist
                    </div>
                    <div className="mt-1 text-sm text-success">{follows}</div>
                  </div>

                  <div className="border border-success/20 bg-black/40 p-2">
                    <div className="flex items-center gap-1 text-success/50">
                      <Radio className="h-3 w-3" />
                      Popularity
                    </div>
                    <div className="mt-1 text-sm text-success">
                      {Number.isFinite(popularityPct) ? `${popularityPct}%` : "0%"}
                    </div>
                  </div>
                </div>

                <Link
                  to={`/prepare/${encodeURIComponent(draft.slug)}`}
                  className="mwz-button mwz-button-active mt-auto inline-flex h-9 items-center justify-center px-3 text-[10px] uppercase tracking-[0.16em]"
                >
                  View Prepare Page
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    );
  }, [err, items, loading]);

  return (
    <section className={cn("mwz-card border-success/30 bg-black/55 p-3 md:p-4", className)}>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-orange-400">
            Prepare Mode
          </div>

          <h2 className="mwz-section-title mt-1 text-2xl text-success md:text-3xl">
            Upcoming Drafts
          </h2>

          <p className="mt-1 max-w-2xl text-sm text-success/65">
            Campaigns preparing before trading opens. No buy button, no chart, no liquidity stats —
            only watchlist strength, heat, and launch readiness.
          </p>
        </div>

        <Link
          to="/create"
          className="mwz-button inline-flex h-9 items-center justify-center px-4 text-[10px] uppercase tracking-[0.16em]"
        >
          Create Draft
        </Link>
      </div>

      {content}
    </section>
  );
}
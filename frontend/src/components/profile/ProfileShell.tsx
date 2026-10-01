import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar, Copy, ExternalLink, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { FeedWhoToFollow } from "@/components/feed/FeedCards";
import { ProfileMoreSheet } from "@/components/profile/ProfileMoreSheet";
import { formatCompactUsd } from "@/features/postgrad/warRoomMetrics";
import { normalizeRank, type RankName } from "@/lib/ranks";

export type ProfileTabKey = "posts" | "coins" | "activity";

export type ProfileShellAuthor = {
  wallet: string;
  name?: string | null;
  avatar?: string | null;
};

type Props = {
  walletAddress: string;
  displayName?: string | null;
  handle?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  rank?: RankName | string | null;
  createdAt?: string | null;
  explorerUrl: string;
  followersCount: number;
  followingCount: number;
  coinsCount: number;
  loadingFollows?: boolean;
  recruiterLoading?: boolean;
  isRecruiter?: boolean;
  recruiterCode?: string | null;
  recruiterName?: string | null;
  squadCode?: string | null;
  squadName?: string | null;
  totalValueUsd?: number | null;
  loadingTotalValue?: boolean;
  isOwner: boolean;
  isFollowing?: boolean;
  followBusy?: boolean;
  onFollow?: () => void;
  onEdit?: () => void;
  commandBasePath: string;
  tab: ProfileTabKey;
  onTabChange: (tab: ProfileTabKey) => void;
  followSuggestions?: ProfileShellAuthor[];
  followersHref?: string;
  followingHref?: string;
  children: ReactNode;
};

function shorten(addr?: string | null) {
  if (!addr) return "";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatJoined(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function formatCount(value: number) {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString();
}

function formatCode(value?: string | null) {
  const raw = String(value || "").trim().replace(/^\/+/, "");
  return raw ? `/${raw}` : null;
}

function identityValue(code?: string | null, name?: string | null) {
  const formatted = formatCode(code);
  const label = String(name || "").trim();
  if (formatted && label && label.toLowerCase() !== formatted.slice(1).toLowerCase()) {
    return `${formatted} · ${label}`;
  }
  return formatted || label || null;
}

const TABS: Array<{ key: ProfileTabKey; label: string }> = [
  { key: "posts", label: "Posts" },
  { key: "coins", label: "Coins" },
  { key: "activity", label: "Activity" },
];

export function ProfileShell({
  walletAddress,
  displayName,
  handle,
  bio,
  avatarUrl,
  bannerUrl,
  rank,
  createdAt,
  explorerUrl,
  followersCount,
  followingCount,
  coinsCount,
  loadingFollows,
  recruiterLoading,
  isRecruiter,
  recruiterCode,
  recruiterName,
  squadCode,
  squadName,
  totalValueUsd,
  loadingTotalValue,
  isOwner,
  isFollowing,
  followBusy,
  onFollow,
  onEdit,
  commandBasePath,
  tab,
  onTabChange,
  followSuggestions = [],
  followersHref,
  followingHref,
  children,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const title = (displayName || "").trim() || shorten(walletAddress);
  const atHandle = (handle || "").trim() || (displayName ? `@${displayName}` : null);
  const joined = formatJoined(createdAt);
  const resolvedRank = rank ? normalizeRank(rank) : null;
  const initials = useMemo(() => {
    const raw = (displayName || walletAddress || "?").replace(/^@/, "");
    return raw.slice(0, 2).toUpperCase();
  }, [displayName, walletAddress]);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy address");
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-0 pb-10 pt-4 md:px-4 md:pt-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 overflow-hidden border-border/40 md:border-x">
          <div
            className="relative h-32 w-full md:h-[200px]"
            data-profile-cover="true"
            style={
              bannerUrl
                ? undefined
                : {
                    background:
                      "radial-gradient(120% 90% at 72% 18%, hsl(var(--accent) / 0.38), transparent 52%), linear-gradient(180deg, #24160c 0%, #050505 78%)",
                  }
            }
          >
            {bannerUrl ? (
              <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="pointer-events-none absolute inset-0" data-profile-cover-empty="true" />
            )}
          </div>

          <div className="px-4">
            <div className="flex items-end justify-between">
              <div className="-mt-12 h-24 w-24 overflow-hidden rounded-none bg-background md:-mt-16 md:h-32 md:w-32" data-profile-avatar="true">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={title} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-card font-retro text-2xl text-accent">
                    {initials}
                  </div>
                )}
              </div>

              <div className="mb-1 flex items-center gap-2">
                {isOwner ? (
                  <>
                    <button
                      type="button"
                      onClick={onEdit}
                      className="rounded-full border border-accent px-4 py-2 font-retro text-xs uppercase tracking-[0.14em] text-accent"
                    >
                      Edit profile
                    </button>
                    <button
                      type="button"
                      aria-label="More"
                      data-profile-more="true"
                      onClick={() => setMoreOpen(true)}
                      className="flex h-10 w-10 items-center justify-center rounded-full border border-accent text-accent"
                    >
                      <MoreHorizontal className="h-5 w-5" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={onFollow}
                    disabled={followBusy}
                    className={
                      isFollowing
                        ? "rounded-full border border-border px-5 py-2 font-retro text-sm text-foreground"
                        : "rounded-full bg-accent px-5 py-2 font-retro text-sm text-accent-foreground"
                    }
                  >
                    {followBusy ? "Updating…" : isFollowing ? "Following" : "Follow +"}
                  </button>
                )}
              </div>
            </div>

            <h1 className="mt-3 flex flex-wrap items-center gap-2 font-retro text-2xl text-foreground">
              {title}
              {resolvedRank ? (
                <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] text-accent">
                  {resolvedRank}
                </span>
              ) : null}
            </h1>
            {atHandle ? <div className="mt-0.5 text-sm text-muted-foreground">{atHandle.startsWith("@") ? atHandle : `@${atHandle}`}</div> : null}
            {bio ? <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{bio}</p> : null}

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <button type="button" onClick={() => void copyAddress()} className="inline-flex items-center gap-1 hover:text-foreground">
                📍 {shorten(walletAddress)}
              </button>
              {joined ? (
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Joined {joined}
                </span>
              ) : null}
              <button type="button" onClick={() => void copyAddress()} className="inline-flex items-center gap-1 hover:text-foreground" title="Copy address">
                <Copy className="h-3.5 w-3.5" />
              </button>
              <a href={explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                Explorer <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <div className="mt-3 grid gap-1 text-sm" data-profile-identity="true">
              <div className="flex flex-wrap items-baseline gap-x-2" data-profile-recruiter="true">
                <span className="text-muted-foreground">Recruiter</span>
                {recruiterLoading ? (
                  <span className="text-muted-foreground">…</span>
                ) : isRecruiter && recruiterCode ? (
                  <Link to={`/recruiters/${encodeURIComponent(recruiterCode)}`} className="text-accent hover:underline">
                    {identityValue(recruiterCode, recruiterName)}
                  </Link>
                ) : (
                  <span className="text-foreground">Not a recruiter</span>
                )}
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2" data-profile-squad="true">
                <span className="text-muted-foreground">Squad</span>
                {recruiterLoading ? (
                  <span className="text-muted-foreground">…</span>
                ) : squadCode ? (
                  <Link to={`/recruiters/${encodeURIComponent(squadCode)}`} className="text-accent hover:underline">
                    {identityValue(squadCode, squadName)}
                  </Link>
                ) : (
                  <span className="text-foreground">No squad</span>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <span data-profile-total-value="true">
                <b className="text-foreground">
                  {loadingTotalValue ? "…" : totalValueUsd != null && totalValueUsd > 0 ? formatCompactUsd(totalValueUsd) : "—"}
                </b>{" "}
                <span className="text-muted-foreground">Total value</span>
              </span>
              <Link to={followingHref || "#"} className="hover:underline">
                <b className="text-foreground">{loadingFollows ? "…" : formatCount(followingCount)}</b>{" "}
                <span className="text-muted-foreground">Following</span>
              </Link>
              <Link to={followersHref || "#"} className="hover:underline">
                <b className="text-foreground">{loadingFollows ? "…" : formatCount(followersCount)}</b>{" "}
                <span className="text-muted-foreground">Followers</span>
              </Link>
              <span>
                <b className="text-foreground">{formatCount(coinsCount)}</b>{" "}
                <span className="text-muted-foreground">Coins</span>
              </span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 border-b border-border/40">
            {TABS.map((item) => {
              const on = tab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-profile-tab={item.key}
                  onClick={() => onTabChange(item.key)}
                  className={`relative py-3 font-retro text-sm ${on ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {item.label}
                  {on ? <span className="absolute inset-x-8 bottom-0 h-1 rounded-t bg-accent" /> : null}
                </button>
              );
            })}
          </div>

          {children}
        </div>

        <aside className="hidden px-4 lg:block lg:px-0">
          <FeedWhoToFollow authors={followSuggestions} />
        </aside>
      </div>

      {isOwner ? (
        <ProfileMoreSheet open={moreOpen} onOpenChange={setMoreOpen} basePath={commandBasePath} />
      ) : null}
    </div>
  );
}

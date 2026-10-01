import { Link } from "react-router-dom";
import { Eye, MessageCircle, Repeat2, Rocket } from "lucide-react";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import type { FeedItem } from "@/lib/feedApi";

function shorten(addr?: string | null) {
  if (!addr) return "";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function timeAgo(createdAt?: string | null) {
  if (!createdAt) return "";
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return "now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function profileHref(wallet?: string | null) {
  if (!wallet) return "/profile";
  return `/profile/${wallet}`;
}

function tokenHref(item: FeedItem) {
  return tokenDetailsPath({
    tokenAddress: item.tokenAddress || item.mentionedToken,
    campaignAddress: item.campaignAddress || item.mentionedCampaign,
    chainId: item.chainId || item.mentionedChainId,
  });
}

function formatCount(value?: number | null) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.floor(n));
}

export function ProfilePostCard({ item }: { item: FeedItem }) {
  const ticker = item.tokenTicker || item.ticker;
  const tokenName = item.tokenName || item.name;
  const logo = item.tokenLogoUri || item.logoUri || "/placeholder.svg";
  const path = tokenHref(item);
  const title = item.authorDisplayName || shorten(item.wallet);
  const handle = item.authorDisplayName ? `@${item.authorDisplayName}` : null;
  const likeCount = formatCount(item.likeCount);
  const repostCount = formatCount(item.repostCount);
  const replyCount = formatCount(item.replyCount);
  const viewCount = formatCount(item.viewCount);

  return (
    <article className="border-b border-border/40 px-4 py-4">
      <div className="flex items-start gap-3">
        <Link to={profileHref(item.wallet)} className="shrink-0">
          <img
            src={item.authorAvatarUrl || "/placeholder.svg"}
            alt=""
            className="h-10 w-10 rounded-md object-cover"
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Link to={profileHref(item.wallet)} className="truncate font-retro text-sm text-foreground hover:text-accent">
              {title}
            </Link>
            {handle ? <span>{handle}</span> : null}
            <span>· {timeAgo(item.createdAt)}</span>
          </div>
          {item.body ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{item.body}</p>
          ) : null}
          {(item.mentionedCampaign || item.mentionedToken || ticker) && (
            <Link
              to={path && path !== "/" ? path : profileHref(item.wallet)}
              className="mt-3 flex items-center gap-3 rounded-xl border border-border/40 bg-card/40 p-3 hover:border-accent/50"
            >
              <img src={logo} alt="" className="h-10 w-10 rounded-md object-cover" />
              <div className="min-w-0">
                <div className="truncate font-retro text-sm text-foreground">{tokenName || "Token"}</div>
                <div className="text-xs text-muted-foreground">{ticker ? `$${ticker}` : "Market card"}</div>
              </div>
            </Link>
          )}
          <div className="mt-3 flex items-center justify-between gap-2 text-muted-foreground sm:max-w-[420px]">
            <span className="inline-flex items-center gap-1.5 text-xs">
              <Rocket className="h-4 w-4 text-accent" />
              {likeCount}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <Repeat2 className="h-4 w-4" />
              {repostCount}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <MessageCircle className="h-4 w-4" />
              {replyCount}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <Eye className="h-4 w-4" />
              {viewCount}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

export function ProfileFeedItem({ item }: { item: FeedItem }) {
  if (item.type === "post") return <ProfilePostCard item={item} />;
  return null;
}

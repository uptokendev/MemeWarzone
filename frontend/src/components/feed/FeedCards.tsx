import { Link, useNavigate } from "react-router-dom";
import { isSolanaAddress } from "@/lib/address";
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

export function FeedPostCard({ item }: { item: FeedItem }) {
  const ticker = item.tokenTicker || item.ticker;
  const tokenName = item.tokenName || item.name;
  const logo = item.tokenLogoUri || item.logoUri || "/placeholder.svg";
  const path = tokenHref(item);

  return (
    <article className="rounded-2xl border border-border/40 bg-background/30 p-4">
      <div className="flex items-start gap-3">
        <Link to={profileHref(item.wallet)} className="shrink-0">
          <img
            src={item.authorAvatarUrl || "/placeholder.svg"}
            alt=""
            className="h-10 w-10 rounded-full object-cover"
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link to={profileHref(item.wallet)} className="truncate font-retro text-sm text-foreground hover:text-accent">
              {item.authorDisplayName ? `@${item.authorDisplayName}` : shorten(item.wallet)}
            </Link>
            <span>{timeAgo(item.createdAt)}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{item.body}</p>
          {(item.mentionedCampaign || item.mentionedToken || ticker) && (
            <Link
              to={path && path !== "/" ? path : profileHref(item.wallet)}
              className="mt-3 flex items-center gap-3 rounded-xl border border-border/40 bg-card/40 p-3 hover:border-accent/50"
            >
              <img src={logo} alt="" className="h-10 w-10 rounded-full object-cover" />
              <div className="min-w-0">
                <div className="truncate font-retro text-sm text-foreground">{tokenName || "Token"}</div>
                <div className="text-xs text-muted-foreground">{ticker ? `$${ticker}` : "Market card"}</div>
              </div>
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

export function FeedSystemCard({ item }: { item: FeedItem }) {
  const navigate = useNavigate();
  const ticker = item.ticker || item.campaignSymbol;
  const name = item.name || item.campaignName || shorten(item.campaignAddress);
  const logo = item.logoUri || "/placeholder.svg";
  const verb = item.type === "draft_created" ? "opened a draft" : "deployed";
  const href = item.type === "draft_created" && item.slug
    ? `/prepare/${item.slug}`
    : tokenHref(item);

  return (
    <button
      type="button"
      onClick={() => {
        if (href && href !== "/") navigate(href);
      }}
      className="flex w-full items-center gap-3 rounded-2xl border border-border/40 bg-background/30 p-4 text-left hover:border-accent/50"
    >
      <img src={logo} alt="" className="h-11 w-11 rounded-full object-cover" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">
          <Link to={profileHref(item.wallet)} className="text-foreground hover:text-accent" onClick={(e) => e.stopPropagation()}>
            {shorten(item.wallet)}
          </Link>
          {" "}{verb}{" "}
          <span className="font-retro text-foreground">{name}</span>
          {ticker ? ` $${ticker}` : ""}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{timeAgo(item.createdAt)}</div>
      </div>
    </button>
  );
}

function nativeSymbol(chainId?: number | null) {
  if (Number(chainId) === 101 || Number(chainId) === 102) return "SOL";
  if (Number(chainId) === 4663 || Number(chainId) === 46630) return "ETH";
  return "BNB";
}

export function FeedTradeCard({ item }: { item: FeedItem }) {
  const navigate = useNavigate();
  const path = tokenHref(item);
  const amount = item.bnbAmount == null || !Number.isFinite(item.bnbAmount)
    ? null
    : `${Number(item.bnbAmount).toLocaleString(undefined, { maximumFractionDigits: 5 })} ${nativeSymbol(item.chainId)}`;
  return (
    <button
      type="button"
      onClick={() => {
        if (path && path !== "/") navigate(path);
      }}
      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border/40 bg-background/30 p-4 text-left hover:border-accent/50"
    >
      <div className="flex min-w-0 items-center gap-3">
        <img src={item.logoUri || "/placeholder.svg"} alt="" className="h-10 w-10 rounded-full object-cover" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={item.side === "sell" ? "text-orange-400" : "text-emerald-400"}>
              {String(item.side || "buy").toUpperCase()}
            </span>
            <span className="truncate font-retro text-sm text-foreground">
              {item.campaignName || shorten(item.campaignAddress)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {item.campaignSymbol ? `$${item.campaignSymbol}` : "Token"} · {timeAgo(item.createdAt || item.blockTime)}
          </div>
        </div>
      </div>
      {amount ? (
        <div className="shrink-0 text-right text-xs text-foreground">{amount}</div>
      ) : null}
    </button>
  );
}

export function FeedItemView({ item }: { item: FeedItem }) {
  if (item.type === "post") return <FeedPostCard item={item} />;
  if (item.type === "trade") return <FeedTradeCard item={item} />;
  return <FeedSystemCard item={item} />;
}

export function FeedWhoToFollow({ authors }: { authors: Array<{ wallet: string; name?: string | null; avatar?: string | null }> }) {
  if (!authors.length) return null;
  return (
    <aside className="rounded-2xl border border-border/50 bg-card/35 p-4">
      <div className="mb-3 font-retro text-sm text-foreground">Who to follow</div>
      <div className="space-y-3">
        {authors.slice(0, 5).map((author) => (
          <Link
            key={author.wallet}
            to={profileHref(author.wallet)}
            className="flex items-center gap-3 rounded-xl p-2 hover:bg-background/40"
          >
            <img src={author.avatar || "/placeholder.svg"} alt="" className="h-9 w-9 rounded-full object-cover" />
            <div className="min-w-0">
              <div className="truncate text-sm text-foreground">
                {author.name ? `@${author.name}` : shorten(author.wallet)}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {isSolanaAddress(author.wallet) ? "Solana" : "Wallet"}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </aside>
  );
}

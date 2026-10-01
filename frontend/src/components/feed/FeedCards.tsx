import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageCircle, Repeat2, Rocket } from "lucide-react";
import { toast } from "sonner";
import { isSolanaAddress } from "@/lib/address";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import {
  FEED_MAX_CHARS,
  FEED_PREVIEW_CHARS,
  createFeedReply,
  fetchPostReplies,
  toggleFeedFire,
  toggleFeedRepost,
  type FeedItem,
  type FeedSuggestion,
} from "@/lib/feedApi";
import { useFeedSession } from "@/hooks/useFeedSession";

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

function FeedBody({ body }: { body?: string | null }) {
  const [open, setOpen] = useState(false);
  const text = String(body || "");
  const collapsed = text.length > FEED_PREVIEW_CHARS;
  const shown = open || !collapsed ? text : `${text.slice(0, FEED_PREVIEW_CHARS).trimEnd()}…`;
  return (
    <>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{shown}</p>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 text-xs text-accent hover:underline"
        >
          {open ? "Show less" : "Read more"}
        </button>
      ) : null}
    </>
  );
}

function countLabel(n?: number) {
  const value = Number(n || 0);
  return value > 0 ? String(value) : "";
}

function FeedPostActions({
  item,
  onChanged,
}: {
  item: FeedItem;
  onChanged?: () => void;
}) {
  const { account, withSession, busy } = useFeedSession();
  const [fireCount, setFireCount] = useState(Number(item.fireCount || 0));
  const [replyCount, setReplyCount] = useState(Number(item.replyCount || 0));
  const [repostCount, setRepostCount] = useState(Number(item.repostCount || 0));
  const [fired, setFired] = useState(Boolean(item.firedByMe));
  const [reposted, setReposted] = useState(Boolean(item.repostedByMe));
  const [replyOpen, setReplyOpen] = useState(false);
  const [replies, setReplies] = useState<FeedItem[] | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [working, setWorking] = useState(false);
  const postId = Number(item.postId || 0);

  const loadReplies = async () => {
    if (!postId) return;
    const next = await fetchPostReplies(postId, account);
    setReplies(next);
  };

  const run = async (fn: () => Promise<void>) => {
    if (!postId || working || busy) return;
    setWorking(true);
    try {
      await fn();
    } catch (err: unknown) {
      toast.error(String((err as Error)?.message || "Action failed"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="flex items-center gap-5 text-muted-foreground">
        <button
          type="button"
          disabled={working || busy}
          onClick={() =>
            void run(async () => {
              setReplyOpen((open) => !open);
              if (replies == null) await loadReplies();
            })
          }
          className="inline-flex items-center gap-1.5 text-xs hover:text-accent"
        >
          <MessageCircle className="h-4 w-4" />
          {countLabel(replyCount)}
        </button>
        <button
          type="button"
          disabled={working || busy}
          onClick={() =>
            void run(async () => {
              const result = await withSession((token) => toggleFeedRepost(postId, token));
              setReposted(result.on);
              setRepostCount(result.repostCount);
              onChanged?.();
            })
          }
          className={`inline-flex items-center gap-1.5 text-xs hover:text-emerald-400 ${reposted ? "text-emerald-400" : ""}`}
        >
          <Repeat2 className="h-4 w-4" />
          {countLabel(repostCount)}
        </button>
        <button
          type="button"
          disabled={working || busy}
          onClick={() =>
            void run(async () => {
              const result = await withSession((token) => toggleFeedFire(postId, token));
              setFired(result.on);
              setFireCount(result.fireCount);
            })
          }
          className={`inline-flex items-center gap-1.5 text-xs hover:text-orange-400 ${fired ? "text-orange-400" : ""}`}
        >
          <Rocket className="h-4 w-4" />
          {countLabel(fireCount)}
        </button>
      </div>

      {replyOpen ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-border/40 bg-background/40 p-3">
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value.slice(0, FEED_MAX_CHARS))}
              placeholder="Reply"
              rows={2}
              className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={working || busy || !replyBody.trim()}
                onClick={() =>
                  void run(async () => {
                    const result = await withSession((token) => createFeedReply(postId, token, replyBody.trim()));
                    setReplyBody("");
                    setReplyCount(result.replyCount);
                    await loadReplies();
                    toast.success("Replied.");
                  })
                }
                className="rounded-full bg-accent px-3 py-1 font-retro text-[10px] uppercase tracking-[0.14em] text-black disabled:opacity-40"
              >
                Reply
              </button>
            </div>
          </div>
          {replies?.length ? (
            <div className="space-y-2 pl-2">
              {replies.map((reply) => (
                <div key={reply.id} className="rounded-xl border border-border/30 bg-background/20 p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Link to={profileHref(reply.wallet)} className="font-retro text-foreground hover:text-accent">
                      {reply.authorDisplayName ? `@${reply.authorDisplayName}` : shorten(reply.wallet)}
                    </Link>
                    <span>{timeAgo(reply.createdAt)}</span>
                  </div>
                  <FeedBody body={reply.body} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FeedPostCard({ item, onChanged }: { item: FeedItem; onChanged?: () => void }) {
  const ticker = item.tokenTicker || item.ticker;
  const tokenName = item.tokenName || item.name;
  const logo = item.tokenLogoUri || item.logoUri || "/placeholder.svg";
  const path = tokenHref(item);
  const reposter = item.repostedByDisplayName
    ? `@${item.repostedByDisplayName}`
    : item.repostedByWallet
      ? shorten(item.repostedByWallet)
      : null;

  return (
    <article className="rounded-2xl border border-border/40 bg-background/30 p-4">
      {reposter ? (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Repeat2 className="h-3 w-3" />
          <Link to={profileHref(item.repostedByWallet)} className="hover:text-accent">
            {reposter}
          </Link>
          <span>reposted</span>
        </div>
      ) : null}
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
          <FeedBody body={item.body} />
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
          {item.postId ? <FeedPostActions item={item} onChanged={onChanged} /> : null}
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
            {item.authorDisplayName ? `@${item.authorDisplayName}` : shorten(item.wallet)}
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

export function FeedItemView({ item, onChanged }: { item: FeedItem; onChanged?: () => void }) {
  if (item.type === "post") return <FeedPostCard item={item} onChanged={onChanged} />;
  if (item.type === "trade") return <FeedTradeCard item={item} />;
  return <FeedSystemCard item={item} />;
}

export function FeedWhoToFollow({ authors }: { authors: FeedSuggestion[] }) {
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

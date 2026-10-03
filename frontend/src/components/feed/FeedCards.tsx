import { useEffect, useRef, useState } from "react";
import { ItemMenu } from "@/components/moderation/ItemMenu";
import { useModeration } from "@/hooks/useModeration";
import { CoinPriceLine, CoinSparkline, useCoinMiniMarket } from "@/components/feed/CoinSparkline";
import { PostImage } from "@/components/feed/PostImage";
import { MentionField } from "@/components/feed/MentionField";
import { OperativeMark } from "@/components/ui-v2/OperativeMark";
import { Link, useNavigate } from "react-router-dom";
import { BarChart2, GraduationCap, ImagePlus, Link2, MessageCircle, PenLine, Repeat2, Rocket, Rocket as LaunchIcon, Share2, Swords, TrendingUp, Trophy, X } from "lucide-react";
import { toast } from "sonner";
import { isSolanaAddress } from "@/lib/address";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import {
  FEED_PREVIEW_CHARS,
  feedViewerKey,
  queueFeedView,
  toggleFeedFire,
  deleteFeedPost,
  toggleFeedRepost,
  type FeedItem,
  type FeedSuggestion,
} from "@/lib/feedApi";
import { useFeedSession } from "@/hooks/useFeedSession";
import { readStoredFeedSession } from "@/lib/feedSession";
import { usePostComposer } from "@/components/feed/usePostComposer";

/* UI redesign phase 2: cards in the artboard style. Fire / repost / session behaviour is unchanged;
   the reply button opens the thread page (/post/:id), where replies are written. */

function shorten(addr?: string | null) {
  if (!addr) return "";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function timeAgo(createdAt?: string | null) {
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

export function postHref(postId?: number | null) {
  return postId ? `/post/${postId}` : "/";
}

function tokenHref(item: FeedItem) {
  return tokenDetailsPath({
    tokenAddress: item.tokenAddress || item.mentionedToken,
    campaignAddress: item.campaignAddress || item.mentionedCampaign,
    chainId: item.chainId || item.mentionedChainId,
  });
}

function chainLabel(chainId?: number | null) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "Solana";
  if (id === 4663 || id === 46630) return "Robinhood";
  if (id === 56 || id === 97) return "BNB";
  return null;
}

const card = "rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text";
const actBase =
  "mw-focus inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors hover:bg-[#171B20] disabled:opacity-50";
const act = `${actBase} text-mw-muted hover:text-mw-text`;
/** Active state replaces the grey (rocket orange, repost green) instead of competing with it. */
const actOn = (on: boolean, color: string) => (on ? `${actBase} ${color}` : act);
const chip = "inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold";

export function FeedAvatar({ url, label, square = false, size = 44 }: { url?: string | null; label: string; square?: boolean; size?: number }) {
  const [failed, setFailed] = useState(false);
  const shape = square ? "rounded-[12px]" : "rounded-full";
  const style = { width: size, height: size };
  if (url && !failed) {
    return <img src={url} alt="" style={style} onError={() => setFailed(true)} className={`${shape} shrink-0 border border-mw-border object-cover`} />;
  }
  // People without a picture get the operative mark (founder, 2026-10-02); coins keep the ticker letters.
  if (!square) return <OperativeMark size={size} />;
  return (
    <span style={style} className={`${shape} flex shrink-0 items-center justify-center bg-[#2B3440] font-mw-cond text-sm font-bold text-mw-text`} aria-hidden="true">
      {label.replace(/^[@$]/, "").slice(0, 2).toUpperCase() || "MW"}
    </span>
  );
}

/** Counts a view once a post card has been on screen for about a second (one view per viewer per post). */
function useViewTracking(postId?: number | null) {
  const ref = useRef<HTMLElement | null>(null);
  const { account, chainId } = useFeedSession();
  useEffect(() => {
    const el = ref.current;
    if (!el || !postId || typeof IntersectionObserver === "undefined") return;
    let timer: number | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          timer = window.setTimeout(() => {
            queueFeedView(Number(postId), feedViewerKey(account), account ? readStoredFeedSession(account, chainId) : null);
            observer.disconnect();
          }, 1000);
        } else if (timer != null) {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, 0.5] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [postId, account]);
  return ref;
}

function compactCount(n?: number | null) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

const MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g;

/** @username in a post opens that profile (founder, 2026-10-02). The body sits inside the post link, so this is a button, not a nested link. */
export function MentionText({ text }: { text: string }) {
  const navigate = useNavigate();
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) parts.push(text.slice(last, start));
    const handle = m[2];
    parts.push(
      <span
        key={`${start}-${handle}`}
        role="link"
        tabIndex={0}
        data-mention={handle}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          navigate(`/profile/${handle}`);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.stopPropagation();
          navigate(`/profile/${handle}`);
        }}
        className="mw-focus cursor-pointer font-semibold text-mw-accent-soft hover:text-[#FFD0A8]"
      >
        @{handle}
      </span>,
    );
    last = start + handle.length + 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function absoluteUrl(path: string) {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}

/** Display name, else @username, else the short wallet (founder, 2026-10-02: names instead of addresses). */
function personName(displayName?: string | null, handle?: string | null, wallet?: string | null) {
  const name = String(displayName || "").trim();
  if (name) return name;
  if (handle) return `@${handle}`;
  return shorten(wallet);
}

export function FeedBody({ body, big = false }: { body?: string | null; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const text = String(body || "");
  const collapsed = !big && text.length > FEED_PREVIEW_CHARS;
  const shown = open || !collapsed ? text : `${text.slice(0, FEED_PREVIEW_CHARS).trimEnd()}…`;
  return (
    <>
      <p className={`m-0 mt-1 whitespace-pre-wrap break-words ${big ? "text-lg leading-relaxed" : "text-[15px]"}`}><MentionText text={shown} /></p>
      {collapsed ? (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            setOpen((value) => !value);
          }}
          className="mw-focus mt-1 text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]"
        >
          {open ? "Show less" : "Read more"}
        </button>
      ) : null}
    </>
  );
}

/** Coin card attached to a post (artboard): logo, name, ticker, chain, Buy (opens the coin page). */
export function FeedCoinCard({ item }: { item: FeedItem }) {
  const ticker = item.tokenTicker || item.ticker;
  const name = item.tokenName || item.name || (ticker ? `$${ticker}` : "Coin");
  const path = tokenHref(item);
  const chain = chainLabel(item.chainId || item.mentionedChainId);
  const href = path && path !== "/" ? path : null;
  // Founder 2026-10-03: price, change and a price line on the card (like cashtags on X, from the CA).
  const market = useCoinMiniMarket({
    chainId: item.chainId || item.mentionedChainId,
    campaign: item.campaignAddress || item.mentionedCampaign,
    token: item.tokenAddress || item.mentionedToken,
  });
  return (
    <div ref={market.ref} className="mt-3 rounded-[14px] border border-mw-border bg-mw-input p-3.5" style={{ containerType: "inline-size", containerName: "coin-card" }}>
      {/* Narrow cards (phones, the thread's side card) tighten logo, gaps and Buy: rule in mw-v2.css. */}
      <div className="flex items-center gap-3.5" data-coin-row="true">
        <span className="shrink-0" data-coin-logo="true">
          <FeedAvatar url={item.tokenLogoUri || item.logoUri} label={ticker || name} square size={56} />
        </span>
        <div className="min-w-[84px] flex-1" data-coin-text="true">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-bold">{name}</span>
            {ticker && market.priceUsd == null && market.change == null ? <span className={`${chip} border-mw-edge font-mw-mono text-[#C9CED4]`}>${String(ticker).replace(/^\$/, "")}</span> : null}
            {chain ? <span className={`${chip} border-mw-edge text-[#C9CED4]`}>{chain}</span> : null}
          </div>
          {/* With a price the ticker moves into the price line: "$K88 $0.000026 +80.4%" (founder's X example). */}
          <CoinPriceLine ticker={ticker} priceUsd={market.priceUsd} change={market.change} />
        </div>
        <CoinSparkline values={market.values} />
        {href ? (
          <Link to={href} data-coin-buy="true" className="mw-focus inline-flex min-h-11 shrink-0 items-center rounded-[10px] border border-mw-buy bg-mw-buy px-4 text-sm font-bold text-[#04140A] hover:bg-[#15913F] hover:text-[#04140A]">
            Buy
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function QuotedPost({ quoted }: { quoted: NonNullable<FeedItem["quoted"]> }) {
  const label = personName(quoted.authorDisplayName, quoted.authorHandle, quoted.wallet);
  return (
    <Link to={postHref(quoted.postId)} className="mw-focus mt-3 flex gap-2.5 rounded-[14px] border border-mw-border bg-mw-input p-3 text-mw-text hover:border-[#3A424C] hover:text-mw-text">
      <FeedAvatar url={quoted.authorAvatarUrl} label={label} size={32} />
      <div className="min-w-0">
        <div className="flex gap-1.5 text-[13px]">
          <b className="truncate">{label}</b>
          <span className="text-mw-muted">· {timeAgo(quoted.createdAt)}</span>
        </div>
        <p className="m-0 mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm">{quoted.body}</p>
      </div>
    </Link>
  );
}

/** Quote dialog (artboard repost popup → Quote post): your take on top, the original below. */
function QuoteDialog({ item, onClose, onPosted }: { item: FeedItem; onClose: () => void; onPosted?: () => void }) {
  const composer = usePostComposer({ quoteOf: item.postId, onPosted });
  const label = personName(item.authorDisplayName, item.authorHandle, item.wallet);
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-[rgba(5,6,8,0.75)] sm:items-center" role="dialog" aria-modal="true" aria-label="Quote post">
      <div className="flex w-full flex-col gap-3 rounded-t-[20px] border border-[#2E353D] bg-mw-surface p-4 font-mw-body text-mw-text sm:w-[560px] sm:rounded-[18px]">
        <div className="flex items-center gap-2.5">
          <button type="button" onClick={onClose} aria-label="Close" className="mw-focus inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-mw-text hover:bg-[#171B20]">
            <X className="h-5 w-5" />
          </button>
          <span className="flex-1 font-mw-cond text-xl font-bold">Quote post</span>
          <button
            type="button"
            disabled={!composer.canPost}
            onClick={() => void composer.submit().then((ok) => ok && onClose())}
            className="mw-focus inline-flex min-h-9 items-center rounded-[10px] border border-mw-accent bg-mw-accent px-3 text-sm font-bold text-[#140A02] disabled:opacity-50"
          >
            {composer.posting ? "Posting..." : "Post"}
          </button>
        </div>
        <MentionField
          multiline
          wrapperClassName="w-full"
          value={composer.body}
          onChange={composer.setBody}
          rows={3}
          placeholder="Add your take"
          aria-label="Your comment"
          className="mw-focus w-full resize-none rounded-[10px] border border-[#2E353D] bg-mw-input p-3 text-[15px] text-mw-text placeholder:text-[#5C6670]"
        />
        <div className="flex gap-2.5 rounded-[14px] border border-mw-border bg-mw-input p-3">
          <FeedAvatar url={item.authorAvatarUrl} label={label} size={32} />
          <div className="min-w-0">
            <div className="flex gap-1.5 text-[13px]"><b className="truncate">{label}</b><span className="text-mw-muted">· {timeAgo(item.createdAt)}</span></div>
            <p className="m-0 mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm">{item.body}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-mw-muted">
          <ImagePickButton onPick={composer.setFile} disabled={composer.posting} />
          <span>{composer.file ? composer.file.name : "A contract address in your text adds a coin card."}</span>
        </div>
      </div>
    </div>
  );
}

function countLabel(n?: number) {
  const value = Number(n || 0);
  return value > 0 ? String(value) : "";
}

export function FeedPostActions({ item, onChanged, big = false }: { item: FeedItem; onChanged?: () => void; big?: boolean }) {
  const { withSession, busy } = useFeedSession();
  const [fireCount, setFireCount] = useState(Number(item.fireCount || 0));
  const [repostCount, setRepostCount] = useState(Number(item.repostCount || 0));
  const [fired, setFired] = useState(Boolean(item.firedByMe));
  const [reposted, setReposted] = useState(Boolean(item.repostedByMe));
  const [menuOpen, setMenuOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const postId = Number(item.postId || 0);

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

  const [shareOpen, setShareOpen] = useState(false);
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${postHref(postId)}` : postHref(postId);
  const copyLink = async () => {
    setShareOpen(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy the link.");
    }
  };
  const shareOnX = () => {
    setShareOpen(false);
    const text = String(item.body || "").slice(0, 200);
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`, "_blank", "noopener,noreferrer");
  };

  return (
    <>
      {big ? (
        <div className="mt-3 flex gap-5 border-y border-[#1E2329] py-3 text-[15px]">
          <span><b>{repostCount}</b> <span className="text-mw-muted">reposts</span></span>
          <span><b>{fireCount}</b> <span className="text-mw-muted">rockets</span></span>
          <span><b>{Number(item.replyCount || 0)}</b> <span className="text-mw-muted">replies</span></span>
          <span><b>{compactCount(item.viewCount)}</b> <span className="text-mw-muted">views</span></span>
        </div>
      ) : null}
      <div className={big ? "flex items-center justify-around pt-1.5" : "-ml-2.5 mt-2 flex items-center gap-1"}>
        <Link to={postHref(postId)} className={act} aria-label={`${Number(item.replyCount || 0)} replies, open the thread`}>
          <MessageCircle className="h-[18px] w-[18px]" />
          {big ? null : <span>{countLabel(item.replyCount)}</span>}
        </Link>
        <div className="relative">
          <button
            type="button"
            disabled={working || busy}
            aria-label="Repost or quote"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className={actOn(reposted, "text-[#4ADE80]")}
          >
            <Repeat2 className="h-[18px] w-[18px]" />
            {big ? null : <span>{countLabel(repostCount)}</span>}
          </button>
          {menuOpen ? (
            <>
              <button type="button" aria-label="Close menu" className="fixed inset-0 z-[60] cursor-default" onClick={() => setMenuOpen(false)} />
              <div role="menu" aria-label="Repost" className="absolute left-0 top-11 z-[61] flex w-[220px] flex-col gap-1 rounded-[16px] border border-[#2E353D] bg-mw-surface p-2 shadow-xl">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    void run(async () => {
                      setMenuOpen(false);
                      const result = await withSession((token) => toggleFeedRepost(postId, token));
                      setReposted(result.on);
                      setRepostCount(result.repostCount);
                      onChanged?.();
                    })
                  }
                  className="mw-focus flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left font-bold text-mw-text hover:bg-[#171B20]"
                >
                  <Repeat2 className="h-[18px] w-[18px]" />
                  {reposted ? "Undo repost" : "Repost"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setQuoteOpen(true);
                  }}
                  className="mw-focus flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left font-bold text-mw-text hover:bg-[#171B20]"
                >
                  <PenLine className="h-[18px] w-[18px]" />
                  Quote post
                </button>
              </div>
            </>
          ) : null}
        </div>
        <button
          type="button"
          disabled={working || busy}
          aria-label="Rocket this post"
          aria-pressed={fired}
          onClick={() =>
            void run(async () => {
              const result = await withSession((token) => toggleFeedFire(postId, token));
              setFired(result.on);
              setFireCount(result.fireCount);
            })
          }
          className={actOn(fired, "text-[#FF9A4D]")}
        >
          <Rocket className="h-[18px] w-[18px]" />
          {big ? null : <span>{countLabel(fireCount)}</span>}
        </button>
        {big ? null : (
          <span className="inline-flex min-h-10 items-center gap-1.5 px-2.5 text-sm text-mw-muted" aria-label={`${Number(item.viewCount || 0)} views`}>
            <BarChart2 className="h-[18px] w-[18px]" aria-hidden="true" />
            <span>{item.viewCount ? compactCount(item.viewCount) : ""}</span>
          </span>
        )}
        {big ? null : <span className="flex-1" />}
        <div className="relative">
          <button type="button" aria-label="Share" aria-haspopup="menu" aria-expanded={shareOpen} onClick={() => setShareOpen((open) => !open)} className={act}>
            <Share2 className="h-[18px] w-[18px]" />
          </button>
          {shareOpen ? (
            <>
              <button type="button" aria-label="Close menu" className="fixed inset-0 z-[60] cursor-default" onClick={() => setShareOpen(false)} />
              <div role="menu" aria-label="Share" className="absolute right-0 top-11 z-[61] flex w-[200px] flex-col gap-1 rounded-[16px] border border-[#2E353D] bg-mw-surface p-2 shadow-xl">
                <button type="button" role="menuitem" onClick={() => void copyLink()} className="mw-focus flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left font-bold text-mw-text hover:bg-[#171B20]">
                  <Link2 className="h-[18px] w-[18px]" />
                  Copy link
                </button>
                <button type="button" role="menuitem" onClick={shareOnX} className="mw-focus flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left font-bold text-mw-text hover:bg-[#171B20]">
                  <span className="w-[18px] text-center font-black" aria-hidden="true">𝕏</span>
                  Share on X
                </button>
              </div>
            </>
          ) : null}
        </div>
        {quoteOpen ? <QuoteDialog item={item} onClose={() => setQuoteOpen(false)} onPosted={onChanged} /> : null}
      </div>
    </>
  );
}

export function FeedPostCard({ item, onChanged }: { item: FeedItem; onChanged?: () => void }) {
  const ticker = item.tokenTicker || item.ticker;
  const reposter = item.repostedByDisplayName || item.repostedByHandle || item.repostedByWallet
    ? personName(item.repostedByDisplayName, item.repostedByHandle, item.repostedByWallet)
    : null;
  const author = personName(item.authorDisplayName, item.authorHandle, item.wallet);
  // The grey @line is the real username, shown next to a display name.
  const handle = item.authorHandle && String(item.authorDisplayName || "").trim() ? `@${item.authorHandle}` : "";
  const viewRef = useViewTracking(item.postId);
  const moderation = useModeration();
  const { withSession } = useFeedSession();
  const [deleted, setDeleted] = useState(false);
  // CO-30: hidden posts and posts or reposts by blocked accounts disappear for this viewer only.
  if (deleted || moderation.isHidden("post", item.postId) || moderation.isBlocked(item.wallet) || moderation.isBlocked(item.repostedByWallet)) return null;
  // Your own post: Delete in the "…" menu (founder, 2026-10-03), on the feed session.
  const removeOwn = item.postId
    ? async () => {
        await withSession((token) => deleteFeedPost(Number(item.postId), token));
        setDeleted(true);
        onChanged?.();
      }
    : undefined;

  return (
    <article ref={viewRef as React.RefObject<HTMLElement>} className={`${card} px-[18px] pb-2 pt-4`}>
      {item.reach === "taking_off" && !reposter ? (
        <div className="mb-2 flex items-center gap-1.5 pl-[58px] text-[13px] font-semibold text-[#FF9A4D]">
          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
          Taking off
        </div>
      ) : null}
      {reposter ? (
        <div className="mb-2 flex items-center gap-1.5 pl-[58px] text-[13px] text-mw-muted">
          <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
          <Link to={profileHref(item.repostedByWallet)} className="hover:text-mw-text">{reposter}</Link>
          <span>reposted</span>
        </div>
      ) : null}
      <div className="flex gap-3.5">
        <Link to={profileHref(item.wallet)} className="mw-focus shrink-0 rounded-full">
          <FeedAvatar url={item.authorAvatarUrl} label={author} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <Link to={profileHref(item.wallet)} className="truncate font-bold text-mw-text hover:text-mw-text">{author}</Link>
            <span className="text-sm text-mw-muted">{handle ? `${handle} · ` : ""}{timeAgo(item.createdAt)}</span>
            <ItemMenu
              className="-mr-2 -mt-1 ml-auto"
              report={{ entityType: "post", subject: "Reported post", reportedWallet: item.wallet, reportedUrl: absoluteUrl(postHref(item.postId)) }}
              hide={item.postId ? { type: "post", id: item.postId } : undefined}
              author={item.wallet}
              authorLabel={author}
              onDelete={removeOwn}
            />
          </div>
          {item.parentId ? (
            // A reply shown on its own (reposted, quoted): where it belongs (founder, 2026-10-03).
            <Link to={postHref(item.parentId)} className="mt-0.5 inline-block text-[13px] text-mw-muted hover:text-mw-text" data-reply-context="true">
              Replying to a post · <span className="text-mw-accent-soft">View the post</span>
            </Link>
          ) : null}
          <Link to={postHref(item.postId)} className="block text-mw-text hover:text-mw-text">
            <FeedBody body={item.body} />
          </Link>
          {item.mediaUrl ? <PostImage src={item.mediaUrl} /> : null}
          {item.quoted ? <QuotedPost quoted={item.quoted} /> : null}
          {(item.mentionedCampaign || item.mentionedToken || ticker) ? <FeedCoinCard item={item} /> : null}
          {item.postId ? <FeedPostActions item={item} onChanged={onChanged} /> : null}
        </div>
      </div>
    </article>
  );
}

/** A creator post written as the coin, shared to the feed from its coin page (artboard "Creator update"). */
export function FeedCoinPostCard({ item }: { item: FeedItem }) {
  const ticker = item.tokenTicker ? `$${String(item.tokenTicker).replace(/^\$/, "")}` : "";
  const name = item.tokenName || ticker || "Coin";
  const path = tokenHref(item);
  const href = path && path !== "/" ? path : null;
  const avatar = <FeedAvatar url={item.tokenLogoUri} label={ticker || name} square />;
  const moderation = useModeration();
  if (moderation.isHidden("coin_post", item.id)) return null;
  return (
    <article className={`${card} flex gap-3.5 px-[18px] py-4`}>
      {href ? <Link to={href} className="mw-focus shrink-0 rounded-[12px]">{avatar}</Link> : avatar}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {href ? <Link to={href} className="font-bold text-mw-text hover:text-mw-text">{name}</Link> : <b>{name}</b>}
          <span className={`${chip} border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft`}>Creator update</span>
          <span className="text-sm text-mw-muted">{ticker ? `${ticker} · ` : ""}{timeAgo(item.createdAt)}</span>
          {/* Coin updates are posted as the coin: Report and Hide, no Block (founder: blocking never touches coin pages). */}
          <ItemMenu
            className="-mr-2 -mt-1 ml-auto"
            report={{ entityType: "post", subject: "Reported post", reportedUrl: absoluteUrl(href || "/") }}
            hide={{ type: "coin_post", id: item.id }}
          />
        </div>
        <FeedBody body={item.body} />
        {item.mediaUrl ? <PostImage src={item.mediaUrl} /> : null}
        {/* Founder 2026-10-03: creator updates take reactions like any post, through their linked post. */}
        {item.postId ? <FeedPostActions item={item} /> : null}
      </div>
    </article>
  );
}

const updateChip = `${chip} border-[#1E3A5F] bg-[#0F1C2B] text-[#8CC4F0]`;

/** Auto update card (artboard "Auto update"): launches, public drafts and graduations. */
export function FeedSystemCard({ item }: { item: FeedItem }) {
  const ticker = item.ticker || item.campaignSymbol;
  const name = item.name || item.campaignName || shorten(item.campaignAddress);
  const href = item.type === "draft_created" && item.slug ? `/prepare/${item.slug}` : tokenHref(item);
  const chain = chainLabel(item.chainId);
  const kind =
    item.type === "coin_graduated"
      ? { icon: <GraduationCap className="h-4 w-4" aria-hidden="true" />, verb: "graduated", line: "The curve is full. It now trades on its DEX with liquidity locked." }
      : item.type === "draft_created"
        ? { icon: <PenLine className="h-4 w-4" aria-hidden="true" />, verb: "is being prepared", line: "A new coin in prepare mode. Follow it before launch." }
        : { icon: <LaunchIcon className="h-4 w-4" aria-hidden="true" />, verb: "launched", line: "New on the curve." };
  const target = href && href !== "/" ? href : null;
  return (
    <article className={`${card} flex gap-3.5 px-[18px] py-4`}>
      {target ? <Link to={target} className="mw-focus shrink-0 rounded-[12px]"><FeedAvatar url={item.logoUri} label={ticker || name || "?"} square /></Link> : <FeedAvatar url={item.logoUri} label={ticker || name || "?"} square />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <b>{name}</b>
          <span className={updateChip}>Auto update</span>
          <span className="text-sm text-mw-muted">{ticker ? `$${ticker} · ` : ""}{chain ? `${chain} · ` : ""}{timeAgo(item.createdAt)}</span>
        </div>
        <p className="m-0 mt-1 flex items-center gap-1.5 text-[15px]">
          <span className={item.type === "coin_graduated" ? "text-[#6EE7A0]" : "text-mw-accent-soft"}>{kind.icon}</span>
          <span>
            {ticker ? `$${ticker}` : name} {kind.verb}
            {item.wallet ? (
              <>
                {" "}by{" "}
                <Link to={profileHref(item.wallet)} className="text-mw-accent-soft hover:text-[#FFD0A8]">
                  {personName(item.authorDisplayName, item.authorHandle, item.wallet)}
                </Link>
              </>
            ) : null}
            .
          </span>
        </p>
        <p className="m-0 mt-0.5 text-sm text-mw-muted">{kind.line}</p>
        {target ? (
          <div className="mt-2.5 flex gap-2">
            <Link to={target} className="mw-focus inline-flex min-h-10 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text">
              {item.type === "draft_created" ? "Open promotion" : "Coin page"}
            </Link>
            {item.type !== "draft_created" ? (
              <Link to={target} className="mw-focus inline-flex min-h-10 items-center rounded-[10px] border border-mw-buy bg-mw-buy px-4 text-sm font-bold text-[#04140A] hover:bg-[#15913F] hover:text-[#04140A]">Buy</Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** Battle update: a fight went live, or a fight has a winner. */
export function FeedBattleCard({ item }: { item: FeedItem }) {
  const sides = item.sides || [];
  const [a, b] = [sides[0], sides[1]];
  const tick = (side?: (typeof sides)[number]) => (side?.symbol ? `$${String(side.symbol).replace(/^\$/, "")}` : "?");
  const winner = item.type === "battle_finished" ? sides.find((side) => String(side.tokenAddress || "").toLowerCase() === String(item.winnerToken || "").toLowerCase()) : null;
  const href = item.battleId ? `/warzone/battles/${encodeURIComponent(item.battleId)}` : "/warzone/battles";
  const mode = item.battleMode === "vote" ? "Vote battle" : item.battleMode ? "Metrics battle" : "Battle";
  return (
    <article className={`${card} flex flex-col gap-3 px-[18px] py-4 ${item.type === "battle_finished" ? "" : "border-[#5A3416]"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={item.type === "battle_finished" ? updateChip : `${chip} border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft`}>{item.type === "battle_finished" ? "Battle result" : "Battle live"}</span>
        <span className="text-sm text-mw-muted">{mode}{chainLabel(item.chainId) ? ` · ${chainLabel(item.chainId)}` : ""} · {timeAgo(item.createdAt)}</span>
      </div>
      <div className="flex items-center gap-3">
        <FeedAvatar url={a?.imageUrl} label={a?.symbol || "?"} square size={72} />
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate font-bold">{tick(a)} <span className="font-medium text-mw-muted">vs</span> {tick(b)}</div>
          <div className="mt-0.5 flex items-center justify-center gap-1.5 text-sm text-mw-muted">
            {winner ? (
              <>
                <Trophy className="h-4 w-4 text-[#F2C14E]" aria-hidden="true" />
                {tick(winner)} won
              </>
            ) : (
              <>
                <Swords className="h-4 w-4 text-[#FF9A4D]" aria-hidden="true" />
                {item.stakeNative ? `Stake ${item.stakeNative} ${item.nativeSymbol || ""}` : "Vote or boost your side"}
              </>
            )}
          </div>
        </div>
        <FeedAvatar url={b?.imageUrl} label={b?.symbol || "?"} square size={72} />
      </div>
      <Link to={href} className="mw-focus inline-flex min-h-10 w-max items-center gap-2 self-end rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text">
        <Swords className="h-4 w-4" aria-hidden="true" />
        {item.type === "battle_finished" ? "See the result" : "Open fight"}
      </Link>
    </article>
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
      className={`${card} mw-focus flex w-full items-center justify-between gap-3 p-4 text-left hover:border-[#3A424C]`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <FeedAvatar url={item.logoUri} label={item.campaignSymbol || "?"} square size={40} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`font-bold ${item.side === "sell" ? "text-mw-down" : "text-mw-up"}`}>{String(item.side || "buy").toUpperCase()}</span>
            <span className="truncate font-bold">{item.campaignName || shorten(item.campaignAddress)}</span>
          </div>
          <div className="text-xs text-mw-muted">
            {item.campaignSymbol ? `$${item.campaignSymbol}` : "Token"} · {timeAgo(item.createdAt || item.blockTime)}
          </div>
        </div>
      </div>
      {amount ? <div className="shrink-0 text-right font-mw-mono text-sm">{amount}</div> : null}
    </button>
  );
}

export function FeedItemView({ item, onChanged }: { item: FeedItem; onChanged?: () => void }) {
  if (item.type === "post") return <FeedPostCard item={item} onChanged={onChanged} />;
  if (item.type === "coin_post") return <FeedCoinPostCard item={item} />;
  if (item.type === "trade") return <FeedTradeCard item={item} />;
  if (item.type === "battle_started" || item.type === "battle_finished") return <FeedBattleCard item={item} />;
  return <FeedSystemCard item={item} />;
}

export function FeedWhoToFollow({ authors }: { authors: FeedSuggestion[] }) {
  if (!authors.length) return null;
  return (
    <section className={`${card} flex flex-col gap-1 p-4`}>
      <span className="mb-1 font-mw-cond text-xl font-bold">Who to follow</span>
      {authors.slice(0, 5).map((author) => (
        <Link key={author.wallet} to={profileHref(author.wallet)} className="mw-focus flex min-h-12 items-center gap-3 rounded-[10px] px-1 text-mw-text hover:bg-[#171B20] hover:text-mw-text">
          <FeedAvatar url={author.avatar} label={author.name || author.wallet} size={36} />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{author.name ? `@${author.name}` : shorten(author.wallet)}</div>
            <div className="truncate text-xs text-mw-muted">{isSolanaAddress(author.wallet) ? "Solana" : "Wallet"}</div>
          </div>
        </Link>
      ))}
    </section>
  );
}

/** Image picker button for the composers (artboard "Add image"). */
export function ImagePickButton({ onPick, disabled }: { onPick: (file: File) => void; disabled?: boolean }) {
  return (
    <label className={`mw-focus inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text hover:bg-[#222830] ${disabled ? "pointer-events-none opacity-50" : ""}`} aria-label="Add image">
      <ImagePlus className="h-5 w-5" aria-hidden="true" />
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

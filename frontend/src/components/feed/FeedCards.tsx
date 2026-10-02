import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ImagePlus, Link2, MessageCircle, PenLine, Repeat2, Rocket, Share2, X } from "lucide-react";
import { toast } from "sonner";
import { isSolanaAddress } from "@/lib/address";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import {
  FEED_PREVIEW_CHARS,
  toggleFeedFire,
  toggleFeedRepost,
  type FeedItem,
  type FeedSuggestion,
} from "@/lib/feedApi";
import { useFeedSession } from "@/hooks/useFeedSession";
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
  return (
    <span style={style} className={`${shape} flex shrink-0 items-center justify-center bg-[#2B3440] font-mw-cond text-sm font-bold text-mw-text`} aria-hidden="true">
      {label.replace(/^[@$]/, "").slice(0, 2).toUpperCase() || "MW"}
    </span>
  );
}

export function FeedBody({ body, big = false }: { body?: string | null; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const text = String(body || "");
  const collapsed = !big && text.length > FEED_PREVIEW_CHARS;
  const shown = open || !collapsed ? text : `${text.slice(0, FEED_PREVIEW_CHARS).trimEnd()}…`;
  return (
    <>
      <p className={`m-0 mt-1 whitespace-pre-wrap break-words ${big ? "text-lg leading-relaxed" : "text-[15px]"}`}>{shown}</p>
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
  return (
    <div className="mt-3 flex items-center gap-3.5 rounded-[14px] border border-mw-border bg-mw-input p-3.5">
      <FeedAvatar url={item.tokenLogoUri || item.logoUri} label={ticker || name} square size={56} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-bold">{name}</span>
          {ticker ? <span className={`${chip} border-mw-edge font-mw-mono text-[#C9CED4]`}>${String(ticker).replace(/^\$/, "")}</span> : null}
          {chain ? <span className={`${chip} border-mw-edge text-[#C9CED4]`}>{chain}</span> : null}
        </div>
      </div>
      {href ? (
        <Link to={href} className="mw-focus inline-flex min-h-11 shrink-0 items-center rounded-[10px] border border-mw-buy bg-mw-buy px-4 text-sm font-bold text-[#04140A] hover:bg-[#15913F] hover:text-[#04140A]">
          Buy
        </Link>
      ) : null}
    </div>
  );
}

function QuotedPost({ quoted }: { quoted: NonNullable<FeedItem["quoted"]> }) {
  const label = quoted.authorDisplayName ? `@${quoted.authorDisplayName}` : shorten(quoted.wallet);
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
  const label = item.authorDisplayName ? `@${item.authorDisplayName}` : shorten(item.wallet);
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
        <textarea
          value={composer.body}
          onChange={(e) => composer.setBody(e.target.value)}
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
  const reposter = item.repostedByDisplayName
    ? `@${item.repostedByDisplayName}`
    : item.repostedByWallet
      ? shorten(item.repostedByWallet)
      : null;
  const author = item.authorDisplayName ? item.authorDisplayName : shorten(item.wallet);
  const handle = item.authorDisplayName ? `@${item.authorDisplayName}` : "";

  return (
    <article className={`${card} px-[18px] pb-2 pt-4`}>
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
          </div>
          <Link to={postHref(item.postId)} className="block text-mw-text hover:text-mw-text">
            <FeedBody body={item.body} />
          </Link>
          {item.mediaUrl ? <img src={item.mediaUrl} alt="" className="mt-3 max-h-[420px] w-full rounded-[14px] border border-mw-border object-cover" /> : null}
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
  return (
    <article className={`${card} flex gap-3.5 px-[18px] py-4`}>
      {href ? <Link to={href} className="mw-focus shrink-0 rounded-[12px]">{avatar}</Link> : avatar}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {href ? <Link to={href} className="font-bold text-mw-text hover:text-mw-text">{name}</Link> : <b>{name}</b>}
          <span className={`${chip} border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft`}>Creator update</span>
          <span className="text-sm text-mw-muted">{ticker ? `${ticker} · ` : ""}{timeAgo(item.createdAt)}</span>
        </div>
        <FeedBody body={item.body} />
        {item.mediaUrl ? <img src={item.mediaUrl} alt="" className="mt-3 max-h-[420px] w-full rounded-[14px] border border-mw-border object-cover" /> : null}
      </div>
    </article>
  );
}

export function FeedSystemCard({ item }: { item: FeedItem }) {
  const navigate = useNavigate();
  const ticker = item.ticker || item.campaignSymbol;
  const name = item.name || item.campaignName || shorten(item.campaignAddress);
  const verb = item.type === "draft_created" ? "opened a draft" : "deployed";
  const href = item.type === "draft_created" && item.slug ? `/prepare/${item.slug}` : tokenHref(item);

  return (
    <button
      type="button"
      onClick={() => {
        if (href && href !== "/") navigate(href);
      }}
      className={`${card} mw-focus flex w-full items-center gap-3 p-4 text-left hover:border-[#3A424C]`}
    >
      <FeedAvatar url={item.logoUri} label={ticker || name || "?"} square />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-mw-muted">
          <Link to={profileHref(item.wallet)} className="text-mw-text hover:text-mw-text" onClick={(e) => e.stopPropagation()}>
            {item.authorDisplayName ? `@${item.authorDisplayName}` : shorten(item.wallet)}
          </Link>{" "}
          {verb} <b className="text-mw-text">{name}</b>
          {ticker ? ` $${ticker}` : ""}
        </div>
        <div className="mt-0.5 text-xs text-mw-muted">{timeAgo(item.createdAt)}</div>
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

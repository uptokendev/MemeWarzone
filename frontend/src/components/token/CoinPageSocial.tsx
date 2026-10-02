/**
 * Coin page pieces that read /api/coin-page (UI redesign phase 1b). Each one reads the same cached
 * query, so the page makes one request per coin, and each falls back to what the page showed before
 * when the owner has not set anything.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ImagePlus, Loader2, Pencil, Pin, Rocket, Swords, Trash2, Trophy, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { cp } from "@/components/token/coinPageStyles";
import { CoinAvatar } from "@/components/ui-v2";
import { useCoinOwnerSigner, useCoinPage, useCoinPageMutations, type CoinAutoUpdate, type CoinPost } from "@/lib/coinPageApi";
import { mergeCoinFeed, relativeTime } from "@/lib/coinPageFeed.mjs";

type CoinRef = { chainId: number; token: string };

/** Banner image (or the placeholder grid) and, for the owner, the Edit page button. */
export function CoinBanner({ chainId, token, editPath }: CoinRef & { editPath: string }) {
  const { data } = useCoinPage(chainId, token);
  const { isOwner } = useCoinOwnerSigner(chainId, data?.owner?.wallet);
  const banner = data?.profile.bannerUrl;
  return (
    <div className="relative h-[120px] overflow-hidden rounded-2xl border border-[#1E2329] md:h-[200px] xl:h-[240px]">
      {banner ? (
        <img src={banner} alt="" className="h-full w-full object-cover" style={{ objectPosition: `50% ${data?.profile.bannerPositionY ?? 50}%` }} />
      ) : (
        <div className="mw-banner h-full w-full" aria-hidden="true" />
      )}
      {isOwner ? (
        <Link to={editPath} className={`${cp.btn} absolute right-3 top-3 min-h-10 bg-[rgba(19,23,28,0.92)] px-3 text-sm md:right-4 md:top-4`}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit page
        </Link>
      ) : null}
    </div>
  );
}

/** Shows the owner's link for `kind` when set, otherwise `fallback` (the launch link, unchanged). */
export function CoinLinkSwap({ chainId, token, kind, fallback }: CoinRef & { kind: "website" | "x" | "telegram" | "discord"; fallback: ReactNode }) {
  const { data } = useCoinPage(chainId, token);
  const p = data?.profile;
  const href = kind === "website" ? p?.websiteUrl : kind === "x" ? p?.xUrl : kind === "telegram" ? p?.telegramUrl : p?.discordUrl;
  if (!href) return <>{fallback}</>;
  const label = kind === "website" ? "Website" : kind === "x" ? "X" : kind === "telegram" ? "Telegram" : "Discord";
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cp.chipButton}>
      {label}
    </a>
  );
}

/** The bio set on the coin page (launched coins) or `fallback` (today's description). */
export function CoinBio({ chainId, token, fallback }: CoinRef & { fallback: string | null | undefined }) {
  const { data } = useCoinPage(chainId, token);
  const text = (data?.owner?.origin === "launched" && data.profile.bio) || fallback;
  if (!text) return null;
  return <p className="m-0 max-w-[70ch] whitespace-pre-line break-words text-base leading-relaxed text-mw-text">{text}</p>;
}

export function CoinFounderNote({ chainId, token }: CoinRef) {
  const { data } = useCoinPage(chainId, token);
  const note = data?.profile.founderNote;
  if (!note) return null;
  return (
    <blockquote className="m-0 border-l-[3px] border-mw-accent pl-3 font-mw-cond text-lg font-semibold text-mw-accent-soft">
      “{note}”
    </blockquote>
  );
}

export function CoinTags({ chainId, token }: CoinRef) {
  const { data } = useCoinPage(chainId, token);
  const tags = data?.profile.tags || [];
  if (!tags.length) return null;
  return (
    <div className="contents" aria-label="Tags">
      {tags.map((t) => (
        <span key={t} className={cp.chip}>#{t}</span>
      ))}
    </div>
  );
}

function AutoIcon({ kind }: { kind: CoinAutoUpdate["kind"] }) {
  const Icon = kind === "battle" ? Swords : kind === "graduation" ? Trophy : Rocket;
  return <Icon className="h-4 w-4" aria-hidden="true" />;
}

/**
 * Posts written as the coin plus auto updates, newest first, the pinned post on top. The owner gets a
 * composer. `children` (today's Comments / Creator Updates) follows below, unchanged.
 */
export function CoinPostsPanel({
  chainId,
  token,
  name,
  ticker,
  logoUrl,
  children,
}: CoinRef & { name: string; ticker: string; logoUrl?: string | null; children?: ReactNode }) {
  const { data, isLoading, isError } = useCoinPage(chainId, token);
  const { isOwner, sign } = useCoinOwnerSigner(chainId, data?.owner?.wallet);
  const { createPost, deletePost, uploadImage } = useCoinPageMutations(chainId, token, data?.owner?.token);
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [busy, setBusy] = useState<"post" | "image" | string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const items = useMemo(() => mergeCoinFeed(data?.posts || [], data?.autoUpdates || [], data?.profile.pinnedPostId || null), [data]);
  const shareDefault = data?.profile.shareUpdatesToFeed !== false;

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy("post");
    try {
      await createPost(sign, { body: text.trim(), mediaUrl, shareToFeed });
      setText("");
      setMediaUrl(null);
      toast.success("Posted.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not post."));
    } finally {
      setBusy(null);
    }
  };

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setBusy("image");
    try {
      setMediaUrl(await uploadImage(sign, "post", file));
    } catch (error: any) {
      toast.error(String(error?.message || "Could not upload the image."));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (post: CoinPost) => {
    setBusy(`del:${post.id}`);
    try {
      await deletePost(sign, post.id);
      toast.success("Post deleted.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not delete the post."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {isOwner ? (
        <section aria-label="Post an update" className={`${cp.card} flex flex-col gap-2.5 p-3.5 md:px-4`}>
          <div className="flex items-start gap-3">
            <CoinAvatar src={logoUrl} ticker={ticker} size={44} />
            <label className="sr-only" htmlFor="coin-post-body">Post an update</label>
            <textarea
              id="coin-post-body"
              rows={2}
              maxLength={280}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Post an update to your holders"
              className="min-h-11 flex-1 resize-y rounded-[10px] border border-mw-edge bg-mw-input px-3.5 py-2.5 text-[15px] text-mw-text placeholder:text-[#7C858F] focus:outline-none focus:ring-2 focus:ring-mw-accent"
            />
          </div>
          {mediaUrl ? (
            <div className="relative ml-14 w-fit">
              <img src={mediaUrl} alt="Attached image" className="max-h-48 rounded-xl border border-mw-border object-cover" />
              <button type="button" aria-label="Remove image" onClick={() => setMediaUrl(null)} className="mw-focus absolute right-1 top-1 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[rgba(5,6,8,0.8)] text-mw-text">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <div className="ml-14 flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void pickImage(e.target.files?.[0])} />
            <button type="button" aria-label="Add image" className={cn(cp.btn, "w-11 px-0")} onClick={() => fileRef.current?.click()} disabled={busy === "image"}>
              {busy === "image" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
            </button>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-mw-muted">
              <input type="checkbox" checked={shareToFeed} onChange={(e) => setShareToFeed(e.target.checked)} className="h-5 w-5 accent-[#FF7A1A]" />
              Also in the home feed
            </label>
            <span className="ml-auto font-mw-mono text-xs text-mw-muted">{text.length}/280</span>
            <button type="button" onClick={() => void submit()} disabled={!text.trim() || busy === "post"} className={`${cp.btn} border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`}>
              {busy === "post" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Post
            </button>
          </div>
          <span className="ml-14 text-xs text-mw-muted">You post as the coin. {shareDefault ? "Updates also appear in the home feed unless you untick it." : "Feed sharing is off by default in your page settings."}</span>
        </section>
      ) : null}

      {/* Unavailable coin page data degrades to the existing comments below, with no error card. */}
      {isLoading && !isError ? <div className={`${cp.card} p-4 text-sm text-mw-muted`}>Loading posts…</div> : null}

      {items.map((item) => {
        const pinned = item.pinned;
        return (
          <article key={item.id} className={`${cp.card} flex gap-3.5 px-4 pb-2 pt-4 md:px-[18px]`}>
            <CoinAvatar src={logoUrl} ticker={ticker} size={44} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-mw-text">{name || ticker}</span>
                {item.kind === "post" ? <span className={`${cp.chipAccent} h-[22px] text-xs`}>Creator update</span> : <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-[#24384A] bg-[#14202A] px-2 text-xs font-semibold text-[#8CC4F0]"><AutoIcon kind={item.kind} />Auto update</span>}
                {pinned ? <span className={`${cp.chip} h-[22px] text-xs`}><Pin className="h-3 w-3" aria-hidden="true" />Pinned</span> : null}
                <span className="text-sm text-mw-muted">${ticker} · <time dateTime={item.at}>{relativeTime(item.at)}</time></span>
                {item.kind === "post" && isOwner ? (
                  <button type="button" aria-label="Delete post" onClick={() => void remove(item as CoinPost)} disabled={busy === `del:${item.id}`} className="mw-focus ml-auto inline-flex h-10 w-10 items-center justify-center rounded-lg text-mw-muted hover:bg-mw-raised hover:text-mw-down">
                    {busy === `del:${item.id}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                  </button>
                ) : null}
              </div>
              <p className="mb-3 mt-1 whitespace-pre-line break-words text-[15px] text-mw-text">{item.kind === "post" ? item.body : item.text}</p>
              {item.kind === "post" && item.mediaUrl ? (
                <img src={item.mediaUrl} alt="" className="mb-3 max-h-[420px] w-full rounded-xl border border-mw-border object-cover" loading="lazy" />
              ) : null}
              {item.kind === "battle" && item.battleId ? (
                <Link to={`/warzone/battles/${encodeURIComponent(item.battleId)}`} className="mb-3 inline-flex text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">View battle</Link>
              ) : null}
            </div>
          </article>
        );
      })}

      {data && !items.length ? (
        <div className={`${cp.card} p-4 text-sm text-mw-muted`}>{isOwner ? "No posts yet. Your first update shows here and in the home feed." : "No updates from this coin yet."}</div>
      ) : null}

      {children}
    </div>
  );
}

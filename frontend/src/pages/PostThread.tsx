/** Single post with its replies (UI redesign phase 2, artboard PostThread). Route /post/:postId. */
import { PostImage } from "@/components/feed/PostImage";
import { useWalletAvatar } from "@/hooks/useWalletAvatar";
import { useStickyRail } from "@/hooks/useStickyRail";
import { MentionField } from "@/components/feed/MentionField";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { FeedAvatar, FeedBody, FeedCoinCard, FeedPostActions, timeAgo } from "@/components/feed/FeedCards";
import { useFeedSession } from "@/hooks/useFeedSession";
import { FEED_MAX_CHARS, createFeedReply, feedViewerKey, fetchFeedPost, fetchPostReplies, queueFeedView, type FeedItem } from "@/lib/feedApi";

function shortWallet(value?: string | null) {
  const v = String(value || "");
  return v.length > 10 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
}

const card = "rounded-[14px] border border-mw-border bg-mw-surface";

export default function PostThread() {
  const railRef = useStickyRail<HTMLElement>();
  const { postId: raw } = useParams<{ postId: string }>();
  const postId = Number(raw);
  const navigate = useNavigate();
  const { account, withSession, busy } = useFeedSession();
  const composerAvatar = useWalletAvatar(account);
  const [post, setPost] = useState<FeedItem | null>(null);
  const [replies, setReplies] = useState<FeedItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(postId) || postId <= 0) {
      setState("missing");
      return;
    }
    try {
      const [item, list] = await Promise.all([fetchFeedPost(postId, account || undefined), fetchPostReplies(postId, account || undefined).catch(() => [])]);
      if (!item) {
        setState("missing");
        return;
      }
      setPost(item);
      setReplies(list);
      setState("ready");
      queueFeedView(postId, feedViewerKey(account));
    } catch {
      setState("error");
    }
  }, [account, postId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || sending || busy) return;
    setSending(true);
    try {
      await withSession((token) => createFeedReply(postId, token, text));
      setReply("");
      toast.success("Replied.");
      await load();
    } catch (err: unknown) {
      toast.error(String((err as Error)?.message || "Could not reply"));
    } finally {
      setSending(false);
    }
  };

  const author = post?.authorDisplayName || (post?.authorHandle ? `@${post.authorHandle}` : shortWallet(post?.wallet));
  const hasCoin = Boolean(post && (post.mentionedCampaign || post.mentionedToken || post.tokenTicker));

  return (
    <ContentContainer className="px-0 pb-16 font-mw-body text-mw-text md:px-2">
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <main className={`${card} min-w-0 overflow-hidden`}>
          <div className="flex h-[60px] items-center gap-3.5 border-b border-[#242A31] px-3">
            <button type="button" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))} aria-label="Back to the feed" className="mw-focus inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-mw-text hover:bg-[#171B20]">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="m-0 font-mw-cond text-xl font-bold">Post</h1>
          </div>

          {state === "loading" ? <p className="m-0 p-5 text-sm text-mw-muted">Loading post...</p> : null}
          {state === "missing" ? <p className="m-0 p-5 text-sm text-mw-muted">This post does not exist or was deleted. <Link to="/" className="text-mw-accent-soft">Back to Home</Link></p> : null}
          {state === "error" ? <p className="m-0 p-5 text-sm text-[#FFB4C0]">The post could not be loaded. Try again shortly.</p> : null}

          {post ? (
            <>
              <article className="p-[18px]">
                <Link to={`/profile/${post.wallet}`} className="mw-focus flex w-max items-center gap-3 rounded-full text-mw-text hover:text-mw-text">
                  <FeedAvatar url={post.authorAvatarUrl} label={author} size={48} />
                  <span>
                    <b className="block">{author}</b>
                    {post.authorDisplayName ? <span className="text-sm text-mw-muted">{post.authorHandle ? `@${post.authorHandle}` : shortWallet(post.wallet)}</span> : null}
                  </span>
                </Link>
                <div className="mt-3.5"><FeedBody body={post.body} big /></div>
                {post.mediaUrl ? <PostImage src={post.mediaUrl} /> : null}
                {post.quoted ? (
                  <Link to={`/post/${post.quoted.postId}`} className="mw-focus mt-3 block rounded-[14px] border border-mw-border bg-mw-input p-3 text-mw-text hover:text-mw-text">
                    <b className="text-[13px]">{post.quoted.authorDisplayName || (post.quoted.authorHandle ? `@${post.quoted.authorHandle}` : shortWallet(post.quoted.wallet))}</b>
                    <p className="m-0 mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm">{post.quoted.body}</p>
                  </Link>
                ) : null}
                <div className="mt-3 text-sm text-mw-muted">
                  {post.createdAt ? new Date(post.createdAt).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", year: "numeric" }) : ""}
                </div>
                <FeedPostActions item={post} onChanged={() => void load()} big />
              </article>

              <div className="flex items-center gap-3 border-t border-[#242A31] px-[18px] py-3.5">
                <span className="hidden sm:block"><FeedAvatar url={composerAvatar} label={account || "You"} size={40} /></span>
                <MentionField
                  value={reply}
                  onChange={(next) => setReply(next.slice(0, FEED_MAX_CHARS))}
                  onKeyDown={(e) => { if (e.key === "Enter") void sendReply(); }}
                  placeholder="Post your reply"
                  aria-label="Post your reply"
                  className="mw-focus h-11 min-w-0 flex-1 rounded-[10px] border border-[#2E353D] bg-mw-input px-3.5 text-[15px] text-mw-text placeholder:text-[#5C6670]"
                />
                <button type="button" disabled={!reply.trim() || sending || busy} onClick={() => void sendReply()} className="mw-focus inline-flex min-h-11 items-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-bold text-[#140A02] disabled:opacity-50">
                  {sending ? "Replying..." : "Reply"}
                </button>
              </div>

              {replies.map((r) => {
                const name = r.authorDisplayName || (r.authorHandle ? `@${r.authorHandle}` : shortWallet(r.wallet));
                return (
                  <article key={r.id} className="flex gap-3 border-t border-[#1E2329] px-[18px] py-3.5">
                    <Link to={`/profile/${r.wallet}`} className="mw-focus shrink-0 rounded-full"><FeedAvatar url={r.authorAvatarUrl} label={name} size={40} /></Link>
                    <div className="min-w-0 flex-1">
                      <div className="flex gap-2"><b>{name}</b><span className="text-sm text-mw-muted">{timeAgo(r.createdAt)}</span></div>
                      <FeedBody body={r.body} />
                    </div>
                  </article>
                );
              })}
            </>
          ) : null}
        </main>

        <aside ref={railRef} className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--mwz-topbar-offset)+16px)]">
          {post && hasCoin ? (
            <section className={`${card} flex flex-col gap-1 p-4`}>
              <span className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Coin in this post</span>
              <FeedCoinCard item={post} />
            </section>
          ) : null}
        </aside>
      </div>
    </ContentContainer>
  );
}

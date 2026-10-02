import { apiFetch, apiJson } from "@/lib/apiBase";
import { isSolanaAddress } from "@/lib/address";

export const FEED_MAX_CHARS = 1000;
export const FEED_PREVIEW_CHARS = 280;

export type FeedItemType = "post" | "coin_post" | "draft_created" | "coin_deployed" | "coin_graduated" | "battle_started" | "battle_finished" | "trade";

export type FeedItem = {
  type: FeedItemType;
  id: string;
  createdAt: string | null;
  wallet?: string | null;
  body?: string | null;
  postId?: number;
  authorDisplayName?: string | null;
  authorAvatarUrl?: string | null;
  name?: string | null;
  ticker?: string | null;
  logoUri?: string | null;
  campaignAddress?: string | null;
  tokenAddress?: string | null;
  chainId?: number | null;
  slug?: string | null;
  draftId?: number;
  mentionedChainId?: number | null;
  mentionedCampaign?: string | null;
  mentionedToken?: string | null;
  tokenName?: string | null;
  tokenTicker?: string | null;
  tokenLogoUri?: string | null;
  side?: "buy" | "sell";
  bnbAmount?: number | null;
  tokenAmount?: number | null;
  campaignName?: string | null;
  campaignSymbol?: string | null;
  txHash?: string | null;
  blockTime?: string | null;
  parentId?: number | null;
  fireCount?: number;
  replyCount?: number;
  repostCount?: number;
  firedByMe?: boolean;
  repostedByMe?: boolean;
  repostedByWallet?: string | null;
  repostedByDisplayName?: string | null;
  /** UI redesign phase 2. */
  mediaUrl?: string | null;
  quoteOfId?: number | null;
  quoted?: {
    postId: number;
    wallet: string | null;
    body: string;
    mediaUrl: string | null;
    createdAt: string | null;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
  } | null;
  coinPostId?: number;
  viewCount?: number;
  /** Battle updates (founder, 2026-10-02: For you shows battles too). */
  battleId?: string;
  battleMode?: string | null;
  sides?: Array<{ symbol: string | null; name: string | null; tokenAddress: string | null; ownerWallet: string | null; imageUrl: string | null }>;
  winnerToken?: string | null;
  stakeNative?: number | null;
  nativeSymbol?: string | null;
};

export type FeedSuggestion = {
  wallet: string;
  name?: string | null;
  avatar?: string | null;
};

/** Mirrors api/lib/postsCanon.js buildPostCreateMessage: optional Media / Quote lines, none for a plain post. */
function buildPostMessage(args: {
  chainId: number;
  address: string;
  nonce: string;
  body: string;
  mediaUrl?: string | null;
  quoteOf?: number | null;
}) {
  const bodyPreview = args.body.trim();
  const address = isSolanaAddress(args.address) ? args.address : args.address.toLowerCase();
  const extra: string[] = [];
  if (args.mediaUrl) extra.push(`Media: ${String(args.mediaUrl).trim()}`);
  if (args.quoteOf) extra.push(`Quote: ${Number(args.quoteOf)}`);
  return [
    "MemeWarzone Post",
    "Action: POST_CREATE",
    `ChainId: ${args.chainId}`,
    `Address: ${address}`,
    `Nonce: ${args.nonce}`,
    ...extra,
    "",
    bodyPreview,
  ].join("\n");
}

export { buildPostMessage };

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function fetchFeedPosts(params: {
  tab?: "for-you" | "following";
  author?: string;
  viewer?: string;
  chainId?: number;
  limit?: number;
}): Promise<FeedItem[]> {
  const qs = new URLSearchParams();
  if (params.tab) qs.set("tab", params.tab);
  if (params.author) qs.set("author", params.author);
  if (params.viewer) qs.set("viewer", params.viewer);
  if (params.chainId) qs.set("chainId", String(params.chainId));
  qs.set("limit", String(params.limit ?? 40));
  const json = await apiJson<{ items?: FeedItem[] }>(`/api/feed/posts?${qs.toString()}`);
  return Array.isArray(json?.items) ? json.items : [];
}

export async function fetchActivityTimeline(wallet: string, limit = 40): Promise<FeedItem[]> {
  const qs = new URLSearchParams({ wallet, limit: String(limit) });
  const json = await apiJson<{ items?: FeedItem[] }>(`/api/activity/timeline?${qs.toString()}`);
  return Array.isArray(json?.items) ? json.items : [];
}

export async function fetchFeedSuggestions(viewer?: string): Promise<FeedSuggestion[]> {
  const qs = new URLSearchParams();
  if (viewer) qs.set("viewer", viewer);
  const json = await apiJson<{ items?: FeedSuggestion[] }>(`/api/feed/suggestions?${qs.toString()}`);
  return Array.isArray(json?.items) ? json.items : [];
}

export async function createFeedPost(input: {
  chainId: number;
  address: string;
  body: string;
  nonce: string;
  signature: string;
  mediaUrl?: string | null;
  quoteOf?: number | null;
  /** Feed session token: the post then needs no nonce or signature (one signature per 12 h). */
  token?: string;
}): Promise<{ id: number | null }> {
  const { token, ...payload } = input;
  const res = await apiFetch("/api/feed/posts", {
    method: "POST",
    headers: token ? { "content-type": "application/json", Authorization: `Bearer ${token}` } : { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await readJson(res);
  if (!res.ok) throw Object.assign(new Error(String(json?.error || `Failed to post (${res.status})`)), { status: res.status, code: json?.code });
  return { id: (json?.id as number | null) ?? null };
}

export async function fetchFeedNonce(chainId: number, address: string): Promise<string> {
  const url = `/api/auth/nonce?chainId=${encodeURIComponent(String(chainId))}&address=${encodeURIComponent(address)}`;
  const res = await apiFetch(url, { method: "GET" });
  const json = await readJson(res);
  if (!res.ok || !json?.nonce) throw new Error(String(json?.error || "Nonce missing"));
  return String(json.nonce);
}

export async function fetchPostReplies(postId: number, viewer?: string): Promise<FeedItem[]> {
  const qs = new URLSearchParams();
  if (viewer) qs.set("viewer", viewer);
  const json = await apiJson<{ items?: FeedItem[] }>(`/api/feed/posts/${postId}/replies?${qs.toString()}`);
  return Array.isArray(json?.items) ? json.items : [];
}

function sessionError(json: Record<string, unknown>, fallback: string, status: number) {
  const error = new Error(String(json?.error || fallback)) as Error & { code?: string };
  if (json?.code) error.code = String(json.code);
  if (status === 401) error.code = error.code || "FEED_SESSION_REQUIRED";
  return error;
}

export async function toggleFeedFire(postId: number, token: string): Promise<{ on: boolean; fireCount: number }> {
  const res = await apiFetch(`/api/feed/posts/${postId}/fire`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await readJson(res);
  if (!res.ok) throw sessionError(json, `Failed to fire (${res.status})`, res.status);
  return { on: Boolean(json.on), fireCount: Number(json.fireCount || 0) };
}

export async function toggleFeedRepost(postId: number, token: string): Promise<{ on: boolean; repostCount: number }> {
  const res = await apiFetch(`/api/feed/posts/${postId}/repost`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await readJson(res);
  if (!res.ok) throw sessionError(json, `Failed to repost (${res.status})`, res.status);
  return { on: Boolean(json.on), repostCount: Number(json.repostCount || 0) };
}

export async function createFeedReply(postId: number, token: string, body: string): Promise<{ id: number | null; replyCount: number }> {
  const res = await apiFetch(`/api/feed/posts/${postId}/replies`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  const json = await readJson(res);
  if (!res.ok) throw sessionError(json, `Failed to reply (${res.status})`, res.status);
  return { id: (json.id as number | null) ?? null, replyCount: Number(json.replyCount || 0) };
}

/** Single post for the thread page (UI redesign phase 2). Null when it does not exist. */
export async function fetchFeedPost(postId: number, viewer?: string): Promise<FeedItem | null> {
  const qs = new URLSearchParams();
  if (viewer) qs.set("viewer", viewer);
  const res = await apiFetch(`/api/feed/posts/${postId}?${qs.toString()}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const json = await readJson(res);
  if (!res.ok) throw new Error(String(json?.error || `Failed to load post (${res.status})`));
  return (json?.item as FeedItem) || null;
}

/** Image for a post: signed by the posting wallet (`feed_post_image`), stored in its own folder. */
export async function uploadFeedImage(input: {
  file: File;
  chainId: number;
  address: string;
  walletType: "evm" | "solana";
  signMessage?: (message: string) => Promise<string>;
  /** Feed session token: the upload then needs no signature of its own. */
  token?: string;
}): Promise<string> {
  const qs = new URLSearchParams({ chainId: String(input.chainId), address: input.address });
  if (!input.token) {
    const { signWalletAction, appendAuthToSearchParams } = await import("@/lib/walletActionAuth");
    const auth = await signWalletAction({
      action: "feed_post_image",
      walletAddress: input.address,
      chainId: input.chainId,
      walletType: input.walletType,
      signMessage: input.signMessage!,
    });
    appendAuthToSearchParams(qs, auth);
  }
  const fd = new FormData();
  fd.append("file", input.file);
  const res = await apiFetch(`/api/feed/image?${qs.toString()}`, {
    method: "POST",
    body: fd,
    headers: input.token ? { Authorization: `Bearer ${input.token}` } : undefined,
  });
  const json = await readJson(res);
  if (!res.ok) throw Object.assign(new Error(String(json?.error || `Upload failed (${res.status})`)), { status: res.status, code: json?.code });
  const url = String(json?.url || "").trim();
  if (!url) throw new Error("Upload succeeded but no image URL was returned.");
  return url;
}

/** One page of For you / Following (infinite scroll). `before` = createdAt of the last item shown. */
export async function fetchFeedPage(params: { tab: "for-you" | "following"; viewer?: string; before?: string | null; limit?: number }): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ tab: params.tab, limit: String(params.limit ?? 30) });
  if (params.viewer) qs.set("viewer", params.viewer);
  if (params.before) qs.set("before", params.before);
  const json = await apiJson<{ items?: FeedItem[]; nextCursor?: string | null }>(`/api/feed/posts?${qs.toString()}`);
  return { items: Array.isArray(json?.items) ? json.items : [], nextCursor: json?.nextCursor || null };
}

const ANON_KEY = "mwz:feed:viewer";

/** Who is viewing: the wallet when connected, otherwise one anonymous id per browser. */
export function feedViewerKey(account?: string | null) {
  if (account) return account;
  try {
    let id = window.localStorage.getItem(ANON_KEY);
    if (!id) {
      id = `anon:${(window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, "")}`;
      window.localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

let pendingViews = new Set<number>();
let viewTimer: number | null = null;
let viewViewer = "";

/** Queue a view; sent in small batches (one view per viewer per post is kept server side). */
export function queueFeedView(postId: number, viewer: string) {
  if (!postId || !viewer) return;
  viewViewer = viewer;
  pendingViews.add(postId);
  if (viewTimer != null) return;
  viewTimer = window.setTimeout(() => {
    const ids = [...pendingViews].slice(0, 40);
    pendingViews = new Set([...pendingViews].slice(40));
    viewTimer = null;
    void apiFetch("/api/feed/views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postIds: ids, viewer: viewViewer }),
      keepalive: true,
    }).catch(() => {});
  }, 2500);
}

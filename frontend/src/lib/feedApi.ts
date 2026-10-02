import { apiFetch, apiJson } from "@/lib/apiBase";
import { isSolanaAddress } from "@/lib/address";

export const FEED_MAX_CHARS = 1000;
export const FEED_PREVIEW_CHARS = 280;

export type FeedItemType = "post" | "draft_created" | "coin_deployed" | "trade";

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
};

export type FeedSuggestion = {
  wallet: string;
  name?: string | null;
  avatar?: string | null;
};

function buildPostMessage(args: {
  chainId: number;
  address: string;
  nonce: string;
  body: string;
}) {
  const bodyPreview = args.body.trim();
  const address = isSolanaAddress(args.address) ? args.address : args.address.toLowerCase();
  return [
    "MemeWarzone Post",
    "Action: POST_CREATE",
    `ChainId: ${args.chainId}`,
    `Address: ${address}`,
    `Nonce: ${args.nonce}`,
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
}): Promise<{ id: number | null }> {
  const res = await apiFetch("/api/feed/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(String(json?.error || `Failed to post (${res.status})`));
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

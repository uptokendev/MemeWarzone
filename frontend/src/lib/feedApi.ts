import { apiFetch, apiJson } from "@/lib/apiBase";
import { isSolanaAddress } from "@/lib/address";

export const FEED_MAX_CHARS = 280;

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
};

function buildPostMessage(args: {
  chainId: number;
  address: string;
  nonce: string;
  body: string;
}) {
  // Must match api/lib/postsCanon.js: the whole trimmed post is signed.
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
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(json?.error || `Failed to post (${res.status})`));
  return { id: json?.id ?? null };
}

export async function fetchFeedNonce(chainId: number, address: string): Promise<string> {
  const url = `/api/auth/nonce?chainId=${encodeURIComponent(String(chainId))}&address=${encodeURIComponent(address)}`;
  const res = await apiFetch(url, { method: "GET" });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.nonce) throw new Error(json?.error || "Nonce missing");
  return String(json.nonce);
}

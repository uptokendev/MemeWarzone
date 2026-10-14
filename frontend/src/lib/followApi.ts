import { isAddress } from "ethers";
import { apiFetch } from "@/lib/apiBase";
import { findStoredFeedSession } from "@/lib/feedSession";
import { isSolanaAddress } from "@/lib/address";
import { isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";

/**
 * Social follows: connected wallet address only — no signature popup.
 * (Server accepts unsigned follow/unfollow writes.)
 */
export type FollowSignOpts = {
  /** @deprecated Follows no longer require signing; kept for call-site compatibility. */
  signer?: unknown;
  /** @deprecated Follows no longer require signing; kept for call-site compatibility. */
  signMessage?: (message: string) => Promise<string>;
  /** @deprecated Follows no longer require signing; kept for call-site compatibility. */
  auth?: unknown;
};

type FollowUserPayload = {
  chainId: number;
  followerAddress: string;
  followingAddress: string;
};

type FollowCampaignPayload = {
  chainId: number;
  userAddress: string;
  campaignAddress: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Follow API error (${res.status}): ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

function normAddr(a: string) {
  const raw = (a ?? "").trim();
  if (isSolanaAddress(raw)) return raw;
  return raw.toLowerCase();
}

function assertAddr(a: string, label: string) {
  const v = normAddr(a);
  if (!isSolanaAddress(v) && !isAddress(v)) throw new Error(`Invalid ${label} address`);
  return v;
}

/**
 * Following is chainless (founder, 2026-10-14): any connected wallet follows any coin on any chain; only
 * buying and selling need the coin's own wallet. The coin's own wallet is used when it is connected,
 * otherwise whichever wallet is.
 */
export function pickFollowWallet(coinOnSolana: boolean, solanaAccount?: string | null, evmAccount?: string | null): string {
  const sol = String(solanaAccount || "").trim();
  const evm = String(evmAccount || "").trim();
  return coinOnSolana ? sol || evm : evm || sol;
}

function resolveChainId(chainId: number, ...addresses: string[]) {
  if (addresses.some((address) => isSolanaAddress(address))) {
    return isSolanaChainId(chainId) ? chainId : SOLANA_CHAIN_ID;
  }
  // EVM user-follows are wallet-global (not per 56/97). API stores them under 0.
  return 0;
}

export async function followUser(
  followerAddress: string,
  followingAddress: string,
  chainId = 0,
  _signOpts?: FollowSignOpts,
): Promise<void> {
  const follower = assertAddr(followerAddress, "follower");
  const following = assertAddr(followingAddress, "following");
  const payload: FollowUserPayload = {
    chainId: resolveChainId(chainId, follower, following),
    followerAddress: follower,
    followingAddress: following,
  };
  // The stored social signature, when there is one, lets the server send "x followed you" (never prompts).
  const session = findStoredFeedSession(follower);
  await api<{ ok: true }>(`/api/follows/user`, {
    method: "POST",
    headers: session ? { "content-type": "application/json", Authorization: `Bearer ${session}` } : { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, action: "follow" }),
  });
}

export async function unfollowUser(
  followerAddress: string,
  followingAddress: string,
  chainId = 0,
  _signOpts?: FollowSignOpts,
): Promise<void> {
  const follower = assertAddr(followerAddress, "follower");
  const following = assertAddr(followingAddress, "following");
  const payload: FollowUserPayload = {
    chainId: resolveChainId(chainId, follower, following),
    followerAddress: follower,
    followingAddress: following,
  };
  await api<{ ok: true }>(`/api/follows/user`, {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "unfollow" }),
  });
}

export async function isFollowingUser(
  followerAddress: string,
  followingAddress: string,
  chainId = 0
): Promise<boolean> {
  const follower = assertAddr(followerAddress, "follower");
  const following = assertAddr(followingAddress, "following");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, follower, following)), follower, following });
  const out = await api<{ isFollowing: boolean }>(`/api/follows/user?${q.toString()}`);
  return !!out.isFollowing;
}

export async function getFollowersCount(address: string, chainId = 0): Promise<number> {
  const a = assertAddr(address, "address");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, a)), address: a });
  const out = await api<{ followers: number }>(`/api/follows/user-counts?${q.toString()}`);
  return out.followers ?? 0;
}

export async function getFollowingCount(address: string, chainId = 0): Promise<number> {
  const a = assertAddr(address, "address");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, a)), address: a });
  const out = await api<{ following: number }>(`/api/follows/user-counts?${q.toString()}`);
  return out.following ?? 0;
}

export async function getFollowers(address: string, chainId = 0) {
  const a = assertAddr(address, "address");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, a)), address: a, type: "followers" });
  const out = await api<{ items: Array<{ address: string; profile?: any }> }>(`/api/follows/user-list?${q.toString()}`);
  return (out.items || []).map((it) => ({ id: it.address, profile: it.profile }));
}

export async function getFollowing(address: string, chainId = 0) {
  const a = assertAddr(address, "address");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, a)), address: a, type: "following" });
  const out = await api<{ items: Array<{ address: string; profile?: any }> }>(`/api/follows/user-list?${q.toString()}`);
  return (out.items || []).map((it) => ({ id: it.address, profile: it.profile }));
}

export async function followCampaign(
  userAddress: string,
  campaignAddress: string,
  chainId = 0,
  _signOpts?: FollowSignOpts,
): Promise<void> {
  const user = assertAddr(userAddress, "user");
  const campaign = assertAddr(campaignAddress, "campaign");
  const payload: FollowCampaignPayload = {
    chainId: resolveChainId(chainId, user, campaign),
    userAddress: user,
    campaignAddress: campaign,
  };
  await api<{ ok: true }>(`/api/follows/campaign`, {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "follow" }),
  });
}

export async function unfollowCampaign(
  userAddress: string,
  campaignAddress: string,
  chainId = 0,
  _signOpts?: FollowSignOpts,
): Promise<void> {
  const user = assertAddr(userAddress, "user");
  const campaign = assertAddr(campaignAddress, "campaign");
  const payload: FollowCampaignPayload = {
    chainId: resolveChainId(chainId, user, campaign),
    userAddress: user,
    campaignAddress: campaign,
  };
  await api<{ ok: true }>(`/api/follows/campaign`, {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "unfollow" }),
  });
}

export async function isFollowingCampaign(userAddress: string, campaignAddress: string, chainId = 0): Promise<boolean> {
  const user = assertAddr(userAddress, "user");
  const campaign = assertAddr(campaignAddress, "campaign");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, user, campaign)), user, campaign });
  const out = await api<{ isFollowing: boolean }>(`/api/follows/campaign?${q.toString()}`);
  return !!out.isFollowing;
}

export async function getFollowedCampaigns(userAddress: string, chainId = 0): Promise<string[]> {
  const user = assertAddr(userAddress, "user");
  const q = new URLSearchParams({ chainId: String(resolveChainId(chainId, user)), user });
  const out = await api<{ items: string[] }>(`/api/follows/campaign-list?${q.toString()}`);
  return out.items || [];
}

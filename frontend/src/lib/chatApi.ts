import { apiFetch } from "@/lib/apiBase";

export type ChatProfile = {
  walletAddress: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  role?: string | null;
};

export type ChatSession = {
  sessionToken: string;
  expiresAt: string;
  profile: ChatProfile;
};

export type ChatMessage = {
  id: number;
  chainId: number;
  campaignAddress: string;
  walletAddress: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  role?: string | null;
  message: string;
  clientNonce?: string | null;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
};

async function parseResponse(res: Response) {
  const text = await res.text();
  const data = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })() : null;

  if (!res.ok) {
    throw new Error(data?.details || data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export async function getNonce(chainId: number, address: string) {
  const res = await apiFetch(`/api/auth/nonce?chainId=${encodeURIComponent(String(chainId))}&address=${encodeURIComponent(address)}`);
  const data = await parseResponse(res);
  if (!data?.nonce) throw new Error("Nonce missing");
  return String(data.nonce);
}

export function buildChatSessionMessage(args: { chainId: number; address: string; campaignAddress: string; nonce: string; }) {
  const address = String(args.address || "").trim();
  const campaign = String(args.campaignAddress || "").trim();
  const evmAddress = /^0x[a-fA-F0-9]{40}$/i.test(address);
  const evmCampaign = /^0x[a-fA-F0-9]{40}$/i.test(campaign);
  return [
    "MemeWarzone War Room",
    "Action: CHAT_SESSION",
    `ChainId: ${args.chainId}`,
    `Address: ${evmAddress ? address.toLowerCase() : address}`,
    `Campaign: ${evmCampaign ? campaign.toLowerCase() : campaign}`,
    `Nonce: ${args.nonce}`,
  ].join("\n");
}

export async function joinWarRoom(args: { chainId: number; campaignAddress: string; address: string; signature: string; nonce: string; creatorAddress?: string | null; }) {
  const res = await apiFetch("/api/chat/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return parseResponse(res) as Promise<ChatSession>;
}

/** Join with the feed session (one signature per 30 days): the server takes the wallet from the session. */
export async function joinWarRoomWithFeedSession(args: { chainId: number; campaignAddress: string; creatorAddress?: string | null; token: string; }) {
  const { token, ...rest } = args;
  const res = await apiFetch("/api/chat/join", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(rest),
  });
  if (res.status === 401) {
    // An expired or revoked feed session: the caller opens a new one and retries.
    throw Object.assign(new Error("Feed session required."), { code: "FEED_SESSION_REQUIRED" });
  }
  return parseResponse(res) as Promise<ChatSession>;
}

export async function fetchWarRoomHistory(args: { chainId: number; campaignAddress: string; limit?: number; beforeId?: number | null; }) {
  const qs = new URLSearchParams({
    chainId: String(args.chainId),
    campaignAddress: args.campaignAddress,
    limit: String(args.limit ?? 50),
  });
  if (args.beforeId != null) qs.set("beforeId", String(args.beforeId));
  const res = await apiFetch(`/api/chat/history?${qs.toString()}`);
  return parseResponse(res) as Promise<{ items: ChatMessage[]; nextBeforeId: number | null }>;
}

export async function sendWarRoomMessage(args: { chainId: number; campaignAddress: string; message: string; clientNonce: string; sessionToken: string; }) {
  const res = await apiFetch("/api/chat/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.sessionToken}`,
    },
    body: JSON.stringify({
      chainId: args.chainId,
      campaignAddress: args.campaignAddress,
      message: args.message,
      clientNonce: args.clientNonce,
    }),
  });
  return parseResponse(res) as Promise<{ item: ChatMessage; duplicate?: boolean }>;
}

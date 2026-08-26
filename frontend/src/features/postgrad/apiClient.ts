import { apiFetch } from "@/lib/apiBase";

type JsonObject = Record<string, any>;

export type PostGradWarRoomMode = "trending" | "new" | "graduated" | "draft";
export type PostGradLeagueAction = "advance-week" | "rebalance-divisions" | "cycle-season-state";

export type PostGradCampaignFeedParams = {
  chainId?: number | string | null;
  limit?: number;
  bnbUsd?: number | null;
  includeTestnet?: boolean;
  signal?: AbortSignal;
};

export type PostGradFeaturedFeedParams = {
  chainId?: number | string | null;
  limit?: number;
  includeTestnet?: boolean;
  signal?: AbortSignal;
};

export type PostGradWarRoomCampaignFeedParams = {
  chainId?: number | string | null;
  limit?: number;
  mode: PostGradWarRoomMode;
  search?: string;
  includeTestnet?: boolean;
  signal?: AbortSignal;
};

export type PostGradSponsoredFeedParams = {
  chainId?: number | string | null;
  limit?: number;
  /** Filter inventory by slot_code (e.g. homepage-sponsored-rail, featured-top-left). */
  slot?: string | null;
  /** When "one", server returns a single weighted/random pick (Featured top-left). */
  select?: "one" | "list" | null;
  strategy?: "weighted" | "random" | "priority" | null;
  signal?: AbortSignal;
};

export type OpenPostGradBattleInput = {
  tokenId: string;
  chainId?: number | null;
  stakeNative?: number;
  initialPotBnb?: number;
  auth?: JsonObject;
};

export type ChallengePostGradBattleInput = {
  tokenId: string;
  targetTokenId: string;
  chainId?: number | null;
  stakeNative: number;
  auth?: JsonObject;
};

export type PostGradWarPoolState = "open" | "locked" | "settling" | "paid";

function envFlag(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function isTestnetCampaignsEnabled(): boolean {
  return envFlag(import.meta.env.VITE_ENABLE_TESTNET_CAMPAIGNS) || envFlag(import.meta.env.VITE_WAR_ROOM_INCLUDE_TESTNET);
}

export function isWarRoomTestnetFeedEnabled(): boolean {
  return isTestnetCampaignsEnabled();
}

function applyTestnetCampaignParams(params: URLSearchParams, includeTestnet?: boolean): void {
  const shouldIncludeTestnet = includeTestnet ?? isTestnetCampaignsEnabled();
  if (!shouldIncludeTestnet) return;
  params.set("includeTestnet", "true");
  params.set("testnet", "true");
  params.set("includeDrafts", "true");
  params.set("status", "all");
}

async function readJson(response: Response): Promise<JsonObject | null> {
  return response.json().catch(() => null) as Promise<JsonObject | null>;
}

async function fetchJson(path: string, init?: RequestInit): Promise<JsonObject | null> {
  const response = await apiFetch(path, init);
  if (!response.ok) return null;
  const json = await readJson(response);
  return json && typeof json === "object" ? json : null;
}

async function mutateJson(path: string, body: JsonObject = {}): Promise<boolean> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) return false;
  const json = await readJson(response);
  return json == null || json.ok !== false;
}

async function mutateBattle(path: string, body: JsonObject = {}): Promise<JsonObject> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await readJson(response)) || {};
  if (!response.ok || json.ok === false) {
    throw new Error(String(json.error || json.reason || json.warning || `Request failed (${response.status})`));
  }
  return json;
}

export async function fetchPostGradBattleFeed(signal?: AbortSignal) {
  return fetchJson("/api/arena/battles", { cache: "no-store", signal });
}

export async function fetchPostGradCreatorBattleStatuses(creatorAddress: string, chainId?: number | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ creator: creatorAddress });
  if (chainId) params.set("chainId", String(chainId));
  return fetchJson(`/api/arena/battles/creator-status?${params.toString()}`, { cache: "no-store", signal });
}

export async function fetchPostGradBattleDetails(battleId: string, signal?: AbortSignal) {
  return fetchJson(`/api/arena/battles/${encodeURIComponent(battleId)}`, { cache: "no-store", signal });
}

export async function openPostGradBattle(input: OpenPostGradBattleInput) {
  const payload: JsonObject = {
    tokenId: input.tokenId,
    chainId: input.chainId || undefined,
    auth: input.auth,
  };

  const stake = input.stakeNative ?? input.initialPotBnb;
  if (typeof stake === "number" && stake > 0) payload.stakeNative = stake;

  await mutateBattle("/api/arena/battles/open", payload);
  return true;
}

export async function challengePostGradBattle(input: ChallengePostGradBattleInput) {
  await mutateBattle("/api/arena/battles/challenge", {
    tokenId: input.tokenId,
    targetTokenId: input.targetTokenId,
    chainId: input.chainId || undefined,
    stakeNative: input.stakeNative,
    auth: input.auth,
  });
  return true;
}

export async function acceptPostGradBattle(battleId: string, auth?: JsonObject) {
  await mutateBattle(`/api/arena/battles/${encodeURIComponent(battleId)}/accept`, { auth });
  return true;
}

export async function declinePostGradBattle(battleId: string, auth?: JsonObject) {
  await mutateBattle(`/api/arena/battles/${encodeURIComponent(battleId)}/decline`, { auth });
  return true;
}

export async function fetchPostGradEventFeed(signal?: AbortSignal) {
  return fetchJson("/api/arena/events", { cache: "no-store", signal });
}

export async function fetchPostGradEventDetails(eventId: string, signal?: AbortSignal) {
  return fetchJson(`/api/arena/events/${encodeURIComponent(eventId)}`, { cache: "no-store", signal });
}

export async function fetchPostGradLeagueFeed(signal?: AbortSignal) {
  return fetchJson("/api/arena/league", { cache: "no-store", signal });
}

export async function mutatePostGradLeague(action: PostGradLeagueAction) {
  return mutateJson("/api/arena/league/mutate", { action });
}

export async function fetchPostGradWarPool(battleId: string, signal?: AbortSignal) {
  return fetchJson(`/api/arena/war-pools/${encodeURIComponent(battleId)}`, { cache: "no-store", signal });
}

export async function fetchPostGradWarPoolSummary(signal?: AbortSignal) {
  return fetchJson("/api/arena/war-pools", { cache: "no-store", signal });
}

export async function supportPostGradWarPool(battleId: string, sideTokenId: string, amountUsd: number) {
  return mutateJson(`/api/arena/war-pools/${encodeURIComponent(battleId)}/support`, { sideTokenId, amountUsd });
}

export async function transitionPostGradWarPool(battleId: string, state: PostGradWarPoolState) {
  return mutateJson(`/api/arena/war-pools/${encodeURIComponent(battleId)}/transition`, { state });
}

export async function fetchPostGradSponsoredFeed({
  chainId = 97,
  limit = 4,
  slot = null,
  select = null,
  strategy = null,
  signal,
}: PostGradSponsoredFeedParams) {
  const params = new URLSearchParams({
    chainId: String(chainId || 97),
    limit: String(limit),
  });
  // Optional filters only — omit for Arena rail default list behavior.
  if (slot) params.set("slot", String(slot));
  if (select) params.set("select", String(select));
  if (strategy) params.set("strategy", String(strategy));

  return fetchJson(`/api/sponsored?${params.toString()}`, { cache: "no-store", signal });
}

export async function fetchPostGradFeaturedFeed({ chainId = 97, limit = 6, includeTestnet, signal }: PostGradFeaturedFeedParams) {
  const params = new URLSearchParams({
    chainId: String(chainId || 97),
    sort: "24h",
    limit: String(limit),
  });
  applyTestnetCampaignParams(params, includeTestnet);

  return fetchJson(`/api/featured?${params.toString()}`, { cache: "no-store", signal });
}

export async function fetchPostGradCampaignFeed({ chainId = 97, limit = 12, bnbUsd, includeTestnet, signal }: PostGradCampaignFeedParams) {
  const params = new URLSearchParams({
    chainId: String(chainId || 97),
    limit: String(limit),
    cursor: "0",
    tab: "trending",
    status: "all",
    sort: "default",
  });
  if (bnbUsd && Number.isFinite(bnbUsd)) params.set("bnbUsd", String(bnbUsd));
  applyTestnetCampaignParams(params, includeTestnet);

  return fetchJson(`/api/campaigns?${params.toString()}`, { cache: "no-store", signal });
}

export async function fetchPostGradWarRoomCampaignFeed({
  chainId = 97,
  limit = 250,
  mode,
  search = "",
  includeTestnet,
  signal,
}: PostGradWarRoomCampaignFeedParams) {
  const params = new URLSearchParams({
    chainId: String(chainId || 97),
    limit: String(limit),
    mode,
  });
  if (search.trim()) params.set("search", search.trim());
  applyTestnetCampaignParams(params, includeTestnet);

  return fetchJson(`/api/war-room?${params.toString()}`, { cache: "no-store", signal });
}

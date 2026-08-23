import { useEffect, useMemo, useState } from "react";
import { fetchPostGradWarRoomCampaignFeed, isWarRoomTestnetFeedEnabled } from "@/features/postgrad/apiClient";
import { useLeagueRealtime, type LeagueCampaignCreated, type LeaguePatch } from "@/hooks/useLeagueRealtime";
import { apiFetch } from "@/lib/apiBase";
import { fetchCampaignDraft, fetchPublicCampaignDrafts, type CampaignDraft, type PrepareDraftBundle } from "@/lib/draftApi";
import type { CampaignInfo } from "@/lib/launchpadClient";
import { resolveImageUri } from "@/lib/media";
import { fetchOnChainCampaignPage } from "@/lib/onChainCampaignFeed";
import { isSolanaAddress } from "@/lib/address";
import {
  getDefaultChainId,
  isSolanaChainId,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { liveCampaignKey } from "@/lib/liveMarketMerge";
import { fetchOnChainCampaignStats } from "@/lib/onChainCampaignStats";
import {
  lifecycleByCampaign,
  timestampSeconds,
  type CampaignDraftLifecycle,
  fetchPublicCampaignLifecycleDrafts,
} from "@/lib/scheduledLaunchApi";

export type WarRoomCampaign = CampaignInfo & Record<string, unknown>;
export type WarRoomMode = "trending" | "new" | "graduated" | "draft";
export type WarRoomCampaignFeedSource = "api" | "campaign-api" | "onchain" | "empty";

const PUBLIC_DRAFT_STATUSES = new Set(["promotion_published", "ready_to_launch", "scheduled"]);
/** Keep hydrate light — browser public RPCs cannot absorb bulk multicalls. */
const ONCHAIN_HYDRATE_CONCURRENCY = 4;
const MAX_ONCHAIN_STATS = 12;
/** Skip full on-chain inventory when the API already returned a usable list. */
const MIN_API_ROWS_TO_SKIP_INVENTORY = 3;

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

/** Drafts follow the selected feed chain only — do not mix 97 inventory into 56. */
function draftFeedChainIds(selectedChainId: number): number[] {
  return [Number(selectedChainId || getDefaultChainId())];
}

function scheduledLaunchSeconds(draft: CampaignDraftLifecycle | CampaignDraft) {
  return timestampSeconds((draft as CampaignDraftLifecycle).scheduledLaunchAt ?? (draft as any).tradingLaunchAt);
}

function isScheduledDraft(draft: CampaignDraftLifecycle | CampaignDraft) {
  return String(draft.status) === "scheduled";
}

/**
 * Pre-launch scheduled drafts only. Past-due scheduled with a campaign address
 * are live/bonding and must leave War Room Drafts (same rule as home Drafts grid).
 */
function isDiscoverableScheduledDraft(draft: CampaignDraftLifecycle | CampaignDraft, nowMs = Date.now()) {
  if (!isScheduledDraft(draft)) return false;
  const launchAt = scheduledLaunchSeconds(draft);
  const hasCampaign = Boolean(draft.campaignAddress);
  if (hasCampaign) {
    if (!launchAt || launchAt <= Math.floor(nowMs / 1000)) return false;
    return true;
  }
  return Boolean(launchAt);
}

/** Same discoverability rules as Showcase DraftCampaignGrid. */
function isDiscoverableDraft(draft: CampaignDraftLifecycle | CampaignDraft, nowMs = Date.now()) {
  const status = String(draft.status);
  if (!PUBLIC_DRAFT_STATUSES.has(status)) return false;
  if (status === "scheduled") return isDiscoverableScheduledDraft(draft, nowMs);
  // Un-deployed prepare pages only (armed timed launches use status=scheduled).
  return !draft.campaignAddress;
}

function isPreLaunchCampaign(input: {
  launchAtSec?: number | null;
  draftStatus?: string | null;
  nowSec?: number;
}) {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (String(input.draftStatus || "") === "scheduled") {
    const launchAt = Number(input.launchAtSec || 0);
    // Scheduled drafts stay non-tradeable until launchAt is known and has passed.
    if (!Number.isFinite(launchAt) || launchAt <= 0) return true;
    return launchAt > now;
  }
  const launchAt = Number(input.launchAtSec || 0);
  return Number.isFinite(launchAt) && launchAt > now;
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function lookupLeaguePatch(campaign: WarRoomCampaign, patchByCampaign: Record<string, LeaguePatch>) {
  const addr = String(campaign.campaign || "").trim();
  if (!addr) return undefined;
  const key = liveCampaignKey(Number(campaign.chainId || 0), addr);
  return patchByCampaign[key] || patchByCampaign[addr] || patchByCampaign[addr.toLowerCase()];
}

function overlayNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  return toNumber(value);
}

/** Overlay live league patches at read time so later inventory hydrates cannot wipe them. */
function overlayLeaguePatch(campaign: WarRoomCampaign, patchByCampaign: Record<string, LeaguePatch>): WarRoomCampaign {
  const patch = lookupLeaguePatch(campaign, patchByCampaign);
  if (!patch) return campaign;

  const next: WarRoomCampaign = { ...campaign };
  const marketcapBnb = overlayNumber(patch.marketcapBnb);
  if (marketcapBnb != null) (next as any).rtMarketcapBnb = marketcapBnb;
  const vol24hBnb = overlayNumber(patch.vol24hBnb);
  if (vol24hBnb != null) (next as any).rtVol24hBnb = vol24hBnb;
  const lastPriceBnb = overlayNumber(patch.lastPriceBnb);
  if (lastPriceBnb != null) {
    (next as any).priceBnb = lastPriceBnb;
    (next as any).lastPrice = lastPriceBnb;
  }
  if (marketcapBnb != null && lastPriceBnb != null && lastPriceBnb > 0) {
    (next as any).soldTokens = marketcapBnb / lastPriceBnb;
  }
  const raisedTotalBnb = overlayNumber(patch.raisedTotalBnb);
  if (raisedTotalBnb != null) (next as any).raisedTotalBnb = raisedTotalBnb;
  const votes24h = overlayNumber(patch.votes24h);
  if (votes24h != null) (next as any).votes24h = votes24h;
  const votesAllTime = overlayNumber(patch.votesAllTime);
  if (votesAllTime != null) (next as any).votesAllTime = votesAllTime;
  const lastActivityAt = overlayNumber(patch.lastActivityAt);
  if (lastActivityAt != null) (next as any).lastActivityAt = lastActivityAt;
  return next;
}

function toUnixSeconds(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function safeCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalizeStatus(item: any): "graduated" | "live" | "draft" | "ended" | undefined {
  const status = String(item?.status ?? item?.state ?? item?.lifecycleStatus ?? item?.lifecycle_status ?? "").toLowerCase();
  if (["graduated", "ended", "live", "draft"].includes(status)) return status as "graduated" | "live" | "draft" | "ended";
  if (Boolean(item?.isDexTrading ?? item?.is_dex_trading) || item?.dexPairAddress || item?.dex_pair_address) return "graduated";
  if (typeof item?.isDraft === "boolean" && item.isDraft) return "draft";
  if (typeof item?.is_draft === "boolean" && item.is_draft) return "draft";
  if (typeof item?.isActive === "boolean") return item.isActive ? "live" : "draft";
  if (typeof item?.is_active === "boolean") return item.is_active ? "live" : "draft";
  return undefined;
}

function preserveFeedAddress(value: unknown, chainId?: number): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (isSolanaChainId(Number(chainId)) || isSolanaAddress(raw)) return raw;
  return raw.toLowerCase();
}

function normalizeApiCampaign(item: any, index: number): WarRoomCampaign {
  const chainId = toNumber(item?.chainId ?? item?.chain_id);
  const campaign = preserveFeedAddress(item?.campaignAddress ?? item?.campaign_address ?? item?.campaign, chainId);
  const token = preserveFeedAddress(item?.tokenAddress ?? item?.token_address ?? item?.token, chainId);
  const creator = preserveFeedAddress(item?.creatorAddress ?? item?.creator_address ?? item?.creator, chainId);
  const normalizedStatus = normalizeStatus(item);
  const logo = resolveImageUri(item?.logoUri ?? item?.logoURI ?? item?.logo_url ?? item?.logo_uri) || "/placeholder.svg";
  const isDexTrading = Boolean((item?.isDexTrading ?? item?.is_dex_trading) ?? (normalizedStatus === "graduated" || normalizedStatus === "ended"));

  return {
    id: 100000 + index,
    chainId,
    campaign,
    token,
    creator,
    name: String(item?.name ?? "Unknown"),
    symbol: String(item?.symbol ?? ""),
    logoURI: logo,
    metadataURI: undefined,
    xAccount: String(item?.xAccount ?? item?.x_url ?? ""),
    website: String(item?.website ?? item?.website_url ?? ""),
    extraLink: String(item?.extraLink ?? item?.extra_link ?? ""),
    createdAt: toUnixSeconds(item?.createdAtChain ?? item?.created_at_chain ?? item?.createdAt ?? item?.created_at),
    status: normalizedStatus === "ended" ? "graduated" : normalizedStatus,
    isActive: typeof item?.isActive === "boolean" ? item.isActive : typeof item?.is_active === "boolean" ? item.is_active : normalizedStatus === "live" ? true : normalizedStatus === "draft" ? false : undefined,
    isDexTrading,
    graduatedAt: toUnixSeconds(item?.graduatedAtChain ?? item?.graduated_at_chain),
    holdersCount: toNumber(item?.holderCount ?? item?.holder_count ?? item?.holdersCount),
    holders: item?.holderCount != null || item?.holder_count != null || item?.holdersCount != null
      ? String(item?.holderCount ?? item?.holder_count ?? item?.holdersCount)
      : undefined,
    volumeBnb: toNumber(item?.vol24hBnb ?? item?.vol_24h_bnb ?? item?.volumeBnb),
    marketCapBnb: toNumber(item?.marketcapBnb ?? item?.marketcap_bnb ?? item?.marketCapBnb),
    athMarketCapBnb: toNumber(item?.athMarketcapBnb ?? item?.ath_marketcap_bnb ?? item?.athMarketCapBnb),
    raisedTotalBnb: toNumber(item?.raisedTotalBnb ?? item?.raised_total_bnb ?? item?.liquidityBnb),
    priceBnb: toNumber(item?.lastPriceBnb ?? item?.last_price_bnb ?? item?.priceBnb ?? item?.price_bnb),
    soldTokens: toNumber(item?.soldTokens ?? item?.sold_tokens),
    raised10mBnb: toNumber(item?.raised10mBnb ?? item?.raised_10m_bnb),
    progressPct: toNumber(item?.progressPct ?? item?.progress_pct) ?? null,
    etaSec: toNumber(item?.etaSec ?? item?.eta_sec) ?? null,
    votes24h: toNumber(item?.votes24h ?? item?.votes_24h),
    votesAllTime: toNumber(item?.votesAllTime ?? item?.votes_all_time),
    dexPairAddress: item?.dexPairAddress ?? item?.dex_pair_address ?? undefined,
  } as WarRoomCampaign;
}

function stubFromCreatedCampaign(item: LeagueCampaignCreated, index: number, chainId: number): WarRoomCampaign {
  return normalizeApiCampaign(
    {
      chainId,
      campaignAddress: item.campaignAddress,
      tokenAddress: item.tokenAddress,
      creatorAddress: item.creatorAddress,
      name: item.name ?? "Unknown",
      symbol: item.symbol ?? "",
      createdAtChain: item.createdAtChain ?? new Date().toISOString(),
      status: "live",
      isActive: true,
      isDexTrading: false,
    },
    300000 + index,
  );
}

function mapDraftToWarRoomCampaign(
  draft: CampaignDraftLifecycle | CampaignDraft,
  index: number,
  bundle?: PrepareDraftBundle | null,
): WarRoomCampaign {
  const draftSlug = String(draft.slug || "").trim();
  const promotionHref = draftSlug ? `/prepare/${draftSlug}` : `/drafts/${draft.id}`;
  const promotion = bundle?.promotion;
  const popularity = bundle?.popularity;
  const launchAtSec = scheduledLaunchSeconds(draft);
  const scheduled = isScheduledDraft(draft);
  // Prefer real campaign address for armed timed launches so we can de-dupe against on-chain rows,
  // but keep draft status so the row never opens a trade panel pre-launch.
  const draftChainId = Number(draft.chainId);
  const campaignKey = draft.campaignAddress
    ? preserveFeedAddress(draft.campaignAddress, draftChainId)
    : `draft:${draft.id}`;

  return {
    id: 200000 + index,
    chainId: draftChainId,
    campaign: campaignKey,
    token: "",
    creator: preserveFeedAddress(draft.creatorWallet, draftChainId),
    name: String(draft.name || "Unknown"),
    symbol: String(draft.ticker || ""),
    logoURI: resolveImageUri(promotion?.bannerUrl || draft.logoUrl) || resolveImageUri(draft.logoUrl) || "/placeholder.svg",
    metadataURI: undefined,
    xAccount: String(draft.xUrl || promotion?.xUrl || ""),
    website: String(draft.websiteUrl || promotion?.websiteUrl || ""),
    extraLink: String(draft.otherUrl || ""),
    createdAt: toUnixSeconds((draft as any).draftCreatedAt || draft.createdAt),
    status: "draft",
    isActive: false,
    isDexTrading: false,
    isScheduled: scheduled,
    launchAt: launchAtSec ?? undefined,
    draftId: draft.id,
    draftSlug,
    draftStatus: scheduled ? "scheduled" : draft.status,
    draftVisibility: draft.visibility,
    draftCategory: draft.category,
    draftDescription: draft.description || promotion?.missionStatement || "No promotion description has been added yet.",
    draftFounderNote: promotion?.creatorNote || "No founder note has been added yet.",
    draftUpdatedAt: draft.updatedAt,
    draftFollowCount: safeCount(popularity?.follows),
    draftOptInCount: safeCount(popularity?.armedCount),
    draftCommentCount: safeCount(popularity?.comments),
    promotionHref,
    scheduledCampaignAddress: draft.campaignAddress ? preserveFeedAddress(draft.campaignAddress, draftChainId) : null,
  } as WarRoomCampaign;
}

function modeToCampaignStatus(mode: WarRoomMode) {
  if (mode === "graduated") return "graduated";
  if (mode === "draft") return "ended";
  return "all";
}

function modeToCampaignTab(mode: WarRoomMode) {
  if (mode === "new") return "new";
  if (mode === "graduated") return "dex";
  return "trending";
}

function isGraduatedCampaign(campaign: WarRoomCampaign) {
  const rich = campaign as any;
  return Boolean(
    rich.isDexTrading ||
      rich.status === "graduated" ||
      rich.status === "ended" ||
      rich.dexPairAddress ||
      rich.graduatedAt,
  );
}

function isDraftOnlyRow(campaign: WarRoomCampaign) {
  const rich = campaign as any;
  if (isGraduatedCampaign(campaign)) return false;
  // Real market rows with campaign 0x addresses stay market even if a draft lifecycle row exists.
  const addr = String(campaign.campaign || "");
  const looksLikeMarket = /^0x[a-f0-9]{40}$/i.test(addr) || isSolanaAddress(addr);
  if (looksLikeMarket && (rich.isActive === true || rich.status === "live" || Number(rich.marketCapBnb || 0) > 0 || Number(rich.raisedTotalBnb || 0) > 0)) {
    return false;
  }
  const preLaunch = isPreLaunchCampaign({
    launchAtSec: rich.launchAt,
    draftStatus: rich.draftStatus || (rich.status === "draft" ? rich.draftStatus : null),
  });
  return (
    rich.status === "draft" ||
    preLaunch ||
    Boolean(rich.draftId && rich.isActive === false) ||
    Boolean(rich.isScheduled && !looksLikeMarket) ||
    addr.startsWith("draft:")
  );
}

function matchesMode(campaign: WarRoomCampaign, mode: WarRoomMode) {
  const graduated = isGraduatedCampaign(campaign);
  const draftOnly = isDraftOnlyRow(campaign);

  if (mode === "draft") return draftOnly;
  if (mode === "graduated") return graduated;
  // Trending / New: ALL tradeable market campaigns (bonding + graduated), never prepare-only drafts.
  // Sort by trend/new happens in the page — do not drop graduated from the inventory.
  return !draftOnly;
}

/** Fast local search index fields (no network). */
export function warRoomCampaignMatchesSearch(campaign: WarRoomCampaign, search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const rich = campaign as any;
  const haystack = [
    campaign.name,
    campaign.symbol,
    campaign.campaign,
    campaign.token,
    campaign.creator,
    rich.creatorName,
    rich.creatorUsername,
    rich.username,
    rich.displayName,
    rich.draftSlug,
    rich.scheduledCampaignAddress,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  // Support multi-token queries: "ddy 0x12"
  return query.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

function matchesModeAndSearch(campaign: WarRoomCampaign, mode: WarRoomMode, search: string) {
  return matchesMode(campaign, mode) && warRoomCampaignMatchesSearch(campaign, search);
}

function hasValue(value: unknown) {
  const raw = String(value ?? "").trim();
  return Boolean(raw && raw !== "0" && raw !== "-" && raw !== "—" && raw !== "/placeholder.svg");
}

function mergeWarRoomCampaign(base: WarRoomCampaign, incoming: WarRoomCampaign): WarRoomCampaign {
  const merged: WarRoomCampaign = { ...base, ...incoming };
  for (const key of ["name", "symbol", "logoURI", "metadataURI", "xAccount", "website", "extraLink"] as const) {
    if (hasValue((base as any)[key])) (merged as any)[key] = (base as any)[key];
    else if (hasValue((incoming as any)[key])) (merged as any)[key] = (incoming as any)[key];
  }
  merged.createdAt = base.createdAt || incoming.createdAt;
  merged.marketCapBnb = toNumber((base as any).marketCapBnb) || toNumber((incoming as any).marketCapBnb);
  merged.volumeBnb = toNumber((base as any).volumeBnb) || toNumber((incoming as any).volumeBnb);
  merged.raisedTotalBnb = toNumber((base as any).raisedTotalBnb) || toNumber((incoming as any).raisedTotalBnb);
  merged.holdersCount = toNumber((base as any).holdersCount) || toNumber((incoming as any).holdersCount);
  merged.athMarketCapBnb = toNumber((base as any).athMarketCapBnb) || toNumber((incoming as any).athMarketCapBnb);
  (merged as any).priceBnb = toNumber((base as any).priceBnb) || toNumber((incoming as any).priceBnb);
  return merged;
}

function needsMarketStats(campaign: WarRoomCampaign): boolean {
  if ((campaign as any).status === "draft" || Boolean((campaign as any).isScheduled)) return false;
  const mcap = toNumber((campaign as any).marketCapBnb) || 0;
  const ath = toNumber((campaign as any).athMarketCapBnb) || 0;
  return mcap <= 0 || ath <= 0;
}

async function hydrateSolanaBondingMetrics(campaign: WarRoomCampaign): Promise<WarRoomCampaign> {
  const address = String(campaign.campaign || "").trim();
  if (!address || String(campaign.campaign).startsWith("draft:")) return campaign;
  if (isGraduatedCampaign(campaign) || isDraftOnlyRow(campaign)) return campaign;
  try {
    const { resolveSolanaCampaignCurve, solanaMarginalSpotSol } = await import("@/lib/solanaCampaignRead");
    const state = await resolveSolanaCampaignCurve(address, address);
    if (!state || state.graduated || state.soldTokens <= 0n) return campaign;
    const decimals = Number(state.tokenDecimals || 6);
    const soldWhole = Number(state.soldTokens) / 10 ** decimals;
    const spot = solanaMarginalSpotSol(state, state.soldTokens);
    if (!(soldWhole > 0) || !(spot > 0)) return campaign;
    const raised = Number(state.netRaisedLamports) / 1_000_000_000;
    return {
      ...campaign,
      marketCapBnb: spot * soldWhole,
      priceBnb: spot,
      soldTokens: soldWhole,
      raisedTotalBnb: raised > 0 ? raised : toNumber((campaign as any).raisedTotalBnb),
    } as WarRoomCampaign;
  } catch {
    return campaign;
  }
}

async function hydrateCampaignMarketStats(campaign: WarRoomCampaign, chainId: number): Promise<WarRoomCampaign> {
  if (isSolanaChainId(chainId)) return hydrateSolanaBondingMetrics(campaign);
  if (!needsMarketStats(campaign) || !campaign.campaign || String(campaign.campaign).startsWith("draft:")) {
    return campaign;
  }
  const stats = await fetchOnChainCampaignStats({
    chainId: chainId as SupportedChainId,
    campaignAddress: campaign.campaign,
    tokenAddress: campaign.token,
  }).catch(() => null);
  if (!stats) return campaign;

  const marketCapBnb = stats.marketCapBnb ?? toNumber((campaign as any).marketCapBnb);
  const athMarketCapBnb = stats.athMarketCapBnb ?? marketCapBnb ?? toNumber((campaign as any).athMarketCapBnb);

  return normalizeApiCampaign(
    {
      ...campaign,
      ...stats,
      campaignAddress: campaign.campaign,
      tokenAddress: campaign.token,
      creatorAddress: campaign.creator,
      logoUri: campaign.logoURI,
      chainId: campaign.chainId ?? chainId,
      status: stats.isDexTrading || stats.status === "graduated" ? "graduated" : (campaign as any).status,
      isDexTrading: Boolean(stats.isDexTrading || (campaign as any).isDexTrading),
      isActive: (campaign as any).isActive,
      marketCapBnb,
      athMarketCapBnb,
      volumeBnb: stats.volumeBnb ?? (campaign as any).volumeBnb,
      raisedTotalBnb: stats.raisedTotalBnb ?? stats.liquidityBnb ?? (campaign as any).raisedTotalBnb,
      holdersCount: stats.holdersCount ?? (campaign as any).holdersCount,
      priceBnb: stats.priceBnb ?? (campaign as any).priceBnb,
      dexPairAddress: stats.dexPairAddress ?? (campaign as any).dexPairAddress,
    },
    Number(campaign.id || 0),
  );
}

/** Full market inventory for one chain (bonding + graduated). */
async function fetchCampaignApiInventoryForChain(chainId: number, signal: AbortSignal): Promise<WarRoomCampaign[]> {
  const params = new URLSearchParams({
    chainId: String(chainId),
    limit: "250",
    cursor: "0",
    tab: "trending",
    sort: "default",
    status: "all",
  });
  if (chainId === 97 && isWarRoomTestnetFeedEnabled()) {
    params.set("includeTestnet", "true");
    params.set("testnet", "true");
  }
  const response = await apiFetch(`/api/campaigns?${params.toString()}`, { cache: "no-store" as RequestCache, signal });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(json?.error || `Campaign inventory HTTP ${response.status}`));
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.map((item: any, index: number) => normalizeApiCampaign(item, index));
}

/** Inventory follows the selected feed chain only — do not mix 97 inventory into 56. */
async function fetchCampaignApiInventory(selectedChainId: number, signal: AbortSignal): Promise<WarRoomCampaign[]> {
  const chainIds = [Number(selectedChainId || getDefaultChainId())];

  const pages = await Promise.all(
    chainIds.map((id) => fetchCampaignApiInventoryForChain(id, signal).catch(() => [] as WarRoomCampaign[])),
  );
  const byKey = new Map<string, WarRoomCampaign>();
  for (const page of pages) {
    for (const row of page) {
      const key = `${Number((row as any).chainId || 0)}:${String(row.campaign || "").toLowerCase()}`;
      if (!row.campaign || byKey.has(key)) continue;
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

async function fetchDraftCampaignsForWarRoom(selectedChainId: number): Promise<WarRoomCampaign[]> {
  try {
    const chainIds = draftFeedChainIds(selectedChainId);
    // Match Showcase: public drafts are the primary discovery source
    // (promotion_published + ready_to_launch + scheduled).
    // lifecycle=campaign only returns armed/scheduled campaign rows — merge it
    // for launchAt metadata, never use it as the sole source.
    const [publicPages, lifecyclePages] = await Promise.all([
      Promise.all(
        chainIds.map((id) =>
          fetchPublicCampaignDrafts({ chainId: id, limit: 100 }).catch(() => [] as CampaignDraft[]),
        ),
      ),
      Promise.all(
        chainIds.map((id) =>
          fetchPublicCampaignLifecycleDrafts({ chainId: id, limit: 200 }).catch(
            () => [] as CampaignDraftLifecycle[],
          ),
        ),
      ),
    ]);

    const byId = new Map<string, CampaignDraftLifecycle>();
    for (const draft of [...publicPages.flat(), ...lifecyclePages.flat()]) {
      const id = String(draft?.id || "");
      if (!id) continue;
      const current = byId.get(id);
      byId.set(id, current ? ({ ...current, ...draft } as CampaignDraftLifecycle) : (draft as CampaignDraftLifecycle));
    }

    const visibleDrafts = Array.from(byId.values())
      .filter((draft) => chainIds.includes(Number(draft.chainId)))
      .filter((draft) => draft.visibility === "public" || !draft.visibility)
      .filter((draft) => String(draft.status) !== "deployed" && String(draft.status) !== "archived")
      .filter((draft) => isDiscoverableDraft(draft))
      .sort((a, b) =>
        String((b as any).draftCreatedAt || b.createdAt || "").localeCompare(
          String((a as any).draftCreatedAt || a.createdAt || ""),
        ),
      )
      .slice(0, 100);

    // Cap bundle hydration — popularity is nice-to-have, not worth melting the browser.
    const hydrateLimit = Math.min(visibleDrafts.length, 30);
    const hydrated = await mapPool(visibleDrafts.slice(0, hydrateLimit), 3, async (draft, index) => {
      const bundle = await fetchCampaignDraft(draft.id).catch(() => null);
      return mapDraftToWarRoomCampaign(draft, index, bundle);
    });
    const tail = visibleDrafts.slice(hydrateLimit).map((draft, index) => mapDraftToWarRoomCampaign(draft, hydrateLimit + index, null));

    return [...hydrated, ...tail];
  } catch (error) {
    console.warn("[useWarRoomCampaignFeed] public draft fallback failed", error);
    return [];
  }
}

export function useWarRoomCampaignFeed({
  activeMode,
  activeChainId,
  bnbUsd: _bnbUsd,
}: {
  activeMode: WarRoomMode;
  activeChainId: number | undefined;
  bnbUsd: number | null;
  /** @deprecated Search is local-only in WarRoom — ignored here. */
  search?: string;
}) {
  /** Full inventory for the chain (market rows + drafts). Mode is filtered in the UI. */
  const [inventory, setInventory] = useState<WarRoomCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<WarRoomCampaignFeedSource>("empty");
  const chainId = Number(activeChainId || getDefaultChainId());
  const { patchByCampaign, created } = useLeagueRealtime({
    enabled: true,
    chainId,
    fallbackMs: 25000,
    softRefreshMs: 0, // no extra REST loop — feed is one-shot + Ably
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const mergeLists = (
      onChainItems: WarRoomCampaign[],
      apiItems: WarRoomCampaign[],
      draftItems: WarRoomCampaign[],
      nowSec: number,
    ) => {
      const mergedMap = new Map<string, WarRoomCampaign>();
      // Prefer market rows (on-chain / API) over draft rows so graduated campaigns are not demoted.
      for (const campaign of [...onChainItems, ...apiItems, ...draftItems]) {
        if (!campaign.campaign) continue;
        const key = String(campaign.campaign).toLowerCase();
        const current = mergedMap.get(key);
        if (!current) {
          mergedMap.set(key, campaign);
          continue;
        }

        const currentGraduated = isGraduatedCampaign(current);
        const nextGraduated = isGraduatedCampaign(campaign);
        if (currentGraduated || nextGraduated) {
          const base = currentGraduated ? current : campaign;
          const extra = currentGraduated ? campaign : current;
          const merged = mergeWarRoomCampaign(base, extra);
          (merged as any).status = "graduated";
          (merged as any).isDexTrading = true;
          (merged as any).isActive = false;
          (merged as any).isScheduled = false;
          (merged as any).draftId = undefined;
          (merged as any).draftStatus = undefined;
          mergedMap.set(key, merged);
          continue;
        }

        const currentPreLaunch =
          (current as any).status === "draft" ||
          Boolean((current as any).isScheduled) ||
          isPreLaunchCampaign({
            launchAtSec: (current as any).launchAt,
            draftStatus: (current as any).draftStatus,
            nowSec,
          });
        const nextPreLaunch =
          (campaign as any).status === "draft" ||
          Boolean((campaign as any).isScheduled) ||
          isPreLaunchCampaign({
            launchAtSec: (campaign as any).launchAt,
            draftStatus: (campaign as any).draftStatus,
            nowSec,
          });

        if (currentPreLaunch || nextPreLaunch) {
          const base = currentPreLaunch ? current : campaign;
          const extra = currentPreLaunch ? campaign : current;
          const merged = mergeWarRoomCampaign(base, extra);
          (merged as any).status = "draft";
          (merged as any).isActive = false;
          (merged as any).isDexTrading = false;
          (merged as any).isScheduled = true;
          mergedMap.set(key, merged);
          continue;
        }

        mergedMap.set(key, mergeWarRoomCampaign(current, campaign));
      }
      return Array.from(mergedMap.values()).filter((campaign: WarRoomCampaign) => campaign.campaign);
    };

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const chainId = Number(activeChainId || getDefaultChainId());
        const nowSec = Math.floor(Date.now() / 1000);

        // ── Phase 0: full market inventory once (bonding + graduated) — no search param ──
        let feedSource: WarRoomCampaignFeedSource = "campaign-api";
        let apiItems: WarRoomCampaign[] = [];
        try {
          // Prefer direct campaigns inventory (status=all) so both live + graduated paint together.
          apiItems = await fetchCampaignApiInventory(chainId, controller.signal);
          if (!apiItems.length) {
            const json = await fetchPostGradWarRoomCampaignFeed({
              chainId,
              mode: "trending",
              search: "",
              includeTestnet: chainId === 97 && isWarRoomTestnetFeedEnabled(),
              signal: controller.signal,
            });
            apiItems = Array.isArray(json?.items)
              ? json.items.map((item: any, index: number) => normalizeApiCampaign(item, index))
              : [];
            if (apiItems.length) feedSource = "api";
          }
        } catch {
          apiItems = await fetchCampaignApiInventory(chainId, controller.signal).catch(() => []);
        }

        if (!cancelled && apiItems.length) {
          setInventory(apiItems);
          setSource(feedSource);
          setLoading(false);
        }

        // ── Phase 1: drafts + lifecycle in parallel (does not block first paint) ──
        const [draftItems, lifecyclePages] = await Promise.all([
          fetchDraftCampaignsForWarRoom(chainId),
          Promise.all(
            draftFeedChainIds(chainId).map((id) =>
              fetchPublicCampaignLifecycleDrafts({ chainId: id, limit: 80 }).catch(
                () => [] as CampaignDraftLifecycle[],
              ),
            ),
          ),
        ]);
        if (cancelled) return;

        const lifecycleByAddress = lifecycleByCampaign(lifecyclePages.flat());
        // Never demote a live/graduated market row to draft — that was wiping coins after first paint.
        const apiWithLifecycle = apiItems.map((campaign) => {
          if (isGraduatedCampaign(campaign)) return campaign;
          if (campaign.isActive === true || (campaign as any).status === "live") return campaign;
          const address = String(campaign.campaign || "").toLowerCase();
          if (!/^0x[a-f0-9]{40}$/i.test(address)) return campaign;
          const lifecycle = lifecycleByAddress.get(address);
          if (!lifecycle || String(lifecycle.status) !== "scheduled") return campaign;
          const launchAt = timestampSeconds(lifecycle.scheduledLaunchAt || lifecycle.tradingLaunchAt);
          // Only demote pure pre-launch scheduled rows (future launch, not yet trading).
          if (!launchAt || launchAt <= nowSec) return campaign;
          return {
            ...campaign,
            status: "draft",
            isActive: false,
            isDexTrading: false,
            isScheduled: true,
            launchAt,
            draftId: lifecycle.id,
            draftSlug: lifecycle.slug,
            draftStatus: "scheduled",
            promotionHref: lifecycle.slug ? `/prepare/${lifecycle.slug}` : `/drafts/${lifecycle.id}`,
          } as WarRoomCampaign;
        });

        let painted = mergeLists([], apiWithLifecycle, draftItems, nowSec);
        if (!cancelled) {
          setInventory(painted);
          setSource(painted.length ? feedSource : "empty");
          setLoading(false);
        }

        // ── Phase 2: on-chain factory page only if inventory is thin ──
        let onChainItems: WarRoomCampaign[] = [];
        if (apiWithLifecycle.length < MIN_API_ROWS_TO_SKIP_INVENTORY) {
          const onChainPage = await fetchOnChainCampaignPage(chainId as SupportedChainId, {
            limit: 24,
            skipLifecycleFilter: true,
          }).catch(() => ({ campaigns: [], nextCursor: null, total: 0 }));
          if (cancelled) return;

          onChainItems = onChainPage.campaigns.slice(0, MAX_ONCHAIN_STATS).map((campaign, index) => {
            const address = String(campaign.campaign || "").toLowerCase();
            const lifecycle = lifecycleByAddress.get(address);
            const launchAtOnChain = timestampSeconds(lifecycle?.scheduledLaunchAt || lifecycle?.tradingLaunchAt);
            const apiKnown = apiWithLifecycle.find((item) => String(item.campaign || "").toLowerCase() === address);
            const launched = Boolean(apiKnown && isGraduatedCampaign(apiKnown));
            const preLaunch =
              !launched &&
              isPreLaunchCampaign({
                launchAtSec: launchAtOnChain,
                draftStatus: lifecycle?.status,
                nowSec,
              });
            return normalizeApiCampaign(
              {
                ...campaign,
                chainId,
                campaignAddress: campaign.campaign,
                tokenAddress: campaign.token,
                creatorAddress: campaign.creator,
                logoUri: campaign.logoURI,
                createdAtChain: campaign.createdAt,
                status: launched ? "graduated" : preLaunch ? "draft" : "live",
                isActive: !preLaunch && !launched,
                isDexTrading: launched,
                isScheduled: preLaunch || (!launched && String(lifecycle?.status) === "scheduled"),
                launchAt: launchAtOnChain ?? undefined,
              },
              500000 + index,
            );
          });

          painted = mergeLists(onChainItems, apiWithLifecycle, draftItems, nowSec);
          if (!cancelled) {
            setInventory(painted);
            setSource(painted.length ? (onChainItems.length ? "onchain" : feedSource) : "empty");
            setLoading(false);
          }
        }

        // ── Phase 3: Solana bonding always hydrates spot × sold (API fill VWAP is not mcap).
        const needStats = (
          isSolanaChainId(chainId)
            ? painted.filter((row) => !isDraftOnlyRow(row) && !String(row.campaign || "").startsWith("draft:"))
            : painted.filter(needsMarketStats)
        ).slice(0, isSolanaChainId(chainId) ? 40 : MAX_ONCHAIN_STATS);
        if (needStats.length) {
          const hydrated = await mapPool(
            needStats,
            ONCHAIN_HYDRATE_CONCURRENCY,
            (campaign) => hydrateCampaignMarketStats(campaign, chainId),
          );
          if (cancelled) return;
          const byKey = new Map(hydrated.map((c) => [String(c.campaign).toLowerCase(), c]));
          const enriched = painted.map((c) => byKey.get(String(c.campaign).toLowerCase()) || c);
          setInventory(enriched);
          setSource(enriched.length ? (onChainItems.length ? "onchain" : feedSource) : "empty");
        }
      } catch (loadError) {
        if (controller.signal.aborted) return;
        console.error("[useWarRoomCampaignFeed] failed to load campaigns", loadError);
        if (!cancelled) {
          setInventory([]);
          setSource("empty");
          setError(loadError instanceof Error ? loadError.message : "Failed to load market campaigns");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeChainId]);

  // Mode filter is pure client — switching Trending ↔ Graduated is instant.
  // Patches overlay at read time so later hydrate setInventory cannot bake over live values.
  const campaigns = useMemo(() => {
    const seen = new Set(
      inventory
        .map((campaign) => String(campaign.campaign || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const extras: WarRoomCampaign[] = [];
    for (const item of created) {
      const rawAddr = String(item?.campaignAddress || "").trim();
      if (!rawAddr || seen.has(rawAddr.toLowerCase())) continue;
      seen.add(rawAddr.toLowerCase());
      extras.push(stubFromCreatedCampaign(item, extras.length, chainId));
    }

    const merged = extras.length ? [...inventory, ...extras] : inventory;
    return merged
      .map((campaign) => overlayLeaguePatch(campaign, patchByCampaign))
      .filter((campaign) => matchesMode(campaign, activeMode));
  }, [activeMode, chainId, created, inventory, patchByCampaign]);

  return { campaigns, loading, error, source };
}

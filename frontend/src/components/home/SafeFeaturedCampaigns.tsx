import { useEffect, useMemo, useRef, useState } from "react";
import { Contract } from "ethers";
import { useNavigate } from "react-router-dom";
import { ThumbsUp } from "lucide-react";
import { UpvoteDialog } from "@/components/token/UpvoteDialog";
import {
  SponsoredFeaturedSlotCard,
  type FeaturedSponsorPlacement,
} from "@/components/home/SponsoredFeaturedSlotCard";
import { FEATURED_SPONSOR_SLOT, loadFeaturedSponsorSlot } from "@/lib/featuredSponsor";
import { SponsorshipApplyDialog } from "@/components/home/SponsorshipApplyDialog";
import { AdvertisementNoticeDialog } from "@/components/home/AdvertisementNoticeDialog";
import { apiFetch } from "@/lib/apiBase";
import { fetchPublicCampaignDrafts } from "@/lib/draftApi";
import { resolveImageUri } from "@/lib/media";
import { getReadProvider } from "@/lib/readProvider";
import { fetchOnChainCampaignPage } from "@/lib/onChainCampaignFeed";
import { fetchOnChainCampaignStats } from "@/lib/onChainCampaignStats";
import { getPublicTokenDetailRoute } from "@/features/postgrad/identityRoutes";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { isTestnetCampaignsEnabled } from "@/features/postgrad/apiClient";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import { useLeagueRealtime } from "@/hooks/useLeagueRealtime";
import { BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, getDefaultChainId, type SupportedChainId } from "@/lib/chainConfig";
import { liveCampaignKey, pickLiveNumeric } from "@/lib/liveMarketMerge";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";

/** Soft rank poll while page is open — pump.fun-style board movement without full remount. */
const FEATURED_SOFT_POLL_MS = 10000;
export { FEATURED_SPONSOR_SLOT };

const CAMPAIGN_ABI = LaunchCampaignArtifact.abi;
const TOKEN_ABI = LaunchTokenArtifact.abi;

type FeaturedItem = {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  creatorAddress?: string | null;
  name?: string | null;
  symbol?: string | null;
  logoUri?: string | null;
  votes24h?: number | null;
  votesAllTime?: number | null;
  marketcapBnb?: string | null;
  liveMarketcapBnb?: string | null;
  graduatedAtChain?: string | null;
  isDexTrading?: boolean;
};

type FeaturedCard = FeaturedItem & {
  mcapUsdLabel: string | null;
  athUsdLabel: string;
};

function isAddress(value: unknown) {
  const raw = String(value ?? "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return true;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
}

function usefulImage(value: unknown) {
  const raw = String(value ?? "").trim();
  return Boolean(raw && raw !== "/placeholder.svg" && raw !== "-");
}

function formatCompactUsd(value: number) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function getAthLabel(_chainId: number, _campaignAddress: string, currentUsd: number | null, indexedAthUsd?: number | null) {
  const live = Number(currentUsd);
  const indexed = Number(indexedAthUsd);
  const ath = Math.max(Number.isFinite(live) && live > 0 ? live : 0, Number.isFinite(indexed) && indexed > 0 ? indexed : 0);
  return ath > 0 ? formatCompactUsd(ath) : "—";
}

function normalizeItem(raw: any, fallbackChainId: number): FeaturedItem | null {
  const rawAddress = String(raw?.campaignAddress ?? raw?.campaign_address ?? raw?.campaign ?? "").trim();
  const chainId = Number(raw?.chainId ?? raw?.chain_id ?? fallbackChainId);
  const campaignAddress = liveCampaignKey(chainId, rawAddress);
  if (!isAddress(campaignAddress)) return null;
  return {
    chainId,
    campaignAddress,
    tokenAddress: raw?.tokenAddress ?? raw?.token_address ?? raw?.token ?? null,
    creatorAddress: raw?.creatorAddress ?? raw?.creator_address ?? raw?.creator ?? null,
    name: raw?.name ?? null,
    symbol: raw?.symbol ?? raw?.ticker ?? null,
    logoUri: raw?.logoUri ?? raw?.logo_uri ?? raw?.logoURI ?? null,
    votes24h: Number(raw?.votes24h ?? raw?.votes_24h ?? 0),
    votesAllTime: Number(raw?.votesAllTime ?? raw?.votes_all_time ?? 0),
    marketcapBnb: raw?.marketcapBnb ?? raw?.marketcap_bnb ?? null,
    graduatedAtChain: raw?.graduatedAtChain ?? raw?.graduated_at_chain ?? null,
    isDexTrading: Boolean(raw?.isDexTrading ?? raw?.is_dex_trading ?? raw?.status === "graduated"),
  };
}

async function safeString(read: () => Promise<unknown>, fallback = "") {
  try {
    const value = String((await read()) ?? "").trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function itemKey(item: Pick<FeaturedItem, "chainId" | "campaignAddress">) {
  return `${Number(item.chainId)}:${liveCampaignKey(Number(item.chainId), String(item.campaignAddress || ""))}`;
}

function isBnbDualFeedChain(chainId: number) {
  return chainId === BNB_CHAIN_ID || chainId === BNB_TESTNET_CHAIN_ID;
}

/** Selected BNB main/test both share the dual featured board. */
function featuredEventMatchesChain(selectedChainId: number, eventChainId?: number | null) {
  if (eventChainId == null || !Number.isFinite(Number(eventChainId))) return true;
  const cid = Number(eventChainId);
  if (cid === selectedChainId) return true;
  return isBnbDualFeedChain(selectedChainId) && isBnbDualFeedChain(cid);
}

function mergeFeaturedItems(prev: FeaturedItem[], incoming: FeaturedItem[], opts?: { preferIncomingVotes?: boolean }): FeaturedItem[] {
  const map = new Map<string, FeaturedItem>();
  for (const item of prev) map.set(itemKey(item), item);
  for (const item of incoming) {
    const key = itemKey(item);
    const old = map.get(key);
    if (!old) {
      map.set(key, item);
      continue;
    }
    const oldV24 = Number(old.votes24h || 0);
    const oldVAll = Number(old.votesAllTime || 0);
    const inV24 = Number(item.votes24h || 0);
    const inVAll = Number(item.votesAllTime || 0);
    map.set(key, {
      ...old,
      ...item,
      name: item.name || old.name,
      symbol: item.symbol || old.symbol,
      logoUri: usefulImage(item.logoUri) ? item.logoUri : old.logoUri,
      tokenAddress: isAddress(item.tokenAddress) ? item.tokenAddress : old.tokenAddress,
      creatorAddress: isAddress(item.creatorAddress) ? item.creatorAddress : old.creatorAddress,
      marketcapBnb:
        item.marketcapBnb != null && item.marketcapBnb !== "" && Number(item.marketcapBnb) > 0
          ? item.marketcapBnb
          : old.marketcapBnb,
      liveMarketcapBnb:
        item.liveMarketcapBnb != null && item.liveMarketcapBnb !== ""
          ? item.liveMarketcapBnb
          : old.liveMarketcapBnb,
      // Keep optimistic local bumps from going backwards when indexer lags a few seconds.
      votes24h: opts?.preferIncomingVotes ? inV24 : Math.max(oldV24, inV24),
      votesAllTime: opts?.preferIncomingVotes ? inVAll : Math.max(oldVAll, inVAll),
    });
  }
  return Array.from(map.values());
}

function campaignAddrsMatch(itemAddr: string, patchAddr: string, itemChainId: number, patchChainId?: number) {
  const left = liveCampaignKey(Number(itemChainId), itemAddr);
  const right = liveCampaignKey(Number(patchChainId ?? itemChainId), patchAddr);
  return Boolean(left && right && left === right);
}

function applyVotePatch(
  items: FeaturedItem[],
  patch: { chainId?: number; campaignAddress: string; votes24h?: number; votesAllTime?: number; delta?: number },
): FeaturedItem[] {
  const addr = liveCampaignKey(Number(patch.chainId || 0), String(patch.campaignAddress || ""));
  if (!isAddress(addr)) return items;
  const delta = Number(patch.delta || 0);
  const idx = items.findIndex((item) => {
    if (!campaignAddrsMatch(String(item.campaignAddress), addr, Number(item.chainId), patch.chainId)) return false;
    if (patch.chainId == null) return true;
    // BNB dual board: address match is enough when either side is 56/97.
    if (isBnbDualFeedChain(Number(item.chainId)) && isBnbDualFeedChain(Number(patch.chainId))) return true;
    return Number(item.chainId) === Number(patch.chainId);
  });

  if (idx < 0) {
    if (!delta && patch.votes24h == null && patch.votesAllTime == null) return items;
    const seedVotes = Math.max(1, Number(patch.votes24h ?? delta ?? 1));
    const seed: FeaturedItem = {
      chainId: Number(patch.chainId || 0) || getDefaultChainId(),
      campaignAddress: addr,
      votes24h: seedVotes,
      votesAllTime: Math.max(seedVotes, Number(patch.votesAllTime ?? delta ?? 1)),
      name: null,
      symbol: null,
      logoUri: null,
    };
    return mergeFeaturedItems(items, [seed]);
  }

  const cur = items[idx];
  const nextVotes24 = Math.max(Number(cur.votes24h || 0) + delta, Number(patch.votes24h ?? 0), Number(cur.votes24h || 0));
  const nextVotesAll = Math.max(
    Number(cur.votesAllTime || 0) + delta,
    Number(patch.votesAllTime ?? 0),
    Number(cur.votesAllTime || 0),
  );
  if (nextVotes24 === Number(cur.votes24h || 0) && nextVotesAll === Number(cur.votesAllTime || 0)) return items;
  const next = items.slice();
  next[idx] = { ...cur, votes24h: nextVotes24, votesAllTime: nextVotesAll };
  return next;
}

function applyLiveMcap(
  items: FeaturedItem[],
  patch: { chainId?: number; campaignAddress: string; marketcapBnb: number },
): FeaturedItem[] {
  const addr = liveCampaignKey(Number(patch.chainId || 0), String(patch.campaignAddress || ""));
  if (!isAddress(addr) || !(patch.marketcapBnb > 0)) return items;
  const idx = items.findIndex((item) => {
    if (!campaignAddrsMatch(String(item.campaignAddress), addr, Number(item.chainId), patch.chainId)) return false;
    if (patch.chainId == null) return true;
    if (isBnbDualFeedChain(Number(item.chainId)) && isBnbDualFeedChain(Number(patch.chainId))) return true;
    return Number(item.chainId) === Number(patch.chainId);
  });
  if (idx < 0) return items;
  const cur = items[idx];
  const label = String(patch.marketcapBnb);
  if (cur.liveMarketcapBnb === label) return items;
  const next = items.slice();
  next[idx] = { ...cur, liveMarketcapBnb: label };
  return next;
}

/** Lightweight featured ranks (vote board only) for live soft-poll. */
async function loadFeaturedVoteRanks(chainId: number): Promise<FeaturedItem[]> {
  const { getBnbCampaignFeedChainIds } = await import("@/lib/feedChainConfig");
  const chainIds = getBnbCampaignFeedChainIds(chainId);
  const pages = await Promise.all(
    chainIds.map(async (id) => {
      const query = new URLSearchParams({
        chainId: String(id),
        limit: "20",
        sort: "24h",
        _r: String(Date.now()),
      });
      try {
        const response = await apiFetch(`/api/featured?${query.toString()}`, { cache: "no-store" });
        const json = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(json?.items)) return [] as FeaturedItem[];
        return json.items.map((item: any) => normalizeItem(item, id)).filter(Boolean) as FeaturedItem[];
      } catch {
        return [] as FeaturedItem[];
      }
    }),
  );
  return mergeFeaturedItems([], pages.flat(), { preferIncomingVotes: true });
}

async function loadApiCandidatesForChain(chainId: number): Promise<FeaturedItem[]> {
  // Rank by 24h UpVotes (matches Featured UI label). activity sort is last_activity_at.
  const query = new URLSearchParams({ chainId: String(chainId), limit: "20", sort: "24h", _r: String(Date.now()) });
  try {
    const response = await apiFetch(`/api/featured?${query.toString()}`, { cache: "no-store" });
    const json = await response.json().catch(() => null);
    if (response.ok && Array.isArray(json?.items) && json.items.length) {
      return json.items.map((item: any) => normalizeItem(item, chainId)).filter(Boolean) as FeaturedItem[];
    }
  } catch {
    // Continue to the live campaign fallback below.
  }

  query.set("status", "all");
  query.set("tab", "trending");
  query.set("sort", "default");
  if (chainId === 97 && isTestnetCampaignsEnabled()) {
    query.set("includeTestnet", "true");
    query.set("testnet", "true");
  }
  try {
    const response = await apiFetch(`/api/campaigns?${query.toString()}`, { cache: "no-store" });
    const json = await response.json().catch(() => null);
    if (response.ok && Array.isArray(json?.items)) {
      return json.items.map((item: any) => normalizeItem(item, chainId)).filter(Boolean) as FeaturedItem[];
    }
  } catch {
    // The on-chain fallback below remains available.
  }

  return [];
}

async function loadApiCandidates(chainId: number): Promise<FeaturedItem[]> {
  const { getBnbCampaignFeedChainIds } = await import("@/lib/feedChainConfig");
  const chainIds = getBnbCampaignFeedChainIds(chainId);
  const pages = await Promise.all(chainIds.map((id) => loadApiCandidatesForChain(id)));
  const seen = new Set<string>();
  const out: FeaturedItem[] = [];
  for (const page of pages) {
    for (const item of page) {
      const key = `${item.chainId}:${String(item.campaignAddress || "").toLowerCase()}`;
      if (!item.campaignAddress || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

async function loadOnChainCandidates(chainId: number): Promise<FeaturedItem[]> {
  try {
    const page = await fetchOnChainCampaignPage(chainId as any, { limit: 100, cursor: 0 });
    return page.campaigns.map((row) => normalizeItem({
      chainId,
      campaignAddress: row.campaign,
      tokenAddress: row.token,
      creatorAddress: row.creator,
      name: row.name,
      symbol: row.symbol,
      logoUri: row.logoURI,
    }, chainId)).filter(Boolean) as FeaturedItem[];
  } catch {
    return [];
  }
}

async function fetchRegisteredLogo(chainId: number, address?: string | null): Promise<string | null> {
  const raw = String(address ?? "").trim();
  if (!isAddress(raw)) return null;
  try {
    const response = await apiFetch(`/api/token-metadata/${chainId}/${raw}`, { cache: "no-store" });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) return null;
    const logo = json.image || json.image_url || json.logoUri || json.logo_uri || json.logoURI || null;
    return usefulImage(logo) ? String(logo) : null;
  } catch {
    return null;
  }
}

async function hydrateMissingLogo(item: FeaturedItem): Promise<FeaturedItem> {
  if (usefulImage(item.logoUri)) return item;
  // Prefer token-keyed metadata, then campaign-keyed (common mix-up after direct deploy).
  for (const address of [item.tokenAddress, item.campaignAddress]) {
    const logo = await fetchRegisteredLogo(item.chainId, address);
    if (logo) return { ...item, logoUri: logo };
  }
  return item;
}

async function hydrateMissingSummary(item: FeaturedItem, options?: { includeOnChainMcap?: boolean }): Promise<FeaturedItem> {
  let next = await hydrateMissingLogo(item);

  if (next.marketcapBnb == null || next.marketcapBnb === "" || Number(next.votes24h || 0) <= 0) {
    try {
      // Summary endpoints accept either identity; prefer token for public consistency.
      const identity = next.tokenAddress || next.campaignAddress;
      const response = await apiFetch(`/api/token/${identity}/summary?chainId=${next.chainId}`, {
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (response.ok && json) {
        next = {
          ...next,
          marketcapBnb: json.marketcapBnb ?? json.marketcap_bnb ?? next.marketcapBnb ?? null,
          votes24h: Number(json.votes24h ?? json.votes_24h ?? next.votes24h ?? 0),
          votesAllTime: Number(json.votesAllTime ?? json.votes_all_time ?? next.votesAllTime ?? 0),
          logoUri: usefulImage(next.logoUri)
            ? next.logoUri
            : (json.logoUri ?? json.logo_uri ?? json.logoURI ?? next.logoUri),
        };
      }
    } catch {
      // Fall through to on-chain stats when needed.
    }
  }

  // Indexer token_stats is often empty on testnet — fill mcap from bonding curve for upvoted cards only.
  const hasVotes = Number(next.votes24h || 0) > 0 || Number(next.votesAllTime || 0) > 0;
  if (
    options?.includeOnChainMcap !== false &&
    hasVotes &&
    (next.marketcapBnb == null || next.marketcapBnb === "" || Number(next.marketcapBnb) <= 0)
  ) {
    try {
      const stats = await fetchOnChainCampaignStats({
        chainId: next.chainId as SupportedChainId,
        campaignAddress: next.campaignAddress,
        tokenAddress: next.tokenAddress,
      });
      if (stats?.marketCapBnb != null && stats.marketCapBnb > 0) {
        next = {
          ...next,
          marketcapBnb: String(stats.marketCapBnb),
        };
      }
    } catch {
      // Keep whatever we have.
    }
  }

  return next;
}

async function mapPoolFeatured<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

async function verifyAndHydrateLive(items: FeaturedItem[], chainId: number): Promise<FeaturedItem[]> {
  const provider = getReadProvider(chainId as any);
  // Cap work hard — full Promise.all over 100 launched() calls freezes the home page.
  const candidates = items.slice(0, 24);

  const checked = await mapPoolFeatured(candidates, 4, async (item) => {
    if (item.graduatedAtChain || item.isDexTrading) return null;
    // Trust API rows that already have identity; skip multi-RPC hydration.
    if (item.name && item.symbol && isAddress(item.tokenAddress) && Number(item.votes24h || 0) >= 0) {
      if (item.marketcapBnb != null && item.marketcapBnb !== "" && usefulImage(item.logoUri)) {
        return item;
      }
      return hydrateMissingSummary(item, { includeOnChainMcap: false });
    }
    try {
      const campaign = new Contract(item.campaignAddress, CAMPAIGN_ABI, provider) as any;
      if (await campaign.launched()) return null;

      const tokenAddress = isAddress(item.tokenAddress) ? String(item.tokenAddress).toLowerCase() : await safeString(() => campaign.token());
      const token = isAddress(tokenAddress) ? new Contract(tokenAddress, TOKEN_ABI, provider) as any : null;
      const [name, symbol, logoUri, creatorAddress] = await Promise.all([
        item.name ? Promise.resolve(String(item.name)) : token ? safeString(() => token.name(), "Unknown") : Promise.resolve("Unknown"),
        item.symbol ? Promise.resolve(String(item.symbol)) : token ? safeString(() => token.symbol(), "") : Promise.resolve(""),
        usefulImage(item.logoUri) ? Promise.resolve(String(item.logoUri)) : safeString(() => campaign.logoURI(), ""),
        item.creatorAddress ? Promise.resolve(String(item.creatorAddress)) : safeString(() => campaign.creator(), ""),
      ]);

      return hydrateMissingSummary({
        ...item,
        tokenAddress: isAddress(tokenAddress) ? tokenAddress.toLowerCase() : item.tokenAddress,
        creatorAddress: isAddress(creatorAddress) ? creatorAddress.toLowerCase() : item.creatorAddress,
        name,
        symbol,
        logoUri,
        isDexTrading: false,
        graduatedAtChain: null,
      } satisfies FeaturedItem, { includeOnChainMcap: false });
    } catch (error) {
      console.warn("[SafeFeaturedCampaigns] lifecycle verification failed", item.campaignAddress, error);
      return null;
    }
  });

  const live = checked.filter(Boolean) as FeaturedItem[];
  // Phase 2: on-chain mcap only for a few upvoted cards missing stats.
  const upvoted = live
    .filter((item) => Number(item.votes24h || 0) > 0 || Number(item.votesAllTime || 0) > 0)
    .filter((item) => item.marketcapBnb == null || item.marketcapBnb === "" || Number(item.marketcapBnb) <= 0)
    .slice(0, 8);

  if (!upvoted.length) return live;

  const mcapByAddress = new Map<string, string>();
  await mapPoolFeatured(upvoted, 3, async (item) => {
    try {
      const stats = await fetchOnChainCampaignStats({
        chainId: item.chainId as SupportedChainId,
        campaignAddress: item.campaignAddress,
        tokenAddress: item.tokenAddress,
      });
      if (stats?.marketCapBnb != null && stats.marketCapBnb > 0) {
        mcapByAddress.set(item.campaignAddress.toLowerCase(), String(stats.marketCapBnb));
      }
    } catch {
      // optional
    }
    return null;
  });

  if (!mcapByAddress.size) return live;
  return live.map((item) => {
    const mcap = mcapByAddress.get(item.campaignAddress.toLowerCase());
    return mcap ? { ...item, marketcapBnb: mcap } : item;
  });
}

export function SafeFeaturedCampaigns({ className = "" }: { className?: string }) {
  const navigate = useNavigate();
  const [chainId] = useSelectedFeedChainId();
  const { price: nativeUsd } = useNativeUsdPrice(chainId);
  const [items, setItems] = useState<FeaturedItem[]>([]);
  const [sponsor, setSponsor] = useState<FeaturedSponsorPlacement | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [adNoticeOpen, setAdNoticeOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const softPollInFlight = useRef(false);
  const softPollRef = useRef<() => void>(() => {});

  softPollRef.current = () => {
    if (softPollInFlight.current) return;
    softPollInFlight.current = true;
    void (async () => {
      try {
        const ranks = await loadFeaturedVoteRanks(chainId);
        if (!ranks.length) return;
        setItems((prev) => mergeFeaturedItems(prev, ranks));
        const needHydrate = ranks
          .filter((item) => Number(item.votes24h || 0) > 0 || Number(item.votesAllTime || 0) > 0)
          .filter((item) => !item.name || item.name === "Unknown" || !usefulImage(item.logoUri))
          .slice(0, 6);
        if (needHydrate.length) {
          const hydrated = await Promise.all(
            needHydrate.map((item) => hydrateMissingSummary(item, { includeOnChainMcap: false })),
          );
          setItems((prev) => mergeFeaturedItems(prev, hydrated));
        }
      } catch {
        // keep current board
      } finally {
        softPollInFlight.current = false;
      }
    })();
  };

  // Ably vote patches re-rank in place; REST soft-poll is owned by this component.
  const { patchByCampaign } = useLeagueRealtime({
    enabled: true,
    chainId,
    fallbackMs: 15000,
    softRefreshMs: 0,
    onFallbackRefresh: () => softPollRef.current(),
  });

  // Merge Ably vote + mcap patches into local board (live rank movement / live mcap).
  useEffect(() => {
    const keys = Object.keys(patchByCampaign || {});
    if (!keys.length) return;
    setItems((prev) => {
      let next = prev;
      for (const addr of keys) {
        const p = patchByCampaign[addr];
        if (!p) continue;
        next = applyVotePatch(next, {
          chainId,
          campaignAddress: p.campaignAddress || addr,
          votes24h: p.votes24h != null ? Number(p.votes24h) : undefined,
          votesAllTime: p.votesAllTime != null ? Number(p.votesAllTime) : undefined,
        });
        const liveMcap = pickLiveNumeric(p.marketcapBnb, NaN);
        if (liveMcap > 0) {
          next = applyLiveMcap(next, {
            chainId,
            campaignAddress: p.campaignAddress || addr,
            marketcapBnb: liveMcap,
          });
        }
      }
      return next === prev ? prev : next;
    });
  }, [patchByCampaign, chainId]);

  // Local upvote: admit + re-rank immediately (absolute counts from vote ingest when present).
  useEffect(() => {
    const onUpvote = (event: Event) => {
      const detail =
        (event as CustomEvent<{
          chainId?: number;
          campaignAddress?: string;
          votes24h?: number;
          votesAllTime?: number;
        }>).detail ?? {};
      if (!featuredEventMatchesChain(chainId, detail.chainId)) return;
      const eventChain = Number(detail.chainId ?? chainId);
      const addr = liveCampaignKey(eventChain, String(detail.campaignAddress || ""));
      if (!isAddress(addr)) {
        softPollRef.current();
        return;
      }
      const hasAbsolute =
        detail.votes24h != null && Number.isFinite(Number(detail.votes24h)) && Number(detail.votes24h) > 0;
      setItems((prev) =>
        applyVotePatch(prev, {
          chainId: eventChain,
          campaignAddress: addr,
          ...(hasAbsolute
            ? { votes24h: Number(detail.votes24h), votesAllTime: Number(detail.votesAllTime ?? detail.votes24h) }
            : { delta: 1 }),
        }),
      );
      // Hydrate identity for first-time featured admission (token page / explore upvote).
      void (async () => {
        const seed: FeaturedItem = {
          chainId: eventChain,
          campaignAddress: addr,
          votes24h: hasAbsolute ? Number(detail.votes24h) : 1,
          votesAllTime: hasAbsolute ? Number(detail.votesAllTime ?? detail.votes24h) : 1,
        };
        try {
          const hydrated = await hydrateMissingSummary(seed, { includeOnChainMcap: true });
          setItems((prev) => mergeFeaturedItems(prev, [hydrated]));
        } catch {
          // ignore
        }
        // Ingest + soft poll — board should already show the card; this settles ranks.
        window.setTimeout(() => softPollRef.current(), 400);
        window.setTimeout(() => softPollRef.current(), 2500);
      })();
    };

    const onTx = (event: Event) => {
      const detail = (event as CustomEvent<{ chainId?: number; kind?: string; campaignAddress?: string }>).detail ?? {};
      if (detail.kind && detail.kind !== "upvote" && detail.kind !== "buy" && detail.kind !== "sell") return;
      if (!featuredEventMatchesChain(chainId, detail.chainId)) return;
      window.setTimeout(() => softPollRef.current(), 800);
    };

    window.addEventListener("memewarzone:upvoteConfirmed", onUpvote as EventListener);
    window.addEventListener("memewarzone:txConfirmed", onTx as EventListener);
    return () => {
      window.removeEventListener("memewarzone:upvoteConfirmed", onUpvote as EventListener);
      window.removeEventListener("memewarzone:txConfirmed", onTx as EventListener);
    };
  }, [chainId]);

  // Continuous soft rank poll (even while Ably is connected).
  useEffect(() => {
    const id = window.setInterval(() => softPollRef.current(), FEATURED_SOFT_POLL_MS);
    return () => window.clearInterval(id);
  }, [chainId]);

  // Initial / chain-switch hard load (full hydrate once). Soft updates never remount the board.
  // Sponsor is loaded separately so organic soft-polls never drop the fixed top-left cell.
  // Never pre-paint the house "Advertise here" banner — that flashes over live partners (e.g. Derpy Dave).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setSponsor(null);
    void (async () => {
      try {
        const [apiCandidates, publicDrafts, sponsorSlot] = await Promise.all([
          loadApiCandidates(chainId),
          fetchPublicCampaignDrafts({ chainId, limit: 100 }).catch(() => []),
          loadFeaturedSponsorSlot(chainId),
        ]);
        if (!cancelled) setSponsor(sponsorSlot);
        const draftLogoByIdentity = new Map<string, string>();
        for (const draft of publicDrafts) {
          if (!usefulImage(draft.logoUrl)) continue;
          const logo = String(draft.logoUrl);
          if (isAddress(draft.campaignAddress)) {
            draftLogoByIdentity.set(String(draft.campaignAddress).toLowerCase(), logo);
          }
          if (isAddress((draft as any).tokenAddress)) {
            draftLogoByIdentity.set(String((draft as any).tokenAddress).toLowerCase(), logo);
          }
        }
        const rawCandidates = apiCandidates.length ? apiCandidates : await loadOnChainCandidates(chainId);
        const candidates = rawCandidates.map((item) => ({
          ...item,
          logoUri: usefulImage(item.logoUri)
            ? item.logoUri
            : draftLogoByIdentity.get(item.campaignAddress.toLowerCase())
              || (item.tokenAddress ? draftLogoByIdentity.get(String(item.tokenAddress).toLowerCase()) : null)
              || item.logoUri,
        }));
        const live = await verifyAndHydrateLive(candidates, chainId);
        if (cancelled) return;
        setItems(live);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const cards = useMemo<FeaturedCard[]>(() => {
    return items
      .slice()
      // Featured = ranked by upvotes — zero-vote campaigns do not belong here.
      .filter((item) => Number(item.votes24h || 0) > 0 || Number(item.votesAllTime || 0) > 0)
      .sort((a, b) => {
        const dv = Number(b.votes24h || 0) - Number(a.votes24h || 0);
        if (dv !== 0) return dv;
        const da = Number(b.votesAllTime || 0) - Number(a.votesAllTime || 0);
        if (da !== 0) return da;
        return String(a.campaignAddress).localeCompare(String(b.campaignAddress));
      })
      .slice(0, 20)
      .map((item) => {
        const patchKey = liveCampaignKey(item.chainId, String(item.campaignAddress || ""));
        const patch = patchByCampaign[patchKey] || patchByCampaign[String(item.campaignAddress || "")];
        const liveMcap = pickLiveNumeric(patch?.marketcapBnb, pickLiveNumeric(item.liveMarketcapBnb, NaN));
        const mcapBnb = liveMcap > 0 ? liveMcap : pickLiveNumeric(item.marketcapBnb, NaN);
        const mcapUsd = Number.isFinite(mcapBnb) && mcapBnb > 0 && Number.isFinite(Number(nativeUsd)) && Number(nativeUsd) > 0
          ? mcapBnb * Number(nativeUsd)
          : null;

        return {
          ...item,
          mcapUsdLabel: mcapUsd != null ? formatCompactUsd(mcapUsd) : null,
          athUsdLabel: getAthLabel(item.chainId, item.campaignAddress, mcapUsd),
        };
      });
  }, [items, nativeUsd, patchByCampaign]);

  return (
    <div className={`w-full ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 mwz-section-title text-sm md:text-base">
          <ThumbsUp className="h-4 w-4" />
          Featured Campaigns
        </div>
        <div className="hidden text-xs uppercase tracking-[0.16em] mwz-muted md:block">Live campaigns ranked by 24h UpVotes</div>
      </div>

      <div className="grid grid-flow-col grid-rows-2 auto-cols-[340px] gap-3 overflow-x-auto pb-1 pr-2 sm:auto-cols-[370px] lg:auto-cols-[392px]" style={{ scrollbarWidth: "none" }}>
        {loading && !cards.length ? (
          <>
            {sponsor ? (
              <SponsoredFeaturedSlotCard
                placement={sponsor}
                onHouseAdClick={() => setApplyOpen(true)}
                onAdvertisementClick={() => setAdNoticeOpen(true)}
              />
            ) : (
              <div className="mwz-card h-[150px] animate-pulse border border-amber-400/20" />
            )}
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="mwz-card h-[150px] animate-pulse" />
            ))}
          </>
        ) : (
          <>
            {/* Fixed top-left: live paid/partner placement; house "Advertise here" only when enabled & empty. */}
            {sponsor ? (
              <SponsoredFeaturedSlotCard
                key={`sponsor-${sponsor?.id || "house"}`}
                placement={sponsor}
                onHouseAdClick={() => setApplyOpen(true)}
                onAdvertisementClick={() => setAdNoticeOpen(true)}
              />
            ) : null}
            {!cards.length ? (
              <div className="mwz-muted flex h-[150px] items-center px-4 text-sm">No live featured campaigns yet — organic ranks appear after UpVotes.</div>
            ) : null}
            {cards.map((item, index) => {
              const image = usefulImage(item.logoUri) ? resolveImageUri(item.logoUri) : null;
              const targetRoute = getPublicTokenDetailRoute({
                tokenAddress: item.tokenAddress,
                campaignAddress: item.campaignAddress,
                chainId: item.chainId,
              }) || `/token/${item.tokenAddress || item.campaignAddress}?chainId=${item.chainId}`;
              return (
                <div
                  key={item.campaignAddress}
                  data-live-id={`${item.chainId}:${item.campaignAddress}`}
                  className="mwz-hud-frame group flex h-[150px] w-full cursor-pointer overflow-hidden rounded-none border border-orange-400/30 bg-black/70 transition hover:border-orange-400/80 hover:shadow-[0_0_18px_rgba(240,106,26,0.22)]"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(targetRoute)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") navigate(targetRoute);
                  }}
                >
                  <div className="relative h-[150px] w-[150px] shrink-0 overflow-hidden border-r border-orange-400/30 bg-black">
                    <img
                      src={image || "/placeholder.svg"}
                      alt={item.name || "Campaign"}
                      className="h-full w-full object-cover"
                      draggable={false}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        const el = event.currentTarget;
                        if (el.dataset.fallbackApplied === "1") return;
                        el.dataset.fallbackApplied = "1";
                        el.src = "/placeholder.svg";
                      }}
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.02),transparent_40%,rgba(0,0,0,0.78))]" />
                    <div className="absolute left-2 top-2 border border-orange-400/70 bg-black/75 px-2 py-1 text-xs font-bold text-orange-300">#{index + 1}</div>
                    <div className="absolute inset-x-2 bottom-2" onClick={(event) => event.stopPropagation()}>
                      <UpvoteDialog campaignAddress={item.campaignAddress} chainId={item.chainId} className="mwz-button mwz-button-active h-9 w-full text-[11px]" buttonVariant="ghost" buttonSize="sm" />
                    </div>
                  </div>

                  <div className="flex h-[150px] min-w-0 flex-1 flex-col justify-between px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-[19px] font-semibold leading-tight text-foreground group-hover:text-orange-200">{item.name || "Unknown"}</div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold uppercase tracking-[0.08em] text-orange-300">{item.symbol ? `$${item.symbol}` : "—"}</span>
                        <span className="shrink-0 text-[12px] font-semibold text-orange-300">{Number(item.votes24h || 0)} votes / 24h</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-[11px] leading-tight">
                      <div className="min-w-0 rounded-sm border border-orange-400/20 bg-black/35 px-2 py-2">
                        <div className="uppercase tracking-[0.14em] text-orange-300/65">MCap</div>
                        <div className="mt-1 truncate text-[16px] font-bold text-foreground">{item.mcapUsdLabel ?? "—"}</div>
                      </div>
                      <div className="min-w-0 rounded-sm border border-orange-400/20 bg-black/35 px-2 py-2">
                        <div className="uppercase tracking-[0.14em] text-orange-300/65">ATH</div>
                        <div className="mt-1 truncate text-[16px] font-bold text-foreground">{item.athUsdLabel}</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <SponsorshipApplyDialog open={applyOpen} onOpenChange={setApplyOpen} defaultSlot={FEATURED_SPONSOR_SLOT} />
      <AdvertisementNoticeDialog open={adNoticeOpen} onOpenChange={setAdNoticeOpen} />
    </div>
  );
}

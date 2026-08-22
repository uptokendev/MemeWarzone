import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useLaunchpad } from "@/lib/launchpadClient";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import { useLeagueRealtime, type LeagueCampaignCreated } from "@/hooks/useLeagueRealtime";
import { CampaignCard, type CampaignCardVM } from "./CampaignCard";
import { resolveImageUri } from "@/lib/media";
import { apiFetch } from "@/lib/apiBase";
import { getDefaultChainId, type SupportedChainId } from "@/lib/chainConfig";
import { fetchOnChainCampaignPage } from "@/lib/onChainCampaignFeed";
import { fetchOnChainCampaignStats } from "@/lib/onChainCampaignStats";
import { isTestnetCampaignsEnabled } from "@/features/postgrad/apiClient";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { getBnbCampaignFeedChainIds } from "@/lib/feedChainConfig";
import { liveCampaignKey, mergeFeedWithCreated, pickLiveNumeric } from "@/lib/liveMarketMerge";

export type FeedTabKey = "drafts" | "trending" | "new" | "ending" | "dex";

export type HomeQuery = {
  tab: FeedTabKey;
  status?: "all" | "live" | "graduated";
  mcapMinUsd?: number;
  mcapMaxUsd?: number;
  progressMinPct?: number;
  progressMaxPct?: number;
  category?: string;
  sort?:
    | "default"
    | "mcap_desc"
    | "mcap_asc"
    | "votes_desc"
    | "progress_desc"
    | "popular_desc"
    | "created_desc"
    | "created_asc";
  timeFilter?: "1h" | "24h" | "7d" | "all";
  search?: string;
};

type CampaignFeedItemApi = {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  creatorAddress?: string | null;
  name?: string | null;
  symbol?: string | null;
  logoUri?: string | null;
  createdAtChain?: string | null;
  lastActivityAt?: string | null;
  graduatedAtChain?: string | null;
  isDexTrading?: boolean;
  marketcapBnb?: string | null;
  athMarketcapBnb?: string | null;
  raisedTotalBnb?: string | null;
  gradTargetBnb?: number | null;
  votes24h?: number;
  progressPct?: number | null;
  etaSec?: number | null;
};

type OnChainCardPatch = {
  marketcapBnb?: string;
  raisedTotalBnb?: string;
  progressPct?: number;
  isDexTrading?: boolean;
};

type CampaignFeedResponse = {
  items: CampaignFeedItemApi[];
  nextCursor: number | null;
  pageSize: number;
  updatedAt?: string;
  source?: string;
};

function safeUnixSeconds(ts: any): number | null {
  if (ts == null) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  if (typeof ts === "string") {
    const asNum = Number(ts);
    if (Number.isFinite(asNum) && asNum > 0) return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function buildQueryString(params: Record<string, any>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    qs.set(k, String(v));
  }
  return qs.toString();
}

function normalizeSearch(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function matchesSearch(item: CampaignFeedItemApi, search: unknown) {
  const q = normalizeSearch(search);
  if (!q) return true;
  return [item.name, item.symbol, item.campaignAddress, item.tokenAddress, item.creatorAddress]
    .map((v) => String(v ?? "").toLowerCase())
    .some((v) => v.includes(q));
}

function mergeCampaignItems(primary: CampaignFeedItemApi[], fallback: CampaignFeedItemApi[]) {
  const map = new Map<string, CampaignFeedItemApi>();
  for (const item of [...fallback, ...primary]) {
    const key = liveCampaignKey(Number(item.chainId || 0), String(item.campaignAddress ?? ""));
    if (!key) continue;
    const existing = map.get(key);
    const presentValues = Object.fromEntries(
      Object.entries(item).filter(([, value]) => value !== null && value !== undefined && value !== ""),
    ) as Partial<CampaignFeedItemApi>;
    if (existing) {
      const incomingMcap = pickLiveNumeric(presentValues.marketcapBnb, NaN);
      const oldMcap = pickLiveNumeric(existing.marketcapBnb, NaN);
      if (!(incomingMcap > 0) && oldMcap > 0) {
        delete presentValues.marketcapBnb;
      }
    }
    map.set(key, { ...(existing || {}), ...presentValues } as CampaignFeedItemApi);
  }
  return Array.from(map.values());
}

function createdToFeedItem(it: LeagueCampaignCreated, chainId: number): CampaignFeedItemApi {
  const addr = liveCampaignKey(chainId, String(it?.campaignAddress ?? ""));
  const token = it.tokenAddress ? liveCampaignKey(chainId, String(it.tokenAddress)) : "";
  const creator = it.creatorAddress ? liveCampaignKey(chainId, String(it.creatorAddress)) : "";
  return {
    chainId,
    campaignAddress: addr,
    tokenAddress: token || null,
    creatorAddress: creator || null,
    name: it.name ?? null,
    symbol: it.symbol ?? null,
    logoUri: null,
    createdAtChain: it.createdAtChain ?? new Date().toISOString(),
    graduatedAtChain: null,
    isDexTrading: false,
    marketcapBnb: null,
    votes24h: 0,
    progressPct: 0,
    etaSec: null,
  };
}

function tabAcceptsCreated(tab: FeedTabKey) {
  return tab === "trending" || tab === "new" || tab === "ending";
}

async function fetchOnChainCampaignFeed(params: Record<string, any>): Promise<CampaignFeedResponse> {
  const chainId = Number(params.chainId || getDefaultChainId());
  const limit = Math.max(1, Math.min(100, Number(params.limit || 24)));
  const cursor = Math.max(0, Number(params.cursor || 0));
  const page = await fetchOnChainCampaignPage(chainId as SupportedChainId, {
    limit: Math.min(100, Math.max(limit, 48)),
    cursor,
  });
  const mapped: CampaignFeedItemApi[] = page.campaigns
    .map((row) => ({
      chainId,
      campaignAddress: row.campaign,
      tokenAddress: row.token || null,
      creatorAddress: row.creator || null,
      name: row.name || null,
      symbol: row.symbol || null,
      logoUri: row.logoURI || null,
      createdAtChain: row.createdAt ? String(row.createdAt) : null,
      graduatedAtChain: null,
      isDexTrading: false,
      marketcapBnb: null,
      votes24h: 0,
      progressPct: null,
      etaSec: null,
    }))
    .filter((item) => {
      const addr = String(item.campaignAddress || "").trim();
      if (!addr) return false;
      // EVM campaign addresses
      if (/^0x[a-f0-9]{40}$/i.test(addr)) return true;
      // Solana campaign / mint PDAs (base58)
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return true;
      return false;
    })
    .filter((item) => matchesSearch(item, params.search));

  const items = mapped.slice(0, limit);
  return { items, nextCursor: page.nextCursor, pageSize: limit, updatedAt: new Date().toISOString(), source: items.length ? "onchain-factory-fallback" : "onchain-empty" };
}

async function fetchCampaignFeedForChain(params: Record<string, any>): Promise<CampaignFeedResponse> {
  const qs = buildQueryString(params);
  try {
    const r = await apiFetch(`/api/campaigns?${qs}`, { cache: "no-store" as any });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error ?? "Failed to load campaigns");
    const items = Array.isArray(j?.items) ? j.items : [];

    // Only hit the slow on-chain factory fallback when the API is empty.
    // Partial pages used to always dual-scan factories and made dual-chain feeds feel stuck.
    if (!items.length) {
      const fallback = await fetchOnChainCampaignFeed(params);
      return {
        ...j,
        items: fallback.items.slice(0, Number(params.limit || 24)),
        nextCursor: fallback.nextCursor ?? null,
        pageSize: Number(params.limit || 24),
        updatedAt: fallback.updatedAt ?? j?.updatedAt,
        source: fallback.source,
      } as CampaignFeedResponse;
    }

    return { ...j, items, source: j?.source || "api" } as CampaignFeedResponse;
  } catch (error) {
    console.warn("[CampaignGrid] realtime campaign feed failed; using on-chain factory fallback", error);
    return await fetchOnChainCampaignFeed(params);
  }
}

/** Fetch the selected feed chain. Multi-id merge remains only if the helper returns more than one. */
async function fetchCampaignFeed(params: Record<string, any>): Promise<CampaignFeedResponse> {
  const selected = Number(params.chainId || getDefaultChainId());
  const chainIds = getBnbCampaignFeedChainIds(selected);
  const limit = Number(params.limit || 24);

  if (chainIds.length <= 1) {
    return fetchCampaignFeedForChain(params);
  }

  // Multi-chain merge is unused when the helper returns a single selected chain.
  const pages = await Promise.all(
    chainIds.map((chainId) =>
      fetchCampaignFeedForChain({
        ...params,
        chainId,
        includeTestnet: chainId === 97 && params.includeTestnet === "true" ? "true" : params.includeTestnet,
        testnet: chainId === 97 && params.testnet === "true" ? "true" : params.testnet,
        includeDrafts: chainId === 97 && params.includeDrafts === "true" ? "true" : params.includeDrafts,
      }).catch((error) => {
        console.warn(`[CampaignGrid] feed failed for chain ${chainId}`, error);
        return { items: [], nextCursor: null, pageSize: limit, source: "error" } as CampaignFeedResponse;
      }),
    ),
  );

  let merged: CampaignFeedItemApi[] = [];
  for (const page of pages) {
    // Merge key must include chainId so 56/97 addresses never collide.
    for (const item of page.items || []) {
      const key = `${Number(item.chainId || 0)}:${String(item.campaignAddress || "").toLowerCase()}`;
      if (!String(item.campaignAddress || "").trim()) continue;
      const existing = merged.find(
        (row) => `${Number(row.chainId || 0)}:${String(row.campaignAddress || "").toLowerCase()}` === key,
      );
      if (!existing) merged.push(item);
    }
  }

  // Stable-ish order: newest first when sort is default/new.
  const sort = String(params.sort || "default");
  if (sort === "default" || sort === "created_desc" || params.tab === "new") {
    merged = merged.slice().sort((a, b) => {
      const ta = Date.parse(String(a.createdAtChain || 0)) || 0;
      const tb = Date.parse(String(b.createdAtChain || 0)) || 0;
      return tb - ta;
    });
  } else if (sort === "mcap_desc" || sort === "mcap_asc") {
    merged = merged.slice().sort((a, b) => {
      const ma = Number(a.marketcapBnb || 0);
      const mb = Number(b.marketcapBnb || 0);
      return sort === "mcap_desc" ? mb - ma : ma - mb;
    });
  }

  return {
    items: merged.slice(0, limit),
    nextCursor: pages.some((p) => p.nextCursor != null) ? limit : null,
    pageSize: limit,
    updatedAt: new Date().toISOString(),
    source: "multi-chain-bnb",
  };
}

export function CampaignGrid({ className, query }: { className?: string; query: HomeQuery }) {
  const { fetchCampaignLogoURI } = useLaunchpad();
  const [selectedChainId] = useSelectedFeedChainId();
  const activeChainId = selectedChainId;
  const includeTestnet = activeChainId === 97 && isTestnetCampaignsEnabled();
  const [refetchNonce, setRefetchNonce] = useState(0);

  // Soft refresh while Ably is up so trending/mcap order can change with new activity + feed membership.
  const { patchByCampaign, created } = useLeagueRealtime({
    enabled: query.tab !== "drafts",
    chainId: activeChainId,
    fallbackMs: 25000,
    softRefreshMs: 12000,
    onFallbackRefresh: () => setRefetchNonce((n) => n + 1),
  });
  const { price: nativeUsd } = useNativeUsdPrice(activeChainId);

  const DEBUG = typeof window !== "undefined" && (window.localStorage?.getItem("debug_campaign_grid") === "1" || (window as any).__DEBUG_CAMPAIGN_GRID__ === true);

  const [items, setItems] = useState<CampaignFeedItemApi[]>([]);
  const [logoCache, setLogoCache] = useState<Record<string, string>>({});
  const [onChainByCampaign, setOnChainByCampaign] = useState<Record<string, OnChainCardPatch>>({});
  const [nextCursor, setNextCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const initialLoadedRef = useRef(false);
  const onChainHydrateRef = useRef<Set<string>>(new Set());
  const createdRef = useRef(created);
  createdRef.current = created;
  const feedIdentity = `${activeChainId}|${query.tab}|${query.sort ?? ""}|${query.status ?? ""}|${query.search ?? ""}|${query.mcapMinUsd ?? ""}|${query.mcapMaxUsd ?? ""}|${query.progressMinPct ?? ""}|${query.progressMaxPct ?? ""}`;
  const feedIdentityRef = useRef("");

  useEffect(() => {
    initialLoadedRef.current = false;
    feedIdentityRef.current = "";
    setItems([]);
    setNextCursor(0);
    setLogoCache({});
    setOnChainByCampaign({});
    onChainHydrateRef.current = new Set();
  }, [activeChainId]);

  // After each soft list refresh, allow on-chain mcap re-hydrate so mcap sorts stay live on sparse indexers.
  useEffect(() => {
    if (refetchNonce === 0) return;
    onChainHydrateRef.current = new Set();
  }, [refetchNonce]);

  useEffect(() => {
    if (!tabAcceptsCreated(query.tab)) return;
    if (!created?.length) return;
    setItems((prev) => {
      const next = mergeFeedWithCreated(prev, created, activeChainId, (row) => createdToFeedItem(row, activeChainId));
      const sliced = next.length > 200 ? next.slice(0, 200) : next;
      if (sliced.length === prev.length && sliced.every((row, i) => row === prev[i])) return prev;
      return sliced;
    });
  }, [created, query.tab, activeChainId]);

  useEffect(() => {
    const onRefresh = (e: any) => {
      const d = e?.detail ?? {};
      const cid = Number(d.chainId ?? NaN);
      if (Number.isFinite(cid) && cid !== activeChainId) return;
      setRefetchNonce((n) => n + 1);
    };
    window.addEventListener("memewarzone:upvoteConfirmed", onRefresh as any);
    window.addEventListener("memewarzone:txConfirmed", onRefresh as any);
    return () => {
      window.removeEventListener("memewarzone:upvoteConfirmed", onRefresh as any);
      window.removeEventListener("memewarzone:txConfirmed", onRefresh as any);
    };
  }, [activeChainId]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const baseParams = useMemo(() => ({
    chainId: activeChainId,
    limit: 24,
    tab: query.tab === "drafts" ? "trending" : (query.tab ?? "trending"),
    sort: query.sort ?? "default",
    status: query.status ?? "all",
    search: query.search ?? "",
    // Legacy API key; value is USD per selected chain-native coin.
    bnbUsd: nativeUsd ? nativeUsd : null,
    mcapMinUsd: query.mcapMinUsd ?? null,
    mcapMaxUsd: query.mcapMaxUsd ?? null,
    progressMinPct: query.progressMinPct ?? null,
    progressMaxPct: query.progressMaxPct ?? null,
    includeTestnet: includeTestnet ? "true" : null,
    testnet: includeTestnet ? "true" : null,
    includeDrafts: includeTestnet ? "true" : null,
  }), [activeChainId, query, nativeUsd, includeTestnet]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (query.tab === "drafts") return;
      if (!initialLoadedRef.current) setLoading(true);
      setErr(null);
      try {
        const resp = await fetchCampaignFeed({ ...baseParams, cursor: 0, _r: refetchNonce });
        if (!mounted) return;
        if (DEBUG) console.debug("[CampaignGrid] first page response", { source: resp.source, count: resp.items?.length ?? 0 });
        const restItems = resp.items ?? [];
        const sameFeed = feedIdentityRef.current === feedIdentity;
        feedIdentityRef.current = feedIdentity;
        setItems((prev) => {
          const restKeys = new Set(
            restItems
              .map((it) => liveCampaignKey(Number(it.chainId || activeChainId), String(it.campaignAddress ?? "")))
              .filter(Boolean),
          );
          const matchingPrev = prev.filter((it) =>
            restKeys.has(liveCampaignKey(Number(it.chainId || activeChainId), String(it.campaignAddress ?? ""))),
          );
          // Soft refetch keeps live-only Ably rows; query/tab changes replace the page.
          const page = mergeCampaignItems(restItems, sameFeed ? prev : matchingPrev);
          if (!tabAcceptsCreated(query.tab)) return page;
          return mergeFeedWithCreated(page, createdRef.current, activeChainId, (row) =>
            createdToFeedItem(row, activeChainId),
          );
        });
        setNextCursor(resp.nextCursor ?? null);
        setLastUpdatedAt(resp.updatedAt ?? null);
        initialLoadedRef.current = true;
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message ?? "Failed to load campaigns");
        if (!initialLoadedRef.current) {
          setItems([]);
          setNextCursor(null);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [baseParams, refetchNonce, query.tab, DEBUG]);

  useEffect(() => {
    if (query.tab === "drafts") return;
    let cancelled = false;
    const missing = (items || [])
      .map((it) => String(it.campaignAddress ?? "").toLowerCase())
      .filter((addr) => addr && !logoCache[addr])
      .filter((addr) => {
        const found = (items || []).find((x) => String(x.campaignAddress ?? "").toLowerCase() === addr);
        return !found?.logoUri;
      })
      .slice(0, 24);
    if (!missing.length) return;
    (async () => {
      try {
        const pairs = await Promise.all(missing.map(async (addr) => [addr, await fetchCampaignLogoURI(addr)] as const));
        if (cancelled) return;
        setLogoCache((prev) => {
          const next = { ...prev };
          for (const [addr, uri] of pairs) if (uri) next[addr] = uri;
          return next;
        });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [items, logoCache, fetchCampaignLogoURI, query.tab]);

  // Indexer token_stats is often empty on testnet — fill mcap/raised from bonding contracts.
  useEffect(() => {
    if (query.tab === "drafts") return;
    let cancelled = false;
    const need = (items || [])
      .filter((it) => {
        const addr = String(it.campaignAddress ?? "").toLowerCase();
        if (!addr || onChainHydrateRef.current.has(addr)) return false;
        const mcap = Number(it.marketcapBnb ?? NaN);
        const raised = Number(it.raisedTotalBnb ?? NaN);
        const missingMcap = !Number.isFinite(mcap) || mcap <= 0;
        const missingRaised = !Number.isFinite(raised) || raised <= 0;
        return missingMcap || missingRaised;
      })
      .slice(0, 6);

    if (!need.length) return;
    for (const it of need) {
      const addr = String(it.campaignAddress ?? "").toLowerCase();
      if (addr) onChainHydrateRef.current.add(addr);
    }

    void (async () => {
      const patches: Record<string, OnChainCardPatch> = {};
      // Small concurrency: full parallel RPC storms make the homepage feel stuck.
      const queue = need.slice();
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const it = queue.shift();
          if (!it) return;
          const addr = String(it.campaignAddress ?? "").toLowerCase();
          try {
            const stats = await fetchOnChainCampaignStats({
              chainId: Number(it.chainId || activeChainId) as SupportedChainId,
              campaignAddress: addr,
              tokenAddress: it.tokenAddress,
            });
            if (!stats) continue;
            const target = Number(it.gradTargetBnb ?? 50) || 50;
            const raised = Number(stats.raisedTotalBnb ?? NaN);
            const mcap = Number(stats.marketCapBnb ?? NaN);
            const graduated = Boolean(stats.isDexTrading || stats.status === "graduated" || it.isDexTrading || it.graduatedAtChain);
            patches[addr] = {
              ...(Number.isFinite(mcap) && mcap > 0 ? { marketcapBnb: String(mcap) } : {}),
              ...(Number.isFinite(raised) && raised > 0 ? { raisedTotalBnb: String(raised) } : {}),
              progressPct: graduated
                ? 100
                : Number.isFinite(raised) && raised > 0
                  ? Math.max(0, Math.min(100, (raised / target) * 100))
                  : undefined,
              isDexTrading: graduated || undefined,
            };
          } catch {
            // leave API values
          }
        }
      });
      await Promise.all(workers);
      if (cancelled || !Object.keys(patches).length) return;
      setOnChainByCampaign((prev) => ({ ...prev, ...patches }));
    })();

    return () => {
      cancelled = true;
    };
  }, [items, activeChainId, query.tab]);

  const loadMore = async () => {
    if (query.tab === "drafts" || loadingMore || loading || nextCursor == null) return;
    setLoadingMore(true);
    try {
      const resp = await fetchCampaignFeed({ ...baseParams, cursor: nextCursor, _r: refetchNonce });
      setItems((prev) => mergeCampaignItems(prev, resp.items ?? []));
      setNextCursor(resp.nextCursor ?? null);
      setLastUpdatedAt(resp.updatedAt ?? null);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (query.tab === "drafts") return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) loadMore();
    }, { root: null, rootMargin: "600px", threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentinelRef.current, nextCursor, loading, loadingMore, baseParams, query.tab]);

  const vms: CampaignCardVM[] = useMemo(() => {
    const DEFAULT_GRAD_TARGET_BNB = 50;
    const sort = String(baseParams.sort || "default");
    const tab = String(baseParams.tab || "trending");
    const mcapMinUsd = baseParams.mcapMinUsd != null ? Number(baseParams.mcapMinUsd) : NaN;
    const mcapMaxUsd = baseParams.mcapMaxUsd != null ? Number(baseParams.mcapMaxUsd) : NaN;
    const progressMinPct = baseParams.progressMinPct != null ? Number(baseParams.progressMinPct) : NaN;
    const progressMaxPct = baseParams.progressMaxPct != null ? Number(baseParams.progressMaxPct) : NaN;

    type InternalVm = CampaignCardVM & { _mcapUsd: number; _mcapBnb: number; _createdAt: number; _activity: number; _votes: number; _progress: number };
    const mapped: InternalVm[] = (items || []).map((it) => {
      // Preserve Solana base58 case — lowercasing breaks /token routes and registry match.
      const rawAddr = String(it.campaignAddress ?? "").trim();
      const isSolanaAddr =
        Number(it.chainId) === 101 ||
        Number(it.chainId) === 102 ||
        (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawAddr) && !rawAddr.startsWith("0x"));
      const addr = isSolanaAddr ? rawAddr : rawAddr.toLowerCase();
      const lookupKey = liveCampaignKey(Number(it.chainId || activeChainId), rawAddr);
      const patch = patchByCampaign[lookupKey] || patchByCampaign[addr] || patchByCampaign[rawAddr.toLowerCase()];
      const onChain = onChainByCampaign[lookupKey] || onChainByCampaign[addr] || onChainByCampaign[rawAddr.toLowerCase()];
      const gradTarget = Number(it.gradTargetBnb ?? DEFAULT_GRAD_TARGET_BNB) || DEFAULT_GRAD_TARGET_BNB;
      const isDex = Boolean(it.isDexTrading || it.graduatedAtChain || onChain?.isDexTrading);

      // Live Ably mcap wins when finite > 0; otherwise keep on-chain hydrate / REST.
      const liveMcap = pickLiveNumeric(patch?.marketcapBnb, NaN);
      const onChainMcap = pickLiveNumeric(onChain?.marketcapBnb, NaN);
      const restMcap = pickLiveNumeric(it.marketcapBnb, NaN);
      const mcapBnb = liveMcap > 0 ? liveMcap : onChainMcap > 0 ? onChainMcap : restMcap;
      const mcapUsd = Number.isFinite(mcapBnb) && nativeUsd ? mcapBnb * nativeUsd : NaN;
      const marketCapUsdLabel = Number.isFinite(mcapUsd) ? formatCompactUsd(mcapUsd) : null;

      const athBnb = Number((it.athMarketcapBnb ?? mcapBnb) ?? NaN);
      const athUsd = Number.isFinite(athBnb) && nativeUsd ? athBnb * nativeUsd : NaN;
      const athLabel = Number.isFinite(athUsd)
        ? formatCompactUsd(athUsd)
        : marketCapUsdLabel;

      const rawLogo = it.logoUri || logoCache[lookupKey] || logoCache[addr] || logoCache[rawAddr.toLowerCase()] || null;
      const raised = Number(
        (patch?.raisedTotalBnb ?? onChain?.raisedTotalBnb ?? it.raisedTotalBnb) ?? NaN,
      );

      let progressPct: number | null = null;
      if (isDex) {
        progressPct = 100;
      } else if (Number.isFinite(raised) && raised >= 0 && gradTarget > 0) {
        progressPct = Math.max(0, Math.min(100, (raised / gradTarget) * 100));
      } else if (onChain?.progressPct != null && Number.isFinite(onChain.progressPct)) {
        progressPct = Math.max(0, Math.min(100, Number(onChain.progressPct)));
      } else if (it.progressPct != null && Number.isFinite(Number(it.progressPct))) {
        progressPct = Math.max(0, Math.min(100, Number(it.progressPct)));
      }

      const activitySec = (patch?.lastActivityAt != null ? Number(patch.lastActivityAt) : safeUnixSeconds((it as any).lastActivityAt ?? null)) ?? 0;
      const createdAt = safeUnixSeconds(it.createdAtChain ?? null) ?? 0;
      const votes24h = Number(patch?.votes24h ?? it.votes24h ?? 0);
      const rawToken = it.tokenAddress ? String(it.tokenAddress).trim() : "";
      return {
        campaignAddress: addr,
        tokenAddress: rawToken
          ? isSolanaAddr
            ? rawToken
            : rawToken.toLowerCase()
          : null,
        name: String(it.name ?? "Unknown"),
        symbol: String(it.symbol ?? ""),
        logoURI: resolveImageUri(rawLogo) ?? undefined,
        creator: it.creatorAddress ?? undefined,
        createdAt: createdAt || undefined,
        lastActivityAtSec: activitySec,
        marketCapUsdLabel,
        athLabel,
        progressPct,
        isDexTrading: isDex,
        votes24h,
        _mcapUsd: Number.isFinite(mcapUsd) ? mcapUsd : 0,
        _mcapBnb: Number.isFinite(mcapBnb) ? mcapBnb : 0,
        _createdAt: createdAt,
        _activity: activitySec,
        _votes: votes24h,
        _progress: progressPct != null && Number.isFinite(progressPct) ? progressPct : -1,
      } as InternalVm;
    });

    // Client filters use hydrated mcap/progress so dropdowns work even when API mcap is null.
    let filtered = mapped.filter((vm) => {
      // Ending Soon = live bonding only (never graduated / 100% progress).
      if (tab === "ending" && (vm.isDexTrading || vm._progress >= 100)) return false;
      // DEX tab = graduated only.
      if (tab === "dex" && !vm.isDexTrading) return false;
      if (Number.isFinite(mcapMinUsd) && vm._mcapUsd < mcapMinUsd) return false;
      if (Number.isFinite(mcapMaxUsd) && vm._mcapUsd > mcapMaxUsd) return false;
      if (Number.isFinite(progressMinPct) && vm._progress < progressMinPct) return false;
      if (Number.isFinite(progressMaxPct) && vm._progress > progressMaxPct) return false;
      return true;
    });

    const byAddr = (a: InternalVm, b: InternalVm) => String(a.campaignAddress).localeCompare(String(b.campaignAddress));
    filtered = filtered.slice().sort((a, b) => {
      if (sort === "mcap_desc") {
        if (b._mcapUsd !== a._mcapUsd) return b._mcapUsd - a._mcapUsd;
        if (b._mcapBnb !== a._mcapBnb) return b._mcapBnb - a._mcapBnb;
        return byAddr(a, b);
      }
      if (sort === "mcap_asc") {
        // Push unknown (0) mcaps to the end for low→high.
        const aUnknown = a._mcapUsd <= 0 && a._mcapBnb <= 0 ? 1 : 0;
        const bUnknown = b._mcapUsd <= 0 && b._mcapBnb <= 0 ? 1 : 0;
        if (aUnknown !== bUnknown) return aUnknown - bUnknown;
        if (a._mcapUsd !== b._mcapUsd) return a._mcapUsd - b._mcapUsd;
        if (a._mcapBnb !== b._mcapBnb) return a._mcapBnb - b._mcapBnb;
        return byAddr(a, b);
      }
      if (sort === "votes_desc") {
        if (b._votes !== a._votes) return b._votes - a._votes;
        return byAddr(a, b);
      }
      if (sort === "progress_desc") {
        if (b._progress !== a._progress) return b._progress - a._progress;
        return byAddr(a, b);
      }
      if (sort === "created_asc") {
        if (a._createdAt !== b._createdAt) return a._createdAt - b._createdAt;
        return byAddr(a, b);
      }
      if (sort === "created_desc" || tab === "new") {
        if (b._createdAt !== a._createdAt) return b._createdAt - a._createdAt;
        return byAddr(a, b);
      }
      // default / trending: activity then created
      if (b._activity !== a._activity) return b._activity - a._activity;
      if (b._createdAt !== a._createdAt) return b._createdAt - a._createdAt;
      return byAddr(a, b);
    });

    // Strip internal sort keys before render.
    return filtered.map(({ _mcapUsd, _mcapBnb, _createdAt, _activity, _votes, _progress, ...vm }) => vm);
  }, [items, nativeUsd, logoCache, patchByCampaign, onChainByCampaign, baseParams]);

  const gridClass = "grid grid-cols-2 gap-3 justify-items-stretch sm:[grid-template-columns:repeat(auto-fill,minmax(180px,220px))] sm:justify-start sm:gap-4";

  return (
    <div className={cn("w-full", className)}>
      
      {loading && !vms.length ? (
        <div className={gridClass}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[1/2] w-full rounded-2xl border border-border/40 bg-card/40 animate-pulse" />
          ))}
        </div>
      ) : err && !vms.length ? (
        <div className="py-10 text-center text-sm text-muted-foreground">{err}</div>
      ) : vms.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">No campaigns yet.</div>
      ) : (
        <>
          {err && (
            <div className="mb-3 rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-200">
              Background refresh failed. Showing the last loaded campaigns.
            </div>
          )}
          <div className={gridClass}>
            {vms.map((vm) => <CampaignCard key={vm.campaignAddress} vm={vm} chainIdForStorage={activeChainId} />)}
          </div>
          <div ref={sentinelRef} className="h-12" />
          {loadingMore ? (
            <div className="py-6 text-center text-xs text-muted-foreground">Loading more...</div>
          ) : nextCursor == null ? (
            <div className="py-6 text-center text-xs text-muted-foreground">End of results</div>
          ) : null}
        </>
      )}
    </div>
  );
}

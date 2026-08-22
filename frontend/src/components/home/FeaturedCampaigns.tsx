import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Contract, ethers } from "ethers";
import { Button } from "@/components/ui/button";
import { UpvoteDialog } from "@/components/token/UpvoteDialog";
import { cn } from "@/lib/utils";
import { useLaunchpad } from "@/lib/launchpadClient";
import { useWallet } from "@/contexts/WalletContext";
import { useToast } from "@/hooks/use-toast";
import { followCampaign, unfollowCampaign, isFollowingCampaign } from "@/lib/followApi";
import { ChevronLeft, ChevronRight, Star, ThumbsUp } from "lucide-react";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import { useLeagueRealtime } from "@/hooks/useLeagueRealtime";
import { getDefaultChainId, getFactoryAddress } from "@/lib/chainConfig";
import { resolveImageUri } from "@/lib/media";
import { apiFetch } from "@/lib/apiBase";
import { getReadProvider } from "@/lib/readProvider";
import { isTestnetCampaignsEnabled } from "@/features/postgrad/apiClient";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { liveCampaignKey, pickLiveNumeric } from "@/lib/liveMarketMerge";
import LaunchFactoryArtifact from "@/abi/LaunchFactory.json";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";

const FACTORY_ABI = LaunchFactoryArtifact.abi as ethers.InterfaceAbi;
const CAMPAIGN_ABI = LaunchCampaignArtifact.abi as ethers.InterfaceAbi;
const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;
const LEGACY_FACTORY_ABI = [
  "function campaignsCount() view returns (uint256)",
  "function getCampaignPage(uint256 offset,uint256 limit) view returns ((address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt)[] page)",
] as const;

const UNREACHABLE_FEATURED_IMAGE_HOSTS = new Set(["jlbdueorprgnfkcpnkfq.supabase.co"]);

const FEATURED_CARD_WIDTH = 392;

type FeaturedItemApi = {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  creatorAddress?: string | null;
  creatorName?: string | null;
  creatorUsername?: string | null;
  username?: string | null;
  name?: string | null;
  symbol?: string | null;
  logoUri?: string | null;
  createdAtChain?: string | null;
  graduatedAtChain?: string | null;
  votes24h?: number | null;
  votesAllTime?: number | null;
  marketcapBnb?: string | null;
};

type FeaturedCardVM = {
  idx: number;
  chainId: number;
  addr: string;
  tokenAddr?: string | null;
  name: string;
  symbol: string;
  createdAt?: number;
  votes24h: number;
  votesAll: number;
  rankVotes: number;
  activitySec: number;
  mcapUsdLabel: string | null;
  athUsdLabel: string;
  image: string;
};

function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function parseCompactUsd(input?: string | null): number | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw || raw === "-") return null;
  const first = raw.split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/[,\s]/g, "").replace(/^[^\d\-.]+/, "");
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) {
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = (match[2] ?? "").toUpperCase();
  const multiplier =
    suffix === "K" ? 1e3 :
    suffix === "M" ? 1e6 :
    suffix === "B" ? 1e9 :
    suffix === "T" ? 1e12 :
    1;

  return value * multiplier;
}

function getAthLabel(chainId: number, addr: string, currentLabel?: string | null): string {
  const current = parseCompactUsd(currentLabel);

  if (typeof window === "undefined") {
    return current != null ? formatCompactUsd(current) : "-";
  }

  try {
    const key = `ath:${chainId}:${addr}:v2`;
    const storedRaw = window.localStorage.getItem(key);
    const stored = storedRaw ? Number(storedRaw) : NaN;
    const storedValue = Number.isFinite(stored) ? stored : null;
    const nextValue = Math.max(storedValue ?? 0, current ?? 0);

    if (current != null && Number.isFinite(current) && (!storedValue || current > storedValue)) {
      window.localStorage.setItem(key, String(current));
    }

    return nextValue > 0 ? formatCompactUsd(nextValue) : "-";
  } catch {
    return current != null ? formatCompactUsd(current) : "-";
  }
}

function isEvmAddress(addr?: string | null) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr ?? "").trim());
}

function resolveFeaturedImageUri(rawLogo?: string | null) {
  const resolved = resolveImageUri(rawLogo) || "/placeholder.svg";
  try {
    const url = new URL(resolved, typeof window !== "undefined" ? window.location.origin : "http://local");
    if (UNREACHABLE_FEATURED_IMAGE_HOSTS.has(url.hostname)) return "/placeholder.svg";
  } catch {
    return "/placeholder.svg";
  }
  return resolved;
}

function preserveFeaturedAddress(value: unknown, chainId?: number): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  // Solana base58 is case-sensitive — never lowercase (L→l destroys the id).
  if (Number(chainId) === 101 || Number(chainId) === 102 || (!raw.startsWith("0x") && raw.length >= 32)) {
    return raw;
  }
  return raw.toLowerCase();
}

function normalizeFeaturedItem(raw: any): FeaturedItemApi | null {
  if (!raw) return null;
  const src = raw.campaign && typeof raw.campaign === "object" ? { ...raw.campaign, ...raw } : raw;
  const chainId = Number(src.chainId ?? src.chain_id ?? getDefaultChainId());
  const campaignAddress = preserveFeaturedAddress(
    src.campaignAddress ?? src.campaign_address ?? src.campaign,
    chainId,
  );
  if (!campaignAddress) return null;
  return {
    chainId,
    campaignAddress,
    tokenAddress: preserveFeaturedAddress(src.tokenAddress ?? src.token_address ?? src.token, chainId) || null,
    creatorAddress: preserveFeaturedAddress(src.creatorAddress ?? src.creator_address ?? src.creator, chainId) || null,
    creatorName: src.creatorName ?? src.creator_name ?? null,
    creatorUsername: src.creatorUsername ?? src.creator_username ?? null,
    username: src.username ?? null,
    name: src.name ?? null,
    symbol: src.symbol ?? src.ticker ?? null,
    logoUri: src.logoUri ?? src.logo_uri ?? src.logoURI ?? src.image ?? null,
    createdAtChain: src.createdAtChain ?? src.created_at_chain ?? src.createdAt ?? null,
    graduatedAtChain: src.graduatedAtChain ?? src.graduated_at_chain ?? null,
    votes24h: Number(src.votes24h ?? src.votes_24h ?? 0),
    votesAllTime: Number(src.votesAllTime ?? src.votes_all_time ?? 0),
    marketcapBnb: src.marketcapBnb ?? src.marketcap_bnb ?? null,
  };
}

function getResponseItems(json: any) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.items)) return json.items;
  return [];
}

function mergeFeaturedItems(primary: FeaturedItemApi[], fallback: FeaturedItemApi[]) {
  const map = new Map<string, FeaturedItemApi>();
  for (const item of [...fallback, ...primary]) {
    const key = String(item.campaignAddress || "").toLowerCase();
    if (!key) continue;
    const existing = map.get(key);
    const presentValues = Object.fromEntries(
      Object.entries(item).filter(([, value]) => value !== null && value !== undefined && value !== ""),
    ) as Partial<FeaturedItemApi>;
    map.set(key, { ...(existing || {}), ...presentValues } as FeaturedItemApi);
  }
  return Array.from(map.values());
}

async function safeString(fn: () => Promise<unknown>, fallback = "") {
  try {
    const value = await fn();
    const text = String(value ?? "").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

function buildFeedQuery(chainId: number, refetchNonce: number, path: "campaigns" | "featured") {
  const params = new URLSearchParams({
    chainId: String(chainId),
    limit: "20",
    _r: String(refetchNonce),
  });

  if (path === "campaigns") {
    params.set("tab", "trending");
    params.set("sort", "default");
    params.set("status", "all");
  } else {
    params.set("sort", "activity");
  }

  // Always pull testnet inventory for chain 97 (and when flag on).
  if (chainId === 97 && isTestnetCampaignsEnabled()) {
    params.set("includeTestnet", "true");
    params.set("testnet", "true");
    params.set("includeDrafts", "true");
    params.set("status", "all");
  }

  return params.toString();
}

async function fetchCampaignItemsMultiChain(chainId: number, refetchNonce: number): Promise<FeaturedItemApi[]> {
  const { getBnbCampaignFeedChainIds } = await import("@/lib/feedChainConfig");
  const chainIds = getBnbCampaignFeedChainIds(chainId);
  const pages = await Promise.all(
    chainIds.map(async (id) => {
      const res = await apiFetch(`/api/campaigns?${buildFeedQuery(id, refetchNonce, "campaigns")}`, {
        cache: "no-store" as RequestCache,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) return [] as FeaturedItemApi[];
      return getResponseItems(json)
        .map(normalizeFeaturedItem)
        .filter(Boolean) as FeaturedItemApi[];
    }),
  );
  return mergeFeaturedItems([], pages.flat()).slice(0, 20);
}

async function fetchOnChainFeaturedItems(chainId: number): Promise<FeaturedItemApi[]> {
  const factoryAddress = getFactoryAddress(chainId as any);
  if (!factoryAddress || !isEvmAddress(factoryAddress)) return [];

  try {
    const provider = getReadProvider(chainId as any);
    const factory = new Contract(factoryAddress, FACTORY_ABI, provider) as any;
    const totalRaw: bigint = await factory.campaignsCount();
    const total = Number(totalRaw ?? 0n);
    if (!Number.isFinite(total) || total <= 0) return [];
    const limit = Math.min(20, total);
    const offset = Math.max(0, total - limit);

    let page: any[] = [];
    try {
      page = await factory.getCampaignPage(offset, limit);
    } catch {
      const legacyFactory = new Contract(factoryAddress, LEGACY_FACTORY_ABI, provider) as any;
      page = await legacyFactory.getCampaignPage(offset, limit);
    }

    return (page || []).slice().reverse().map((item: any): FeaturedItemApi | null => {
      const campaignAddress = String(item.campaign || "").toLowerCase();
      if (!isEvmAddress(campaignAddress)) return null;
      const createdAt = Number(item.createdAt ?? 0);
      return {
        chainId,
        campaignAddress,
        tokenAddress: item.token ? String(item.token).toLowerCase() : null,
        creatorAddress: item.creator ? String(item.creator).toLowerCase() : null,
        name: String(item.name || "Unknown"),
        symbol: String(item.symbol || ""),
        logoUri: String(item.logoURI || ""),
        createdAtChain: createdAt ? new Date(createdAt * 1000).toISOString() : null,
        votes24h: 0,
        votesAllTime: 0,
      };
    }).filter(Boolean) as FeaturedItemApi[];
  } catch (error) {
    console.warn("[FeaturedCampaigns] on-chain testnet fallback failed", error);
    return [];
  }
}

async function fetchFeaturedItems(chainId: number, refetchNonce: number): Promise<FeaturedItemApi[]> {
  const normalizedCampaigns = await fetchCampaignItemsMultiChain(chainId, refetchNonce);
  const onChain = await fetchOnChainFeaturedItems(chainId);

  if (normalizedCampaigns.length || onChain.length) {
    return mergeFeaturedItems(normalizedCampaigns, onChain).slice(0, 20);
  }

  const featured = await apiFetch(`/api/featured?${buildFeedQuery(chainId, refetchNonce, "featured")}`, {
    cache: "no-store" as RequestCache,
  });
  const featuredJson = await featured.json().catch(() => null);
  const featuredItems = getResponseItems(featuredJson);

  if (featured.ok && featuredItems.length) {
    return featuredItems.map(normalizeFeaturedItem).filter(Boolean) as FeaturedItemApi[];
  }

  if (onChain.length) return onChain;

  if (!featured.ok) {
    throw new Error(String(featuredJson?.error || "Failed to load featured"));
  }

  return [];
}

async function hydrateFeaturedMetadata(items: FeaturedItemApi[], chainId: number): Promise<FeaturedItemApi[]> {
  const provider = getReadProvider(chainId as any);
  return Promise.all(
    items.map(async (item) => {
      const needsHydration = !item.name || item.name === "Unknown" || !item.symbol || !item.logoUri || !item.creatorAddress;
      if (!needsHydration || !isEvmAddress(item.campaignAddress)) return item;

      try {
        const campaign = new Contract(item.campaignAddress, CAMPAIGN_ABI, provider) as any;
        const tokenAddress = item.tokenAddress || (await safeString(() => campaign.token()));
        const token = isEvmAddress(tokenAddress) ? (new Contract(String(tokenAddress), TOKEN_ABI, provider) as any) : null;
        const [name, symbol, logoUri, creatorAddress] = await Promise.all([
          item.name && item.name !== "Unknown" ? Promise.resolve(item.name) : token ? safeString(() => token.name(), item.name || "Unknown") : Promise.resolve(item.name || "Unknown"),
          item.symbol ? Promise.resolve(item.symbol) : token ? safeString(() => token.symbol(), "") : Promise.resolve(""),
          item.logoUri ? Promise.resolve(item.logoUri) : safeString(() => campaign.logoURI(), "/placeholder.svg"),
          item.creatorAddress ? Promise.resolve(item.creatorAddress) : safeString(() => campaign.creator(), ""),
        ]);
        return {
          ...item,
          tokenAddress: tokenAddress ? String(tokenAddress).toLowerCase() : item.tokenAddress,
          name,
          symbol,
          logoUri,
          creatorAddress: isEvmAddress(creatorAddress) ? String(creatorAddress).toLowerCase() : item.creatorAddress,
        };
      } catch {
        return item;
      }
    })
  );
}

export function FeaturedCampaigns({ className, bare = false }: { className?: string; bare?: boolean }) {
  const wallet = useWallet();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { fetchCampaignLogoURI } = useLaunchpad();
  const [featuredChainId] = useSelectedFeedChainId();
  const { price: nativeUsd } = useNativeUsdPrice(featuredChainId);
  const [voteMode, setVoteMode] = useState<"24h" | "all">("24h");
  const [refetchNonce, setRefetchNonce] = useState(0);
  const [items, setItems] = useState<FeaturedItemApi[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logoCache, setLogoCache] = useState<Record<string, string>>({});
  const [followedMap, setFollowedMap] = useState<Record<string, boolean>>({});
  const [followBusyMap, setFollowBusyMap] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialLoadedRef = useRef(false);

  // Soft refresh while Ably is up so Top 20 membership reorders (patches alone never admit new cards).
  const { patchByCampaign } = useLeagueRealtime({
    enabled: true,
    chainId: featuredChainId,
    fallbackMs: 25000,
    softRefreshMs: 40000,
    onFallbackRefresh: () => setRefetchNonce((n) => n + 1),
  });

  useEffect(() => {
    initialLoadedRef.current = false;
    setItems([]);
    setLogoCache({});
  }, [featuredChainId]);

  useEffect(() => {
    const onRefresh = (e: Event) => {
      const d = (e as CustomEvent<{ chainId?: number }>).detail ?? {};
      const cid = Number(d.chainId ?? NaN);
      if (Number.isFinite(cid) && cid !== featuredChainId) return;
      setRefetchNonce((n) => n + 1);
    };
    window.addEventListener("memewarzone:upvoteConfirmed", onRefresh as EventListener);
    window.addEventListener("memewarzone:txConfirmed", onRefresh as EventListener);
    return () => {
      window.removeEventListener("memewarzone:upvoteConfirmed", onRefresh as EventListener);
      window.removeEventListener("memewarzone:txConfirmed", onRefresh as EventListener);
    };
  }, [featuredChainId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!initialLoadedRef.current) setLoading(true);
      setErr(null);
      try {
        const normalized = await fetchFeaturedItems(featuredChainId, refetchNonce);
        if (!mounted) return;
        setItems(normalized);
        initialLoadedRef.current = true;
        hydrateFeaturedMetadata(normalized, featuredChainId).then((next) => { if (mounted) setItems(next); });
      } catch (e: unknown) {
        if (!mounted) return;
        setErr(String((e as { message?: string })?.message ?? "Failed to load featured"));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [featuredChainId, refetchNonce]);

  useEffect(() => {
    let cancelled = false;
    const missing = (items || []).map((it) => String(it.campaignAddress ?? "").toLowerCase()).filter((addr) => addr && !logoCache[addr]).filter((addr) => {
      const found = (items || []).find((x) => String(x.campaignAddress ?? "").toLowerCase() === addr);
      return !found?.logoUri;
    }).slice(0, 20);
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
  }, [items, logoCache, fetchCampaignLogoURI]);

  const cards: FeaturedCardVM[] = useMemo(() => {
    const mapped = items.map((it, idx) => {
      const rawAddr = String(it.campaignAddress ?? "").trim();
      const chainId = Number(it.chainId ?? 0) || featuredChainId;
      const addr = preserveFeaturedAddress(rawAddr, chainId) || rawAddr.toLowerCase();
      const patchKey = liveCampaignKey(chainId, rawAddr);
      const patch = patchByCampaign[patchKey] || patchByCampaign[addr] || patchByCampaign[rawAddr.toLowerCase()] || {};
      const createdAt = it.createdAtChain ? Math.floor(new Date(it.createdAtChain).getTime() / 1000) : undefined;
      const votes24h = Number((patch as { votes24h?: number }).votes24h ?? it.votes24h ?? 0);
      const votesAll = Number((patch as { votesAllTime?: number; votesAll?: number }).votesAllTime ?? (patch as { votesAll?: number }).votesAll ?? it.votesAllTime ?? 0);
      const rankVotes = voteMode === "24h" ? votes24h : votesAll;
      const activitySec = Number((patch as { lastActivityAt?: number }).lastActivityAt ?? 0);
      const liveMcap = pickLiveNumeric((patch as { marketcapBnb?: string | number }).marketcapBnb, NaN);
      const mcapBnb = liveMcap > 0 ? liveMcap : pickLiveNumeric(it.marketcapBnb, NaN);
      const mcapUsdLabel = Number.isFinite(mcapBnb) && nativeUsd ? formatCompactUsd(mcapBnb * nativeUsd) : null;
      const rawLogo = it.logoUri || logoCache[addr] || logoCache[rawAddr.toLowerCase()] || null;
      const resolved = resolveFeaturedImageUri(rawLogo);
      const tokenAddr = it.tokenAddress
        ? preserveFeaturedAddress(it.tokenAddress, chainId) || null
        : null;
      return {
        idx: idx + 1,
        chainId,
        addr: preserveFeaturedAddress(addr, chainId) || addr,
        tokenAddr,
        name: String(it.name || "Unknown"),
        symbol: String(it.symbol ?? ""),
        createdAt,
        votes24h,
        votesAll,
        rankVotes,
        activitySec,
        mcapUsdLabel,
        athUsdLabel: getAthLabel(chainId, addr, mcapUsdLabel),
        image: resolved,
      };
    });
    mapped.sort((a, b) => {
      if (b.rankVotes !== a.rankVotes) return b.rankVotes - a.rankVotes;
      if (b.activitySec !== a.activitySec) return b.activitySec - a.activitySec;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
    return mapped.map((c, i) => ({ ...c, idx: i + 1 }));
  }, [items, patchByCampaign, nativeUsd, logoCache, voteMode, featuredChainId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!wallet.account) { if (alive) setFollowedMap({}); return; }
        const next: Record<string, boolean> = {};
        await Promise.all(cards.map(async (c) => { try { next[c.addr] = await isFollowingCampaign(wallet.account!, c.addr, c.chainId); } catch { next[c.addr] = false; } }));
        if (alive) setFollowedMap(next);
      } catch { if (alive) setFollowedMap({}); }
    })();
    return () => { alive = false; };
  }, [wallet.account, cards]);

  const toggleFollow = async (e: React.MouseEvent, c: FeaturedCardVM) => {
    e.stopPropagation();
    if (!c?.addr) return;
    if (!wallet.account) { toast({ title: "Connect wallet", description: "Connect your wallet to follow campaigns." }); window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); return; }
    const key = c.addr.toLowerCase();
    if (followBusyMap[key]) return;
    const nextVal = !(followedMap[key] ?? false);
    setFollowBusyMap((m) => ({ ...m, [key]: true }));
    setFollowedMap((m) => ({ ...m, [key]: nextVal }));
    try {
      const signOpts = { signer: wallet.signer };
      if (nextVal) await followCampaign(wallet.account, key, c.chainId, signOpts);
      else await unfollowCampaign(wallet.account, key, c.chainId, signOpts);
    }
    catch (error: unknown) { setFollowedMap((m) => ({ ...m, [key]: !nextVal })); toast({ title: "Follow failed", description: String((error as { message?: string })?.message ?? error ?? "Unknown error") }); }
    finally { setFollowBusyMap((m) => ({ ...m, [key]: false })); }
  };

  const scrollByCards = (dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = Math.max(FEATURED_CARD_WIDTH, Math.floor(el.clientWidth * 0.82));
    el.scrollBy({ left: dir === "left" ? -amount : amount, behavior: "smooth" });
  };

  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="inline-flex items-center gap-2 mwz-section-title text-sm md:text-base"><ThumbsUp className="h-4 w-4" />Featured Campaigns</div>
        <div className="hidden md:block text-xs uppercase tracking-[0.16em] mwz-muted">Top 20 ({voteMode === "24h" ? "24h upvotes" : "all-time upvotes"})</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button type="button" variant="ghost" size="sm" className={cn("mwz-chip !h-7 !min-h-0 !min-w-0 !px-1.5 !text-[9px] leading-none", voteMode === "24h" && "mwz-chip-active")} onClick={() => setVoteMode("24h")}>24H</Button>
        <Button type="button" variant="ghost" size="sm" className={cn("mwz-chip !h-7 !min-h-0 !min-w-0 !px-1.5 !text-[9px] leading-none", voteMode === "all" && "mwz-chip-active")} onClick={() => setVoteMode("all")}>All-Time</Button>
        <Button variant="ghost" size="sm" className="mwz-button hidden md:inline-flex !h-7 !w-6 !min-h-0 !min-w-0 !p-0" onClick={() => scrollByCards("left")}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" className="mwz-button hidden md:inline-flex !h-7 !w-6 !min-h-0 !min-w-0 !p-0" onClick={() => scrollByCards("right")}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );

  return (
    <div className={cn(bare ? "" : "mwz-hud-frame w-full px-3 py-3", className)}>
      {header}
      <div className="relative">
        <div
          ref={scrollRef}
          className="grid grid-flow-col grid-rows-2 auto-cols-[340px] gap-3 overflow-x-auto pb-1 pr-2 snap-x snap-mandatory scroll-smooth sm:auto-cols-[370px] lg:auto-cols-[392px]"
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          {loading && !cards.length ? (
            Array.from({ length: 10 }).map((_, i) => <div key={i} className="mwz-card h-[150px] w-full animate-pulse" />)
          ) : err && !cards.length ? (
            <div className="mwz-muted py-8 text-sm">{err}</div>
          ) : cards.length === 0 ? (
            <div className="mwz-muted py-8 text-sm">No featured campaigns yet.</div>
          ) : (
            <>
              {err && <div className="mwz-card h-[150px] w-full p-4 text-sm text-orange-200">Background refresh failed. Showing last loaded featured campaigns.</div>}
              {cards.map((c) => (
                <div
                  key={c.addr}
                  data-addr={c.addr}
                  className="mwz-hud-frame group flex h-[150px] w-full snap-start overflow-hidden rounded-none border border-orange-400/30 bg-black/70 transition hover:border-orange-400/80 hover:shadow-[0_0_18px_rgba(240,106,26,0.22)]"
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    navigate(
                      tokenDetailsPath(
                        { tokenAddress: c.tokenAddr, campaignAddress: c.addr, chainId: c.chainId },
                        { chainId: c.chainId },
                      ),
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      navigate(
                        tokenDetailsPath(
                          { tokenAddress: c.tokenAddr, campaignAddress: c.addr, chainId: c.chainId },
                          { chainId: c.chainId },
                        ),
                      );
                    }
                  }}
                >
                  <div className="relative h-[150px] w-[150px] shrink-0 overflow-hidden border-r border-orange-400/30 bg-black">
                    <div className="absolute inset-0 mwz-stat-grid opacity-20 z-10 pointer-events-none" />
                    <img
                      src={c.image}
                      alt={c.name}
                      className="h-full w-full object-cover"
                      draggable={false}
                      onError={(e) => { const img = e.currentTarget; if (!img.dataset.fallback) { img.dataset.fallback = "1"; img.src = "/placeholder.svg"; } }}
                    />
                    <div className="absolute inset-0 z-20 bg-[linear-gradient(180deg,rgba(0,0,0,0.04),transparent_38%,rgba(0,0,0,0.82))]" />
                    <div className="absolute left-2 top-2 z-30 flex h-7 min-w-7 items-center justify-center border border-orange-400/70 bg-black/75 px-1.5 text-xs font-bold text-orange-300 shadow-[0_0_10px_rgba(240,106,26,0.24)]">#{c.idx}</div>
                    <div className="absolute inset-x-2 bottom-2 z-30 flex items-center justify-between gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Button type="button" variant="ghost" size="icon" className={cn("mwz-button h-9 w-9 border-orange-400/40 bg-black/75 text-orange-300 hover:border-orange-400/80 hover:text-orange-200", followedMap[c.addr] && "mwz-button-active border-orange-400/80")} onClick={(e) => toggleFollow(e, c)} disabled={!!followBusyMap[c.addr]} aria-label={(followedMap[c.addr] ?? false) ? "Unfollow campaign" : "Follow campaign"} title={(followedMap[c.addr] ?? false) ? "Unfollow" : "Follow"}>
                        <Star className={cn("h-4 w-4", followedMap[c.addr] ? "fill-current text-orange-400" : "text-orange-300")} />
                      </Button>
                      <UpvoteDialog campaignAddress={c.addr} chainId={c.chainId} className="mwz-button mwz-button-active h-9 min-w-0 flex-1 border-orange-400/50 px-2 text-[11px] text-orange-100 hover:border-orange-400/80" buttonVariant="ghost" buttonSize="sm" />
                    </div>
                  </div>

                  <div className="flex h-[150px] min-w-0 flex-1 flex-col justify-between px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-[19px] font-semibold leading-tight text-foreground group-hover:text-orange-200">{c.name}</div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold uppercase tracking-[0.08em] text-orange-300">{c.symbol ? `$${c.symbol}` : "-"}</span>
                        <span className="shrink-0 text-[12px] font-semibold text-orange-300">{voteMode === "24h" ? c.votes24h : c.votesAll} votes</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-[11px] leading-tight">
                      <div className="min-w-0 rounded-sm border border-orange-400/20 bg-black/35 px-2 py-2">
                        <div className="uppercase tracking-[0.14em] text-orange-300/65">MCap</div>
                        <div className="mt-1 truncate text-[16px] font-bold text-foreground">{c.mcapUsdLabel ?? "-"}</div>
                      </div>
                      <div className="min-w-0 rounded-sm border border-orange-400/20 bg-black/35 px-2 py-2">
                        <div className="uppercase tracking-[0.14em] text-orange-300/65">ATH</div>
                        <div className="mt-1 truncate text-[16px] font-bold text-foreground">{c.athUsdLabel}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

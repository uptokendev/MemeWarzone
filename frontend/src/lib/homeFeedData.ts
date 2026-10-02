/** Home (UI redesign phase 2): coin lists for the story row, Launches, Graduations and Trending. Read-only, existing /api/campaigns. */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";

export type HomeCoin = {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  creatorAddress?: string | null;
  name: string;
  symbol: string;
  logoUri?: string | null;
  marketStage?: string | null;
  isDexTrading?: boolean;
  marketcapBnb?: string | number | null;
  athMarketcapBnb?: string | number | null;
  vol24hBnb?: string | number | null;
  holderCount?: number | null;
  raisedTotalBnb?: string | number | null;
  progressPct?: number | null;
  createdAtChain?: string | null;
  graduatedAtChain?: string | null;
  contractDeployedAt?: string | null;
};

export type HomeCoinList = "trending" | "launches" | "graduations";

const QUERY: Record<HomeCoinList, string> = {
  trending: "tab=trending&sort=default&status=all",
  launches: "tab=new&sort=created_desc&status=live",
  graduations: "tab=dex&sort=default&status=graduated",
};

async function fetchCoins(chainId: number, list: HomeCoinList, limit: number): Promise<HomeCoin[]> {
  const res = await apiFetch(`/api/campaigns?chainId=${chainId}&limit=${limit}&cursor=0&${QUERY[list]}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Coins unavailable (${res.status})`);
  const json = await res.json().catch(() => ({}));
  return Array.isArray(json?.items) ? (json.items as HomeCoin[]) : [];
}

export function useHomeCoins(chainId: number | null | undefined, list: HomeCoinList, limit = 20, enabled = true) {
  return useQuery({
    queryKey: ["home-coins", chainId, list, limit],
    enabled: Boolean(chainId) && enabled,
    queryFn: () => fetchCoins(Number(chainId), list, limit),
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** Trending across the three chains for the "All" chip: each chain's list merged by 24h votes, then volume. */
export function useHomeTrendingAll(chainIds: number[], enabled = true) {
  return useQuery({
    queryKey: ["home-coins-all", chainIds.join(",")],
    enabled,
    queryFn: async () => {
      const lists = await Promise.all(chainIds.map((id) => fetchCoins(id, "trending", 8).catch(() => [] as HomeCoin[])));
      return lists.flat().slice(0, 24);
    },
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function nativeSymbolFor(chainId?: number | null) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "SOL";
  if (id === 4663 || id === 46630) return "ETH";
  return "BNB";
}

export function chainNameFor(chainId?: number | null) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "Solana";
  if (id === 4663 || id === 46630) return "Robinhood";
  return "BNB";
}

export function dexNameFor(chainId?: number | null) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "Meteora";
  if (id === 4663 || id === 46630) return "Uniswap";
  return "Topaz";
}

export function formatNative(value: unknown, chainId?: number | null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const digits = n >= 100 ? 0 : n >= 1 ? 2 : 4;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${nativeSymbolFor(chainId)}`;
}

export function agoLabel(value?: string | null) {
  const ts = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(ts)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

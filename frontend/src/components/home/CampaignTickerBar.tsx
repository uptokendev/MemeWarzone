import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { Contract } from "ethers";
import { cn } from "@/lib/utils";
import { getFactoryAddress, isRobinhoodChainId, isSolanaChainId } from "@/lib/chainConfig";
import { getTickerFeedChainId } from "@/lib/feedChainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { useWallet } from "@/contexts/WalletContext";
import { apiFetch } from "@/lib/apiBase";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";

type CampaignTickerItem = {
  campaignAddress: string;
  tokenAddress?: string;
  symbol: string;
  name: string;
  marketcapBnb: number | null;
  votes24h: number;
};

type FactoryCampaignRow = {
  campaign?: string;
  token?: string;
  creator?: string;
  name?: string;
  symbol?: string;
  logoURI?: string;
  xAccount?: string;
  website?: string;
  extraLink?: string;
  createdAt?: bigint | number | string;
};

const FACTORY_ABI = [
  "function campaignsCount() view returns (uint256)",
  "function getCampaignPage(uint256 offset, uint256 limit) view returns ((address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt)[] page)",
] as const;

const REALTIME_API_BASE = String(import.meta.env.VITE_REALTIME_API_BASE || import.meta.env.VITE_TOKEN_API_BASE || "")
  .trim()
  .replace(/\/+$/, "");

const MIN_TICKER_RENDERED_ITEMS = 18;

function normalizeAddress(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

// Solana addresses are case-sensitive base58; lowercasing them and testing for 0x dropped every
// Solana coin from the ticker (2026-10-01).
function normalizeCampaignAddress(value: unknown, chainId: number) {
  return isSolanaChainId(chainId) ? String(value ?? "").trim() : normalizeAddress(value);
}

function isCampaignAddress(value: string, chainId: number) {
  return isSolanaChainId(chainId) ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) : isAddress(value);
}

function isAddress(value: unknown) {
  return /^0x[a-f0-9]{40}$/.test(normalizeAddress(value));
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function nativeTickerSymbol(chainId: number) {
  if (isSolanaChainId(chainId)) return "SOL";
  if (isRobinhoodChainId(chainId)) return "ETH";
  return "BNB";
}

function formatMc(value: number | null, nativeUsd: number | null, chainId: number) {
  if (value == null || !Number.isFinite(value)) return "MC —";

  if (nativeUsd && Number.isFinite(nativeUsd)) {
    const usd = value * nativeUsd;
    return `MC ${new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(usd)}`;
  }

  const symbol = nativeTickerSymbol(chainId);
  return `MC ${value >= 1 ? value.toFixed(2) : value.toFixed(4)} ${symbol}`;
}

async function fetchTokenSummary(chainId: number, campaignAddress: string): Promise<{ marketcapBnb: number | null; votes24h: number }> {
  if (!REALTIME_API_BASE) return { marketcapBnb: null, votes24h: 0 };
  try {
    const res = await fetch(`${REALTIME_API_BASE}/api/token/${campaignAddress}/summary?chainId=${chainId}`, {
      cache: "no-store" as RequestCache,
      headers: { Accept: "application/json" },
    });
    const row = await res.json().catch(() => null);
    if (!res.ok || !row) return { marketcapBnb: null, votes24h: 0 };

    return {
      marketcapBnb: asNumber(row.marketcap_bnb ?? row.marketcapBnb),
      votes24h: Number(asNumber(row.votes_24h ?? row.votes24h) ?? 0),
    };
  } catch {
    return { marketcapBnb: null, votes24h: 0 };
  }
}

async function fetchFactoryRows(chainId: number): Promise<FactoryCampaignRow[]> {
  const factoryAddress = getFactoryAddress(chainId as any);
  if (!factoryAddress) return [];

  const provider = getReadProvider(chainId as any);
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider) as any;
  const totalRaw: bigint = await factory.campaignsCount();
  const total = Number(totalRaw ?? 0n);
  if (!Number.isFinite(total) || total <= 0) return [];

  const limit = Math.min(30, total);
  const offset = Math.max(0, total - limit);
  const rows = await factory.getCampaignPage(offset, limit);
  return Array.from(rows ?? []).reverse() as FactoryCampaignRow[];
}

async function fetchIndexedTickerItems(chainId: number): Promise<CampaignTickerItem[]> {
  try {
    const params = new URLSearchParams({
      chainId: String(chainId),
      limit: "100",
      cursor: "0",
      status: "all",
      sort: "created_desc",
      tab: "trending",
      _r: String(Date.now()),
    });
    if (chainId === 97) {
      params.set("includeTestnet", "true");
      params.set("testnet", "true");
    }
    const response = await apiFetch(`/api/campaigns?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.items)) return [];
    return payload.items.map((row: any): CampaignTickerItem | null => {
      const campaignAddress = normalizeCampaignAddress(row?.campaignAddress ?? row?.campaign_address, chainId);
      if (!isCampaignAddress(campaignAddress, chainId)) return null;
      const tokenAddress = normalizeCampaignAddress(row?.tokenAddress ?? row?.token_address, chainId);
      return {
        campaignAddress,
        tokenAddress: isCampaignAddress(tokenAddress, chainId) ? tokenAddress : undefined,
        symbol: String(row?.symbol ?? row?.ticker ?? "").trim() || "???",
        name: String(row?.name ?? "").trim() || "Unknown",
        marketcapBnb: asNumber(row?.marketcapBnb ?? row?.marketcap_bnb),
        votes24h: Number(asNumber(row?.votes24h ?? row?.votes_24h) ?? 0),
      };
    }).filter(Boolean) as CampaignTickerItem[];
  } catch {
    return [];
  }
}

async function fetchTickerItems(chainId: number): Promise<CampaignTickerItem[]> {
  const [indexed, factoryRows] = await Promise.all([
    fetchIndexedTickerItems(chainId),
    fetchFactoryRows(chainId).catch(() => []),
  ]);

  const merged = new Map<string, CampaignTickerItem>();
  for (const item of indexed) merged.set(item.campaignAddress, item);
  for (const row of factoryRows) {
    const campaignAddress = normalizeAddress(row?.campaign);
    if (!isAddress(campaignAddress)) continue;
    const previous = merged.get(campaignAddress);
    merged.set(campaignAddress, {
      campaignAddress,
      tokenAddress: isAddress(row?.token) ? normalizeAddress(row?.token) : previous?.tokenAddress,
      symbol: String(row?.symbol ?? "").trim() || previous?.symbol || "???",
      name: String(row?.name ?? "").trim() || previous?.name || "Unknown",
      marketcapBnb: previous?.marketcapBnb ?? null,
      votes24h: previous?.votes24h ?? 0,
    });
  }

  return Promise.all(
    Array.from(merged.values()).slice(0, 30).map(async (item) => {
      if (item.marketcapBnb != null || item.votes24h > 0) return item;
      const summary = await fetchTokenSummary(chainId, item.campaignAddress);
      return { ...item, ...summary };
    }),
  );
}

function buildRepeatedTickerItems(items: CampaignTickerItem[]) {
  if (!items.length) return [];

  // The CSS animation moves the track by 50%, so the rendered list must contain
  // two identical halves. First make one half wide enough for short campaign
  // lists, then duplicate that half for a seamless loop.
  const repeatCount = Math.max(1, Math.ceil(MIN_TICKER_RENDERED_ITEMS / items.length));
  const half = Array.from({ length: repeatCount }).flatMap(() => items);
  return [...half, ...half];
}

export function CampaignTickerBar({ className }: { className?: string }) {
  const wallet = useWallet();
  const chainId = getTickerFeedChainId((wallet as any)?.chainId ?? (wallet as any)?.network?.chainId);
  const { price: nativeUsd } = useNativeUsdPrice(chainId);
  const [items, setItems] = useState<CampaignTickerItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await fetchTickerItems(chainId);
        if (!cancelled) setItems(next);
      } catch (error) {
        console.warn("[CampaignTickerBar] failed to load ticker campaigns", error);
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [chainId]);

  const loopItems = useMemo(() => buildRepeatedTickerItems(items), [items]);

  if (!loopItems.length) {
    return (
      <div className={cn("flex h-12 items-center overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface px-4", className)} aria-label="Live campaign ticker">
        <div className="text-sm text-mw-muted">
          {loaded ? "Live ticker waiting for factory campaigns" : "Loading live campaign ticker..."}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex h-12 items-center overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface", className)} aria-label="Live campaign ticker">
      <div className="mwz-campaign-ticker-track flex w-max items-center">
        {loopItems.map((item, index) => (
          <Link
            key={`${item.campaignAddress}-${index}`}
            to={tokenDetailsPath({ tokenAddress: item.tokenAddress, campaignAddress: item.campaignAddress, chainId: Number(chainId) })}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-r border-[#1E2329] px-[18px] font-mw-body text-sm text-mw-text hover:bg-[#171B20] hover:text-mw-text"
          >
            <span className="font-bold">${item.symbol}</span>
            <span className="hidden max-w-[140px] truncate text-mw-muted sm:inline">{item.name}</span>
            <span className="font-mw-mono">{formatMc(item.marketcapBnb, nativeUsd, chainId)}</span>
            <span className="font-mw-mono text-mw-accent-soft">▲ {item.votes24h || 0}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import type { CampaignSummary } from "@/lib/launchpadClient";
import { formatTimeAgo } from "@/lib/profile/profileFormatters";
import {
  getActiveChainId,
  getFactoryAddress,
  isRobinhoodChainId,
  isSolanaChainId,
} from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { isEvmAddress, isSolanaAddress, normalizeAddress } from "@/lib/address";
import { apiFetch } from "@/lib/apiBase";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";
import {
  fetchSolanaCampaignCurveState,
  solanaMarginalSpotSol,
} from "@/lib/solanaCampaignRead";

type FetchCampaigns = () => Promise<any[]>;
type FetchCampaignSummary = (campaign: any) => Promise<CampaignSummary>;

export interface CreatedCampaignCard {
  id: number;
  image: string;
  name: string;
  ticker: string;
  campaignAddress: string;
  tokenAddress?: string;
  /** Chain id for navigation (101 Solana / 56/97 BNB / 4663/46630 Robinhood). */
  chainId?: number;
  marketCap: string;
  timeAgo: string;
  buyersCount?: number;
}

interface UseCreatedCampaignsArgs {
  viewedAddress: string | null;
  account: string | null;
  chainId?: number;
  fetchCampaigns: FetchCampaigns;
  fetchCampaignSummary: FetchCampaignSummary;
}

const LEGACY_FACTORY_ABI = [
  "function campaignsCount() view returns (uint256)",
  "function getCampaignPage(uint256 offset, uint256 limit) view returns ((address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt)[] page)",
] as const;

function sameWallet(a?: string | null, b?: string | null): boolean {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);
  if (!left || !right) return false;
  if (isSolanaAddress(left) || isSolanaAddress(right)) {
    return left === right || left.toLowerCase() === right.toLowerCase();
  }
  return left.toLowerCase() === right.toLowerCase();
}

function mapFactoryCampaign(raw: any, id: number) {
  return {
    id,
    campaign: String(raw?.campaign ?? "").toLowerCase(),
    token: String(raw?.token ?? "").toLowerCase(),
    creator: String(raw?.creator ?? "").toLowerCase(),
    name: String(raw?.name ?? "Unnamed coin"),
    symbol: String(raw?.symbol ?? "???"),
    logoURI: String(raw?.logoURI ?? "") || "/placeholder.svg",
    xAccount: String(raw?.xAccount ?? ""),
    website: String(raw?.website ?? ""),
    extraLink: String(raw?.extraLink ?? ""),
    createdAt: raw?.createdAt ? Number(raw.createdAt) : undefined,
  };
}

async function fetchCreatedCampaignsOnChain(chainId: number | undefined, creator: string): Promise<any[]> {
  try {
    if (isSolanaChainId(Number(chainId)) || isSolanaAddress(creator)) return [];
    const activeChainId = getActiveChainId(Number(chainId ?? 97));
    const factoryAddress = getFactoryAddress(activeChainId);
    if (!factoryAddress) return [];

    const provider = getReadProvider(activeChainId);
    const factory = new Contract(factoryAddress, LEGACY_FACTORY_ABI, provider) as any;

    const totalRaw: bigint = await factory.campaignsCount();
    const total = Number(totalRaw ?? 0n);
    if (!Number.isFinite(total) || total <= 0) return [];

    const pageSize = 50;
    const maxPages = 10;
    const out: any[] = [];
    const owner = creator.toLowerCase();

    for (let page = 0; page < maxPages; page++) {
      const endExclusive = total - page * pageSize;
      if (endExclusive <= 0) break;

      const offset = Math.max(0, endExclusive - pageSize);
      const limit = endExclusive - offset;
      const rows = await factory.getCampaignPage(offset, limit);

      const mapped = Array.from(rows ?? [])
        .map((row: any, idx: number) => mapFactoryCampaign(row, offset + idx))
        .reverse();

      for (const item of mapped) {
        if (String(item.creator || "").toLowerCase() === owner) out.push(item);
      }

      if (out.length >= 100) break;
    }

    return out;
  } catch {
    return [];
  }
}

function formatCompactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  const abs = Math.abs(usd);
  const fmt = (v: number, suffix: string) => {
    const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `$${v.toFixed(decimals)}${suffix}`;
  };
  if (abs >= 1e12) return fmt(usd / 1e12, "T");
  if (abs >= 1e9) return fmt(usd / 1e9, "B");
  if (abs >= 1e6) return fmt(usd / 1e6, "M");
  if (abs >= 1e3) return fmt(usd / 1e3, "K");
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `$${usd.toFixed(decimals)}`;
}

function nativeAmount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeNativeMarketCapLabel(value: unknown, chainId?: number): string {
  const label = String(value ?? "—").trim() || "—";
  if (!isRobinhoodChainId(Number(chainId))) return label;
  return label.replace(/\s+BNB$/i, " ETH");
}

async function solanaMarketCapLabel(item: any, solUsd: number | null): Promise<string> {
  const fromStats = nativeAmount(item?.marketcapBnb ?? item?.marketCapBnb);
  const fromPriceSold =
    nativeAmount(item?.lastPriceBnb ?? item?.priceBnb) * nativeAmount(item?.soldTokens);
  const native = fromStats || fromPriceSold;
  if (native > 0 && solUsd && solUsd > 0) return formatCompactUsd(native * solUsd);
  if (native > 0) return `${native.toFixed(2)} SOL`;

  const curve = await fetchSolanaCampaignCurveState(String(item?.campaign || "")).catch(() => null);
  if (!curve) return "—";
  const spot = solanaMarginalSpotSol(curve, curve.soldTokens);
  const decimals = Number(curve.tokenDecimals || 6);
  const soldWhole = Number(curve.soldTokens) / 10 ** decimals;
  if (!(spot > 0 && soldWhole > 0)) return "—";
  if (solUsd && solUsd > 0) return formatCompactUsd(spot * soldWhole * solUsd);
  return `${(spot * soldWhole).toFixed(2)} SOL`;
}

/** Load Solana campaigns from the shared registry by creator wallet. */
async function fetchSolanaCreatedCampaigns(creator: string): Promise<any[]> {
  try {
    const res = await apiFetch(
      `/api/campaigns?chainId=101&limit=200&tab=trending&sort=default&status=all`,
      { cache: "no-store" as RequestCache },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    const items = Array.isArray(json?.items) ? json.items : [];
    return items
      .filter((item: any) => sameWallet(item?.creatorAddress ?? item?.creator, creator))
      .map((item: any, idx: number) => ({
        id: 200000 + idx,
        campaign: String(item.campaignAddress || item.campaign || "").trim(),
        token: String(item.tokenAddress || item.token || item.campaignAddress || "").trim(),
        creator: String(item.creatorAddress || item.creator || creator).trim(),
        name: String(item.name || "Solana campaign"),
        symbol: String(item.symbol || item.ticker || ""),
        logoURI: String(item.logoUri || item.logoURI || "/placeholder.svg"),
        xAccount: String(item.xAccount || ""),
        website: String(item.website || ""),
        extraLink: String(item.extraLink || ""),
        createdAt: item.createdAtChain ? Math.floor(new Date(item.createdAtChain).getTime() / 1000) : undefined,
        chainId: 101,
        marketcapBnb: item.marketcapBnb,
        lastPriceBnb: item.lastPriceBnb,
        soldTokens: item.soldTokens,
        holderCount: item.holderCount,
      }));
  } catch (error) {
    console.warn("[Profile] Solana campaigns fetch failed", error);
    return [];
  }
}

export function useCreatedCampaigns({
  viewedAddress,
  account,
  chainId,
  fetchCampaigns,
  fetchCampaignSummary,
}: UseCreatedCampaignsArgs) {
  const [created, setCreated] = useState<CreatedCampaignCard[]>([]);
  const { price: solUsd } = useSolUsdPrice(
    isSolanaChainId(Number(chainId)) || isSolanaAddress(viewedAddress) || isSolanaAddress(account),
  );

  useEffect(() => {
    let cancelled = false;

    const loadCreated = async () => {
      try {
        const ownerRaw = String(viewedAddress || account || "").trim();
        if (!ownerRaw) {
          setCreated([]);
          return;
        }

        const owner = normalizeAddress(ownerRaw);
        const solanaOwner = isSolanaAddress(ownerRaw) || isSolanaChainId(Number(chainId));

        let mine: any[] = [];

        if (solanaOwner) {
          mine = await fetchSolanaCreatedCampaigns(ownerRaw);
        } else if (isEvmAddress(ownerRaw)) {
          const campaigns = (await fetchCampaigns().catch(() => [])) ?? [];
          mine = campaigns.filter((c) => sameWallet(c?.creator, owner));
          if (!mine.length) {
            mine = await fetchCreatedCampaignsOnChain(chainId, owner);
          }
        }

        if (cancelled) return;

        if (solanaOwner) {
          const cards = await Promise.all(
            mine.map(async (c, idx) => ({
              id: typeof c.id === "number" ? c.id : idx + 1,
              image: c.logoURI || "/placeholder.svg",
              name: c.name || "Solana campaign",
              ticker: c.symbol || "",
              campaignAddress: c.campaign,
              tokenAddress: c.token,
              chainId: 101,
              marketCap: await solanaMarketCapLabel(c, solUsd),
              timeAgo: c.createdAt ? formatTimeAgo(c.createdAt) : "",
              buyersCount: Number(c.holderCount || 0) || undefined,
            })),
          );
          if (!cancelled) setCreated(cards);
          return;
        }

        const results = await Promise.allSettled(mine.map((c) => fetchCampaignSummary(c)));
        if (cancelled) return;

        const next = results
          .filter((r): r is PromiseFulfilledResult<CampaignSummary> => r.status === "fulfilled")
          .map((r, idx) => {
            const s = r.value;
            return {
              id: typeof s.campaign.id === "number" ? s.campaign.id : idx + 1,
              image: s.campaign.logoURI || "/placeholder.svg",
              name: s.campaign.name,
              ticker: s.campaign.symbol,
              campaignAddress: s.campaign.campaign,
              tokenAddress: s.campaign.token,
              chainId: Number(chainId) || undefined,
              marketCap: normalizeNativeMarketCapLabel(s.stats.marketCap, chainId),
              timeAgo: (s.campaign as any).timeAgo || formatTimeAgo(s.campaign.createdAt),
              buyersCount: (s.stats as any)?.buyersCount ?? undefined,
            };
          });

        setCreated(next);
      } catch (e) {
        console.error("[Profile] Failed to load created campaigns", e);
        if (!cancelled) setCreated([]);
      }
    };

    loadCreated();
    return () => {
      cancelled = true;
    };
  }, [viewedAddress, account, chainId, fetchCampaigns, fetchCampaignSummary, solUsd]);

  return created;
}

import { Contract, ethers } from "ethers";
import LaunchFactoryArtifact from "@/abi/LaunchFactory.json";
import {
  getFactoryAddress,
  getSupportedFactoryAddresses,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import type { CampaignInfo } from "@/lib/launchpadClient";

const FACTORY_ABI = LaunchFactoryArtifact.abi as ethers.InterfaceAbi;
const LEGACY_FACTORY_ABI = [
  "function campaignsCount() view returns (uint256)",
  "function getCampaignPage(uint256 offset,uint256 limit) view returns ((address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt)[] page)",
] as const;

// Temporary launch hygiene: keep claim-upgrade/test campaigns operational/indexed,
// but never surface them through any public on-chain fallback path.
const PUBLIC_HIDDEN_CAMPAIGNS = new Map<number, Set<string>>([
  [
    101,
    new Set([
      "9t72mNAVpnJCn42Z2quJTqoS8wsBTGR9aG2CvbeumXEF",
      "Bv2EZEznfuHNHcoC5DXJJtJH8x7mAjCUagsPGeXK3Jms",
      "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH",
    ]),
  ],
]);

const PUBLIC_HIDDEN_SYMBOLS = new Map<number, Set<string>>([
  [56, new Set(["BWT"])],
]);

function isPublicHiddenCampaign(chainId: SupportedChainId, campaignAddress: string): boolean {
  const hidden = PUBLIC_HIDDEN_CAMPAIGNS.get(Number(chainId));
  if (!hidden) return false;
  return hidden.has(String(campaignAddress || "").trim());
}

function isPublicHiddenSymbol(chainId: SupportedChainId, symbol: string): boolean {
  const hidden = PUBLIC_HIDDEN_SYMBOLS.get(Number(chainId));
  if (!hidden) return false;
  return hidden.has(String(symbol || "").trim().toUpperCase());
}

export type OnChainCampaignPage = {
  campaigns: CampaignInfo[];
  nextCursor: number | null;
  total: number;
};

async function fetchFactoryCampaignPage(
  chainId: SupportedChainId,
  factoryAddress: string,
  options: { limit?: number; cursor?: number } = {},
): Promise<OnChainCampaignPage> {
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 100)));
  const cursor = Math.max(0, Number(options.cursor ?? 0));
  if (!factoryAddress || !ethers.isAddress(factoryAddress)) {
    return { campaigns: [], nextCursor: null, total: 0 };
  }

  const provider = getReadProvider(chainId);
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider) as any;
  let total = 0;
  try {
    total = Number((await factory.campaignsCount()) ?? 0n);
  } catch {
    return { campaigns: [], nextCursor: null, total: 0 };
  }
  if (!Number.isFinite(total) || total <= 0 || cursor >= total) {
    return { campaigns: [], nextCursor: null, total: Math.max(0, total || 0) };
  }

  const endExclusive = Math.max(0, total - cursor);
  const offset = Math.max(0, endExclusive - limit);
  const actualLimit = endExclusive - offset;

  let page: any[] = [];
  try {
    page = await factory.getCampaignPage(offset, actualLimit);
  } catch {
    try {
      const legacyFactory = new Contract(factoryAddress, LEGACY_FACTORY_ABI, provider) as any;
      page = await legacyFactory.getCampaignPage(offset, actualLimit);
    } catch {
      return { campaigns: [], nextCursor: null, total };
    }
  }

  const campaigns = Array.from(page ?? [])
    .map((row: any, index): CampaignInfo | null => {
      const campaignRaw = String(row?.campaign ?? "").trim();
      const campaign = campaignRaw.toLowerCase();
      const symbol = String(row?.symbol ?? "");
      if (!ethers.isAddress(campaign)) return null;
      if (isPublicHiddenCampaign(chainId, campaignRaw)) return null;
      if (isPublicHiddenSymbol(chainId, symbol)) return null;
      return {
        id: offset + index,
        campaign,
        token: String(row?.token ?? "").toLowerCase(),
        creator: String(row?.creator ?? "").toLowerCase(),
        name: String(row?.name ?? "Unknown"),
        symbol,
        logoURI: String(row?.logoURI ?? ""),
        metadataURI: String(row?.metadataURI ?? ""),
        xAccount: String(row?.xAccount ?? ""),
        website: String(row?.website ?? ""),
        extraLink: String(row?.extraLink ?? ""),
        createdAt: row?.createdAt ? Number(row.createdAt) : undefined,
        factoryAddress: factoryAddress.toLowerCase(),
      } as CampaignInfo;
    })
    .filter((campaign): campaign is CampaignInfo => campaign !== null)
    .reverse();

  return {
    campaigns,
    nextCursor: cursor + actualLimit < total ? cursor + actualLimit : null,
    total,
  };
}

export async function fetchOnChainCampaignPage(
  chainId: SupportedChainId,
  options: { limit?: number; cursor?: number } = {},
): Promise<OnChainCampaignPage> {
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 100)));
  const factories = getSupportedFactoryAddresses(chainId);
  const fallbackActive = getFactoryAddress(chainId);
  const factoryList =
    factories.length > 0
      ? factories
      : fallbackActive && ethers.isAddress(fallbackActive)
        ? [fallbackActive]
        : [];

  if (!factoryList.length) {
    return { campaigns: [], nextCursor: null, total: 0 };
  }

  const pages = await Promise.all(
    factoryList.map((factoryAddress) =>
      fetchFactoryCampaignPage(chainId, factoryAddress, {
        limit,
        cursor: factoryList.length === 1 ? options.cursor : 0,
      }).catch(() => ({ campaigns: [] as CampaignInfo[], nextCursor: null, total: 0 })),
    ),
  );

  const seen = new Set<string>();
  const campaigns: CampaignInfo[] = [];
  let total = 0;
  for (const page of pages) {
    total += Number(page.total || 0);
    for (const campaign of page.campaigns) {
      const key = String(campaign.campaign || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      campaigns.push(campaign);
    }
  }

  campaigns.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  return {
    campaigns: campaigns.slice(0, limit),
    nextCursor: null,
    total,
  };
}

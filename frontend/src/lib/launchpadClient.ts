import { useCallback, useMemo } from "react";
import { Contract, ethers } from "ethers";
import { useLocation } from "react-router-dom";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  BNB_CHAIN_ID,
  getActiveChainId,
  isEvmTokenRoutePath,
  resolveTokenPageChainId,
  isSolanaChainId,
  SOLANA_CHAIN_ID,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { bnbContractAbis, getBnbContractAddresses, getBnbContractReadiness } from "@/lib/bnbContracts";
import {
  fetchLaunchpadBuyPreflight,
  fetchLaunchpadCreatePreflight,
  fetchLaunchpadSellPreflight,
} from "@/lib/recruiterApi";
import { getReadProvider } from "@/lib/readProvider";
import { apiFetch } from "@/lib/apiBase";
import { resolveImageUri } from "@/lib/media";
import { assertOnchainLogoUri } from "@/lib/onchainLogoUri";
import { getBnbLaunchpadSafetyStatus } from "@/lib/launchpad/adapters/bnbLaunchpadAdapter";
import { createSolanaLaunchpadAdapter } from "@/lib/launchpad/adapters/solanaLaunchpadAdapter";
import type {
  CampaignActivity,
  CampaignCardStats,
  CampaignInfo,
  CampaignMetrics,
  CampaignSummary,
  CreateCampaignParams,
  FetchCampaignPageOptions,
  LaunchpadAdapter,
} from "@/lib/launchpad/adapters/types";

export type {
  CampaignActivity,
  CampaignCardStats,
  CampaignInfo,
  CampaignMetrics,
  CampaignSummary,
  CreateCampaignParams,
  FetchCampaignPageOptions,
  LaunchpadAdapter,
  LaunchpadProtocolStatus,
  LaunchpadSafetyCheck,
  LaunchpadSafetyStatus,
} from "@/lib/launchpad/adapters/types";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
const LEGACY_BUY_GAS_LIMIT = 650_000n;
const LEGACY_SELL_GAS_LIMIT = 650_000n;

function envEnabled(value: unknown): boolean {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

const ENABLE_ONCHAIN_CAMPAIGN_FALLBACK = envEnabled(import.meta.env.VITE_ENABLE_ONCHAIN_CAMPAIGN_FALLBACK);

const FACTORY_ABI = bnbContractAbis.launchFactory as ethers.InterfaceAbi;
const FACTORY_INTERFACE = new ethers.Interface(FACTORY_ABI);
const CAMPAIGN_ABI = [
  ...((bnbContractAbis.launchCampaign as any[]) ?? []),
  "function buyExactTokens(uint256 amountOut,uint256 maxCost) payable returns (uint256 cost)",
  "function sellExactTokens(uint256 amountIn,uint256 minPayout) returns (uint256 payout)",
  "function buyExactTokensAuthorized(uint256 amountOut,uint256 maxCost,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) payable returns (uint256 cost)",
  "function sellExactTokensAuthorized(uint256 amountIn,uint256 minPayout,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) returns (uint256 payout)",
] as ethers.InterfaceAbi;
const TOKEN_ABI = bnbContractAbis.launchToken as ethers.InterfaceAbi;
const CAMPAIGN_INTERFACE = new ethers.Interface(CAMPAIGN_ABI);
const ACTIVITY_LOG_LOOKBACK_BLOCKS = 10_000;
const ACTIVITY_LOG_CHUNK_SIZE = 1_000;
const GRADUATION_WRITE_ABI = [
  ...((CAMPAIGN_ABI as any[]) ?? []),
  "function graduateIfEligible(uint256 minTokens, uint256 minBnb) returns (uint256 usedTokens, uint256 usedBnb)",
] as ethers.InterfaceAbi;

const LEGACY_FACTORY_ABI = [
  "function campaignsCount() view returns (uint256)",
  "function getCampaignPage(uint256 offset, uint256 limit) view returns ((address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt)[] page)",
] as const;

type CampaignRequestPayload = {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: string;
};

type CreatedCampaignReceipt = {
  campaignAddress?: string;
  tokenAddress?: string;
};

async function parseApiJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  return json as any;
}

async function postApiJson(path: string, body: any) {
  return parseApiJson(await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function requestCreateAuthorization(params: {
  walletAddress: string;
  chainId: number;
  factoryAddress: string;
  campaignRequest: CampaignRequestPayload;
}) {
  return postApiJson("/api/routing/create-authorization", {
    walletAddress: params.walletAddress,
    chainId: params.chainId,
    factoryAddress: params.factoryAddress,
    campaignRequest: params.campaignRequest,
  });
}

async function requestTradeAuthorization(params: {
  walletAddress: string;
  campaignAddress: string;
  chainId: number;
  action: number;
  amount: bigint;
  limit: bigint;
}) {
  return postApiJson("/api/routing/trade-authorization", {
    walletAddress: params.walletAddress,
    campaignAddress: params.campaignAddress,
    chainId: params.chainId,
    action: params.action,
    amount: params.amount.toString(),
    limit: params.limit.toString(),
  });
}

function normalizeAddress(value: unknown): string {
  const raw = String(value ?? "").trim();
  return ethers.isAddress(raw) ? raw.toLowerCase() : "";
}

function isSolanaAddress(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  return raw.length >= 32 && raw.length <= 44 && SOLANA_ADDRESS_RE.test(raw);
}

function normalizeChainAddress(value: unknown, chainId: number): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (isSolanaChainId(chainId)) return isSolanaAddress(raw) ? raw : "";
  return ethers.isAddress(raw) ? raw.toLowerCase() : "";
}

function normalizeLogoUri(value: unknown): string {
  const raw = String(value ?? "").trim();
  const resolved = resolveImageUri(raw);
  return resolved || "/placeholder.svg";
}

function hasLogo(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/placeholder.svg" || raw === "-") return false;
  return Boolean(resolveImageUri(raw));
}

function toUnixSeconds(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    const seconds = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    return seconds > 1_577_836_800 ? seconds : undefined;
  }
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return undefined;
  const seconds = Math.floor(ms / 1000);
  return seconds > 1_577_836_800 ? seconds : undefined;
}

function findNestedRevertData(error: unknown): string | null {
  const value = error as any;
  const candidates = [
    value?.data,
    value?.error?.data,
    value?.info?.error?.data,
    value?.cause?.data,
    value?.revert?.data,
  ];
  return candidates.find((candidate) =>
    typeof candidate === "string" && /^0x[0-9a-f]+$/i.test(candidate) && candidate !== "0x"
  ) ?? null;
}

export function isUnsupportedContractMethod(error: unknown): boolean {
  if (findNestedRevertData(error)) return false;
  const value = error as any;
  const text = String(value?.shortMessage || value?.reason || value?.message || value || "").toLowerCase();
  return (
    text.includes("function selector was not recognized") ||
    text.includes("unknown function") ||
    text.includes("no matching fragment") ||
    text.includes("no data present") ||
    (value?.code === "BAD_DATA" && text.includes("could not decode result data"))
  );
}

function buildMetadataURI(chainId: number, tokenOrCampaignAddress?: string): string {
  const raw = String(tokenOrCampaignAddress || "").trim();
  if (!raw) return "";
  const address = normalizeChainAddress(raw, chainId);
  return address ? `/api/token-metadata/${chainId}/${address}` : "";
}

function formatBnbFromWei(wei: bigint): string {
  try {
    const n = Number(ethers.formatEther(wei));
    if (!Number.isFinite(n)) return `${wei.toString()} wei`;
    const abs = Math.abs(n);
    const pretty = abs >= 1 ? n.toFixed(2) : abs >= 0.01 ? n.toFixed(4) : abs >= 0.0001 ? n.toFixed(6) : n.toFixed(8);
    return `${pretty} BNB`;
  } catch {
    return `${wei.toString()} wei`;
  }
}

function extractCreatedCampaign(receipt: any): CreatedCampaignReceipt {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = FACTORY_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "CampaignCreated") continue;
      return {
        campaignAddress: normalizeAddress(parsed.args?.campaign),
        tokenAddress: normalizeAddress(parsed.args?.token),
      };
    } catch {
      // Ignore logs from other contracts in the same transaction.
    }
  }
  return {};
}

function mapDbCampaign(item: any, idx: number, chainId: number): CampaignInfo | null {
  const campaign = normalizeChainAddress(item?.campaignAddress ?? item?.campaign_address ?? item?.campaign, chainId);
  if (!campaign) return null;

  const token = normalizeChainAddress(item?.tokenAddress ?? item?.token_address ?? item?.token, chainId);
  const creator = normalizeChainAddress(item?.creatorAddress ?? item?.creator_address ?? item?.creator, chainId);

  return {
    id: 100000 + idx,
    campaign,
    token,
    creator,
    name: String(item?.name ?? "Unknown"),
    symbol: String(item?.symbol ?? ""),
    logoURI: normalizeLogoUri(item?.logoUri ?? item?.logoURI ?? item?.logoUrl ?? item?.logo_url ?? item?.logo_uri),
    metadataURI: buildMetadataURI(chainId, token || campaign),
    xAccount: String(item?.xAccount ?? item?.xUrl ?? item?.x_url ?? ""),
    website: String(item?.website ?? item?.websiteUrl ?? item?.website_url ?? ""),
    extraLink: String(item?.extraLink ?? item?.extraUrl ?? item?.otherUrl ?? item?.other_url ?? ""),
    createdAt: toUnixSeconds(item?.createdAtChain ?? item?.created_at_chain ?? item?.createdAt ?? item?.created_at),
    timeAgo: String(item?.timeAgo ?? item?.time_ago ?? item?.ageLabel ?? item?.age_label ?? "").trim() || undefined,
    dexPairAddress: item?.dexPairAddress ?? item?.dex_pair_address ?? undefined,
    tokenVault: item?.tokenVault ? String(item.tokenVault) : null,
    solVault: item?.solVault ? String(item.solVault) : null,
    campaignIdHex: item?.campaignIdHex ? String(item.campaignIdHex) : null,
  };
}

async function fetchDbCampaigns(chainId: number, limit = 500): Promise<CampaignInfo[]> {
  try {
    const res = await apiFetch(
      `/api/campaigns?chainId=${encodeURIComponent(String(chainId))}&limit=${encodeURIComponent(String(limit))}&tab=trending&sort=default&status=all`,
      { cache: "no-store" as RequestCache },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(String(json?.error || `HTTP ${res.status}`));
    const items = Array.isArray(json?.items) ? json.items : [];
    return items.map((item: any, idx: number) => mapDbCampaign(item, idx, chainId)).filter(Boolean) as CampaignInfo[];
  } catch (error) {
    console.warn("[launchpadClient] DB campaign fetch failed", error);
    return [];
  }
}

const CAMPAIGN_IDENTITY_ABI = [
  "function token() view returns (address)",
  "function creator() view returns (address)",
] as const;

export async function resolveCanonicalCampaignAddress(
  submittedAddress: string,
  chainId: number,
  provider: ethers.AbstractProvider,
): Promise<string> {
  const normalized = normalizeAddress(submittedAddress);
  if (!normalized) throw new Error("Invalid campaign or token address");

  // Resolve through the canonical database mirror first. Public token URLs are
  // expected here, and the database row carries the authoritative campaign/token pair.
  const campaigns = await fetchDbCampaigns(chainId, 500);
  const match = campaigns.find((campaign) =>
    normalizeAddress(campaign.campaign) === normalized ||
    normalizeAddress(campaign.token) === normalized
  );
  const canonicalCampaign = normalizeAddress(match?.campaign);
  if (canonicalCampaign) return canonicalCampaign;

  // A direct LaunchCampaign address may not be mirrored yet. Verify both token()
  // and creator() so a non-campaign contract cannot be accepted by one weak probe.
  try {
    const candidate = new Contract(normalized, CAMPAIGN_IDENTITY_ABI, provider) as any;
    const [tokenRaw, creatorRaw] = await Promise.all([candidate.token(), candidate.creator()]);
    const tokenAddress = normalizeAddress(tokenRaw);
    const creatorAddress = normalizeAddress(creatorRaw);
    if (tokenAddress && creatorAddress) return normalized;
  } catch {
    // Fall through to a deterministic resolution error.
  }

  throw new Error("Could not resolve the canonical LaunchCampaign contract for this token.");
}

function isDecodeResultError(error: unknown): boolean {
  const anyError = error as any;
  return anyError?.code === "BAD_DATA" || String(anyError?.message ?? "").toLowerCase().includes("could not decode result data");
}

function mapOnChainCampaign(c: any, idx: number, offset: number, chainId: number): CampaignInfo {
  return {
    id: offset + idx,
    campaign: c.campaign,
    token: c.token,
    creator: c.creator,
    name: c.name,
    symbol: c.symbol,
    logoURI: normalizeLogoUri(c.logoURI),
    metadataURI: c.metadataURI ?? buildMetadataURI(chainId, c.token || c.campaign),
    xAccount: c.xAccount,
    website: c.website,
    extraLink: c.extraLink,
    createdAt: toUnixSeconds(c.createdAt),
  };
}

function mergeCampaigns(onChain: CampaignInfo[], db: CampaignInfo[]): CampaignInfo[] {
  const mergedByAddress = new Map<string, CampaignInfo>();
  const isUseful = (value: unknown) => {
    const raw = String(value ?? "").trim();
    return Boolean(raw && raw !== "/placeholder.svg" && raw !== "-");
  };
  const mergeOne = (base: CampaignInfo, incoming: CampaignInfo): CampaignInfo => ({
    ...base,
    ...incoming,
    name: isUseful(base.name) ? base.name : incoming.name,
    symbol: isUseful(base.symbol) ? base.symbol : incoming.symbol,
    logoURI: isUseful(base.logoURI) ? base.logoURI : incoming.logoURI,
    metadataURI: isUseful(base.metadataURI) ? base.metadataURI : incoming.metadataURI,
    xAccount: isUseful(base.xAccount) ? base.xAccount : incoming.xAccount,
    website: isUseful(base.website) ? base.website : incoming.website,
    extraLink: isUseful(base.extraLink) ? base.extraLink : incoming.extraLink,
    createdAt: base.createdAt || incoming.createdAt,
    dexPairAddress: base.dexPairAddress || incoming.dexPairAddress,

  });

  // Keep canonical factory addresses/order, but backfill partial direct-deploy
  // metadata from the API row while the indexer catches up.
  for (const item of [...onChain, ...db]) {
    const key = normalizeAddress(item?.campaign);
    if (!key) continue;
    const current = mergedByAddress.get(key);
    mergedByAddress.set(key, current ? mergeOne(current, item) : item);
  }
  return Array.from(mergedByAddress.values());
}

async function hydrateMissingLogosFromContract(
  campaigns: CampaignInfo[],
  fetchCampaignLogoURI: (campaignAddress: string) => Promise<string | null>,
): Promise<CampaignInfo[]> {
  // Older multi-factory inventories can have many empty logo rows; hydrate more than one page.
  const targets = campaigns.filter((campaign) => !hasLogo(campaign.logoURI)).slice(0, 80);
  if (!targets.length) return campaigns;

  const hydrated = new Map<string, string>();

  await Promise.all(
    targets.map(async (campaign) => {
      try {
        const logo = normalizeLogoUri(await fetchCampaignLogoURI(campaign.campaign));
        if (hasLogo(logo)) hydrated.set(campaign.campaign.toLowerCase(), logo);
      } catch {
        // Best-effort image hydration only; never block the campaign feed.
      }
    }),
  );

  if (!hydrated.size) return campaigns;

  return campaigns.map((campaign) => {
    const logoURI = hydrated.get(campaign.campaign.toLowerCase());
    return logoURI ? { ...campaign, logoURI } : campaign;
  });
}

async function legacyGasOverrides(signer: any, readProvider: ethers.AbstractProvider, extra: any = {}) {
  try {
    const p: any = signer?.provider ?? readProvider;
    if (!p || typeof p.send !== "function") return extra;
    const gpHex = await p.send("eth_gasPrice", []);
    const gasPrice = gpHex ? BigInt(gpHex) : 0n;
    return gasPrice > 0n ? { ...extra, gasPrice, type: 0 } : extra;
  } catch {
    return extra;
  }
}

function emitTxConfirmed(detail: any) {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("memewarzone:txConfirmed", { detail }));
    }
  } catch {
    // non-fatal
  }
}

function notifyIndexerTrade(detail: { chainId?: number; campaignAddress?: string; txHash?: string }) {
  const chainId = Number(detail.chainId || 0);
  const campaign = String(detail.campaignAddress || "").trim();
  const txHash = String(detail.txHash || "").trim();
  if ((chainId !== 56 && chainId !== 97) || !/^0x[a-fA-F0-9]{40}$/.test(campaign) || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return;
  }
  void apiFetch(`/api/token/${encodeURIComponent(campaign)}/ingest-tx?chainId=${chainId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId, txHash }),
  }).catch(() => undefined);
}

async function blockTimestamp(provider: ethers.AbstractProvider, blockNumber?: number | null) {
  if (!blockNumber) return Math.floor(Date.now() / 1000);
  try {
    const block = await provider.getBlock(blockNumber);
    return Number(block?.timestamp || 0) || Math.floor(Date.now() / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

const LIVE_BONDING_TRADE_IFACE = new ethers.Interface([
  "event TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost)",
  "event TokensSold(address indexed seller, uint256 amountIn, uint256 payout)",
]);

async function extractReceiptTrades(receipt: any, campaignAddress: string, provider: ethers.AbstractProvider) {
  const normalizedCampaign = normalizeAddress(campaignAddress);
  if (!normalizedCampaign) return [];
  const timestamp = await blockTimestamp(provider, Number(receipt?.blockNumber || 0));
  const trades: any[] = [];

  for (const log of receipt?.logs ?? []) {
    if (normalizeAddress(log?.address) !== normalizedCampaign) continue;
    try {
      let parsed = null as ethers.LogDescription | null;
      try {
        parsed = LIVE_BONDING_TRADE_IFACE.parseLog({ topics: [...(log.topics || [])], data: log.data });
      } catch {
        parsed = CAMPAIGN_INTERFACE.parseLog({ topics: [...(log.topics || [])], data: log.data });
      }
      if (!parsed || (parsed.name !== "TokensPurchased" && parsed.name !== "TokensSold")) continue;
      const isSell = parsed.name === "TokensSold";
      trades.push({
        side: isSell ? "sell" : "buy",
        wallet: String(isSell ? parsed.args?.seller : parsed.args?.buyer || "").toLowerCase(),
        token_amount: String(isSell ? parsed.args?.amountIn : parsed.args?.amountOut || "0"),
        bnb_amount: String(isSell ? parsed.args?.payout : parsed.args?.cost || "0"),
        tx_hash: String(receipt?.hash || receipt?.transactionHash || "").toLowerCase(),
        block_number: Number(receipt?.blockNumber || log?.blockNumber || 0),
        log_index: Number(log?.index ?? log?.logIndex ?? 0),
        timestamp,
      });
    } catch {
      // Ignore unrelated logs in the same transaction.
    }
  }

  return trades;
}

async function getCampaignLogsChunked(
  provider: ethers.AbstractProvider,
  campaignAddress: string,
  topics: (string | string[] | null)[],
  fromBlock: number,
  toBlock: number,
) {
  const logs: ethers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += ACTIVITY_LOG_CHUNK_SIZE) {
    const end = Math.min(toBlock, start + ACTIVITY_LOG_CHUNK_SIZE - 1);
    const chunk = await provider.getLogs({ address: campaignAddress, topics, fromBlock: start, toBlock: end } as any);
    logs.push(...chunk);
  }
  return logs;
}

function readWindowPathname(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location.pathname || "";
  } catch {
    return "";
  }
}

export function useLaunchpad(): LaunchpadAdapter {
  const wallet = useWallet() as any;
  const solanaWallet = useSolanaWallet();
  const { provider: walletProvider, signer, chainId: walletChainId, account: evmAccount } = wallet;
  const { solanaAccount, solanaWalletName, isSolanaConnected } = solanaWallet;

  // CRITICAL BUG (fixed): preferSolana used `!wallet.isConnected`, which is true whenever
  // the *app* has no EVM session — even if MetaMask is injected on BNB. Combined with a
  // connected Phantom/Solana session, EVERY page (including /token/0x…) selected the
  // Solana adapter → metrics throw VITE_SOLANA_LAUNCHPAD_PROGRAM_ID and charts go blank.
  const location = useLocation();
  const onEvmTokenPage = isEvmTokenRoutePath(location.pathname) || isEvmTokenRoutePath(readWindowPathname());
  const hasEvmAppSession = Boolean(evmAccount || walletProvider);
  const preferSolanaLaunchpad = Boolean(
    isSolanaConnected &&
      solanaAccount &&
      !hasEvmAppSession &&
      !onEvmTokenPage,
  );

  // 0x Token Details: campaign chain from the URL, never the Solana feed latch.
  const tokenPageReadChain = onEvmTokenPage
    ? resolveTokenPageChainId({ pathname: location.pathname, search: location.search })
    : null;

  const activeChainId = useMemo<SupportedChainId>(() => {
    // 0x token pages: pinned/featured/default EVM — never MetaMask network.
    if (tokenPageReadChain) return tokenPageReadChain;
    if (preferSolanaLaunchpad) return SOLANA_CHAIN_ID;
    return getActiveChainId(walletChainId);
  }, [tokenPageReadChain, preferSolanaLaunchpad, walletChainId]);

  const evmFallbackChainId = useMemo<SupportedChainId>(() => {
    if (tokenPageReadChain) return tokenPageReadChain;
    if (walletChainId === 56 || walletChainId === 97) return walletChainId as SupportedChainId;
    const fallback = getActiveChainId(walletChainId);
    return isSolanaChainId(fallback) ? BNB_CHAIN_ID : fallback;
  }, [tokenPageReadChain, walletChainId]);
  const evmReadChainId = isSolanaChainId(activeChainId) ? evmFallbackChainId : activeChainId;
  const bnbAddresses = useMemo(() => getBnbContractAddresses(evmReadChainId), [evmReadChainId]);
  const bnbReadiness = useMemo(() => getBnbContractReadiness(evmReadChainId), [evmReadChainId]);
  const factoryAddress = bnbAddresses.launchFactory;
  const readProvider = useMemo(() => getReadProvider(evmReadChainId), [evmReadChainId]);

  const getFactoryRead = useCallback(() => {
    if (!factoryAddress) return null;
    return new Contract(factoryAddress, FACTORY_ABI, readProvider) as any;
  }, [factoryAddress, readProvider]);

  const getFactoryWrite = useCallback(() => {
    if (!factoryAddress || !signer) return null;
    return new Contract(factoryAddress, FACTORY_ABI, signer) as any;
  }, [factoryAddress, signer]);

  const getCampaignRead = useCallback((address: string) => {
    const campaignAddress = normalizeAddress(address);
    if (!campaignAddress) return null;
    return new Contract(campaignAddress, CAMPAIGN_ABI, readProvider) as any;
  }, [readProvider]);

  const fetchCampaignsCount = useCallback(async (): Promise<number> => {
    const factory = getFactoryRead();
    if (!factory) return 0;
    try {
      const total: bigint = await factory.campaignsCount();
      return Number(total ?? 0n);
    } catch (error) {
      if (isDecodeResultError(error)) {
        console.warn("[launchpadClient] campaignsCount unavailable for configured factory; using DB campaign feed", error);
        return 0;
      }
      throw error;
    }
  }, [getFactoryRead]);

  const fetchCampaignPage = useCallback(async (offset: number, limit: number, opts?: FetchCampaignPageOptions): Promise<CampaignInfo[]> => {
    const factory = getFactoryRead();
    if (!factory || !factoryAddress) return [];

    const total = await fetchCampaignsCount();
    if (total <= 0) return [];

    const safeLimit = Math.max(1, Math.min(50, Number(limit ?? 24)));
    const safeOffset = Math.max(0, Math.min(total, Number(offset ?? 0)));
    let page: any[] = [];

    try {
      page = await factory.getCampaignPage(safeOffset, safeLimit);
    } catch (error) {
      if (!isDecodeResultError(error)) throw error;
      const legacyFactory = new Contract(factoryAddress, LEGACY_FACTORY_ABI, readProvider) as any;
      page = await legacyFactory.getCampaignPage(safeOffset, safeLimit);
    }

    const mapped = (page ?? []).map((c: any, idx: number) => mapOnChainCampaign(c, idx, safeOffset, Number(activeChainId)));
    return opts?.newestFirst ?? true ? mapped.slice().reverse() : mapped;
  }, [getFactoryRead, fetchCampaignsCount, factoryAddress, readProvider, activeChainId]);

  const fetchCampaignLogoURI = useCallback(async (campaignAddress: string): Promise<string | null> => {
    const campaign = getCampaignRead(campaignAddress);
    if (!campaign) return null;
    try {
      const uri = await campaign.logoURI();
      const s = uri != null ? String(uri).trim() : "";
      return s || null;
    } catch {
      return null;
    }
  }, [getCampaignRead]);

  const fetchCampaigns = useCallback(async (): Promise<CampaignInfo[]> => {
    const chainId = Number(activeChainId || 56);
    const db = await fetchDbCampaigns(chainId);
    if (isSolanaChainId(activeChainId)) return db;
    if (!ENABLE_ONCHAIN_CAMPAIGN_FALLBACK) return hydrateMissingLogosFromContract(db, fetchCampaignLogoURI);

    try {
      const total = await fetchCampaignsCount();
      const limit = Math.min(total, 25);
      const offset = Math.max(0, total - limit);
      const onChain = limit > 0 ? await fetchCampaignPage(offset, limit, { newestFirst: true }) : [];
      return hydrateMissingLogosFromContract(mergeCampaigns(onChain, db), fetchCampaignLogoURI);
    } catch (error) {
      console.warn("[launchpadClient] on-chain campaign page failed; using DB campaigns", error);
      return hydrateMissingLogosFromContract(db, fetchCampaignLogoURI);
    }
  }, [activeChainId, fetchCampaignLogoURI, fetchCampaignsCount, fetchCampaignPage]);

  const fetchCampaignMetrics = useCallback(async (campaignAddress: string): Promise<CampaignMetrics | null> => {
    const campaign = getCampaignRead(campaignAddress);
    if (!campaign) return null;

    const readBig = async (method: string, fallback = 0n): Promise<bigint> => {
      try {
        const fn = campaign?.[method];
        if (typeof fn !== "function") return fallback;
        return (await fn()) as bigint;
      } catch (error) {
        if (!isUnsupportedContractMethod(error)) {
          console.warn(`[fetchCampaignMetrics] ${method} read failed`, error);
        }
        return fallback;
      }
    };

    const [
      sold,
      curveSupply,
      liquiditySupply,
      creatorReserve,
      basePrice,
      priceSlope,
      graduationTarget,
      liquidityBps,
      protocolFeeBps,
      currentPrice,
    ] = await Promise.all([
      readBig("sold"),
      readBig("curveSupply"),
      readBig("liquiditySupply"),
      readBig("creatorReserve"),
      readBig("basePrice"),
      readBig("priceSlope"),
      readBig("graduationTarget"),
      readBig("liquidityBps"),
      readBig("protocolFeeBps"),
      readBig("currentPrice"),
    ]);
    const graduationNativeTarget = await readBig("graduationNativeTarget", graduationTarget);

    const [launched, finalizedAt] = await Promise.all([
      campaign.launched().catch(() => false),
      campaign.finalizedAt().catch(() => 0n),
    ]);

    return { sold, curveSupply, liquiditySupply, creatorReserve, basePrice, priceSlope, graduationTarget, graduationNativeTarget, liquidityBps, protocolFeeBps, currentPrice, launched, finalizedAt };
  }, [getCampaignRead]);

  const fetchCampaignActivity = useCallback(async (campaignAddress: string): Promise<CampaignActivity | null> => {
    const campaign = getCampaignRead(campaignAddress);
    if (!campaign) return null;
    const latest = await readProvider.getBlockNumber().catch(() => 0);

    try {
      const [buyersCount, totalBuyVolumeWei, totalSellVolumeWei] = await Promise.all([
        campaign.buyersCount(),
        campaign.totalBuyVolumeWei(),
        campaign.totalSellVolumeWei(),
      ]);
      return { buyers: Number(buyersCount), sellers: 0, buyVolumeWei: totalBuyVolumeWei as bigint, sellVolumeWei: totalSellVolumeWei as bigint, fromBlock: latest, toBlock: latest };
    } catch (error) {
      console.warn("[fetchCampaignActivity] counters unavailable", error);
      try {
        const normalizedCampaign = normalizeAddress(campaignAddress);
        if (!normalizedCampaign || !latest) return null;
        const buyTopic = CAMPAIGN_INTERFACE.getEvent("TokensPurchased")?.topicHash;
        const sellTopic = CAMPAIGN_INTERFACE.getEvent("TokensSold")?.topicHash;
        if (!buyTopic || !sellTopic) return null;

        const fromBlock = Math.max(0, latest - ACTIVITY_LOG_LOOKBACK_BLOCKS);
        const logs = await getCampaignLogsChunked(readProvider, normalizedCampaign, [[buyTopic, sellTopic]], fromBlock, latest);
        const buyers = new Set<string>();
        const sellers = new Set<string>();
        let buyVolumeWei = 0n;
        let sellVolumeWei = 0n;

        for (const log of logs) {
          try {
            const parsed = CAMPAIGN_INTERFACE.parseLog(log);
            if (!parsed) continue;
            if (parsed.name === "TokensPurchased") {
              buyers.add(String(parsed.args?.buyer || "").toLowerCase());
              buyVolumeWei += BigInt(String(parsed.args?.cost || 0));
            } else if (parsed.name === "TokensSold") {
              sellers.add(String(parsed.args?.seller || "").toLowerCase());
              sellVolumeWei += BigInt(String(parsed.args?.payout || 0));
            }
          } catch {
            // Ignore malformed legacy logs.
          }
        }

        return { buyers: buyers.size, sellers: sellers.size, buyVolumeWei, sellVolumeWei, fromBlock, toBlock: latest };
      } catch (fallbackError) {
        console.warn("[fetchCampaignActivity] log fallback unavailable", fallbackError);
        return null;
      }
    }
  }, [getCampaignRead, readProvider]);

  const fetchCampaignSummary = useCallback(async (campaign: CampaignInfo): Promise<CampaignSummary> => {
    let metrics: CampaignMetrics | null = null;
    try {
      metrics = await fetchCampaignMetrics(campaign.campaign);
    } catch (error) {
      console.warn("[fetchCampaignSummary] metrics fetch failed", error);
    }

    let holders = "-";
    let volume = "-";
    let marketCap = "-";
    let marketCapBnb: number | undefined;

    try {
      const activity = await fetchCampaignActivity(campaign.campaign);
      if (activity) {
        holders = String(activity.buyers);
        volume = formatBnbFromWei(activity.buyVolumeWei + activity.sellVolumeWei);
      }
    } catch {
      // best effort
    }

    try {
      if (metrics && campaign.token) {
        const tokenAddress = normalizeAddress(campaign.token);
        if (tokenAddress) {
          const token = new Contract(tokenAddress, TOKEN_ABI, readProvider) as any;
          const totalSupply: bigint = await token.totalSupply();
          const circulating = metrics.launched ? totalSupply : metrics.sold;
          const mcWei = (metrics.currentPrice * circulating) / 10n ** 18n;
          marketCap = formatBnbFromWei(mcWei);
          const raw = Number(ethers.formatEther(mcWei));
          if (Number.isFinite(raw) && raw > 0) marketCapBnb = raw;
        }
      }
    } catch (error) {
      console.warn("[fetchCampaignSummary] market cap calc failed", error);
    }

    return { campaign, metrics, stats: { holders, volume, marketCap, marketCapBnb } };
  }, [fetchCampaignActivity, fetchCampaignMetrics, readProvider]);

  const fetchCampaignCardStats = useCallback(async (campaign: CampaignInfo): Promise<CampaignCardStats> => {
    const summary = await fetchCampaignSummary(campaign);
    return summary.stats;
  }, [fetchCampaignSummary]);

  const createCampaign = useCallback(async (params: CreateCampaignParams) => {
    const writer = getFactoryWrite();
    if (!writer) throw new Error("Wallet not connected");
    if (!wallet.account) throw new Error("Wallet not connected");
    if (!factoryAddress) throw new Error(`Factory address missing for chain ${evmReadChainId}`);

    const campaignRequest: CampaignRequestPayload = {
      name: params.name,
      symbol: params.symbol,
      logoURI: assertOnchainLogoUri(params.logoURI),
      xAccount: params.xAccount,
      website: params.website,
      extraLink: params.extraLink,
      graduationTarget: (params.graduationTargetWei ?? 0n).toString(),
    };

    await fetchLaunchpadCreatePreflight(wallet.account, activeChainId);
    const authResponse = await requestCreateAuthorization({
      walletAddress: wallet.account,
      chainId: Number(activeChainId),
      factoryAddress,
      campaignRequest,
    });
    const auth = authResponse.authorization;

    const tx = await writer.createCampaignAuthorized(
      campaignRequest,
      {
        tradeRouteProfile: auth.tradeRouteProfileId,
        finalizeRouteProfile: auth.finalizeRouteProfileId,
        deadline: Math.floor(new Date(auth.validUntil).getTime() / 1000),
        signature: auth.signature,
      },
      await legacyGasOverrides(signer, readProvider),
    );

    const receipt = await tx.wait();
    const created = extractCreatedCampaign(receipt);
    try {
      if (created.campaignAddress && created.tokenAddress) {
        const chainIdNum = Number(activeChainId);
        const campaignAddress = String(created.campaignAddress || "").toLowerCase();
        const tokenAddress = String(created.tokenAddress || "").toLowerCase();
        const creatorAddress = String(wallet.account || "").toLowerCase();
        let authFields: Record<string, string | number> = {};
        try {
          if (signer) {
            const { signWalletAction } = await import("@/lib/walletActionAuth");
            const auth = await signWalletAction({
              action: "campaign_upsert",
              walletAddress: creatorAddress,
              chainId: chainIdNum,
              signer,
              extraLines: [`Campaign: ${campaignAddress}`],
            });
            authFields = {
              action: auth.action,
              walletAddress: auth.walletAddress,
              nonce: auth.nonce,
              message: auth.message,
              signature: auth.signature,
              ...(auth.walletType ? { walletType: auth.walletType } : {}),
            };
          }
        } catch (signErr) {
          console.warn("[launchpadClient] campaign upsert auth sign skipped", signErr);
        }
        await apiFetch("/api/campaigns/upsert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chainId: chainIdNum,
            campaignAddress,
            tokenAddress,
            creatorAddress,
            name: params.name,
            symbol: params.symbol,
            logoURI: params.logoURI,
            xAccount: params.xAccount,
            website: params.website,
            extraLink: params.extraLink,
            ...authFields,
          }),
        });
      }
    } catch (error) {
      console.warn("[launchpadClient] Campaign metadata mirror failed", error);
    }
    emitTxConfirmed({ kind: "create", chainId: activeChainId, txHash: receipt?.hash ?? tx?.hash, ...created });
    return Object.assign(receipt ?? {}, created);
  }, [getFactoryWrite, wallet.account, activeChainId, evmReadChainId, factoryAddress, signer, readProvider]);

  const buyTokens = useCallback(async (campaignAddress: string, amountWei: bigint, maxCostWei: bigint) => {
    const submittedAddress = normalizeAddress(campaignAddress);
    if (!submittedAddress) throw new Error("Invalid campaign or token address");
    if (!signer) throw new Error("Wallet not connected");
    if (!wallet.account) throw new Error("Wallet not connected");

    const normalizedCampaign = await resolveCanonicalCampaignAddress(
      submittedAddress,
      Number(activeChainId),
      readProvider,
    );
    const campaign = new Contract(normalizedCampaign, CAMPAIGN_ABI, signer) as any;
    await fetchLaunchpadBuyPreflight(wallet.account, normalizedCampaign, activeChainId);
    const authResponse = await requestTradeAuthorization({
      walletAddress: wallet.account,
      campaignAddress: normalizedCampaign,
      chainId: Number(activeChainId),
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountWei,
      limit: maxCostWei,
    });
    const auth = authResponse.authorization;

    const overrides = await legacyGasOverrides(signer, readProvider, { value: maxCostWei });
    let tx;
    try {
      tx = await campaign.buyExactTokensAuthorized(
        amountWei,
        maxCostWei,
        auth.routeProfileId,
        Math.floor(new Date(auth.validUntil).getTime() / 1000),
        auth.signature,
        overrides,
      );
    } catch (error) {
      if (!isUnsupportedContractMethod(error)) throw error;
      console.warn("[launchpadClient] Authorized buy selector unavailable; retrying legacy buyExactTokens", error);
      tx = await campaign.buyExactTokens(amountWei, maxCostWei, { ...overrides, gasLimit: LEGACY_BUY_GAS_LIMIT });
    }
    const receipt = await tx.wait();
    let trades = await extractReceiptTrades(receipt, normalizedCampaign, readProvider);
    if (!trades.length) {
      trades = [{
        side: "buy",
        wallet: String(wallet.account || "").toLowerCase(),
        token_amount: amountWei.toString(),
        bnb_amount: maxCostWei.toString(),
        tx_hash: String(receipt?.hash || tx?.hash || "").toLowerCase(),
        block_number: Number(receipt?.blockNumber || 0),
        log_index: 1_000_000,
        timestamp: await blockTimestamp(readProvider, Number(receipt?.blockNumber || 0)),
      }];
    }
    emitTxConfirmed({ kind: "buy", chainId: activeChainId, campaignAddress: normalizedCampaign, txHash: receipt?.hash ?? tx?.hash, trades });
    notifyIndexerTrade({ chainId: Number(activeChainId), campaignAddress: normalizedCampaign, txHash: receipt?.hash ?? tx?.hash });
    return receipt;
  }, [signer, wallet.account, activeChainId, readProvider]);

  const sellTokens = useCallback(async (campaignAddress: string, amountWei: bigint, minAmountWei: bigint) => {
    const submittedAddress = normalizeAddress(campaignAddress);
    if (!submittedAddress) throw new Error("Invalid campaign or token address");
    if (!signer) throw new Error("Wallet not connected");
    if (!wallet.account) throw new Error("Wallet not connected");

    const normalizedCampaign = await resolveCanonicalCampaignAddress(
      submittedAddress,
      Number(activeChainId),
      readProvider,
    );
    const campaign = new Contract(normalizedCampaign, CAMPAIGN_ABI, signer) as any;
    await fetchLaunchpadSellPreflight(wallet.account, normalizedCampaign, activeChainId);
    const authResponse = await requestTradeAuthorization({
      walletAddress: wallet.account,
      campaignAddress: normalizedCampaign,
      chainId: Number(activeChainId),
      action: TRADE_AUTH_SELL_EXACT_TOKENS,
      amount: amountWei,
      limit: minAmountWei,
    });
    const auth = authResponse.authorization;

    const overrides = await legacyGasOverrides(signer, readProvider);
    let tx;
    try {
      tx = await campaign.sellExactTokensAuthorized(
        amountWei,
        minAmountWei,
        auth.routeProfileId,
        Math.floor(new Date(auth.validUntil).getTime() / 1000),
        auth.signature,
        overrides,
      );
    } catch (error) {
      if (!isUnsupportedContractMethod(error)) throw error;
      console.warn("[launchpadClient] Authorized sell selector unavailable; retrying legacy sellExactTokens", error);
      tx = await campaign.sellExactTokens(amountWei, minAmountWei, { ...overrides, gasLimit: LEGACY_SELL_GAS_LIMIT });
    }
    const receipt = await tx.wait();
    let trades = await extractReceiptTrades(receipt, normalizedCampaign, readProvider);
    if (!trades.length) {
      trades = [{
        side: "sell",
        wallet: String(wallet.account || "").toLowerCase(),
        token_amount: amountWei.toString(),
        bnb_amount: minAmountWei.toString(),
        tx_hash: String(receipt?.hash || tx?.hash || "").toLowerCase(),
        block_number: Number(receipt?.blockNumber || 0),
        log_index: 1_000_000,
        timestamp: await blockTimestamp(readProvider, Number(receipt?.blockNumber || 0)),
      }];
    }
    emitTxConfirmed({ kind: "sell", chainId: activeChainId, campaignAddress: normalizedCampaign, txHash: receipt?.hash ?? tx?.hash, trades });
    notifyIndexerTrade({ chainId: Number(activeChainId), campaignAddress: normalizedCampaign, txHash: receipt?.hash ?? tx?.hash });
    return receipt;
  }, [signer, wallet.account, activeChainId, readProvider]);

  const finalizeCampaign = useCallback(async (campaignAddress: string, minTokens: bigint, minBnb: bigint) => {
    const normalizedCampaign = normalizeAddress(campaignAddress);
    if (!normalizedCampaign) throw new Error("Invalid campaign address");
    if (!signer) throw new Error("Wallet not connected");
    const campaign = new Contract(normalizedCampaign, GRADUATION_WRITE_ABI, signer) as any;
    const tx = await campaign.graduateIfEligible(minTokens, minBnb, await legacyGasOverrides(signer, readProvider));
    const receipt = await tx.wait();
    emitTxConfirmed({ kind: "finalize", chainId: activeChainId, campaignAddress: normalizedCampaign, txHash: receipt?.hash ?? tx?.hash });
    return receipt;
  }, [signer, activeChainId, readProvider]);

  const getSafetyStatus = useCallback(() => getBnbLaunchpadSafetyStatus({
    chainId: activeChainId,
    factoryAddress,
    hasSigner: Boolean(signer),
    hasAccount: Boolean(wallet.account),
    walletChainId,
    contractReadiness: bnbReadiness,
  }), [activeChainId, factoryAddress, signer, wallet.account, walletChainId, bnbReadiness]);

  const bnbAdapter = useMemo<LaunchpadAdapter>(() => ({
    adapterId: "bnb",
    protocolStatus: factoryAddress && bnbReadiness.ready ? "ready" : "unavailable",
    fetchCampaignsCount,
    fetchCampaignPage,
    fetchCampaigns,
    fetchCampaignLogoURI,
    fetchCampaignMetrics,
    fetchCampaignCardStats,
    fetchCampaignActivity,
    fetchCampaignSummary,
    createCampaign,
    buyTokens,
    sellTokens,
    finalizeCampaign,
    getSafetyStatus,
    walletProvider,
    activeChainId,
    factoryAddress,
  }), [
    factoryAddress,
    bnbReadiness.ready,
    fetchCampaignsCount,
    fetchCampaignPage,
    fetchCampaigns,
    fetchCampaignLogoURI,
    fetchCampaignMetrics,
    fetchCampaignCardStats,
    fetchCampaignActivity,
    fetchCampaignSummary,
    createCampaign,
    buyTokens,
    sellTokens,
    finalizeCampaign,
    getSafetyStatus,
    walletProvider,
    activeChainId,
  ]);

  const solanaAdapter = useMemo<LaunchpadAdapter>(() => createSolanaLaunchpadAdapter({
    fetchCampaigns,
    walletProvider,
    hasSolanaWallet: Boolean(solanaAccount),
    solanaWalletName,
    solanaAccount,
  }), [fetchCampaigns, walletProvider, solanaAccount, solanaWalletName]);

  // Hard rule: /token/0x… always BNB. Solana adapter only when active chain is Solana
  // and we are not on an EVM token details route.
  if (onEvmTokenPage) return bnbAdapter;
  return isSolanaChainId(activeChainId) ? solanaAdapter : bnbAdapter;
}

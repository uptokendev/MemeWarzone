/**
 * Token Details Page
 * Displays comprehensive information about a specific token including
 * chart, trading interface, transactions, and holder distribution
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Copy, ExternalLink, Flag, Globe, Star } from "lucide-react";
import { buildAbuseReportPath } from "@/lib/abuseReportLink";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import twitterIcon from "@/assets/social/twitter.png";
import { useLaunchpad } from "@/lib/launchpadClient";
import type { CampaignInfo, CampaignMetrics, CampaignSummary, CampaignActivity } from "@/lib/launchpadClient";
import {
  isSolanaChainId,
  pinTokenDetailsChainId,
  resolveTokenPageChainId,
  SOLANA_CHAIN_ID,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { resolveMarketIdentity, resolveMarketIdentityAcrossEvm } from "@/lib/marketIdentity";
import { recordRecentlyViewed } from "@/lib/searchHistory";
import { getReadProvider } from "@/lib/readProvider";

import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";
import { useTokenStatsRealtime } from "@/hooks/useTokenStatsRealtime";
import { UnifiedMarketChart } from "@/components/token/UnifiedMarketChart";
import { GraduationExplosion } from "@/components/token/GraduationExplosion";
import { useUnifiedMarket, type MarketResolution } from "@/hooks/useUnifiedMarket";
import { useTopazMarket } from "@/hooks/useTopazMarket";
import { useSolanaMeteoraMarket } from "@/hooks/useSolanaMeteoraMarket";
import {
  ensureTopazSellAllowance,
  executeTopazBuy,
  executeTopazSell,
  quoteTopazBuy,
  quoteTopazSell,
  resolveVerifiedTopazRoute,
  solveNativeForExactTokens,
  solveTokensForExactNative,
} from "@/lib/topazV2Trade";
import {
  isSolanaCurveClosedError,
  requestSolanaGraduationHandoff,
  stashPendingSolanaDexTrade,
} from "@/lib/solanaGraduationHandoff";
import { TokenComments } from "@/components/token/TokenComments";
import { TokenWarRoom } from "@/components/token/TokenWarRoom";
import { AthBar } from "@/components/token/AthBar";
import { canonicalAthUsd } from "@/lib/canonicalMarket";
import { canonicalAthNativeFromCandles } from "@/lib/chart/canonicalChartCandles";
import { UpvoteDialog } from "@/components/token/UpvoteDialog";
import { useWallet } from "@/contexts/WalletContext";
import { followCampaign, unfollowCampaign, isFollowingCampaign } from "@/lib/followApi";
import { useCurveTrades, type CurveTradePoint } from "@/hooks/useCurveTrades";
import { useTokenTransferHolders } from "@/hooks/useTokenTransferHolders";
import { marketTradeToCurvePoint, parseRawOrHumanAmount } from "@/lib/chart/normalizeTrade";
import { Contract, ethers } from "ethers";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";
import { fetchUserProfile, type UserProfile } from "@/lib/profileApi";
import { resolveImageUri } from "@/lib/media";
import { apiFetch } from "@/lib/apiBase";
import { SOLANA_WALLET_EVENT, ensureSolanaListeners } from "@/lib/solanaWallet";
import {
  CrypticPumpBadge,
  CrypticPumpListButton,
  fetchCrypticPumpListing,
  type CrypticPumpListingData,
} from "@/components/token/CrypticPumpListing";
import { RadarLoader } from "@/components/ui/RadarLoader";
import { fetchOnChainCampaignPage } from "@/lib/onChainCampaignFeed";
import { solanaMarginalSpotSol } from "@/lib/solanaCampaignRead";
import { fetchPublicCampaignLifecycleDrafts } from "@/lib/scheduledLaunchApi";
import {
  appendLocalTopazTrade,
} from "@/lib/localTopazTrades";
import { fetchTopazTradeReports, reportTopazTrade } from "@/lib/topazTradeReports";
import { isValidTradeTxHash, mergeTradePoints, normalizeTradeTxHash, SYNTHETIC_LOG_INDEX_MIN, tradeDedupeKey } from "@/lib/tradeDedupe";

const CAMPAIGN_ABI = LaunchCampaignArtifact.abi as ethers.InterfaceAbi;
const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;
const TOKEN_DECIMALS = 18;
const SLIPPAGE_PCT = 5;
const MAX_UINT256 = (1n << 256n) - 1n;

function findEthersErrorData(error: any): string | null {
  const candidates = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.cause?.data,
    error?.revert?.data,
  ];
  return candidates.find((value) => typeof value === "string" && value.startsWith("0x")) ?? null;
}

function describeTradeError(error: any): string {
  const data = findEthersErrorData(error);
  if (data) {
    try {
      const parsed = new ethers.Interface(CAMPAIGN_ABI).parseError(data);
      if (parsed?.name === "CreatorBuyLocked") {
        return "Creator-wallet buys are temporarily locked after launch. Use a different wallet for this test or wait until the creator lock expires.";
      }
      if (parsed?.name === "CreatorBuyCapExceeded") {
        return "This buy exceeds the creator wallet's launch-period buy cap. Use a smaller amount or a different wallet.";
      }
    } catch {
      // Fall through to the provider's message for unknown errors.
    }
  }
  return error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
}

function hasUsefulImage(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  return Boolean(raw && raw !== "/placeholder.svg" && raw !== "-");
}

function isLikelyMetadataUri(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  return raw.includes("/api/token-metadata/") || raw.includes("token-metadata") || raw.endsWith(".json");
}

function extractMetadataImage(metadata: any): string | undefined {
  return resolveImageUri(
    metadata?.image ||
      metadata?.image_url ||
      metadata?.imageUrl ||
      metadata?.logo_uri ||
      metadata?.logoUri ||
      metadata?.logoURI ||
      metadata?.metadata?.image ||
      metadata?.metadata?.image_url ||
      metadata?.tokenMetadata?.image ||
      metadata?.tokenMetadata?.image_url,
  );
}

async function fetchImageFromMetadataUri(uri: string): Promise<string | undefined> {
  const raw = String(uri ?? "").trim();
  if (!raw) return undefined;

  try {
    const res = raw.startsWith("/api/") ? await apiFetch(raw, { cache: "no-store" }) : await fetch(raw, { cache: "no-store" });
    const metadata = await res.json().catch(() => null);
    if (!res.ok) return undefined;
    return extractMetadataImage(metadata);
  } catch {
    return undefined;
  }
}

async function fetchRegisteredImage(chainId: number, address?: string | null): Promise<string | undefined> {
  const metadata = await fetchRegisteredMetadata(chainId, address);
  return metadata ? extractMetadataImage(metadata) : undefined;
}

async function fetchRegisteredMetadata(chainId: number, address?: string | null): Promise<any | null> {
  const raw = String(address ?? "").trim();
  if (!ethers.isAddress(raw)) return null;

  try {
    const metadataRes = await apiFetch(`/api/token-metadata/${chainId}/${raw}`, { cache: "no-store" });
    const metadata = await metadataRes.json().catch(() => null);
    if (!metadataRes.ok) return null;
    return metadata;
  } catch {
    return null;
  }
}

function normalizeMetadataSocials(metadata: any): Partial<CampaignInfo> {
  const props = metadata?.properties || {};
  return {
    website: String(props.website || metadata?.website || "").trim(),
    xAccount: String(props.x || metadata?.xAccount || metadata?.xUrl || "").trim(),
    telegram: String(props.telegram || metadata?.telegram || "").trim(),
    discord: String(props.discord || metadata?.discord || "").trim(),
    extraLink: String(props.extraLink || props.extra_link || metadata?.extraLink || metadata?.extra_link || "").trim(),
  };
}

async function hydrateCampaignMetadata(campaign: CampaignInfo, chainId: number): Promise<CampaignInfo> {
  for (const address of [campaign.campaign, campaign.token]) {
    const metadata = await fetchRegisteredMetadata(chainId, address);
    if (!metadata) continue;
    const socials = normalizeMetadataSocials(metadata);
    const image = extractMetadataImage(metadata);
    return {
      ...campaign,
      logoURI: hasUsefulImage(campaign.logoURI) ? campaign.logoURI : image || campaign.logoURI,
      website: campaign.website || socials.website || "",
      xAccount: campaign.xAccount || socials.xAccount || "",
      telegram: campaign.telegram || socials.telegram || "",
      discord: campaign.discord || socials.discord || "",
      extraLink: campaign.extraLink || socials.extraLink || "",
    };
  }
  return campaign;
}

async function hydrateCampaignCreatedAtFromFactory(campaign: CampaignInfo, chainId: SupportedChainId): Promise<CampaignInfo> {
  if (campaign.createdAt && campaign.createdAt > 1_577_836_800) return campaign;
  const target = String(campaign.campaign || "").toLowerCase();
  if (!target) return campaign;

  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const page = await fetchOnChainCampaignPage(chainId, { limit: 100, cursor });
    const found = page.campaigns.find((item) => String(item.campaign || "").toLowerCase() === target);
    if (found?.createdAt && found.createdAt > 1_577_836_800) {
      return {
        ...campaign,
        createdAt: found.createdAt,
        timeAgo: campaign.timeAgo || found.timeAgo,
      };
    }
    if (page.nextCursor == null) break;
    cursor = page.nextCursor;
  }

  return campaign;
}

async function resolveCampaignDisplayImage(campaign: CampaignInfo, chainId: number, fetchCampaignLogoURI: (campaignAddress: string) => Promise<string | null>): Promise<string | undefined> {
  const candidates = [campaign.logoURI, campaign.metadataURI].map((value) => String(value ?? "").trim()).filter(Boolean);

  for (const candidate of candidates) {
    if (isLikelyMetadataUri(candidate)) {
      const metadataImage = await fetchImageFromMetadataUri(candidate);
      if (hasUsefulImage(metadataImage)) return metadataImage;
      continue;
    }

    const resolved = resolveImageUri(candidate);
    if (hasUsefulImage(resolved)) return resolved;
  }

  for (const address of [campaign.campaign, campaign.token]) {
    const registeredImage = await fetchRegisteredImage(chainId, address);
    if (hasUsefulImage(registeredImage)) return registeredImage;
  }

  try {
    const contractLogo = String((await fetchCampaignLogoURI(campaign.campaign)) ?? "").trim();
    if (isLikelyMetadataUri(contractLogo)) {
      const metadataImage = await fetchImageFromMetadataUri(contractLogo);
      if (hasUsefulImage(metadataImage)) return metadataImage;
    }
    const resolved = resolveImageUri(contractLogo);
    if (hasUsefulImage(resolved)) return resolved;
  } catch {
    // Best-effort only.
  }

  return undefined;
}

async function safeContractRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const value = await read();
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function buildCampaignFromAddress(
  campaignAddress: string,
  provider: ethers.AbstractProvider,
  chainId: number,
): Promise<CampaignInfo | null> {
  const campaignAddr = String(campaignAddress ?? "").trim().toLowerCase();
  if (!ethers.isAddress(campaignAddr)) return null;

  const campaign = new Contract(campaignAddr, CAMPAIGN_ABI, provider) as any;
  const tokenAddress = String(await safeContractRead(() => campaign.token(), "") || "").toLowerCase();
  if (!ethers.isAddress(tokenAddress)) return null;

  const token = new Contract(tokenAddress, TOKEN_ABI, provider) as any;
  const [name, symbol, creator, logo] = await Promise.all([
    safeContractRead(() => token.name(), "Unknown"),
    safeContractRead(() => token.symbol(), ""),
    safeContractRead(() => campaign.creator(), ""),
    safeContractRead(() => campaign.logoURI(), ""),
  ]);

  return {
    id: 0,
    campaign: campaignAddr,
    token: tokenAddress,
    creator: ethers.isAddress(String(creator)) ? String(creator).toLowerCase() : "",
    name: String(name || "Unknown"),
    symbol: String(symbol || ""),
    logoURI: resolveImageUri(String(logo || "")) || "/placeholder.svg",
    metadataURI: `/api/token-metadata/${chainId}/${tokenAddress}`,
    xAccount: "",
    website: "",
    extraLink: "",
  };
}

async function hydrateCampaignCreatorFromContract(
  campaign: CampaignInfo,
  provider: ethers.AbstractProvider,
): Promise<CampaignInfo> {
  const campaignAddress = String(campaign.campaign ?? "").trim();
  if (!ethers.isAddress(campaignAddress)) return campaign;

  try {
    const contract = new Contract(campaignAddress, CAMPAIGN_ABI, provider) as any;
    const creator = String(await safeContractRead(() => contract.creator(), "") || "").toLowerCase();
    if (ethers.isAddress(creator) && creator !== String(campaign.creator ?? "").toLowerCase()) {
      return { ...campaign, creator };
    }
  } catch {
    // Best-effort only. Keep API/indexer creator if contract read is unavailable.
  }

  return campaign;
}

// This is the UI table row shape (NOT the on-chain CurveTrade shape)
type TxRow = {
  id: string;
  time: string;
  type: "buy" | "sell";
  amount: string;
  bnb: string;
  price: string;
  mcap: string;
  maker: string;
  makerAddress: string;
  txHash: string;
};

function parseRawOrDecimalUnits(rawValue: unknown, decimalValue: unknown, decimals: number): bigint {
  if (typeof rawValue === "bigint") return rawValue;
  if (typeof decimalValue === "bigint") return decimalValue;
  return parseRawOrHumanAmount(rawValue, decimalValue, decimals);
}

function tradeTimestampSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value > 1e12 ? value / 1000 : value);
  const raw = String(value ?? "").trim();
  if (!raw) return Math.floor(Date.now() / 1000);
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n > 1e12 ? n / 1000 : n) : Math.floor(Date.now() / 1000);
  }
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function mergeCurveTradePoints(prev: CurveTradePoint[], next: CurveTradePoint[]) {
  return mergeTradePoints(prev, next);
}

function confirmedRowsToCurvePoints(
  rows: any[],
  campaignAddress: string,
  chainId: number,
  tokenDecimals: number,
): CurveTradePoint[] {
  const solana = isSolanaChainId(chainId);
  const campaign = solana ? String(campaignAddress || "").trim() : String(campaignAddress || "").toLowerCase();
  const nativeDecimals = solana ? 9 : 18;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const type = String(row?.side || row?.type || "").toLowerCase() === "sell" ? "sell" : "buy";
      const tokensWei = parseRawOrDecimalUnits(
        row?.token_amount_raw ?? row?.tokensWei,
        row?.token_amount ?? row?.tokens,
        tokenDecimals,
      );
      const nativeWei = parseRawOrDecimalUnits(
        row?.bnb_amount_raw ?? row?.nativeWei,
        row?.bnb_amount ?? row?.native,
        nativeDecimals,
      );
      const tokens = Number(ethers.formatUnits(tokensWei, tokenDecimals));
      const native = Number(ethers.formatUnits(nativeWei, nativeDecimals));
      const txHash = normalizeTradeTxHash(row?.tx_hash || row?.txHash);
      return {
        type,
        from: solana
          ? String(row?.wallet || row?.trader || row?.from || "").trim()
          : String(row?.wallet || row?.trader || row?.from || "").toLowerCase(),
        to: campaign,
        tokensWei,
        nativeWei,
        pricePerToken: Number(row?.price_bnb ?? row?.pricePerToken) || (tokens > 0 ? native / tokens : 0),
        soldTokensAfterRaw:
          row?.sold_tokens_after_raw != null &&
          String(row.sold_tokens_after_raw).trim() !== ""
            ? BigInt(String(row.sold_tokens_after_raw))
            : row?.soldTokensAfterRaw != null &&
                String(row.soldTokensAfterRaw).trim() !== ""
              ? BigInt(String(row.soldTokensAfterRaw))
              : null,
        timestamp: tradeTimestampSeconds(row?.timestamp ?? row?.block_time ?? row?.time),
        txHash,
        blockNumber: Number(row?.block_number ?? row?.blockNumber ?? 0),
        logIndex: Number(row?.log_index ?? row?.logIndex ?? 0),
      } satisfies CurveTradePoint;
    })
    .filter((point) => Boolean(point.txHash) && point.tokensWei > 0n && point.nativeWei >= 0n);
}

function getExplorerBase(chainId?: number): string {
  const id = Number(chainId ?? 0);
  if (id === 101) return "https://explorer.solana.com";
  if (id === 56) return "https://bscscan.com";
  if (id === 97) return "https://testnet.bscscan.com";
  return "https://bscscan.com";
}

function formatTinyUsdPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";

  if (value >= 0.01) {
    return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  // Keep enough significant digits for micro-priced launch tokens.
  // Example: 4.43e-7 => $0.000000443
  const decimals = Math.min(
    14,
    Math.max(8, Math.ceil(-Math.log10(value)) + 3),
  );

  return `$${value
    .toFixed(decimals)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}`;
}

function shortenAddress(addr?: string | null): string {
  const a = String(addr ?? "").trim();
  if (!a) return "";
  if (a.length <= 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function normalizeProfileAddressKey(address: unknown, chainId: number): string {
  const raw = String(address ?? "").trim();
  if (!raw) return "";
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

function formatTimeAgo(ts?: number | null): string {
  if (ts == null) return "—";
  const raw = Number(ts);
  if (!Number.isFinite(raw) || raw <= 0) return "—";

  // tolerate ms timestamps
  const seconds = raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
  if (seconds <= 1_577_836_800) return "—";
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - seconds);

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

function formatDeployedDate(ts?: number | null, fallback?: string | null): string {
  const raw = Number(ts ?? 0);
  const seconds = raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);

  // Guard against bad indexer defaults like unix epoch / tiny placeholder timestamps.
  if (Number.isFinite(seconds) && seconds > 1_577_836_800) {
    const absolute = new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const relative = formatTimeAgo(seconds);
    return relative && relative !== "—" ? `${absolute} · ${relative}` : absolute;
  }

  const timeAgo = String(fallback ?? "").trim();
  if (!timeAgo || /^295\d+w\s+ago$/i.test(timeAgo)) return "—";
  return timeAgo.includes("ago") ? timeAgo : `${timeAgo} ago`;
}

function normalizeSocialUrl(raw: string | null | undefined, kind: "x" | "telegram" | "discord" | "website" | "other"): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const cleaned = value.replace(/^@+/, "").replace(/^\/+/, "");
  if (kind === "x") return `https://x.com/${cleaned.replace(/^(twitter\.com|x\.com)\//i, "").split("/")[0]}`;
  if (kind === "telegram") return `https://t.me/${cleaned.replace(/^(t\.me|telegram\.me|telegram\.dog)\//i, "").split("/")[0]}`;
  if (kind === "discord") return cleaned.toLowerCase().includes("discord") ? `https://${cleaned}` : value;
  return `https://${cleaned}`;
}

function readStoredString<T extends string>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return (value as T) || fallback;
  } catch {
    return fallback;
  }
}

function readStoredStringArray(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : fallback;
  } catch {
    return fallback;
  }
}

const TokenDetails = () => {
  // URL param: /token/:campaignAddress is legacy-named, but accepts either:
  // - the ERC-20 token address (canonical public URL), or
  // - the LaunchCampaign address (legacy/backward-compatible URL).
  const { campaignAddress } = useParams<{ campaignAddress: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const { toast } = useToast();
  const [tradeAmount, setTradeAmount] = useState("0");

  // Default buy input to native (BNB/SOL) — "0.005" as tokens on a ~1e-9 spot curve is almost always a UX mistake.
  // State key stays "BNB" meaning "native coin" for the trade engine; labels use nativeUnit (SOL on Solana).
  const [tradeInputDenom, setTradeInputDenom] = useState<"TOKEN" | "BNB">("BNB");
  const toggleTradeInputDenom = () => {
    setTradeAmount("0");
    setQuoteWei(null);
    setQuoteError(null);
    setTradeInputDenom((d) => (d === "TOKEN" ? "BNB" : "TOKEN"));
  };
  const [effectiveTokenWei, setEffectiveTokenWei] = useState<bigint>(0n);
  const [effectiveBnbWei, setEffectiveBnbWei] = useState<bigint>(0n);
  const [tradeTab, setTradeTab] = useState<"buy" | "sell">("buy");
  const handleTradeTabChange = (value: string) => {
    const next = value as "buy" | "sell";
    setTradeTab(next);
    if (isSolanaPage) {
      // V4 bonding supports exact SOL-in buys and exact token-in sells. Do not leave
      // Sell in native denomination and then reinterpret e.g. "0.01 SOL" as 0.01 token.
      setTradeAmount("0");
      setQuoteWei(null);
      setQuoteError(null);
      setEffectiveTokenWei(0n);
      setEffectiveBnbWei(0n);
      setTradeInputDenom(next === "sell" ? "TOKEN" : "BNB");
    }
  };
  const [selectedTimeframe, setSelectedTimeframe] = useState<
    "5m" | "1h" | "4h" | "24h"
  >("24h");

  const [displayDenom, setDisplayDenom] = useState<"USD" | "BNB">(() => {
    try {
      const saved = localStorage.getItem("launchit:displayDenom");
      if (saved === "USD" || saved === "BNB") return saved;

      // Backward-compat: older builds stored this under a market-cap specific key.
      const legacy = localStorage.getItem("launchit:mcDenom");
      if (legacy === "USD" || legacy === "BNB") return legacy;

      return "USD";
    } catch {
      return "USD";
    }
  });
  const isMobile = window.innerWidth < 768;

  // Buy / Sell CTAs: orange text at rest → full orange + white text on hover/active.
  const topbarButtonClass =
    "bg-transparent border border-orange-400/50 text-orange-300 hover:bg-orange-500 hover:text-white hover:border-orange-500 " +
    "font-retro text-xs md:text-sm px-3 md:px-4 py-2 rounded-xl shadow-lg transition-colors";

  // Tabs that should visually read like the TopBar CTA buttons.
  const ctaTabsListClass = "grid w-full grid-cols-2 mb-3 bg-transparent p-0 h-auto gap-2";
  const ctaTabsTriggerClass =
    "rounded-xl border px-3 py-2 font-retro text-xs md:text-sm transition-colors " +
    "bg-transparent border-orange-400/40 text-orange-300 hover:bg-orange-500 hover:text-white hover:border-orange-500 " +
    "data-[state=active]:bg-orange-500 data-[state=active]:text-white data-[state=active]:border-orange-500 data-[state=active]:shadow-lg";

  useEffect(() => {
    try {
      localStorage.setItem("launchit:displayDenom", displayDenom);
    } catch {
      // ignore
    }
  }, [displayDenom]);

  // Launchpad hooks + state for the on-chain data
  const { fetchCampaigns, fetchCampaignLogoURI, fetchCampaignSummary, fetchCampaignMetrics, fetchCampaignActivity, buyTokens, sellTokens } = useLaunchpad();
  const wallet = useWallet();
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  const [campaign, setCampaign] = useState<CampaignInfo | null>(null);
  // Must be declared BEFORE chainIdForStorage — using campaignAddr in a prior const
  // caused TDZ: "Cannot access 'Q' before initialization" and crashed TokenDetails.
  const campaignAddr = useMemo(() => {
    const raw = String(campaign?.campaign ?? campaignAddress ?? "").trim();
    // Solana base58 is case-sensitive — never lowercase.
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) && !raw.startsWith("0x")) return raw;
    return raw.toLowerCase();
  }, [campaign?.campaign, campaignAddress]);
  // Pinned/featured/default EVM chain — NOT wallet network (see getEvmReadChainIdForTokenPage).
  // Solana token routes force 101 in the load effect.
  const [pageChainId, setPageChainId] = useState<SupportedChainId>(() =>
    resolveTokenPageChainId({
      pathname: typeof window !== "undefined" ? window.location.pathname : "",
      search: typeof window !== "undefined" ? window.location.search : "",
      routeId: campaignAddress,
    }),
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const queryChainId = Number(params.get("chainId") || "");
    if (queryChainId !== 56 && queryChainId !== 101) return;
    params.delete("chainId");
    const next = params.toString();
    navigate({ pathname: location.pathname, search: next ? `?${next}` : "" }, { replace: true });
  }, [location.pathname, location.search, navigate]);
  const chainIdForStorage = pageChainId;

  useEffect(() => {
    const next = resolveTokenPageChainId({
      pathname: location.pathname,
      search: location.search,
      routeId: campaignAddress,
    });
    if (next !== pageChainId) setPageChainId(next);
  }, [campaignAddress, location.pathname, location.search, pageChainId]);
  const isSolanaPage =
    isSolanaChainId(chainIdForStorage) &&
    !/^0x[a-fA-F0-9]{40}$/i.test(String(campaignAddress || campaignAddr || ""));

  useEffect(() => {
    const campaignPda = String(campaign?.campaign || campaignAddr || "").trim();
    const token = String(campaign?.token || campaignAddress || campaignPda || "").trim();
    if (!campaignPda && !token) return;
    recordRecentlyViewed({
      name: String(campaign?.name || campaign?.symbol || token.slice(0, 6) || "Token"),
      symbol: campaign?.symbol,
      logoURI: campaign?.logoURI,
      tokenAddress: token,
      campaignAddress: campaignPda || token,
      chainId: chainIdForStorage,
    });
  }, [campaign, campaignAddr, campaignAddress, chainIdForStorage]);
  /** Native unit for bonding quotes/UI: SOL on Solana, BNB on EVM. Never show BNB on Solana pages. */
  const nativeUnit = isSolanaPage ? "SOL" : "BNB";
  const readProvider = useMemo(
    () => (isSolanaPage ? null : getReadProvider(chainIdForStorage)),
    [chainIdForStorage, isSolanaPage],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!wallet.account || !campaignAddr) {
          if (alive) setIsFollowing(false);
          return;
        }
        const v = await isFollowingCampaign(wallet.account, campaignAddr, chainIdForStorage);
        if (alive) setIsFollowing(!!v);
      } catch {
        if (alive) setIsFollowing(false);
      }
    })();
    return () => { alive = false; };
  }, [wallet.account, campaignAddr, chainIdForStorage]);

  const toggleFollow = async () => {
    if (!campaignAddr) return;
    if (!wallet.account) {
      toast({ title: "Connect wallet", description: "Connect your wallet to follow campaigns." });
      try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch {}
      return;
    }
    if (followBusy) return;
    setFollowBusy(true);
    const next = !isFollowing;
    setIsFollowing(next);
    try {
      const signOpts = { signer: wallet.signer };
      if (next) await followCampaign(wallet.account, campaignAddr, chainIdForStorage, signOpts);
      else await unfollowCampaign(wallet.account, campaignAddr, chainIdForStorage, signOpts);
    } catch (e: any) {
      setIsFollowing(!next);
      toast({ title: "Follow failed", description: String(e?.message ?? e ?? "Unknown error") });
    } finally {
      setFollowBusy(false);
    }
  };
  const [metrics, setMetrics] = useState<CampaignMetrics | null>(null);
  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [activity, setActivity] = useState<CampaignActivity | null>(null);
  const [confirmedCurvePoints, setConfirmedCurvePoints] = useState<CurveTradePoint[]>([]);
  const [activityTab, setActivityTab] = useState<"overview" | "comments" | "trades">(() => readStoredString("mwz:token:workspace-tab", "overview"));
  const [communityTab, setCommunityTab] = useState<"comments" | "updates">(() => {
    const stored = readStoredString("mwz:token:community-tab", "comments" as "comments" | "updates" | "chat");
    return stored === "updates" ? "updates" : "comments";
  });
  const [intelSections, setIntelSections] = useState<string[]>(() => readStoredStringArray("mwz:token:intel-sections", ["campaign", "flywheel", "holders"]));
  const [curveReserveWei, setCurveReserveWei] = useState<bigint | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("mwz:token:workspace-tab", activityTab);
    } catch {
      // ignore
    }
  }, [activityTab]);

  useEffect(() => {
    try {
      localStorage.setItem("mwz:token:community-tab", communityTab);
    } catch {
      // ignore
    }
  }, [communityTab]);

  useEffect(() => {
    try {
      localStorage.setItem("mwz:token:intel-sections", JSON.stringify(intelSections));
    } catch {
      // ignore
    }
  }, [intelSections]);

  // UI rows for the transactions table
  const [txs, setTxs] = useState<TxRow[]>([]);

  // Maker profiles for the Trades tab (best-effort; cached per address)
  const [makerProfiles, setMakerProfiles] = useState<Record<string, UserProfile | null>>({});

  // Creator profile (best-effort; used in the header)
  const [creatorProfile, setCreatorProfile] = useState<UserProfile | null>(null);
  const [crypticPumpListing, setCrypticPumpListing] = useState<CrypticPumpListingData | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Trading (quote + balances)
  const [quoteWei, setQuoteWei] = useState<bigint | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [tradePending, setTradePending] = useState(false);
  const [approvePending, setApprovePending] = useState(false);
  const [bnbBalanceWei, setBnbBalanceWei] = useState<bigint | null>(null);
  const [tokenBalanceWei, setTokenBalanceWei] = useState<bigint | null>(null);
  /** Solana V4 campaign curve snapshot (quotes / vaults / lock). */
  const [solanaCurve, setSolanaCurve] = useState<import("@/lib/solanaCampaignRead").SolanaCampaignCurveState | null>(null);
  const [solanaBalanceTick, setSolanaBalanceTick] = useState(0);

  // Phantom/Solflare/Backpack accountChanged is separate from the EVM WalletContext.
  // Refresh the displayed SOL + ATA balances as soon as the selected Solana account changes.
  useEffect(() => {
    if (!isSolanaPage) return;
    ensureSolanaListeners({ readExistingAccount: true });
    const onSolanaWalletChanged = () => setSolanaBalanceTick((value) => value + 1);
    window.addEventListener(SOLANA_WALLET_EVENT, onSolanaWalletChanged as EventListener);
    return () => {
      window.removeEventListener(SOLANA_WALLET_EVENT, onSolanaWalletChanged as EventListener);
    };
  }, [isSolanaPage]);
  /** SOL/USD for graduation target conversion (USD micros → SOL lamports). */
  const [solUsdPrice, setSolUsdPrice] = useState<number | null>(null);
  /** V4 tokens use on-chain decimals (default 6); EVM launchpad tokens use 18. */
  const tokenDecimals = isSolanaPage ? Number(solanaCurve?.tokenDecimals ?? 6) : TOKEN_DECIMALS;
  const solanaMeteora = useSolanaMeteoraMarket({
    mint: isSolanaPage ? String(solanaCurve?.mint || campaign?.token || "") : "",
    tokenDecimals,
    campaignTokenVault: solanaCurve?.tokenVault ?? null,
    enabled: isSolanaPage && Boolean(solanaCurve?.graduated),
  });
  const transferHolders = useTokenTransferHolders({
    tokenAddress: campaign?.token,
    chainId: chainIdForStorage,
    enabled: !isSolanaPage && Boolean(campaign?.token),
    excludeAddresses: [campaign?.campaign],
  });
  const [marketResolution, setMarketResolution] = useState<MarketResolution>("1m");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [topazSlippageBps, setTopazSlippageBps] = useState(100);
  /** Local Topaz fills so chart/trades update immediately after wallet confirmation. */
  const [localTopazTrades, setLocalTopazTrades] = useState<CurveTradePoint[]>([]);

  // Fetch maker profiles for displayed trades (best-effort; do not block UI).
  // Use a ref so re-renders/tx list churn cannot re-request the same addresses forever
  // (Topaz Swap "sender" is often the router, which previously stormed /api/profile).
  const makerProfileKnownRef = useRef(new Set<string>());

  // Fetch creator profile (best-effort; do not block UI)
  useEffect(() => {
    const creator = String(campaign?.creator ?? "").trim();
    if (!creator) {
      setCreatorProfile(null);
      return;
    }

    const chainIdNum = Number(chainIdForStorage);
    let cancelled = false;

    (async () => {
      try {
        const p = await fetchUserProfile(chainIdNum, creator);
        if (cancelled) return;
        setCreatorProfile(p);
      } catch {
        if (cancelled) return;
        setCreatorProfile(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [campaign?.creator, chainIdForStorage]);

  // CrypticPump listing badge (public)
  useEffect(() => {
    const campaignKey = String(campaign?.campaign ?? campaignAddr ?? "").trim();
    const chainIdNum = Number(chainIdForStorage || 56);
    if (!campaignKey || !Number.isFinite(chainIdNum)) {
      setCrypticPumpListing(null);
      return;
    }
    let cancelled = false;
    void fetchCrypticPumpListing(chainIdNum, campaignKey).then((listing) => {
      if (!cancelled) setCrypticPumpListing(listing);
    });
    return () => {
      cancelled = true;
    };
  }, [campaign?.campaign, campaignAddr, chainIdForStorage]);

  // Load campaign + metrics based on :campaignAddress (preferred).
  // Backward-compatible fallback: if param is not a 0x address, treat it as symbol.
  useEffect(() => {
    const load = async () => {
      if (!campaignAddress) return;

      try {
        setLoading(true);
        setError(null);

        const param = campaignAddress.trim();
        const isEvmAddress = /^0x[a-fA-F0-9]{40}$/.test(param);
        const isSolanaAddressParam =
          !isEvmAddress &&
          param.length >= 32 &&
          param.length <= 44 &&
          /^[1-9A-HJ-NP-Za-km-z]+$/.test(param);
        // Damaged base58 (e.g. .toLowerCase() turned L→l) must still take Solana path.
        const isDamagedSolanaParam =
          !isEvmAddress &&
          !isSolanaAddressParam &&
          param.length >= 32 &&
          param.length <= 48 &&
          /^[0-9A-Za-z]+$/.test(param);

        // ── Fast path for /token/0x… ─────────────────────────────────────────
        // Avoid: full campaign feed, lifecycle×500, dual-chain resolve before paint,
        // and sequential hydrate steps. Paint as soon as contract metadata is ready.
        let loadChainId: SupportedChainId = pageChainId;
        let resolvedCampaignFromIndexer = "";
        let match: CampaignInfo | null = null;

        // ── Solana base58 mint / campaign PDA (incl. case-damaged URLs) ──────
        // No EVM contract reads. Resolve from campaigns registry or draft link.
        if (isSolanaAddressParam || isDamagedSolanaParam) {
          loadChainId = SOLANA_CHAIN_ID;
          if (pageChainId !== SOLANA_CHAIN_ID) {
            pinTokenDetailsChainId(SOLANA_CHAIN_ID);
            setPageChainId(SOLANA_CHAIN_ID);
          }

          // Paint immediately from the URL. Indexer /trades and /candles resolve mint vs PDA.
          // Waiting on the 500-row campaign feed (or a chain fallback) was a 2s+ blank chart.
          setCampaign((prev) =>
            prev ||
            ({
              id: 0,
              campaign: param,
              token: param,
              creator: "",
              name: "Solana campaign",
              symbol: "",
              logoURI: "/placeholder.svg",
              metadataURI: undefined,
              xAccount: "",
              website: "",
              extraLink: "",
            } as CampaignInfo),
          );
          setOnChainLaunched(false);
          setOnChainPair("");
          setMetrics({
            sold: 0n,
            curveSupply: 0n,
            liquiditySupply: 0n,
            creatorReserve: 0n,
            basePrice: 0n,
            priceSlope: 0n,
            graduationTarget: 0n,
            graduationNativeTarget: 0n,
            liquidityBps: 0n,
            protocolFeeBps: 0n,
            currentPrice: 0n,
            launched: false,
            finalizedAt: 0n,
          } as CampaignMetrics);
          setLoading(false);

          const res = await apiFetch(
            `/api/campaigns?chainId=${SOLANA_CHAIN_ID}&limit=500&tab=trending&sort=default&status=all`,
            { cache: "no-store" },
          );
          const json = await res.json().catch(() => ({}));
          const items = Array.isArray(json?.items) ? json.items : [];
          // Case-insensitive match: home grid previously lowercased Solana addrs in the URL.
          // NEVER keep the lowercased form in state — always prefer registry casing.
          const paramLower = param.toLowerCase();
          const hit = items.find((item: any) => {
            const c = String(item?.campaignAddress || item?.campaign || "").trim();
            const t = String(item?.tokenAddress || item?.token || "").trim();
            return (
              c === param ||
              t === param ||
              c.toLowerCase() === paramLower ||
              t.toLowerCase() === paramLower
            );
          });

          if (hit) {
            const canonicalCampaign = String(hit.campaignAddress || hit.campaign || param);
            const canonicalToken = String(hit.tokenAddress || hit.token || param);
            match = {
              id: 0,
              campaign: canonicalCampaign,
              token: canonicalToken,
              creator: String(hit.creatorAddress || hit.creator || ""),
              name: String(hit.name || "Solana campaign"),
              symbol: String(hit.symbol || ""),
              logoURI: String(hit.logoUri || hit.logoURI || hit.logo_url || "/placeholder.svg"),
              metadataURI: undefined,
              xAccount: String(hit.xAccount || ""),
              website: String(hit.website || ""),
              extraLink: String(hit.extraLink || ""),
              createdAt: hit.createdAtChain
                ? Math.floor(new Date(hit.createdAtChain).getTime() / 1000)
                : undefined,
              tokenVault: hit.tokenVault ? String(hit.tokenVault) : null,
              solVault: hit.solVault ? String(hit.solVault) : null,
              campaignIdHex: hit.campaignIdHex ? String(hit.campaignIdHex) : null,
            } as CampaignInfo;
            resolvedCampaignFromIndexer = match.campaign;
            // Canonical public identity is the SPL mint. The campaign PDA is resolved
            // from the registry and must not leak into the public TokenDetails URL.
            const preferred = canonicalToken || canonicalCampaign;
            const desired = `/token/${encodeURIComponent(preferred)}`;
            const current = `${location.pathname}${location.search || ""}`;
            if (preferred && current !== desired) {
              navigate(desired, { replace: true });
            }
          } else {
            // Mint-only URL (82-byte SPL) with no registry row yet — shell until mark-deploy upserts.
            const mintHint = new URLSearchParams(location.search || "").get("mint") || param;
            match = {
              id: 0,
              // Do not treat mint as campaign PDA — curve decode needs the real campaign account.
              campaign: param,
              token: mintHint,
              creator: "",
              name: "Solana campaign",
              symbol: "",
              logoURI: "/placeholder.svg",
              metadataURI: undefined,
              xAccount: "",
              website: "",
              extraLink: "",
            } as CampaignInfo;
            resolvedCampaignFromIndexer = param;
            console.warn(
              "[TokenDetails] Solana address not in /api/campaigns yet (registry lag or Direct mark-deploy failed).",
              param,
            );
          }

          setCampaign(match);
          setError(null);
          setOnChainLaunched(false);
          setOnChainPair("");
          // Solana bonding is still P1. launched/finalized MUST stay false —
          // TokenDetails treats metrics.launched === true as "graduated / Topaz".
          setMetrics({
            sold: 0n,
            curveSupply: 0n,
            liquiditySupply: 0n,
            creatorReserve: 0n,
            basePrice: 0n,
            priceSlope: 0n,
            graduationTarget: 0n,
            graduationNativeTarget: 0n,
            liquidityBps: 0n,
            protocolFeeBps: 0n,
            currentPrice: 0n,
            launched: false,
            finalizedAt: 0n,
          } as CampaignMetrics);
          setLoading(false);
          return;
        }

        if (isEvmAddress) {
          pinTokenDetailsChainId(loadChainId);
          const loadProvider = getReadProvider(loadChainId);

          // Parallel: prefer page chain resolve + treat param as campaign contract.
          const [pageIdentity, directAsCampaign] = await Promise.all([
            resolveMarketIdentity({ address: param, chainId: loadChainId }).catch(() => null),
            buildCampaignFromAddress(param, loadProvider, loadChainId).catch(() => null),
          ]);

          if (pageIdentity?.campaignAddress && !pageIdentity.provisional) {
            resolvedCampaignFromIndexer = pageIdentity.campaignAddress;
            match =
              directAsCampaign &&
              String(directAsCampaign.campaign).toLowerCase() === pageIdentity.campaignAddress.toLowerCase()
                ? directAsCampaign
                : await buildCampaignFromAddress(pageIdentity.campaignAddress, loadProvider, loadChainId);
            if (match && pageIdentity.tokenAddress) {
              match = { ...match, token: pageIdentity.tokenAddress };
            }
          } else if (directAsCampaign) {
            match = directAsCampaign;
          } else {
            // Token URL on another EVM chain (rare) — only then scan 56.
            try {
              const identity = await resolveMarketIdentityAcrossEvm({ address: param });
              if (identity?.campaignAddress) {
                const nextChain = identity.chainId as SupportedChainId;
                resolvedCampaignFromIndexer = identity.campaignAddress;
                pinTokenDetailsChainId(nextChain);
                if (nextChain !== pageChainId) {
                  setPageChainId(nextChain);
                  setLoading(false);
                  return;
                }
                loadChainId = nextChain;
                match = await buildCampaignFromAddress(
                  identity.campaignAddress,
                  getReadProvider(loadChainId),
                  loadChainId,
                );
              }
            } catch (resolveErr) {
              console.warn("[TokenDetails] cross-chain resolve failed; using page chain", resolveErr);
            }
          }

          // Last resort: small factory inventory (only when campaign not direct-readable).
          if (!match) {
            try {
              const page = await fetchOnChainCampaignPage(loadChainId, { limit: 24 });
              const needle = param.toLowerCase();
              const row = page.campaigns.find((c) => {
                const campaign = String(c.campaign || "").toLowerCase();
                const token = String(c.token || "").toLowerCase();
                return campaign === needle || token === needle;
              });
              if (row?.campaign) {
                match =
                  (await buildCampaignFromAddress(String(row.campaign), getReadProvider(loadChainId), loadChainId)) ||
                  ({
                    id: 0,
                    campaign: String(row.campaign).toLowerCase(),
                    token: String(row.token || "").toLowerCase(),
                    creator: String(row.creator || "").toLowerCase(),
                    name: String(row.name || "Unknown"),
                    symbol: String(row.symbol || ""),
                    logoURI: resolveImageUri(row.logoURI) || "/placeholder.svg",
                    metadataURI: undefined,
                    xAccount: String(row.xAccount || ""),
                    website: String(row.website || ""),
                    extraLink: String(row.extraLink || ""),
                    createdAt: row.createdAt,
                  } as CampaignInfo);
              }
            } catch (onChainErr) {
              console.warn("[TokenDetails] on-chain inventory resolve failed", onChainErr);
            }
          }
        } else {
          // Symbol path (legacy): still need a list.
          const campaigns = await fetchCampaigns().catch((campaignError) => {
            console.warn("[TokenDetails] campaign feed failed; trying direct campaign load", campaignError);
            return [] as CampaignInfo[];
          });
          match = campaigns.find((c) => (c.symbol ?? "").toLowerCase() === param.toLowerCase()) || null;
          if (!match) {
            setError(campaigns.length === 0 ? "No token data" : "Token not found");
            setCampaign(null);
            setMetrics(null);
            setSummary(null);
            return;
          }
        }

        if (!match) {
          setError("Token not found");
          setCampaign(null);
          setMetrics(null);
          setSummary(null);
          return;
        }

        // Paint shell immediately so chart/trade hooks can start while extras hydrate.
        setCampaign(match);
        setLoading(false);

        let displayMatch = match;
        const loadProvider = getReadProvider(loadChainId);

        // Metrics + cosmetic hydrates in parallel (do not serialize RPC).
        const [summaryResult, withCreator, withMeta, withCreated, displayImage] = await Promise.all([
          fetchCampaignSummary(match)
            .then((s) => ({ ok: true as const, s }))
            .catch(async (summaryErr) => {
              console.warn("[TokenDetails] summary fetch failed; trying direct metrics", summaryErr);
              try {
                const directMetrics = await fetchCampaignMetrics(match.campaign);
                return {
                  ok: false as const,
                  s: {
                    campaign: match,
                    metrics: directMetrics,
                    stats: { holders: "—", volume: "—", marketCap: "—" },
                  } as CampaignSummary,
                };
              } catch (metricsErr) {
                console.warn("[TokenDetails] direct metrics also failed", metricsErr);
                return {
                  ok: false as const,
                  s: {
                    campaign: match,
                    metrics: null,
                    stats: { holders: "—", volume: "—", marketCap: "—" },
                  } as CampaignSummary,
                };
              }
            }),
          hydrateCampaignCreatorFromContract(displayMatch, loadProvider),
          hydrateCampaignMetadata(displayMatch, loadChainId),
          hydrateCampaignCreatedAtFromFactory(displayMatch, loadChainId),
          resolveCampaignDisplayImage(displayMatch, loadChainId, fetchCampaignLogoURI).catch(() => null),
        ]);

        displayMatch = {
          ...displayMatch,
          ...withCreator,
          ...withMeta,
          ...withCreated,
        };
        if (hasUsefulImage(displayImage)) {
          displayMatch = { ...displayMatch, logoURI: String(displayImage) };
        }
        if (ethers.isAddress(resolvedCampaignFromIndexer)) {
          displayMatch = { ...displayMatch, campaign: resolvedCampaignFromIndexer.toLowerCase() };
        }
        setCampaign(displayMatch);
        setSummary({ ...summaryResult.s, campaign: displayMatch });
        setMetrics(summaryResult.s.metrics ?? null);

        const canonicalTokenAddress = String(displayMatch.token ?? "").trim().toLowerCase();
        if (isEvmAddress && ethers.isAddress(canonicalTokenAddress) && param.toLowerCase() !== canonicalTokenAddress) {
          navigate(`/token/${canonicalTokenAddress}${location.search || ""}`, { replace: true });
        }
      } catch (err) {
        console.error(err);
        setError("Failed to load token data");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [campaignAddress, pageChainId, fetchCampaignLogoURI, fetchCampaigns, fetchCampaignSummary, location.search, navigate]);

  const formatPriceFromWei = (wei?: bigint | null): string => {
    if (wei == null) return "—";
    try {
      // Solana uses 9-dec lamports; EVM bonding uses 18-dec wei. Prefer unit label over fake precision on Solana shell.
      if (isSolanaPage) {
        if (wei === 0n) return `0 ${nativeUnit}`;
        const raw = ethers.formatUnits(wei, 9);
        const n = Number(raw);
        if (!Number.isFinite(n)) return `${raw} ${nativeUnit}`;
        if (n >= 1) return `${n.toFixed(4)} ${nativeUnit}`;
        if (n >= 0.01) return `${n.toFixed(6)} ${nativeUnit}`;
        const pretty = raw.replace(/0+$/, "").replace(/\.$/, "");
        return `${pretty || "0"} ${nativeUnit}`;
      }
      if (wei === 0n) return `0 ${nativeUnit}`;
      const raw = ethers.formatUnits(wei, 18);
      const n = Number(raw);
      if (!Number.isFinite(n)) return `${raw} ${nativeUnit}`;
      // Bonding spot prices are often far below 1e-6 native — keep significant digits.
      if (n >= 1) return `${n.toFixed(2)} ${nativeUnit}`;
      if (n >= 0.01) return `${n.toFixed(6)} ${nativeUnit}`;
      if (n >= 1e-6) return `${n.toFixed(8)} ${nativeUnit}`;
      if (n > 0 && n < 1e-12) return `<0.000000000001 ${nativeUnit}`;
      const fraction = raw.split(".")[1] || "";
      const firstNonZero = fraction.search(/[1-9]/);
      const decimals = Math.min(18, Math.max(8, (firstNonZero >= 0 ? firstNonZero : 7) + 4));
      const pretty = n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
      return `${pretty} ${nativeUnit}`;
    } catch {
      return "—";
    }
  };

  const formatBnbFromWei = (wei?: bigint | null): string => {
    if (wei == null) return "—";
    try {
      if (isSolanaPage) {
        if (wei === 0n) return `0 ${nativeUnit}`;
        const raw = ethers.formatUnits(wei, 9);
        const n = Number(raw);
        if (!Number.isFinite(n)) return `${raw} ${nativeUnit}`;
        if (n > 0 && n < 1e-9) return `<0.000000001 ${nativeUnit}`;
        if (n >= 1) return `${n.toFixed(4)} ${nativeUnit}`;
        if (n >= 0.01) return `${n.toFixed(6)} ${nativeUnit}`;
        const pretty = raw.replace(/0+$/, "").replace(/\.$/, "");
        return `${pretty || "0"} ${nativeUnit}`;
      }
      if (wei === 0n) return `0 ${nativeUnit}`;
      const raw = ethers.formatEther(wei);
      const n = Number(raw);
      if (!Number.isFinite(n)) return `${raw} ${nativeUnit}`;
      if (n > 0 && n < 1e-12) return `<0.000000000001 ${nativeUnit}`;
      if (n >= 1) return `${n.toFixed(2)} ${nativeUnit}`;
      if (n >= 0.01) return `${n.toFixed(4)} ${nativeUnit}`;

      const fraction = raw.split(".")[1] || "";
      const firstNonZero = fraction.search(/[1-9]/);
      const decimals = Math.min(12, Math.max(6, (firstNonZero >= 0 ? firstNonZero : 5) + 4));
      const pretty = n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
      return `${pretty} ${nativeUnit}`;
    } catch {
      return "—";
    }
  };

  const formatTokenFromWei = (wei?: bigint | null): string => {
    if (wei == null) return "—";
    try {
      const raw = ethers.formatUnits(wei, tokenDecimals);
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw;
      // Keep significant digits for micro meme amounts without trailing zero noise.
      let pretty: string;
      if (n >= 1) pretty = n.toFixed(4);
      else if (n >= 0.01) pretty = n.toFixed(6);
      else if (n >= 1e-6) pretty = n.toFixed(8);
      else if (n > 0) pretty = n.toPrecision(4);
      else pretty = "0";
      return pretty.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
    } catch {
      return "—";
    }
  };
  const parseBnbLabel = (input?: string | null): number | null => {
    if (!input) return null;
    const s = String(input).trim();
    if (!s || s === "—") return null;

    // Accept forms like:
    //  - "0.1234 BNB"
    //  - "1.23k BNB"
    //  - "1.23k"
    //  - "0.000123"
    
    // IMPORTANT: avoid treating the leading "B" in "BNB" as a suffix.

    const token = s.split(/\s+/)[0] ?? "";

    const m = token.match(/^(-?\d+(?:\.\d+)?)([kKmMbBtT])?$/);
    if (!m) return null;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) return null;

    const suf = (m[2] ?? "").toLowerCase();
    const mult = suf === "k" ? 1e3 : suf === "m" ? 1e6 : suf === "b" ? 1e9 : suf === "t" ? 1e12 : 1;
    return num * mult;
  };

  const formatCompactUsd = (usd: number): string => {
    if (!Number.isFinite(usd)) return "—";
    const abs = Math.abs(usd);

    const fmt = (v: number, suffix: string) => {
      const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
      return `$${v.toFixed(decimals)}${suffix}`;
    };

    if (abs >= 1e12) return fmt(usd / 1e12, "T");
    if (abs >= 1e9) return fmt(usd / 1e9, "B");
    if (abs >= 1e6) return fmt(usd / 1e6, "M");
    if (abs >= 1e3) return fmt(usd / 1e3, "K");

    // Small values: show up to 2 decimals
    const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return `$${usd.toFixed(decimals)}`;
  };



  const parseTokenAmountWei = (value: string): bigint => {
    const v = (value ?? "").trim();
    if (!v || v === "." || v === "-") return 0n;
    // Only allow digits + a single decimal separator
    const cleaned = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    const normalized = parts.length <= 2 ? cleaned : parts[0] + "." + parts.slice(1).join("");
    try {
      return ethers.parseUnits(normalized || "0", TOKEN_DECIMALS);
    } catch {
      return 0n;
    }
  };


  const parseBnbAmountWei = (value: string): bigint => {
    const v = (value ?? "").trim();
    if (!v || v === "." || v === "-") return 0n;
    const cleaned = v.replace(/,/g, ".").replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    const normalized = parts.length <= 2 ? cleaned : parts[0] + "." + parts.slice(1).join("");
    try {
      return ethers.parseEther(normalized || "0");
    } catch {
      return 0n;
    }
  };

  const formatPriceBnb = (p?: number | null): string => {
    if (p == null || !Number.isFinite(p) || p < 0) return "—";
    if (p === 0) return `0 ${nativeUnit}`;
    if (isSolanaPage && p > 0 && p < 0.01) {
      const pretty = p.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
      return `${pretty || "0"} ${nativeUnit}`;
    }
    if (p >= 1) return `${p.toFixed(2)} ${nativeUnit}`;
    if (p >= 0.01) return `${p.toFixed(6)} ${nativeUnit}`;
    if (p >= 1e-6) return `${p.toFixed(8)} ${nativeUnit}`;
    if (p > 0 && p < 1e-12) return `<0.000000000001 ${nativeUnit}`;
    // Preserve scientific-scale micro prices without truncating to zero.
    return `${p.toPrecision(4)} ${nativeUnit}`;
  };

  // Format a native amount (BNB or SOL) consistently across the UI.
  const formatBnb = (n?: number | null): string => {
    if (n == null || !Number.isFinite(n)) return "—";
    const pretty = n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
    return `${pretty} ${nativeUnit}`;
  };

  const shorten = (addr?: string): string => {
    if (!addr) return "—";
    return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
  };

  const formatCompact = (n: number): string => {
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
    if (abs >= 1) return n.toFixed(2);
    if (abs >= 0.01) return n.toFixed(4);
    if (abs >= 0.0001) return n.toFixed(6);
    return n.toFixed(8);
  };

  const formatAgo = (timestampSecs?: number): string => {
    if (!timestampSecs) return "";
    const now = Math.floor(Date.now() / 1000);
    const diff = Math.max(0, now - timestampSecs);
    if (diff < 60) return "now";
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const weeks = Math.floor(days / 7);
    return `${weeks}w`;
  };

  // Read curve trades for transactions + analytics (BNB + Solana).
  const resolvedCampaignAddress = useMemo(() => {
    const raw = String(campaign?.campaign || campaignAddr || "").trim();
    if (isSolanaPage) {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) ? raw : "";
    }
    const value = raw.toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(value) ? value : "";
  }, [campaign?.campaign, campaignAddr, isSolanaPage]);

  const hasValidCampaignAddress = Boolean(resolvedCampaignAddress);
  const localTradeStorageAddress = useMemo(
    () =>
      isSolanaPage
        ? String(campaign?.campaign || campaignAddr || "").trim()
        : resolvedCampaignAddress,
    [campaign?.campaign, campaignAddr, isSolanaPage, resolvedCampaignAddress],
  );

  const { points: liveCurvePoints, loading: liveCurveLoading, error: liveCurveError } = useCurveTrades(
    hasValidCampaignAddress ? resolvedCampaignAddress : undefined,
    {
      chainId: chainIdForStorage,
      enabled: hasValidCampaignAddress,
      tokenAddress: String(campaign?.token || campaignAddress || "").trim() || undefined,
    },
  );
  const liveCurvePointsSafe = useMemo<CurveTradePoint[]>(
    () => (Array.isArray(liveCurvePoints) ? liveCurvePoints : []),
    [liveCurvePoints],
  );
  const combinedCurvePointsSafe = useMemo<CurveTradePoint[]>(
    () => mergeCurveTradePoints(liveCurvePointsSafe, confirmedCurvePoints),
    [confirmedCurvePoints, liveCurvePointsSafe],
  );

  useEffect(() => {
    setConfirmedCurvePoints([]);
  }, [resolvedCampaignAddress]);

  useEffect(() => {
    if (!hasValidCampaignAddress) return;
    const onConfirmed = (event: Event) => {
      const detail = (event as CustomEvent)?.detail || {};
      const kind = String(detail?.kind || "").toLowerCase();
      const confirmedRaw = String(detail?.campaignAddress || "").trim();
      const confirmedCampaign = isSolanaPage ? confirmedRaw : confirmedRaw.toLowerCase();
      const tokenKey = isSolanaPage
        ? String(campaign?.token || campaignAddress || "").trim()
        : String(campaign?.token || campaignAddress || "").trim().toLowerCase();
      const sameMarket =
        confirmedCampaign === resolvedCampaignAddress ||
        (tokenKey && confirmedCampaign === tokenKey);
      if ((kind !== "buy" && kind !== "sell") || !sameMarket) return;

      const points = confirmedRowsToCurvePoints(
        detail?.trades || [],
        resolvedCampaignAddress,
        chainIdForStorage,
        tokenDecimals,
      );
      if (!points.length) return;

      setConfirmedCurvePoints((prev) => mergeCurveTradePoints(prev, points));
      setActivity((prev) => {
        let buyers = prev?.buyers ?? 0;
        let sellers = prev?.sellers ?? 0;
        let buyVolumeWei = prev?.buyVolumeWei ?? 0n;
        let sellVolumeWei = prev?.sellVolumeWei ?? 0n;
        const buyerSet = new Set<string>();
        const sellerSet = new Set<string>();

        for (const point of points) {
          if (point.type === "sell") {
            if (point.from) sellerSet.add(point.from);
            sellVolumeWei += point.nativeWei;
          } else {
            if (point.from) buyerSet.add(point.from);
            buyVolumeWei += point.nativeWei;
          }
        }

        buyers += buyerSet.size;
        sellers += sellerSet.size;
        return {
          buyers,
          sellers,
          buyVolumeWei,
          sellVolumeWei,
          fromBlock: prev?.fromBlock ?? points[0]?.blockNumber ?? 0,
          toBlock: Math.max(prev?.toBlock ?? 0, ...points.map((point) => point.blockNumber || 0)),
        };
      });
    };

    window.addEventListener("memewarzone:txConfirmed", onConfirmed as EventListener);
    return () => window.removeEventListener("memewarzone:txConfirmed", onConfirmed as EventListener);
  }, [hasValidCampaignAddress, resolvedCampaignAddress, isSolanaPage, chainIdForStorage, tokenDecimals, campaign?.token, campaignAddress]);

  const curvePointsForUi: CurveTradePoint[] = combinedCurvePointsSafe;

  // Restore/persist local Topaz fills + server-reported Topaz trades (wallet receipts).
  useEffect(() => {
    if (!localTradeStorageAddress) {
      setLocalTopazTrades([]);
      return;
    }
    setLocalTopazTrades([]);

    let cancelled = false;
    void (async () => {
      if (isSolanaPage) return;
      try {
        const remote = await fetchTopazTradeReports({
          chainId: chainIdForStorage,
          campaignAddress: localTradeStorageAddress,
          limit: 100,
        });
        if (cancelled || !remote.length) return;
        setLocalTopazTrades((prev) => mergeTradePoints(prev, remote));
      } catch {
        // Server reports are optional until Railway frontend has the route + DB.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [localTradeStorageAddress, chainIdForStorage, isSolanaPage]);

  const unifiedMarket = useUnifiedMarket({
    campaignAddress: hasValidCampaignAddress ? resolvedCampaignAddress : undefined,
    chainId: chainIdForStorage,
    resolution: marketResolution,
    enabled: hasValidCampaignAddress,
  });

  // On-chain launched() — independent of metrics/CMS so WIC-class graduated tokens
  // still open Topaz even when market-state is stuck on BONDING.
  // Solana has no EVM LaunchCampaign — never call Contract reads on base58 addresses.
  const [onChainLaunched, setOnChainLaunched] = useState(false);
  const [onChainPair, setOnChainPair] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    const addr = resolvedCampaignAddress;
    if (!hasValidCampaignAddress || !addr || isSolanaPage) {
      setOnChainLaunched(false);
      setOnChainPair("");
      return;
    }
    void (async () => {
      try {
        const provider = getReadProvider(chainIdForStorage as SupportedChainId);
        const c = new Contract(addr, CAMPAIGN_ABI, provider) as any;
        const [launched, graduation] = await Promise.all([
          c.launched().catch(() => false),
          c.getGraduationState().catch(() => null),
        ]);
        if (cancelled) return;
        const pair = String(graduation?.[0] ?? graduation?.dexPair ?? "").toLowerCase();
        setOnChainLaunched(Boolean(launched) || (ethers.isAddress(pair) && pair !== ethers.ZeroAddress.toLowerCase()));
        setOnChainPair(ethers.isAddress(pair) ? pair : "");
      } catch {
        if (!cancelled) {
          setOnChainLaunched(false);
          setOnChainPair("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasValidCampaignAddress, resolvedCampaignAddress, chainIdForStorage, isSolanaPage]);

  // Early graduation flag so Topaz market data can load before the full stage UI block.
  // Solana P1 shell is always bonding — never treat as graduated.
  const contractGraduatedEarly = useMemo(() => {
    if (isSolanaPage) return Boolean(solanaCurve?.graduated);
    if (onChainLaunched) return true;
    const hasLaunchFlag = (metrics as any)?.launched !== undefined || (metrics as any)?.finalizedAt !== undefined;
    return hasLaunchFlag
      ? Boolean((metrics as any)?.launched) ||
          (typeof (metrics as any)?.finalizedAt === "bigint"
            ? (metrics as any).finalizedAt > 0n
            : Number((metrics as any)?.finalizedAt ?? 0) > 0)
      : Boolean(metrics && metrics.curveSupply > 0n && metrics.sold >= metrics.curveSupply);
  }, [metrics, onChainLaunched, isSolanaPage, solanaCurve?.graduated]);

  // Topaz pair scan only after graduation. Running it on pure bonding campaigns
  // can resolve a wrong/empty route and poison price/mcap/chart streams.
  const topazMarket = useTopazMarket({
    campaignAddress: hasValidCampaignAddress && !isSolanaPage ? resolvedCampaignAddress : undefined,
    tokenAddress: campaign?.token,
    chainId: chainIdForStorage,
    enabled: hasValidCampaignAddress && contractGraduatedEarly && !isSolanaPage,
    pollMs: 8_000,
  });

  // Maker profiles after topazMarket exists so we can skip protocol/router senders.
  useEffect(() => {
    const chainIdNum = Number(chainIdForStorage ?? 56);
    if (!txs.length) return;

    const protocolSkip = new Set(
      [
        campaign?.campaign,
        campaign?.token,
        topazMarket.routerAddress,
        topazMarket.pairAddress,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000001",
        // Known Topaz production router / adapter / route authority on testnet.
        "0xe559d93643631e9e8cc7d10adfa581be4b5399c8",
        "0xc49895ee36ad19aa5cb1405761f6272ad7be6357",
        "0xb989a99823ea96552c3e3198a40cdbf682edf1aa",
      ]
        .map((value) => normalizeProfileAddressKey(value, chainIdNum))
        .filter(Boolean),
    );

    const uniq = Array.from(
      new Set(
        txs
          .map((t) => normalizeProfileAddressKey(t.makerAddress, chainIdNum))
          .filter((addr) => addr && !protocolSkip.has(addr) && !makerProfileKnownRef.current.has(addr)),
      ),
    ).slice(0, 6);

    if (!uniq.length) return;

    let cancelled = false;
    (async () => {
      for (const addr of uniq) {
        if (cancelled) return;
        makerProfileKnownRef.current.add(addr);
        try {
          const p = await fetchUserProfile(chainIdNum, addr);
          if (cancelled) return;
          setMakerProfiles((prev) => ({ ...prev, [addr]: p }));
        } catch {
          if (cancelled) return;
          setMakerProfiles((prev) => ({ ...prev, [addr]: null }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    txs,
    chainIdForStorage,
    campaign?.campaign,
    campaign?.token,
    topazMarket.routerAddress,
    topazMarket.pairAddress,
  ]);

  // Continuous market trade stream.
  // Bonding: curve trades (+ confirmed fills) only — do not mix Topaz/unified DEX rows
  // or circulating mcap / price change tiles go wildly wrong.
  // Graduated: bonding history + Topaz scan + wallet reports + unified market API.
  const marketTradePoints: CurveTradePoint[] = useMemo(() => {
    // Always keep bonding curve history (including after graduation).
    // Include localTopazTrades on bonding too — Solana fills land here until indexer events exist.
    const unifiedAsPoints: CurveTradePoint[] = (unifiedMarket.trades || [])
      .map((trade) => marketTradeToCurvePoint(trade, chainIdForStorage))
      .filter((point): point is CurveTradePoint => Boolean(point));
    const bonding = mergeTradePoints(curvePointsForUi, confirmedCurvePoints, localTopazTrades);
    if (!contractGraduatedEarly) {
      // Only seed a synthetic Solana anchor when no real prints exist yet.
      if (
        isSolanaPage &&
        bonding.length === 0 &&
        unifiedAsPoints.length === 0 &&
        solanaCurve &&
        solanaCurve.soldTokens > 0n &&
        solanaCurve.netRaisedLamports > 0n
      ) {
        const dec = Number(solanaCurve.tokenDecimals || 6);
        const tokens = Number(ethers.formatUnits(solanaCurve.soldTokens, dec));
        const sol = Number(ethers.formatUnits(solanaCurve.netRaisedLamports, 9));
        const marginal = solanaMarginalSpotSol(solanaCurve, solanaCurve.soldTokens);
        const price = marginal > 0 ? marginal : tokens > 0 ? sol / tokens : 0;
        return [
          {
            type: "buy" as const,
            from: solanaCurve.creator || "11111111111111111111111111111111",
            to: solanaCurve.mint || "",
            tokensWei: solanaCurve.soldTokens,
            nativeWei: solanaCurve.netRaisedLamports,
            pricePerToken: Number.isFinite(price) ? price : 0,
            soldTokensAfterRaw: solanaCurve.soldTokens,
            venue: "curve" as const,
            timestamp: Math.floor(Date.now() / 1000) - 600,
            txHash: `solana-seed-${solanaCurve.campaignAddress.slice(0, 16)}`,
            blockNumber: 1,
            logIndex: SYNTHETIC_LOG_INDEX_MIN + 2,
          },
        ];
      }
      if (isSolanaPage && solanaCurve?.graduated && bonding.length) {
        const lastCurveTs = bonding.reduce((max, point) => {
          if (point.soldTokensAfterRaw == null) return max;
          if (String(point.txHash || "").startsWith("solana-seed-")) return max;
          const ts = Number(point.timestamp || 0);
          return ts > max ? ts : max;
        }, 0);
        return bonding.map((point) => {
          if (point.venue === "dex" || point.venue === "curve") return point;
          if (point.soldTokensAfterRaw != null) return { ...point, venue: "curve" as const };
          if (!lastCurveTs || Number(point.timestamp || 0) > lastCurveTs) {
            return { ...point, venue: "dex" as const };
          }
          return point;
        });
      }
      return bonding;
    }
    const merged = mergeTradePoints(
      bonding,
      isSolanaPage ? [] : topazMarket.trades,
      localTopazTrades,
      unifiedAsPoints,
    );
    // Never invent a fake EVM fill with Date.now()-3600. That polluted
    // holders, the trade tab, and 1m candles when the real book was empty.
    if (merged.length === 0 && metrics?.sold != null && metrics.sold > 0n && metrics.currentPrice != null && metrics.currentPrice > 0n && isSolanaPage) {
      const price = Number(ethers.formatUnits(metrics.currentPrice, isSolanaPage ? 9 : 18));
      const tokens = Number(ethers.formatUnits(metrics.sold, 18));
      let nativeWei = 0n;
      try {
        // Prefer activity counters when present.
        if (activity?.buyVolumeWei != null && activity.buyVolumeWei > 0n) {
          nativeWei = activity.buyVolumeWei;
        } else {
          // Approximate notional = price * sold (WAD).
          nativeWei = (metrics.currentPrice * metrics.sold) / 10n ** 18n;
        }
      } catch {
        nativeWei = 0n;
      }
      if (price > 0 && tokens > 0) {
        return [
          {
            type: "buy" as const,
            from: "0x0000000000000000000000000000000000000001",
            to: resolvedCampaignAddress || "",
            tokensWei: metrics.sold,
            nativeWei: nativeWei > 0n ? nativeWei : 1n,
            pricePerToken: price,
            timestamp: Math.floor(Date.now() / 1000) - 3600,
            // Valid hex so mergeTradePoints keeps it; synthetic logIndex = not a chain log.
            txHash: `0x${"ab".repeat(32)}`,
            blockNumber: 1,
            logIndex: SYNTHETIC_LOG_INDEX_MIN + 1,
          },
        ];
      }
    }
    return merged;
  }, [
    activity?.buyVolumeWei,
    confirmedCurvePoints,
    contractGraduatedEarly,
    curvePointsForUi,
    isSolanaPage,
    metrics?.currentPrice,
    metrics?.sold,
    resolvedCampaignAddress,
    solanaCurve,
    topazMarket.trades,
    localTopazTrades,
    unifiedMarket.trades,
    chainIdForStorage,
  ]);

  const solanaSpotNative = useMemo(() => {
    if (!isSolanaPage || !solanaCurve || solanaCurve.economicsVersion < 2) return null;
    const decimals = Number(solanaCurve.tokenDecimals || 6);
    const tokenScale = 10 ** decimals;
    const soldWhole = Number(solanaCurve.soldTokens) / tokenScale;
    const baseLamports = Number(solanaCurve.basePriceLamports);
    const slopeRaw = Number(solanaCurve.priceSlopeLamports);
    if (![soldWhole, baseLamports, slopeRaw].every(Number.isFinite)) return null;
    const slopeLamports = solanaCurve.economicsVersion >= 3
      ? (slopeRaw * soldWhole) / 1_000_000_000
      : slopeRaw * soldWhole;
    const spotSol = (baseLamports + slopeLamports) / 1_000_000_000;
    return Number.isFinite(spotSol) && spotSol > 0 ? spotSol : null;
  }, [isSolanaPage, solanaCurve]);

  // Realtime stats from Railway (price/marketcap/24h vol), patched via Ably.
const { stats: rtStats } = useTokenStatsRealtime(
  hasValidCampaignAddress ? resolvedCampaignAddress : undefined,
  chainIdForStorage,
  hasValidCampaignAddress,
);

  const latestSoldFromTrades = useMemo(() => {
    const points = Array.isArray(marketTradePoints) ? marketTradePoints : [];
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const sold = points[i]?.soldTokensAfterRaw;
      if (sold != null && sold > 0n) return sold;
    }
    return null;
  }, [marketTradePoints]);

  const lastMarketTradePrice = useMemo(() => {
    const points = Array.isArray(marketTradePoints) ? marketTradePoints : [];
    const preferDex = Boolean(solanaCurve?.graduated);
    const pick = (filterDex: boolean) => {
      for (let i = points.length - 1; i >= 0; i -= 1) {
        if (filterDex && points[i]?.venue !== "dex") continue;
        const price = Number(points[i]?.pricePerToken ?? 0);
        if (Number.isFinite(price) && price > 0) return price;
      }
      return null;
    };
    return (preferDex ? pick(true) : null) ?? pick(false);
  }, [marketTradePoints, solanaCurve?.graduated]);

  const solanaDexPrice = useMemo(() => {
    if (!isSolanaPage || !solanaCurve?.graduated) return null;
    const fromPool = solanaMeteora.spot?.priceSol;
    if (fromPool != null && Number.isFinite(fromPool) && fromPool > 0) return fromPool;
    if (lastMarketTradePrice != null) return lastMarketTradePrice;
    const fromRt = rtStats?.lastPriceBnb;
    if (fromRt != null && Number.isFinite(fromRt) && fromRt > 0) return fromRt;
    return null;
  }, [isSolanaPage, lastMarketTradePrice, rtStats?.lastPriceBnb, solanaCurve?.graduated, solanaMeteora.spot?.priceSol]);

  const solanaLivePrice = solanaDexPrice ?? solanaSpotNative;

  const solanaSoldWhole = useMemo(() => {
    if (!isSolanaPage) return null;
    const sold =
      (solanaCurve?.soldTokens && solanaCurve.soldTokens > 0n
        ? solanaCurve.soldTokens
        : null) ??
      (metrics?.sold && metrics.sold > 0n ? metrics.sold : null) ??
      latestSoldFromTrades ??
      0n;
    if (sold <= 0n) return null;
    const whole = Number(ethers.formatUnits(sold, tokenDecimals));
    return Number.isFinite(whole) && whole > 0 ? whole : null;
  }, [isSolanaPage, latestSoldFromTrades, metrics?.sold, solanaCurve?.soldTokens, tokenDecimals]);

  const pageLivePriceNative = useMemo(() => {
    if (isSolanaPage) return solanaLivePrice;
    if (contractGraduatedEarly && topazMarket.priceBnb != null && Number.isFinite(topazMarket.priceBnb) && topazMarket.priceBnb > 0) {
      return Number(topazMarket.priceBnb);
    }
    if (metrics?.currentPrice != null && metrics.currentPrice > 0n) {
      const n = Number(ethers.formatUnits(metrics.currentPrice, 18));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (rtStats?.lastPriceBnb != null && Number.isFinite(rtStats.lastPriceBnb) && rtStats.lastPriceBnb > 0) {
      return Number(rtStats.lastPriceBnb);
    }
    return null;
  }, [contractGraduatedEarly, isSolanaPage, metrics?.currentPrice, rtStats?.lastPriceBnb, solanaLivePrice, topazMarket.priceBnb]);

  const pageLiveSupplyWhole = useMemo(() => {
    if (isSolanaPage) return solanaSoldWhole;
    const sold = metrics?.sold ?? 0n;
    if (sold <= 0n) return null;
    const whole = Number(ethers.formatUnits(sold, tokenDecimals));
    return Number.isFinite(whole) && whole > 0 ? whole : null;
  }, [isSolanaPage, metrics?.sold, solanaSoldWhole, tokenDecimals]);

  const solanaGraduationMarker = useMemo(() => {
    if (!isSolanaPage || !solanaCurve?.graduated) return null;
    const fromStats = rtStats?.graduatedAt ? Date.parse(rtStats.graduatedAt) : NaN;
    const fromDex = (marketTradePoints || [])
      .filter((point) => point.venue === "dex")
      .map((point) => Number(point.timestamp || 0) * 1000)
      .filter((ms) => Number.isFinite(ms) && ms > 0);
    const ms =
      (Number.isFinite(fromStats) && fromStats > 0 ? fromStats : 0) ||
      (fromDex.length ? Math.min(...fromDex) : 0);
    if (!ms) return null;
    return { time: new Date(ms).toISOString() };
  }, [isSolanaPage, marketTradePoints, rtStats?.graduatedAt, solanaCurve?.graduated]);
const toSeconds = (ts: number): number => {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  // If it looks like milliseconds, convert to seconds.
  return ts > 1e11 ? Math.floor(ts / 1000) : Math.floor(ts);
};
  type TimeframeKey = "5m" | "1h" | "4h" | "24h";
  const timeframeTiles = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const windows: Record<TimeframeKey, number> = {
      "5m": 5 * 60,
      "1h": 60 * 60,
      "4h": 4 * 60 * 60,
      "24h": 24 * 60 * 60,
    };

    const liveSpot =
      (isSolanaPage && solanaLivePrice != null ? solanaLivePrice : undefined) ??
      (contractGraduatedEarly && topazMarket.priceBnb != null ? Number(topazMarket.priceBnb) : undefined) ??
      (rtStats?.lastPriceBnb != null ? Number(rtStats.lastPriceBnb) : undefined) ??
      (metrics?.currentPrice != null && metrics.currentPrice > 0n
        ? Number(ethers.formatUnits(metrics.currentPrice, isSolanaPage ? 9 : 18))
        : undefined);

    const points: Array<{ timestamp: number; pricePerToken: number; nativeWei?: bigint }> =
      marketTradePoints.map((p: any) => ({
        timestamp: Number(p.timestamp ?? 0),
        pricePerToken: typeof p.pricePerToken === "number" ? p.pricePerToken : Number(p.pricePerToken ?? 0),
        nativeWei: p.nativeWei,
      }));

    if (!points.length && liveSpot == null) {
      return {
        "5m": { change: null as number | null, volume: "—" },
        "1h": { change: null as number | null, volume: "—" },
        "4h": { change: null as number | null, volume: "—" },
        "24h": { change: null as number | null, volume: "—" },
      };
    }

    const tsOf = (t: number) => (t > 1e11 ? Math.floor(t / 1000) : t);
    const sorted = [...points]
      .filter((p) => Number.isFinite(p.pricePerToken) && p.pricePerToken > 0)
      .sort((a, b) => tsOf(a.timestamp) - tsOf(b.timestamp));
    const latestTradePrice = sorted[sorted.length - 1]?.pricePerToken;
    // Bonding spot only moves on fills. A stale Railway/headline price must not
    // pin 5m/1h at 0.00% after a sell that already landed in the trade book.
    const end =
      !contractGraduatedEarly && latestTradePrice != null && latestTradePrice > 0
        ? latestTradePrice
        : liveSpot ?? latestTradePrice ?? 0;

    const out: Record<TimeframeKey, { change: number | null; volume: string }> = {
      "5m": { change: null, volume: "—" },
      "1h": { change: null, volume: "—" },
      "4h": { change: null, volume: "—" },
      "24h": { change: null, volume: "—" },
    };

    for (const k of Object.keys(windows) as TimeframeKey[]) {
      const startTs = now - windows[k];
      const before = [...sorted].reverse().find((p) => tsOf(p.timestamp) <= startTs);
      const inWindow = sorted.filter((p) => tsOf(p.timestamp) > startTs);
      const startPrice =
        before?.pricePerToken ??
        (inWindow.length >= 2 ? inWindow[0]?.pricePerToken : undefined);

      const volumeWei = inWindow.reduce((acc, p) => acc + (p.nativeWei ?? 0n), 0n);

      let change: number | null = null;
      if (startPrice != null && startPrice > 0 && end > 0) {
        const pct = ((end - startPrice) / startPrice) * 100;
        if (Number.isFinite(pct)) {
          change = Math.abs(pct) < 0.005 ? 0 : Number(pct.toFixed(2));
        }
      }
      out[k].change = change;
      out[k].volume = volumeWei > 0n ? formatBnbFromWei(volumeWei) : points.length ? formatBnbFromWei(0n) : "—";
    }

    return out;
  }, [contractGraduatedEarly, isSolanaPage, marketTradePoints, metrics, rtStats?.lastPriceBnb, solanaLivePrice, topazMarket.priceBnb]);

  // Token view-model used throughout the page
  const tokenData = useMemo(() => {
    const ticker = campaign?.symbol ?? "";
    const name = campaign?.name ?? "Token";
    const stats = summary?.stats;

    const rtMarketCap = rtStats?.marketcapBnb;
    const rtPrice = rtStats?.lastPriceBnb;
    const topazPrice = contractGraduatedEarly ? topazMarket.priceBnb : null;
    const topazMarketCap = contractGraduatedEarly ? topazMarket.marketCapBnb : null;
    const topazLiquidity = contractGraduatedEarly ? topazMarket.liquidityBnb : null;
    const window24h = timeframeTiles?.["24h"]?.volume;

    // Bonding and graduated Solana share one valuation: live price × curve sold.
    // DEX buys must not grow circulating or the headline drifts from the chart.
    let bondingMcapLabel: string | null = null;
    let solanaDexMcapLabel: string | null = null;
    try {
      if (isSolanaPage && solanaLivePrice != null) {
        const sold =
          (solanaCurve?.soldTokens && solanaCurve.soldTokens > 0n
            ? solanaCurve.soldTokens
            : null) ??
          (metrics?.sold && metrics.sold > 0n ? metrics.sold : null) ??
          latestSoldFromTrades ??
          0n;
        const supplyWhole = Number(ethers.formatUnits(sold, tokenDecimals));
        const mcapNative = supplyWhole * solanaLivePrice;
        const label = Number.isFinite(mcapNative) && mcapNative > 0
          ? `${formatCompact(mcapNative)} ${nativeUnit}`
          : null;
        if (solanaCurve?.graduated) solanaDexMcapLabel = label;
        else bondingMcapLabel = label;
      } else if (!contractGraduatedEarly && metrics?.sold != null && metrics.currentPrice != null) {
        const mcWei = (metrics.currentPrice * metrics.sold) / 10n ** 18n;
        bondingMcapLabel = formatBnbFromWei(mcWei);
      }
    } catch {
      bondingMcapLabel = null;
      solanaDexMcapLabel = null;
    }
    const statsMcap =
      stats?.marketCap && stats.marketCap !== "—" && stats.marketCap !== "-"
        ? stats.marketCap
        : null;
    const onChainHolderCount = solanaMeteora.holders?.totalHolders;
    const tradeHolderCount = (() => {
      const balances = new Map<string, bigint>();
      for (const point of marketTradePoints || []) {
        const addr = String(point.from || "").trim();
        if (!addr) continue;
        const prev = balances.get(addr) ?? 0n;
        const delta = point.tokensWei ?? 0n;
        balances.set(addr, point.type === "sell" ? prev - delta : prev + delta);
      }
      return [...balances.values()].filter((bal) => bal > 0n).length;
    })();
    const transferHolderCount = transferHolders.holders.length;
    const useTransferHolders =
      !isSolanaPage &&
      transferHolderCount > 0 &&
      (transferHolders.complete || transferHolderCount >= tradeHolderCount);
    const buyerCount = Number(solanaCurve?.buyerCount ?? 0);

    return {
      image: resolveImageUri(campaign?.logoURI) || "/placeholder.svg",
      ticker,
      name,
      hasWebsite: Boolean(campaign?.website && campaign.website.length > 0),
      hasTwitter: Boolean(campaign?.xAccount && campaign.xAccount.length > 0),
      hasTelegram: Boolean(campaign?.telegram && campaign.telegram.length > 0),
      hasDiscord: Boolean(campaign?.discord && campaign.discord.length > 0),
      hasOtherLink: Boolean(campaign?.extraLink && campaign.extraLink.length > 0),

      // Graduated Solana: live Meteora spot. Graduated BNB: Topaz. Bonding: on-chain curve.
      marketCap:
        solanaDexMcapLabel
          ? solanaDexMcapLabel
          : topazMarketCap != null && Number.isFinite(topazMarketCap) && topazMarketCap > 0
          ? `${formatCompact(topazMarketCap)} ${nativeUnit}`
          : !contractGraduatedEarly && bondingMcapLabel
            ? bondingMcapLabel
            : statsMcap
              ? statsMcap
              : rtMarketCap != null && Number.isFinite(rtMarketCap)
                ? `${formatCompact(rtMarketCap)} ${nativeUnit}`
                : "—",
      volume: window24h && window24h !== "—" ? window24h : stats?.volume ?? "—",
      holders:
        onChainHolderCount != null && onChainHolderCount > 0
          ? String(onChainHolderCount)
          : useTransferHolders
            ? String(transferHolderCount)
          : tradeHolderCount > 0
            ? String(tradeHolderCount)
            : buyerCount > 0
              ? String(buyerCount)
              : stats?.holders && stats.holders !== "—" && stats.holders !== "-"
                ? stats.holders
                : "—",
      price:
        isSolanaPage && solanaLivePrice != null
          ? formatPriceBnb(solanaLivePrice)
          : topazPrice != null && Number.isFinite(topazPrice) && topazPrice > 0
          ? formatPriceBnb(topazPrice)
          : !contractGraduatedEarly && metrics?.currentPrice != null
            ? formatPriceFromWei(metrics.currentPrice)
            : rtPrice != null && Number.isFinite(rtPrice)
              ? formatPriceBnb(rtPrice)
              : formatPriceFromWei(metrics?.currentPrice ?? null),
      liquidity:
        isSolanaPage && solanaMeteora.spot && solanaMeteora.spot.liquiditySol > 0
          ? `${formatCompact(solanaMeteora.spot.liquiditySol)} ${nativeUnit}`
          : topazLiquidity != null && Number.isFinite(topazLiquidity) && topazLiquidity > 0
          ? `${formatCompact(topazLiquidity)} ${nativeUnit}`
          : formatBnbFromWei(
              curveReserveWei && curveReserveWei > 0n
                ? curveReserveWei
                : isSolanaPage
                  ? marketTradePoints.reduce((net, point) => {
                      return point.type === "sell" ? net - point.nativeWei : net + point.nativeWei;
                    }, 0n)
                  : curveReserveWei,
            ),

      // Timeframe analytics (native volume + price change)
      metrics: timeframeTiles,
    };
  }, [campaign, contractGraduatedEarly, curveReserveWei, isSolanaPage, latestSoldFromTrades, marketTradePoints, metrics, nativeUnit, solanaCurve, solanaLivePrice, solanaMeteora.holders, solanaMeteora.spot, solanaSpotNative, summary, timeframeTiles, tokenDecimals, rtStats, topazMarket.liquidityBnb, topazMarket.marketCapBnb, topazMarket.priceBnb, transferHolders.complete, transferHolders.holders]);
  // Native/USD reference for TokenDetails conversions: BNB on EVM, SOL on Solana.
  const { price: bnbUsdPrice, loading: bnbUsdLoading } = useBnbUsdPrice(!isSolanaPage);
  const { price: liveSolUsdPrice, loading: solUsdLoading } = useSolUsdPrice(isSolanaPage);
  const nativeUsdPrice = isSolanaPage ? liveSolUsdPrice : bnbUsdPrice;
  const nativeUsdLoading = isSolanaPage ? solUsdLoading : bnbUsdLoading;

  const nativeUsd = useMemo(() => {
    if (nativeUsdPrice == null) return null;
    const n = Number(nativeUsdPrice);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (!isSolanaPage && n > 100_000) return n / 1e18;
    return n;
  }, [isSolanaPage, nativeUsdPrice]);

  const liveMarketCapNative = useMemo(() => {
    const fromLabel = parseBnbLabel(tokenData.marketCap);
    if (fromLabel != null && fromLabel > 0) return fromLabel;
    if (rtStats?.marketcapBnb != null && Number.isFinite(rtStats.marketcapBnb) && rtStats.marketcapBnb > 0) {
      return Number(rtStats.marketcapBnb);
    }
    if (pageLivePriceNative != null && pageLiveSupplyWhole != null && pageLiveSupplyWhole > 0) {
      const product = pageLivePriceNative * pageLiveSupplyWhole;
      return Number.isFinite(product) && product > 0 ? product : null;
    }
    return fromLabel;
  }, [pageLivePriceNative, pageLiveSupplyWhole, rtStats?.marketcapBnb, tokenData.marketCap]);

  const marketCapDisplay = useMemo(() => {
    if (displayDenom === "BNB") {
      if (liveMarketCapNative != null && liveMarketCapNative > 0) {
        return `${formatCompact(liveMarketCapNative)} ${nativeUnit}`;
      }
      return tokenData.marketCap;
    }
    if (liveMarketCapNative == null) return "—";
    if (!nativeUsd) return nativeUsdLoading ? "…" : "—";
    const usd = liveMarketCapNative * nativeUsd;
    return Number.isFinite(usd) && usd > 0 ? formatCompactUsd(usd) : "—";
  }, [displayDenom, liveMarketCapNative, nativeUnit, nativeUsd, nativeUsdLoading, tokenData.marketCap]);

  const marketCapUsdLabel = useMemo(() => {
    if (liveMarketCapNative == null || !nativeUsd) return null;
    const usd = liveMarketCapNative * nativeUsd;
    return Number.isFinite(usd) && usd > 0 ? formatCompactUsd(usd) : null;
  }, [liveMarketCapNative, nativeUsd]);

  const priceDisplay = useMemo(() => {
    const fromSolanaSpot = isSolanaPage ? solanaLivePrice : null;
    const fromWei =
      metrics?.currentPrice != null && metrics.currentPrice > 0n
        ? Number(ethers.formatUnits(metrics.currentPrice, isSolanaPage ? 9 : 18))
        : null;
    const fromTopaz =
      contractGraduatedEarly && topazMarket.priceBnb != null && Number.isFinite(topazMarket.priceBnb) && topazMarket.priceBnb > 0
        ? Number(topazMarket.priceBnb)
        : null;
    const fromRt =
      rtStats?.lastPriceBnb != null && Number.isFinite(rtStats.lastPriceBnb) && rtStats.lastPriceBnb > 0
        ? Number(rtStats.lastPriceBnb)
        : null;
    const fromUnified = unifiedMarket.summary?.last_price_bnb != null
      ? Number(unifiedMarket.summary.last_price_bnb)
      : null;
    const fromTrades = (() => {
      const pts = Array.isArray(marketTradePoints) ? marketTradePoints : [];
      for (let i = pts.length - 1; i >= 0; i -= 1) {
        const p = Number((pts[i] as any)?.pricePerToken ?? 0);
        if (Number.isFinite(p) && p > 0) return p;
      }
      return null;
    })();

    const priceNative =
      fromSolanaSpot ??
      (contractGraduatedEarly ? fromTopaz : null) ??
      fromWei ??
      fromRt ??
      (Number.isFinite(fromUnified) && (fromUnified as number) > 0 ? (fromUnified as number) : null) ??
      fromTrades ??
      parseBnbLabel(tokenData.price);

    if (priceNative == null || !Number.isFinite(priceNative) || priceNative <= 0) {
      return tokenData.price && tokenData.price !== "—" ? tokenData.price : "—";
    }
    if (displayDenom === "BNB") return formatPriceBnb(priceNative);
    if (!nativeUsd) return nativeUsdLoading ? "…" : formatPriceBnb(priceNative);
    return formatTinyUsdPrice(priceNative * nativeUsd);
  }, [
    contractGraduatedEarly,
    displayDenom,
    isSolanaPage,
    marketTradePoints,
    metrics?.currentPrice,
    nativeUsd,
    nativeUsdLoading,
    rtStats?.lastPriceBnb,
    solanaLivePrice,
    tokenData.price,
    topazMarket.priceBnb,
    unifiedMarket.summary?.last_price_bnb,
  ]);

  const volumeDisplay = useMemo(() => {
    const nativeLabel = tokenData.metrics[selectedTimeframe]?.volume ?? "—";
    if (displayDenom === "BNB") return nativeLabel;
    const volumeNative = parseBnbLabel(nativeLabel);
    if (volumeNative == null) return "—";
    if (!nativeUsd) return nativeUsdLoading ? "…" : "—";
    return formatCompactUsd(volumeNative * nativeUsd);
  }, [displayDenom, nativeUsd, nativeUsdLoading, selectedTimeframe, tokenData.metrics]);

  const formatBnbOrUsd = useMemo(() => {
    return (native: number | null | undefined): string => {
      if (native == null || !Number.isFinite(native)) return "—";
      if (displayDenom === "BNB") return `${formatCompact(native)} ${nativeUnit}`;
      if (!nativeUsd) return nativeUsdLoading ? "…" : "—";
      return formatCompactUsd(native * nativeUsd);
    };
  }, [displayDenom, nativeUnit, nativeUsd, nativeUsdLoading]);

  const flywheel = useMemo(() => {
    if (isSolanaPage && solanaCurve) {
      const buyVol = Number(ethers.formatUnits(solanaCurve.totalBuyVolumeLamports, 9));
      const sellVol = Number(ethers.formatUnits(solanaCurve.totalSellVolumeLamports, 9));
      const netFlow = Number(ethers.formatUnits(solanaCurve.netRaisedLamports, 9));
      const fees =
        buyVol * (Number(solanaCurve.buyFeeBps) / 10000) +
        sellVol * (Number(solanaCurve.sellFeeBps) / 10000);
      return {
        buyVolume: formatBnbOrUsd(buyVol),
        sellVolume: formatBnbOrUsd(sellVol),
        netFlow: formatBnbOrUsd(netFlow),
        feesEstimated: formatBnbOrUsd(fees),
        buyers: String(
          Number(solanaCurve.buyerCount) ||
            new Set(
              marketTradePoints
                .filter((point) => point.type === "buy" && point.from)
                .map((point) => String(point.from).trim()),
            ).size,
        ),
        feeRate: `${(Number(solanaCurve.buyFeeBps) / 100).toFixed(2)}%`,
        lpRate: "—",
      };
    }

    const buyVolBnb = activity ? Number(ethers.formatEther(activity.buyVolumeWei)) : null;
    const sellVolBnb = activity ? Number(ethers.formatEther(activity.sellVolumeWei)) : null;
    const netFlowBnb = buyVolBnb != null && sellVolBnb != null ? buyVolBnb - sellVolBnb : null;
    const feeBps = metrics ? Number(metrics.protocolFeeBps) : 0;
    const feesBnb = buyVolBnb != null && sellVolBnb != null ? (buyVolBnb + sellVolBnb) * (feeBps / 10000) : null;

    return {
      buyVolume: formatBnbOrUsd(buyVolBnb),
      sellVolume: formatBnbOrUsd(sellVolBnb),
      netFlow: formatBnbOrUsd(netFlowBnb),
      feesEstimated: formatBnbOrUsd(feesBnb),
      buyers: activity ? String(activity.buyers) : "—",
      feeRate: metrics ? `${(Number(metrics.protocolFeeBps) / 100).toFixed(2)}%` : "—",
      lpRate: metrics ? `${(Number(metrics.liquidityBps) / 100).toFixed(2)}%` : "—",
    };
  }, [activity, metrics, formatBnbOrUsd, isSolanaPage, marketTradePoints, solanaCurve]);

  const holderDistribution = useMemo(() => {
    if (isSolanaPage && solanaCurve?.graduated && solanaMeteora.holders) {
      return {
        ...solanaMeteora.holders,
        source: "onchain" as const,
      };
    }

    const shortAddr = (a: string) =>
      a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

    const tradeReplay = (() => {
      const balances = new Map<string, bigint>();
      for (const p of marketTradePoints) {
        const rawAddr = String(p.from || "").trim();
        const addr = isSolanaPage ? rawAddr : rawAddr.toLowerCase();
        if (!addr) continue;
        const prev = balances.get(addr) ?? 0n;
        const delta = p.tokensWei ?? 0n;
        const isBuy = (p.type ?? "buy") === "buy";
        balances.set(addr, isBuy ? prev + delta : prev - delta);
      }
      return [...balances.entries()]
        .filter(([, bal]) => bal > 0n)
        .map(([address, bal]) => ({ address, bal }))
        .sort((a, b) => (a.bal === b.bal ? 0 : a.bal > b.bal ? -1 : 1));
    })();
    const fromTransfers =
      !isSolanaPage &&
      transferHolders.holders.length > 0 &&
      (transferHolders.complete || transferHolders.holders.length >= tradeReplay.length);
    const holders = fromTransfers ? transferHolders.holders : tradeReplay;

    const holdersBal = holders.reduce((acc, x) => acc + x.bal, 0n);

    // Reserved token allocation intended for the LP at graduation.
    // Solana stores this allocation directly in the Campaign PDA, while the
    // EVM implementation exposes it through CampaignMetrics.
    const lpBal = isSolanaPage
      ? (solanaCurve?.liquidityTokenSupply ?? 0n)
      : (metrics?.liquiditySupply ?? 0n);

    const totalBal = holdersBal + lpBal;

    const pct = (bal: bigint) => (totalBal > 0n ? Number((bal * 10000n) / totalBal) / 100 : 0);

    const topUsers = holders.slice(0, 6).map((h) => ({
      address: h.address,
      label: shortAddr(h.address),
      pct: pct(h.bal),
      isLp: false as const,
    }));

    const othersBal = holders.slice(6).reduce((acc, x) => acc + x.bal, 0n);

    const top = [
      ...(lpBal > 0n
        ? [
            {
              address: "liquidity-pool",
              label:
                isSolanaPage
                  ? solanaCurve?.graduated
                    ? "Liquidity pool"
                    : "Reserved liquidity"
                  : metrics?.launched || (metrics?.finalizedAt ?? 0n) > 0n
                    ? "Liquidity pool"
                    : "Reserved liquidity",
              pct: pct(lpBal),
              isLp: true as const,
            },
          ]
        : []),
      ...topUsers,
    ];

    return {
      top,
      othersPct: pct(othersBal),
      totalHolders: holders.length,
      hasLp: lpBal > 0n,
      source: fromTransfers ? ("onchain" as const) : ("bonding" as const),
    };
  }, [
    isSolanaPage,
    marketTradePoints,
    transferHolders.complete,
    transferHolders.holders,
    metrics?.liquiditySupply,
    metrics?.launched,
    metrics?.finalizedAt,
    solanaCurve?.liquidityTokenSupply,
    solanaCurve?.graduated,
    solanaMeteora.holders,
  ]);


  // Reserve / "liquidity" shown on the page: BNB held by the campaign contract (pre-graduation)
  useEffect(() => {
    let cancelled = false;

    const loadReserve = async () => {
      try {
        if (!campaign?.campaign || !readProvider || isSolanaPage) {
          setCurveReserveWei(null);
          return;
        }
        const bal = await readProvider.getBalance(campaign.campaign);
        if (!cancelled) setCurveReserveWei(bal);
      } catch (e) {
        console.warn("[TokenDetails] Failed to load campaign reserve", e);
        if (!cancelled) setCurveReserveWei(null);
      }
    };

    loadReserve();
    const timer = isSolanaPage ? 0 : window.setInterval(() => void loadReserve(), 5_000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [readProvider, campaign?.campaign, isSolanaPage]);

  // Bonding headline (price / sold / mcap) must move while the page is open.
  useEffect(() => {
    if (!campaign?.campaign || isSolanaPage) return;
    let cancelled = false;
    const loadMetrics = async () => {
      try {
        const next = await fetchCampaignMetrics(campaign.campaign);
        if (!cancelled && next) setMetrics(next);
      } catch (e) {
        console.warn("[TokenDetails] live metrics poll failed", e);
      }
    };
    void loadMetrics();
    const timer = window.setInterval(() => void loadMetrics(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [campaign?.campaign, fetchCampaignMetrics, isSolanaPage]);

  // Campaign activity counters (buy/sell volume, buyers). Used for Flywheel and related panels.
  useEffect(() => {
    let cancelled = false;

    const loadActivity = async () => {
      try {
        if (!campaign?.campaign || isSolanaPage) {
          // Solana Campaign carries native counters; never interpret EVM activity ABI data as SOL.
          setActivity(null);
          return;
        }
        const a = await fetchCampaignActivity(campaign.campaign);
        if (!cancelled) setActivity(a);
      } catch (e) {
        console.warn("[TokenDetails] Failed to load campaign activity", e);
        if (!cancelled) setActivity(null);
      }
    };

    loadActivity();
    const t = setInterval(loadActivity, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [campaign?.campaign, fetchCampaignActivity, isSolanaPage]);

  // Solana: SOL/USD for $ graduation → native remaining (mirrors BNB oracle target).
  useEffect(() => {
    if (!isSolanaPage) {
      setSolUsdPrice(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
          { cache: "no-store" },
        );
        const json = await res.json();
        const p = Number(json?.solana?.usd);
        if (!cancelled && Number.isFinite(p) && p > 0) setSolUsdPrice(p);
      } catch {
        if (!cancelled) setSolUsdPrice(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSolanaPage]);

  // Solana: load campaign curve snapshot (5s poll while Token Details is open).
  // Metrics are derived locally so a CoinGecko tick or wallet-balance tick cannot re-hit RPC.
  useEffect(() => {
    if (!isSolanaPage || !campaign?.campaign) {
      setSolanaCurve(null);
      return;
    }
    let cancelled = false;
    const loadCurve = async () => {
      try {
        const { resolveSolanaCampaignCurve } = await import("@/lib/solanaCampaignRead");
        const candidates = [
          ...new Set(
            [
              (campaign as { campaignPda?: string }).campaignPda,
              campaign.campaign !== campaign.token ? campaign.campaign : null,
              campaign.campaign,
              campaign.token,
            ]
              .map((x) => String(x || "").trim())
              .filter(Boolean),
          ),
        ];
        let state: import("@/lib/solanaCampaignRead").SolanaCampaignCurveState | null = null;
        for (const addr of candidates) {
          state = await resolveSolanaCampaignCurve(addr);
          if (state && (state.curveTokenSupply > 0n || state.graduated)) break;
        }
        if (cancelled) return;
        if (!state) {
          // Empty resolve must not blank a previous curve for this campaign.
          setSolanaCurve((prev) => {
            if (!prev) return prev;
            const prevAddr = String(prev.campaignAddress || "").trim();
            const curr = String(campaign.campaign || "").trim();
            const token = String(campaign.token || "").trim();
            if (prevAddr && curr && prevAddr !== curr && prevAddr !== token) return null;
            return prev;
          });
          return;
        }
        setSolanaCurve(state);
        setCurveReserveWei(state.netRaisedLamports);
        if (state.mint && (!campaign.token || campaign.token === campaign.campaign)) {
          setCampaign((prev) =>
            prev
              ? {
                  ...prev,
                  campaign: state.campaignAddress || prev.campaign,
                  token: state.mint,
                  creator: state.creator || prev.creator,
                }
              : prev,
          );
        }
      } catch (e) {
        console.warn("[TokenDetails] Solana curve load failed", e);
        // Transient RPC failure: keep the last good curve.
      }
    };
    void loadCurve();
    const timer = window.setInterval(() => void loadCurve(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isSolanaPage, campaign?.campaign, campaign?.token]);

  useEffect(() => {
    if (!isSolanaPage || !solanaCurve) return;
    const state = solanaCurve;
    let graduationNativeTarget = 0n;
    if (solUsdPrice && solUsdPrice > 0 && state.graduationTargetUsdMicros > 0n) {
      const priceScaled = BigInt(Math.max(1, Math.round(solUsdPrice * 1_000_000)));
      graduationNativeTarget = (state.graduationTargetUsdMicros * 1_000_000_000n) / priceScaled;
    }
    const tokenScale = 10n ** BigInt(state.tokenDecimals);
    const slopeDenominator = state.economicsVersion >= 3 ? tokenScale * 1_000_000_000n : tokenScale;
    const spot =
      state.basePriceLamports + (state.priceSlopeLamports * state.soldTokens) / slopeDenominator;
    setMetrics({
      sold: state.soldTokens,
      curveSupply: state.curveTokenSupply,
      liquiditySupply: 0n,
      creatorReserve:
        state.tokenTotalSupply > state.curveTokenSupply
          ? state.tokenTotalSupply - state.curveTokenSupply
          : 0n,
      basePrice: state.basePriceLamports,
      priceSlope: state.priceSlopeLamports,
      graduationTarget: state.graduationTargetUsdMicros,
      graduationNativeTarget,
      liquidityBps: 0n,
      protocolFeeBps: BigInt(state.buyFeeBps),
      currentPrice: spot > 0n ? spot : state.basePriceLamports,
      launched: false,
      finalizedAt: 0n,
    } as CampaignMetrics);
  }, [isSolanaPage, solUsdPrice, solanaCurve]);

  // Wallet balances (for the trading panel)
  useEffect(() => {
    let cancelled = false;

    const loadBalances = async () => {
      try {
        // Solana: load SOL + token ATA balances for position + trade panel.
        if (isSolanaPage) {
          try {
            const { getSolanaProvider } = await import("@/lib/solanaWallet");
            const { loadSolanaWeb3 } = await import("@/lib/solanaWeb3");
            const { getPublicRpcUrl } = await import("@/lib/chainConfig");
            const { getSolanaTokenBalanceRaw } = await import("@/lib/solanaTradeV1");
            const provider = getSolanaProvider();
            const pubkey = String(provider?.publicKey?.toString?.() || "").trim();
            if (!pubkey) {
              if (!cancelled) {
                setBnbBalanceWei(null);
                setTokenBalanceWei(null);
              }
              return;
            }
            const web3 = await loadSolanaWeb3();
            const connection = new web3.Connection(
              String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID),
              { commitment: "confirmed", disableRetryOnRateLimit: true },
            );
            const lamports = BigInt(await connection.getBalance(new web3.PublicKey(pubkey)));
            const mint = String(campaign?.token || campaign?.campaign || "").trim();
            let tokenRaw = 0n;
            if (mint) {
              tokenRaw = await getSolanaTokenBalanceRaw({ mint, owner: pubkey });
            }
            if (!cancelled) {
              setBnbBalanceWei(lamports);
              setTokenBalanceWei(tokenRaw);
            }
          } catch (e) {
            console.warn("[TokenDetails] Failed to load Solana balances", e);
            if (!cancelled) {
              setBnbBalanceWei(null);
              setTokenBalanceWei(null);
            }
          }
          return;
        }

        if (!wallet.account || !readProvider) {
          setBnbBalanceWei(null);
          setTokenBalanceWei(null);
          return;
        }

        const [bnbBal, tokenBal] = await Promise.all([
          readProvider.getBalance(wallet.account),
          (async () => {
            try {
              if (!campaign?.token) return 0n;
              const t = new Contract(campaign.token, TOKEN_ABI, readProvider) as any;
              return (await t.balanceOf(wallet.account)) as bigint;
            } catch {
              return 0n;
            }
          })(),
        ]);

        if (!cancelled) {
          setBnbBalanceWei(bnbBal);
          setTokenBalanceWei(tokenBal);
        }
      } catch (e) {
        console.warn("[TokenDetails] Failed to load balances", e);
        if (!cancelled) {
          setBnbBalanceWei(null);
          setTokenBalanceWei(null);
        }
      }
    };

    loadBalances();

    return () => {
      cancelled = true;
    };
  }, [readProvider, wallet.account, campaign?.token, campaign?.campaign, isSolanaPage, solanaBalanceTick]);

  // Build transactions table rows from continuous market trade stream.
  useEffect(() => {
    if (!campaign) {
      setTxs((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const mcap = tokenData.marketCap ?? "—";

    const seenFill = new Set<string>();
    const next: TxRow[] = [...marketTradePoints]
      .slice()
      .reverse()
      .filter((p: any) => {
        const rawTx = String(p.txHash || "").trim();
        const tx = isSolanaPage ? rawTx : rawTx.toLowerCase();
        const valid = isSolanaPage
          ? /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(tx)
          : /^0x[a-f0-9]{64}$/.test(tx);
        if (!valid) return false;
        const fillKey = tradeDedupeKey(p);
        if (!fillKey || seenFill.has(fillKey)) return false;
        seenFill.add(fillKey);
        return true;
      })
      .slice(0, 100)
      .map((p: any) => {
        const tokenAmount = Number(ethers.formatUnits(p.tokensWei ?? 0n, tokenDecimals));
        const bnb = Number(ethers.formatUnits(p.nativeWei ?? 0n, isSolanaPage ? 9 : 18));
        const bnbStr = Number.isFinite(bnb) ? `${bnb.toFixed(4)} ${nativeUnit}` : "—";

        const priceNum = typeof p.pricePerToken === "number" ? p.pricePerToken : Number(p.pricePerToken ?? 0);
        const priceStr = formatPriceBnb(priceNum);

        const txHash = isSolanaPage
          ? String(p.txHash ?? "").trim()
          : String(p.txHash ?? "").toLowerCase();
        const ts = Number(p.timestamp ?? 0);

        return {
          id: tradeDedupeKey(p) || txHash,
          time: formatAgo(ts),
          type: (p.type ?? "buy") as "buy" | "sell",
          amount: formatCompact(tokenAmount),
          bnb: bnbStr,
          price: priceStr,
          mcap,
          maker: shorten(p.from),
          makerAddress: String(p.from ?? ""),
          txHash,
        };
      });

    setTxs((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
  }, [campaign?.campaign, campaign?.token, marketTradePoints, tokenData.marketCap, isSolanaPage, tokenDecimals]);

  // Graduation is a market-stage transition inside MemeWarzone, not a redirect.
  // Solana DEX stage is only the on-chain graduated flag — never progress, indexer
  // inference, or localStorage. Eligibility is curve_closed, not graduated.
  const contractGraduated = isSolanaPage
    ? Boolean(solanaCurve?.graduated)
    : contractGraduatedEarly;
  const solanaCurveClosed = Boolean(
    isSolanaPage &&
      !solanaCurve?.graduated &&
      (solanaCurve?.curveClosed ||
        (metrics?.graduationNativeTarget != null &&
          metrics.graduationNativeTarget > 0n &&
          (curveReserveWei ?? 0n) >= metrics.graduationNativeTarget) ||
        (metrics?.curveSupply != null &&
          metrics.curveSupply > 0n &&
          (metrics?.sold ?? 0n) >= metrics.curveSupply)),
  );
  useEffect(() => {
    if (!isSolanaPage || !solanaCurveClosed) return;
    const campaignPda = String(solanaCurve?.campaignAddress || campaign?.campaign || "").trim();
    if (campaignPda) void requestSolanaGraduationHandoff(campaignPda);
    const timer = window.setInterval(() => setSolanaBalanceTick((n) => n + 1), 8_000);
    return () => window.clearInterval(timer);
  }, [campaign?.campaign, isSolanaPage, solanaCurve?.campaignAddress, solanaCurveClosed]);
  const verifiedMarketStage = isSolanaPage ? null : unifiedMarket.state?.marketStage;
  // Do NOT treat TOPAZ_PENDING alone as DEX UI — that broke bonding metrics when
  // handoff rows existed without a live pair. Require on-chain graduation or ACTIVE.
  const isDexStage = isSolanaPage
    ? contractGraduated
    : contractGraduated ||
      verifiedMarketStage === "TOPAZ_ACTIVE" ||
      (verifiedMarketStage === "TOPAZ_DEGRADED" && contractGraduated);
  // Allow Topaz when on-chain graduated even if market-state is a soft BONDING skeleton
  // (common after cleanup / CMS lag). Soft BONDING must not block WIC-style trades.
  const isTopazTradingActive = isSolanaPage
    ? false
    : onChainLaunched ||
      contractGraduated ||
      (verifiedMarketStage === "TOPAZ_ACTIVE" &&
        (Boolean(unifiedMarket.state?.tradingEnabled) || Boolean(unifiedMarket.state?.pairAddress || onChainPair)));
  const [solanaGraduationTransitionAt, setSolanaGraduationTransitionAt] = useState<number | null>(null);
  const previousSolanaGraduatedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!isSolanaPage) return;
    const previous = previousSolanaGraduatedRef.current;
    if (previous === false && contractGraduated) {
      setSolanaGraduationTransitionAt(Date.now());
    }
    previousSolanaGraduatedRef.current = contractGraduated;
  }, [isSolanaPage, contractGraduated]);



  const curveProgress = useMemo(() => {
    // IMPORTANT:
    // - metrics.sold is TOKEN base units sold on the bonding curve.
    // - metrics.curveSupply is TOKEN base units available on the curve.
    // - metrics.graduationNativeTarget is native reserve target (BNB wei or SOL lamports).
    // Graduates when sold >= curveSupply OR reserve >= graduationTarget (chain-specific).

    // Prefer live Solana curve snapshot when present (TokenDetails zeros EVM metrics on Solana shell).
    const sold = isSolanaPage
      ? ((solanaCurve?.soldTokens && solanaCurve.soldTokens > 0n
          ? solanaCurve.soldTokens
          : null) ??
        (metrics?.sold && metrics.sold > 0n ? metrics.sold : null) ??
        latestSoldFromTrades ??
        0n)
      : (metrics?.sold ?? 0n);
    const curveSupply = isSolanaPage
      ? (solanaCurve?.curveTokenSupply ?? metrics?.curveSupply ?? 0n)
      : (metrics?.curveSupply ?? 0n);
    const targetWei = metrics?.graduationNativeTarget ?? 0n;
    const reserveWei = isSolanaPage
      ? ((solanaCurve?.netRaisedLamports && solanaCurve.netRaisedLamports > 0n
          ? solanaCurve.netRaisedLamports
          : null) ??
        (curveReserveWei && curveReserveWei > 0n ? curveReserveWei : null) ??
        0n)
      : (curveReserveWei ?? 0n);

    // High-precision % for micro progress (expensive early curves show 0.00% at 2dp).
    const soldPct =
      curveSupply > 0n ? Number(sold * 1_000_000n / curveSupply) / 10_000 : 0;
    const raisedPct =
      targetWei > 0n ? Number(reserveWei * 1_000_000n / targetWei) / 10_000 : 0;

    const reachedSold = curveSupply > 0n && sold >= curveSupply;
    const reachedRaised = targetWei > 0n && reserveWei >= targetWei;

    // When we are in DEX stage, always show 100%.
    if (isDexStage) {
      return {
        pct: 100,
        matured: true,
        soldWei: sold,
        curveSupplyWei: curveSupply,
        reserveWei,
        targetWei,
        soldPct: 100,
        raisedPct: 100,
      };
    }

    // Show whichever progress is “more complete”, because graduation triggers on either.
    const pct = Math.max(
      0,
      Math.min(100, Math.max(soldPct, raisedPct))
    );

    return {
      pct,
      matured: reachedSold || reachedRaised,
      soldWei: sold,
      curveSupplyWei: curveSupply,
      reserveWei,
      targetWei,
      soldPct: Math.max(0, Math.min(100, soldPct)),
      raisedPct: Math.max(0, Math.min(100, raisedPct)),
    };
  }, [
    isDexStage,
    isSolanaPage,
    solanaCurve?.soldTokens,
    solanaCurve?.curveTokenSupply,
    solanaCurve?.netRaisedLamports,
    metrics?.sold,
    metrics?.curveSupply,
    metrics?.graduationNativeTarget,
    curveReserveWei,
    latestSoldFromTrades,
  ]);

    const remainingCurveWei = useMemo(() => {
    // Remaining BNB needed to reach the graduation target (reserve-based trigger).
    // If already in DEX stage, remaining is 0.
    if (isDexStage) return 0n;

    const targetWei = curveProgress.targetWei ?? 0n;
    const reserveWei = curveProgress.reserveWei ?? 0n;
    return targetWei > reserveWei ? targetWei - reserveWei : 0n;
  }, [isDexStage, curveProgress.targetWei, curveProgress.reserveWei]);

  const remainingCurveLabel = useMemo(() => {
    if ((curveProgress.targetWei ?? 0n) <= 0n) {
      return { primary: "—", secondary: "—" };
    }
    const bnbLabel = formatBnbFromWei(remainingCurveWei);

    let remainingBnbNum: number | null = null;
    try {
      const n = Number(ethers.formatUnits(remainingCurveWei, isSolanaPage ? 9 : 18));
      remainingBnbNum = Number.isFinite(n) ? n : null;
    } catch {
      remainingBnbNum = null;
    }

    const usdLabel =
      remainingBnbNum != null && nativeUsd
        ? formatCompactUsd(remainingBnbNum * nativeUsd)
        : nativeUsdLoading
        ? "…"
        : "—";

    // Primary follows the denomination toggle; secondary shows the other denomination.
    if (displayDenom === "USD") return { primary: usdLabel, secondary: bnbLabel };
    return { primary: bnbLabel, secondary: usdLabel };
  }, [curveProgress.targetWei, remainingCurveWei, displayDenom, nativeUsd, nativeUsdLoading, isSolanaPage]);

  const liquidityLabel = isDexStage ? "Liquidity" : "Reserve";
  const liquidityValue = (() => {
    if (!isDexStage) return tokenData.liquidity;
    if (isSolanaPage && solanaMeteora.spot && solanaMeteora.spot.liquiditySol > 0) {
      return `${formatCompact(solanaMeteora.spot.liquiditySol)} ${nativeUnit}`;
    }
    if (isSolanaPage && rtStats?.graduationLiquidityNative != null && rtStats.graduationLiquidityNative > 0) {
      // Initial DAMM v2 TVL is approximately two equal-value sides at handoff.
      return `${formatCompact(rtStats.graduationLiquidityNative * 2)} ${nativeUnit}`;
    }
    // On-chain Topaz pool liquidity only (2 × WBNB reserve). No external DEX APIs.
    if (topazMarket.liquidityBnb != null && Number.isFinite(topazMarket.liquidityBnb) && topazMarket.liquidityBnb > 0) {
      return `${formatCompact(topazMarket.liquidityBnb)} ${nativeUnit}`;
    }
    if (tokenData.liquidity && tokenData.liquidity !== "—") return tokenData.liquidity;
    return "—";
  })();

  const liquidityDisplay = useMemo(() => {
    const bnbLabel = liquidityValue;

    if (displayDenom === "BNB") return bnbLabel;

    const liqBnb = parseBnbLabel(bnbLabel);
    if (liqBnb == null) return "—";

    if (!nativeUsd) return nativeUsdLoading ? "…" : "—";

    return formatCompactUsd(liqBnb * nativeUsd);
  }, [displayDenom, liquidityValue, nativeUsd, nativeUsdLoading]);
;


  const stagePill = isSolanaPage
    ? contractGraduated
      ? "Graduated · Meteora"
      : solanaCurveClosed
        ? "Graduating · Solana"
        : "Bonding · Solana"
    : isTopazTradingActive
      ? "Graduated · Topaz"
      : isDexStage
        ? "Graduating"
        : "Bonding";

  // Quote (buy: BNB cost; sell: BNB payout) for the entered token amount
  useEffect(() => {
    let cancelled = false;

    const loadQuote = async () => {
      try {
        setQuoteError(null);

        // ── Solana bonding quotes (exact SOL-in buy / exact tokens-in sell) ──
        if (isSolanaPage) {
          if (contractGraduated || solanaCurveClosed) {
            const solStr = String(tradeAmount || "").trim();
            if (!solStr || solStr === "0") {
              setEffectiveTokenWei(0n);
              setEffectiveBnbWei(0n);
              setQuoteWei(null);
              setQuoteError(null);
              setQuoteLoading(false);
              return;
            }
            if (solanaCurveClosed && !contractGraduated) {
              setQuoteLoading(false);
              setQuoteError("Opening Meteora…");
              setQuoteWei(null);
              return;
            }
            try {
              setQuoteLoading(true);
              const { quoteSolanaMeteoraExactIn } = await import("@/lib/solanaMeteoraTrade");
              const dec = Number(solanaCurve?.tokenDecimals ?? 6);
              const parseSol = (s: string) => {
                const parts = s.split(".");
                return BigInt(parts[0] || "0") * 1_000_000_000n + BigInt((parts[1] || "").slice(0, 9).padEnd(9, "0") || "0");
              };
              const parseTok = (s: string) => {
                const parts = s.split(".");
                return BigInt(parts[0] || "0") * 10n ** BigInt(dec) + BigInt((parts[1] || "").slice(0, dec).padEnd(dec, "0") || "0");
              };
              const amountInRaw =
                tradeTab === "buy"
                  ? tradeInputDenom === "BNB"
                    ? parseSol(solStr)
                    : effectiveBnbWei
                  : tradeInputDenom === "BNB"
                    ? effectiveTokenWei
                    : parseTok(solStr);
              if (amountInRaw <= 0n) {
                setQuoteWei(null);
                setQuoteError(null);
                return;
              }
              const quote = await quoteSolanaMeteoraExactIn({
                side: tradeTab === "buy" ? "buy" : "sell",
                mint: String(solanaCurve?.mint || campaign?.token || ""),
                tokenDecimals: dec,
                amountInRaw,
                slippagePct: SLIPPAGE_PCT,
              });
              if (cancelled) return;
              if (tradeTab === "buy") {
                setEffectiveBnbWei(amountInRaw);
                setEffectiveTokenWei(quote.amountOutRaw);
                setQuoteWei(amountInRaw);
              } else {
                setEffectiveTokenWei(amountInRaw);
                setEffectiveBnbWei(quote.amountOutRaw);
                setQuoteWei(quote.amountOutRaw);
              }
              setQuoteError(null);
            } catch (e: any) {
              if (!cancelled) {
                setQuoteWei(null);
                setQuoteError(solanaCurveClosed ? "Opening Meteora…" : (e?.message || "Meteora quote failed"));
              }
            } finally {
              if (!cancelled) setQuoteLoading(false);
            }
            return;
          }
          const solStr = String(tradeAmount || "").trim();
          if (!solStr || solStr === "0") {
            setEffectiveTokenWei(0n);
            setEffectiveBnbWei(0n);
            setQuoteWei(null);
            setQuoteError(null);
            setQuoteLoading(false);
            return;
          }
          setQuoteLoading(true);

          const parseSolLamports = (s: string): bigint => {
            const parts = s.split(".");
            const whole = BigInt(parts[0] || "0");
            const frac = (parts[1] || "").slice(0, 9).padEnd(9, "0");
            return whole * 1_000_000_000n + BigInt(frac || "0");
          };
          const parseTok = (s: string, dec: number): bigint => {
            const parts = s.split(".");
            const whole = BigInt(parts[0] || "0");
            const frac = (parts[1] || "").slice(0, dec).padEnd(dec, "0");
            return whole * 10n ** BigInt(dec) + BigInt(frac || "0");
          };

          let curve = solanaCurve;
          if (!curve && campaign?.campaign) {
            const { resolveSolanaCampaignCurve } = await import("@/lib/solanaCampaignRead");
            curve = await resolveSolanaCampaignCurve(String(campaign.campaign));
            if (!cancelled && curve) setSolanaCurve(curve);
          }

          const {
            quoteBuyExactSolIn,
            quoteSellExactTokensIn,
          } = await import("@/lib/solanaTradeV1");

          const dec = Number(curve?.tokenDecimals ?? 6);
          // BNB-parity V2 defaults (1B supply, base=1 lamport/whole token). Live curve overrides.
          const econ = Number(curve?.economicsVersion ?? 2);
          const basePrice = curve?.basePriceLamports ?? 1n;
          const slope = curve?.priceSlopeLamports ?? 1n;
          const sold = curve?.soldTokens ?? 0n;
          const supply = curve?.curveTokenSupply ?? 800_000_000_000_000n; // 800M @ 6 dec
          const buyFeeBps = curve?.buyFeeBps ?? 200;
          const sellFeeBps = curve?.sellFeeBps ?? 200;

          if (tradeTab === "buy") {
            // Native denom: exact SOL in. Token denom: approximate SOL for exact tokens (cost + fee).
            if (tradeInputDenom === "BNB") {
              const lamportsIn = parseSolLamports(solStr);
              if (lamportsIn <= 0n) {
                if (!cancelled) {
                  setEffectiveBnbWei(0n);
                  setEffectiveTokenWei(0n);
                  setQuoteWei(null);
                }
                return;
              }
              const q = quoteBuyExactSolIn({
                lamportsIn,
                basePrice,
                slope,
                sold,
                curveSupply: supply,
                buyFeeBps,
                economicsVersion: econ,
                tokenDecimals: dec,
              });
              if (!cancelled) {
                setEffectiveBnbWei(lamportsIn);
                setEffectiveTokenWei(q.tokensOut);
                setQuoteWei(lamportsIn);
                setQuoteError(q.tokensOut <= 0n ? "Amount too small for curve quote." : null);
              }
            } else {
              const tokensWanted = parseTok(solStr, dec);
              if (tokensWanted <= 0n) {
                if (!cancelled) {
                  setEffectiveBnbWei(0n);
                  setEffectiveTokenWei(0n);
                  setQuoteWei(null);
                }
                return;
              }
              // Invert roughly: cost for tokens + fee top-up.
              const { checkedLinearCurveCost, calculateFee } = await import("@/lib/solanaTradeV1");
              const grossCost = checkedLinearCurveCost(
                basePrice,
                slope,
                sold,
                tokensWanted,
                econ,
                dec,
              );
              // net = gross * (1 - fee) ≈ grossCost → lamportsIn ≈ grossCost / (1 - fee)
              const feeBps = BigInt(buyFeeBps);
              const lamportsIn =
                feeBps >= 10_000n
                  ? grossCost
                  : (grossCost * 10_000n + (10_000n - feeBps - 1n)) / (10_000n - feeBps);
              void calculateFee;
              if (!cancelled) {
                setEffectiveTokenWei(tokensWanted);
                setEffectiveBnbWei(lamportsIn);
                setQuoteWei(lamportsIn);
                setQuoteError(null);
              }
            }
          } else {
            if (tradeInputDenom === "BNB") {
              const targetLamports = parseSolLamports(solStr);
              const walletMax = tokenBalanceWei != null && tokenBalanceWei > 0n ? tokenBalanceWei : sold;
              const maxTokens = walletMax < sold ? walletMax : sold;
              if (targetLamports <= 0n || maxTokens <= 0n) {
                if (!cancelled) {
                  setEffectiveTokenWei(0n);
                  setEffectiveBnbWei(0n);
                  setQuoteWei(null);
                  setQuoteError(targetLamports <= 0n ? null : "No token balance available to sell.");
                }
                return;
              }
              const quoteFor = (tokensIn: bigint) =>
                quoteSellExactTokensIn({
                  tokensIn,
                  basePrice,
                  slope,
                  sold,
                  sellFeeBps,
                  economicsVersion: econ,
                  tokenDecimals: dec,
                });
              const maxQuote = quoteFor(maxTokens);
              if (maxQuote.lamportsOut < targetLamports) {
                if (!cancelled) {
                  setEffectiveTokenWei(maxTokens);
                  setEffectiveBnbWei(maxQuote.lamportsOut);
                  setQuoteWei(maxQuote.lamportsOut);
                  setQuoteError(
                    `That field is target SOL out, not token size. Selling your whole bag only returns ~${ethers.formatUnits(maxQuote.lamportsOut, 9)} SOL (you asked for ${ethers.formatUnits(targetLamports, 9)} SOL). Switch to tokens to sell an exact amount.`,
                  );
                }
                return;
              }
              let lo = 1n;
              let hi = maxTokens;
              for (let i = 0; i < 64 && lo < hi; i += 1) {
                const mid = (lo + hi) / 2n;
                const q = quoteFor(mid);
                if (q.lamportsOut >= targetLamports) hi = mid;
                else lo = mid + 1n;
              }
              const solved = lo;
              const q = quoteFor(solved);
              if (!cancelled) {
                setEffectiveTokenWei(solved);
                setEffectiveBnbWei(q.lamportsOut);
                setQuoteWei(q.lamportsOut);
                setQuoteError(q.lamportsOut <= 0n ? "Sell quote is zero." : null);
              }
            } else {
              const tokensIn = parseTok(solStr, dec);
              if (tokensIn <= 0n) {
                if (!cancelled) {
                  setEffectiveTokenWei(0n);
                  setEffectiveBnbWei(0n);
                  setQuoteWei(null);
                }
                return;
              }
              const q = quoteSellExactTokensIn({
                tokensIn,
                basePrice,
                slope,
                sold,
                sellFeeBps,
                economicsVersion: econ,
                tokenDecimals: dec,
              });
              if (!cancelled) {
                setEffectiveTokenWei(tokensIn);
                setEffectiveBnbWei(q.lamportsOut);
                setQuoteWei(q.lamportsOut);
                setQuoteError(
                  sold < tokensIn
                    ? "Cannot sell more than the curve has sold."
                    : q.lamportsOut <= 0n
                      ? "0.001 in token mode is 0.001 tokens, not 0.001 SOL. That size pays 0 lamports. Switch the unit to SOL to sell a SOL amount."
                      : null,
                );
              }
            }
          }
          return;
        }

        if (isDexStage) {
          if (!campaign?.campaign || !campaign?.token) {
            setQuoteWei(null);
            setQuoteError("Campaign address is not ready yet.");
            return;
          }
          // Prefer on-chain launched over CMS BONDING lag.
          if (!isTopazTradingActive && !onChainLaunched) {
            setQuoteWei(null);
            setQuoteError(
              unifiedMarket.state?.lastError ||
                "Topaz market verification is still in progress. Bonding history remains available.",
            );
            return;
          }
          // Avoid route RPC work until the user enters an amount.
          const hasAmount =
            tradeInputDenom === "BNB"
              ? parseBnbAmountWei(tradeAmount) > 0n
              : parseTokenAmountWei(tradeAmount) > 0n;
          if (!hasAmount) {
            setEffectiveTokenWei(0n);
            setEffectiveBnbWei(0n);
            setQuoteWei(null);
            setQuoteError(null);
            return;
          }
          setQuoteLoading(true);
          // Always resolve on-chain when CMS is stale BONDING — do not require TOPAZ_ACTIVE API.
          const resolved = await resolveVerifiedTopazRoute({
            provider: readProvider,
            campaignAddress: campaign.campaign,
            expectedTokenAddress: campaign.token,
            chainId: chainIdForStorage,
          });
          if (tradeInputDenom === "BNB") {
            const targetNativeWei = parseBnbAmountWei(tradeAmount);
            setEffectiveBnbWei(targetNativeWei);
            if (targetNativeWei <= 0n) {
              setEffectiveTokenWei(0n);
              setQuoteWei(null);
              return;
            }
            if (tradeTab === "buy") {
              const quote = await quoteTopazBuy({
                provider: readProvider,
                resolved,
                nativeAmountInRaw: targetNativeWei,
                slippageBps: topazSlippageBps,
              });
              if (!cancelled) {
                setEffectiveTokenWei(quote.amountOutRaw);
                setQuoteWei(targetNativeWei);
              }
              return;
            }
            const tokenInputWei = await solveTokensForExactNative({
              provider: readProvider,
              resolved,
              targetNativeOutRaw: targetNativeWei,
              initialTokenHighRaw: tokenBalanceWei && tokenBalanceWei > 0n ? tokenBalanceWei : 10n ** 24n,
            });
            const quote = await quoteTopazSell({
              provider: readProvider,
              resolved,
              tokenAmountInRaw: tokenInputWei,
              slippageBps: topazSlippageBps,
            });
            if (!cancelled) {
              setEffectiveTokenWei(tokenInputWei);
              setEffectiveBnbWei(quote.amountOutRaw);
              setQuoteWei(quote.amountOutRaw);
            }
            return;
          }
          const tokenInputWei = parseTokenAmountWei(tradeAmount);
          setEffectiveTokenWei(tokenInputWei);
          if (tokenInputWei <= 0n) {
            setEffectiveBnbWei(0n);
            setQuoteWei(null);
            return;
          }
          if (tradeTab === "buy") {
            let initialNativeHighRaw = 10n ** 15n;
            try {
              const lastPriceWei = ethers.parseUnits(String(unifiedMarket.summary?.last_price_bnb || "0"), 18);
              const estimate = (tokenInputWei * lastPriceWei) / 10n ** 18n;
              if (estimate > 0n) initialNativeHighRaw = estimate * 2n;
            } catch {
              // Binary-search expansion handles an unavailable spot price.
            }
            const nativeInputWei = await solveNativeForExactTokens({
              provider: readProvider,
              resolved,
              targetTokenOutRaw: tokenInputWei,
              initialNativeHighRaw,
            });
            const quote = await quoteTopazBuy({
              provider: readProvider,
              resolved,
              nativeAmountInRaw: nativeInputWei,
              slippageBps: topazSlippageBps,
            });
            if (!cancelled) {
              setEffectiveBnbWei(nativeInputWei);
              setEffectiveTokenWei(quote.amountOutRaw);
              setQuoteWei(nativeInputWei);
            }
            return;
          }
          const quote = await quoteTopazSell({
            provider: readProvider,
            resolved,
            tokenAmountInRaw: tokenInputWei,
            slippageBps: topazSlippageBps,
          });
          if (!cancelled) {
            setEffectiveBnbWei(quote.amountOutRaw);
            setQuoteWei(quote.amountOutRaw);
          }
          return;
        }
        if (!campaign?.campaign) {
          setQuoteWei(null);
          return;
        }

        let amountWei = 0n;
        let inputBnbWei = 0n;
        if (tradeInputDenom === "BNB") {
          inputBnbWei = parseBnbAmountWei(tradeAmount);
          setEffectiveBnbWei(inputBnbWei);
          if (inputBnbWei <= 0n) {
            setEffectiveTokenWei(0n);
            setQuoteWei(null);
            return;
          }
        } else {
          amountWei = parseTokenAmountWei(tradeAmount);
          setEffectiveTokenWei(amountWei);
          if (amountWei <= 0n) {
            setQuoteWei(null);
            return;
          }
        }

        setQuoteLoading(true);

        const c = new Contract(campaign.campaign, CAMPAIGN_ABI, readProvider) as any;
        if (tradeInputDenom === "BNB") {
          const targetWei = inputBnbWei;
          if (tradeTab === "buy") {
            // quoteBuyExactBnb → (tokensOut, totalCostWei, feeWei)
            const quoted = await c.quoteBuyExactBnb(targetWei);
            const tokensOut = BigInt(quoted?.[0] ?? quoted?.tokensOut ?? 0n);
            const totalCostWei = BigInt(quoted?.[1] ?? quoted?.totalCostWei ?? targetWei);
            if (!cancelled) {
              setEffectiveTokenWei(tokensOut);
              // User spends the entered BNB amount; contract may consume slightly less.
              setEffectiveBnbWei(targetWei);
              setQuoteWei(totalCostWei > 0n ? totalCostWei : targetWei);
            }
            return;
          }

          // A BNB-denominated sell still needs inversion because the contract
          // accepts an exact token input.
          const priceWei = metrics?.currentPrice ?? 0n;
          let hi: bigint;
          if (tokenBalanceWei != null && tokenBalanceWei > 0n) {
            hi = tokenBalanceWei;
          } else if (priceWei > 0n) {
            const est = (targetWei * 10n ** 18n) / priceWei;
            hi = est > 0n ? est * 2n : 10n ** 18n;
          } else {
            hi = 10n ** 24n;
          }
          let lo = 0n;
          // 28 iterations ~= good precision without too many RPC calls.
          for (let i = 0; i < 28; i++) {
            const mid = (lo + hi) / 2n;
            if (mid <= 0n) {
              lo = 0n;
              continue;
            }
            const q: bigint = await c.quoteSellExactTokens(mid);
            if (q >= targetWei) hi = mid; else lo = mid;
          }
          const solved = hi;
          if (!cancelled) {
            setEffectiveTokenWei(solved);
            setQuoteWei(targetWei);
          }
        } else {
          const q: bigint = tradeTab === "buy"
            ? await c.quoteBuyExactTokens(amountWei)
            : await c.quoteSellExactTokens(amountWei);
          if (!cancelled) {
            setQuoteWei(q);
            if (tradeTab === "buy") setEffectiveBnbWei(q);
            else setEffectiveBnbWei(q);
          }
        }
      } catch (e: any) {
        console.warn("[TokenDetails] Quote failed", e);
        if (!cancelled) {
          setQuoteWei(null);
          setQuoteError(e?.message ?? "Failed to fetch quote");
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    };

    const t = setTimeout(loadQuote, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [readProvider, campaign?.campaign, campaign?.token, chainIdForStorage, metrics?.currentPrice, tradeTab, tradeAmount, tradeInputDenom, tokenBalanceWei, isDexStage, isTopazTradingActive, onChainLaunched, topazSlippageBps, unifiedMarket.state?.lastError, unifiedMarket.summary?.last_price_bnb, isSolanaPage, solanaCurve, contractGraduated, solanaCurveClosed, effectiveBnbWei, effectiveTokenWei]);

  const handlePlaceTrade = async () => {
    if (!campaign?.campaign) return;

    // ── Solana: bonding until close, then same click becomes a Meteora fill ─
    if (isSolanaPage) {
      try {
        setTradePending(true);
        const { getSolanaProvider } = await import("@/lib/solanaWallet");
        const {
          requestSolanaTradeAuthorization,
          submitSolanaTradeV1,
          ensureTraderAta,
          applySlippageMinOut,
        } = await import("@/lib/solanaTradeV1");

        const provider = getSolanaProvider();
        const trader = String(provider?.publicKey?.toString?.() || "");
        if (!trader) {
          toast({
            title: "Connect Solana wallet",
            description: "Connect Phantom / Solflare to trade Solana campaigns.",
          });
          window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
          return;
        }

        if (solanaCurve?.creator && trader === solanaCurve.creator) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (tradeTab === "buy" && solanaCurve.creatorBuyLockUntil > nowSec) {
            throw new Error(
              `Creator buy lock active until ${new Date(solanaCurve.creatorBuyLockUntil * 1000).toLocaleString()}. Use a different buyer wallet.`,
            );
          }
        }

        const mint = String(solanaCurve?.mint || campaign.token || campaign.campaign);
        const decimals = Number(solanaCurve?.tokenDecimals ?? 6);
        const scale = 10n ** BigInt(decimals);
        const campaignPda = String(
          solanaCurve?.campaignAddress || campaign.campaign || "",
        );

        // Buy: tradeAmount is SOL (tradeInputDenom "BNB" means native unit).
        // Sell: tradeAmount is tokens.
        let amountIn: bigint;
        let minOut: bigint;
        if (tradeTab === "buy") {
          const solStr = String(tradeAmount || "0").trim();
          if (tradeInputDenom === "BNB") {
            const solParts = solStr.split(".");
            const whole = BigInt(solParts[0] || "0");
            const frac = (solParts[1] || "").slice(0, 9).padEnd(9, "0");
            amountIn = whole * 1_000_000_000n + BigInt(frac || "0");
          } else {
            // Token-exact buy: use inverted quote as amountIn (SOL).
            amountIn = effectiveBnbWei > 0n ? effectiveBnbWei : 0n;
          }
          if (amountIn <= 0n) throw new Error("Enter a SOL amount to buy.");
          const estTokens = effectiveTokenWei > 0n ? effectiveTokenWei : 0n;
          minOut = applySlippageMinOut(estTokens, SLIPPAGE_PCT);
          toast({
            title: "Submitting Solana buy",
            description: `Exact ${ethers.formatUnits(amountIn, 9)} SOL in → min ${formatTokenFromWei(minOut)} tokens.`,
          });
        } else {
          if (tradeInputDenom === "BNB") {
            amountIn = effectiveTokenWei;
          } else {
            const tokStr = String(tradeAmount || "0").trim();
            const parts = tokStr.split(".");
            const whole = BigInt(parts[0] || "0");
            const frac = (parts[1] || "").slice(0, decimals).padEnd(decimals, "0");
            amountIn = whole * scale + BigInt(frac || "0");
          }
          if (amountIn <= 0n) throw new Error("Enter a token amount or target SOL payout to sell.");
          const estSol = quoteWei != null && quoteWei > 0n ? quoteWei : effectiveBnbWei;
          minOut = applySlippageMinOut(estSol > 0n ? estSol : 0n, SLIPPAGE_PCT);
          toast({
            title: "Submitting Solana sell",
            description: `Exact ${formatTokenFromWei(amountIn)} tokens in → min ${formatBnbFromWei(minOut)}.`,
          });
        }

        const queueDexTrade = () => {
          stashPendingSolanaDexTrade({
            campaignAddress: campaignPda,
            mint,
            side: tradeTab === "buy" ? "buy" : "sell",
            amountInRaw: amountIn.toString(),
            displayAmount: String(tradeAmount || "").trim(),
            tokenDecimals: decimals,
            createdAt: Date.now(),
          });
          void requestSolanaGraduationHandoff(campaignPda);
        };

        if (contractGraduated || solanaCurveClosed) {
          queueDexTrade();
          if (contractGraduated) {
            const { quoteSolanaMeteoraExactIn, executeSolanaMeteoraSwap } = await import("@/lib/solanaMeteoraTrade");
            toast({
              title: tradeTab === "buy" ? "Submitting Meteora buy" : "Submitting Meteora sell",
              description: "Using the verified DAMM v2 pool.",
            });
            const quote = await quoteSolanaMeteoraExactIn({
              side: tradeTab === "buy" ? "buy" : "sell",
              mint,
              tokenDecimals: decimals,
              amountInRaw: amountIn,
              slippagePct: SLIPPAGE_PCT,
            });
            const result = await executeSolanaMeteoraSwap({
              quote,
              mint,
              tokenDecimals: decimals,
              walletAddress: trader,
              poolAddress: quote.pool,
            });
            toast({
              title: tradeTab === "buy" ? "Buy confirmed" : "Sell confirmed",
              description: `Tx: ${result.signature.slice(0, 12)}…`,
            });
            try {
              const tokensOut = tradeTab === "buy" ? quote.amountOutRaw : amountIn;
              const nativeAmt = tradeTab === "buy" ? amountIn : quote.amountOutRaw;
              const tokenHuman = Number(ethers.formatUnits(tokensOut > 0n ? tokensOut : 1n, decimals));
              const solHuman = Number(ethers.formatUnits(nativeAmt > 0n ? nativeAmt : 0n, 9));
              const pricePerToken = tokenHuman > 0 ? solHuman / tokenHuman : 0;
              const point: CurveTradePoint = {
                type: tradeTab === "buy" ? "buy" : "sell",
                from: trader,
                to: mint,
                tokensWei: tokensOut,
                nativeWei: nativeAmt,
                pricePerToken: Number.isFinite(pricePerToken) ? pricePerToken : 0,
                venue: "dex",
                timestamp: Math.floor(Date.now() / 1000),
                txHash: result.signature,
                blockNumber: 0,
                logIndex: SYNTHETIC_LOG_INDEX_MIN,
              };
              const next = appendLocalTopazTrade(chainIdForStorage, campaignPda || mint, point);
              setLocalTopazTrades(next);
            } catch {
              // Chart point is best-effort.
            }
            setTradeAmount("0");
            setQuoteWei(null);
            setSolanaBalanceTick((n) => n + 1);
            return;
          }
          toast({
            title: "Opening Meteora",
            description: "Threshold reached. Your trade will send as soon as the pool is live.",
          });
          return;
        }

        await ensureTraderAta({ mint, owner: trader });

        const auth = await requestSolanaTradeAuthorization({
          side: tradeTab === "buy" ? "buy" : "sell",
          campaignAddress: campaignPda,
          mintAddress: mint,
          traderAddress: trader,
          amountIn,
          minOut,
          tokenVault: solanaCurve?.tokenVault || campaign.tokenVault || null,
          solVault: solanaCurve?.solVault || campaign.solVault || null,
          campaignId: solanaCurve?.campaignIdHex || campaign.campaignIdHex || null,
          chainId: SOLANA_CHAIN_ID,
        });
        const result = await submitSolanaTradeV1(auth, { traderAddress: trader });
        toast({
          title: tradeTab === "buy" ? "Buy confirmed" : "Sell confirmed",
          description: `Tx: ${result.signature.slice(0, 12)}…`,
        });

        // Optimistic trade point for chart + trades table (indexer Solana events later).
        try {
          const tokensOut =
            tradeTab === "buy"
              ? effectiveTokenWei > 0n
                ? effectiveTokenWei
                : 0n
              : amountIn;
          const nativeAmt = tradeTab === "buy" ? amountIn : quoteWei != null && quoteWei > 0n ? quoteWei : 0n;
          const tokenHuman = Number(ethers.formatUnits(tokensOut > 0n ? tokensOut : 1n, decimals));
          const solHuman = Number(ethers.formatUnits(nativeAmt > 0n ? nativeAmt : 0n, 9));
          const pricePerToken = tokenHuman > 0 ? solHuman / tokenHuman : 0;
          const point: CurveTradePoint = {
            type: tradeTab === "buy" ? "buy" : "sell",
            from: trader,
            to: mint,
            tokensWei: tokensOut,
            nativeWei: nativeAmt,
            pricePerToken: Number.isFinite(pricePerToken) ? pricePerToken : 0,
            soldTokensAfterRaw: solanaCurve?.soldTokens ?? null,
            venue: "curve",
            timestamp: Math.floor(Date.now() / 1000),
            txHash: result.signature,
            blockNumber: 0,
            logIndex: SYNTHETIC_LOG_INDEX_MIN + (localTopazTrades.length % 1000),
          };
          const storageKey = campaignPda || mint;
          const next = appendLocalTopazTrade(chainIdForStorage, storageKey, point);
          setLocalTopazTrades(next);
        } catch (histErr) {
          console.warn("[TokenDetails] solana local trade history", histErr);
        }

        setTradeAmount("0");
        setQuoteWei(null);
        setQuoteError(null);
        setEffectiveTokenWei(0n);
        setEffectiveBnbWei(0n);
        setSolanaBalanceTick((n) => n + 1);
        void requestSolanaGraduationHandoff(campaignPda);
      } catch (e: any) {
        console.error("[TokenDetails] Solana trade failed", e);
        if (isSolanaCurveClosedError(e)) {
          const campaignPda = String(solanaCurve?.campaignAddress || campaign.campaign || "");
          const mint = String(solanaCurve?.mint || campaign.token || campaign.campaign);
          const fallbackRaw =
            tradeTab === "buy"
              ? (effectiveBnbWei > 0n ? effectiveBnbWei : 0n)
              : (effectiveTokenWei > 0n ? effectiveTokenWei : 0n);
          stashPendingSolanaDexTrade({
            campaignAddress: campaignPda,
            mint,
            side: tradeTab === "buy" ? "buy" : "sell",
            amountInRaw: fallbackRaw.toString(),
            displayAmount: String(tradeAmount || "").trim(),
            tokenDecimals: Number(solanaCurve?.tokenDecimals ?? 6),
            createdAt: Date.now(),
          });
          void requestSolanaGraduationHandoff(campaignPda);
          toast({
            title: "Opening Meteora",
            description: "Threshold reached. Your trade will send as soon as the pool is live.",
          });
        } else {
          const { mapSolanaTradeError } = await import("@/lib/solanaTradeV1");
          toast({
            title: "Solana trade failed",
            description: mapSolanaTradeError(e),
            variant: "destructive",
          });
        }
      } finally {
        setTradePending(false);
      }
      return;
    }

    if (isDexStage) {
      if (!isTopazTradingActive || !campaign?.token) {
        toast({
          title: "Topaz market is not ready",
          description: unifiedMarket.state?.lastError || "The verified Topaz route is still being reconciled.",
          variant: "destructive",
        });
        return;
      }
      if (!wallet.signer || !wallet.account) {
        toast({ title: "Connect wallet", description: "Please connect your wallet to trade." });
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
        return;
      }
      try {
        setTradePending(true);
        const resolved = await resolveVerifiedTopazRoute({
          provider: readProvider,
          campaignAddress: campaign.campaign,
          expectedTokenAddress: campaign.token,
          chainId: chainIdForStorage,
        });
        let optimistic: CurveTradePoint | null = null;
        if (tradeTab === "buy") {
          const nativeAmountInRaw = tradeInputDenom === "BNB" ? parseBnbAmountWei(tradeAmount) : effectiveBnbWei;
          if (nativeAmountInRaw <= 0n) throw new Error(`Enter a valid ${nativeUnit} or token amount.`);
          if (bnbBalanceWei != null && nativeAmountInRaw > bnbBalanceWei) throw new Error(`Insufficient ${nativeUnit} balance.`);
          const quote = await quoteTopazBuy({
            provider: readProvider,
            resolved,
            nativeAmountInRaw,
            slippageBps: topazSlippageBps,
          });
          toast({
            title: "Submitting Topaz buy",
            description: `Minimum received: ${formatTokenFromWei(quote.minimumOutRaw)} ${tokenData.ticker}.`,
          });
          const tx = await executeTopazBuy({ signer: wallet.signer, recipient: wallet.account, quote });
          const receipt = await tx.wait();
          toast({
            title: "Buy confirmed",
            description: receipt?.hash ? `Tx: ${receipt.hash.slice(0, 10)}...` : "Transaction confirmed.",
          });
          const tokensOut = quote.amountOutRaw > 0n ? quote.amountOutRaw : quote.minimumOutRaw;
          const pricePerToken =
            tokensOut > 0n
              ? Number(ethers.formatEther(nativeAmountInRaw)) / Number(ethers.formatUnits(tokensOut, TOKEN_DECIMALS))
              : 0;
          optimistic = {
            type: "buy",
            from: String(wallet.account).toLowerCase(),
            to: String(campaign.token || "").toLowerCase(),
            tokensWei: tokensOut,
            nativeWei: nativeAmountInRaw,
            pricePerToken: Number.isFinite(pricePerToken) ? pricePerToken : 0,
            timestamp: Math.floor(Date.now() / 1000),
            txHash: String(receipt?.hash || tx?.hash || "").toLowerCase(),
            blockNumber: Number(receipt?.blockNumber || 0),
            logIndex: SYNTHETIC_LOG_INDEX_MIN,
          };
        } else {
          const tokenAmountInRaw = tradeInputDenom === "BNB" ? effectiveTokenWei : parseTokenAmountWei(tradeAmount);
          if (tokenAmountInRaw <= 0n) throw new Error(`Enter a valid token or ${nativeUnit} amount.`);
          if (tokenBalanceWei != null && tokenAmountInRaw > tokenBalanceWei) {
            throw new Error(`Insufficient ${tokenData.ticker} balance.`);
          }
          const quote = await quoteTopazSell({
            provider: readProvider,
            resolved,
            tokenAmountInRaw,
            slippageBps: topazSlippageBps,
          });
          const approval = await ensureTopazSellAllowance({
            signer: wallet.signer,
            owner: wallet.account,
            resolved,
            tokenAmountRaw: tokenAmountInRaw,
          });
          if (approval) {
            setApprovePending(true);
            toast({
              title: "Approval required",
              description: `Approving the verified Topaz router for ${tokenData.ticker}...`,
            });
            await approval.wait();
            setApprovePending(false);
          }
          toast({
            title: "Submitting Topaz sell",
            description: `Minimum received: ${formatBnbFromWei(quote.minimumOutRaw)}.`,
          });
          const tx = await executeTopazSell({ signer: wallet.signer, recipient: wallet.account, quote });
          const receipt = await tx.wait();
          toast({
            title: "Sell confirmed",
            description: receipt?.hash ? `Tx: ${receipt.hash.slice(0, 10)}...` : "Transaction confirmed.",
          });
          const nativeOut = quote.amountOutRaw > 0n ? quote.amountOutRaw : quote.minimumOutRaw;
          const pricePerToken =
            tokenAmountInRaw > 0n
              ? Number(ethers.formatEther(nativeOut)) / Number(ethers.formatUnits(tokenAmountInRaw, TOKEN_DECIMALS))
              : 0;
          optimistic = {
            type: "sell",
            from: String(wallet.account).toLowerCase(),
            to: String(wallet.account).toLowerCase(),
            tokensWei: tokenAmountInRaw,
            nativeWei: nativeOut,
            pricePerToken: Number.isFinite(pricePerToken) ? pricePerToken : 0,
            timestamp: Math.floor(Date.now() / 1000),
            txHash: String(receipt?.hash || tx?.hash || "").toLowerCase(),
            blockNumber: Number(receipt?.blockNumber || 0),
            // Synthetic logIndex: real pool log is preferred when available (see mergeTradePoints).
            logIndex: SYNTHETIC_LOG_INDEX_MIN,
          };
        }
        if (optimistic?.txHash && resolvedCampaignAddress) {
          const next = appendLocalTopazTrade(chainIdForStorage, resolvedCampaignAddress, optimistic);
          setLocalTopazTrades(next);
          // Persist to frontend API so Topaz fills survive reloads without eth_getLogs.
          void reportTopazTrade({
            chainId: chainIdForStorage,
            campaignAddress: resolvedCampaignAddress,
            side: optimistic.type,
            txHash: optimistic.txHash,
            tokenAmountRaw: optimistic.tokensWei.toString(),
            nativeAmountRaw: optimistic.nativeWei.toString(),
            wallet: wallet.account || undefined,
            pairAddress: topazMarket.pairAddress,
            blockNumber: optimistic.blockNumber || null,
            logIndex: SYNTHETIC_LOG_INDEX_MIN,
            blockTime: new Date((optimistic.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          });
        }
        try {
          await unifiedMarket.refresh();
        } catch {
          // Market API may still be disabled during rollout.
        }
        try {
          await topazMarket.refresh();
        } catch {
          // Pool metrics refresh is best-effort (reserves/price).
        }
        const [bnbBal, tokenBal] = await Promise.all([
          readProvider.getBalance(wallet.account),
          (new Contract(campaign.token, TOKEN_ABI, readProvider) as any).balanceOf(wallet.account),
        ]);
        setBnbBalanceWei(bnbBal);
        setTokenBalanceWei(tokenBal);
        setTradeAmount("0");
      } catch (e: any) {
        console.error("[TokenDetails] Topaz trade failed", e);
        toast({
          title: "Trade failed",
          description: e?.shortMessage || e?.message || "Topaz trade failed.",
          variant: "destructive",
        });
      } finally {
        setApprovePending(false);
        setTradePending(false);
      }
      return;
    }

    const amountWei = tradeInputDenom === "BNB" ? effectiveTokenWei : parseTokenAmountWei(tradeAmount);
    const inputBnbWei = tradeInputDenom === "BNB" ? effectiveBnbWei : 0n;
    if (amountWei <= 0n) {
      toast({
        title: "Invalid amount",
        description: tradeInputDenom === "BNB" ? `Enter a ${nativeUnit} amount greater than 0.` : `Enter a ${tokenData.ticker} amount greater than 0.`,
        variant: "destructive",
      });
      return;
    }

    try {
      // Balance sanity checks (best-effort)
      if (!isDexStage && tradeTab === "sell" && tokenBalanceWei != null && amountWei > tokenBalanceWei) {
        toast({
          title: "Insufficient token balance",
          description: `You do not have enough ${tokenData.ticker} to sell that amount.`,
          variant: "destructive",
        });
        return;
      }

      if (!isDexStage && tradeTab === "buy" && bnbBalanceWei != null) {
        const baseCostWei = quoteWei && quoteWei > 0n ? quoteWei : tradeInputDenom === "BNB" ? inputBnbWei : 0n;
        if (baseCostWei > 0n) {
          const maxCostWei = (baseCostWei * BigInt(100 + SLIPPAGE_PCT)) / 100n;
          if (maxCostWei > bnbBalanceWei) {
            toast({
              title: `Insufficient ${nativeUnit}`,
              description: `You need ~${formatBnbFromWei(maxCostWei)} to place this buy.`,
              variant: "destructive",
            });
            return;
          }
        }
      }

      // Ensure wallet is connected for writes
      if (!wallet.signer || !wallet.account) {
        toast({
          title: "Connect wallet",
          description: "Please connect your wallet to trade.",
        });
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
        return;
      }

      setTradePending(true);

      if (tradeTab === "buy") {
        let costWei = quoteWei && quoteWei > 0n ? quoteWei : tradeInputDenom === "BNB" ? inputBnbWei : null;

        if (amountWei > 0n && (costWei == null || costWei === 0n)) {
          const c = new Contract(campaign.campaign, CAMPAIGN_ABI, readProvider) as any;
          costWei = await c.quoteBuyExactTokens(amountWei);
        }
        if (costWei == null || costWei <= 0n) {
          toast({
            title: "Quote unavailable",
            description: "Could not price this buy. Try again in a moment.",
            variant: "destructive",
          });
          return;
        }
        // Always allow 5% headroom — BNB mode previously sent exact cost and could
        // revert on micro rounding / fee drift.
        const maxCostWei = (costWei * BigInt(100 + SLIPPAGE_PCT)) / 100n;

        toast({
          title: "Submitting buy",
          description: `Buying ~${formatTokenFromWei(amountWei)} ${tokenData.ticker} for up to ${formatBnbFromWei(maxCostWei)}.`,
        });

        const receipt: any = await buyTokens(campaign.campaign, amountWei, maxCostWei);

        toast({
          title: "Buy confirmed",
          description: (receipt?.hash || receipt?.transactionHash)
            ? `Tx: ${String(receipt.hash || receipt.transactionHash).slice(0, 10)}...`
            : "Transaction confirmed.",
        });
      } else {
        let payoutWei = tradeInputDenom === "BNB" ? inputBnbWei : quoteWei;
        if (amountWei > 0n && (payoutWei == null || payoutWei === 0n)) {
  const c = new Contract(
    campaign.campaign,
    CAMPAIGN_ABI,
    readProvider
  ) as any;

  payoutWei = await c.quoteSellExactTokens(amountWei);
}

        const minPayoutWei = (payoutWei * BigInt(100 - SLIPPAGE_PCT)) / 100n;

        if (campaign?.token) {
  const token = new Contract(campaign.token, TOKEN_ABI, wallet.signer) as any;
  const allowance: bigint = await token.allowance(wallet.account, campaign.campaign);

  if (allowance < amountWei) {
    setApprovePending(true);
    toast({
      title: "Approval required",
      description: `Approving ${tokenData.ticker} for selling...`,
    });

    const tx = await token.approve(campaign.campaign, MAX_UINT256);
    await tx.wait();

    setApprovePending(false);
  }
}

        toast({
          title: "Submitting sell",
          description: `Selling ${ethers.formatUnits(amountWei, TOKEN_DECIMALS)} ${tokenData.ticker} (min ${formatBnbFromWei(minPayoutWei)}).`,
        });

        const receipt: any = await sellTokens(campaign.campaign, amountWei, minPayoutWei);

        toast({
          title: "Sell confirmed",
          description: (receipt?.hash || receipt?.transactionHash)
            ? `Tx: ${String(receipt.hash || receipt.transactionHash).slice(0, 10)}...`
            : "Transaction confirmed.",
        });
      }

      // Refresh headline stats + balances. Summary can lag the curve; read metrics
      // directly so 5m/1h tiles close on the post-sell spot.
      try {
        const [s, nextMetrics] = await Promise.all([
          fetchCampaignSummary(campaign).catch(() => null),
          fetchCampaignMetrics(campaign.campaign).catch(() => null),
        ]);
        if (s) {
          setSummary(s);
          if (s.metrics) setMetrics(s.metrics);
        }
        if (nextMetrics) setMetrics(nextMetrics);
      } catch {
        // ignore
      }

      try {
        if (campaign?.campaign) {
          const bal = await readProvider.getBalance(campaign.campaign);
          setCurveReserveWei(bal);
        }
      } catch {
        // ignore
      }

      try {
        if (wallet.account && campaign?.token) {
          const [bnbBal, tokenBal] = await Promise.all([
            readProvider.getBalance(wallet.account),
            (async () => {
              try {
                const t = new Contract(campaign.token, TOKEN_ABI, readProvider) as any;
                return (await t.balanceOf(wallet.account)) as bigint;
              } catch {
                return 0n;
              }
            })(),
          ]);
          setBnbBalanceWei(bnbBal);
          setTokenBalanceWei(tokenBal);
        }
      } catch {
        // ignore
      }

      setTradeAmount("0");
    } catch (e: any) {
      console.error("[TokenDetails] Trade failed", e);
      toast({
        title: "Trade failed",
        description: describeTradeError(e),
        variant: "destructive",
      });
    } finally {
      setApprovePending(false);
      setTradePending(false);
    }
  };

  const copyAddress = (address?: string, label = "Address") => {
    if (!address) return;

    navigator.clipboard.writeText(address);
    toast({
      title: "Copied!",
      description: `${label} copied to clipboard`,
    });
  };

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center px-4">
        <Card className="p-4 md:p-6 bg-card/40 border border-border/40 max-w-md w-full text-center">
          <h2 className="text-sm md:text-base font-semibold mb-2">{error}</h2>
          <p className="text-xs md:text-sm text-muted-foreground">
            {error === "No token data"
              ? "There are no campaigns available yet."
              : "Please go back to the main page and select another token."}
          </p>
        </Card>
      </div>
    );
  }

  if (loading && !campaign) {
    return (
      <div className="flex h-full min-h-[60dvh] w-full items-center justify-center bg-black px-4">
        <RadarLoader label="Scanning token dossier…" size="md" />
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col px-3 md:px-6 gap-3 md:gap-4">
      <div className="lg:hidden sticky top-[4.5rem] z-20 -mx-3 px-3 py-2 bg-background/95 backdrop-blur border-b border-border/40 flex items-center gap-2 shrink-0">
        <img
          src={tokenData.image}
          alt={tokenData.ticker}
          onError={(event) => {
            event.currentTarget.src = "/placeholder.svg";
          }}
          className="h-9 w-9 rounded-lg object-cover bg-muted/30 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-retro text-sm text-foreground truncate">{tokenData.name}</span>
            <span className="text-[11px] text-muted-foreground font-mono shrink-0">{tokenData.ticker}</span>
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{marketCapDisplay}</div>
        </div>
      </div>
      <GraduationExplosion
        campaignAddress={campaign?.campaign}
        active={isSolanaPage ? false : isTopazTradingActive}
        transitionAt={
          isSolanaPage
            ? solanaGraduationTransitionAt
            : unifiedMarket.stageTransition?.to === "TOPAZ_ACTIVE"
              ? unifiedMarket.stageTransition.at
              : null
        }
        venueLabel={isSolanaPage ? "Meteora DAMM v2" : "Topaz"}
      />
      <Card className="overflow-hidden bg-card/30 backdrop-blur-md rounded-2xl border border-border p-0 xl:min-h-[220px] shrink-0">
        <div className="grid grid-cols-1 xl:grid-cols-[220px_minmax(0,1fr)] items-stretch xl:min-h-[220px]">
          <div className="relative min-h-[180px] bg-muted/20 xl:min-h-[220px] overflow-hidden shrink-0">
            <img
              src={tokenData.image}
              alt={tokenData.ticker}
              onError={(event) => {
                event.currentTarget.src = "/placeholder.svg";
              }}
              className="h-full w-full object-contain object-center"
            />
          </div>

          <div className="min-w-0 flex flex-col justify-start gap-2 p-3 md:p-4 xl:p-5">
            <div className="rounded-2xl border border-border/60 bg-muted/15 px-4 py-2.5 md:px-4 md:py-2.5 min-h-0">
              <div className="flex flex-wrap items-center gap-2 md:gap-2.5 xl:flex-nowrap xl:justify-start xl:gap-2 xl:overflow-x-auto">
                <h1 className="text-lg md:text-2xl font-retro text-foreground whitespace-nowrap">
                  {tokenData.name}
                </h1>

                <span className="text-xs md:text-sm text-muted-foreground font-mono whitespace-nowrap">
                  {tokenData.ticker}
                </span>

                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap ${
                    isDexStage
                      ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40"
                      : "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                  }`}
                >
                  {stagePill}
                </span>

                {(() => {
                  const creator = String(campaign?.creator ?? "").trim();
                  if (!creator) return null;

                  const display =
                    (creatorProfile?.displayName
                      ? String(creatorProfile.displayName).trim()
                      : "") || shortenAddress(creator);

                  const createdLabel = campaign?.createdAt
                    ? formatTimeAgo(campaign.createdAt)
                    : campaign?.timeAgo
                    ? `${campaign.timeAgo}${String(campaign.timeAgo).includes("ago") ? "" : " ago"}`
                    : "—";

                  const initial = display ? display.slice(0, 1).toUpperCase() : "C";

                  return (
                    <>
                      <Link
                        to={`/profile?address=${creator}`}
                        className="inline-flex items-center gap-2 hover:opacity-90 transition-opacity max-w-[220px] flex-shrink-0"
                      >
                        <Avatar className="h-6 w-6">
                          <AvatarImage
                            src={creatorProfile?.avatarUrl || undefined}
                            alt={display}
                          />
                          <AvatarFallback className="text-[10px]">
                            {initial}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-[11px] md:text-xs text-foreground/90 truncate">{display}</span>
                      </Link>

                      {tokenData.hasWebsite && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 p-0 hover:bg-muted/50 flex-shrink-0"
                          onClick={() => {
                            const url = normalizeSocialUrl(campaign?.website, "website");
                            if (url) window.open(url, "_blank", "noopener,noreferrer");
                          }}
                          title="Website"
                          aria-label="Open website"
                        >
                          <Globe className="h-4 w-4" />
                        </Button>
                      )}

                      {tokenData.hasTwitter && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 p-0 hover:bg-muted/50 flex-shrink-0"
                          onClick={() => {
                            const url = normalizeSocialUrl(campaign?.xAccount, "x");
                            if (url) window.open(url, "_blank", "noopener,noreferrer");
                          }}
                          title="X"
                          aria-label="Open X profile"
                        >
                          <img
                            src={twitterIcon}
                            alt="X"
                            className="h-4 w-4"
                          />
                        </Button>
                      )}

                      {tokenData.hasTelegram && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 font-retro text-[10px] hover:bg-muted/50 flex-shrink-0"
                          onClick={() => {
                            const url = normalizeSocialUrl(campaign?.telegram, "telegram");
                            if (url) window.open(url, "_blank", "noopener,noreferrer");
                          }}
                        >
                          TG
                        </Button>
                      )}

                      {tokenData.hasDiscord && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 font-retro text-[10px] hover:bg-muted/50 flex-shrink-0"
                          onClick={() => {
                            const url = normalizeSocialUrl(campaign?.discord, "discord");
                            if (url) window.open(url, "_blank", "noopener,noreferrer");
                          }}
                        >
                          DC
                        </Button>
                      )}

                      {tokenData.hasOtherLink && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 p-0 hover:bg-muted/50 flex-shrink-0"
                          onClick={() => {
                            const url = normalizeSocialUrl(campaign?.extraLink, "other");
                            if (url) window.open(url, "_blank", "noopener,noreferrer");
                          }}
                          title="External link"
                          aria-label="Open external link"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      )}

                      <span className="text-[11px] md:text-xs text-muted-foreground whitespace-nowrap">
                        {createdLabel}
                      </span>
                    </>
                  );
                })()}

                <button
                  type="button"
                  onClick={() => copyAddress(campaign?.token, "Token contract address")}
                  className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/20 px-2 py-1 hover:bg-muted/35 transition-colors flex-shrink-0"
                  title="Copy ERC-20 token contract address"
                >
                  <span className="font-mono text-[11px] md:text-xs whitespace-nowrap">
                    {shortenAddress(campaign?.token ?? "") || "—"}
                  </span>
                  <Copy className="h-3 w-3" />
                </button>

                {campaignAddr ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="h-8 w-8 rounded-xl flex-shrink-0"
                      onClick={toggleFollow}
                      disabled={followBusy}
                      aria-label={isFollowing ? "Unfollow campaign" : "Follow campaign"}
                      title={isFollowing ? "Unfollow" : "Follow"}
                    >
                      <Star
                        className={
                          isFollowing
                            ? "text-accent fill-accent scale-110 drop-shadow-[0_0_10px_rgba(240,106,26,0.38)]"
                            : "text-muted-foreground/70"
                        }
                      />
                    </Button>

                    {/* UP Vote: same product on BNB (treasury) and Solana (SOL + vote-ingest). */}
                    <UpvoteDialog
                      campaignAddress={campaignAddr}
                      chainId={chainIdForStorage}
                      buttonVariant="secondary"
                      buttonSize="sm"
                      className="h-8 px-3 text-xs flex-shrink-0"
                    />
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-[11px] text-muted-foreground flex-shrink-0"
                    >
                      <Link
                        to={buildAbuseReportPath({
                          entityType: "campaign",
                          reportedCampaignAddress: campaignAddr,
                          reportedTokenAddress: String(campaign?.token || ""),
                          reportedWallet: String(campaign?.creator || ""),
                          reportedUrl: typeof window !== "undefined" ? window.location.href : `/token/${campaignAddr}`,
                        })}
                      >
                        <Flag className="mr-1 h-3.5 w-3.5" />
                        Report
                      </Link>
                    </Button>

                    {/* CrypticPump badge / list CTA sits to the right of upvote */}
                    {crypticPumpListing?.listingUrl ? (
                      <CrypticPumpBadge
                        listingUrl={crypticPumpListing.listingUrl}
                        className="flex-shrink-0 self-center"
                      />
                    ) : (
                      (() => {
                        const creator = String(campaign?.creator ?? "").trim().toLowerCase();
                        const me = String(wallet.account ?? "").trim().toLowerCase();
                        const isCreator = Boolean(creator && me && creator === me);
                        if (!isCreator) return null;
                        const campaignKey = String(campaign?.campaign ?? campaignAddr ?? "").trim();
                        if (!campaignKey) return null;
                        return (
                          <CrypticPumpListButton
                            className="flex-shrink-0 self-center"
                            chainId={Number(chainIdForStorage || 56)}
                            campaignAddress={campaignKey}
                            tokenAddress={campaign?.token || null}
                            name={tokenData.name}
                            ticker={tokenData.ticker}
                            website={campaign?.website || null}
                            creatorWallet={String(wallet.account)}
                            listing={crypticPumpListing}
                            onListed={setCrypticPumpListing}
                          />
                        );
                      })()
                    )}
                  </>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:w-full xl:max-w-[920px] xl:grid-cols-5">
              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Market cap</p>
                <p className="mt-0.5 text-sm md:text-[15px] font-retro text-foreground break-words">{marketCapDisplay}</p>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Price</p>
                <p className="mt-0.5 text-sm md:text-[15px] font-retro text-foreground break-words">{priceDisplay}</p>
                <p className="mt-0.5 text-[10px] md:text-[11px] text-muted-foreground">Spot</p>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Volume</p>
                <p className="mt-0.5 text-sm md:text-[15px] font-retro text-foreground break-words">{volumeDisplay}</p>
                <p className="mt-0.5 text-[10px] md:text-[11px] text-muted-foreground">Window {selectedTimeframe}</p>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{liquidityLabel}</p>
                <p className="mt-0.5 text-sm md:text-[15px] font-retro text-foreground break-words">{liquidityDisplay}</p>
                {!isDexStage ? (
                  <p className="mt-0.5 text-[10px] md:text-[11px] text-muted-foreground">Remaining {remainingCurveLabel.primary}</p>
                ) : (
                  <p className="mt-0.5 text-[10px] md:text-[11px] text-muted-foreground">Stage {stagePill}</p>
                )}
              </div>

              <div className="rounded-xl border border-border bg-muted/20 px-3 py-2 col-span-2 md:col-span-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Holders</p>
                <p className="mt-0.5 text-sm md:text-[15px] font-retro text-foreground">{tokenData.holders}</p>
                <p className="mt-0.5 text-[10px] md:text-[11px] text-muted-foreground">Buyers {flywheel.buyers}</p>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-3 md:gap-4 items-start">
        <div className="min-w-0 flex flex-col gap-3 md:gap-4">
          <Card
            className={`bg-card/30 backdrop-blur-md rounded-2xl border border-border p-0 overflow-hidden flex flex-col ${chartExpanded ? "h-auto min-h-[640px] md:min-h-[720px] xl:min-h-[760px]" : "min-h-[360px] h-[360px] md:min-h-[420px] md:h-[420px] xl:min-h-[520px] xl:h-[520px]"}`}
          >
            <div className="flex flex-col gap-2 px-4 py-2 border-b border-border/40 bg-card/20">
              <AthBar
                currentLabel={marketCapUsdLabel ?? undefined}
                canonicalAthUsd={canonicalAthUsd(
                  liveMarketCapNative != null && nativeUsd ? liveMarketCapNative * nativeUsd : 0,
                  nativeUsd
                    ? canonicalAthNativeFromCandles(unifiedMarket.candles, liveMarketCapNative ?? 0) * nativeUsd
                    : 0,
                )}
                storageKey={`ath:${String(chainIdForStorage)}:${isSolanaPage ? String((campaignAddress ?? campaign?.campaign ?? "")) : String((campaignAddress ?? campaign?.campaign ?? "")).toLowerCase()}`}
                className="w-full min-w-0"
              />
              <div className="flex min-w-0 flex-col gap-2 w-full xl:flex-row xl:items-center xl:justify-between">
              <div className="flex items-center gap-2 min-w-0 shrink-0">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
                    isDexStage
                      ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40"
                      : "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                  }`}
                >
                  {stagePill}
                </span>
              </div>
                <div className="flex flex-wrap items-center gap-1.5 xl:flex-nowrap xl:justify-end">
                  {Object.entries(tokenData.metrics).map(([key, data]) => {
                    const ch = (data as any).change as number | null;
                    return (
                      <Button
                        key={key}
                        type="button"
                        variant={selectedTimeframe === key ? "secondary" : "ghost"}
                        size="sm"
                        className="h-7 rounded-lg px-2.5 text-[10px] md:text-[11px]"
                        onClick={() => setSelectedTimeframe(key as "5m" | "1h" | "4h" | "24h")}
                      >
                        <span className="text-muted-foreground mr-1.5">{key}</span>
                        <span
                          className={
                            ch == null
                              ? "text-muted-foreground"
                              : ch > 0
                              ? "text-emerald-400"
                              : ch < 0
                              ? "text-red-400"
                              : "text-muted-foreground"
                          }
                        >
                          {ch == null
                            ? "—"
                            : `${ch > 0 ? "▲" : ch < 0 ? "▼" : "•"} ${Math.abs(ch).toFixed(2)}%`}
                        </span>
                      </Button>
                    );
                  })}

                  {/* Always available — memecoin traders price mcap in USD by default. */}
                  <div className="inline-flex items-center gap-0 rounded-lg border border-border/40 bg-muted/25 p-1 shrink-0">
                    <Button
                      size="sm"
                      variant={displayDenom === "USD" ? "secondary" : "ghost"}
                      className="h-6 px-2.5 text-[10px] md:text-[11px]"
                      onClick={() => setDisplayDenom("USD")}
                    >
                      USD
                    </Button>
                    <Button
                      size="sm"
                      variant={displayDenom === "BNB" ? "secondary" : "ghost"}
                      className="h-6 px-2.5 text-[10px] md:text-[11px]"
                      onClick={() => setDisplayDenom("BNB")}
                    >
                      {nativeUnit}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              <div className={chartExpanded ? "w-full min-h-[560px] md:min-h-[640px]" : "w-full h-full min-h-[260px]"}>
                {/* Continuous chart: bonding curve history always; Topaz candles when market API is enabled. */}
                <UnifiedMarketChart
                  curvePoints={marketTradePoints}
                  marketCandles={unifiedMarket.candles}
                  marketState={unifiedMarket.state}
                  serverTime={unifiedMarket.serverTime}
                  graduationMarker={unifiedMarket.graduationMarker || solanaGraduationMarker}
                  creatorAddress={campaign?.creator}
                  creatorAvatarUrl={creatorProfile?.avatarUrl}
                  creatorDisplayName={creatorProfile?.displayName}
                  chainId={chainIdForStorage}
                  currentBondingSoldRaw={isSolanaPage ? solanaCurve?.soldTokens ?? null : metrics?.sold ?? null}
                  solanaCurvePricing={isSolanaPage ? solanaCurve : null}
                  solanaGraduated={Boolean(isSolanaPage && solanaCurve?.graduated)}
                  livePriceNative={pageLivePriceNative}
                  liveSupplyWhole={pageLiveSupplyWhole}
                  nativeUsdPrice={nativeUsd}
                  marketKey={`${chainIdForStorage}:${resolvedCampaignAddress || localTradeStorageAddress || ""}`}
                  expanded={chartExpanded}
                  onExpandedChange={setChartExpanded}
                  resolution={marketResolution}
                  onResolutionChange={setMarketResolution}
                  denomination={displayDenom}
                  historyReady={!unifiedMarket.loading}
                  loading={unifiedMarket.loading || ((marketTradePoints?.length ?? 0) === 0 && liveCurveLoading)}
                  error={unifiedMarket.error || ((marketTradePoints?.length ?? 0) > 0 ? null : liveCurveError || topazMarket.error)}
                />
              </div>
            </div>
          </Card>

          <Card className="bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4">
            <Tabs
              value={activityTab}
              onValueChange={(v) => setActivityTab(v as any)}
              className="h-full flex flex-col min-h-0"
            >
              <TabsList className="grid w-full grid-cols-3 mb-3 bg-transparent p-0 h-auto gap-2">
                <TabsTrigger value="overview" className={ctaTabsTriggerClass}>Overview</TabsTrigger>
                <TabsTrigger value="trades" className={ctaTabsTriggerClass}>Trades</TabsTrigger>
                <TabsTrigger value="comments" className={ctaTabsTriggerClass}>Community</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-0">
                <Accordion
                  type="multiple"
                  value={intelSections}
                  onValueChange={setIntelSections}
                  className="space-y-3"
                >
                  <AccordionItem value="campaign" className="rounded-2xl border border-border bg-muted/10 px-4">
                    <AccordionTrigger className="py-4 text-sm font-retro text-foreground hover:no-underline">
                      Campaign Intel
                    </AccordionTrigger>
                    <AccordionContent className="pb-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Creator</p>
                          <p className="mt-1 text-sm font-retro text-foreground break-words">
                            {creatorProfile?.displayName?.trim() || shortenAddress(campaign?.creator) || "—"}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Deployed</p>
                          <p className="mt-1 text-sm font-retro text-foreground">
                            {formatDeployedDate(campaign?.createdAt, campaign?.timeAgo)}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Stage</p>
                          <p className="mt-1 text-sm font-retro text-foreground">{stagePill}</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Token contract</p>
                          <div className="mt-1 flex items-center gap-2 min-w-0">
                            <span className="text-sm font-mono text-foreground truncate">{shortenAddress(campaign?.token ?? "") || "—"}</span>
                            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => copyAddress(campaign?.token, "Token contract address")}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Curve progress</p>
                          <p className="mt-1 text-sm font-retro text-foreground">{curveProgress.pct.toFixed(2)}%</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Remaining to graduate</p>
                          <p className="mt-1 text-sm font-retro text-foreground break-words">{remainingCurveLabel.primary}</p>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="flywheel" className="rounded-2xl border border-border bg-muted/10 px-4">
                    <AccordionTrigger className="py-4 text-sm font-retro text-foreground hover:no-underline">
                      Flywheel
                    </AccordionTrigger>
                    <AccordionContent className="pb-4">
                      <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Buy volume</p>
                          <p className="text-lg font-retro text-foreground">{flywheel.buyVolume}</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Sell volume</p>
                          <p className="text-lg font-retro text-foreground">{flywheel.sellVolume}</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Net flow</p>
                          <p className="text-lg font-retro text-foreground">{flywheel.netFlow}</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Protocol fees (est.)</p>
                          <p className="text-lg font-retro text-foreground">{flywheel.feesEstimated}</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Buyers</p>
                          <p className="text-lg font-retro text-foreground">{flywheel.buyers}</p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Protocol fee rate</p>
                          <p className="text-lg font-retro text-foreground">{flywheel.feeRate}</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3">
                        Volumes and buyer count come from on-chain counters when available. Fees are estimated from protocol fee basis points.
                      </p>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="holders" className="rounded-2xl border border-border bg-muted/10 px-4">
                    <AccordionTrigger className="py-4 text-sm font-retro text-foreground hover:no-underline">
                      Holder Distribution
                    </AccordionTrigger>
                    <AccordionContent className="pb-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs text-muted-foreground">{holderDistribution.totalHolders} holders</span>
                        <span className="text-xs text-muted-foreground">
                          {holderDistribution.source === "onchain"
                            ? "On-chain token accounts"
                            : "Estimated from bonding-curve trades"}
                        </span>
                      </div>

                      {holderDistribution.top.length ? (
                        <div className="space-y-3 overflow-auto min-h-0 pr-1">
                          {holderDistribution.top.map((h, idx) => {
                            const rank = h.isLp ? null : holderDistribution.hasLp ? idx : idx + 1;

                            return (
                              <div key={h.address} className="space-y-1">
                                <div className="flex items-center justify-between text-xs gap-2">
                                  <span className="font-mono min-w-0 truncate">
                                    {rank != null ? `${rank}. ` : ""}

                                    {h.isLp ? (
                                      <span className="text-foreground">{h.label}</span>
                                    ) : (
                                      <Link
                                        to={`/profile?address=${h.address}`}
                                        className="text-foreground hover:underline underline-offset-4"
                                      >
                                        {h.label}
                                      </Link>
                                    )}
                                  </span>
                                  <span className="font-mono text-muted-foreground flex-shrink-0">{h.pct.toFixed(2)}%</span>
                                </div>
                                <Progress value={h.pct} className="h-1.5" />
                              </div>
                            );
                          })}
                          {holderDistribution.othersPct > 0 ? (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="font-mono">Others</span>
                                <span className="font-mono text-muted-foreground">{holderDistribution.othersPct.toFixed(2)}%</span>
                              </div>
                              <Progress value={holderDistribution.othersPct} className="h-1.5" />
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">No holder data yet.</div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </TabsContent>

              <TabsContent value="comments" className="mt-0">
                <Tabs value={communityTab} onValueChange={(v) => setCommunityTab(v as any)} className="h-full flex flex-col min-h-0 gap-3">
                  <TabsList className="grid w-full grid-cols-2 bg-transparent p-0 h-auto gap-2">
                    <TabsTrigger value="comments" className={ctaTabsTriggerClass}>Comments</TabsTrigger>
                    <TabsTrigger value="updates" className={ctaTabsTriggerClass}>Creator Updates</TabsTrigger>
                  </TabsList>

                  <TabsContent value="comments" className="mt-0 min-h-0">
                    {campaign?.campaign ? (
                      <TokenComments
                        chainId={chainIdForStorage}
                        campaignAddress={campaign.campaign}
                        tokenAddress={campaign.token}
                      />
                    ) : (
                      <div className="text-sm text-muted-foreground">Loading comments…</div>
                    )}
                  </TabsContent>

                  <TabsContent value="updates" className="mt-0 min-h-0">
                    {campaign?.campaign ? (
                      <TokenComments
                        chainId={chainIdForStorage}
                        campaignAddress={campaign.campaign}
                        tokenAddress={campaign.token}
                        mode="updates"
                        authorFilterAddress={campaign.creator}
                        hideComposer
                        pollIntervalMs={15000}
                      />
                    ) : (
                      <div className="text-sm text-muted-foreground">Loading creator updates…</div>
                    )}
                  </TabsContent>
                </Tabs>
              </TabsContent>

              <TabsContent value="trades" className="mt-0">
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card/60 backdrop-blur border-b border-border">
                      <tr>
                        <th className="text-left py-3 px-3 font-medium text-muted-foreground">Account</th>
                        <th className="text-left py-3 px-3 font-medium text-muted-foreground">Type</th>
                        <th className="text-left py-3 px-3 font-medium text-muted-foreground">{nativeUnit}</th>
                        <th className="text-left py-3 px-3 font-medium text-muted-foreground">Token</th>
                        <th className="text-left py-3 px-3 font-medium text-muted-foreground">Time</th>
                        <th className="text-right py-3 px-3 font-medium text-muted-foreground">Txn</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txs.map((tx) => {
                        const addr = normalizeProfileAddressKey(tx.makerAddress, chainIdForStorage);
                        const prof = addr ? makerProfiles[addr] : null;
                        const avatar = prof?.avatarUrl || "/placeholder.svg";
                        const label = (prof?.displayName && prof.displayName.trim().length)
                          ? prof.displayName.trim()
                          : tx.maker;

                        const explorer = getExplorerBase(chainIdForStorage);
                        const txLabel = tx.txHash ? `${tx.txHash.slice(0, 6)}…${tx.txHash.slice(-4)}` : "—";
                        const txUrl = tx.txHash
                          ? isSolanaPage
                            ? `https://explorer.solana.com/tx/${tx.txHash}`
                            : `${explorer}/tx/${tx.txHash}`
                          : "";

                        return (
                          <tr key={tx.id} className="border-b border-border/40 hover:bg-muted/20">
                            <td className="py-3 px-3">
                              {tx.makerAddress ? (
                                <Link
                                  to={`/profile?address=${tx.makerAddress}`}
                                  className="flex items-center gap-2 min-w-0"
                                >
                                  <img
                                    src={avatar}
                                    alt={label}
                                    onError={(e) => {
                                      (e.currentTarget as HTMLImageElement).src = "/placeholder.svg";
                                    }}
                                    className="h-7 w-7 rounded-full ring-1 ring-border/30 flex-shrink-0"
                                  />
                                  <span className="font-mono text-foreground truncate max-w-[140px]">
                                    {label}
                                  </span>
                                </Link>
                              ) : (
                                <span className="font-mono text-muted-foreground">—</span>
                              )}
                            </td>

                            <td className="py-3 px-3">
                              <span
                                className={`font-medium ${tx.type === "buy" ? "text-emerald-400" : "text-red-400"}`}
                              >
                                {tx.type === "buy" ? "Buy" : "Sell"}
                              </span>
                            </td>

                            <td className="py-3 px-3 font-mono text-foreground">{tx.bnb}</td>

                            <td className="py-3 px-3 font-mono">
                              <span className={tx.type === "buy" ? "text-emerald-300" : "text-red-300"}>
                                {tx.amount}
                              </span>
                            </td>

                            <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{tx.time}</td>

                            <td className="py-3 px-3 text-right">
                              {txUrl ? (
                                <a
                                  href={txUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono text-muted-foreground hover:text-foreground hover:underline underline-offset-4"
                                >
                                  {txLabel}
                                </a>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {txs.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                            No trades yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        <div className="xl:sticky xl:top-[80px] xl:-mt-px self-start">
          <Card className="bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4">
            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="text-sm font-semibold">Graduation progress</h3>
                  <span className="text-xs text-muted-foreground">
                    {contractGraduated
                      ? "Graduated"
                      : solanaCurveClosed || curveProgress.matured
                        ? "Eligible"
                      : curveProgress.pct > 0 && curveProgress.pct < 0.01
                        ? `${curveProgress.pct.toFixed(6)}%`
                        : `${curveProgress.pct.toFixed(2)}%`}
                  </span>
                </div>
                {contractGraduated ? (
                  <p className="text-[10px] text-muted-foreground leading-snug mb-2">
                    This token has graduated. Bonding is closed. Trading continues on the same page
                    {isSolanaPage ? " via Meteora" : " via Topaz"}.
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground leading-snug mb-2">
                    Graduates when <span className="text-foreground/80">tokens sold</span> hit the curve
                    supply <span className="text-foreground/80">or</span> {nativeUnit} raised hits the target
                    (testnet ${isSolanaPage ? "6" : "target"} can be tiny, so {nativeUnit} % can look large).
                    {isSolanaPage && solanaCurve ? (
                      <>
                        {" "}Curve: {formatTokenFromWei(solanaCurve.soldTokens)} /{" "}
                        {formatTokenFromWei(solanaCurve.curveTokenSupply)} sold ·{" "}
                        {formatBnbFromWei(solanaCurve.netRaisedLamports)} net raised.
                      </>
                    ) : null}
                  </p>
                )}

                <div className="mt-3 h-2 w-full rounded-full bg-muted/30 border border-border/40 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,rgba(255,255,255,0.65),rgba(255,255,255,0.25),rgba(255,255,255,0.65))] dark:bg-[linear-gradient(90deg,rgba(255,255,255,0.25),rgba(255,255,255,0.08),rgba(255,255,255,0.25))]"
                    style={{ width: `${Math.max(0, Math.min(100, curveProgress.pct))}%`, minWidth: curveProgress.pct > 0 ? "1px" : undefined }}
                  />
                </div>

                {contractGraduated ? null : (
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">Tokens sold</p>
                    <p className="mt-1 font-mono text-foreground">
                      {curveProgress.soldPct > 0 && curveProgress.soldPct < 0.01
                        ? `${curveProgress.soldPct.toFixed(6)}%`
                        : `${curveProgress.soldPct.toFixed(2)}%`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground">{nativeUnit} raised</p>
                    <p className="mt-1 font-mono text-foreground">
                      {curveProgress.raisedPct > 0 && curveProgress.raisedPct < 0.01
                        ? `${curveProgress.raisedPct.toFixed(6)}%`
                        : `${curveProgress.raisedPct.toFixed(2)}%`}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">In curve</p>
                    <p className="mt-1 font-mono text-foreground">{formatBnbFromWei(curveProgress.reserveWei ?? undefined)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground">{nativeUnit} to target</p>
                    <p className="mt-1 font-mono text-foreground">{remainingCurveLabel.primary}</p>
                  </div>
                </div>
                )}
              </div>

              <div className="rounded-2xl border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="text-sm font-semibold">Your Position</h3>
                  <span className="text-[11px] text-muted-foreground">Wallet view</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">{nativeUnit} balance</p>
                    <p className="mt-1 font-mono text-foreground break-words">{formatBnbFromWei(bnbBalanceWei)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Token balance</p>
                    <p className="mt-1 font-mono text-foreground break-words">{formatTokenFromWei(tokenBalanceWei)} {tokenData.ticker}</p>
                  </div>
                </div>
              </div>

              <Tabs value={tradeTab} onValueChange={handleTradeTabChange}>
                <TabsList className={ctaTabsListClass}>
                  <TabsTrigger value="buy" className={ctaTabsTriggerClass}>Buy</TabsTrigger>
                  <TabsTrigger value="sell" className={ctaTabsTriggerClass}>Sell</TabsTrigger>
                </TabsList>

                <TabsContent value="buy" className="space-y-3 mt-0">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                          onClick={toggleTradeInputDenom}
                        >
                          {tradeInputDenom === "BNB" ? `Switch to ${tokenData.ticker}` : `Switch to ${nativeUnit}`}
                        </Button>
                      </div>
                      <span className="text-xs text-muted-foreground">Slippage: {SLIPPAGE_PCT}%</span>
                    </div>
                    <div className="relative">
                      <input
                        type="text"
                        value={tradeAmount}
                        onChange={(e) => setTradeAmount(e.target.value)}
                        className="w-full bg-background border border-border rounded-lg px-3 py-2 pr-20 font-mono text-base focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="0"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <span className="text-xs font-mono text-muted-foreground">{tradeInputDenom === "BNB" ? nativeUnit : tokenData.ticker}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-muted-foreground">
                        Balance:{" "}
                        {tradeInputDenom === "BNB"
                          ? formatBnbFromWei(bnbBalanceWei)
                          : `${formatTokenFromWei(tokenBalanceWei)} ${tokenData.ticker}`}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Pay: {quoteLoading ? "…" : quoteWei != null ? formatBnbFromWei(quoteWei) : "—"}
                      </span>
                    </div>
                    {effectiveTokenWei > 0n ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Receive: {formatTokenFromWei(effectiveTokenWei)} {tokenData.ticker}
                        {tradeInputDenom === "TOKEN" ? " (exact)" : " (est.)"}
                      </p>
                    ) : null}
                    {quoteError ? (
                      <p className="mt-2 text-center text-xs text-destructive">{quoteError}</p>
                    ) : null}
                  </div>

                  <div className="text-center text-xs text-muted-foreground">
                    {isDexStage ? (
                      isSolanaPage ? (
                        quoteWei != null ? (
                          <p>Meteora execution · min received protected by {SLIPPAGE_PCT}% slippage.</p>
                        ) : (
                          <p>Enter an amount to quote on Meteora.</p>
                        )
                      ) : (isTopazTradingActive || onChainLaunched) && quoteWei != null ? (
                        <p>
                          Topaz execution · min received protected by {(topazSlippageBps / 100).toFixed(2)}% slippage.
                          {tradeTab === "buy" && effectiveTokenWei > 0n
                            ? ` Est. ${formatTokenFromWei(effectiveTokenWei)} ${tokenData.ticker}.`
                            : ""}
                        </p>
                      ) : isTopazTradingActive || onChainLaunched ? (
                        <p>Enter an amount to quote on Topaz{onChainPair ? ` · pair ${onChainPair.slice(0, 6)}…${onChainPair.slice(-4)}` : ""}.</p>
                      ) : (
                        <p>Topaz market verification is in progress. Bonding history remains available.</p>
                      )
                    ) : quoteWei != null && effectiveTokenWei > 0n ? (
                      isSolanaPage ? (
                        <p>
                          Pay {formatBnbFromWei(tradeInputDenom === "BNB" ? effectiveBnbWei || quoteWei : quoteWei)} exact
                          {" "}→ ~{formatTokenFromWei(effectiveTokenWei)} {tokenData.ticker}
                          {" "}(min {formatTokenFromWei((effectiveTokenWei * BigInt(100 - SLIPPAGE_PCT)) / 100n)} @ {SLIPPAGE_PCT}% slip)
                        </p>
                      ) : (
                        <p>
                          Pay ~{formatBnbFromWei(quoteWei)} → get {formatTokenFromWei(effectiveTokenWei)} {tokenData.ticker}
                          {" "}(max {formatBnbFromWei((quoteWei * BigInt(100 + SLIPPAGE_PCT)) / 100n)})
                        </p>
                      )
                    ) : (
                      <p>Enter a {nativeUnit} amount to buy (switch to {tokenData.ticker || "TOKEN"} only for exact token size).</p>
                    )}
                  </div>

                  <Button
                    onClick={handlePlaceTrade}
                    disabled={
                      tradePending ||
                      approvePending ||
                      quoteLoading ||
                      (isSolanaPage
                        ? effectiveBnbWei <= 0n && !solanaCurveClosed && !contractGraduated
                        : (isDexStage && !isTopazTradingActive) ||
                          (tradeInputDenom === "BNB"
                            ? effectiveBnbWei <= 0n || effectiveTokenWei <= 0n
                            : parseTokenAmountWei(tradeAmount) <= 0n))
                    }
                    className={`w-full ${topbarButtonClass} py-5`}
                  >
                    {tradePending ? "Processing..." : isSolanaPage && (contractGraduated || solanaCurveClosed) ? "Buy on Meteora" : isDexStage ? "Buy on Topaz" : "Buy"}
                  </Button>
                </TabsContent>

                <TabsContent value="sell" className="space-y-3 mt-0">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Amount ({tradeInputDenom === "BNB" ? nativeUnit : tokenData.ticker})</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={toggleTradeInputDenom}
                        >
                          {tradeInputDenom === "BNB" ? `Switch to ${tokenData.ticker}` : `Switch to ${nativeUnit}`}
                        </Button>
                      </div>
                      <span className="text-xs text-muted-foreground">Slippage: {SLIPPAGE_PCT}%</span>
                    </div>
                    <div className="relative">
                      <input
                        type="text"
                        value={tradeAmount}
                        onChange={(e) => setTradeAmount(e.target.value)}
                        className="w-full bg-background border border-border rounded-lg px-3 py-2 pr-20 font-mono text-base focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="0"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <span className="text-xs font-mono text-muted-foreground">{tradeInputDenom === "BNB" ? nativeUnit : tokenData.ticker}</span>
                      </div>
                    </div>

                    <div className="flex gap-1 mt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs h-7"
                        onClick={() => {
                          if (tokenBalanceWei == null) return;
                          const amt = (tokenBalanceWei * 25n) / 100n;
                          setTradeInputDenom("TOKEN");
                          setTradeAmount(ethers.formatUnits(amt, tokenDecimals));
                        }}
                      >
                        25%
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs h-7"
                        onClick={() => {
                          if (tokenBalanceWei == null) return;
                          const amt = (tokenBalanceWei * 50n) / 100n;
                          setTradeInputDenom("TOKEN");
                          setTradeAmount(ethers.formatUnits(amt, tokenDecimals));
                        }}
                      >
                        50%
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs h-7"
                        onClick={() => {
                          if (tokenBalanceWei == null) return;
                          setTradeInputDenom("TOKEN");
                          setTradeAmount(ethers.formatUnits(tokenBalanceWei, tokenDecimals));
                        }}
                      >
                        100%
                      </Button>
                    </div>

                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-muted-foreground">
                        Balance:{" "}
                        {tradeInputDenom === "BNB"
                          ? formatBnbFromWei(bnbBalanceWei)
                          : `${formatTokenFromWei(tokenBalanceWei)} ${tokenData.ticker}`}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Payout: {tradeInputDenom === "BNB" ? formatBnbFromWei(effectiveBnbWei) : (quoteLoading ? "…" : quoteWei != null ? formatBnbFromWei(quoteWei) : "—")}
                      </span>
                    </div>
                    {tradeInputDenom === "BNB" && effectiveTokenWei > 0n ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">Est. sell: {formatTokenFromWei(effectiveTokenWei)} {tokenData.ticker}</p>
                    ) : null}

                    {approvePending ? (
                      <p className="mt-2 text-center text-xs text-muted-foreground">Approval in progress...</p>
                    ) : null}
                    {quoteError ? (
                      <p className="mt-2 text-center text-xs text-destructive">{quoteError}</p>
                    ) : null}
                  </div>

                  <div className="text-center text-xs text-muted-foreground">
                    {isDexStage ? (
                      isSolanaPage ? (
                        quoteWei != null ? (
                          <p>Meteora execution · min received protected by {SLIPPAGE_PCT}% slippage.</p>
                        ) : (
                          <p>Enter an amount to quote on Meteora.</p>
                        )
                      ) : (isTopazTradingActive || onChainLaunched) && quoteWei != null ? (
                        <p>
                          Topaz execution · min received protected by {(topazSlippageBps / 100).toFixed(2)}% slippage.
                          {` Est. ${formatBnbFromWei(quoteWei)}.`}
                        </p>
                      ) : isTopazTradingActive || onChainLaunched ? (
                        <p>Enter an amount to quote a Topaz sell.</p>
                      ) : (
                        <p>Topaz market verification is in progress. Bonding history remains available.</p>
                      )
                    ) : quoteWei != null ? (
                      <p>
                        You will receive ~{formatBnbFromWei(quoteWei)} (min {formatBnbFromWei((quoteWei * BigInt(100 - SLIPPAGE_PCT)) / 100n)})
                      </p>
                    ) : (
                      <p>Enter an amount to see the sell quote.</p>
                    )}
                  </div>

                  <Button
                    onClick={handlePlaceTrade}
                    disabled={
                      tradePending ||
                      approvePending ||
                      quoteLoading ||
                      (isSolanaPage
                        ? effectiveTokenWei <= 0n && !solanaCurveClosed && !contractGraduated
                        : (isDexStage && !isTopazTradingActive) ||
                          (tradeInputDenom === "BNB"
                            ? effectiveBnbWei <= 0n || effectiveTokenWei <= 0n
                            : parseTokenAmountWei(tradeAmount) <= 0n))
                    }
                    className={`w-full ${topbarButtonClass} py-5`}
                  >
                    {tradePending ? "Processing..." : isSolanaPage && (contractGraduated || solanaCurveClosed) ? "Sell on Meteora" : isDexStage ? "Sell on Topaz" : "Sell"}
                  </Button>
                </TabsContent>
              </Tabs>
            </div>
          </Card>

          <Card className="mt-3 bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-sm font-semibold">War Room</h3>
                <p className="text-[11px] text-muted-foreground">Live campaign chat</p>
              </div>
            </div>

            {campaign?.campaign ? (
              <TokenWarRoom
                chainId={chainIdForStorage}
                campaignAddress={campaign.campaign}
                creatorAddress={campaign.creator}
              />
            ) : (
              <div className="text-sm text-muted-foreground">Loading chat…</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

export default TokenDetails;
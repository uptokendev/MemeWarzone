import { Contract, ethers } from "ethers";
import LaunchCampaignArtifact from "@/abi/LaunchCampaign.json";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";
import { getReadProvider } from "@/lib/readProvider";
import { getDefaultChainId } from "@/lib/chainConfig";

const CAMPAIGN_ABI = LaunchCampaignArtifact.abi as ethers.InterfaceAbi;
const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;

function normalizeApiBase(value: unknown): string {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (/\{\{/.test(raw) || /%7B%7B/i.test(raw)) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return `https:${raw}`;
  return `https://${raw}`;
}

/** Indexer hosts must never receive frontend-api routes (league/summary, featured, upload, …). */
function looksLikeRetiredRailwayHost(url: string): boolean {
  const host = String(url || "").toLowerCase();
  return (
    host.includes("memebattles-frontend-7dcf.up.railway.app") ||
    host.includes("memebattles-production-dca0.up.railway.app")
  );
}

function looksLikeIndexerBase(url: string): boolean {
  const host = String(url || "").toLowerCase();
  return (
    looksLikeRetiredRailwayHost(host) ||
    host.includes("memebattles-production") ||
    host.includes("memewarzone-production") ||
    host.includes("-dca0") ||
    host.includes("indexer") ||
    host.includes("realtime-indexer")
  );
}

function firstNonIndexerBase(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeApiBase(candidate);
    if (normalized && !looksLikeIndexerBase(normalized) && !looksLikeRetiredRailwayHost(normalized)) {
      return normalized;
    }
  }
  return "";
}

function firstAnyBase(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeApiBase(candidate);
    if (normalized && !looksLikeRetiredRailwayHost(normalized)) return normalized;
  }
  return "";
}

// Frontend-api only. Never fall back to VITE_API_BASE — in prod that is the indexer
// (memebattles-production), which has no /api/league/summary and broke the League page.
const EXPLICIT_API_BASE = firstNonIndexerBase([
  import.meta.env.VITE_FRONTEND_API_BASE,
  import.meta.env.VITE_RAILWAY_FRONTEND_API_BASE,
  import.meta.env.RAILWAY_FRONTEND_API_BASE_URL,
]);

export function getFrontendApiOrigin(): string {
  return EXPLICIT_API_BASE.replace(/\/$/, "");
}

// Realtime indexer (votes, token markets, some rewards). VITE_API_BASE is a legacy alias.
const EXPLICIT_REALTIME_API_BASE = firstAnyBase([
  import.meta.env.VITE_TOKEN_API_BASE,
  import.meta.env.VITE_RAILWAY_TOKEN_API_BASE,
  import.meta.env.RAILWAY_TOKEN_API_BASE_URL,
  import.meta.env.VITE_REALTIME_API_BASE,
  import.meta.env.VITE_API_BASE,
  import.meta.env.VITE_API_BASE_URL,
  import.meta.env.VITE_RAILWAY_API_BASE,
]);

// Do not route global list endpoints (/api/campaigns, /api/featured) to the
// realtime-indexer project: memebattles-production does not expose those routes.
// TokenDetails is protected below by a preemptive /token/0x... contract fallback
// when legacy code asks for /api/campaigns.
const REALTIME_INDEXER_API_PREFIXES = [
  "/api/token/",
  "/api/market/",
  "/api/votes",
  "/api/vote_counts",
  "/api/dashboard/lp-fees",
];

const FRONTEND_API_PREFIXES = [
  "/api/token-metadata",
  "/api/topaz-trades",
  "/api/recruiters",
  "/api/recruiters/signup",
  "/api/recruiter-auth-nonce",
  "/api/recruiter-auth-verify",
  "/api/recruiter-portal",
  "/api/recruiter-logout",
  "/api/rewards",
  // Full UP Only League stack (epoch windows, prize meta, all categories).
  "/api/league",
  "/api/leaguePayouts",
  "/api/leagueRoot",
  // Vote receipt → vote_aggregates (must not hit indexer /api/votes proxy).
  "/api/vote-ingest",
  "/api/votes/ingest",
  "/api/arena",
  // Solana V4 create/trade/vote — must hit frontend-api, never indexer.
  "/api/solana",
  "/api/drafts",
  // Same-origin Netlify proxy → frontend-api for these product surfaces.
  "/api/featured",
  "/api/campaigns",
  "/api/upload",
  "/api/auth",
  "/api/ably",
  "/api/launchpad",
  "/api/price",
  "/api/follows",
  "/api/analytics",
];

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = String(hostname || "").trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function shouldUseLocalApiGateway(path: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (!isLoopbackHost(window.location.hostname)) return false;
  } catch {
    return false;
  }
  return path === "/api" || path.startsWith("/api/") || path === "/internal" || path.startsWith("/internal/");
}

function matchesApiPrefix(path: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}

function shouldUseFrontendApi(path: string): boolean {
  return FRONTEND_API_PREFIXES.some((prefix) => matchesApiPrefix(path, prefix));
}

function shouldUseRealtimeIndexer(path: string): boolean {
  if (shouldUseFrontendApi(path)) return false;
  return REALTIME_INDEXER_API_PREFIXES.some((prefix) => matchesApiPrefix(path, prefix));
}

function isCampaignFeedPath(path: string): boolean {
  try {
    const url = new URL(path, "http://local");
    return url.pathname === "/api/campaigns";
  } catch {
    return normalizePath(path).split("?")[0] === "/api/campaigns";
  }
}

function getTokenPageCampaignAddress(): string {
  if (typeof window === "undefined") return "";
  try {
    const match = window.location.pathname.match(/^\/token\/(0x[a-fA-F0-9]{40})(?:\/)?$/);
    return match?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function getChainIdFromApiPath(path: string): number {
  try {
    const url = new URL(path, "http://local");
    const raw = Number(url.searchParams.get("chainId") || getDefaultChainId());
    return Number.isFinite(raw) ? raw : getDefaultChainId();
  } catch {
    return getDefaultChainId();
  }
}

function getMethod(init?: RequestInit): string {
  return String(init?.method || "GET").trim().toUpperCase();
}

function isSolanaAddress(value?: string | null): boolean {
  const raw = String(value || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
}

function normalizeWallet(value?: string | null): string {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(lower)) return lower;
  return isSolanaAddress(raw) ? raw : "";
}

function emptyWalletRewardSummary(walletAddress: string) {
  return {
    walletAddress,
    pendingByProgram: {},
    claimableByProgram: {},
    totalEarnedByProgram: {},
    claimableTotalRaw: "0",
    pendingTotalRaw: "0",
    totalEarnedRaw: "0",
    claimedByProgram: {},
    totalClaimableAmount: "0",
    claimedLifetimeAmount: "0",
    lastClaimedAt: null,
    materializedAt: null,
    updatedAt: null,
  };
}

function deferCompatibilityFallback(path: string): boolean {
  try {
    const url = new URL(path, "http://local");
    if (url.pathname === "/api/recruiters/signup/status") return true;
    if (url.pathname === "/api/rewards/wallet") return true;
    return /^\/api\/recruiters\/wallet\/[^/]+\/summary$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function safeString(fn: () => Promise<unknown>, fallback = ""): Promise<string> {
  try {
    const value = await fn();
    const text = String(value ?? "").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

async function safeBool(fn: () => Promise<unknown>, fallback = false): Promise<boolean> {
  try {
    return Boolean(await fn());
  } catch {
    return fallback;
  }
}

async function safeBigInt(fn: () => Promise<unknown>, fallback = 0n): Promise<bigint> {
  try {
    const value = await fn();
    if (typeof value === "bigint") return value;
    return BigInt(String(value ?? fallback));
  } catch {
    return fallback;
  }
}

function jsonResponse(body: unknown, status = 200, fallback = "client-compatibility"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-mwz-client-fallback": fallback,
    },
  });
}

function buildPublicCompatibilityFallback(path: string, init?: RequestInit): Response | null {
  if (getMethod(init) !== "GET") return null;

  let url: URL;
  try {
    url = new URL(path, "http://local");
  } catch {
    return null;
  }

  if (url.pathname === "/api/recruiters/signup/status") {
    const walletAddress = normalizeWallet(url.searchParams.get("walletAddress"));
    return jsonResponse({
      walletAddress,
      isRecruiter: false,
      recruiter: null,
      canStartSignup: true,
      signupApiAvailable: false,
      warning: "Recruiter signup is opening soon.",
    });
  }

  const recruiterWalletMatch = url.pathname.match(/^\/api\/recruiters\/wallet\/([^/]+)\/summary$/);
  if (recruiterWalletMatch) {
    const walletAddress = normalizeWallet(decodeURIComponent(recruiterWalletMatch[1] || ""));
    return jsonResponse({ summary: null, walletAddress });
  }

  if (url.pathname === "/api/rewards/wallet") {
    const walletAddress = normalizeWallet(url.searchParams.get("walletAddress"));
    return jsonResponse({ summary: emptyWalletRewardSummary(walletAddress) });
  }

  return null;
}

async function buildTokenDetailsCampaignFallback(path: string): Promise<Response | null> {
  const campaignAddress = getTokenPageCampaignAddress();
  if (!campaignAddress) return null;
  if (!isCampaignFeedPath(path)) return null;

  const chainId = getChainIdFromApiPath(path);

  try {
    const provider = getReadProvider(chainId as any);
    const campaign = new Contract(campaignAddress, CAMPAIGN_ABI, provider) as any;

    const tokenAddress = (await safeString(() => campaign.token())).toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(tokenAddress)) return null;

    const token = new Contract(tokenAddress, TOKEN_ABI, provider) as any;

    const [
      name,
      symbol,
      logoUri,
      creatorAddress,
      website,
      xAccount,
      extraLink,
      launched,
      sold,
      curveSupply,
    ] = await Promise.all([
      safeString(() => token.name(), "Unknown"),
      safeString(() => token.symbol(), ""),
      safeString(() => campaign.logoURI(), "/placeholder.svg"),
      safeString(() => campaign.creator()),
      safeString(() => campaign.website()),
      safeString(() => campaign.xAccount()),
      safeString(() => campaign.extraLink()),
      safeBool(() => campaign.launched(), false),
      safeBigInt(() => campaign.sold(), 0n),
      safeBigInt(() => campaign.curveSupply(), 0n),
    ]);

    const progressPct = curveSupply > 0n ? Number((sold * 10_000n) / curveSupply) / 100 : null;

    return jsonResponse(
      {
        items: [
          {
            chainId,
            campaignAddress,
            tokenAddress,
            creatorAddress: /^0x[a-fA-F0-9]{40}$/.test(creatorAddress) ? creatorAddress.toLowerCase() : null,
            name,
            symbol,
            logoUri,
            logoURI: logoUri,
            website,
            xAccount,
            xUrl: xAccount,
            extraLink,
            isDexTrading: launched,
            isActive: !launched,
            status: launched ? "graduated" : "live",
            progressPct,
            votes24h: 0,
            votesAllTime: 0,
            raisedTotalBnb: "0",
            raised10mBnb: "0",
            source: "token-details-contract-fallback",
          },
        ],
        nextCursor: null,
        pageSize: 1,
        updatedAt: new Date().toISOString(),
        warning: "Campaign feed fallback hydrated this token directly from the campaign contract.",
      },
      200,
      "token-details-contract",
    );
  } catch (error) {
    console.warn("[apiBase] TokenDetails contract fallback failed", error);
    return null;
  }
}

// Only open the global creator-protection dialog for intentional creator/cluster
// trade blocks. Infrastructure UNAVAILABLE codes must not spam visitors on page
// load from TokenSafety / passive preflight probes.
const CREATOR_PROTECTION_DIALOG_CODES = new Set([
  "CREATOR_BUY_LOCKED",
  "CREATOR_CLUSTER_BUY_LOCKED",
  "CREATOR_CLUSTER_BUY_CAP_EXCEEDED",
]);

async function notifyCreatorProtectionResponse(res: Response): Promise<void> {
  if (res.ok || typeof window === "undefined") return;
  try {
    const payload = await res.clone().json();
    const preflight = payload?.preflight || null;
    const protection = preflight?.creatorProtection || null;
    const code = String(preflight?.code || protection?.code || payload?.code || "");
    if (!CREATOR_PROTECTION_DIALOG_CODES.has(code)) return;
    window.dispatchEvent(new CustomEvent("mwz:creatorProtectionBlocked", {
      detail: {
        ...(protection || {}),
        code,
      },
    }));
  } catch {
    // The caller still receives and handles the original error response.
  }
}

export function apiUrl(path: string): string {
  if (isHttpUrl(path)) return path;
  const normalized = normalizePath(path);

  if (shouldUseLocalApiGateway(normalized)) {
    return normalized;
  }

  // Indexer-only surfaces (votes, token market, …).
  if (EXPLICIT_REALTIME_API_BASE && shouldUseRealtimeIndexer(normalized)) {
    return `${EXPLICIT_REALTIME_API_BASE}${normalized}`;
  }

  // Frontend-api surfaces (league/summary, featured, upload, …).
  // Prefer explicit frontend base; otherwise same-origin so Netlify can proxy.
  // Never send these to the indexer — even if VITE_API_BASE is the only absolute URL set.
  if (shouldUseFrontendApi(normalized)) {
    return EXPLICIT_API_BASE ? `${EXPLICIT_API_BASE}${normalized}` : normalized;
  }

  if (EXPLICIT_API_BASE) return `${EXPLICIT_API_BASE}${normalized}`;
  // Last resort for unclassified paths: same-origin (not the indexer).
  return normalized;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const compatibilityFallback = buildPublicCompatibilityFallback(path, init);
  const deferredFallback = deferCompatibilityFallback(path);
  if (compatibilityFallback && !deferredFallback) return compatibilityFallback;

  const url = apiUrl(path);

  try {
    const res = await fetch(url, init);
    if (!res.ok && isCampaignFeedPath(path)) {
      const fallback = await buildTokenDetailsCampaignFallback(path);
      if (fallback) return fallback;
    }
    if (!res.ok && compatibilityFallback) return compatibilityFallback;
    await notifyCreatorProtectionResponse(res);
    return res;
  } catch (error) {
    const fallback = await buildTokenDetailsCampaignFallback(path);
    if (fallback) return fallback;
    if (compatibilityFallback) return compatibilityFallback;
    throw error;
  }
}

export async function apiJson<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(String(json?.error || json?.message || `Request failed (${res.status})`));
  }
  return json as T;
}

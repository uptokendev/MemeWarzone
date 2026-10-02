import { getActiveChainId, getFactoryAddress } from "@/lib/chainConfig";
import { apiFetch } from "@/lib/apiBase";

const SESSION_KEY = "mwz:recruiter:session";
const FINGERPRINT_KEY = "mwz:recruiter:fingerprint";
const MEMBER_ROLE_KEY = "mwz:recruiter:memberRole";
const RECRUITER_SIGNUP_API_BASE = "/api/recruiter-signup";

export type RecruiterMemberRole = "creator" | "trader";

type StoredRecruiterSession = {
  sessionToken: string;
  clientFingerprint: string;
};

export type CreatorProtectionPreflight = {
  code?: string | null;
  creatorWallet?: string | null;
  creatorLinked?: boolean;
  relationship?: string | null;
  tier?: string | null;
  tierNumber?: number | null;
  unlockAt?: string | null;
  creatorBuyLockUntil?: number | null;
  creatorBuyCapWei?: string | null;
  creatorBoughtWei?: string | null;
  buyerClusterId?: string | null;
  creatorClusterId?: string | null;
  source?: string | null;
  requestedWei?: string | null;
  confirmedWei?: string | null;
  reservedWei?: string | null;
  remainingWei?: string | null;
  error?: string | null;
};

export type LaunchpadPreflight = {
  allowed: boolean;
  reasons: string[];
  warnings: string[];
  code?: string | null;
  schemaReady?: boolean;
  tier?: string;
  rules?: Record<string, unknown>;
  creator?: Record<string, unknown> | null;
  walletRisk?: Record<string, unknown> | null;
  cluster?: Record<string, unknown> | null;
  campaign?: Record<string, unknown> | null;
  creatorProtection?: CreatorProtectionPreflight | null;
  lookupErrors?: string[];
  canonicalCampaignAddress?: string | null;
  submittedCampaignAddress?: string | null;
};

export class LaunchpadPreflightBlockedError extends Error {
  preflight: LaunchpadPreflight;

  constructor(preflight: LaunchpadPreflight) {
    const reasons = Array.isArray(preflight?.reasons)
      ? preflight.reasons.map(String).filter(Boolean)
      : [];
    const message = reasons.length
      ? reasons.slice(0, 3).join(" ")
      : "Safety preflight blocked this action.";

    super(message);
    this.name = "LaunchpadPreflightBlockedError";
    this.preflight = preflight;
  }
}

function ensureStorageValue(key: string): string {
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(key, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

function normalizeMemberRole(value?: string | null): RecruiterMemberRole | null {
  const role = String(value || "").trim().toLowerCase();
  return role === "creator" || role === "trader" ? role : null;
}

function openTokenSafetyDropdown() {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("mwz:openTokenSafety"));
      window.dispatchEvent(new CustomEvent("mwz:refreshTokenSafety"));
    }
  } catch {
    // ignore
  }
}

function showCreatorProtection(preflight: LaunchpadPreflight) {
  try {
    if (typeof window === "undefined") return;
    const code = String(preflight?.code || preflight?.creatorProtection?.code || "");
    // Active trade attempts may still surface infrastructure unavailability so the
    // user knows MetaMask was not opened. Passive global apiFetch notifier no longer
    // fires UNAVAILABLE for passive TokenDetails probes.
    if (!code.startsWith("CREATOR_")) return;
    const campaignAddress = String(
      (preflight.creatorProtection as { campaignAddress?: string | null } | null)?.campaignAddress
      || preflight.canonicalCampaignAddress
      || preflight.submittedCampaignAddress
      || (preflight.campaign as { address?: string | null } | null)?.address
      || "",
    ).trim();
    window.dispatchEvent(new CustomEvent("mwz:creatorProtectionBlocked", {
      detail: {
        ...(preflight.creatorProtection || {}),
        campaignAddress: campaignAddress || null,
        code,
        force: true,
      },
    }));
  } catch {
    // The safety failure still throws below even if the dialog cannot render.
  }
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : "";
}

function isMissingEndpointError(error: unknown): boolean {
  const message = String((error as any)?.message || error || "").toLowerCase();
  return message.includes("request failed (404)") || message.includes("unknown route") || message.includes("not found");
}

function emptyWalletRewardSummary(walletAddress: string): WalletRewardSummary {
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

function normalizeRecruiterCode(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function setRecruiterReferralMemberRole(role: RecruiterMemberRole) {
  try {
    window.localStorage.setItem(MEMBER_ROLE_KEY, role);
  } catch {
    // ignore storage failures
  }
}

export function getRecruiterReferralMemberRole(): RecruiterMemberRole | null {
  try {
    return normalizeMemberRole(window.localStorage.getItem(MEMBER_ROLE_KEY));
  } catch {
    return null;
  }
}

export function clearRecruiterReferralMemberRole() {
  try {
    window.localStorage.removeItem(MEMBER_ROLE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function getRecruiterSession(): StoredRecruiterSession {
  return {
    sessionToken: ensureStorageValue(SESSION_KEY),
    clientFingerprint: ensureStorageValue(FINGERPRINT_KEY),
  };
}

async function parseJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  }
  return json as any;
}

async function getJson(path: string) {
  return parseJson(await apiFetch(path));
}

async function postJson(path: string, body: any) {
  return parseJson(
    await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function postPreflight(path: string, body: any): Promise<LaunchpadPreflight> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const preflight = (json?.preflight ?? json) as LaunchpadPreflight;
  if (!preflight || typeof preflight.allowed !== "boolean") {
    throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  }
  return preflight;
}

function assertPreflightAllowed(preflight: LaunchpadPreflight): LaunchpadPreflight {
  if (!preflight?.allowed) {
    showCreatorProtection(preflight);
    openTokenSafetyDropdown();
    throw new LaunchpadPreflightBlockedError(preflight);
  }
  return preflight;
}

async function ensureRecruiterSignupWalletProfile(walletAddress: string) {
  if (!walletAddress) return;
  const session = getRecruiterSession();
  try {
    await postJson("/api/attribution/wallet-connect", {
      walletAddress,
      sessionToken: session.sessionToken,
      clientFingerprint: session.clientFingerprint,
      memberRole: null,
    });
  } catch (error) {
    // This call creates/updates wallet_profiles on the API before recruiter insert.
    // Do not block signup when attribution itself is unavailable; the submit route still performs canonical validation.
    console.warn("[recruiterApi] wallet profile preflight failed", error);
  }
}

export async function captureRecruiterReferral(recruiterCode: string, walletAddress?: string | null) {
  const session = getRecruiterSession();
  return postJson(`/api/recruiters/${encodeURIComponent(recruiterCode)}/referral/capture`, {
    recruiterCode,
    walletAddress: walletAddress ?? null,
    sessionToken: session.sessionToken,
    clientFingerprint: session.clientFingerprint,
  });
}

export async function syncWalletRecruiterAttribution(walletAddress: string, memberRole?: RecruiterMemberRole | null) {
  const session = getRecruiterSession();
  const role = normalizeMemberRole(memberRole) || getRecruiterReferralMemberRole();
  const result = await postJson("/api/attribution/wallet-connect", {
    walletAddress,
    sessionToken: session.sessionToken,
    clientFingerprint: session.clientFingerprint,
    memberRole: role,
  });
  if (result?.linked && role) clearRecruiterReferralMemberRole();
  return result;
}

export async function fetchLaunchpadCreateEligibility(walletAddress: string, walletChainId?: number | null): Promise<LaunchpadPreflight> {
  const chainId = getActiveChainId(walletChainId);
  const factoryAddress = getFactoryAddress(chainId);
  return postPreflight("/api/launchpad/preflight-create", { walletAddress, chainId, factoryAddress });
}

export async function fetchLaunchpadCreatePreflight(walletAddress: string, walletChainId?: number | null): Promise<LaunchpadPreflight> {
  return assertPreflightAllowed(await fetchLaunchpadCreateEligibility(walletAddress, walletChainId));
}

export async function fetchLaunchpadBuyPreflight(
  walletAddress: string,
  campaignAddress: string,
  walletChainId?: number | null,
): Promise<LaunchpadPreflight> {
  const chainId = getActiveChainId(walletChainId);
  const preflight = await postPreflight("/api/launchpad/preflight-buy", { walletAddress, campaignAddress, chainId });
  return assertPreflightAllowed(preflight);
}

export async function fetchLaunchpadSellPreflight(
  walletAddress: string,
  campaignAddress: string,
  walletChainId?: number | null,
): Promise<LaunchpadPreflight> {
  const chainId = getActiveChainId(walletChainId);
  const preflight = await postPreflight("/api/launchpad/preflight-sell", { walletAddress, campaignAddress, chainId });
  return assertPreflightAllowed(preflight);
}

export async function fetchCampaignCreateAuthorization(walletAddress: string, walletChainId?: number | null) {
  const chainId = getActiveChainId(walletChainId);
  const factoryAddress = getFactoryAddress(chainId);
  if (!factoryAddress) throw new Error(`Factory address missing for chain ${chainId}`);

  return postJson("/api/routing/create-authorization", {
    walletAddress,
    chainId,
    factoryAddress,
  });
}

export async function fetchCampaignTradeAuthorization(
  walletAddress: string,
  campaignAddress: string,
  walletChainId?: number | null,
) {
  const chainId = getActiveChainId(walletChainId);
  return postJson("/api/routing/trade-authorization", {
    walletAddress,
    campaignAddress,
    chainId,
  });
}

export type RecruiterSummary = {
  recruiterId: number;
  walletAddress: string;
  code: string;
  displayName: string | null;
  isOg: boolean;
  status: string;
  closedAt: string | null;
  linkedWalletCount: number;
  linkedCreatorsCount: number;
  linkedTradersCount: number;
  activeSquadMemberCount: number;
  referredEventCount: number;
  referredVolumeRaw: string;
  recruiterRouteAmountRaw: string;
  lastReferredEventAt: string | null;
  latestLinkedActivityAt: string | null;
  pendingEarningsRaw: string;
  claimableEarningsRaw: string;
  totalEarnedRaw: string;
  claimedLifetimeRaw: string;
  lastClaimedAt: string | null;
  weightedScore?: number;
  createdAt: string | null;
  updatedAt: string | null;
  materializedAt: string | null;
};

export type SquadSummary = {
  recruiterId: number;
  recruiterWalletAddress: string;
  recruiterCode: string;
  recruiterDisplayName: string | null;
  squadImageUrl?: string | null;
  squad_image_url?: string | null;
  recruiterIsOg: boolean;
  recruiterStatus: string;
  activeMemberCount: number;
  eligibleMemberCount: number;
  totalEligibleScore: string;
  routedEventCount: number;
  routedSquadAmountTotal: string;
  currentEpochRoutedSquadAmount: string;
  estimatedPendingPoolAmount: string;
  lastRoutedAt: string | null;
  currentEpochId: number | null;
  currentEpochStartAt: string | null;
  currentEpochEndAt: string | null;
  materializedAt: string | null;
};

export type WalletAttributionPublicState = {
  walletAddress: string;
  hasActivity: boolean;
  recruiterLinkState: string;
  recruiterCode: string | null;
  recruiterDisplayName: string | null;
  recruiterIsOg: boolean;
  squadState: string;
};

export type WalletRewardSummary = {
  walletAddress: string;
  pendingByProgram: Record<string, string>;
  claimableByProgram: Record<string, string>;
  totalEarnedByProgram: Record<string, string>;
  claimableTotalRaw: string;
  pendingTotalRaw: string;
  totalEarnedRaw: string;
  updatedAt: string | null;
  claimedByProgram?: Record<string, string>;
  totalClaimableAmount?: string;
  claimedLifetimeAmount?: string;
  lastClaimedAt?: string | null;
  materializedAt?: string | null;
};

export type RecruiterApplication = {
  displayName: string;
  socialHandle?: string;
  telegramHandle?: string;
  website?: string;
  pitch?: string;
  specialties?: string[];
};

export type RecruiterSignupStatus = {
  walletAddress: string;
  isRecruiter: boolean;
  recruiter: RecruiterSummary | null;
  canStartSignup: boolean;
  signupApiAvailable: boolean;
  warning?: string;
};

export type RecruiterCodeAvailability = {
  code: string;
  isAvailable: boolean | null;
  checkedVia: string;
  message: string;
};

export type RecruiterSignupNonce = {
  nonce: string;
  expiresAt: string;
};

export type RecruiterSignupPayload = {
  walletAddress: string;
  chainId: number;
  displayName: string;
  desiredCode: string;
  email: string;
  telegram?: string;
  discord?: string;
  xHandle?: string;
  pitch: string;
  acceptTerms: boolean;
  nonce: string;
  signature: string;
};

export async function fetchRecruiterSummary(code: string): Promise<RecruiterSummary | null> {
  const json = await getJson(`/api/recruiters/${encodeURIComponent(code)}/summary`);
  return json?.summary ?? json ?? null;
}

export async function fetchRecruiterSummaryByWallet(walletAddress: string): Promise<RecruiterSummary | null> {
  if (!walletAddress) return null;

  try {
    const json = await getJson(`/api/recruiters/wallet/${encodeURIComponent(walletAddress)}/summary`);
    return json?.summary ?? json ?? null;
  } catch (error: any) {
    if (String(error?.message || "").includes("Recruiter not found")) return null;
    throw error;
  }
}

export async function fetchRecruiterLeaderboard(
  limit = 100,
  status: "active" | "inactive" | "closed" | "all" = "active",
): Promise<RecruiterSummary[]> {
  const json = await getJson(`/api/recruiters${buildQuery({ limit, status })}`);
  return Array.isArray(json?.recruiters) ? json.recruiters : [];
}

export async function fetchRecruiterReplacements(code: string, limit = 4): Promise<{ replacements: RecruiterSummary[] }> {
  const currentCode = String(code || "").trim().toLowerCase();
  const recruiters = await fetchRecruiterLeaderboard(Math.max(limit + 1, limit), "active");
  return {
    replacements: recruiters
      .filter((recruiter) => String(recruiter.code || "").trim().toLowerCase() !== currentCode)
      .slice(0, limit),
  };
}

export async function fetchSquadSummary(code: string): Promise<SquadSummary | null> {
  // Indexer exposes /api/squads/:code/summary (not /api/recruiters/:code/squad).
  const json = await getJson(`/api/squads/${encodeURIComponent(code)}/summary`);
  return json?.summary ?? json ?? null;
}

export async function applyRecruiter(walletAddress: string, application: RecruiterApplication) {
  return postJson("/api/recruiters/apply", { walletAddress, ...application });
}

export async function fetchRecruiterSignupStatus(walletAddress: string): Promise<RecruiterSignupStatus> {
  try {
    const json = await getJson(`${RECRUITER_SIGNUP_API_BASE}/status${buildQuery({ walletAddress })}`);
    return {
      walletAddress: json?.walletAddress ?? walletAddress,
      isRecruiter: Boolean(json?.isRecruiter),
      recruiter: json?.recruiter ?? null,
      canStartSignup: Boolean(json?.canStartSignup ?? !json?.isRecruiter),
      signupApiAvailable: Boolean(json?.signupApiAvailable ?? true),
      warning: json?.warning,
    };
  } catch (error) {
    if (!isMissingEndpointError(error)) throw error;
    const recruiter = await fetchRecruiterSummaryByWallet(walletAddress).catch(() => null);
    return {
      walletAddress,
      isRecruiter: Boolean(recruiter),
      recruiter,
      canStartSignup: !recruiter,
      signupApiAvailable: false,
      warning: recruiter ? undefined : "Recruiter signup is opening soon.",
    };
  }
}

export async function checkRecruiterCodeAvailability(code: string): Promise<RecruiterCodeAvailability> {
  return getJson(`${RECRUITER_SIGNUP_API_BASE}/code-availability${buildQuery({ code })}`);
}

export async function requestRecruiterSignupNonce(walletAddress: string, chainId: number): Promise<RecruiterSignupNonce> {
  await ensureRecruiterSignupWalletProfile(walletAddress);
  return postJson(`${RECRUITER_SIGNUP_API_BASE}/nonce`, { walletAddress, chainId });
}

export function buildRecruiterSignupMessage({
  walletAddress,
  chainId,
  nonce,
  displayName,
  desiredCode,
  email,
  telegram,
  discord,
  xHandle,
  pitch,
}: Omit<RecruiterSignupPayload, "acceptTerms" | "signature">): string {
  return [
    "MemeWarzone Recruiter Signup",
    "Action: RECRUITER_SIGNUP",
    `Wallet: ${String(walletAddress || "").trim()}`,
    `ChainId: ${chainId ?? ""}`,
    `Nonce: ${String(nonce || "").trim()}`,
    "",
    `DisplayName: ${String(displayName || "").trim().slice(0, 40)}`,
    `DesiredCode: ${normalizeRecruiterCode(desiredCode)}`,
    `Email: ${String(email || "").trim().slice(0, 120)}`,
    `Telegram: ${String(telegram || "").trim().slice(0, 80)}`,
    `Discord: ${String(discord || "").trim().slice(0, 80)}`,
    `X: ${String(xHandle || "").trim().slice(0, 80)}`,
    "",
    `Pitch: ${String(pitch || "").trim().slice(0, 1000)}`,
  ].join("\n");
}

export async function submitRecruiterSignup(payload: RecruiterSignupPayload) {
  await ensureRecruiterSignupWalletProfile(payload.walletAddress);
  return postJson(RECRUITER_SIGNUP_API_BASE, payload);
}

export async function fetchWalletAttribution(walletAddress: string): Promise<WalletAttributionPublicState | null> {
  if (!walletAddress) return null;
  const json = await getJson(`/api/attribution/wallet/${encodeURIComponent(walletAddress)}`);
  return json?.state ?? null;
}

export async function fetchWalletAttributionState(walletAddress: string): Promise<WalletAttributionPublicState | null> {
  return fetchWalletAttribution(walletAddress);
}

export async function fetchWalletRewards(walletAddress: string): Promise<WalletRewardSummary | null> {
  if (!walletAddress) return null;
  try {
    const json = await getJson(`/api/rewards/wallet${buildQuery({ walletAddress })}`);
    return json?.summary ?? emptyWalletRewardSummary(walletAddress);
  } catch (error) {
    if (isMissingEndpointError(error)) return emptyWalletRewardSummary(walletAddress);
    throw error;
  }
}

export async function fetchWalletRewardSummary(walletAddress: string): Promise<WalletRewardSummary | null> {
  return fetchWalletRewards(walletAddress);
}

export async function fetchRecruiterRewards(code: string): Promise<WalletRewardSummary | null> {
  const json = await getJson(`/api/recruiters/${encodeURIComponent(code)}/rewards`);
  return json?.summary ?? null;
}

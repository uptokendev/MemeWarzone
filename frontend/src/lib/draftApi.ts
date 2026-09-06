import { verifyMessage } from "ethers";
import { apiFetch, apiUrl } from "@/lib/apiBase";
import { BNB_CHAIN_ID, BNB_TESTNET_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import type { DraftActionAuth, DraftAuthAction } from "@/lib/draftAuth";

const OWNER_SESSION_ACTION: DraftAuthAction = "draft_owner_session";
const OWNER_SESSION_CACHE_PREFIX = "mwz:draft-owner-session:v3:";
const LEGACY_OWNER_SESSION_CACHE_PREFIX = "mwz:draft-owner-session:v2:";
const OWNER_SESSION_SAFETY_WINDOW_MS = 15 * 1000;
const OWNER_SESSION_MAX_AGE_MS = 9 * 60 * 1000;

async function parseJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  }
  return json as any;
}

async function readResponseJson(res: Response) {
  return res.json().catch(() => ({}));
}

function query(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

function isSolanaWalletAddress(value: string) {
  const raw = String(value || "").trim();
  return raw.length >= 32 && raw.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(raw) && !raw.startsWith("0x");
}

/** EVM → lowercase; Solana base58 → preserve case. */
function normalizeWallet(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isSolanaWalletAddress(raw)) return raw;
  return raw.toLowerCase();
}

function buildDraftAuthMessage(input: {
  action: DraftAuthAction;
  walletAddress: string;
  chainId: number;
  nonce: string;
  draftId?: string | null;
}) {
  const lines = [
    "MemeWarzone Prepare Mode",
    `Action: ${input.action}`,
    `Wallet: ${normalizeWallet(input.walletAddress)}`,
    `Chain ID: ${Number(input.chainId)}`,
  ];

  if (input.draftId) lines.push(`Draft ID: ${input.draftId}`);
  lines.push(`Nonce: ${input.nonce}`);

  return lines.join("\n");
}

async function fetchNonce(chainId: number, walletAddress: string) {
  const qs = new URLSearchParams({
    chainId: String(chainId),
    address: normalizeWallet(walletAddress),
  });

  const res = await apiFetch(`/api/auth/nonce?${qs.toString()}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json?.nonce) {
    throw new Error(String(json?.error || json?.message || "Could not create wallet auth nonce."));
  }

  return {
    nonce: String(json.nonce),
    expiresAt: json?.expiresAt ? String(json.expiresAt) : null,
  };
}

function ownerSessionCacheKey(input: { walletAddress: string; chainId: number; draftId: string }) {
  return `${OWNER_SESSION_CACHE_PREFIX}${Number(input.chainId)}:${normalizeWallet(input.walletAddress)}:${input.draftId}`;
}

function readCachedOwnerSession(input: { walletAddress: string; chainId: number; draftId: string }): DraftActionAuth | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(ownerSessionCacheKey(input));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { auth?: DraftActionAuth; cachedAt?: number; expiresAt?: string | null };
    const auth = parsed?.auth;
    if (!auth) return null;

    const now = Date.now();
    const expiresAtMs = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : 0;
    const cachedAt = Number(parsed.cachedAt || 0);

    if (auth.action !== OWNER_SESSION_ACTION) return null;
    if (normalizeWallet(auth.walletAddress) !== normalizeWallet(input.walletAddress)) return null;
    if (Number(auth.chainId) !== Number(input.chainId)) return null;
    if (String(auth.draftId || "") !== input.draftId) return null;
    if (!auth.nonce || !auth.message || !auth.signature) return null;
    if (cachedAt <= 0 || now - cachedAt > OWNER_SESSION_MAX_AGE_MS) return null;
    if (expiresAtMs && expiresAtMs <= now + OWNER_SESSION_SAFETY_WINDOW_MS) return null;

    return auth;
  } catch {
    return null;
  }
}

function cacheOwnerSession(input: {
  auth: DraftActionAuth;
  walletAddress: string;
  chainId: number;
  draftId: string;
  expiresAt: string | null;
}) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      ownerSessionCacheKey(input),
      JSON.stringify({ auth: input.auth, cachedAt: Date.now(), expiresAt: input.expiresAt })
    );
  } catch {
    // Ignore storage failures. The user can still sign again.
  }
}

function clearCachedOwnerSession(input: { walletAddress: string; chainId: number; draftId: string }) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(ownerSessionCacheKey(input));
    window.sessionStorage.removeItem(
      `${LEGACY_OWNER_SESSION_CACHE_PREFIX}${Number(input.chainId)}:${normalizeWallet(input.walletAddress)}:${input.draftId}`,
    );
  } catch {
    // Ignore storage failures. The user can still sign again.
  }
}

function shouldRetryWithFreshOwnerSession(error: any) {
  const text = String(error?.error || error?.message || "").toLowerCase();
  return text.includes("nonce not found") || text.includes("nonce already used") || text.includes("nonce expired") || text.includes("please sign again");
}

function verifySignatureWallet(message: string, signature: string, walletAddress: string) {
  try {
    return normalizeWallet(verifyMessage(message, signature)) === normalizeWallet(walletAddress);
  } catch {
    return false;
  }
}

type DraftApiEip1193Provider = {
  request?: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  selectedAddress?: string | null;
  providers?: DraftApiEip1193Provider[];
  [key: string]: any;
};

type DraftApiEip6963ProviderInfo = {
  uuid?: string;
  name?: string;
  icon?: string;
  rdns?: string;
};

type DraftApiEip6963ProviderDetail = {
  info?: DraftApiEip6963ProviderInfo;
  provider?: DraftApiEip1193Provider;
};

const EIP6963_PROVIDERS = new Map<string, DraftApiEip1193Provider>();
let eip6963DiscoveryStarted = false;
let eip6963DiscoveryRequested = false;

function startEip6963Discovery() {
  if (typeof window === "undefined") return;

  if (!eip6963DiscoveryStarted) {
    window.addEventListener("eip6963:announceProvider", (event: Event) => {
      const detail = (event as CustomEvent<DraftApiEip6963ProviderDetail>).detail;
      const provider = detail?.provider;
      if (!provider?.request) return;

      try {
        provider.__mwzEip6963Info = detail.info || {};
      } catch {
        // Provider objects are usually mutable, but legacy wrappers may not be.
      }

      const info = detail.info || {};
      const key = info.uuid || info.rdns || info.name || String(EIP6963_PROVIDERS.size + 1);
      EIP6963_PROVIDERS.set(key, provider);
    });
    eip6963DiscoveryStarted = true;
  }

  if (eip6963DiscoveryRequested) return;
  eip6963DiscoveryRequested = true;

  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    // Legacy provider detection still works.
  }
}

function dedupeProviders(candidates: Array<DraftApiEip1193Provider | null | undefined>) {
  const seen = new Set<DraftApiEip1193Provider>();
  return candidates.filter((candidate): candidate is DraftApiEip1193Provider => {
    if (!candidate?.request || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

async function waitForEip6963Providers() {
  startEip6963Discovery();
  if (EIP6963_PROVIDERS.size > 0) return Array.from(EIP6963_PROVIDERS.values());
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  return Array.from(EIP6963_PROVIDERS.values());
}

async function getInjectedProviders() {
  const eth = (globalThis as any)?.ethereum as DraftApiEip1193Provider | undefined;
  const legacy = eth ? (Array.isArray(eth.providers) ? eth.providers : [eth]) : [];
  const eip6963 = typeof window === "undefined" ? [] : await waitForEip6963Providers();
  return dedupeProviders([...eip6963, ...legacy]);
}

function providerText(provider: any) {
  const eip6963Info = provider?.__mwzEip6963Info || {};
  const parts = [
    eip6963Info?.name,
    eip6963Info?.rdns,
    provider?.providerInfo?.name,
    provider?.providerInfo?.rdns,
    provider?.info?.name,
    provider?.info?.rdns,
    provider?.metadata?.name,
    provider?.metadata?.rdns,
    provider?.name,
    provider?._walletName,
    provider?.rdns,
    provider?._rdns,
  ];
  return parts.map((item) => String(item || "").toLowerCase()).join(" ");
}

function isCryptoComProvider(provider: any) {
  const text = providerText(provider);
  return Boolean(
    provider?.isCryptoCom ||
      provider?.isCryptoComWallet ||
      provider?.isDefiWallet ||
      provider?.isDeFiWallet ||
      provider?.deficonnectProvider ||
      text.includes("crypto.com") ||
      text.includes("cryptocom") ||
      text.includes("crypto com") ||
      text.includes("defi wallet")
  );
}

function isMetaMaskProvider(provider: any) {
  const text = providerText(provider);
  return Boolean(
    (provider?.isMetaMask || provider?._metamask || text.includes("metamask") || text.includes("io.metamask")) &&
      !isCryptoComProvider(provider)
  );
}

function selectedWalletId() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("mwz:selected_wallet") || "").toLowerCase();
  } catch {
    return "";
  }
}

async function providerAccounts(provider: any) {
  const selected = normalizeWallet(provider?.selectedAddress || "");
  if (selected) return [selected];

  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    return Array.isArray(accounts) ? accounts.map((item) => normalizeWallet(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function findProviderForWallet(walletAddress: string) {
  const wallet = normalizeWallet(walletAddress);
  const providers = await getInjectedProviders();
  const selected = selectedWalletId();

  const selectedMatches = providers.filter((provider: any) => {
    if (selected.startsWith("metamask")) return isMetaMaskProvider(provider);
    if (selected.startsWith("cryptocom")) return isCryptoComProvider(provider);
    const text = providerText(provider);
    return selected ? text.includes(selected) : false;
  });

  for (const provider of selectedMatches) {
    const accounts = await providerAccounts(provider);
    if (accounts.includes(wallet)) return provider;
  }

  const selectedMetaMask = selectedMatches.find((provider: any) => isMetaMaskProvider(provider));
  if (selected.startsWith("metamask") && selectedMetaMask) return selectedMetaMask;

  const metaMaskProvider = providers.find((provider: any) => isMetaMaskProvider(provider));
  if (!selected.startsWith("cryptocom") && metaMaskProvider) {
    const metaMaskAccounts = await providerAccounts(metaMaskProvider);
    if (selected.startsWith("metamask") || metaMaskAccounts.includes(wallet)) return metaMaskProvider;
  }

  const accountMatches: any[] = [];
  for (const provider of providers) {
    const accounts = await providerAccounts(provider);
    if (accounts.includes(wallet)) accountMatches.push(provider);
  }

  if (accountMatches.length > 0) {
    if (selected.startsWith("cryptocom")) {
      return accountMatches.find((provider) => isCryptoComProvider(provider)) || selectedMatches[0] || accountMatches[0];
    }

    if (selected.startsWith("metamask")) {
      return (
        accountMatches.find((provider) => isMetaMaskProvider(provider)) ||
        selectedMatches[0] ||
        accountMatches.find((provider) => !isCryptoComProvider(provider)) ||
        accountMatches[0]
      );
    }

    return (
      accountMatches.find((provider) => isMetaMaskProvider(provider)) ||
      accountMatches.find((provider) => !isCryptoComProvider(provider)) ||
      accountMatches[0]
    );
  }

  if (selected.startsWith("metamask") && selectedMatches[0]) return selectedMatches[0];
  if (selected.startsWith("cryptocom") && selectedMatches[0]) return selectedMatches[0];

  const metamask = providers.find((provider: any) => isMetaMaskProvider(provider));
  if (metamask) return metamask;

  return providers.find((provider: any) => !isCryptoComProvider(provider)) || providers[0] || null;
}

async function signWithInjectedWallet(message: string, walletAddress: string) {
  const wallet = normalizeWallet(walletAddress);
  const provider = await findProviderForWallet(wallet);

  if (!provider?.request) throw new Error("Wallet signer unavailable. Reconnect your wallet and try again.");

  const accounts = await provider.request({ method: "eth_requestAccounts" }).catch(() => []);
  const active = normalizeWallet(Array.isArray(accounts) ? accounts[0] : "");

  if (active && active !== wallet) {
    throw new Error("Connected wallet does not match this action. Switch to the selected wallet and try again.");
  }

  const attempts = [[message, wallet], [wallet, message]];
  let lastError: any = null;

  for (const params of attempts) {
    try {
      const signature = String(await provider.request({ method: "personal_sign", params }));
      if (verifySignatureWallet(message, signature, wallet)) return signature;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError?.message) throw lastError;
  throw new Error("Wallet signature could not be verified. Reconnect the selected wallet and try again.");
}

async function signDraftActionWithKnownChain(input: {
  action: DraftAuthAction;
  draftId: string;
  walletAddress: string;
  chainId: number;
  useOwnerSession?: boolean;
  forceNewOwnerSession?: boolean;
}): Promise<DraftActionAuth> {
  const walletAddress = normalizeWallet(input.walletAddress);
  if (!walletAddress) throw new Error("Wallet address missing. Reconnect your wallet and try again.");

  const chainId = Number(input.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("Invalid draft chain id. Refresh and try again.");

  // Solana drafts must use Ed25519 signing — personal_sign always fails / mismatches.
  if (isSolanaWalletAddress(walletAddress) || chainId === 101 || chainId === 102) {
    const { signSolanaDraftAction } = await import("@/lib/solanaWallet");
    return signSolanaDraftAction({
      walletAddress,
      chainId,
      action: input.action,
      draftId: input.draftId,
      forceNewOwnerSession: Boolean(input.forceNewOwnerSession),
    });
  }

  if (input.useOwnerSession) {
    const cacheInput = { walletAddress, chainId, draftId: input.draftId };
    if (!input.forceNewOwnerSession) {
      const cached = readCachedOwnerSession(cacheInput);
      if (cached) return cached;
    } else {
      clearCachedOwnerSession(cacheInput);
    }
  }

  const actionToSign = input.useOwnerSession ? OWNER_SESSION_ACTION : input.action;
  const { nonce, expiresAt } = await fetchNonce(chainId, walletAddress);
  const message = buildDraftAuthMessage({ action: actionToSign, walletAddress, chainId, nonce, draftId: input.draftId });
  const signature = await signWithInjectedWallet(message, walletAddress);

  const auth = { action: actionToSign, walletAddress, chainId, draftId: input.draftId, nonce, message, signature };

  if (input.useOwnerSession) {
    cacheOwnerSession({ auth, walletAddress, chainId, draftId: input.draftId, expiresAt });
  }

  return auth;
}

async function resolveConnectedEvmChainId(): Promise<number> {
  try {
    const eth = (globalThis as any)?.ethereum;
    if (eth?.request) {
      const hex = await eth.request({ method: "eth_chainId" });
      const n = Number.parseInt(String(hex), 16);
      if (n === BNB_CHAIN_ID || n === BNB_TESTNET_CHAIN_ID) return n;
    }
  } catch {
    /* ignore */
  }
  return BNB_CHAIN_ID;
}

/** Sign follow/arm on the WALLET's chain, not the draft's chain. */
async function resolveEngagementSignerChainId(walletAddress: string, draftChainId: number): Promise<number> {
  if (isSolanaWalletAddress(walletAddress)) return SOLANA_CHAIN_ID;
  if (draftChainId === BNB_CHAIN_ID || draftChainId === BNB_TESTNET_CHAIN_ID) return draftChainId;
  return resolveConnectedEvmChainId();
}

async function signPrepareEngagement(input: {
  action: "follow_draft" | "comment_draft" | "arm_draft_notifications" | "react_draft_comment";
  draftId: string;
  walletAddress: string;
}): Promise<DraftActionAuth> {
  const walletAddress = normalizeWallet(input.walletAddress);
  if (!walletAddress) throw new Error("Wallet address missing. Reconnect your wallet and try again.");
  const bundle = await fetchCampaignDraft(input.draftId, walletAddress);
  const draftChainId = Number(bundle.draft.chainId);
  const isSocialAction =
    input.action === "follow_draft" ||
    input.action === "arm_draft_notifications" ||
    input.action === "comment_draft" ||
    input.action === "react_draft_comment";

  let chainId = draftChainId;
  if (isSocialAction) {
    chainId = await resolveEngagementSignerChainId(walletAddress, draftChainId);
  } else {
    // Comments / reacts stay on the previous same-chain-oriented remap.
    const isEvmWallet = /^0x[a-f0-9]{40}$/i.test(walletAddress);
    if (isEvmWallet && (draftChainId === 101 || draftChainId === 102 || !Number.isFinite(draftChainId))) {
      chainId = await resolveConnectedEvmChainId();
    }
  }
  return signDraftActionWithKnownChain({ action: input.action, draftId: input.draftId, walletAddress, chainId });
}

async function postPrivateRead(url: string, auth: DraftActionAuth) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth }),
  });
}

async function retryPrivateReadWithAuth(
  url: string,
  walletAddress: string | null | undefined,
  json: any,
  fallbackDraftId?: string | null
): Promise<PrepareDraftBundle> {
  const wallet = normalizeWallet(walletAddress || "");
  if (!wallet) throw new Error(String(json?.error || "Private draft requires the owner wallet."));

  const chainId = Number(json?.chainId);
  const draftId = String(json?.draftId || fallbackDraftId || "");
  if (!draftId) throw new Error("Private draft auth could not identify the draft. Refresh and try again.");

  const auth = await signDraftActionWithKnownChain({ action: "read_draft", draftId, walletAddress: wallet, chainId, useOwnerSession: true });
  let res = await postPrivateRead(url, auth);

  if (!res.ok) {
    const errorJson = await readResponseJson(res);
    if (res.status === 401 && shouldRetryWithFreshOwnerSession(errorJson)) {
      const freshAuth = await signDraftActionWithKnownChain({
        action: "read_draft",
        draftId,
        walletAddress: wallet,
        chainId,
        useOwnerSession: true,
        forceNewOwnerSession: true,
      });
      res = await postPrivateRead(url, freshAuth);
    } else {
      throw new Error(String(errorJson?.error || errorJson?.message || `Request failed (${res.status})`));
    }
  }

  return parseJson(res) as Promise<PrepareDraftBundle>;
}

export type TickerReservationStatus =
  | "DRAFT_UNRESERVED"
  | "SOFT_RESERVED"
  | "PREPARE_MODE_RESERVED"
  | "SCHEDULED_UNARMED"
  | "ARM_AUTHORIZED"
  | "ARMING"
  | "ARMED_ONCHAIN"
  | "LIVE"
  | "DEPLOY_FAILED"
  | "EXPIRED_GRACE"
  | "RELEASED"
  | "SCHEDULE_MISSED";

export type TickerReservation = {
  id: string;
  draftId: string | null;
  creatorWallet: string;
  chainId: number;
  cluster: string;
  originalTicker: string;
  normalizedTicker: string;
  tickerHash: string;
  reservationIdHash: string;
  status: TickerReservationStatus;
  reservedAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  graceEndAt: string | null;
  renewalCount: number;
  scheduledLaunchAt: string | null;
  armAuthorizedAt: string | null;
  armingAt: string | null;
  armedAt: string | null;
  liveAt: string | null;
  scheduleMissedAt: string | null;
  releasedAt: string | null;
  programId: string | null;
  generationId: string | null;
  campaignPda: string | null;
  mint: string | null;
  deploymentSignature: string | null;
  reservationVersion: string;
  authorizationNonce: string | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type TickerReservationOperation = "read" | "renew" | "release" | "reclaim";

export type TickerReservationManagementResult = {
  operation: TickerReservationOperation;
  draftId: string;
  ticker: string;
  chainId: number;
  reservation: TickerReservation | null;
  availableActions: Array<"renew" | "release" | "reclaim">;
};

export type DraftVisibility = "public" | "unlisted" | "private";
export type DraftStatus = "draft" | "promotion_published" | "ready_to_launch" | "scheduled" | "deployed" | "archived";

export type CampaignDraft = {
  id: string;
  chainId: number;
  creatorWallet: string;
  name: string;
  ticker: string;
  description: string | null;
  category: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  otherUrl: string | null;
  slug: string;
  status: DraftStatus;
  visibility: DraftVisibility;
  campaignAddress: string | null;
  tokenAddress: string | null;
  deployTxHash: string | null;
  archivedAt: string | null;
  deployedAt: string | null;
  graduationTargetWei: string;
  scheduledLaunchAt?: string | null;
  createdAt: string;
  updatedAt: string;
  tickerReservation?: TickerReservation | null;
  graduationQuoteAssetId?: string | null;
  graduationQuoteStateVersion?: number | null;
  graduationMarketKind?: string | null;
  graduationQuoteAsset?: string | null;
  graduationMarketPolicyVersion?: string | null;
};

export type CampaignDraftPromotion = {
  draftId: string;
  missionStatement: string;
  roadmap: string[];
  launchStrategy: string;
  telegramUrl: string;
  discordUrl: string;
  xUrl: string;
  websiteUrl: string;
  docs: string[];
  creatorNote: string;
  bannerUrl: string;
  shareMessage: string;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DraftPopularity = {
  views: number;
  follows: number;
  comments: number;
  reactions: number;
  shares: number;
  signedActions: number;
  armedCount: number;
  popularityPercentage: number;
  heatLabel: "Cold" | "Warming" | "Hot" | "On Fire";
  rankingScore: number;
};

export type DraftComment = {
  id: string;
  draftId: string;
  walletAddress: string;
  displayName: string | null;
  /** Profile avatar when set; UI falls back to placeholder gradient. */
  avatarUrl?: string | null;
  body: string;
  parentCommentId: string | null;
  reactionCount: number;
  /** True when the requesting wallet has an active fire reaction on this comment. */
  viewerReacted?: boolean;
  createdAt: string;
  replies?: DraftComment[];
};

export type PrepareDraftBundle = {
  draft: CampaignDraft;
  promotion: CampaignDraftPromotion;
  popularity: DraftPopularity;
  viewer?: {
    wallet: string | null;
    isFollowing: boolean;
    isArmed: boolean;
  };
};

const JUST_CREATED_DRAFT_CACHE_PREFIX = "mwz:just-created-draft:";
const JUST_CREATED_DRAFT_CACHE_TTL_MS = 5 * 60 * 1000;
const DRAFT_READ_IN_FLIGHT = new Map<string, Promise<PrepareDraftBundle>>();
const DRAFT_READ_RESULT_CACHE = new Map<string, { bundle: PrepareDraftBundle; cachedAt: number }>();
const DRAFT_READ_RESULT_CACHE_TTL_MS = 10_000;

function emptyPromotion(draftId: string): CampaignDraftPromotion {
  return {
    draftId,
    missionStatement: "",
    roadmap: [],
    launchStrategy: "",
    telegramUrl: "",
    discordUrl: "",
    xUrl: "",
    websiteUrl: "",
    docs: [],
    creatorNote: "",
    bannerUrl: "",
    shareMessage: "",
    publishedAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

function emptyPopularity(): DraftPopularity {
  return { views: 0, follows: 0, comments: 0, reactions: 0, shares: 0, signedActions: 0, armedCount: 0, popularityPercentage: 0, heatLabel: "Cold", rankingScore: 0 };
}

function cacheJustCreatedDraft(bundle: PrepareDraftBundle) {
  const draft = bundle?.draft;
  if (typeof window === "undefined" || !draft?.id) return;
  try {
    window.sessionStorage.setItem(
      `${JUST_CREATED_DRAFT_CACHE_PREFIX}${draft.id}`,
      JSON.stringify({ bundle, cachedAt: Date.now() }),
    );
  } catch {}
}

function clearJustCreatedDraftCache(draftId: string) {
  if (typeof window === "undefined" || !draftId) return;
  try {
    window.sessionStorage.removeItem(`${JUST_CREATED_DRAFT_CACHE_PREFIX}${draftId}`);
  } catch {}
}

function readJustCreatedDraftBundle(draftId: string): PrepareDraftBundle | null {
  if (typeof window === "undefined" || !draftId) return null;
  const key = `${JUST_CREATED_DRAFT_CACHE_PREFIX}${draftId}`;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { bundle?: PrepareDraftBundle; draft?: CampaignDraft; cachedAt?: number };
    if (!parsed.cachedAt || Date.now() - parsed.cachedAt > JUST_CREATED_DRAFT_CACHE_TTL_MS) return null;
    if (parsed.bundle?.draft?.id === draftId) return parsed.bundle;
    if (parsed.draft?.id === draftId) {
      return { draft: parsed.draft, promotion: emptyPromotion(draftId), popularity: emptyPopularity() };
    }
    return null;
  } catch {
    try {
      window.sessionStorage.removeItem(key);
    } catch {}
    return null;
  }
}

export type CreateDraftInput = {
  auth?: DraftActionAuth;
  chainId: number;
  cluster?: string;
  creatorWallet: string;
  name: string;
  ticker: string;
  description?: string | null;
  category?: string | null;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  discordUrl?: string | null;
  docs?: string[];
  otherUrl?: string | null;
  graduationTargetWei?: string;
  visibility?: DraftVisibility;
  graduationQuoteAssetId?: string | null;
  graduationQuoteStateVersion?: number | null;
  graduationMarketKind?: string | null;
  graduationQuoteAsset?: string | null;
  graduationMarketPolicyVersion?: string | null;
};

export type SavePromotionInput = {
  auth?: DraftActionAuth;
  missionStatement?: string;
  roadmap?: string[];
  launchStrategy?: string;
  telegramUrl?: string;
  discordUrl?: string;
  xUrl?: string;
  websiteUrl?: string;
  docs?: string[];
  creatorNote?: string;
  bannerUrl?: string;
  visibility?: DraftVisibility;
  shareMessage?: string;
  publish?: boolean;
};

export type TickerAvailability = {
  ticker: string;
  chainId?: number;
  cluster?: string;
  available: boolean;
  reason: string;
  source: "validation" | "draft" | "campaign" | "available" | string;
  reservation?: Pick<TickerReservation, "status" | "expiresAt" | "graceEndAt" | "renewalCount" | "scheduledLaunchAt" | "reservationVersion"> | null;
};

export async function checkTickerAvailability(input: { ticker: string; chainId?: number; cluster?: string }): Promise<TickerAvailability> {
  const res = await apiFetch(`/api/drafts/ticker-availability${query({
    ticker: input.ticker,
    chainId: input.chainId,
    cluster: input.cluster,
  })}`, { cache: "no-store" });
  return parseJson(res) as Promise<TickerAvailability>;
}

export async function createCampaignDraft(input: CreateDraftInput): Promise<CampaignDraft> {
  const res = await apiFetch("/api/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJson(res);
  const draft = {
    ...(json.draft as CampaignDraft),
    tickerReservation: (json.tickerReservation as TickerReservation | null | undefined) ?? json.draft?.tickerReservation ?? null,
  };
  const bundle: PrepareDraftBundle = {
    draft,
    promotion: (json.promotion as CampaignDraftPromotion | undefined) || emptyPromotion(draft.id),
    popularity: (json.popularity as DraftPopularity | undefined) || emptyPopularity(),
    viewer: json.viewer,
  };
  cacheJustCreatedDraft(bundle);
  return draft;
}

export async function fetchPublicCampaignDrafts(input: { chainId?: number; limit?: number } = {}): Promise<CampaignDraft[]> {
  const res = await apiFetch(`/api/drafts${query({ chainId: input.chainId, limit: input.limit })}`, { cache: "no-store" });
  const json = await parseJson(res);
  return Array.isArray(json.items) ? (json.items as CampaignDraft[]) : [];
}

export async function fetchOwnerCampaignDrafts(owner: string, input: { chainId?: number; limit?: number } = {}): Promise<CampaignDraft[]> {
  const res = await apiFetch(`/api/drafts${query({ owner, chainId: input.chainId, limit: input.limit })}`, { cache: "no-store" });
  const json = await parseJson(res);
  return Array.isArray(json.items) ? (json.items as CampaignDraft[]) : [];
}

export async function fetchFollowedCampaignDrafts(input: { walletAddress: string; chainId?: number }): Promise<CampaignDraft[]> {
  const res = await apiFetch(`/api/drafts/followed${query({ wallet: input.walletAddress })}`, { cache: "no-store" });
  const json = await parseJson(res);
  return Array.isArray(json.items) ? (json.items as CampaignDraft[]) : [];
}

export async function fetchCampaignDraft(draftId: string, viewer?: string | null): Promise<PrepareDraftBundle> {
  const justCreatedBundle = readJustCreatedDraftBundle(draftId);
  if (justCreatedBundle) return justCreatedBundle;

  const readKey = `${draftId}:${normalizeWallet(viewer || "") || "public"}`;
  const cachedResult = DRAFT_READ_RESULT_CACHE.get(readKey);
  if (cachedResult && Date.now() - cachedResult.cachedAt <= DRAFT_READ_RESULT_CACHE_TTL_MS) {
    return cachedResult.bundle;
  }
  if (cachedResult) DRAFT_READ_RESULT_CACHE.delete(readKey);

  const existing = DRAFT_READ_IN_FLIGHT.get(readKey);
  if (existing) return existing;

  const request = (async () => {
    const url = apiUrl(`/api/drafts/${encodeURIComponent(draftId)}${query({ viewer })}`);
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));

    if (res.ok) {
      const bundle = json as PrepareDraftBundle;
      DRAFT_READ_RESULT_CACHE.set(readKey, { bundle, cachedAt: Date.now() });
      return bundle;
    }
    if (res.status === 401 && json?.code === "PRIVATE_DRAFT_AUTH_REQUIRED") {
      const bundle = await retryPrivateReadWithAuth(url, viewer, json, draftId);
      DRAFT_READ_RESULT_CACHE.set(readKey, { bundle, cachedAt: Date.now() });
      return bundle;
    }
    throw new Error(String(json?.error || json?.message || `Request failed (${res.status})`));
  })();

  DRAFT_READ_IN_FLIGHT.set(readKey, request);
  try {
    return await request;
  } finally {
    DRAFT_READ_IN_FLIGHT.delete(readKey);
  }
}

export async function fetchCampaignDraftWithAuth(draftId: string, auth: DraftActionAuth): Promise<PrepareDraftBundle> {
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth }),
  });
  return parseJson(res) as Promise<PrepareDraftBundle>;
}

export async function saveDraftPromotion(draftId: string, input: SavePromotionInput): Promise<PrepareDraftBundle> {
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/promotion`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const bundle = await parseJson(res) as PrepareDraftBundle;
  clearJustCreatedDraftCache(draftId);
  return bundle;
}

export async function fetchPrepareDraft(
  slug: string,
  viewer?: string | null,
  options?: { evmAccount?: string | null; solanaAccount?: string | null },
): Promise<PrepareDraftBundle> {
  const url = apiUrl(`/api/prepare/${encodeURIComponent(slug)}${query({ viewer })}`);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  if (res.ok) return json as PrepareDraftBundle;
  if (res.status === 401 && json?.code === "PRIVATE_DRAFT_AUTH_REQUIRED") {
    const chainId = Number(json?.chainId);
    const ownerWallet =
      chainId === SOLANA_CHAIN_ID || chainId === 102
        ? options?.solanaAccount || viewer
        : options?.evmAccount || viewer;
    return retryPrivateReadWithAuth(url, ownerWallet, json, json?.draftId || null);
  }
  throw new Error(String(json?.error || json?.message || `Request failed (${res.status})`));
}

export async function followDraft(input: DraftActionAuth | string, walletAddress?: string): Promise<{ following: boolean; followCount: number }> {
  const draftId = typeof input === "string" ? input : String(input.draftId || "");
  const wallet = typeof input === "string" ? normalizeWallet(walletAddress || "") : normalizeWallet(input.walletAddress || walletAddress || "");

  if (!draftId) throw new Error("Draft id missing.");
  if (!wallet) throw new Error("Connect wallet to follow this draft.");

  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/follow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet }),
  });
  const json = await parseJson(res);
  return { following: Boolean(json.following), followCount: Number(json.followCount || 0) };
}

export async function armDraftNotifications(input: DraftActionAuth | string, walletAddress?: string): Promise<{ armed: boolean }> {
  const auth = typeof input === "string"
    ? await signPrepareEngagement({ action: "arm_draft_notifications", draftId: input, walletAddress: walletAddress || "" })
    : input;

  const draftId = String(auth.draftId || "");
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth }),
  });
  const json = await parseJson(res);
  return { armed: Boolean(json.armed) };
}

export async function fetchDraftComments(
  draftId: string,
  walletAddress?: string | null
): Promise<DraftComment[]> {
  const params = new URLSearchParams();
  const wallet = normalizeWallet(walletAddress || "");
  if (wallet) params.set("wallet", wallet);
  const query = params.toString();
  const res = await apiFetch(
    `/api/drafts/${encodeURIComponent(draftId)}/comments${query ? `?${query}` : ""}`
  );
  const json = await parseJson(res);
  return Array.isArray(json.items) ? (json.items as DraftComment[]) : [];
}

export async function addDraftComment(
  input: DraftActionAuth | string,
  walletAddressOrBody: string,
  bodyOrParentCommentId?: string | null,
  parentCommentIdArg?: string | null
): Promise<DraftComment> {
  const oldSignature = typeof input === "string";
  const draftId = oldSignature ? input : String(input.draftId || "");
  const auth = oldSignature ? await signPrepareEngagement({ action: "comment_draft", draftId, walletAddress: walletAddressOrBody }) : input;
  const body = oldSignature ? String(bodyOrParentCommentId || "") : walletAddressOrBody;
  const parentCommentId = oldSignature ? parentCommentIdArg : bodyOrParentCommentId;

  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, body, parentCommentId: parentCommentId || null }),
  });
  const json = await parseJson(res);
  return json.comment as DraftComment;
}

export async function toggleDraftCommentReaction(
  draftId: string,
  commentId: string,
  walletAddress: string
): Promise<{ reacted: boolean; reactionCount: number; commentId: string }> {
  const auth = await signPrepareEngagement({
    action: "react_draft_comment",
    draftId,
    walletAddress,
  });

  const res = await apiFetch(
    `/api/drafts/${encodeURIComponent(draftId)}/comments/${encodeURIComponent(commentId)}/reactions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth }),
    }
  );
  const json = await parseJson(res);
  return {
    reacted: Boolean(json.reacted),
    reactionCount: Number(json.reactionCount || 0),
    commentId: String(json.commentId || commentId),
  };
}

export async function manageTickerReservation(input: {
  draftId: string;
  walletAddress: string;
  chainId: number;
  operation: TickerReservationOperation;
  auth?: DraftActionAuth | null;
}): Promise<TickerReservationManagementResult> {
  const send = async (auth: DraftActionAuth) => {
    const res = await apiFetch(`/api/drafts/${encodeURIComponent(input.draftId)}/ticker-reservation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: input.operation, auth }),
    });
    const json = await readResponseJson(res);
    return { res, json };
  };

  let auth = input.auth || await signDraftActionWithKnownChain({
    action: "manage_ticker_reservation",
    draftId: input.draftId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    useOwnerSession: true,
  });
  let attempt = await send(auth);

  if (attempt.res.status === 401 && shouldRetryWithFreshOwnerSession(attempt.json)) {
    auth = await signDraftActionWithKnownChain({
      action: "manage_ticker_reservation",
      draftId: input.draftId,
      walletAddress: input.walletAddress,
      chainId: input.chainId,
      useOwnerSession: true,
      forceNewOwnerSession: true,
    });
    attempt = await send(auth);
  }

  if (!attempt.res.ok) {
    throw new Error(String(attempt.json?.error || attempt.json?.message || `Request failed (${attempt.res.status})`));
  }
  return attempt.json as TickerReservationManagementResult;
}

export async function archiveCampaignDraft(draftId: string, auth: DraftActionAuth): Promise<PrepareDraftBundle> {
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth }),
  });
  return parseJson(res) as Promise<PrepareDraftBundle>;
}

export async function markDraftDeployed(
  draftId: string,
  input: {
    auth: DraftActionAuth;
    campaignAddress: string;
    tokenAddress?: string | null;
    deployTxHash?: string | null;
    /** Solana V4: persist vaults + campaignId into campaigns.meta.solana */
    tokenVault?: string | null;
    solVault?: string | null;
    campaignId?: number[] | string | null;
    factoryAddress?: string | null;
    scheduledLaunchAt?: number | null;
  }
): Promise<CampaignDraft> {
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      auth: input.auth,
      campaignAddress: input.campaignAddress,
      tokenAddress: input.tokenAddress || null,
      deployTxHash: input.deployTxHash || null,
      scheduledLaunchAt: input.scheduledLaunchAt || null,
      tokenVault: input.tokenVault || null,
      solVault: input.solVault || null,
      campaignId: input.campaignId || null,
      factoryAddress: input.factoryAddress || null,
    }),
  });
  const json = await parseJson(res);
  return {
    ...(json.draft as CampaignDraft),
    tickerReservation: (json.tickerReservation as TickerReservation | null | undefined) ?? json.draft?.tickerReservation ?? null,
  };
}

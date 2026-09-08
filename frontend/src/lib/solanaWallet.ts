import type { DraftActionAuth, DraftAuthAction } from "@/lib/draftAuth";
import { apiFetch } from "@/lib/apiBase";
import { detectWalletStandardSolanaWallets } from "@/lib/solanaWalletStandard";

export const SOLANA_WALLET_STORAGE_KEY = "mwz:solana_wallet";
export const SOLANA_WALLET_NAME_STORAGE_KEY = "mwz:solana_wallet_name";
export const SOLANA_WALLET_ID_STORAGE_KEY = "mwz:solana_wallet_id";
export const SOLANA_WALLET_DISCONNECTED_KEY = "mwz:solana_wallet_disconnected";
export const SOLANA_WALLET_EVENT = "memewarzone:solana-wallet-changed";

export type SolanaProvider = {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: { toString: () => string } | null;
  connect?: (args?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString: () => string } }>;
  disconnect?: () => Promise<void>;
  signMessage?: (message: Uint8Array, encoding?: "utf8") => Promise<{ signature: Uint8Array } | Uint8Array>;
  signTransaction?: (transaction: unknown) => Promise<any>;
  signAndSendTransaction?: (transaction: unknown) => Promise<{ signature?: string } | string>;
  on?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  [key: string]: unknown;
};

const CONNECT_TIMEOUT_MS = 25_000;
const OTHER_WALLET_DISCONNECT_MS = 200;

function debugLog(step: string, data?: any) {
  console.log(`[Solana Wallet Debug] ${step}`, data ? data : "");
}

async function withTimeout<T>(promise: Promise<T> | undefined | null, ms: number, message: string): Promise<T> {
  if (!promise) throw new Error(message);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function providerPublicKey(provider?: SolanaProvider | null): string {
  return normalizePublicKey(provider?.publicKey?.toString?.() || "");
}

function alreadyConnectedKey(provider?: SolanaProvider | null): string {
  const key = providerPublicKey(provider);
  if (!key) return "";
  if (provider?.isConnected === false) return "";
  return key;
}

export type DetectedSolanaWallet = {
  id: string;
  name: string;
  icon: string;
  provider: SolanaProvider;
};

function normalizePublicKey(value: string) {
  return String(value || "").trim();
}

function getWindowAny() {
  return typeof window === "undefined" ? {} : (window as any);
}

function solanaDisconnected() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOLANA_WALLET_DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function isSolanaWalletDisconnected(): boolean {
  return solanaDisconnected();
}

function setSolanaDisconnected(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(SOLANA_WALLET_DISCONNECTED_KEY, "1");
    else window.localStorage.removeItem(SOLANA_WALLET_DISCONNECTED_KEY);
  } catch {
    // ignore storage failures
  }
}

function addWallet(wallets: DetectedSolanaWallet[], seen: Set<SolanaProvider>, wallet: DetectedSolanaWallet | null) {
  if (!wallet?.provider || seen.has(wallet.provider)) return;
  if (wallets.some((item) => item.id === wallet.id)) return;
  if (typeof wallet.provider.connect !== "function") return;
  wallets.push(wallet);
  seen.add(wallet.provider);
}

export function detectSolanaWallets(): DetectedSolanaWallet[] {
  const w = getWindowAny();
  const wallets: DetectedSolanaWallet[] = [];
  const seen = new Set<SolanaProvider>();

  // Wallet Standard is authoritative for standards-compliant wallets. Legacy
  // globals remain only as a compatibility fallback for wallets that have not
  // adopted the standard yet.
  for (const wallet of detectWalletStandardSolanaWallets()) {
    addWallet(wallets, seen, wallet as DetectedSolanaWallet);
  }

  addWallet(wallets, seen, w.solana?.isPhantom ? { id: "legacy:phantom", name: "Phantom", icon: "👻", provider: w.solana } : null);
  addWallet(wallets, seen, w.phantom?.solana ? { id: "legacy:phantom", name: "Phantom", icon: "👻", provider: w.phantom.solana } : null);
  addWallet(wallets, seen, w.solflare ? { id: "legacy:solflare", name: "Solflare", icon: "☀️", provider: w.solflare } : null);
  addWallet(wallets, seen, w.solana?.isSolflare ? { id: "legacy:solflare", name: "Solflare", icon: "SOL", provider: w.solana } : null);
  addWallet(wallets, seen, w.backpack?.solana ? { id: "legacy:backpack", name: "Backpack", icon: "🎒", provider: w.backpack.solana } : null);
  addWallet(wallets, seen, w.glowSolana ? { id: "legacy:glow", name: "Glow", icon: "✨", provider: w.glowSolana } : null);

  return wallets;
}

export function getSolanaProvider(walletId?: string | null): SolanaProvider | null {
  const wallets = detectSolanaWallets();

  if (walletId) {
    return wallets.find((wallet) => wallet.id === walletId || wallet.name === walletId)?.provider || null;
  }

  const storedId = getStoredSolanaWalletId();
  if (storedId) {
    const stored = wallets.find((wallet) => wallet.id === storedId);
    if (stored) return stored.provider;
  }

  return wallets[0]?.provider || null;
}

function notifySolanaWalletChanged(publicKey: string, wallet?: DetectedSolanaWallet | null) {
  if (typeof window === "undefined") return;

  try {
    if (publicKey) {
      if (solanaDisconnected()) return;
      window.localStorage.setItem(SOLANA_WALLET_STORAGE_KEY, publicKey);
      if (wallet?.name) window.localStorage.setItem(SOLANA_WALLET_NAME_STORAGE_KEY, wallet.name);
      if (wallet?.id) window.localStorage.setItem(SOLANA_WALLET_ID_STORAGE_KEY, wallet.id);
    } else {
      window.localStorage.removeItem(SOLANA_WALLET_STORAGE_KEY);
      window.localStorage.removeItem(SOLANA_WALLET_NAME_STORAGE_KEY);
      window.localStorage.removeItem(SOLANA_WALLET_ID_STORAGE_KEY);
    }

    window.dispatchEvent(new CustomEvent(SOLANA_WALLET_EVENT, {
      detail: {
        publicKey,
        walletId: wallet?.id || "",
        walletName: wallet?.name || "",
      },
    }));
  } catch {
    // Ignore storage/event failures.
  }
}

export function getStoredSolanaWallet(): string {
  if (typeof window === "undefined" || solanaDisconnected()) return "";
  try {
    return normalizePublicKey(window.localStorage.getItem(SOLANA_WALLET_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

export function getStoredSolanaWalletName(): string {
  if (typeof window === "undefined" || solanaDisconnected()) return "";
  try {
    return window.localStorage.getItem(SOLANA_WALLET_NAME_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function getStoredSolanaWalletId(): string {
  if (typeof window === "undefined" || solanaDisconnected()) return "";
  try {
    return window.localStorage.getItem(SOLANA_WALLET_ID_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function refreshSolanaWalletFromProvider(walletId?: string | null): string {
  if (solanaDisconnected()) return "";
  const wallets = detectSolanaWallets();
  const selected =
    (walletId ? wallets.find((wallet) => wallet.id === walletId || wallet.name === walletId) : null) ||
    wallets.find((wallet) => wallet.id === getStoredSolanaWalletId());

  const publicKey = providerPublicKey(selected?.provider);
  if (publicKey) notifySolanaWalletChanged(publicKey, selected);
  return publicKey;
}

const attachedSolanaProviders = new WeakSet<object>();

export function ensureSolanaListeners(options: { readExistingAccount?: boolean } = {}): void {
  const wallets = detectSolanaWallets();

  wallets.forEach((wallet) => {
    const provider = wallet.provider;
    if (!provider || typeof provider !== "object") return;
    if (attachedSolanaProviders.has(provider as object)) return;

    attachedSolanaProviders.add(provider as object);

    const sync = (clearIfEmpty = false) => {
      if (solanaDisconnected()) return;
      const storedId = getStoredSolanaWalletId();
      if (storedId && storedId !== wallet.id) return;
      const key = providerPublicKey(provider);
      if (key || clearIfEmpty) notifySolanaWalletChanged(key, wallet);
    };

    try { provider.on?.("connect", () => sync(true)); } catch { }
    try {
      provider.on?.("disconnect", () => {
        const storedId = getStoredSolanaWalletId();
        if (storedId && storedId !== wallet.id) return;
        notifySolanaWalletChanged("");
      });
    } catch { }
    try { provider.on?.("accountChanged", () => sync(true)); } catch { }

    if (options.readExistingAccount) sync(false);
  });
}

export async function connectSolanaWallet(walletId?: string): Promise<{ publicKey: string; walletId: string; walletName: string }> {
  debugLog("connectSolanaWallet started", { walletId });
  setSolanaDisconnected(false);
  const wallets = detectSolanaWallets();
  const wallet = wallets.find((item) => item.id === walletId || item.name === walletId) || wallets[0];

  debugLog("Wallet resolved", { id: wallet?.id, name: wallet?.name });

  if (!wallet?.provider?.connect) {
    debugLog("Error: No supported Solana wallet detected");
    throw new Error("No standards-compatible or legacy Solana wallet detected.");
  }

  const previousId = getStoredSolanaWalletId();
  debugLog("previousId from storage", { previousId });

  try {
    window.localStorage.setItem(SOLANA_WALLET_ID_STORAGE_KEY, wallet.id);
    window.localStorage.setItem(SOLANA_WALLET_NAME_STORAGE_KEY, wallet.name);
  } catch {
    // ignore
  }

  if (previousId && previousId !== wallet.id) {
    debugLog("Disconnecting previous wallet", { previousId });
    try {
      await withTimeout(
        Promise.resolve(getSolanaProvider(previousId)?.disconnect?.()),
        OTHER_WALLET_DISCONNECT_MS,
        "Previous wallet disconnect timed out",
      );
      debugLog("Previous wallet disconnected successfully");
    } catch (e) {
      debugLog("Previous wallet disconnect failed or timed out", e);
    }
  }

  let result: { publicKey?: { toString: () => string } } | undefined;
  try {
    debugLog("Calling wallet.provider.connect() ...");
    const connectStart = performance.now();
    result = await withTimeout(
      wallet.provider.connect({ onlyIfTrusted: false }),
      CONNECT_TIMEOUT_MS,
      `${wallet.name} did not respond. Unlock it, approve the wallet request, then try again.`,
    );
    debugLog(`wallet.provider.connect() resolved in ${Math.round(performance.now() - connectStart)}ms`, { publicKey: result?.publicKey?.toString() });
  } catch (error) {
    debugLog("wallet.provider.connect() THREW AN ERROR", error);
    const message = error instanceof Error ? error.message : String(error || "");
    if (/user.*reject|denied|cancel/i.test(message)) {
      throw new Error(`${wallet.name} request was rejected.`);
    }
    throw error instanceof Error ? error : new Error(message || `Failed to connect ${wallet.name}.`);
  }

  const publicKey = normalizePublicKey(result?.publicKey?.toString() || providerPublicKey(wallet.provider));
  if (!publicKey) throw new Error("No Solana public key returned.");

  notifySolanaWalletChanged(publicKey, wallet);

  return {
    publicKey,
    walletId: wallet.id,
    walletName: wallet.name,
  };
}

export async function disconnectSolanaWallet(): Promise<void> {
  const provider = getSolanaProvider();
  setSolanaDisconnected(true);
  try {
    await withTimeout(Promise.resolve(provider?.disconnect?.()), OTHER_WALLET_DISCONNECT_MS, "Wallet disconnect timed out");
  } catch {
    // Local session is cleared even if the extension never answers.
  } finally {
    notifySolanaWalletChanged("");
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function ensureSolanaProviderSession(input: {
  provider: SolanaProvider;
  detectedWallet?: DetectedSolanaWallet | null;
  expectedWalletAddress?: string | null;
}): Promise<string> {
  const expected = normalizePublicKey(input.expectedWalletAddress || "");
  let publicKey = alreadyConnectedKey(input.provider);

  if (!publicKey) {
    if (!input.provider.connect) throw new Error("Solana wallet not connected.");
    setSolanaDisconnected(false);

    let result: { publicKey?: { toString: () => string } } | undefined;
    try {
      result = await withTimeout(
        input.provider.connect({ onlyIfTrusted: false }),
        CONNECT_TIMEOUT_MS,
        `${input.detectedWallet?.name || "Solana wallet"} did not respond. Unlock it and try again.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (/user.*reject|denied|cancel/i.test(message)) {
        throw new Error(`${input.detectedWallet?.name || "Solana wallet"} request was rejected.`);
      }
      throw error instanceof Error ? error : new Error(message || "Failed to reconnect Solana wallet.");
    }

    publicKey = normalizePublicKey(result?.publicKey?.toString() || providerPublicKey(input.provider));
  }

  if (!publicKey) throw new Error("Solana wallet not connected.");
  if (expected && publicKey !== expected) {
    throw new Error(
      `Connected wallet (${input.detectedWallet?.name || "extension"}) is ${publicKey.slice(0, 4)}…${publicKey.slice(-4)}, ` +
      `but this action expects ${expected.slice(0, 4)}…${expected.slice(-4)}. Reconnect the correct wallet.`,
    );
  }

  notifySolanaWalletChanged(publicKey, input.detectedWallet || null);
  return publicKey;
}

export async function signSolanaMessage(message: string, walletAddress?: string): Promise<{ walletAddress: string; signature: string }> {
  const storedId = getStoredSolanaWalletId();
  const detectedWallet = detectSolanaWallets().find((wallet) => wallet.id === storedId) || null;
  const provider = detectedWallet?.provider || getSolanaProvider(storedId || null);
  if (!provider?.signMessage) throw new Error("This Solana wallet does not support message signing.");

  const publicKey = await ensureSolanaProviderSession({
    provider,
    detectedWallet,
    expectedWalletAddress: walletAddress,
  });

  const encoded = new TextEncoder().encode(message);
  const signed = await provider.signMessage(encoded);
  const rawSig = signed instanceof Uint8Array ? signed : signed?.signature;
  const signature =
    rawSig instanceof Uint8Array
      ? rawSig
      : rawSig?.buffer
        ? new Uint8Array(rawSig.buffer, rawSig.byteOffset || 0, rawSig.byteLength || rawSig.length)
        : null;
  if (!signature?.length) throw new Error("Solana wallet did not return a signature.");

  notifySolanaWalletChanged(publicKey, detectedWallet);
  return { walletAddress: publicKey, signature: bytesToBase64(signature) };
}

async function fetchNonce(chainId: number, walletAddress: string) {
  const qs = new URLSearchParams({ chainId: String(chainId), address: walletAddress });
  const res = await apiFetch(`/api/auth/nonce?${qs.toString()}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json?.nonce) {
    throw new Error(String(json?.error || json?.message || `Request failed (${res.status})`));
  }

  return String(json.nonce);
}

function resolveSolanaProviderForAddress(walletAddress?: string): { provider: SolanaProvider; wallet: DetectedSolanaWallet | null } {
  const wallets = detectSolanaWallets();
  const wanted = normalizePublicKey(walletAddress || "");

  if (wanted) {
    const byKey = wallets.find((w) => normalizePublicKey(w.provider?.publicKey?.toString?.() || "") === wanted);
    if (byKey?.provider) return { provider: byKey.provider, wallet: byKey };
  }

  const storedId = getStoredSolanaWalletId();
  const byStored = storedId ? wallets.find((w) => w.id === storedId) : null;
  if (byStored?.provider) return { provider: byStored.provider, wallet: byStored };

  const fallback = wallets[0] || null;
  if (!fallback?.provider) throw new Error("No supported Solana wallet detected.");
  return { provider: fallback.provider, wallet: fallback };
}

const SOLANA_OWNER_SESSION_ACTION: DraftAuthAction = "draft_owner_session";
const SOLANA_OWNER_SESSION_ACTIONS = new Set<DraftAuthAction>([
  "read_draft",
  "save_promotion",
  "publish_promotion",
  "archive_draft",
  "deploy_draft",
  "manage_ticker_reservation",
]);
const SOLANA_OWNER_SESSION_CACHE_PREFIX = "mwz:solana-draft-owner-session:v1:";
const SOLANA_OWNER_SESSION_MAX_AGE_MS = 9 * 60 * 1000;
const SOLANA_OWNER_SESSION_SAFETY_WINDOW_MS = 15 * 1000;
const SOLANA_OWNER_SESSION_IN_FLIGHT = new Map<string, Promise<DraftActionAuth & { walletType: "solana" }>>();

function solanaOwnerSessionCacheKey(input: { walletAddress: string; chainId: number; draftId: string }) {
  return `${SOLANA_OWNER_SESSION_CACHE_PREFIX}${Number(input.chainId)}:${normalizePublicKey(input.walletAddress)}:${input.draftId}`;
}

function readSolanaOwnerSession(input: {
  walletAddress: string;
  chainId: number;
  draftId: string;
}): (DraftActionAuth & { walletType: "solana" }) | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(solanaOwnerSessionCacheKey(input));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      auth?: DraftActionAuth & { walletType?: "solana" };
      cachedAt?: number;
      expiresAt?: string | null;
    };
    const auth = parsed?.auth;
    const now = Date.now();
    const cachedAt = Number(parsed.cachedAt || 0);
    const expiresAtMs = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : 0;
    if (!auth || auth.action !== SOLANA_OWNER_SESSION_ACTION) return null;
    if (normalizePublicKey(auth.walletAddress) !== normalizePublicKey(input.walletAddress)) return null;
    if (Number(auth.chainId) !== Number(input.chainId)) return null;
    if (String(auth.draftId || "") !== input.draftId) return null;
    if (!auth.nonce || !auth.message || !auth.signature) return null;
    if (cachedAt <= 0 || now - cachedAt > SOLANA_OWNER_SESSION_MAX_AGE_MS) return null;
    if (expiresAtMs && expiresAtMs <= now + SOLANA_OWNER_SESSION_SAFETY_WINDOW_MS) return null;
    return { ...auth, walletType: "solana" as const };
  } catch {
    return null;
  }
}

function cacheSolanaOwnerSession(input: {
  auth: DraftActionAuth & { walletType: "solana" };
  walletAddress: string;
  chainId: number;
  draftId: string;
  expiresAt: string | null;
}) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      solanaOwnerSessionCacheKey(input),
      JSON.stringify({ auth: input.auth, cachedAt: Date.now(), expiresAt: input.expiresAt }),
    );
  } catch {
    // Ignore storage failures; user can re-sign.
  }
}

export function clearSolanaDraftOwnerSession(input: {
  walletAddress: string;
  chainId: number;
  draftId: string;
}) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(solanaOwnerSessionCacheKey(input));
  } catch {
    // ignore
  }
  SOLANA_OWNER_SESSION_IN_FLIGHT.delete(solanaOwnerSessionCacheKey(input));
}

async function createSignedSolanaDraftAction(input: {
  provider: SolanaProvider;
  detectedWallet: DetectedSolanaWallet | null;
  walletAddress: string;
  chainId: number;
  action: DraftAuthAction;
  draftId: string | null;
}): Promise<DraftActionAuth & { walletType: "solana" }> {
  const { provider, detectedWallet, walletAddress, chainId, draftId } = input;

  await ensureSolanaProviderSession({
    provider,
    detectedWallet,
    expectedWalletAddress: walletAddress,
  });

  const nonce = await fetchNonce(chainId, walletAddress);
  const lines = [
    "MemeWarzone Prepare Mode",
    `Action: ${input.action}`,
    `Wallet: ${walletAddress}`,
    `Chain ID: ${chainId}`,
  ];
  if (draftId) lines.push(`Draft ID: ${draftId}`);
  lines.push(`Nonce: ${nonce}`);

  const message = lines.join("\n");
  const encoded = new TextEncoder().encode(message);
  const signed = await provider.signMessage(encoded);
  const rawSig = signed instanceof Uint8Array ? signed : signed?.signature;
  const signature =
    rawSig instanceof Uint8Array
      ? rawSig
      : rawSig?.buffer
        ? new Uint8Array(rawSig.buffer, rawSig.byteOffset || 0, rawSig.byteLength || rawSig.length)
        : null;
  if (!signature?.length) throw new Error("Solana wallet did not return a signature.");

  notifySolanaWalletChanged(walletAddress, detectedWallet);

  const auth: DraftActionAuth & { walletType: "solana" } = {
    walletType: "solana",
    action: input.action,
    walletAddress,
    chainId,
    draftId,
    nonce,
    message,
    signature: bytesToBase64(signature),
  };

  if (input.action === SOLANA_OWNER_SESSION_ACTION && draftId) {
    cacheSolanaOwnerSession({
      auth,
      walletAddress,
      chainId,
      draftId,
      expiresAt: null,
    });
  }

  return auth;
}

export async function signSolanaDraftAction(input: {
  walletAddress: string;
  chainId: number;
  action: DraftAuthAction;
  draftId?: string | null;
  forceNewOwnerSession?: boolean;
}): Promise<DraftActionAuth & { walletType: "solana" }> {
  const { provider, wallet: detectedWallet } = resolveSolanaProviderForAddress(input.walletAddress);

  if (!provider?.signMessage) {
    throw new Error("This Solana wallet does not support message signing.");
  }

  let walletAddress = normalizePublicKey(input.walletAddress || provider.publicKey?.toString?.() || getStoredSolanaWallet());
  if (!walletAddress && provider.connect) {
    const result = await provider.connect({ onlyIfTrusted: false } as any);
    walletAddress = normalizePublicKey(result?.publicKey?.toString?.() || provider.publicKey?.toString?.() || "");
  }
  if (!walletAddress) throw new Error("Solana wallet not connected.");

  const providerKey = normalizePublicKey(provider.publicKey?.toString?.() || "");
  if (providerKey && providerKey !== walletAddress) {
    throw new Error(
      `Connected wallet (${detectedWallet?.name || "extension"}) is ${providerKey.slice(0, 4)}…${providerKey.slice(-4)}, ` +
      `but this action expects ${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}. Reconnect the correct wallet.`,
    );
  }

  const chainId = Number(input.chainId);
  const draftId = input.draftId || null;
  const useOwnerSession = Boolean(draftId && SOLANA_OWNER_SESSION_ACTIONS.has(input.action));

  if (!useOwnerSession || !draftId) {
    return createSignedSolanaDraftAction({
      provider,
      detectedWallet,
      walletAddress,
      chainId,
      action: input.action,
      draftId,
    });
  }

  const cacheInput = { walletAddress, chainId, draftId };
  if (input.forceNewOwnerSession) {
    clearSolanaDraftOwnerSession(cacheInput);
  } else {
    const cached = readSolanaOwnerSession(cacheInput);
    if (cached) return cached;
  }

  const inFlightKey = solanaOwnerSessionCacheKey(cacheInput);
  const existing = SOLANA_OWNER_SESSION_IN_FLIGHT.get(inFlightKey);
  if (existing) return existing;

  const signing = createSignedSolanaDraftAction({
    provider,
    detectedWallet,
    walletAddress,
    chainId,
    action: SOLANA_OWNER_SESSION_ACTION,
    draftId,
  }).finally(() => {
    SOLANA_OWNER_SESSION_IN_FLIGHT.delete(inFlightKey);
  });

  SOLANA_OWNER_SESSION_IN_FLIGHT.set(inFlightKey, signing);
  return signing;
}

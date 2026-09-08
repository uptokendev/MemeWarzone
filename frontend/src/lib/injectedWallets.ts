export type Eip1193Provider = {
  request: (args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }) => Promise<unknown>;

  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void
  ) => void;

  providers?: Eip1193Provider[];
  selectedProvider?: Eip1193Provider;
  isMetaMask?: boolean;
  isCryptoCom?: boolean;
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isBinance?: boolean;
  isBinanceChain?: boolean;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  [key: string]: unknown;
};

export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

export type DetectedEvmWallet = {
  /** Stable application identity. EIP-6963 UUID wins, then rdns/name fallback. */
  id: string;
  uuid?: string;
  name: string;
  icon?: string;
  rdns?: string;
  provider: Eip1193Provider;
  source: "eip6963" | "legacy";
};

export type EvmWalletCapabilities = {
  accounts: true;
  signMessage: true;
  sendTransaction: true;
  switchChain: true;
  providerEvents: boolean;
};

export type EvmAddChainParams = {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
};

type WindowLike = EventTarget & {
  ethereum?: Eip1193Provider;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

type DiscoveryOptions = {
  timeoutMs?: number;
  windowObject?: WindowLike;
};

const wait = (ms: number, windowObject?: WindowLike) =>
  new Promise<void>((resolve) => {
    const setTimer = windowObject?.setTimeout?.bind(windowObject) ?? globalThis.setTimeout;
    setTimer(resolve, ms);
  });

function currentWindow(windowObject?: WindowLike): WindowLike | undefined {
  if (windowObject) return windowObject;
  if (typeof window === "undefined") return undefined;
  return window as unknown as WindowLike;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerMetadata(provider: Eip1193Provider) {
  const providerInfo = provider.providerInfo;
  const legacyInfo = provider.info;
  const metadata = provider.metadata;
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const pInfo = asRecord(providerInfo);
  const lInfo = asRecord(legacyInfo);
  const meta = asRecord(metadata);

  return {
    name:
      safeText(pInfo.name) ||
      safeText(lInfo.name) ||
      safeText(meta.name) ||
      safeText(provider.name) ||
      safeText(provider._walletName),
    rdns:
      safeText(pInfo.rdns) ||
      safeText(lInfo.rdns) ||
      safeText(meta.rdns) ||
      safeText(provider.rdns) ||
      safeText(provider._rdns),
    icon: safeText(pInfo.icon) || safeText(lInfo.icon) || safeText(meta.icon),
  };
}

function normalizeIdentityPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(com|io|app|org)\./, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "number") return record.code;
  const data = record.data;
  if (!data || typeof data !== "object") return undefined;
  const originalError = (data as Record<string, unknown>).originalError;
  if (!originalError || typeof originalError !== "object") return undefined;
  const code = (originalError as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}

export function createDetectedEvmWallet(
  provider: Eip1193Provider,
  source: "eip6963" | "legacy",
  info?: Partial<Eip6963ProviderInfo>
): DetectedEvmWallet {
  const metadata = providerMetadata(provider);
  const uuid = safeText(info?.uuid);
  const name = safeText(info?.name) || metadata.name || "Injected EVM Wallet";
  const rdns = safeText(info?.rdns) || metadata.rdns;
  const icon = safeText(info?.icon) || metadata.icon;
  const fallbackId = normalizeIdentityPart(rdns || name) || "injected";

  return {
    id: uuid || fallbackId,
    ...(uuid ? { uuid } : {}),
    name,
    ...(icon ? { icon } : {}),
    ...(rdns ? { rdns } : {}),
    provider,
    source,
  };
}

function getLegacyInjectedProviders(windowObject?: WindowLike): Eip1193Provider[] {
  const targetWindow = currentWindow(windowObject);
  const ethereum = targetWindow?.ethereum;
  if (!ethereum) return [];

  const candidates = Array.isArray(ethereum.providers)
    ? [...ethereum.providers, ethereum]
    : [ethereum.selectedProvider, ethereum];
  const seen = new Set<Eip1193Provider>();

  return candidates.filter((provider): provider is Eip1193Provider => {
    if (!provider || typeof provider.request !== "function" || seen.has(provider)) {
      return false;
    }
    seen.add(provider);
    return true;
  });
}

/**
 * Discover all standards-compatible injected EVM wallets without a brand
 * allowlist. EIP-6963 identities are preferred; legacy `window.ethereum`
 * providers are normalized into the same shape as a compatibility fallback.
 *
 * The helper deliberately listens passively for EIP-6963 announcements. The
 * application-wide wallet hook owns the guarded requestProvider dispatch so
 * extensions that synchronously recurse on request events cannot trap callers.
 */
export async function discoverInjectedWallets(
  options: number | DiscoveryOptions = 500
): Promise<DetectedEvmWallet[]> {
  const normalizedOptions: DiscoveryOptions =
    typeof options === "number" ? { timeoutMs: options } : options;
  const targetWindow = currentWindow(normalizedOptions.windowObject);
  if (!targetWindow) return [];

  const timeoutMs = normalizedOptions.timeoutMs ?? 500;
  const announced = new Map<string, DetectedEvmWallet>();

  const onAnnounceProvider = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.provider || typeof detail.provider.request !== "function") return;

    const wallet = createDetectedEvmWallet(detail.provider, "eip6963", detail.info);
    announced.set(wallet.uuid || wallet.rdns || wallet.id, wallet);
  };

  targetWindow.addEventListener(
    "eip6963:announceProvider",
    onAnnounceProvider as EventListener
  );

  await wait(timeoutMs, targetWindow);

  targetWindow.removeEventListener(
    "eip6963:announceProvider",
    onAnnounceProvider as EventListener
  );

  const eip6963Wallets = Array.from(announced.values());
  const legacyWallets = getLegacyInjectedProviders(targetWindow).map((provider) =>
    createDetectedEvmWallet(provider, "legacy")
  );
  const seenProviders = new Set<Eip1193Provider>();
  const seenIdentity = new Set<string>();

  return [...eip6963Wallets, ...legacyWallets].filter((wallet) => {
    const identity = (wallet.uuid || wallet.rdns || wallet.id).toLowerCase();
    if (seenProviders.has(wallet.provider) || seenIdentity.has(identity)) return false;
    seenProviders.add(wallet.provider);
    seenIdentity.add(identity);
    return true;
  });
}

/**
 * Resolve a provider by generic wallet identity. The selector may be the
 * EIP-6963 UUID, rdns, normalized id, or display name; no wallet brand is
 * required in application code.
 */
export async function getInjectedProvider(
  walletIdentity: string,
  options?: DiscoveryOptions
): Promise<Eip1193Provider> {
  const selector = walletIdentity.trim().toLowerCase();
  if (!selector) throw new Error("Injected wallet identity is required.");

  const wallets = await discoverInjectedWallets(options ?? 500);
  const wallet = wallets.find((candidate) => {
    const identities = [
      candidate.id,
      candidate.uuid || "",
      candidate.rdns || "",
      candidate.name,
      normalizeIdentityPart(candidate.rdns || candidate.name),
    ];
    return identities.some((value) => value.toLowerCase() === selector);
  });

  if (!wallet) {
    throw new Error(`Injected EVM wallet not found: ${walletIdentity}`);
  }

  return wallet.provider;
}

export function getEvmWalletCapabilities(
  provider: Eip1193Provider
): EvmWalletCapabilities {
  return {
    accounts: true,
    signMessage: true,
    sendTransaction: true,
    switchChain: true,
    providerEvents:
      typeof provider.on === "function" && typeof provider.removeListener === "function",
  };
}

export async function requestEvmAccounts(
  provider: Eip1193Provider
): Promise<string[]> {
  const result = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(result)) return [];
  return result.filter((value): value is string => typeof value === "string");
}

export async function signEvmMessage(
  provider: Eip1193Provider,
  account: string,
  messageHex: string
): Promise<string> {
  const signature = await provider.request({
    method: "personal_sign",
    params: [messageHex, account],
  });
  if (typeof signature !== "string" || !signature) {
    throw new Error("Wallet did not return a message signature.");
  }
  return signature;
}

export async function sendEvmTransaction(
  provider: Eip1193Provider,
  transaction: Record<string, unknown>
): Promise<string> {
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [transaction],
  });
  if (typeof hash !== "string" || !hash) {
    throw new Error("Wallet did not return a transaction hash.");
  }
  return hash;
}

export async function switchEvmWalletChain(
  provider: Eip1193Provider,
  chainId: number,
  addChainParams?: EvmAddChainParams
): Promise<void> {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid EVM chain id: ${chainId}`);
  }

  const hexChainId = `0x${chainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
    return;
  } catch (error) {
    if (errorCode(error) !== 4902 || !addChainParams) throw error;
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [addChainParams],
  });
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hexChainId }],
  });
}

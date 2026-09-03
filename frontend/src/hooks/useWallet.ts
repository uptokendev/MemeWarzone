import { BrowserProvider, JsonRpcSigner } from "ethers";
import { useCallback, useEffect, useRef, useState } from "react";

import { syncWalletRecruiterAttribution } from "@/lib/recruiterApi";
import { getActiveChainId, getAllowedChainIds, isAllowedChainId, isEvmChainId } from "@/lib/chainConfig";
import { watchInjectedProviderAvailability } from "@/lib/injectedProviderDiscovery";

export type WalletType =
  | "metamask"
  | "rabby"
  | "coinbase"
  | "binance"
  | "trust"
  | "cryptocom"
  | "okx"
  | "phantom"
  | "rainbow"
  | "brave"
  | "frame"
  | "injected"
  | (string & {});

type Eip1193RequestArgs = {
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

export type Eip1193Provider = {
  request<T = unknown>(args: Eip1193RequestArgs): Promise<T>;
  on?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => void;
  selectedAddress?: string | null;
  providers?: Eip1193Provider[];
  selectedProvider?: Eip1193Provider;
  providerMap?: Map<unknown, Eip1193Provider>;
  detected?: Eip1193Provider[];
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
  isBinance?: boolean;
  isBinanceChain?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isCryptoCom?: boolean;
  isCryptoComWallet?: boolean;
  isDeFiWallet?: boolean;
  isDeficonnectProvider?: boolean;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  isPhantom?: boolean;
  isBraveWallet?: boolean;
  [key: string]: unknown;
};

type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

export type DetectedWallet = {
  id: WalletType;
  name: string;
  description: string;
  rdns: string;
  icon?: string;
  provider: Eip1193Provider;
  source: "eip6963" | "legacy";
  installed: true;
  sortScore: number;
};

export type WalletHook = {
  provider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
  account: string;
  chainId?: number;
  connecting: boolean;
  connectingWalletId: WalletType | null;
  detectedWallets: DetectedWallet[];
  hasInjectedWallets: boolean;
  connect: (wallet?: WalletType) => Promise<void>;
  disconnect: () => Promise<void>;
  detectWallets: () => DetectedWallet[];
  isConnected: boolean;
  isOnSupportedChain: boolean;
};

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
    "eip6963:requestProvider": Event;
    "memewarzone:openWalletModal": CustomEvent<void>;
  }

  interface Window {
    ethereum?: Eip1193Provider;
    BinanceChain?: Eip1193Provider;
    binanceChain?: Eip1193Provider;
  }
}

const SELECTED_WALLET_KEY = "mwz:selected_wallet";
const DISCONNECTED_KEY = "mwz:wallet:disconnected";
const LEGACY_CONNECTED_KEY = "mwz_wallet_connected";

const EIP6963_WALLETS = new Map<string, Eip6963ProviderDetail>();
const EIP6963_SUBSCRIBERS = new Set<() => void>();
let eip6963ListenerStarted = false;
let eip6963RequestInFlight = false;

function normalizeHexAddress(value?: string | null): string {
  const v = String(value ?? "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(v) ? v.toLowerCase() : "";
}

function normalizeAccounts(accounts: unknown): string[] {
  if (!Array.isArray(accounts)) return [];
  return accounts.map((account) => normalizeHexAddress(String(account))).filter(Boolean);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getMeta(provider: Eip1193Provider, info?: Partial<Eip6963ProviderInfo>) {
  const pInfo = isObject(provider.providerInfo) ? provider.providerInfo : {};
  const legacyInfo = isObject(provider.info) ? provider.info : {};
  const metadata = isObject(provider.metadata) ? provider.metadata : {};
  const name = info?.name || getString(pInfo.name) || getString(legacyInfo.name) || getString(metadata.name) || getString(provider.name) || getString(provider._walletName);
  const rdns = info?.rdns || getString(pInfo.rdns) || getString(legacyInfo.rdns) || getString(metadata.rdns) || getString(provider.rdns) || getString(provider._rdns);
  const icon = info?.icon || getString(pInfo.icon) || getString(legacyInfo.icon) || getString(metadata.icon);
  return { name, rdns, icon, nameLower: name.toLowerCase(), rdnsLower: rdns.toLowerCase() };
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function walletBrand(provider: Eip1193Provider, info?: Partial<Eip6963ProviderInfo>) {
  const meta = getMeta(provider, info);
  const name = meta.nameLower;
  const rdns = meta.rdnsLower;
  const flag = (key: string) => Boolean(provider[key]);

  if (flag("isRabby") || hasAny(name, ["rabby"]) || hasAny(rdns, ["rabby"])) return { id: "rabby" as WalletType, name: meta.name || "Rabby", description: "Risk-aware EVM wallet.", score: 98 };
  if (flag("isBinance") || flag("isBinanceChain") || hasAny(name, ["binance"]) || hasAny(rdns, ["binance"])) return { id: "binance" as WalletType, name: meta.name || "Binance Wallet", description: "BNB Chain-native EVM wallet.", score: 96 };
  if (flag("isCoinbaseWallet") || hasAny(name, ["coinbase"]) || hasAny(rdns, ["coinbase"])) return { id: "coinbase" as WalletType, name: meta.name || "Coinbase Wallet", description: "Coinbase self-custody wallet.", score: 94 };
  if (flag("isTrust") || flag("isTrustWallet") || hasAny(name, ["trust"]) || hasAny(rdns, ["trust"])) return { id: "trust" as WalletType, name: meta.name || "Trust Wallet", description: "Mobile-first EVM wallet.", score: 92 };
  if (
    flag("isCryptoCom") ||
    flag("isCryptoComWallet") ||
    flag("isDeFiWallet") ||
    flag("isDeficonnectProvider") ||
    hasAny(name, ["crypto.com", "crypto com", "defi wallet", "deficonnect"]) ||
    hasAny(rdns, ["crypto.com", "cryptocom", "com.crypto"])
  ) return { id: "cryptocom" as WalletType, name: meta.name || "Crypto.com DeFi Wallet", description: "Crypto.com self-custody EVM wallet.", score: 93 };
  if (flag("isOkxWallet") || flag("isOKExWallet") || hasAny(name, ["okx", "okex"]) || hasAny(rdns, ["okx", "okex"])) return { id: "okx" as WalletType, name: meta.name || "OKX Wallet", description: "Multi-chain EVM wallet.", score: 88 };
  if (flag("isPhantom") || hasAny(name, ["phantom"]) || hasAny(rdns, ["phantom"])) return { id: "phantom" as WalletType, name: meta.name || "Phantom", description: "Multi-chain wallet. Use the Solana row for Solana; EVM sessions follow the selected MemeWarzone EVM chain.", score: 70 };
  if (flag("isBraveWallet") || hasAny(name, ["brave"]) || hasAny(rdns, ["brave"])) return { id: "brave" as WalletType, name: meta.name || "Brave Wallet", description: "Built-in Brave wallet.", score: 82 };
  if (flag("isMetaMask") || flag("_metamask") || hasAny(name, ["metamask"]) || hasAny(rdns, ["metamask"])) return { id: "metamask" as WalletType, name: meta.name || "MetaMask", description: "Injected EVM browser wallet.", score: 90 };

  const raw = meta.rdns || meta.name || "injected";
  const id = raw.toLowerCase().replace(/^com\./, "").replace(/^io\./, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "injected";
  return { id: id as WalletType, name: meta.name || "Injected EVM Wallet", description: "Detected EVM-compatible wallet.", score: 50 };
}

function dedupeProviders(candidates: Array<Eip1193Provider | null | undefined>) {
  const seen = new Set<Eip1193Provider>();
  return candidates.filter((candidate): candidate is Eip1193Provider => {
    if (!candidate || typeof candidate.request !== "function" || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function legacyProviders() {
  if (typeof window === "undefined") return [];
  const ethereum = window.ethereum;
  const providerMap = ethereum?.providerMap;
  const mappedProviders = providerMap && typeof providerMap.values === "function"
    ? Array.from(providerMap.values())
    : [];
  const candidates = dedupeProviders([
    ...(Array.isArray(ethereum?.providers) ? ethereum.providers : []),
    ethereum?.selectedProvider,
    ...mappedProviders,
    ...(Array.isArray(ethereum?.detected) ? ethereum.detected : []),
    ethereum,
    window.BinanceChain,
    window.binanceChain,
  ]);
  return candidates.filter((p) => !(p as any)?.isPhantom);
}

function startEip6963Discovery() {
  if (typeof window === "undefined" || eip6963ListenerStarted) return;
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event.detail;
    if (!detail?.provider || typeof detail.provider.request !== "function") return;
    const meta = getMeta(detail.provider, detail.info);
    const key = detail.info?.uuid || meta.rdns || meta.name || String(EIP6963_WALLETS.size + 1);
    EIP6963_WALLETS.set(key, detail);
    EIP6963_SUBSCRIBERS.forEach((subscriber) => subscriber());
  });
  eip6963ListenerStarted = true;
}

function requestEip6963Providers() {
  if (typeof window === "undefined") return;
  startEip6963Discovery();
  if (eip6963RequestInFlight) return;
  eip6963RequestInFlight = true;

  queueMicrotask(() => {
    try {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch {
      // Legacy detection still works.
    } finally {
      eip6963RequestInFlight = false;
    }
  });
}

function detectedWallet(provider: Eip1193Provider, source: "eip6963" | "legacy", info?: Partial<Eip6963ProviderInfo>): DetectedWallet {
  const meta = getMeta(provider, info);
  const brand = walletBrand(provider, info);
  return { id: brand.id, name: brand.name, description: brand.description, rdns: meta.rdns, icon: meta.icon, provider, source, installed: true, sortScore: brand.score + (source === "eip6963" ? 8 : 0) };
}

function knownWalletId(id: WalletType) {
  return ["metamask", "rabby", "coinbase", "binance", "trust", "cryptocom", "okx", "phantom", "rainbow", "brave", "frame"].includes(String(id));
}

function detectedSnapshot(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const wallets = [
    ...[...EIP6963_WALLETS.values()].map((detail) => detectedWallet(detail.provider, "eip6963", detail.info)),
    ...legacyProviders().map((provider) => detectedWallet(provider, "legacy")),
  ];

  const seenProviders = new Set<Eip1193Provider>();
  const seenKeys = new Set<string>();
  const seenBrands = new Set<string>();

  return wallets
    .sort((a, b) => b.sortScore - a.sortScore || Number(Boolean(b.icon)) - Number(Boolean(a.icon)) || a.name.localeCompare(b.name))
    .filter((wallet) => {
      if ((wallet.provider as any)?.isPhantom) return false;
      if (String(wallet.id || "").toLowerCase().includes("phantom")) return false;
      if (String(wallet.rdns || wallet.name || "").toLowerCase().includes("phantom")) return false;
      if (seenProviders.has(wallet.provider)) return false;

      const rawKey = String(wallet.rdns || wallet.name || wallet.id).toLowerCase();
      const brandKey = knownWalletId(wallet.id)
        ? String(wallet.id).toLowerCase()
        : rawKey.replace(/^(com|io)\./, "").replace(/[^a-z0-9]+/g, "-");

      if (seenKeys.has(rawKey) || seenBrands.has(brandKey)) return false;
      seenProviders.add(wallet.provider);
      seenKeys.add(rawKey);
      seenBrands.add(brandKey);
      return true;
    });
}

function walletSnapshotKey(wallet: DetectedWallet) {
  return [wallet.id, wallet.name, wallet.rdns, wallet.icon || "", wallet.source, String(wallet.sortScore)].join("|");
}

function sameWalletSnapshot(previous: DetectedWallet[], next: DetectedWallet[]) {
  if (previous.length !== next.length) return false;
  return previous.every((wallet, index) => wallet.provider === next[index]?.provider && walletSnapshotKey(wallet) === walletSnapshotKey(next[index]));
}

function findWallet(walletId: WalletType | null | undefined) {
  const wallets = detectedSnapshot();
  if (!walletId) return null;
  return wallets.find((wallet) => wallet.id === walletId) || wallets.find((wallet) => wallet.id.startsWith(`${walletId}-`)) || wallets.find((wallet) => walletBrand(wallet.provider).id === walletId) || null;
}

function parseChainId(value: unknown): number | undefined {
  try {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") return Number(BigInt(value));
  } catch {
    return undefined;
  }
  return undefined;
}

async function chooseAccount(provider: Eip1193Provider, accounts: string[]) {
  const normalized = accounts.map(normalizeHexAddress).filter(Boolean);
  if (normalized[0]) return normalized[0];
  try {
    const active = normalizeAccounts(await provider.request({ method: "eth_accounts" }));
    if (active[0]) return active[0];
  } catch {
    // ignore
  }
  const selectedAddress = normalizeHexAddress(provider.selectedAddress);
  return selectedAddress || "";
}

function clearWarRoomSessionCache() {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith("mwz:warroom:") || key?.startsWith("mwz:chat:") || key?.startsWith("mwz:tokenchat:")) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // ignore
  }
}

function clearPersistedWalletSelection() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SELECTED_WALLET_KEY);
    window.localStorage.removeItem(LEGACY_CONNECTED_KEY);
    window.localStorage.setItem(DISCONNECTED_KEY, "1");
  } catch {
    // ignore
  }
}

function dispatchOpenWalletModal() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
}

function getErrorMessage(error: unknown) {
  if (isObject(error) && typeof error.message === "string") return error.message;
  return String(error || "Wallet connection failed.");
}

function isRejected(error: unknown) {
  if (!isObject(error)) return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return error.code === 4001 || message.includes("user rejected") || message.includes("user denied");
}

async function ensureSupportedEvmChain(provider: Eip1193Provider): Promise<number> {
  let cid: number | undefined;
  try {
    const bp = new BrowserProvider(provider);
    const net = await bp.getNetwork();
    cid = Number(net.chainId);
  } catch {
    try {
      const raw = await provider.request({ method: "eth_chainId" });
      cid = parseInt(String(raw), 16);
    } catch {}
  }

  if (isEvmChainId(cid) && isAllowedChainId(cid)) return cid as number;

  const selected = Number(getActiveChainId());
  const allowedEvmChains = getAllowedChainIds().filter((chainId) => isEvmChainId(chainId));
  const target = isEvmChainId(selected) && isAllowedChainId(selected)
    ? selected
    : Number(allowedEvmChains[0] || 56);
  const targetHex = "0x" + target.toString(16);

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: targetHex }] });
    const bp2 = new BrowserProvider(provider);
    const net2 = await bp2.getNetwork();
    const cid2 = Number(net2.chainId);
    if (isEvmChainId(cid2) && isAllowedChainId(cid2)) return cid2;
    throw new Error("Switch did not land on an allowed MemeWarzone EVM chain.");
  } catch {
    const allowedLabel = allowedEvmChains.length ? allowedEvmChains.join(", ") : "none configured";
    throw new Error(
      `Your wallet is not on an enabled MemeWarzone EVM chain. ` +
        `Enabled EVM chain IDs: ${allowedLabel}. ` +
        `Switch to the chain selected in MemeWarzone and try again. ` +
        `For Solana use the dedicated Solana wallet row.`
    );
  }
}

export function useWallet(): WalletHook {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [connectingWalletId, setConnectingWalletId] = useState<WalletType | null>(null);
  const [detectedWallets, setDetectedWallets] = useState<DetectedWallet[]>([]);

  const eip1193Ref = useRef<Eip1193Provider | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const accountRef = useRef<string>("");
  const connectedEvmRef = useRef<{ provider: Eip1193Provider | null; account: string }>({ provider: null, account: "" });

  const setDetectedWalletSnapshot = useCallback((next = detectedSnapshot()) => {
    setDetectedWallets((previous) => (sameWalletSnapshot(previous, next) ? previous : next));
    return next;
  }, []);

  const syncRecruiterAttribution = useCallback(async (walletAddress: string) => {
    if (!walletAddress) return;
    try {
      await syncWalletRecruiterAttribution(walletAddress);
    } catch {
      // best effort
    }
  }, []);

  const detectWallets = useCallback(() => {
    requestEip6963Providers();
    const wallets = detectedSnapshot();
    setDetectedWalletSnapshot(wallets);
    return wallets;
  }, [setDetectedWalletSnapshot]);

  const resetWalletState = useCallback((clearSelectedWallet = false) => {
    eip1193Ref.current = null;
    accountRef.current = "";
    connectedEvmRef.current = { provider: null, account: "" };
    setAccount("");
    setSigner(null);
    setProvider(null);
    setChainId(undefined);
    clearWarRoomSessionCache();
    if (clearSelectedWallet) clearPersistedWalletSelection();
  }, []);

  const applyProviderState = useCallback(async (selectedProvider: Eip1193Provider, chosen: string, selectedWalletId?: WalletType) => {
    eip1193Ref.current = selectedProvider;
    accountRef.current = chosen;
    const browserProvider = new BrowserProvider(selectedProvider);
    setProvider(browserProvider);
    setAccount(chosen);
    void syncRecruiterAttribution(chosen);
    const nextSigner = await browserProvider.getSigner(chosen);
    setSigner(nextSigner);
    const network = await browserProvider.getNetwork();
    const cid = Number(network.chainId);
    if (!isEvmChainId(cid) || !isAllowedChainId(cid)) throw new Error("Unsupported EVM chain in provider state.");
    setChainId(cid);
    if (typeof window !== "undefined" && selectedWalletId) {
      window.localStorage.setItem(SELECTED_WALLET_KEY, selectedWalletId);
      window.localStorage.removeItem(DISCONNECTED_KEY);
      window.localStorage.removeItem(LEGACY_CONNECTED_KEY);
    }
    connectedEvmRef.current = { provider: selectedProvider, account: chosen };
  }, [syncRecruiterAttribution]);

  const bindListeners = useCallback((selectedProvider: Eip1193Provider) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!selectedProvider.on) return;

    const rebuild = async () => {
      if (eip1193Ref.current !== selectedProvider || !accountRef.current) return;
      try {
        const chosen = await chooseAccount(selectedProvider, normalizeAccounts(await selectedProvider.request({ method: "eth_accounts" })));
        if (!chosen) {
          resetWalletState(false);
          return;
        }
        if (chosen.toLowerCase() === accountRef.current.toLowerCase()) return;
        await ensureSupportedEvmChain(selectedProvider);
        await applyProviderState(selectedProvider, chosen);
      } catch {
        setSigner(null);
      }
    };

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void rebuild();
    };

    const onAccountsChanged = async (accounts: unknown) => {
      if (eip1193Ref.current !== selectedProvider || !accountRef.current) return;
      const fromEvent = normalizeAccounts(accounts);
      const chosen = fromEvent[0] || (await chooseAccount(selectedProvider, fromEvent));
      setAccount((previous) => {
        if (previous && chosen && previous.toLowerCase() !== chosen.toLowerCase()) clearWarRoomSessionCache();
        return chosen;
      });
      accountRef.current = chosen || "";
      if (!chosen) {
        setSigner(null);
        return;
      }
      try {
        await ensureSupportedEvmChain(selectedProvider);
        await applyProviderState(selectedProvider, chosen);
      } catch {
        setSigner(null);
        resetWalletState(false);
      }
    };

    const onChainChanged = async (nextChainId: unknown) => {
      if (eip1193Ref.current !== selectedProvider || !accountRef.current) return;
      const c = parseChainId(nextChainId);
      if (c && (!isEvmChainId(c) || !isAllowedChainId(c))) {
        resetWalletState(false);
        return;
      }
      setChainId(c);
      await rebuild();
    };

    selectedProvider.on("accountsChanged", onAccountsChanged);
    selectedProvider.on("chainChanged", onChainChanged);
    selectedProvider.on("disconnect", rebuild);
    window.addEventListener("focus", rebuild);
    document.addEventListener("visibilitychange", onVisibilityChange);

    cleanupRef.current = () => {
      selectedProvider.removeListener?.("accountsChanged", onAccountsChanged);
      selectedProvider.removeListener?.("chainChanged", onChainChanged);
      selectedProvider.removeListener?.("disconnect", rebuild);
      window.removeEventListener("focus", rebuild);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applyProviderState, resetWalletState]);

  useEffect(() => {
    startEip6963Discovery();
    const onDiscovery = () => setDetectedWalletSnapshot();
    EIP6963_SUBSCRIBERS.add(onDiscovery);

    const stopWatching = watchInjectedProviderAvailability(() => {
      requestEip6963Providers();
      setDetectedWalletSnapshot();
    });

    return () => {
      EIP6963_SUBSCRIBERS.delete(onDiscovery);
      stopWatching();
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [setDetectedWalletSnapshot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    const restore = async () => {
      try {
        if (window.localStorage.getItem(DISCONNECTED_KEY) === "1") return;
        const selectedId = String(window.localStorage.getItem(SELECTED_WALLET_KEY) || "").trim();
        if (!selectedId || accountRef.current) return;
        requestEip6963Providers();
        setDetectedWalletSnapshot();
        const selectedWallet = findWallet(selectedId as WalletType);
        if (!selectedWallet?.provider) return;
        const accounts = normalizeAccounts(
          await selectedWallet.provider.request({ method: "eth_accounts" }),
        );
        const chosen = await chooseAccount(selectedWallet.provider, accounts);
        if (!chosen || cancelled || accountRef.current) return;
        const browserProvider = new BrowserProvider(selectedWallet.provider);
        const network = await browserProvider.getNetwork();
        const cid = Number(network.chainId);
        if (!isEvmChainId(cid) || !isAllowedChainId(cid)) return;
        bindListeners(selectedWallet.provider);
        await applyProviderState(selectedWallet.provider, chosen, selectedWallet.id);
        if (!cancelled) setChainId(cid);
      } catch {
        // Silent restore only — never prompt on refresh.
      }
    };

    const timers = [80, 250, 800, 1600].map((delay) => window.setTimeout(() => { void restore(); }, delay));
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [applyProviderState, bindListeners, setDetectedWalletSnapshot]);

  const connect = useCallback(async (wallet?: WalletType) => {
    if (typeof window === "undefined") throw new Error("No browser environment detected.");
    if (!wallet) {
      dispatchOpenWalletModal();
      return;
    }

    setConnecting(true);
    setConnectingWalletId(wallet);
    const { analytics, analyticsErrorCode } = await import("@/lib/analytics/ProductAnalytics");
    analytics.track("wallet_connect_started", { wallet_type: wallet, chain: "evm" });

    try {
      requestEip6963Providers();
      let selectedWallet = findWallet(wallet);
      if (!selectedWallet) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        selectedWallet = findWallet(wallet);
      }
      if (!selectedWallet?.provider) throw new Error("Selected wallet was not found. Unlock it and refresh detection.");
      if ((selectedWallet.provider as any)?.isPhantom || String(selectedWallet.id || "").toLowerCase().includes("phantom")) {
        throw new Error("Use the Solana wallet row for Phantom/Solana. Select an EVM wallet for BNB or Robinhood Chain.");
      }

      const cid = await ensureSupportedEvmChain(selectedWallet.provider);
      const accounts = normalizeAccounts(await selectedWallet.provider.request({ method: "eth_requestAccounts" }));
      const chosen = await chooseAccount(selectedWallet.provider, accounts);
      if (!chosen) throw new Error("No account returned by wallet.");

      bindListeners(selectedWallet.provider);
      await applyProviderState(selectedWallet.provider, chosen, selectedWallet.id);
      setChainId(cid);
      window.localStorage.removeItem(DISCONNECTED_KEY);
      analytics.track("wallet_connect_succeeded", { wallet_type: wallet, chain: String(cid) });
    } catch (error) {
      analytics.track("wallet_connect_failed", {
        wallet_type: wallet,
        chain: "evm",
        error_code: isRejected(error) ? "rejected" : analyticsErrorCode(error),
      });
      if (!isRejected(error)) throw new Error(getErrorMessage(error));
    } finally {
      setConnecting(false);
      setConnectingWalletId(null);
    }
  }, [applyProviderState, bindListeners]);

  const disconnect = useCallback(async () => {
    resetWalletState(true);
  }, [resetWalletState]);

  return {
    provider,
    signer,
    account,
    chainId,
    connecting,
    connectingWalletId,
    detectedWallets,
    hasInjectedWallets: detectedWallets.length > 0,
    connect,
    disconnect,
    detectWallets,
    isConnected: Boolean(account),
    isOnSupportedChain: Boolean(chainId && isEvmChainId(chainId) && isAllowedChainId(chainId)),
  };
}

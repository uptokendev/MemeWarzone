import { Transaction, VersionedTransaction } from "@solana/web3.js";

export type WalletStandardAccount = {
  address: string;
  publicKey?: Uint8Array;
  chains?: readonly string[];
  features?: readonly string[];
};

type WalletStandardFeatureMap = Record<string, any>;

export type WalletStandardWallet = {
  version?: string;
  name: string;
  icon?: string;
  chains?: readonly string[];
  accounts: readonly WalletStandardAccount[];
  features: WalletStandardFeatureMap;
};

type WalletRegistryApi = {
  register: (...wallets: WalletStandardWallet[]) => () => void;
};

type WalletRegistryState = {
  get: () => readonly WalletStandardWallet[];
  on: (event: "register" | "unregister", listener: (...wallets: WalletStandardWallet[]) => void) => () => void;
};

const registeredWallets = new Set<WalletStandardWallet>();
const registryListeners: Record<"register" | "unregister", Array<(...wallets: WalletStandardWallet[]) => void>> = {
  register: [],
  unregister: [],
};
let registryInitialized = false;

function notifyRegistry(event: "register" | "unregister", wallets: WalletStandardWallet[]) {
  for (const listener of registryListeners[event]) {
    try {
      listener(...wallets);
    } catch (error) {
      console.error(`[Wallet Standard] ${event} listener failed`, error);
    }
  }
}

function registerWallets(...wallets: WalletStandardWallet[]) {
  const added = wallets.filter((wallet) => wallet && !registeredWallets.has(wallet));
  added.forEach((wallet) => registeredWallets.add(wallet));
  if (added.length) notifyRegistry("register", added);

  return () => {
    const removed = added.filter((wallet) => registeredWallets.delete(wallet));
    if (removed.length) notifyRegistry("unregister", removed);
  };
}

function initializeWalletStandardRegistry() {
  if (registryInitialized || typeof window === "undefined") return;
  registryInitialized = true;

  const api: WalletRegistryApi = Object.freeze({ register: registerWallets });

  try {
    window.addEventListener("wallet-standard:register-wallet", ((event: Event) => {
      const callback = (event as CustomEvent<(api: WalletRegistryApi) => void>).detail;
      if (typeof callback === "function") callback(api);
    }) as EventListener);
  } catch (error) {
    console.error("[Wallet Standard] register-wallet listener could not be added", error);
  }

  try {
    class WalletStandardAppReadyEvent extends Event {
      readonly detail = api;
      constructor() {
        super("wallet-standard:app-ready", { bubbles: false, cancelable: false, composed: false });
      }
    }
    window.dispatchEvent(new WalletStandardAppReadyEvent());
  } catch (error) {
    console.error("[Wallet Standard] app-ready event could not be dispatched", error);
  }
}

export function getWalletStandardRegistry(): WalletRegistryState {
  initializeWalletStandardRegistry();
  return {
    get: () => Array.from(registeredWallets),
    on: (event, listener) => {
      registryListeners[event].push(listener);
      return () => {
        registryListeners[event] = registryListeners[event].filter((current) => current !== listener);
      };
    },
  };
}

function isSolanaAccount(account: WalletStandardAccount) {
  return (account.chains || []).some((chain) => String(chain).startsWith("solana:"));
}

function accountSupports(account: WalletStandardAccount, feature: string) {
  const features = account.features || [];
  return features.length === 0 || features.includes(feature);
}

function walletSupportsSolana(wallet: WalletStandardWallet) {
  if ((wallet.chains || []).some((chain) => String(chain).startsWith("solana:"))) return true;
  if (wallet.accounts.some(isSolanaAccount)) return true;
  return Object.keys(wallet.features || {}).some((feature) => feature.startsWith("solana:"));
}

function chooseAccount(wallet: WalletStandardWallet, feature?: string): WalletStandardAccount | null {
  const candidates = wallet.accounts.filter(isSolanaAccount);
  if (!feature) return candidates[0] || null;
  return candidates.find((account) => accountSupports(account, feature)) || candidates[0] || null;
}

function publicKeyLike(address: string) {
  return { toString: () => address };
}

function transactionBytes(transaction: any): Uint8Array {
  if (transaction instanceof VersionedTransaction) return transaction.serialize();
  if (transaction instanceof Transaction) {
    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  }
  if (transaction instanceof Uint8Array) return transaction;
  if (transaction?.serialize) return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  throw new Error("This wallet action requires a serializable Solana transaction.");
}

function restoreTransaction(original: any, bytes: Uint8Array): any {
  if (original instanceof VersionedTransaction) return VersionedTransaction.deserialize(bytes);
  if (original instanceof Transaction) return Transaction.from(bytes);
  return bytes;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bytesToBase58(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

export type WalletStandardProvider = {
  isConnected: boolean;
  publicKey: { toString: () => string } | null;
  connect: (args?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString: () => string } }>;
  disconnect?: () => Promise<void>;
  signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
  signTransaction?: (transaction: unknown) => Promise<any>;
  signAndSendTransaction?: (transaction: unknown) => Promise<{ signature: string }>;
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

function createWalletStandardProvider(wallet: WalletStandardWallet): WalletStandardProvider {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let selectedAccount = chooseAccount(wallet);
  let standardEventsOff: (() => void) | null = null;

  const emit = (eventName: string, ...args: unknown[]) => {
    listeners.get(eventName)?.forEach((listener) => listener(...args));
  };

  const provider: WalletStandardProvider = {
    get isConnected() {
      return Boolean(selectedAccount);
    },
    get publicKey() {
      return selectedAccount?.address ? publicKeyLike(selectedAccount.address) : null;
    },
    async connect(args) {
      const feature = wallet.features?.["standard:connect"];
      if (!feature?.connect) throw new Error(`${wallet.name} does not support Wallet Standard connect.`);
      const result = await feature.connect({ silent: Boolean(args?.onlyIfTrusted) });
      const accounts = Array.isArray(result?.accounts) ? result.accounts : wallet.accounts;
      selectedAccount = accounts.find(isSolanaAccount) || accounts[0] || chooseAccount(wallet);
      if (!selectedAccount?.address) throw new Error(`${wallet.name} did not return a Solana account.`);
      emit("connect", publicKeyLike(selectedAccount.address));
      return { publicKey: publicKeyLike(selectedAccount.address) };
    },
    async disconnect() {
      const feature = wallet.features?.["standard:disconnect"];
      if (feature?.disconnect) await feature.disconnect();
      selectedAccount = null;
      emit("disconnect");
    },
    async signMessage(message) {
      const feature = wallet.features?.["solana:signMessage"];
      if (!feature?.signMessage) throw new Error(`${wallet.name} does not support Solana message signing.`);
      const account = selectedAccount || chooseAccount(wallet, "solana:signMessage");
      if (!account) throw new Error(`${wallet.name} has no connected Solana account.`);
      const [output] = await feature.signMessage({ account, message });
      const signature = output?.signature instanceof Uint8Array ? output.signature : new Uint8Array(output?.signature || []);
      if (!signature.length) throw new Error(`${wallet.name} did not return a message signature.`);
      return { signature };
    },
    async signTransaction(transaction) {
      const feature = wallet.features?.["solana:signTransaction"];
      if (!feature?.signTransaction) throw new Error(`${wallet.name} does not support Solana transaction signing.`);
      const account = selectedAccount || chooseAccount(wallet, "solana:signTransaction");
      if (!account) throw new Error(`${wallet.name} has no connected Solana account.`);
      const [output] = await feature.signTransaction({ account, transaction: transactionBytes(transaction) });
      const signed = output?.signedTransaction instanceof Uint8Array
        ? output.signedTransaction
        : new Uint8Array(output?.signedTransaction || []);
      if (!signed.length) throw new Error(`${wallet.name} did not return a signed transaction.`);
      return restoreTransaction(transaction, signed);
    },
    async signAndSendTransaction(transaction) {
      const feature = wallet.features?.["solana:signAndSendTransaction"];
      if (!feature?.signAndSendTransaction) throw new Error(`${wallet.name} does not support Solana sign-and-send.`);
      const account = selectedAccount || chooseAccount(wallet, "solana:signAndSendTransaction");
      if (!account) throw new Error(`${wallet.name} has no connected Solana account.`);
      const chain = account.chains?.find((value) => String(value).startsWith("solana:")) || "solana:mainnet";
      const [output] = await feature.signAndSendTransaction({ account, transaction: transactionBytes(transaction), chain });
      const signature = typeof output?.signature === "string"
        ? output.signature
        : bytesToBase58(output?.signature instanceof Uint8Array ? output.signature : new Uint8Array(output?.signature || []));
      if (!signature) throw new Error(`${wallet.name} did not return a transaction signature.`);
      return { signature };
    },
    on(eventName, listener) {
      const current = listeners.get(eventName) || new Set();
      current.add(listener);
      listeners.set(eventName, current);
    },
    removeListener(eventName, listener) {
      listeners.get(eventName)?.delete(listener);
    },
  };

  const standardEvents = wallet.features?.["standard:events"];
  if (standardEvents?.on) {
    standardEventsOff = standardEvents.on("change", (properties: { accounts?: readonly WalletStandardAccount[] }) => {
      const previous = selectedAccount?.address || "";
      if (properties?.accounts) {
        selectedAccount = properties.accounts.find(isSolanaAccount) || properties.accounts[0] || null;
      } else {
        selectedAccount = chooseAccount(wallet);
      }
      const next = selectedAccount?.address || "";
      if (next !== previous) emit("accountChanged", next ? publicKeyLike(next) : null);
    });
  }

  void standardEventsOff;
  return provider;
}

const providerCache = new WeakMap<WalletStandardWallet, WalletStandardProvider>();

export type DetectedWalletStandardSolanaWallet = {
  id: string;
  name: string;
  icon: string;
  provider: WalletStandardProvider;
};

function walletId(wallet: WalletStandardWallet) {
  const slug = String(wallet.name || "wallet")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `wallet-standard:${slug || "wallet"}`;
}

export function detectWalletStandardSolanaWallets(): DetectedWalletStandardSolanaWallet[] {
  const wallets = getWalletStandardRegistry().get().filter(walletSupportsSolana);
  const seenIds = new Map<string, number>();
  return wallets.map((wallet) => {
    let provider = providerCache.get(wallet);
    if (!provider) {
      provider = createWalletStandardProvider(wallet);
      providerCache.set(wallet, provider);
    }
    const baseId = walletId(wallet);
    const occurrence = seenIds.get(baseId) || 0;
    seenIds.set(baseId, occurrence + 1);
    return {
      id: occurrence === 0 ? baseId : `${baseId}:${occurrence + 1}`,
      name: String(wallet.name || "Solana Wallet"),
      icon: String(wallet.icon || "SOL"),
      provider,
    };
  });
}

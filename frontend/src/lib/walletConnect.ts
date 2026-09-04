import { getActiveChainId, getAllowedChainIds, isEvmChainId } from "@/lib/chainConfig";

import type { Eip1193Provider } from "@/lib/injectedWallets";

type RequestArgs = Parameters<Eip1193Provider["request"]>[0];
type ProviderListener = (...args: unknown[]) => void;
type WalletConnectRuntimeProvider = Eip1193Provider & {
  connect?: (options?: { chains?: number[]; rpcMap?: Record<number, string> }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  connected?: boolean;
};

type WalletConnectModule = {
  EthereumProvider: {
    init(options: Record<string, unknown>): Promise<WalletConnectRuntimeProvider>;
  };
};

const WALLETCONNECT_UUID = "6ba7b810-9dad-4f1e-8f9d-6f6d7b0c5a11";
const WALLETCONNECT_RDNS = "com.walletconnect";
const WALLETCONNECT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%233B99FC'/%3E%3Cpath d='M16 25c8.8-8.6 23.2-8.6 32 0l1.1 1.1-4.4 4.3-1.1-1.1c-6.4-6.2-16.8-6.2-23.2 0l-1.1 1.1-4.4-4.3L16 25Zm7.8 7.6c4.5-4.4 11.9-4.4 16.4 0l1.1 1.1-4.4 4.3-1.1-1.1c-2.1-2-5.5-2-7.6 0L27.1 38l-4.4-4.3 1.1-1.1Zm7.1 7 1.1-1.1 1.1 1.1-1.1 1.1-1.1-1.1Z' fill='white'/%3E%3C/svg%3E";

let bridgeInstalled = false;
let placeholderProvider: LazyWalletConnectProvider | null = null;

function getProjectId() {
  return String(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "").trim();
}

function getAllowedEvmChains() {
  return getAllowedChainIds().filter((chainId) => isEvmChainId(chainId)).map(Number);
}

function preferredEvmChainId() {
  const allowed = getAllowedEvmChains();
  const active = Number(getActiveChainId());
  if (isEvmChainId(active) && allowed.includes(active)) return active;
  return allowed[0] || 56;
}

function parseHexChainId(value: unknown) {
  try {
    const n = typeof value === "number" ? value : Number(BigInt(String(value)));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function chainIdFromParams(params: RequestArgs["params"]) {
  const first = Array.isArray(params) ? params[0] : undefined;
  if (!first || typeof first !== "object") return 0;
  return parseHexChainId((first as { chainId?: unknown }).chainId);
}

function rpcMapFor(chains: number[]) {
  const env = import.meta.env as Record<string, string | undefined>;
  const fallbacks: Record<number, string> = {
    56: "https://bsc-dataseed.binance.org/",
    97: "https://data-seed-prebsc-1-s1.binance.org:8545/",
    4663: "https://rpc.mainnet.chain.robinhood.com",
    46630: "https://rpc.testnet.chain.robinhood.com",
  };
  return Object.fromEntries(
    chains.map((chainId) => [
      chainId,
      env[`VITE_PUBLIC_RPC_${chainId}`] ||
        env[`VITE_BSC_RPC_${chainId}`] ||
        fallbacks[chainId] || "",
    ]).filter(([, url]) => Boolean(url)),
  ) as Record<number, string>;
}

class LazyWalletConnectProvider implements Eip1193Provider {
  private runtime: WalletConnectRuntimeProvider | null = null;
  private initializing: Promise<WalletConnectRuntimeProvider> | null = null;
  private desiredChainId = preferredEvmChainId();
  private readonly listeners = new Map<string, Set<ProviderListener>>();

  private async ensureRuntime() {
    if (this.runtime) return this.runtime;
    if (this.initializing) return this.initializing;

    const projectId = getProjectId();
    if (!projectId) throw new Error("WalletConnect is not configured for this MemeWarzone environment.");

    this.initializing = (async () => {
      const module = (await import("@walletconnect/ethereum-provider")) as WalletConnectModule;
      const optionalChains = getAllowedEvmChains();
      const runtime = await module.EthereumProvider.init({
        projectId,
        optionalChains,
        showQrModal: true,
        rpcMap: rpcMapFor(optionalChains),
        metadata: {
          name: "MemeWarzone",
          description: "MemeWarzone multichain wallet connection",
          url: typeof window !== "undefined" ? window.location.origin : "https://memewar.zone",
          icons: ["https://memewar.zone/favicon.ico"],
        },
      });

      for (const [event, eventListeners] of this.listeners) {
        for (const listener of eventListeners) runtime.on?.(event, listener);
      }
      this.runtime = runtime;
      return runtime;
    })().finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  private assertAllowedChain(chainId: number) {
    if (!isEvmChainId(chainId) || !getAllowedEvmChains().includes(chainId)) {
      throw new Error(`WalletConnect chain ${chainId || "unknown"} is not enabled in this MemeWarzone environment.`);
    }
  }

  async request(args: RequestArgs): Promise<unknown> {
    if (args.method === "eth_chainId" && !this.runtime) {
      return `0x${this.desiredChainId.toString(16)}`;
    }
    if (args.method === "eth_accounts" && !this.runtime) {
      return [];
    }

    if (args.method === "wallet_switchEthereumChain" || args.method === "wallet_addEthereumChain") {
      const chainId = chainIdFromParams(args.params);
      this.assertAllowedChain(chainId);
      this.desiredChainId = chainId;
      if (!this.runtime) return null;
    }

    const runtime = await this.ensureRuntime();
    if (args.method === "eth_requestAccounts" && !runtime.connected && runtime.connect) {
      await runtime.connect({
        chains: [this.desiredChainId],
        rpcMap: rpcMapFor(getAllowedEvmChains()),
      });
    }
    return runtime.request(args);
  }

  on(event: string, listener: ProviderListener) {
    const set = this.listeners.get(event) || new Set<ProviderListener>();
    set.add(listener);
    this.listeners.set(event, set);
    this.runtime?.on?.(event, listener);
  }

  removeListener(event: string, listener: ProviderListener) {
    this.listeners.get(event)?.delete(listener);
    this.runtime?.removeListener?.(event, listener);
  }
}

function announceWalletConnect() {
  if (typeof window === "undefined" || !getProjectId()) return;
  placeholderProvider ||= new LazyWalletConnectProvider();
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: {
          uuid: WALLETCONNECT_UUID,
          name: "WalletConnect",
          icon: WALLETCONNECT_ICON,
          rdns: WALLETCONNECT_RDNS,
        },
        provider: placeholderProvider,
      },
    }),
  );
}

/**
 * Makes WalletConnect v2 participate in the exact same EIP-6963 discovery and
 * EIP-1193 account/signer pipeline as browser-injected EVM wallets. The heavy
 * WalletConnect runtime stays lazy until the user actually requests accounts.
 */
export function installWalletConnectEip6963Bridge() {
  if (typeof window === "undefined" || bridgeInstalled || !getProjectId()) return false;
  bridgeInstalled = true;
  window.addEventListener("eip6963:requestProvider", announceWalletConnect);
  queueMicrotask(announceWalletConnect);
  return true;
}

export const walletConnectTestContract = {
  getAllowedEvmChains,
  preferredEvmChainId,
  rpcMapFor,
};

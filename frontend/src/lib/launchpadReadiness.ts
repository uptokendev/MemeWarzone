import {
  getAllowedChainIds,
  getChainLabel,
  getChainParams,
  getDefaultChainId,
  getFactoryAddress,
  getPublicRpcUrls,
  isAllowedChainId,
  isSolanaChainId,
  type SupportedChainId,
} from "@/lib/chainConfig";
import { buildEvmWalletChainParams, isKnownEvmChainId } from "@/lib/evmChainAdapter";

export type LaunchpadWriteReadiness = {
  ready: boolean;
  reason: "ready" | "wallet_disconnected" | "wrong_chain" | "missing_factory" | "writes_disabled";
  activeChainId: SupportedChainId;
  walletChainId?: number;
  factoryAddress: string;
  title: string;
  message: string;
  actionLabel?: string;
  targetChainId?: SupportedChainId;
};

function envFlag(name: string, fallback = false): boolean {
  const raw = String((import.meta.env as Record<string, unknown>)[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function launchpadWritesEnabled(): boolean {
  return envFlag("VITE_LAUNCHPAD_WRITES_ENABLED", false);
}

function allowedChainNames(): string {
  return getAllowedChainIds()
    .map((chainId) => getChainLabel(chainId))
    .join(", ");
}

function launchpadWriteTarget(chainId: SupportedChainId): { address: string; kind: "factory" | "program" } {
  if (isSolanaChainId(chainId)) {
    const program = String((import.meta.env.VITE_SOLANA_LAUNCHPAD_PROGRAM_ID as string | undefined) || "").trim();
    return { address: program, kind: "program" };
  }
  return { address: getFactoryAddress(chainId), kind: "factory" };
}

function missingTargetMessage(chainId: SupportedChainId, kind: "factory" | "program"): string {
  const label = getChainLabel(chainId);
  if (kind === "program") {
    return `No Solana launchpad program is configured for ${label}. Set VITE_SOLANA_LAUNCHPAD_PROGRAM_ID before enabling launchpad writes.`;
  }
  return `No LaunchFactory address is configured for ${label}. Deploy contracts and set VITE_FACTORY_ADDRESS_${chainId} before enabling launchpad writes.`;
}

export function getLaunchpadWriteReadiness({
  isConnected,
  walletChainId,
}: {
  isConnected: boolean;
  walletChainId?: number | null;
}): LaunchpadWriteReadiness {
  const defaultChainId = getDefaultChainId();
  const activeChainId = isAllowedChainId(walletChainId) ? (walletChainId as SupportedChainId) : defaultChainId;
  const target = launchpadWriteTarget(activeChainId);
  const factoryAddress = target.address;

  if (!isConnected) {
    return {
      ready: false,
      reason: "wallet_disconnected",
      activeChainId,
      walletChainId: walletChainId || undefined,
      factoryAddress,
      title: "Connect wallet",
      message: "Connect your wallet before creating, buying, or selling campaigns.",
      actionLabel: "Connect wallet",
    };
  }

  if (!isAllowedChainId(walletChainId)) {
    return {
      ready: false,
      reason: "wrong_chain",
      activeChainId,
      walletChainId: walletChainId || undefined,
      factoryAddress,
      title: "Wrong network",
      message: `Switch to a supported MemeWarzone network before using launchpad actions: ${allowedChainNames()}.`,
      actionLabel: `Switch to ${getChainLabel(defaultChainId)}`,
      targetChainId: defaultChainId,
    };
  }

  if (!launchpadWritesEnabled()) {
    return {
      ready: false,
      reason: "writes_disabled",
      activeChainId,
      walletChainId: walletChainId || undefined,
      factoryAddress,
      title: "Prepare Mode not enabled yet",
      message: `Launchpad write actions are disabled for this deploy. After the new contracts are deployed and verified, set VITE_LAUNCHPAD_WRITES_ENABLED=true to enable create, buy, sell, and finalize actions on ${getChainLabel(activeChainId)}.`,
    };
  }

  if (!factoryAddress) {
    return {
      ready: false,
      reason: "missing_factory",
      activeChainId,
      walletChainId: walletChainId || undefined,
      factoryAddress,
      title: "Contracts not deployed for this network",
      message: missingTargetMessage(activeChainId, target.kind),
    };
  }

  return {
    ready: true,
    reason: "ready",
    activeChainId,
    walletChainId: walletChainId || undefined,
    factoryAddress,
    title: "Launchpad ready",
    message: `Connected to ${getChainLabel(activeChainId)}.`,
  };
}

export function getWalletChainSwitchParams(chainId: SupportedChainId) {
  if (isKnownEvmChainId(chainId)) {
    return buildEvmWalletChainParams(chainId, getPublicRpcUrls(chainId));
  }
  return getChainParams(chainId);
}

export async function requestWalletChainSwitch(provider: { send?: (method: string, params?: unknown[]) => Promise<unknown> } | null | undefined, chainId: SupportedChainId) {
  if (isSolanaChainId(chainId)) {
    throw new Error(`Switch to ${getChainLabel(chainId)} from your Solana wallet. EVM wallets cannot add Solana.`);
  }
  if (!provider?.send) throw new Error("Wallet provider is not available.");
  const params = getWalletChainSwitchParams(chainId);

  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: params.chainId }]);
  } catch (error: any) {
    if (error?.code === 4902 || String(error?.message || "").toLowerCase().includes("unrecognized chain")) {
      await provider.send("wallet_addEthereumChain", [params]);
      return;
    }
    throw error;
  }
}

export function assertLaunchpadWriteReady(readiness: LaunchpadWriteReadiness) {
  if (readiness.ready) return;
  throw new Error(readiness.message || readiness.title || "Launchpad write action is not available.");
}

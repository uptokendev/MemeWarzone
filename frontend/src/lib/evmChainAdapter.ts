import { CHAIN_REGISTRY, type ChainDefinition } from "@/lib/chainRegistry";

export type EvmChainId = 56 | 97 | 4663 | 46630;
export type ActiveEvmChainId = 56 | 97;

export interface EvmWalletChainParams {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: 18;
  };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

/**
 * Robinhood is intentionally known to the EVM transport layer before it is
 * activated as a MemeWarzone product chain. Keeping discovery separate from
 * activation prevents "add chain ID everywhere" rollouts.
 */
export const KNOWN_EVM_CHAIN_IDS: readonly EvmChainId[] = [56, 97, 4663, 46630] as const;

/**
 * Runtime activation remains exactly equal to main while RH-3 is underway.
 * Robinhood only enters this list after its deployment/acceptance gates pass.
 */
export const ACTIVE_EVM_CHAIN_IDS: readonly ActiveEvmChainId[] = [56, 97] as const;

function isNumericChainId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isKnownEvmChainId(value?: number | null): value is EvmChainId {
  return isNumericChainId(value) && (KNOWN_EVM_CHAIN_IDS as readonly number[]).includes(value);
}

export function isActiveEvmChainId(value?: number | null): value is ActiveEvmChainId {
  return isNumericChainId(value) && (ACTIVE_EVM_CHAIN_IDS as readonly number[]).includes(value);
}

export function getEvmChainDefinition(chainId: EvmChainId): ChainDefinition {
  const definition = Object.values(CHAIN_REGISTRY).find(
    (candidate) => candidate.family === "evm" && candidate.chainId === chainId,
  );
  if (!definition) throw new Error(`Missing EVM chain definition for chain ${chainId}`);
  return definition;
}

export function getEvmExplorerTxBase(chainId: EvmChainId): string {
  return `${getEvmChainDefinition(chainId).explorerBaseUrl.replace(/\/$/, "")}/tx/`;
}

function walletChainName(chainId: EvmChainId): string {
  switch (chainId) {
    case 56:
      return "BNB Smart Chain";
    case 97:
      return "BNB Smart Chain Testnet";
    case 4663:
      return "Robinhood Chain";
    case 46630:
      return "Robinhood Chain Testnet";
  }
}

function nativeCurrencyName(chainId: EvmChainId): string {
  switch (chainId) {
    case 56:
      return "BNB";
    case 97:
      return "tBNB";
    case 4663:
    case 46630:
      return "ETH";
  }
}

export function buildEvmWalletChainParams(
  chainId: EvmChainId,
  rpcUrls: string[],
): EvmWalletChainParams {
  const definition = getEvmChainDefinition(chainId);
  const symbol = definition.nativeAsset;
  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName: walletChainName(chainId),
    nativeCurrency: {
      name: nativeCurrencyName(chainId),
      symbol,
      decimals: 18,
    },
    rpcUrls,
    blockExplorerUrls: [`${definition.explorerBaseUrl.replace(/\/$/, "")}/`],
  };
}

export function getEvmChainLabel(chainId: EvmChainId): string {
  switch (chainId) {
    case 56:
      return "BNB";
    case 97:
      return "BNB Testnet";
    case 4663:
      return "Robinhood";
    case 46630:
      return "Robinhood Testnet";
  }
}

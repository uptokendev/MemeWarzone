export type EvmIndexerChainId = 56 | 97 | 4663 | 46630;

export type EvmIndexerChainConfig = {
  chainId: EvmIndexerChainId;
  rpcHttp: string;
  factoryAddress?: string;
  factoryStartBlock?: number;
  voteTreasuryAddress?: string;
  voteTreasuryStartBlock?: number;
};

export type EvmIndexerChainInput = {
  rpcHttp?: string | null;
  factoryAddress?: string | null;
  factoryStartBlock?: number | null;
  voteTreasuryAddress?: string | null;
  voteTreasuryStartBlock?: number | null;
};

/**
 * Chains whose EVM transport is understood by MemeWarzone.
 * Known does not mean operationally enabled.
 */
export const KNOWN_EVM_INDEXER_CHAIN_IDS: readonly EvmIndexerChainId[] = [56, 97, 4663, 46630] as const;

/**
 * Preserve the current production indexer posture during RH-3.
 * Robinhood is enabled only after RH-7/RH-8 deployment and acceptance gates.
 */
export const ACTIVE_EVM_INDEXER_CHAIN_IDS: readonly EvmIndexerChainId[] = [56, 97] as const;

export function isKnownEvmIndexerChainId(chainId: number): chainId is EvmIndexerChainId {
  return (KNOWN_EVM_INDEXER_CHAIN_IDS as readonly number[]).includes(chainId);
}

export function isActiveEvmIndexerChainId(chainId: number): chainId is EvmIndexerChainId {
  return (ACTIVE_EVM_INDEXER_CHAIN_IDS as readonly number[]).includes(chainId);
}

function positiveBlock(value?: number | null): number | undefined {
  const block = Number(value || 0);
  return Number.isInteger(block) && block > 0 ? block : undefined;
}

function optionalString(value?: string | null): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

export function buildEvmIndexerChainConfig(
  chainId: EvmIndexerChainId,
  input: EvmIndexerChainInput,
): EvmIndexerChainConfig | null {
  const rpcHttp = optionalString(input.rpcHttp);
  if (!rpcHttp) return null;

  return {
    chainId,
    rpcHttp,
    factoryAddress: optionalString(input.factoryAddress),
    factoryStartBlock: positiveBlock(input.factoryStartBlock),
    voteTreasuryAddress: optionalString(input.voteTreasuryAddress),
    voteTreasuryStartBlock: positiveBlock(input.voteTreasuryStartBlock),
  };
}

/**
 * Build only explicitly enabled chains. This function intentionally has no
 * implicit Robinhood activation based on an RPC variable being present.
 */
export function buildActiveEvmIndexerChains(
  input: Partial<Record<EvmIndexerChainId, EvmIndexerChainInput>>,
  activeChainIds: readonly EvmIndexerChainId[] = ACTIVE_EVM_INDEXER_CHAIN_IDS,
): EvmIndexerChainConfig[] {
  return activeChainIds
    .map((chainId) => buildEvmIndexerChainConfig(chainId, input[chainId] || {}))
    .filter((config): config is EvmIndexerChainConfig => Boolean(config));
}

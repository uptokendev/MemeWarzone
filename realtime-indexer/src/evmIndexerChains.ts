export type EvmIndexerChainId = 56 | 97 | 4663 | 46630 | 6281971;

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
export const KNOWN_EVM_INDEXER_CHAIN_IDS: readonly EvmIndexerChainId[] = [56, 97, 4663, 46630, 6281971] as const;

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

/** DogeOS Chikyu testnet. Known, never in the hard-coded ACTIVE list; switched on by its RPC env only. */
export const DOGEOS_TESTNET_CHAIN_ID = 6281971;

/**
 * Chains whose graduated market is a Uniswap-V3 style pool (Robinhood and DogeOS).
 * Drives the V3 campaign_market_state seed and the pre-scan V3 CMS heal in indexer.ts.
 */
export function isV3GraduationIndexerChainId(chainId: number): boolean {
  return chainId === 46630 || chainId === 4663 || chainId === DOGEOS_TESTNET_CHAIN_ID;
}

/** Venue + quote asset announced when a campaign graduates. DogeOS quotes in WDOGE, never WETH/WBNB. */
export function graduatedMarketFor(chainId: number): { venue: "v3" | "topaz"; quoteAsset: "WDOGE" | "WETH" | "WBNB" } {
  if (chainId === DOGEOS_TESTNET_CHAIN_ID) return { venue: "v3", quoteAsset: "WDOGE" };
  if (chainId === 46630 || chainId === 4663) return { venue: "v3", quoteAsset: "WETH" };
  return { venue: "topaz", quoteAsset: "WBNB" };
}

type IndexerChainListChainId = 56 | 97 | 46630 | 4663 | 6281971;

/** The env fields the main indexer CHAINS list reads. `ENV` from env.ts satisfies it. */
export type IndexerChainListEnv = {
  BSC_RPC_HTTP_56: string;
  BSC_RPC_HTTP_97: string;
  ROBINHOOD_RPC_HTTP_46630: string;
  ROBINHOOD_RPC_HTTP_4663: string;
  DOGEOS_RPC_HTTP_6281971: string;
} & Record<`FACTORY_ADDRESS_${IndexerChainListChainId}` | `VOTE_TREASURY_ADDRESS_${IndexerChainListChainId}`, string>
  & Record<`FACTORY_START_BLOCK_${IndexerChainListChainId}` | `VOTE_TREASURY_START_BLOCK_${IndexerChainListChainId}`, number>;

export type IndexerChainCfg = {
  chainId: number;
  rpcHttp: string; // comma-separated list
  factoryAddress?: string;
  factoryStartBlock?: number;
  voteTreasuryAddress?: string;
  voteTreasuryStartBlock?: number;
};

/**
 * The main indexer chain list (indexer.ts CHAINS), moved here unchanged so it can be
 * tested without importing indexer.ts. Every entry is present only when its RPC is
 * configured and usable; this list does not consult ACTIVE_EVM_INDEXER_CHAIN_IDS.
 */
export function buildIndexerChainList(env: IndexerChainListEnv): IndexerChainCfg[] {
  return [
    {
      chainId: 56,
      rpcHttp: env.BSC_RPC_HTTP_56,
      factoryAddress: env.FACTORY_ADDRESS_56 || undefined,
      factoryStartBlock: env.FACTORY_START_BLOCK_56 || undefined,
      voteTreasuryAddress: env.VOTE_TREASURY_ADDRESS_56 || undefined,
      voteTreasuryStartBlock: env.VOTE_TREASURY_START_BLOCK_56 || undefined
    },
    {
      chainId: 97,
      rpcHttp: env.BSC_RPC_HTTP_97,
      factoryAddress: env.FACTORY_ADDRESS_97 || undefined,
      factoryStartBlock: env.FACTORY_START_BLOCK_97 || undefined,
      voteTreasuryAddress: env.VOTE_TREASURY_ADDRESS_97 || undefined,
      voteTreasuryStartBlock: env.VOTE_TREASURY_START_BLOCK_97 || undefined
    },
    {
      chainId: 46630,
      rpcHttp: env.ROBINHOOD_RPC_HTTP_46630,
      factoryAddress: env.FACTORY_ADDRESS_46630 || undefined,
      factoryStartBlock: env.FACTORY_START_BLOCK_46630 || undefined,
      voteTreasuryAddress: env.VOTE_TREASURY_ADDRESS_46630 || undefined,
      voteTreasuryStartBlock: env.VOTE_TREASURY_START_BLOCK_46630 || undefined
    },
    {
      // Robinhood mainnet (factory 0x35E93D0b..., deployed 2026-09-24). Same shape
      // as 46630 and gated the same way: present only when its RPC is configured.
      chainId: 4663,
      rpcHttp: env.ROBINHOOD_RPC_HTTP_4663,
      factoryAddress: env.FACTORY_ADDRESS_4663 || undefined,
      factoryStartBlock: env.FACTORY_START_BLOCK_4663 || undefined,
      voteTreasuryAddress: env.VOTE_TREASURY_ADDRESS_4663 || undefined,
      voteTreasuryStartBlock: env.VOTE_TREASURY_START_BLOCK_4663 || undefined
    },
    {
      // DogeOS Chikyu testnet. Gated the same way: present only when its RPC is
      // configured. Vote treasury stays empty until sub-project 3.
      chainId: 6281971,
      rpcHttp: env.DOGEOS_RPC_HTTP_6281971,
      factoryAddress: env.FACTORY_ADDRESS_6281971 || undefined,
      factoryStartBlock: env.FACTORY_START_BLOCK_6281971 || undefined,
      voteTreasuryAddress: env.VOTE_TREASURY_ADDRESS_6281971 || undefined,
      voteTreasuryStartBlock: env.VOTE_TREASURY_START_BLOCK_6281971 || undefined
    }
  ].filter((chain) => Boolean(chain.rpcHttp && /^https?:\/\//i.test(String(chain.rpcHttp)) && !/[<>]|YOUR_/i.test(String(chain.rpcHttp))));
}

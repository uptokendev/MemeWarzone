import type { RuntimeEnvironment } from "@/lib/runtimeEnvironment";

export type ChainFamily = "evm" | "solana";
export type NetworkClass = "test" | "production";

export type ChainKey =
  | "bnb-mainnet"
  | "bnb-testnet"
  | "solana-mainnet"
  | "solana-devnet"
  | "robinhood-mainnet"
  | "robinhood-testnet";

export interface ChainDefinition {
  key: ChainKey;
  displayName: string;
  family: ChainFamily;
  networkClass: NetworkClass;
  runtimeEnvironment: Exclude<RuntimeEnvironment, "local">;
  chainId: number;
  nativeAsset: string;
  explorerBaseUrl: string;
  publicRpcEnvKey: string;
  deploymentManifest: string;
  graduationAdapter: string;
  swapAdapter: string;
  oracleAdapter: string;
  supportsCreation: boolean;
}

export const CHAIN_REGISTRY: Readonly<Record<ChainKey, ChainDefinition>> = Object.freeze({
  "bnb-mainnet": {
    key: "bnb-mainnet",
    displayName: "BNB Chain",
    family: "evm",
    networkClass: "production",
    runtimeEnvironment: "production",
    chainId: 56,
    nativeAsset: "BNB",
    explorerBaseUrl: "https://bscscan.com",
    publicRpcEnvKey: "VITE_PUBLIC_RPC_56",
    deploymentManifest: "deployments/bnb/mainnet.json",
    graduationAdapter: "topaz",
    swapAdapter: "topaz",
    oracleAdapter: "bnb-usd",
    supportsCreation: true,
  },
  "bnb-testnet": {
    key: "bnb-testnet",
    displayName: "BNB Chain Testnet",
    family: "evm",
    networkClass: "test",
    runtimeEnvironment: "staging",
    chainId: 97,
    nativeAsset: "tBNB",
    explorerBaseUrl: "https://testnet.bscscan.com",
    publicRpcEnvKey: "VITE_PUBLIC_RPC_97",
    deploymentManifest: "deployments/bnb/testnet.json",
    graduationAdapter: "topaz-testnet",
    swapAdapter: "topaz-testnet",
    oracleAdapter: "bnb-usd-test",
    supportsCreation: true,
  },
  "solana-mainnet": {
    key: "solana-mainnet",
    displayName: "Solana",
    family: "solana",
    networkClass: "production",
    runtimeEnvironment: "production",
    chainId: 101,
    nativeAsset: "SOL",
    explorerBaseUrl: "https://solscan.io",
    publicRpcEnvKey: "VITE_SOLANA_MAINNET_RPC",
    deploymentManifest: "deployments/solana/mainnet.json",
    graduationAdapter: "meteora",
    swapAdapter: "meteora",
    oracleAdapter: "sol-usd",
    supportsCreation: true,
  },
  "solana-devnet": {
    key: "solana-devnet",
    displayName: "Solana Devnet",
    family: "solana",
    networkClass: "test",
    runtimeEnvironment: "staging",
    chainId: 101,
    nativeAsset: "SOL",
    explorerBaseUrl: "https://solscan.io",
    publicRpcEnvKey: "VITE_SOLANA_DEVNET_RPC",
    deploymentManifest: "deployments/solana/devnet.json",
    graduationAdapter: "meteora-devnet",
    swapAdapter: "meteora-devnet",
    oracleAdapter: "sol-usd-test",
    supportsCreation: true,
  },
  "robinhood-mainnet": {
    key: "robinhood-mainnet",
    displayName: "Robinhood Chain",
    family: "evm",
    networkClass: "production",
    runtimeEnvironment: "production",
    chainId: 4663,
    nativeAsset: "ETH",
    explorerBaseUrl: "https://robinhoodchain.blockscout.com",
    publicRpcEnvKey: "VITE_PUBLIC_RPC_4663",
    deploymentManifest: "deployments/robinhood/mainnet.json",
    graduationAdapter: "robinhood-dex",
    swapAdapter: "robinhood-dex",
    oracleAdapter: "eth-usd",
    supportsCreation: false,
  },
  "robinhood-testnet": {
    key: "robinhood-testnet",
    displayName: "Robinhood Chain Testnet",
    family: "evm",
    networkClass: "test",
    runtimeEnvironment: "staging",
    chainId: 46630,
    nativeAsset: "ETH",
    explorerBaseUrl: "https://explorer.testnet.chain.robinhood.com",
    publicRpcEnvKey: "VITE_PUBLIC_RPC_46630",
    deploymentManifest: "deployments/robinhood/testnet.json",
    graduationAdapter: "robinhood-dex-testnet",
    swapAdapter: "robinhood-dex-testnet",
    oracleAdapter: "eth-usd-test",
    supportsCreation: false,
  },
});

export function getChainDefinition(key: ChainKey): ChainDefinition {
  const definition = CHAIN_REGISTRY[key];
  if (!definition) throw new Error(`Unsupported chain registry key: ${key}`);
  return definition;
}

export function getChainsForEnvironment(
  environment: Exclude<RuntimeEnvironment, "local">,
): ChainDefinition[] {
  return Object.values(CHAIN_REGISTRY).filter(
    (definition) => definition.runtimeEnvironment === environment,
  );
}

export function getEvmChainsForEnvironment(
  environment: Exclude<RuntimeEnvironment, "local">,
): ChainDefinition[] {
  return getChainsForEnvironment(environment).filter((definition) => definition.family === "evm");
}

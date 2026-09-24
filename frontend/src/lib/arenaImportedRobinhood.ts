import { Contract, ethers } from "ethers";
import {
  executeRobinhoodV3Buy,
  executeRobinhoodV3Sell,
  ensureRobinhoodV3SellAllowance,
  quoteRobinhoodV3Buy,
  quoteRobinhoodV3Sell,
  type RobinhoodV3ResolvedRoute,
} from "@/lib/robinhoodV3Trade";
import { isRobinhoodChainId } from "@/lib/chainConfig";
import type { MarketRoute } from "@/lib/marketContinuityApi";

const V3_FACTORY_ABI = ["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"] as const;
const ADAPTER_ABI = [
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
] as const;
const FEE_TIERS = [500, 3000, 10000] as const;

function envAddress(name: string, chainId: number): string {
  const viteEnv = import.meta.env as Record<string, unknown>;
  return String(viteEnv[`${name}_${chainId}`] ?? viteEnv[name] ?? "").trim();
}

export async function resolveImportedRobinhoodV3Route(input: {
  provider: ethers.Provider;
  tokenAddress: string;
  chainId: number;
}): Promise<RobinhoodV3ResolvedRoute | null> {
  if (!isRobinhoodChainId(input.chainId) || !ethers.isAddress(input.tokenAddress)) return null;
  const factoryAddress = envAddress("VITE_ROBINHOOD_V3_FACTORY_ADDRESS", input.chainId);
  const adapterAddress = envAddress("VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS", input.chainId);
  if (!ethers.isAddress(factoryAddress) || !ethers.isAddress(adapterAddress)) return null;

  const adapter = new Contract(adapterAddress, ADAPTER_ABI, input.provider);
  const [routerAddress, wrappedNativeAddress] = await Promise.all([adapter.swapRouter(), adapter.wrappedNative()]);
  if (!ethers.isAddress(routerAddress) || !ethers.isAddress(wrappedNativeAddress)) return null;

  const factory = new Contract(factoryAddress, V3_FACTORY_ABI, input.provider);
  let poolAddress = ethers.ZeroAddress;
  let fee = 3000;
  for (const candidate of FEE_TIERS) {
    const pool = String(await factory.getPool(input.tokenAddress, wrappedNativeAddress, candidate));
    if (pool && pool !== ethers.ZeroAddress) {
      poolAddress = pool;
      fee = candidate;
      break;
    }
  }
  if (!poolAddress || poolAddress === ethers.ZeroAddress) return null;

  const market: MarketRoute = {
    chainId: input.chainId,
    marketStage: "DEX_ACTIVE",
    campaignAddress: input.tokenAddress,
    token: input.tokenAddress,
    pair: poolAddress,
    router: routerAddress,
    factory: factoryAddress,
    wrappedNative: wrappedNativeAddress,
    quoteToken: wrappedNativeAddress,
    quoteAssetType: "WRAPPED_NATIVE",
    routeKind: "DIRECT_NATIVE",
    stable: false,
    feeBps: Math.round(fee / 100),
    verified: true,
    tradingEnabled: true,
    verifiedAt: new Date().toISOString(),
    lastError: null,
  };

  return {
    market,
    chainId: input.chainId,
    tokenAddress: ethers.getAddress(input.tokenAddress),
    poolAddress: ethers.getAddress(poolAddress),
    routerAddress: ethers.getAddress(routerAddress),
    factoryAddress: ethers.getAddress(factoryAddress),
    wrappedNativeAddress: ethers.getAddress(wrappedNativeAddress),
    quoteTokenAddress: ethers.getAddress(wrappedNativeAddress),
    quoteAssetType: "WRAPPED_NATIVE",
    routeKind: "DIRECT_NATIVE",
    referenceOracleAddress: null,
    nativeSwapAdapterAddress: ethers.getAddress(adapterAddress),
    executionAdapterAddress: ethers.getAddress(adapterAddress),
    multiHopSwapAdapterAddress: null,
    fee,
    stockRoute: null,
  };
}

export { quoteRobinhoodV3Buy, quoteRobinhoodV3Sell, executeRobinhoodV3Buy, executeRobinhoodV3Sell, ensureRobinhoodV3SellAllowance };

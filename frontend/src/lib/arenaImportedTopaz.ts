import { Contract, ethers } from "ethers";
import { getBnbContractAddresses } from "@/lib/bnbContracts";
import { quoteTopazBuy, quoteTopazSell, executeTopazBuy, executeTopazSell, ensureTopazSellAllowance, type TopazResolvedRoute } from "@/lib/topazV2Trade";
import type { SupportedChainId } from "@/lib/chainConfig";

const FACTORY_ABI = ["function getPool(address tokenA,address tokenB,bool stable) view returns (address pool)"] as const;

export async function resolveImportedTopazRoute(input: {
  provider: ethers.Provider;
  tokenAddress: string;
  chainId: number;
}): Promise<TopazResolvedRoute | null> {
  const addrs = getBnbContractAddresses(input.chainId as SupportedChainId);
  if (!addrs.topazFactory || !addrs.topazRouter || !addrs.topazWbnb) return null;
  if (!ethers.isAddress(input.tokenAddress)) return null;
  const factory = new Contract(addrs.topazFactory, FACTORY_ABI, input.provider);
  const pair = String(await factory.getPool(input.tokenAddress, addrs.topazWbnb, false));
  if (!pair || pair === ethers.ZeroAddress) return null;
  return {
    market: {
      chainId: input.chainId,
      marketStage: "TOPAZ_ACTIVE",
      campaignAddress: input.tokenAddress,
      token: input.tokenAddress,
      pair,
      router: addrs.topazRouter,
      factory: addrs.topazFactory,
      wrappedNative: addrs.topazWbnb,
      stable: false,
      feeBps: 100,
      verified: true,
      tradingEnabled: true,
      verifiedAt: new Date().toISOString(),
      lastError: null,
    },
    route: [
      { from: addrs.topazWbnb, to: input.tokenAddress, stable: false, factory: addrs.topazFactory },
    ],
    routerAddress: addrs.topazRouter,
    factoryAddress: addrs.topazFactory,
    wrappedNativeAddress: addrs.topazWbnb,
    tokenAddress: input.tokenAddress,
    pairAddress: pair,
    feeBps: 100,
  };
}

export { quoteTopazBuy, quoteTopazSell, executeTopazBuy, executeTopazSell, ensureTopazSellAllowance };

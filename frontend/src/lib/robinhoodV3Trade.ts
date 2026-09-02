import { Contract, ethers } from "ethers";
import { fetchMarketRoute, type MarketRoute } from "@/lib/marketContinuityApi";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";

const V3_ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn) view returns (uint256 amountOut)",
] as const;

const NATIVE_SWAP_ADAPTER_ABI = [
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function buyExactNativeIn(address tokenOut,uint24 fee,uint256 amountOutMinimum,address recipient) payable returns (uint256 amountOut)",
  "function sellExactTokenIn(address tokenIn,uint24 fee,uint256 amountIn,uint256 amountOutMinimum,address recipient) returns (uint256 amountOut)",
] as const;

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;

type ExtendedMarketRoute = MarketRoute & {
  quoteToken?: string | null;
  quoteAssetType?: "WRAPPED_NATIVE" | "STOCK_TOKEN" | "UNKNOWN" | null;
  routeKind?: "DIRECT_NATIVE" | "STOCK_TWO_HOP" | "UNKNOWN" | null;
  referenceOracle?: string | null;
};

export type RobinhoodV3ResolvedRoute = {
  market: MarketRoute;
  chainId: number;
  tokenAddress: string;
  poolAddress: string;
  routerAddress: string;
  factoryAddress: string;
  wrappedNativeAddress: string;
  quoteTokenAddress: string;
  quoteAssetType: "WRAPPED_NATIVE";
  routeKind: "DIRECT_NATIVE";
  referenceOracleAddress: string | null;
  nativeSwapAdapterAddress: string;
  fee: number;
};

export type RobinhoodV3Quote = {
  amountInRaw: bigint;
  amountOutRaw: bigint;
  minimumOutRaw: bigint;
  slippageBps: number;
  route: RobinhoodV3ResolvedRoute;
};

function isRobinhoodChainId(chainId: number): boolean {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

function normalizeAddress(value: unknown, label: string): string {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`Invalid ${label}.`);
  return ethers.getAddress(raw);
}

function normalizeOptionalAddress(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw || !ethers.isAddress(raw) || raw === ethers.ZeroAddress) return null;
  return ethers.getAddress(raw);
}

function sameAddress(a: unknown, b: unknown): boolean {
  try {
    return ethers.getAddress(String(a)) === ethers.getAddress(String(b));
  } catch {
    return false;
  }
}

function envAddress(name: string, chainId: number): string {
  const viteEnv = import.meta.env as Record<string, unknown>;
  return String(viteEnv[`${name}_${chainId}`] || "").trim();
}

function validateSlippageBps(value: number): number {
  const bps = Math.trunc(Number(value));
  if (!Number.isFinite(bps) || bps < 10 || bps > 500) {
    throw new Error("Slippage must be between 0.10% and 5.00%.");
  }
  return bps;
}

function minimumOut(amountOutRaw: bigint, slippageBps: number): bigint {
  const bps = validateSlippageBps(slippageBps);
  return amountOutRaw <= 0n ? 0n : (amountOutRaw * BigInt(10_000 - bps)) / 10_000n;
}

async function requireCode(provider: ethers.Provider, address: string, label: string) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} is not deployed.`);
}

function normalizeV3Fee(route: MarketRoute): number {
  const raw = Number(route.feeBps);
  if (Number.isInteger(raw) && raw > 0) {
    if (raw >= 100 && raw <= 1_000_000) return raw;
    if (raw <= 100) return raw * 100;
  }
  return 3000;
}

export async function resolveRobinhoodV3Route(input: {
  provider: ethers.Provider;
  campaignAddress: string;
  chainId: number;
  expectedTokenAddress?: string;
  signal?: AbortSignal;
}): Promise<RobinhoodV3ResolvedRoute> {
  if (!isRobinhoodChainId(input.chainId)) throw new Error("Robinhood V3 route requested for a non-Robinhood chain.");

  const network = await input.provider.getNetwork();
  if (Number(network.chainId) !== Number(input.chainId)) {
    throw new Error(`Wrong network. Connect Robinhood chain ${input.chainId}.`);
  }

  const market = await fetchMarketRoute(input.campaignAddress, input.chainId, input.signal);
  if (market.marketStage !== "DEX_ACTIVE" || market.tradingEnabled === false || market.verified === false) {
    throw new Error("Robinhood V3 market is not active and verified yet.");
  }

  const tokenAddress = normalizeAddress(market.token, "Robinhood token");
  if (input.expectedTokenAddress && !sameAddress(tokenAddress, input.expectedTokenAddress)) {
    throw new Error("Robinhood V3 market token mismatch.");
  }

  const extendedMarket = market as ExtendedMarketRoute;
  const routeKind = String(extendedMarket.routeKind || "DIRECT_NATIVE").trim().toUpperCase();
  const quoteAssetType = String(extendedMarket.quoteAssetType || "WRAPPED_NATIVE").trim().toUpperCase();
  const quoteTokenAddress = normalizeAddress(
    extendedMarket.quoteToken || market.wrappedNative,
    "Robinhood quote token",
  );
  if (routeKind !== "DIRECT_NATIVE" || quoteAssetType !== "WRAPPED_NATIVE") {
    throw new Error("This trade panel does not support Robinhood Stock Battlefield routes yet.");
  }

  const poolAddress = normalizeAddress(market.pair, "Robinhood V3 pool");
  const routerAddress = normalizeAddress(
    market.router || envAddress("VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS", input.chainId),
    "Robinhood V3 router",
  );
  const factoryAddress = normalizeAddress(
    market.factory || envAddress("VITE_ROBINHOOD_V3_FACTORY_ADDRESS", input.chainId),
    "Robinhood V3 factory",
  );
  const wrappedNativeAddress = normalizeAddress(
    market.wrappedNative || envAddress("VITE_WRAPPED_NATIVE_ADDRESS", input.chainId),
    "Robinhood wrapped native",
  );
  if (!sameAddress(quoteTokenAddress, wrappedNativeAddress)) {
    throw new Error("Robinhood direct-native route quote asset mismatch.");
  }
  const nativeSwapAdapterAddress = normalizeAddress(
    envAddress("VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS", input.chainId),
    "Robinhood V3 native swap adapter",
  );

  await Promise.all([
    requireCode(input.provider, tokenAddress, "Robinhood token"),
    requireCode(input.provider, poolAddress, "Robinhood V3 pool"),
    requireCode(input.provider, routerAddress, "Robinhood V3 router"),
    requireCode(input.provider, factoryAddress, "Robinhood V3 factory"),
    requireCode(input.provider, wrappedNativeAddress, "Robinhood wrapped native"),
    requireCode(input.provider, nativeSwapAdapterAddress, "Robinhood V3 native swap adapter"),
  ]);

  const router = new Contract(routerAddress, V3_ROUTER_ABI, input.provider) as any;
  const adapter = new Contract(nativeSwapAdapterAddress, NATIVE_SWAP_ADAPTER_ABI, input.provider) as any;
  const [routerFactory, routerWrapped, adapterRouter, adapterWrapped] = await Promise.all([
    router.factory(),
    router.WETH9(),
    adapter.swapRouter(),
    adapter.wrappedNative(),
  ]);
  if (!sameAddress(routerFactory, factoryAddress)) throw new Error("Robinhood V3 router factory mismatch.");
  if (!sameAddress(routerWrapped, wrappedNativeAddress)) throw new Error("Robinhood V3 router wrapped-native mismatch.");
  if (!sameAddress(adapterRouter, routerAddress)) throw new Error("Robinhood V3 native adapter router mismatch.");
  if (!sameAddress(adapterWrapped, wrappedNativeAddress)) throw new Error("Robinhood V3 native adapter wrapped-native mismatch.");

  return {
    market,
    chainId: input.chainId,
    tokenAddress,
    poolAddress,
    routerAddress,
    factoryAddress,
    wrappedNativeAddress,
    quoteTokenAddress,
    quoteAssetType: "WRAPPED_NATIVE",
    routeKind: "DIRECT_NATIVE",
    referenceOracleAddress: normalizeOptionalAddress(extendedMarket.referenceOracle),
    nativeSwapAdapterAddress,
    fee: normalizeV3Fee(market),
  };
}

async function quoteExactInput(
  provider: ethers.Provider,
  route: RobinhoodV3ResolvedRoute,
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
  slippageBps: number,
): Promise<RobinhoodV3Quote> {
  if (amountInRaw <= 0n) throw new Error("Enter an amount greater than zero.");
  const router = new Contract(route.routerAddress, V3_ROUTER_ABI, provider) as any;
  const amountOutRaw = BigInt(await router.quoteExactInputSingle(tokenIn, tokenOut, route.fee, amountInRaw));
  if (amountOutRaw <= 0n) throw new Error("Robinhood V3 quote returned zero output.");
  return {
    amountInRaw,
    amountOutRaw,
    minimumOutRaw: minimumOut(amountOutRaw, slippageBps),
    slippageBps: validateSlippageBps(slippageBps),
    route,
  };
}

export function quoteRobinhoodV3Buy(
  provider: ethers.Provider,
  route: RobinhoodV3ResolvedRoute,
  nativeInRaw: bigint,
  slippageBps: number,
) {
  return quoteExactInput(provider, route, route.wrappedNativeAddress, route.tokenAddress, nativeInRaw, slippageBps);
}

export function quoteRobinhoodV3Sell(
  provider: ethers.Provider,
  route: RobinhoodV3ResolvedRoute,
  tokenInRaw: bigint,
  slippageBps: number,
) {
  return quoteExactInput(provider, route, route.tokenAddress, route.wrappedNativeAddress, tokenInRaw, slippageBps);
}

export async function ensureRobinhoodV3SellAllowance(input: {
  signer: ethers.Signer;
  route: RobinhoodV3ResolvedRoute;
  amountInRaw: bigint;
}) {
  const owner = await input.signer.getAddress();
  const token = new Contract(input.route.tokenAddress, ERC20_ABI, input.signer) as any;
  const allowance = BigInt(await token.allowance(owner, input.route.nativeSwapAdapterAddress));
  if (allowance >= input.amountInRaw) return null;
  const tx = await token.approve(input.route.nativeSwapAdapterAddress, MAX_UINT256);
  await tx.wait();
  return tx;
}

export async function executeRobinhoodV3Buy(input: {
  signer: ethers.Signer;
  quote: RobinhoodV3Quote;
  recipient?: string;
}) {
  const recipient = input.recipient || await input.signer.getAddress();
  const adapter = new Contract(input.quote.route.nativeSwapAdapterAddress, NATIVE_SWAP_ADAPTER_ABI, input.signer) as any;
  return adapter.buyExactNativeIn(
    input.quote.route.tokenAddress,
    input.quote.route.fee,
    input.quote.minimumOutRaw,
    recipient,
    { value: input.quote.amountInRaw },
  );
}

export async function executeRobinhoodV3Sell(input: {
  signer: ethers.Signer;
  quote: RobinhoodV3Quote;
  recipient?: string;
}) {
  const recipient = input.recipient || await input.signer.getAddress();
  const adapter = new Contract(input.quote.route.nativeSwapAdapterAddress, NATIVE_SWAP_ADAPTER_ABI, input.signer) as any;
  return adapter.sellExactTokenIn(
    input.quote.route.tokenAddress,
    input.quote.route.fee,
    input.quote.amountInRaw,
    input.quote.minimumOutRaw,
    recipient,
  );
}

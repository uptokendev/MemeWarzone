import { Contract, ethers } from "ethers";
import {
  fetchMarketRoute,
  type MarketRoute,
  type RobinhoodQuoteAssetType,
  type RobinhoodRouteKind,
} from "@/lib/marketContinuityApi";
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

const MULTI_HOP_SWAP_ADAPTER_ABI = [
  "function v3Factory() view returns (address)",
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function marketRoutes(address memeToken) view returns (address stockToken,uint24 nativeStockFee,uint24 stockMemeFee,uint16 maxPriceImpactBps,bool enabled)",
  "function routeHealth(address memeToken) view returns (bool configured,bool enabled,address stockToken,address nativeStockPool,address stockMemePool,bool poolsValid)",
  "function quoteBuyWithNative(address memeToken,uint256 nativeIn) view returns ((address stockToken,uint256 intermediateOut,uint256 finalOut,uint256 firstLegPriceImpactBps,uint256 secondLegPriceImpactBps,uint64 quotedAt) quote)",
  "function quoteSellForNative(address memeToken,uint256 memeIn) view returns ((address stockToken,uint256 intermediateOut,uint256 finalOut,uint256 firstLegPriceImpactBps,uint256 secondLegPriceImpactBps,uint64 quotedAt) quote)",
  "function buyWithNative(address memeToken,uint256 minimumStockOut,uint256 minimumMemeOut,uint256 deadline,address recipient) payable returns (uint256 memeOut)",
  "function sellForNative(address memeToken,uint256 memeIn,uint256 minimumStockOut,uint256 minimumNativeOut,uint256 deadline,address recipient) returns (uint256 nativeOut)",
] as const;

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;
const TRADE_DEADLINE_SECONDS = 5 * 60;

export type RobinhoodV3ResolvedRoute = {
  market: MarketRoute;
  chainId: number;
  tokenAddress: string;
  poolAddress: string;
  routerAddress: string;
  factoryAddress: string;
  wrappedNativeAddress: string;
  quoteTokenAddress: string;
  quoteAssetType: "WRAPPED_NATIVE" | "STOCK_TOKEN";
  routeKind: "DIRECT_NATIVE" | "STOCK_TWO_HOP";
  referenceOracleAddress: string | null;
  /** Backward-compatible alias for the contract that receives sell allowance/execution. */
  nativeSwapAdapterAddress: string;
  executionAdapterAddress: string;
  multiHopSwapAdapterAddress: string | null;
  fee: number;
  stockRoute: {
    stockTokenAddress: string;
    nativeStockPoolAddress: string;
    stockMemePoolAddress: string;
    nativeStockFee: number;
    stockMemeFee: number;
    maxPriceImpactBps: number;
  } | null;
};

export type RobinhoodV3Quote = {
  amountInRaw: bigint;
  amountOutRaw: bigint;
  minimumOutRaw: bigint;
  intermediateAmountOutRaw: bigint | null;
  minimumIntermediateOutRaw: bigint | null;
  firstLegPriceImpactBps: bigint | null;
  secondLegPriceImpactBps: bigint | null;
  quotedAt: bigint | null;
  slippageBps: number;
  route: RobinhoodV3ResolvedRoute;
};

type RobinhoodRouteDescriptor = {
  quoteTokenAddress: string;
  quoteAssetType: RobinhoodQuoteAssetType;
  routeKind: RobinhoodRouteKind;
  referenceOracleAddress: string | null;
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

function envValue(name: string, chainId: number): string {
  const viteEnv = import.meta.env as Record<string, unknown>;
  return String(viteEnv[`${name}_${chainId}`] ?? viteEnv[name] ?? "").trim();
}

function envAddress(name: string, chainId: number): string {
  return envValue(name, chainId);
}

function envFlag(name: string, chainId: number): boolean {
  const normalized = envValue(name, chainId).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function stockEthRoutingEnabled(chainId: number): boolean {
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) return true;
  return envFlag("VITE_ROBINHOOD_STOCK_ETH_ROUTING", chainId);
}

function normalizeQuoteAssetType(value: unknown): RobinhoodQuoteAssetType {
  const normalized = String(value || "WRAPPED_NATIVE").trim().toUpperCase();
  if (normalized === "WRAPPED_NATIVE" || normalized === "STOCK_TOKEN" || normalized === "UNKNOWN") {
    return normalized;
  }
  return "UNKNOWN";
}

function normalizeRouteKind(value: unknown): RobinhoodRouteKind {
  const normalized = String(value || "DIRECT_NATIVE").trim().toUpperCase();
  if (normalized === "DIRECT_NATIVE" || normalized === "STOCK_TWO_HOP" || normalized === "UNKNOWN") {
    return normalized;
  }
  return "UNKNOWN";
}

export function describeRobinhoodV3Route(market: MarketRoute): RobinhoodRouteDescriptor {
  return {
    quoteTokenAddress: normalizeAddress(market.quoteToken || market.wrappedNative, "Robinhood quote token"),
    quoteAssetType: normalizeQuoteAssetType(market.quoteAssetType),
    routeKind: normalizeRouteKind(market.routeKind),
    referenceOracleAddress: normalizeOptionalAddress(market.referenceOracle),
  };
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

function resultValue(result: any, name: string, index: number): any {
  return result?.[name] ?? result?.[index];
}

function resultBigInt(result: any, name: string, index: number): bigint {
  return BigInt(resultValue(result, name, index) ?? 0);
}

async function resolveCommonRoute(input: {
  provider: ethers.Provider;
  market: MarketRoute;
  chainId: number;
  tokenAddress: string;
  routeDescriptor: RobinhoodRouteDescriptor;
}) {
  const poolAddress = normalizeAddress(input.market.pair, "Robinhood V3 pool");
  const routerAddress = normalizeAddress(
    input.market.router || envAddress("VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS", input.chainId),
    "Robinhood V3 router",
  );
  const factoryAddress = normalizeAddress(
    input.market.factory || envAddress("VITE_ROBINHOOD_V3_FACTORY_ADDRESS", input.chainId),
    "Robinhood V3 factory",
  );
  const wrappedNativeAddress = normalizeAddress(
    input.market.wrappedNative || envAddress("VITE_WRAPPED_NATIVE_ADDRESS", input.chainId),
    "Robinhood wrapped native",
  );

  await Promise.all([
    requireCode(input.provider, input.tokenAddress, "Robinhood token"),
    requireCode(input.provider, poolAddress, "Robinhood V3 pool"),
    requireCode(input.provider, routerAddress, "Robinhood V3 router"),
    requireCode(input.provider, factoryAddress, "Robinhood V3 factory"),
    requireCode(input.provider, wrappedNativeAddress, "Robinhood wrapped native"),
  ]);

  const router = new Contract(routerAddress, V3_ROUTER_ABI, input.provider) as any;
  const [routerFactory, routerWrapped] = await Promise.all([router.factory(), router.WETH9()]);
  if (!sameAddress(routerFactory, factoryAddress)) throw new Error("Robinhood V3 router factory mismatch.");
  if (!sameAddress(routerWrapped, wrappedNativeAddress)) throw new Error("Robinhood V3 router wrapped-native mismatch.");

  return { poolAddress, routerAddress, factoryAddress, wrappedNativeAddress };
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

  const market = await fetchMarketRoute(input.campaignAddress, input.chainId, input.signal, { includeQuotePrice: true });
  if (market.marketStage !== "DEX_ACTIVE" || market.tradingEnabled === false || market.verified === false) {
    throw new Error("Robinhood V3 market is not active and verified yet.");
  }

  const tokenAddress = normalizeAddress(market.token, "Robinhood token");
  if (input.expectedTokenAddress && !sameAddress(tokenAddress, input.expectedTokenAddress)) {
    throw new Error("Robinhood V3 market token mismatch.");
  }

  const routeDescriptor = describeRobinhoodV3Route(market);
  const common = await resolveCommonRoute({
    provider: input.provider,
    market,
    chainId: input.chainId,
    tokenAddress,
    routeDescriptor,
  });

  if (routeDescriptor.routeKind === "DIRECT_NATIVE" && routeDescriptor.quoteAssetType === "WRAPPED_NATIVE") {
    if (!sameAddress(routeDescriptor.quoteTokenAddress, common.wrappedNativeAddress)) {
      throw new Error("Robinhood direct-native route quote asset mismatch.");
    }
    const nativeSwapAdapterAddress = normalizeAddress(
      envAddress("VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS", input.chainId),
      "Robinhood V3 native swap adapter",
    );
    await requireCode(input.provider, nativeSwapAdapterAddress, "Robinhood V3 native swap adapter");

    const adapter = new Contract(nativeSwapAdapterAddress, NATIVE_SWAP_ADAPTER_ABI, input.provider) as any;
    const [adapterRouter, adapterWrapped] = await Promise.all([adapter.swapRouter(), adapter.wrappedNative()]);
    if (!sameAddress(adapterRouter, common.routerAddress)) throw new Error("Robinhood V3 native adapter router mismatch.");
    if (!sameAddress(adapterWrapped, common.wrappedNativeAddress)) throw new Error("Robinhood V3 native adapter wrapped-native mismatch.");

    return {
      market,
      chainId: input.chainId,
      tokenAddress,
      poolAddress: common.poolAddress,
      routerAddress: common.routerAddress,
      factoryAddress: common.factoryAddress,
      wrappedNativeAddress: common.wrappedNativeAddress,
      quoteTokenAddress: routeDescriptor.quoteTokenAddress,
      quoteAssetType: "WRAPPED_NATIVE",
      routeKind: "DIRECT_NATIVE",
      referenceOracleAddress: routeDescriptor.referenceOracleAddress,
      nativeSwapAdapterAddress,
      executionAdapterAddress: nativeSwapAdapterAddress,
      multiHopSwapAdapterAddress: null,
      fee: normalizeV3Fee(market),
      stockRoute: null,
    };
  }

  if (routeDescriptor.routeKind !== "STOCK_TWO_HOP" || routeDescriptor.quoteAssetType !== "STOCK_TOKEN") {
    throw new Error("Robinhood market route kind is unsupported.");
  }
  if (!stockEthRoutingEnabled(input.chainId)) {
    throw new Error("Robinhood Stock ETH routing is not enabled on mainnet yet.");
  }
  if (sameAddress(routeDescriptor.quoteTokenAddress, common.wrappedNativeAddress)) {
    throw new Error("Robinhood Stock route cannot use wrapped native as its quote asset.");
  }
  if (market.stockToken?.contractAddress && !sameAddress(market.stockToken.contractAddress, routeDescriptor.quoteTokenAddress)) {
    throw new Error("Robinhood Stock route registry token mismatch.");
  }
  if (market.stockToken && market.stockToken.enabledForTrading === false) {
    throw new Error("Robinhood Stock Token is not enabled for trading.");
  }

  const multiHopSwapAdapterAddress = normalizeAddress(
    envAddress("VITE_ROBINHOOD_V3_MULTI_HOP_SWAP_ADAPTER_ADDRESS", input.chainId),
    "Robinhood V3 Stock multi-hop swap adapter",
  );
  await Promise.all([
    requireCode(input.provider, routeDescriptor.quoteTokenAddress, "Robinhood Stock Token"),
    requireCode(input.provider, multiHopSwapAdapterAddress, "Robinhood V3 Stock multi-hop swap adapter"),
  ]);

  const adapter = new Contract(multiHopSwapAdapterAddress, MULTI_HOP_SWAP_ADAPTER_ABI, input.provider) as any;
  const [adapterFactory, adapterRouter, adapterWrapped, configuredRoute, health] = await Promise.all([
    adapter.v3Factory(),
    adapter.swapRouter(),
    adapter.wrappedNative(),
    adapter.marketRoutes(tokenAddress),
    adapter.routeHealth(tokenAddress),
  ]);
  if (!sameAddress(adapterFactory, common.factoryAddress)) throw new Error("Robinhood Stock adapter factory mismatch.");
  if (!sameAddress(adapterRouter, common.routerAddress)) throw new Error("Robinhood Stock adapter router mismatch.");
  if (!sameAddress(adapterWrapped, common.wrappedNativeAddress)) throw new Error("Robinhood Stock adapter wrapped-native mismatch.");

  const configuredStock = normalizeAddress(resultValue(configuredRoute, "stockToken", 0), "configured Robinhood Stock Token");
  const nativeStockFee = Number(resultValue(configuredRoute, "nativeStockFee", 1));
  const stockMemeFee = Number(resultValue(configuredRoute, "stockMemeFee", 2));
  const maxPriceImpactBps = Number(resultValue(configuredRoute, "maxPriceImpactBps", 3));
  const configuredEnabled = Boolean(resultValue(configuredRoute, "enabled", 4));
  if (!configuredEnabled) throw new Error("Robinhood Stock execution route is disabled.");
  if (!sameAddress(configuredStock, routeDescriptor.quoteTokenAddress)) {
    throw new Error("Robinhood Stock adapter quote asset mismatch.");
  }
  if (stockMemeFee !== normalizeV3Fee(market)) {
    throw new Error("Robinhood Stock adapter market fee tier mismatch.");
  }

  const healthConfigured = Boolean(resultValue(health, "configured", 0));
  const healthEnabled = Boolean(resultValue(health, "enabled", 1));
  const healthStock = normalizeAddress(resultValue(health, "stockToken", 2), "healthy Robinhood Stock Token");
  const nativeStockPoolAddress = normalizeAddress(resultValue(health, "nativeStockPool", 3), "Robinhood native/Stock pool");
  const stockMemePoolAddress = normalizeAddress(resultValue(health, "stockMemePool", 4), "Robinhood Stock/MEME pool");
  const poolsValid = Boolean(resultValue(health, "poolsValid", 5));
  if (!healthConfigured || !healthEnabled || !poolsValid) throw new Error("Robinhood Stock execution route is unhealthy.");
  if (!sameAddress(healthStock, routeDescriptor.quoteTokenAddress)) throw new Error("Robinhood Stock route health token mismatch.");
  if (!sameAddress(stockMemePoolAddress, common.poolAddress)) throw new Error("Robinhood Stock canonical market pool mismatch.");

  return {
    market,
    chainId: input.chainId,
    tokenAddress,
    poolAddress: common.poolAddress,
    routerAddress: common.routerAddress,
    factoryAddress: common.factoryAddress,
    wrappedNativeAddress: common.wrappedNativeAddress,
    quoteTokenAddress: routeDescriptor.quoteTokenAddress,
    quoteAssetType: "STOCK_TOKEN",
    routeKind: "STOCK_TWO_HOP",
    referenceOracleAddress: routeDescriptor.referenceOracleAddress,
    nativeSwapAdapterAddress: multiHopSwapAdapterAddress,
    executionAdapterAddress: multiHopSwapAdapterAddress,
    multiHopSwapAdapterAddress,
    fee: stockMemeFee,
    stockRoute: {
      stockTokenAddress: configuredStock,
      nativeStockPoolAddress,
      stockMemePoolAddress,
      nativeStockFee,
      stockMemeFee,
      maxPriceImpactBps,
    },
  };
}

async function quoteDirectExactInput(
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
    intermediateAmountOutRaw: null,
    minimumIntermediateOutRaw: null,
    firstLegPriceImpactBps: null,
    secondLegPriceImpactBps: null,
    quotedAt: null,
    slippageBps: validateSlippageBps(slippageBps),
    route,
  };
}

async function quoteStockTwoHop(
  provider: ethers.Provider,
  route: RobinhoodV3ResolvedRoute,
  amountInRaw: bigint,
  slippageBps: number,
  side: "buy" | "sell",
): Promise<RobinhoodV3Quote> {
  if (amountInRaw <= 0n) throw new Error("Enter an amount greater than zero.");
  if (!route.multiHopSwapAdapterAddress || !route.stockRoute) throw new Error("Robinhood Stock execution route is incomplete.");

  const adapter = new Contract(route.multiHopSwapAdapterAddress, MULTI_HOP_SWAP_ADAPTER_ABI, provider) as any;
  const quote = side === "buy"
    ? await adapter.quoteBuyWithNative(route.tokenAddress, amountInRaw)
    : await adapter.quoteSellForNative(route.tokenAddress, amountInRaw);
  const stockToken = normalizeAddress(resultValue(quote, "stockToken", 0), "quoted Robinhood Stock Token");
  const intermediateAmountOutRaw = resultBigInt(quote, "intermediateOut", 1);
  const amountOutRaw = resultBigInt(quote, "finalOut", 2);
  const firstLegPriceImpactBps = resultBigInt(quote, "firstLegPriceImpactBps", 3);
  const secondLegPriceImpactBps = resultBigInt(quote, "secondLegPriceImpactBps", 4);
  const quotedAt = resultBigInt(quote, "quotedAt", 5);
  if (!sameAddress(stockToken, route.quoteTokenAddress)) throw new Error("Robinhood Stock quote token mismatch.");
  if (intermediateAmountOutRaw <= 0n || amountOutRaw <= 0n) throw new Error("Robinhood Stock quote returned zero output.");

  return {
    amountInRaw,
    amountOutRaw,
    minimumOutRaw: minimumOut(amountOutRaw, slippageBps),
    intermediateAmountOutRaw,
    minimumIntermediateOutRaw: minimumOut(intermediateAmountOutRaw, slippageBps),
    firstLegPriceImpactBps,
    secondLegPriceImpactBps,
    quotedAt,
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
  return route.routeKind === "STOCK_TWO_HOP"
    ? quoteStockTwoHop(provider, route, nativeInRaw, slippageBps, "buy")
    : quoteDirectExactInput(provider, route, route.wrappedNativeAddress, route.tokenAddress, nativeInRaw, slippageBps);
}

export function quoteRobinhoodV3Sell(
  provider: ethers.Provider,
  route: RobinhoodV3ResolvedRoute,
  tokenInRaw: bigint,
  slippageBps: number,
) {
  return route.routeKind === "STOCK_TWO_HOP"
    ? quoteStockTwoHop(provider, route, tokenInRaw, slippageBps, "sell")
    : quoteDirectExactInput(provider, route, route.tokenAddress, route.wrappedNativeAddress, tokenInRaw, slippageBps);
}

export async function ensureRobinhoodV3SellAllowance(input: {
  signer: ethers.Signer;
  route: RobinhoodV3ResolvedRoute;
  amountInRaw: bigint;
}) {
  const owner = await input.signer.getAddress();
  const token = new Contract(input.route.tokenAddress, ERC20_ABI, input.signer) as any;
  const allowance = BigInt(await token.allowance(owner, input.route.executionAdapterAddress));
  if (allowance >= input.amountInRaw) return null;
  const tx = await token.approve(input.route.executionAdapterAddress, MAX_UINT256);
  await tx.wait();
  return tx;
}

async function executionDeadline(signer: ethers.Signer): Promise<bigint> {
  const block = await signer.provider?.getBlock("latest");
  const base = Number(block?.timestamp ?? Math.floor(Date.now() / 1000));
  return BigInt(base + TRADE_DEADLINE_SECONDS);
}

export async function executeRobinhoodV3Buy(input: {
  signer: ethers.Signer;
  quote: RobinhoodV3Quote;
  recipient?: string;
}) {
  const recipient = input.recipient || await input.signer.getAddress();
  if (input.quote.route.routeKind === "STOCK_TWO_HOP") {
    if (!input.quote.route.multiHopSwapAdapterAddress || input.quote.minimumIntermediateOutRaw == null) {
      throw new Error("Robinhood Stock buy route is incomplete.");
    }
    const adapter = new Contract(
      input.quote.route.multiHopSwapAdapterAddress,
      MULTI_HOP_SWAP_ADAPTER_ABI,
      input.signer,
    ) as any;
    return adapter.buyWithNative(
      input.quote.route.tokenAddress,
      input.quote.minimumIntermediateOutRaw,
      input.quote.minimumOutRaw,
      await executionDeadline(input.signer),
      recipient,
      { value: input.quote.amountInRaw },
    );
  }

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
  if (input.quote.route.routeKind === "STOCK_TWO_HOP") {
    if (!input.quote.route.multiHopSwapAdapterAddress || input.quote.minimumIntermediateOutRaw == null) {
      throw new Error("Robinhood Stock sell route is incomplete.");
    }
    const adapter = new Contract(
      input.quote.route.multiHopSwapAdapterAddress,
      MULTI_HOP_SWAP_ADAPTER_ABI,
      input.signer,
    ) as any;
    return adapter.sellForNative(
      input.quote.route.tokenAddress,
      input.quote.amountInRaw,
      input.quote.minimumIntermediateOutRaw,
      input.quote.minimumOutRaw,
      await executionDeadline(input.signer),
      recipient,
    );
  }

  const adapter = new Contract(input.quote.route.nativeSwapAdapterAddress, NATIVE_SWAP_ADAPTER_ABI, input.signer) as any;
  return adapter.sellExactTokenIn(
    input.quote.route.tokenAddress,
    input.quote.route.fee,
    input.quote.amountInRaw,
    input.quote.minimumOutRaw,
    recipient,
  );
}

export const robinhoodV3TradeInternals = {
  describeRobinhoodV3Route,
  normalizeQuoteAssetType,
  normalizeRouteKind,
  stockEthRoutingEnabled,
};

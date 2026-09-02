import { Contract, ethers } from "ethers";
import { createWorkingProvider, maskRpcUrl, parseRpcList } from "./rpcProvider.js";
import {
  getRobinhoodQuoteAssetPrice,
  getRobinhoodStockToken,
  type RobinhoodQuoteAssetPrice,
  type RobinhoodStockTokenRegistryEntry,
} from "./robinhoodStockTokenRegistry.js";

const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);
const SIMPLE_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn) view returns (uint256 amountOut)",
] as const;
const V3_POOL_IDENTITY_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
] as const;

export type RobinhoodStockAcquisitionPlan = {
  chainId: number;
  wrappedNativeAddress: string;
  stockTokenAddress: string;
  stockSymbol: string;
  poolAddress: string;
  quoterAddress: string;
  routerAddress: string | null;
  feeTier: number;
  quoteKind: "SIMPLE_EXACT_INPUT_SINGLE";
};

export type RobinhoodStockAcquisitionQuote = {
  ok: boolean;
  plan: RobinhoodStockAcquisitionPlan | null;
  amountInRaw: string;
  expectedQuoteOutRaw: string | null;
  minimumQuoteOutRaw: string | null;
  probeAmountInRaw: string | null;
  probeQuoteOutRaw: string | null;
  priceImpactBps: number | null;
  oracle: RobinhoodQuoteAssetPrice | null;
  rpc: string | null;
  quotedAt: string;
  deadline: string;
  failures: string[];
};

function normalizeAddress(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw || !ethers.isAddress(raw) || raw === ethers.ZeroAddress) return null;
  return ethers.getAddress(raw);
}

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function wrappedNativeForChain(chainId: number): string | null {
  if (chainId === 46630) return normalizeAddress(firstEnv("WRAPPED_NATIVE_ADDRESS_46630", "VITE_WRAPPED_NATIVE_ADDRESS_46630"));
  if (chainId === 4663) return normalizeAddress(firstEnv("WRAPPED_NATIVE_ADDRESS_4663", "VITE_WRAPPED_NATIVE_ADDRESS_4663"));
  return null;
}

function rpcUrlsForChain(chainId: number): string[] {
  if (chainId === 46630) return parseRpcList(firstEnv("ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_TESTNET_RPC_URL"));
  if (chainId === 4663) return parseRpcList(firstEnv("ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_MAINNET_RPC_URL"));
  return [];
}

function registryPlan(chainId: number, entry: RobinhoodStockTokenRegistryEntry): RobinhoodStockAcquisitionPlan | null {
  const wrappedNativeAddress = wrappedNativeForChain(chainId);
  const stockTokenAddress = normalizeAddress(entry.contractAddress);
  const poolAddress = normalizeAddress(entry.acquisitionPoolAddress);
  const quoterAddress = normalizeAddress(entry.acquisitionQuoterAddress);
  const routerAddress = normalizeAddress(entry.acquisitionRouterAddress);
  const feeTier = Number(entry.acquisitionFeeTier || 0);
  if (
    !wrappedNativeAddress ||
    !stockTokenAddress ||
    !poolAddress ||
    !quoterAddress ||
    !Number.isInteger(feeTier) ||
    feeTier <= 0 ||
    feeTier > 1_000_000 ||
    entry.acquisitionQuoteKind !== "SIMPLE_EXACT_INPUT_SINGLE"
  ) {
    return null;
  }
  return {
    chainId,
    wrappedNativeAddress,
    stockTokenAddress,
    stockSymbol: entry.symbol,
    poolAddress,
    quoterAddress,
    routerAddress,
    feeTier,
    quoteKind: "SIMPLE_EXACT_INPUT_SINGLE",
  };
}

export function buildRobinhoodStockAcquisitionPlan(chainId: number, stockTokenAddress: string): {
  plan: RobinhoodStockAcquisitionPlan | null;
  stockToken: RobinhoodStockTokenRegistryEntry | null;
  failures: string[];
} {
  const failures: string[] = [];
  if (!ROBINHOOD_CHAIN_IDS.has(Number(chainId))) failures.push("UNSUPPORTED_ROBINHOOD_CHAIN");
  const stockToken = getRobinhoodStockToken(chainId, stockTokenAddress);
  if (!stockToken) failures.push("STOCK_TOKEN_NOT_REGISTERED");
  if (stockToken && !stockToken.canonical) failures.push("STOCK_TOKEN_NOT_CANONICAL");
  if (stockToken && !stockToken.enabledForGraduation) failures.push("STOCK_TOKEN_GRADUATION_DISABLED");
  if (stockToken && String(stockToken.marketStatus || "").toLowerCase() !== "active") failures.push("STOCK_TOKEN_MARKET_INACTIVE");
  const plan = stockToken ? registryPlan(chainId, stockToken) : null;
  if (stockToken && !plan) failures.push("ACQUISITION_VENUE_INCOMPLETE");
  return { plan: failures.length === 0 ? plan : null, stockToken, failures };
}

export function calculateAcquisitionPriceImpactBps(input: {
  amountInRaw: bigint;
  amountOutRaw: bigint;
  probeAmountInRaw: bigint;
  probeAmountOutRaw: bigint;
}): number | null {
  const { amountInRaw, amountOutRaw, probeAmountInRaw, probeAmountOutRaw } = input;
  if (amountInRaw <= 0n || amountOutRaw <= 0n || probeAmountInRaw <= 0n || probeAmountOutRaw <= 0n) return null;
  const expectedAtProbeRate = (probeAmountOutRaw * amountInRaw) / probeAmountInRaw;
  if (expectedAtProbeRate <= 0n) return null;
  if (amountOutRaw >= expectedAtProbeRate) return 0;
  const lost = expectedAtProbeRate - amountOutRaw;
  return Number((lost * 10_000n) / expectedAtProbeRate);
}

export function minimumOutForSlippage(expectedOutRaw: bigint, slippageBps: number): bigint | null {
  if (expectedOutRaw <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) return null;
  return (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
}

async function verifyAcquisitionPool(provider: ethers.Provider, plan: RobinhoodStockAcquisitionPlan): Promise<boolean> {
  const code = await provider.getCode(plan.poolAddress);
  if (!code || code === "0x") return false;
  const pool = new Contract(plan.poolAddress, V3_POOL_IDENTITY_ABI, provider) as any;
  const [token0Raw, token1Raw, feeRaw] = await Promise.all([pool.token0(), pool.token1(), pool.fee()]);
  const token0 = normalizeAddress(token0Raw);
  const token1 = normalizeAddress(token1Raw);
  const fee = Number(feeRaw);
  const pairMatches =
    (token0 === plan.wrappedNativeAddress && token1 === plan.stockTokenAddress) ||
    (token1 === plan.wrappedNativeAddress && token0 === plan.stockTokenAddress);
  return pairMatches && fee === plan.feeTier;
}

export async function quoteRobinhoodStockAcquisition(input: {
  chainId: number;
  stockTokenAddress: string;
  amountInRaw: bigint;
  slippageBps: number;
  probeBps?: number;
  deadlineSeconds?: number;
}): Promise<RobinhoodStockAcquisitionQuote> {
  const nowMs = Date.now();
  const deadlineSeconds = Math.max(1, Number(input.deadlineSeconds || 60));
  const base = {
    amountInRaw: input.amountInRaw.toString(),
    quotedAt: new Date(nowMs).toISOString(),
    deadline: new Date(nowMs + deadlineSeconds * 1000).toISOString(),
  };
  const built = buildRobinhoodStockAcquisitionPlan(input.chainId, input.stockTokenAddress);
  const failures = [...built.failures];
  if (input.amountInRaw <= 0n) failures.push("INVALID_ACQUISITION_INPUT");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 10_000) failures.push("INVALID_SLIPPAGE_BPS");
  if (!built.plan || failures.length) {
    return { ok: false, plan: built.plan, ...base, expectedQuoteOutRaw: null, minimumQuoteOutRaw: null, probeAmountInRaw: null, probeQuoteOutRaw: null, priceImpactBps: null, oracle: null, rpc: null, failures };
  }

  const rpcUrls = rpcUrlsForChain(input.chainId);
  if (!rpcUrls.length) failures.push("ROBINHOOD_RPC_NOT_CONFIGURED");
  let provider: ethers.JsonRpcProvider | null = null;
  try {
    if (failures.length) throw new Error(failures[0]);
    const selected = await createWorkingProvider(rpcUrls, input.chainId, { label: `robinhood-stock-acquisition-${input.chainId}`, timeoutMs: 8_000 });
    provider = selected.provider;
    const poolVerified = await verifyAcquisitionPool(provider, built.plan);
    if (!poolVerified) failures.push("ACQUISITION_POOL_UNVERIFIED");
    const quoterCode = await provider.getCode(built.plan.quoterAddress);
    if (!quoterCode || quoterCode === "0x") failures.push("ACQUISITION_QUOTER_UNAVAILABLE");
    if (failures.length) throw new Error(failures[0]);

    const quoter = new Contract(built.plan.quoterAddress, SIMPLE_QUOTER_ABI, provider) as any;
    const probeBps = Math.max(1, Math.min(1_000, Number(input.probeBps || 100)));
    const probeAmountInRaw = input.amountInRaw > 1n ? ((input.amountInRaw * BigInt(probeBps)) / 10_000n || 1n) : 1n;
    const [amountOutRawValue, probeOutRawValue, oracle] = await Promise.all([
      quoter.quoteExactInputSingle(built.plan.wrappedNativeAddress, built.plan.stockTokenAddress, built.plan.feeTier, input.amountInRaw),
      quoter.quoteExactInputSingle(built.plan.wrappedNativeAddress, built.plan.stockTokenAddress, built.plan.feeTier, probeAmountInRaw),
      getRobinhoodQuoteAssetPrice({ chainId: input.chainId, quoteToken: built.plan.stockTokenAddress }),
    ]);
    const amountOutRaw = BigInt(amountOutRawValue);
    const probeQuoteOutRaw = BigInt(probeOutRawValue);
    const minimumQuoteOutRaw = minimumOutForSlippage(amountOutRaw, input.slippageBps);
    const priceImpactBps = calculateAcquisitionPriceImpactBps({
      amountInRaw: input.amountInRaw,
      amountOutRaw,
      probeAmountInRaw,
      probeAmountOutRaw: probeQuoteOutRaw,
    });
    if (amountOutRaw <= 0n) failures.push("ZERO_ACQUISITION_QUOTE");
    if (minimumQuoteOutRaw == null || minimumQuoteOutRaw <= 0n) failures.push("INVALID_MINIMUM_QUOTE_OUT");
    if (priceImpactBps == null) failures.push("PRICE_IMPACT_UNAVAILABLE");
    if (!oracle.healthy) failures.push("STOCK_ORACLE_UNHEALTHY");

    return {
      ok: failures.length === 0,
      plan: built.plan,
      ...base,
      expectedQuoteOutRaw: amountOutRaw.toString(),
      minimumQuoteOutRaw: minimumQuoteOutRaw?.toString() || null,
      probeAmountInRaw: probeAmountInRaw.toString(),
      probeQuoteOutRaw: probeQuoteOutRaw.toString(),
      priceImpactBps,
      oracle,
      rpc: maskRpcUrl(selected.url),
      failures,
    };
  } catch (error: any) {
    if (!failures.length) failures.push("ACQUISITION_QUOTE_FAILED");
    return { ok: false, plan: built.plan, ...base, expectedQuoteOutRaw: null, minimumQuoteOutRaw: null, probeAmountInRaw: null, probeQuoteOutRaw: null, priceImpactBps: null, oracle: null, rpc: null, failures: [...new Set(failures)], };
  } finally {
    try { provider?.destroy(); } catch { /* noop */ }
  }
}

export const robinhoodStockAcquisitionQuoteInternals = {
  normalizeAddress,
  wrappedNativeForChain,
  registryPlan,
  calculateAcquisitionPriceImpactBps,
  minimumOutForSlippage,
};

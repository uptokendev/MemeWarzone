import { Contract, ethers } from "ethers";
import { createWorkingProvider, parseRpcList } from "./rpcProvider.js";

const AGGREGATOR_V3_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
] as const;

const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);
const DEFAULT_MAX_ORACLE_AGE_SECONDS = 15 * 60;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export type RobinhoodQuoteAssetType = "WRAPPED_NATIVE" | "STOCK_TOKEN" | "UNKNOWN";
export type RobinhoodRouteKind = "DIRECT_NATIVE" | "STOCK_TWO_HOP" | "UNKNOWN";
export type RobinhoodStockAcquisitionQuoteKind = "SIMPLE_EXACT_INPUT_SINGLE" | "UNKNOWN";

export type RobinhoodStockTokenRegistryEntry = {
  chainId: number;
  contractAddress: string;
  symbol: string;
  displayName: string;
  underlyingSymbol: string;
  decimals: number | null;
  uiMultiplierSupported: boolean;
  oracleFeedAddress: string | null;
  oracleType: string;
  canonical: boolean;
  enabledForDiscovery: boolean;
  enabledForGraduation: boolean;
  enabledForTrading: boolean;
  minimumQuoteLiquidityUsd: number | null;
  maximumGraduationSwapImpactBps: number | null;
  acquisitionPoolAddress: string | null;
  acquisitionQuoterAddress: string | null;
  acquisitionRouterAddress: string | null;
  acquisitionFeeTier: number | null;
  acquisitionQuoteKind: RobinhoodStockAcquisitionQuoteKind;
  marketStatus: string;
  lastVerifiedAt: string | null;
  metadataSource: string;
};

export type RobinhoodQuoteAssetDescriptor = {
  quoteTokenAddress: string | null;
  quoteAssetType: RobinhoodQuoteAssetType;
  routeKind: RobinhoodRouteKind;
  referenceOracle: string | null;
  stockToken: RobinhoodStockTokenRegistryEntry | null;
};

export type RobinhoodQuoteAssetPrice = {
  priceUsd: string | null;
  updatedAt: string | null;
  roundId: string | null;
  source: string | null;
  healthy: boolean;
  error: string | null;
};

type RegistryInput = Record<string, unknown>;

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeAddress(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw || !ethers.isAddress(raw) || raw === ethers.ZeroAddress) return null;
  return ethers.getAddress(raw);
}

function sameAddress(a: unknown, b: unknown): boolean {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);
  return Boolean(left && right && left === right);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  if (typeof value === "boolean") return value;
  return fallback;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalInteger(value: unknown): number | null {
  const parsed = parseOptionalNumber(value);
  return parsed != null && Number.isInteger(parsed) ? parsed : null;
}

function parseAcquisitionQuoteKind(value: unknown): RobinhoodStockAcquisitionQuoteKind {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "SIMPLE_EXACT_INPUT_SINGLE" ? "SIMPLE_EXACT_INPUT_SINGLE" : "UNKNOWN";
}

function registryEnvKey(chainId: number): string {
  if (chainId === 46630) return "ROBINHOOD_STOCK_TOKEN_REGISTRY_46630";
  if (chainId === 4663) return "ROBINHOOD_STOCK_TOKEN_REGISTRY_4663";
  throw new Error(`Unsupported Robinhood stock registry chainId ${chainId}`);
}

function rpcEnvValue(chainId: number): string {
  if (chainId === 46630) {
    return firstEnv("ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_TESTNET_RPC_URL");
  }
  if (chainId === 4663) {
    return firstEnv("ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_MAINNET_RPC_URL");
  }
  return "";
}

function maxOracleAgeSeconds(): number {
  const parsed = Number(process.env.ROBINHOOD_STOCK_MAX_ORACLE_AGE_SECONDS || DEFAULT_MAX_ORACLE_AGE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ORACLE_AGE_SECONDS;
}

function normalizeRegistryEntry(chainId: number, input: RegistryInput, metadataSource: string): RobinhoodStockTokenRegistryEntry | null {
  const entryChainId = Number(input.chainId ?? chainId);
  if (!Number.isInteger(entryChainId) || entryChainId !== chainId) return null;

  const contractAddress = normalizeAddress(input.contractAddress || input.address || input.tokenAddress);
  if (!contractAddress) throw new Error(`${metadataSource}: contractAddress is missing or invalid`);

  const symbol = String(input.symbol || input.underlyingSymbol || "").trim().toUpperCase();
  if (!symbol) throw new Error(`${metadataSource}: symbol is missing for ${contractAddress}`);

  const displayName = String(input.displayName || input.name || symbol).trim() || symbol;
  const underlyingSymbol = String(input.underlyingSymbol || symbol).trim().toUpperCase() || symbol;
  const oracleFeedAddress = normalizeAddress(input.oracleFeedAddress || input.oracleAddress || input.priceFeedAddress);
  const oracleType = String(input.oracleType || "chainlink").trim().toLowerCase() || "chainlink";
  const acquisitionFeeTier = parseOptionalInteger(input.acquisitionFeeTier ?? input.acquisitionFeePpm);
  if (acquisitionFeeTier != null && (acquisitionFeeTier <= 0 || acquisitionFeeTier > 1_000_000)) {
    throw new Error(`${metadataSource}: acquisitionFeeTier is invalid`);
  }

  return {
    chainId,
    contractAddress,
    symbol,
    displayName,
    underlyingSymbol,
    decimals: parseOptionalInteger(input.decimals),
    uiMultiplierSupported: parseBoolean(input.uiMultiplierSupported, true),
    oracleFeedAddress,
    oracleType,
    canonical: parseBoolean(input.canonical, true),
    enabledForDiscovery: parseBoolean(input.enabledForDiscovery, true),
    enabledForGraduation: parseBoolean(input.enabledForGraduation, false),
    enabledForTrading: parseBoolean(input.enabledForTrading, false),
    minimumQuoteLiquidityUsd: parseOptionalNumber(input.minimumQuoteLiquidityUsd),
    maximumGraduationSwapImpactBps: parseOptionalNumber(input.maximumGraduationSwapImpactBps),
    acquisitionPoolAddress: normalizeAddress(input.acquisitionPoolAddress),
    acquisitionQuoterAddress: normalizeAddress(input.acquisitionQuoterAddress),
    acquisitionRouterAddress: normalizeAddress(input.acquisitionRouterAddress),
    acquisitionFeeTier,
    acquisitionQuoteKind: parseAcquisitionQuoteKind(input.acquisitionQuoteKind),
    marketStatus: String(input.marketStatus || "active").trim().toLowerCase() || "active",
    lastVerifiedAt: String(input.lastVerifiedAt || "").trim() || null,
    metadataSource: String(input.metadataSource || metadataSource).trim() || metadataSource,
  };
}

function parseRegistryEntries(chainId: number, raw: string, metadataSource: string): RobinhoodStockTokenRegistryEntry[] {
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${metadataSource} must be a JSON array`);
  }
  return parsed
    .map((item, index) => normalizeRegistryEntry(chainId, (item || {}) as RegistryInput, `${metadataSource}[${index}]`))
    .filter((item): item is RobinhoodStockTokenRegistryEntry => Boolean(item))
    .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.contractAddress.localeCompare(right.contractAddress));
}

export function listRobinhoodStockTokens(chainId: number, options?: { includeDisabled?: boolean }): RobinhoodStockTokenRegistryEntry[] {
  if (!ROBINHOOD_CHAIN_IDS.has(Number(chainId))) return [];
  const envKey = registryEnvKey(chainId);
  const entries = parseRegistryEntries(chainId, firstEnv(envKey, `VITE_${envKey}`), envKey);
  if (options?.includeDisabled) return entries;
  return entries.filter((item) => item.enabledForDiscovery || item.enabledForGraduation || item.enabledForTrading);
}

export function getRobinhoodStockToken(chainId: number, address: string): RobinhoodStockTokenRegistryEntry | null {
  const target = normalizeAddress(address);
  if (!target) return null;
  return listRobinhoodStockTokens(chainId, { includeDisabled: true }).find((item) => item.contractAddress === target) || null;
}

export function describeRobinhoodQuoteAsset(input: {
  chainId: number;
  quoteToken?: string | null;
  wrappedNativeAddress?: string | null;
}): RobinhoodQuoteAssetDescriptor {
  const quoteTokenAddress = normalizeAddress(input.quoteToken);
  const wrappedNativeAddress = normalizeAddress(input.wrappedNativeAddress);
  if (!quoteTokenAddress) {
    return {
      quoteTokenAddress: null,
      quoteAssetType: "UNKNOWN",
      routeKind: "UNKNOWN",
      referenceOracle: null,
      stockToken: null,
    };
  }
  if (wrappedNativeAddress && quoteTokenAddress === wrappedNativeAddress) {
    return {
      quoteTokenAddress,
      quoteAssetType: "WRAPPED_NATIVE",
      routeKind: "DIRECT_NATIVE",
      referenceOracle: null,
      stockToken: null,
    };
  }
  const stockToken = getRobinhoodStockToken(input.chainId, quoteTokenAddress);
  if (stockToken) {
    return {
      quoteTokenAddress,
      quoteAssetType: "STOCK_TOKEN",
      routeKind: "STOCK_TWO_HOP",
      referenceOracle: stockToken.oracleFeedAddress,
      stockToken,
    };
  }
  return {
    quoteTokenAddress,
    quoteAssetType: "UNKNOWN",
    routeKind: "UNKNOWN",
    referenceOracle: null,
    stockToken: null,
  };
}

export async function getRobinhoodQuoteAssetPrice(input: {
  chainId: number;
  quoteToken: string;
  maxOracleAgeSeconds?: number;
}): Promise<RobinhoodQuoteAssetPrice> {
  const descriptor = describeRobinhoodQuoteAsset({ chainId: input.chainId, quoteToken: input.quoteToken });
  if (!descriptor.stockToken) {
    return {
      priceUsd: null,
      updatedAt: null,
      roundId: null,
      source: null,
      healthy: false,
      error: "Quote asset is not a registered Robinhood stock token.",
    };
  }
  if (!descriptor.referenceOracle) {
    return {
      priceUsd: null,
      updatedAt: null,
      roundId: null,
      source: descriptor.stockToken.oracleType,
      healthy: false,
      error: "Stock token oracle is not configured.",
    };
  }

  const rpcUrls = parseRpcList(rpcEnvValue(input.chainId));
  let provider: ethers.JsonRpcProvider | null = null;
  try {
    const connection = await createWorkingProvider(rpcUrls, input.chainId, {
      label: `robinhood-stock-${input.chainId}`,
      timeoutMs: 8_000,
    });
    provider = connection.provider;
    const feed = new Contract(descriptor.referenceOracle, AGGREGATOR_V3_ABI, provider) as any;
    const [latest, decimalsRaw] = await Promise.all([feed.latestRoundData(), feed.decimals()]);

    const decimals = Number(decimalsRaw);
    const roundId = BigInt(latest.roundId);
    const answeredInRound = BigInt(latest.answeredInRound);
    const answer = BigInt(latest.answer);
    const updatedAtSeconds = Number(latest.updatedAt || 0);
    const ageLimit = Math.max(1, Number(input.maxOracleAgeSeconds ?? maxOracleAgeSeconds()));
    const ageSeconds = updatedAtSeconds > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - updatedAtSeconds) : Number.POSITIVE_INFINITY;
    const healthy =
      answer > 0n &&
      Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 &&
      updatedAtSeconds > 0 &&
      answeredInRound >= roundId &&
      ageSeconds <= ageLimit;

    return {
      priceUsd: answer > 0n && Number.isInteger(decimals) && decimals >= 0 ? ethers.formatUnits(answer, decimals) : null,
      updatedAt: updatedAtSeconds > 0 ? new Date(updatedAtSeconds * 1000).toISOString() : null,
      roundId: roundId > 0n ? roundId.toString() : null,
      source: descriptor.stockToken.oracleType,
      healthy,
      error: healthy
        ? null
        : answer <= 0n
          ? "Stock token oracle returned a non-positive price."
          : updatedAtSeconds <= 0
            ? "Stock token oracle did not return an update time."
            : answeredInRound < roundId
              ? "Stock token oracle answeredInRound is stale."
              : ageSeconds > ageLimit
                ? `Stock token oracle is stale (${ageSeconds}s old).`
                : "Stock token oracle metadata is invalid.",
    };
  } catch (error: any) {
    return {
      priceUsd: null,
      updatedAt: null,
      roundId: null,
      source: descriptor.stockToken.oracleType,
      healthy: false,
      error: error?.message || String(error),
    };
  } finally {
    try {
      provider?.destroy();
    } catch {
      // ignore provider teardown failures
    }
  }
}

export const robinhoodStockRegistryInternals = {
  normalizeAddress,
  sameAddress,
  parseRegistryEntries,
  normalizeRegistryEntry,
  parseAcquisitionQuoteKind,
};

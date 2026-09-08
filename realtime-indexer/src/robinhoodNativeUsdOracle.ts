import { Contract, ethers } from "ethers";
import { createWorkingProvider, maskRpcUrl, parseRpcList } from "./rpcProvider.js";

const AGGREGATOR_V3_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
] as const;

export type RobinhoodNativeUsdReference = {
  chainId: number;
  priceUsd: string | null;
  updatedAt: string | null;
  roundId: string | null;
  oracleFeedAddress: string | null;
  source: "chainlink" | null;
  healthy: boolean;
  rpc: string | null;
  error: string | null;
};

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

function feedForChain(chainId: number): string | null {
  if (chainId === 46630) {
    return normalizeAddress(firstEnv("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630", "VITE_ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630"));
  }
  if (chainId === 4663) {
    return normalizeAddress(firstEnv("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_4663", "VITE_ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_4663"));
  }
  return null;
}

function rpcUrlsForChain(chainId: number): string[] {
  if (chainId === 46630) return parseRpcList(firstEnv("ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_TESTNET_RPC_URL"));
  if (chainId === 4663) return parseRpcList(firstEnv("ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_MAINNET_RPC_URL"));
  return [];
}

function maxAgeSeconds(): number {
  const value = Number(process.env.ROBINHOOD_NATIVE_USD_MAX_ORACLE_AGE_SECONDS || process.env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_AGE_SECONDS || 900);
  return Number.isFinite(value) && value > 0 ? value : 900;
}

export function evaluateNativeUsdRound(input: {
  nowSeconds: number;
  roundId: bigint;
  answeredInRound: bigint;
  answer: bigint;
  updatedAtSeconds: number;
  decimals: number;
  maxAgeSeconds: number;
}): { healthy: boolean; priceUsd: string | null; updatedAt: string | null; error: string | null } {
  const ageSeconds = input.updatedAtSeconds > 0 ? Math.max(0, Math.floor(input.nowSeconds - input.updatedAtSeconds)) : Number.POSITIVE_INFINITY;
  const decimalsValid = Number.isInteger(input.decimals) && input.decimals >= 0 && input.decimals <= 36;
  const healthy =
    input.answer > 0n &&
    input.roundId > 0n &&
    input.answeredInRound >= input.roundId &&
    input.updatedAtSeconds > 0 &&
    decimalsValid &&
    ageSeconds <= input.maxAgeSeconds;
  const priceUsd = input.answer > 0n && decimalsValid ? ethers.formatUnits(input.answer, input.decimals) : null;
  const updatedAt = input.updatedAtSeconds > 0 ? new Date(input.updatedAtSeconds * 1000).toISOString() : null;
  const error = healthy
    ? null
    : input.answer <= 0n
      ? "Robinhood native USD oracle returned a non-positive price."
      : input.roundId <= 0n
        ? "Robinhood native USD oracle returned an invalid round."
        : input.answeredInRound < input.roundId
          ? "Robinhood native USD oracle answeredInRound is stale."
          : input.updatedAtSeconds <= 0
            ? "Robinhood native USD oracle did not return an update time."
            : !decimalsValid
              ? "Robinhood native USD oracle decimals are invalid."
              : ageSeconds > input.maxAgeSeconds
                ? `Robinhood native USD oracle is stale (${ageSeconds}s old).`
                : "Robinhood native USD oracle metadata is invalid.";
  return { healthy, priceUsd, updatedAt, error };
}

export async function getRobinhoodNativeUsdReference(chainId: number): Promise<RobinhoodNativeUsdReference> {
  const oracleFeedAddress = feedForChain(chainId);
  if (chainId !== 4663 && chainId !== 46630) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: null, healthy: false, rpc: null, error: "Unsupported Robinhood chain." };
  }
  if (!oracleFeedAddress) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress: null, source: null, healthy: false, rpc: null, error: "Robinhood native USD oracle is not configured." };
  }
  const rpcUrls = rpcUrlsForChain(chainId);
  if (!rpcUrls.length) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: "chainlink", healthy: false, rpc: null, error: "Robinhood RPC is not configured." };
  }

  let provider: ethers.JsonRpcProvider | null = null;
  try {
    const selected = await createWorkingProvider(rpcUrls, chainId, { label: `robinhood-native-usd-${chainId}`, timeoutMs: 8_000 });
    provider = selected.provider;
    const code = await provider.getCode(oracleFeedAddress);
    if (!code || code === "0x") {
      return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: "chainlink", healthy: false, rpc: maskRpcUrl(selected.url), error: "Robinhood native USD oracle has no bytecode." };
    }
    const feed = new Contract(oracleFeedAddress, AGGREGATOR_V3_ABI, provider) as any;
    const [latest, decimalsRaw] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
    const roundId = BigInt(latest.roundId);
    const evaluated = evaluateNativeUsdRound({
      nowSeconds: Math.floor(Date.now() / 1000),
      roundId,
      answeredInRound: BigInt(latest.answeredInRound),
      answer: BigInt(latest.answer),
      updatedAtSeconds: Number(latest.updatedAt || 0),
      decimals: Number(decimalsRaw),
      maxAgeSeconds: maxAgeSeconds(),
    });
    return {
      chainId,
      priceUsd: evaluated.priceUsd,
      updatedAt: evaluated.updatedAt,
      roundId: roundId > 0n ? roundId.toString() : null,
      oracleFeedAddress,
      source: "chainlink",
      healthy: evaluated.healthy,
      rpc: maskRpcUrl(selected.url),
      error: evaluated.error,
    };
  } catch (error: any) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: "chainlink", healthy: false, rpc: null, error: error?.message || String(error) };
  } finally {
    try { provider?.destroy(); } catch { /* noop */ }
  }
}

export const robinhoodNativeUsdOracleInternals = {
  normalizeAddress,
  feedForChain,
  maxAgeSeconds,
};

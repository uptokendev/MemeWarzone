import { Contract, ethers } from "ethers";
import { DOGEOS_TESTNET_CHAIN_ID } from "./evmIndexerChains.js";
import { createWorkingProvider, maskRpcUrl, parseRpcList } from "./rpcProvider.js";

/**
 * DOGE/USD reference for DogeOS Chikyu testnet (6281971).
 *
 * A sibling of robinhoodNativeUsdOracle.ts with the same AggregatorV3 read/evaluate shape. That module
 * is gated to 4663/46630 and stays untouched; DogeOS reads its own testnet oracle (pushed by the
 * DOGE/USD push worker) over the DogeOS RPC only, never a BSC or Robinhood one. The on-chain
 * graduation path treats a round older than 3600 s as stale, so this reader uses the same limit.
 */

const DOGEOS_CHAIN_ID = DOGEOS_TESTNET_CHAIN_ID;
const MAX_AGE_SECONDS = 3600;

const AGGREGATOR_V3_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
] as const;

export type DogeosNativeUsdReference = {
  chainId: number;
  priceUsd: string | null;
  updatedAt: string | null;
  roundId: string | null;
  oracleFeedAddress: string | null;
  source: "aggregator_v3" | null;
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

function feedAddress(): string | null {
  return normalizeAddress(firstEnv("DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971"));
}

function rpcUrls(): string[] {
  return parseRpcList(firstEnv("DOGEOS_RPC_HTTP_6281971"));
}

export function evaluateDogeosNativeUsdRound(input: {
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
      ? "DogeOS native USD oracle returned a non-positive price."
      : input.roundId <= 0n
        ? "DogeOS native USD oracle returned an invalid round."
        : input.answeredInRound < input.roundId
          ? "DogeOS native USD oracle answeredInRound is stale."
          : input.updatedAtSeconds <= 0
            ? "DogeOS native USD oracle did not return an update time."
            : !decimalsValid
              ? "DogeOS native USD oracle decimals are invalid."
              : ageSeconds > input.maxAgeSeconds
                ? `DogeOS native USD oracle is stale (${ageSeconds}s old).`
                : "DogeOS native USD oracle metadata is invalid.";
  return { healthy, priceUsd, updatedAt, error };
}

export async function getDogeosNativeUsdReference(chainId: number): Promise<DogeosNativeUsdReference> {
  const oracleFeedAddress = chainId === DOGEOS_CHAIN_ID ? feedAddress() : null;
  if (chainId !== DOGEOS_CHAIN_ID) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress: null, source: null, healthy: false, rpc: null, error: "Unsupported DogeOS chain." };
  }
  if (!oracleFeedAddress) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress: null, source: null, healthy: false, rpc: null, error: "DogeOS native USD oracle is not configured." };
  }
  const urls = rpcUrls();
  if (!urls.length) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: "aggregator_v3", healthy: false, rpc: null, error: "DogeOS RPC is not configured." };
  }

  let provider: ethers.JsonRpcProvider | null = null;
  try {
    const selected = await createWorkingProvider(urls, chainId, { label: `dogeos-native-usd-${chainId}`, timeoutMs: 8_000 });
    provider = selected.provider;
    const code = await provider.getCode(oracleFeedAddress);
    if (!code || code === "0x") {
      return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: "aggregator_v3", healthy: false, rpc: maskRpcUrl(selected.url), error: "DogeOS native USD oracle has no bytecode." };
    }
    const feed = new Contract(oracleFeedAddress, AGGREGATOR_V3_ABI, provider) as any;
    const [latest, decimalsRaw] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
    const roundId = BigInt(latest.roundId);
    const evaluated = evaluateDogeosNativeUsdRound({
      nowSeconds: Math.floor(Date.now() / 1000),
      roundId,
      answeredInRound: BigInt(latest.answeredInRound),
      answer: BigInt(latest.answer),
      updatedAtSeconds: Number(latest.updatedAt || 0),
      decimals: Number(decimalsRaw),
      maxAgeSeconds: MAX_AGE_SECONDS,
    });
    return {
      chainId,
      priceUsd: evaluated.priceUsd,
      updatedAt: evaluated.updatedAt,
      roundId: roundId > 0n ? roundId.toString() : null,
      oracleFeedAddress,
      source: "aggregator_v3",
      healthy: evaluated.healthy,
      rpc: maskRpcUrl(selected.url),
      error: evaluated.error,
    };
  } catch (error: any) {
    return { chainId, priceUsd: null, updatedAt: null, roundId: null, oracleFeedAddress, source: "aggregator_v3", healthy: false, rpc: null, error: error?.message || String(error) };
  } finally {
    try { provider?.destroy(); } catch { /* noop */ }
  }
}

export const dogeosNativeUsdOracleInternals = {
  DOGEOS_CHAIN_ID,
  MAX_AGE_SECONDS,
  normalizeAddress,
  feedAddress,
  rpcUrls,
};

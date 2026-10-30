import { isDogeosChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import {
  barkLaunchCalldataBytes,
  createDogeosReserveCache,
  dogeosReserveFloorWei,
  estimateDogeosReserveWei,
  formatDogeReserve,
} from "../../shared/dogeosGasReserve.mjs";

/**
 * The live DOGE reserve for a DogeOS buy or launch (barkswap plan t34, founder decision A 2026-10-17):
 * max(floor, (L1GasPriceOracle.getL1Fee + gas limit x gas price) x 1.5), read on the chain's read provider and reused
 * for 30 s; the floor (0.05 DOGE buy, 0.2 DOGE launch) when the read fails. Off DogeOS everything here returns null and
 * reads nothing, so the caller keeps its own reserve exactly as before. The rules: shared/dogeosGasReserve.mjs.
 */
export type DogeosReserveKind = "buy" | "launch";

/** The launch's on-chain strings (MwzBarkLauncher.launch request); a field left out is priced at the rehearsal's. */
export type DogeosLaunchStrings = Partial<Record<"name" | "symbol" | "logoURI" | "xAccount" | "website" | "extraLink", string>>;

let cache = createDogeosReserveCache();

/** Forgets every cached live estimate (tests). */
export function clearDogeosGasReserveCache() {
  cache = createDogeosReserveCache();
}

/** The DogeOS floor for this kind; null off DogeOS. */
export function dogeosGasReserveFloorWei(chainId: number, kind: DogeosReserveKind): bigint | null {
  return isDogeosChainId(chainId) ? (dogeosReserveFloorWei(kind) as bigint) : null;
}

/**
 * The live reserve; null off DogeOS. `provider` defaults to getReadProvider(chainId), as the trade path reads. A launch
 * with `launchStrings` is priced at its own calldata size, else at the rehearsal's launch. Never throws.
 */
export async function dogeosLiveGasReserveWei(input: {
  chainId: number;
  kind: DogeosReserveKind;
  provider?: unknown;
  launchStrings?: DogeosLaunchStrings | null;
}): Promise<bigint | null> {
  const { chainId, kind } = input;
  if (!isDogeosChainId(chainId)) return null;
  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = getReadProvider(chainId as SupportedChainId);
    } catch {
      provider = null;
    }
  }
  try {
    const calldataBytes = kind === "launch" && input.launchStrings ? barkLaunchCalldataBytes(input.launchStrings) : null;
    return (await estimateDogeosReserveWei({ provider, chainId, kind, calldataBytes, cache })) as bigint;
  } catch {
    // e.g. a DogeOS chain without an oracle entry yet: the floor
    return dogeosReserveFloorWei(kind) as bigint;
  }
}

/** A reserve as DOGE for a message, rounded up to 0.01 ("0.06", "0.2"). */
export function formatDogeosReserve(wei: bigint): string {
  return formatDogeReserve(wei) as string;
}

/** The buy's balance message on DogeOS: the amount kept back for network fees. */
export function dogeosBuyReserveMessage(reserveWei: bigint, symbol: string): string {
  const amount = formatDogeosReserve(reserveWei);
  return `Not enough ${symbol}. Keep about ${amount} ${symbol} for network fees.`;
}

/**
 * Post-graduation handoff for the EVM launch generation (campaign generation 5). The old generation
 * hands off from `CampaignFinalized` and reads its DEX from `campaign.router()`; generation 5 has
 * neither. Its handoff is driven by `Graduated(pool, ...)` and the campaign's own graduation binding:
 *
 *   - pool:  Graduated.pool, confirmed by getGraduationState().dexPair
 *   - quote: graduationQuoteToken() for a quote/stock coin, WBNB/WETH for a native coin or after the
 *            E12 native fallback (nativeFallback() == true)
 *   - DEX:   BNB 56/97: the Topaz volatile pool, factory from the adapter (BnbNativeGraduationAdapter /
 *            BnbQuoteGraduationAdapter: topazFactory(), WBNB(), topazRouter() on the quote adapter);
 *            Robinhood 4663/46630: Uniswap V3, adapter (RobinhoodV3PoolRepair family) WETH(), v3Factory().
 *
 * Pure helpers only (no database, no RPC), so the tests pin them without either.
 */
import { ethers } from "ethers";
import { GEN5_CAMPAIGN_IFACE } from "./evmGen5CampaignLogs.js";

const ZERO = ethers.ZeroAddress.toLowerCase();

/** Views the handoff reads off a gen-5 adapter (BNB and Robinhood variants; each answers a subset). */
export const GEN5_ADAPTER_VIEW_ABI = [
  "function topazFactory() view returns (address)",
  "function topazRouter() view returns (address)",
  "function WBNB() view returns (address)",
  "function WETH() view returns (address)",
  "function v3Factory() view returns (address)",
] as const;

export function lowerAddress(value: unknown): string {
  const candidate = String(value ?? "").trim();
  if (!ethers.isAddress(candidate)) return ZERO;
  return ethers.getAddress(candidate).toLowerCase();
}

/** Same shape as marketContinuity's GraduationEventSnapshot, so the same writes serve both generations. */
export type Gen5GraduationSnapshot = {
  caller: string;
  pair: string;
  graduationBalanceRaw: string;
  graduationOvershootRaw: string;
  liquidityTokenRaw: string;
  liquidityBnbRaw: string;
  liquidityLpRaw: string;
  protocolFeeRaw: string;
  creatorPayoutRaw: string;
  burnedUnsoldTokenRaw: string;
  burnedUnusedLpTokenRaw: string;
  finalCurvePriceRaw: string;
  initialDexPriceRaw: string;
  postBurnTotalSupplyRaw: string;
};

function raw(value: unknown, fallback = "0"): string {
  if (value == null || value === "") return fallback;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function at(source: any, name: string, index: number): unknown {
  if (source == null) return undefined;
  return source[name] ?? source[index];
}

/**
 * Graduated(pool, raise, protocolShare, creatorShare, poolNative, memeUsed, memeBurned, curvePrice,
 * startPrice, repaired) plus, when readable, getGraduationState() (same 11-field tuple as the old
 * generation). The state is authoritative for what the event does not carry: the LP amount, the native
 * that actually stayed in the pool (poolNative minus the adapter's refund), the post-burn supply and the
 * overshoot. Args may be an ethers Result or the stored JSON (strings) from evm_campaign_events.
 */
export function gen5GraduatedSnapshot(args: any, state?: any, caller?: string | null): Gen5GraduationSnapshot {
  const eventPool = lowerAddress(at(args, "pool", 0));
  const statePool = lowerAddress(at(state, "dexPair", 0));
  return {
    caller: lowerAddress(caller),
    pair: statePool !== ZERO ? statePool : eventPool,
    graduationBalanceRaw: raw(at(state, "graduationBalance", 9) ?? at(args, "raise", 1)),
    graduationOvershootRaw: raw(at(state, "graduationOvershoot", 10)),
    liquidityTokenRaw: raw(at(state, "graduatedLiquidityTokens", 3) ?? at(args, "memeUsed", 5)),
    liquidityBnbRaw: raw(at(state, "graduatedLiquidityBnb", 4) ?? at(args, "poolNative", 4)),
    liquidityLpRaw: raw(at(state, "graduatedLiquidityLp", 5)),
    protocolFeeRaw: raw(at(args, "protocolShare", 2)),
    creatorPayoutRaw: raw(at(args, "creatorShare", 3)),
    burnedUnsoldTokenRaw: raw(at(state, "burnedUnsoldTokens", 6) ?? at(args, "memeBurned", 6)),
    burnedUnusedLpTokenRaw: raw(at(state, "burnedUnusedLpTokens", 7)),
    finalCurvePriceRaw: raw(at(state, "finalCurvePrice", 1) ?? at(args, "curvePrice", 7)),
    initialDexPriceRaw: raw(at(state, "initialDexPrice", 2) ?? at(args, "startPrice", 8)),
    postBurnTotalSupplyRaw: raw(at(state, "postBurnTotalSupply", 8)),
  };
}

/** The pool's paired token: the bound quote, unless the coin is native or took the E12 native fallback. */
export function expectedGen5PoolQuote(input: {
  quoteToken: string | null | undefined;
  nativeFallback: boolean;
  wrappedNative: string;
}): string {
  const quote = lowerAddress(input.quoteToken);
  if (quote === ZERO || input.nativeFallback) return lowerAddress(input.wrappedNative);
  return quote;
}

export type Gen5TopazVerification = {
  routeVerified: boolean;
  marketStage: "TOPAZ_PENDING" | "TOPAZ_ACTIVE" | "TOPAZ_DEGRADED";
  reason: string | null;
};

/**
 * classifyTopazMarket for a gen-5 pool: the pair must hold the campaign token and the expected quote
 * (WBNB for native coins, the bound quote for quote coins), be the factory's volatile pool for that pair,
 * hold reserves and have a readable fee.
 */
export function classifyGen5TopazPool(input: {
  pairPresent: boolean;
  pairMatchesFactory: boolean;
  token: string;
  expectedQuote: string;
  token0: string;
  token1: string;
  stable: boolean;
  reservesPresent: boolean;
  feeVerified: boolean;
}): Gen5TopazVerification {
  if (!input.pairPresent) {
    return { routeVerified: false, marketStage: "TOPAZ_PENDING", reason: "Graduation pool is not available yet." };
  }
  const token = lowerAddress(input.token);
  const quote = lowerAddress(input.expectedQuote);
  const t0 = lowerAddress(input.token0);
  const t1 = lowerAddress(input.token1);
  const failures: string[] = [];
  if (!input.pairMatchesFactory) failures.push("factory pool mismatch");
  if (quote === ZERO || !((t0 === token && t1 === quote) || (t1 === token && t0 === quote))) {
    failures.push("token/quote pool mismatch");
  }
  if (input.stable) failures.push("pool is not volatile");
  if (!input.reservesPresent) failures.push("pool reserves are not available");
  if (!input.feeVerified) failures.push("pool fee is not verified");
  if (failures.length) return { routeVerified: false, marketStage: "TOPAZ_DEGRADED", reason: failures.join(", ") };
  return { routeVerified: true, marketStage: "TOPAZ_ACTIVE", reason: null };
}

/** Reserves as (campaign token side, paired side), whatever the pool's token order. */
export function splitReserves(input: { token: string; token0: string; reserve0: bigint; reserve1: bigint }): {
  reserveTokenRaw: string;
  reserveQuoteRaw: string;
} {
  const tokenIs0 = lowerAddress(input.token0) === lowerAddress(input.token);
  return {
    reserveTokenRaw: (tokenIs0 ? input.reserve0 : input.reserve1).toString(),
    reserveQuoteRaw: (tokenIs0 ? input.reserve1 : input.reserve0).toString(),
  };
}

export const GEN5_GRADUATED_TOPIC: string = (() => {
  const event = GEN5_CAMPAIGN_IFACE.getEvent("Graduated");
  if (!event) throw new Error("gen5 ABI lacks Graduated");
  return event.topicHash;
})();

/** A stored evm_campaign_events Graduated row, as the handoff consumes it. */
export type StoredGraduated = {
  txHash: string;
  blockNumber: number;
  blockTime: Date | null;
  args: Record<string, unknown>;
};

export function storedGraduatedFromRow(row: any): StoredGraduated | null {
  if (!row) return null;
  const txHash = String(row.tx_hash || "").toLowerCase();
  const blockNumber = Number(row.block_number || 0);
  if (!/^0x[a-f0-9]{64}$/.test(txHash) || !(blockNumber > 0)) return null;
  const args = typeof row.args === "string" ? JSON.parse(row.args) : row.args || {};
  if (lowerAddress(args.pool) === ZERO) return null;
  return {
    txHash,
    blockNumber,
    blockTime: row.block_time ? new Date(row.block_time) : null,
    args,
  };
}

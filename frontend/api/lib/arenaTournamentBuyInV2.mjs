import { Contract, formatUnits, getAddress, id } from "ethers";

import { unitPriceNativeRawFromUsdMicros } from "./arenaBoostQuote.mjs";
import { isSolanaChainId } from "./chainNative.js";

export const TOURNAMENT_BUY_IN_USD_MICROS = 250_000n;
export const DEFAULT_TOURNAMENT_PRICE_MAX_AGE_SECONDS = 300n;

function positiveBigInt(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error(`${label} must be positive`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /must be positive/.test(error.message)) throw error;
    throw new Error(`${label} must be a positive integer`);
  }
}

export function tournamentNativeDecimals(chainId) {
  return isSolanaChainId(Number(chainId)) ? 9 : 18;
}

export function tournamentPoolIdV2(tournamentId) {
  return id(`arena-tournament:${String(tournamentId)}`);
}

export function readTournamentBuyInPricing(chainId, env = process.env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const chain = Number(chainId);
  if (!Number.isInteger(chain) || chain <= 0) throw new Error("chainId is invalid");
  const nativeUsdRaw =
    env[`ARENA_TOURNAMENT_NATIVE_USD_MICROS_${chain}`] ||
    env.ARENA_TOURNAMENT_NATIVE_USD_MICROS ||
    env[`ARENA_BOOST_NATIVE_USD_MICROS_${chain}`] ||
    env.ARENA_BOOST_NATIVE_USD_MICROS;
  const pricingVersionRaw =
    env[`ARENA_TOURNAMENT_PRICING_VERSION_${chain}`] ||
    env.ARENA_TOURNAMENT_PRICING_VERSION ||
    env[`ARENA_BOOST_PRICING_VERSION_${chain}`] ||
    env.ARENA_BOOST_PRICING_VERSION;
  const updatedAtRaw =
    env[`ARENA_TOURNAMENT_NATIVE_USD_UPDATED_AT_${chain}`] ||
    env.ARENA_TOURNAMENT_NATIVE_USD_UPDATED_AT ||
    env[`ARENA_BOOST_NATIVE_USD_UPDATED_AT_${chain}`] ||
    env.ARENA_BOOST_NATIVE_USD_UPDATED_AT;
  const maxAgeRaw =
    env[`ARENA_TOURNAMENT_PRICE_MAX_AGE_SECONDS_${chain}`] ||
    env.ARENA_TOURNAMENT_PRICE_MAX_AGE_SECONDS ||
    env[`ARENA_BOOST_PRICE_MAX_AGE_SECONDS_${chain}`] ||
    env.ARENA_BOOST_PRICE_MAX_AGE_SECONDS ||
    DEFAULT_TOURNAMENT_PRICE_MAX_AGE_SECONDS;

  if (!nativeUsdRaw || !pricingVersionRaw || !updatedAtRaw) {
    throw new Error("Vote Tournament native/USD pricing is not configured for this chain");
  }
  const nativeUsdMicros = positiveBigInt(nativeUsdRaw, "nativeUsdMicros");
  const pricingVersion = positiveBigInt(pricingVersionRaw, "pricingVersion");
  const updatedAt = positiveBigInt(updatedAtRaw, "updatedAt");
  const maxAgeSeconds = positiveBigInt(maxAgeRaw, "maxAgeSeconds");
  const now = BigInt(nowSeconds);
  if (updatedAt > now || now - updatedAt > maxAgeSeconds) throw new Error("Vote Tournament native/USD price is stale");

  const nativeDecimals = tournamentNativeDecimals(chain);
  const buyInNativeRaw = unitPriceNativeRawFromUsdMicros({
    usdMicros: TOURNAMENT_BUY_IN_USD_MICROS,
    nativeUsdMicros,
    nativeDecimals,
  });
  return {
    chainId: chain,
    usdMicros: TOURNAMENT_BUY_IN_USD_MICROS,
    nativeUsdMicros,
    pricingVersion,
    oracleTimestamp: updatedAt,
    nativeDecimals,
    buyInNativeRaw,
    buyInNative: formatUnits(buyInNativeRaw, nativeDecimals),
  };
}

export function arenaWarPoolTreasuryV2Address(chainId, env = process.env) {
  const chain = Number(chainId);
  const raw = String(
    env[`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chain}`] ||
      env[`ARENA_WAR_POOL_TREASURY_ADDRESS_${chain}`] ||
      "",
  ).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) throw new Error(`Arena War Pool V2 address is not configured for chain ${chain}`);
  return getAddress(raw);
}

const TOURNAMENT_POOL_READ_ABI = [
  "function buyIns(bytes32 poolId,address wallet) view returns (uint256)",
  "function pools(bytes32 poolId) view returns (uint8 kind,uint8 state,address ownerA,address ownerB,uint96 stakeAmount,uint96 buyInAmount,uint256 stakeA,uint256 stakeB,uint256 buyInTotal,uint256 boostTotal,address winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 depositDeadline,uint256 resolveDeadline,bool claimedWinner,bool claimedProtocol,bool claimedLeague,bool refundedA,bool refundedB)",
];

export async function verifyEvmTournamentBuyInV2({ provider, chainId, tournamentId, wallet, expectedBuyInRaw, treasuryAddress }) {
  if (!provider) throw new Error("Vote Tournament RPC provider is unavailable");
  const treasury = treasuryAddress || arenaWarPoolTreasuryV2Address(chainId);
  const contract = new Contract(treasury, TOURNAMENT_POOL_READ_ABI, provider);
  const poolId = tournamentPoolIdV2(tournamentId);
  const pool = await contract.pools(poolId);
  const kind = Number(pool.kind ?? pool[0]);
  const state = Number(pool.state ?? pool[1]);
  const buyInAmount = BigInt(pool.buyInAmount ?? pool[5]);
  const paid = BigInt(await contract.buyIns(poolId, getAddress(String(wallet))));
  const expected = positiveBigInt(expectedBuyInRaw, "expectedBuyInRaw");
  if (kind !== 1) throw new Error("Vote Tournament V2 pool is not a tournament pool");
  if (![0, 1].includes(state)) throw new Error("Vote Tournament V2 pool is not accepting/holding active entries");
  if (buyInAmount !== expected) throw new Error("Vote Tournament V2 on-chain buy-in does not match the founder-locked quote");
  if (paid !== expected) throw new Error("Vote Tournament V2 wallet has not paid the exact buy-in");
  return { ok: true, treasuryAddress: treasury, poolId, state, buyInAmount, paid };
}

/**
 * One airdrop rule set for every chain, in USD (founder, 2026-09-25: "we shouldn't have different
 * values than the other chains"). Mirrors realtime-indexer/src/rewards/airdropThresholds.ts; the
 * figures are the old BNB rules at $600/BNB. Each run converts them to the chain's native raw units
 * at the spot price and records that price in the batch metadata.
 */

export const AIRDROP_USD_RULES = Object.freeze({
  traderMinUsd: 150,
  traderCapUsd: 9_000,
  creatorMinBondingUsd: 1_800,
  creatorCapUsd: 15_000,
  creatorMinUniqueBuyers: 10,
  // Target payout per winner (was 0.05 BNB): sets how many winners a pool is split over.
  targetPayoutUsd: 30,
  // Scores are expressed in "BNB-equivalent" units ($600) so BNB weights stay exactly as before
  // and every other chain is weighted on the same dollar scale.
  scoreUnitUsd: 600,
});

export function nativeDecimals(chainId) {
  return Number(chainId) === 101 || Number(chainId) === 102 ? 9 : 18;
}

export function usdToNativeRaw(usd, nativeUsd, decimals) {
  if (!(nativeUsd > 0) || !(usd >= 0)) throw new Error(`invalid USD conversion ${usd} @ ${nativeUsd}`);
  const micro = BigInt(Math.floor((usd / nativeUsd) * 1_000_000));
  return decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals);
}

/** raw native amount -> "BNB-equivalent" score units at this run's price. */
export function scoreUnits(raw, chainId, nativeUsd) {
  const whole = Number(raw) / 10 ** nativeDecimals(chainId);
  return (whole * nativeUsd) / AIRDROP_USD_RULES.scoreUnitUsd;
}

export function thresholdsFor(chainId, nativeUsd) {
  const decimals = nativeDecimals(chainId);
  const raw = (usd) => usdToNativeRaw(usd, nativeUsd, decimals);
  return {
    chainId: Number(chainId),
    nativeUsd,
    decimals,
    traderMinRaw: raw(AIRDROP_USD_RULES.traderMinUsd),
    traderCapRaw: raw(AIRDROP_USD_RULES.traderCapUsd),
    creatorMinRaw: raw(AIRDROP_USD_RULES.creatorMinBondingUsd),
    creatorCapRaw: raw(AIRDROP_USD_RULES.creatorCapUsd),
    creatorMinUniqueBuyers: AIRDROP_USD_RULES.creatorMinUniqueBuyers,
    targetPayoutRaw: raw(AIRDROP_USD_RULES.targetPayoutUsd),
    // Score normalisers: the old fixed 15 / 25 BNB, now the USD caps in score units.
    traderCapScore: AIRDROP_USD_RULES.traderCapUsd / AIRDROP_USD_RULES.scoreUnitUsd,
    creatorCapScore: AIRDROP_USD_RULES.creatorCapUsd / AIRDROP_USD_RULES.scoreUnitUsd,
  };
}

const SYMBOL = { 56: "BNB", 97: "BNB", 101: "SOL", 102: "SOL", 4663: "ETH", 46630: "ETH" };

/** Spot native/USD. AIRDROP_NATIVE_USD_<chainId> pins it. Throws rather than guessing. */
export async function nativeUsdFor(chainId, fetchImpl = fetch) {
  const pinned = Number(process.env[`AIRDROP_NATIVE_USD_${chainId}`] || "");
  if (pinned > 0) return pinned;
  const symbol = SYMBOL[Number(chainId)];
  if (!symbol) throw new Error(`no native/USD source for chain ${chainId}`);
  for (const url of [
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`,
    `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`,
  ]) {
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const body = await response.json();
      const price = Number(body?.price ?? body?.data?.amount);
      if (price > 0 && price < 1_000_000) return price;
    } catch {
      // next source
    }
  }
  throw new Error(`native/USD price unavailable for chain ${chainId}; refusing to guess airdrop thresholds`);
}

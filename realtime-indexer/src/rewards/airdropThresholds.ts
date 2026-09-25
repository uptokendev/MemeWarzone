/**
 * Airdrop eligibility thresholds, one USD rule set for every chain (founder, 2026-09-25): "we
 * shouldn't have different values than the other chains".
 *
 * They used to be BNB-wei constants applied to every chain's raw amounts. On Solana, where amounts
 * are lamports (1e9 per SOL), "0.25 BNB" (25e16) meant 250 million SOL, so no Solana wallet could
 * ever qualify. The USD figures are the old BNB rules at ~$600/BNB. Each epoch converts them to the
 * chain's native raw units at the spot price when eligibility runs, and records that price.
 */

export const AIRDROP_USD_RULES = {
  traderMinUsd: 150,
  traderMaxCountedUsd: 9_000,
  creatorMinBondingUsd: 1_800,
  creatorMaxCountedUsd: 15_000,
} as const;

export type AirdropNativeThresholds = {
  chainId: number;
  nativeUsd: number;
  decimals: number;
  traderMinVolume: bigint;
  traderMaxCountedVolume: bigint;
  creatorMinBondingVolume: bigint;
  creatorMaxCountedVolume: bigint;
};

const BNB = 10n ** 18n;

/** The previous fixed BNB rules; the default for callers that pass no thresholds (simulations, tests). */
export const LEGACY_BNB_THRESHOLDS: AirdropNativeThresholds = {
  chainId: 56,
  nativeUsd: 600,
  decimals: 18,
  traderMinVolume: 25n * 10n ** 16n,
  traderMaxCountedVolume: 15n * BNB,
  creatorMinBondingVolume: 3n * BNB,
  creatorMaxCountedVolume: 25n * BNB,
};

export function nativeDecimalsForChain(chainId: number): number {
  return chainId === 101 || chainId === 102 ? 9 : 18;
}

/** usd / price in the chain's raw units, rounded down, exact to 1e-6 of a native unit. */
export function usdToNativeRaw(usd: number, nativeUsd: number, decimals: number): bigint {
  if (!(nativeUsd > 0) || !(usd >= 0)) throw new Error(`invalid USD conversion ${usd} @ ${nativeUsd}`);
  const micro = BigInt(Math.floor((usd / nativeUsd) * 1_000_000));
  return decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals);
}

export function airdropThresholdsForChain(chainId: number, nativeUsd: number): AirdropNativeThresholds {
  const decimals = nativeDecimalsForChain(chainId);
  const raw = (usd: number) => usdToNativeRaw(usd, nativeUsd, decimals);
  return {
    chainId,
    nativeUsd,
    decimals,
    traderMinVolume: raw(AIRDROP_USD_RULES.traderMinUsd),
    traderMaxCountedVolume: raw(AIRDROP_USD_RULES.traderMaxCountedUsd),
    creatorMinBondingVolume: raw(AIRDROP_USD_RULES.creatorMinBondingUsd),
    creatorMaxCountedVolume: raw(AIRDROP_USD_RULES.creatorMaxCountedUsd),
  };
}

const BINANCE_SYMBOL: Record<number, string> = {
  56: "BNBUSDT",
  97: "BNBUSDT",
  101: "SOLUSDT",
  102: "SOLUSDT",
  4663: "ETHUSDT",
  46630: "ETHUSDT",
};

/** Spot native/USD for eligibility. AIRDROP_NATIVE_USD_<chainId> pins a price. Throws when unknown. */
export async function fetchAirdropNativeUsd(chainId: number, fetchImpl: typeof fetch = fetch): Promise<number> {
  const pinned = Number(process.env[`AIRDROP_NATIVE_USD_${chainId}`] || "");
  if (pinned > 0) return pinned;
  const symbol = BINANCE_SYMBOL[chainId];
  if (!symbol) throw new Error(`no native/USD source for chain ${chainId}`);
  const sources = [
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    `https://api.coinbase.com/v2/prices/${symbol.replace("USDT", "")}-USD/spot`,
  ];
  for (const url of sources) {
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const body = (await response.json()) as { price?: string; data?: { amount?: string } };
      const price = Number(body?.price ?? body?.data?.amount);
      if (price > 0 && price < 1_000_000) return price;
    } catch {
      // try the next source
    }
  }
  throw new Error(`native/USD price unavailable for chain ${chainId}; eligibility refuses to guess thresholds`);
}

/**
 * Token page numbers for a Meteora DBC coin.
 *
 * The page's Solana metrics read the launchpad Campaign account (sold tokens, volume counters, fee
 * bps). A DBC pool has none of those, so market cap, Deployed and the Flywheel showed "—" and the
 * chart priced market cap on traded tokens. These helpers derive the same numbers from what a DBC
 * coin does have: the mint supply, the pool's sqrt price, the API record and the indexed trades.
 */
import { DBC_TRADE_FEE_BPS } from "../../shared/dbcEconomics.mjs";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_PLAUSIBLE_UNIX = 1_577_836_800; // 2020-01-01, as formatDeployedDate guards

/** Mint supply in whole tokens. A DBC mint holds its whole supply from create, so mcap = spot x this. */
export function dbcSupplyWhole(supplyRaw, decimals = 6) {
  let raw;
  try {
    raw = typeof supplyRaw === "bigint" ? supplyRaw : BigInt(String(supplyRaw ?? "0"));
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  const whole = Number(raw) / 10 ** Number(decimals);
  return Number.isFinite(whole) && whole > 0 ? whole : null;
}

/** SOL per whole token from the pool's Q64.64 sqrt price; null for a pool quoted in anything but SOL. */
export function dbcSpotSolFromSqrt(sqrtPrice, quoteMint = WSOL_MINT, baseDecimals = 6) {
  if (String(quoteMint || WSOL_MINT) !== WSOL_MINT) return null;
  let sqrt;
  try {
    sqrt = BigInt(String(sqrtPrice ?? "0"));
  } catch {
    return null;
  }
  if (sqrt <= 0n) return null;
  const q64 = 2n ** 64n;
  const scale = 10n ** 18n;
  const scaled = (sqrt * sqrt * 10n ** BigInt(baseDecimals) * scale) / (q64 * q64 * 10n ** 9n);
  const spot = Number(scaled) / 1e18;
  return Number.isFinite(spot) && spot > 0 ? spot : null;
}

/** Unix seconds the coin was deployed: the API's created time, else the pool's activation time. */
export function dbcDeployedAtSec(dbcLive) {
  const created = Date.parse(String(dbcLive?.createdAt || ""));
  if (Number.isFinite(created) && created / 1000 > MIN_PLAUSIBLE_UNIX) return Math.floor(created / 1000);
  // activationPoint is unix seconds on a timestamp-activated config; a slot-activated one is far below.
  const activation = Number(dbcLive?.poolLive?.activationPoint || 0);
  if (Number.isFinite(activation) && activation > MIN_PLAUSIBLE_UNIX) return Math.floor(activation);
  return null;
}

/**
 * Flywheel from indexed DBC trades (native units). Buy volume is what buyers paid, sell volume what
 * sellers received. Fees are an estimate at the base trade fee: the anti-sniper minute charged more.
 */
export function dbcFlywheel(trades, nativeDecimals = 9, feeBps = DBC_TRADE_FEE_BPS) {
  let buyRaw = 0n;
  let sellRaw = 0n;
  const buyers = new Set();
  for (const trade of Array.isArray(trades) ? trades : []) {
    let amount;
    try {
      amount = BigInt(trade?.nativeWei ?? 0);
    } catch {
      continue;
    }
    if (amount <= 0n) continue;
    if (trade?.type === "sell") {
      sellRaw += amount;
    } else {
      buyRaw += amount;
      const from = String(trade?.from || "").trim();
      if (from) buyers.add(from);
    }
  }
  const scale = 10 ** Number(nativeDecimals);
  const buyVolume = Number(buyRaw) / scale;
  const sellVolume = Number(sellRaw) / scale;
  return {
    buyVolume,
    sellVolume,
    netFlow: buyVolume - sellVolume,
    feesEstimated: (buyVolume + sellVolume) * (Number(feeBps) / 10_000),
    feeBps: Number(feeBps),
    buyers: buyers.size,
  };
}

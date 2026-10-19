/**
 * The gen-8 amount field is a whole-coin or whole-native decimal. The wei of that string
 * is 18 decimals and nothing else. A sell typed in native is solved into coins, then the
 * same exact-input sell sends those coins. The field text is never a second scale of itself.
 */

export function gen8TypedAmountWei(text, decimals = 18) {
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 78) return null;
  const v = String(text ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  if (frac.length > places) return null;
  const scale = 10n ** BigInt(places);
  const fracWei = BigInt((frac + "0".repeat(places)).slice(0, places) || "0");
  const raw = BigInt(whole || "0") * scale + fracWei;
  return raw > 0n ? raw : null;
}

/** Decimal the amount field shows. Trailing zeros are stripped so parse is exact. */
export function gen8FormatAmountField(raw, decimals = 18) {
  const places = Number(decimals);
  const value = BigInt(raw);
  if (value < 0n) return "";
  const scale = 10n ** BigInt(places);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

/**
 * MAX fills the field with the coin wei it will send. That is the wallet balance, or the
 * pool's max sellable when that is smaller. The field text parses back to that same wei.
 */
export function gen8MaxCoinWei(balanceWei, maxSellableWei) {
  const balance = BigInt(balanceWei);
  if (balance <= 0n) return null;
  if (maxSellableWei == null) return balance;
  const cap = BigInt(maxSellableWei);
  if (cap <= 0n) return null;
  return cap < balance ? cap : balance;
}

/** Curve payout that leaves `net` after a fee of `feeBps`. The hook takes the fee out of a sell's payout. */
export function gen8GrossForNet(netWei, feeBps = 0) {
  const net = BigInt(netWei);
  const bps = BigInt(feeBps);
  if (net <= 0n) return null;
  if (bps <= 0n) return net;
  if (bps >= 10_000n) return null;
  const keep = 10_000n - bps;
  return (net * 10_000n + keep - 1n) / keep;
}

/**
 * First coin guess for an exact-input sell that should receive `targetNativeWei`.
 * `nativePerCoinWei` is native wei per 1e18 coin units. The quote then corrects this.
 */
export function gen8SpotSellCoins({ targetNativeWei, nativePerCoinWei, feeBps = 0 }) {
  const gross = gen8GrossForNet(targetNativeWei, feeBps);
  const price = BigInt(nativePerCoinWei);
  if (gross == null || price <= 0n) return null;
  const coins = (gross * 10n ** 18n + price - 1n) / price;
  return coins > 0n ? coins : null;
}

/** Next coin guess after one exact-input quote. Null when the quote cannot be scaled. */
export function gen8ScaleSellCoins({ coinIn, quotedOut, targetOut }) {
  const coins = BigInt(coinIn);
  const quoted = BigInt(quotedOut);
  const target = BigInt(targetOut);
  if (coins <= 0n || quoted <= 0n || target <= 0n) return null;
  if (quoted === target) return coins;
  const scaled = target > quoted ? (coins * target + quoted - 1n) / quoted : (coins * target) / quoted;
  return scaled > 0n ? scaled : null;
}

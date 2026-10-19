/**
 * The gen-8 amount field is a whole-coin or whole-native decimal. The wei sent is that
 * string at 18 decimals, nothing else: not the displayed rounding, not a price, not a second scale.
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

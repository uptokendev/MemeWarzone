export const MOBILE_TRADE_UNITS = ["USD", "NATIVE", "TOKEN"];

export function nextMobileTradeUnit(unit) {
  const current = String(unit || "USD").toUpperCase();
  const index = MOBILE_TRADE_UNITS.indexOf(current);
  return MOBILE_TRADE_UNITS[index < 0 ? 1 : (index + 1) % MOBILE_TRADE_UNITS.length];
}

export function mobileTradeUnitLabel(unit, nativeUnit, ticker) {
  const key = String(unit || "USD").toUpperCase();
  if (key === "USD") return "USD";
  if (key === "NATIVE") return String(nativeUnit || "SOL").replace(/^\$/, "");
  return String(ticker || "TOKEN").replace(/^\$/, "") || "TOKEN";
}

export function parseTradeNumber(value) {
  const cleaned = String(value ?? "").trim().replace(/,/g, ".").replace(/[^0-9.]/g, "");
  if (!cleaned || cleaned === ".") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function formatTradeAmount(n, maxDecimals = 8) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1) return String(Number(n.toFixed(Math.min(6, maxDecimals))));
  if (n >= 0.0001) return String(Number(n.toFixed(Math.min(8, maxDecimals))));
  return n.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function usdToNativeAmount(usd, nativeUsd) {
  const dollars = Number(usd);
  const px = Number(nativeUsd);
  if (!Number.isFinite(dollars) || dollars <= 0 || !Number.isFinite(px) || px <= 0) return "";
  return formatTradeAmount(dollars / px);
}

export function usdToTokenAmount(usd, priceNative, nativeUsd) {
  const dollars = Number(usd);
  const px = Number(priceNative) * Number(nativeUsd);
  if (!Number.isFinite(dollars) || dollars <= 0 || !Number.isFinite(px) || px <= 0) return "";
  return formatTradeAmount(dollars / px, 12);
}

export function nativeToUsdAmount(native, nativeUsd) {
  const n = Number(native);
  const px = Number(nativeUsd);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(px) || px <= 0) return "";
  return formatTradeAmount(n * px, 2);
}

export function tokenToUsdAmount(tokens, priceNative, nativeUsd) {
  const n = Number(tokens);
  const px = Number(priceNative) * Number(nativeUsd);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(px) || px <= 0) return "";
  return formatTradeAmount(n * px, 2);
}

export function engineAmountFromDisplay({ unit, displayAmount, side, nativeUsd, priceNative }) {
  const value = parseTradeNumber(displayAmount);
  const key = String(unit || "USD").toUpperCase();
  if (key === "NATIVE") return { denom: "BNB", amount: formatTradeAmount(value) || String(displayAmount || "0") };
  if (key === "TOKEN") return { denom: "TOKEN", amount: formatTradeAmount(value, 12) || String(displayAmount || "0") };
  if (String(side) === "sell") {
    return { denom: "TOKEN", amount: usdToTokenAmount(value, priceNative, nativeUsd) || "0" };
  }
  return { denom: "BNB", amount: usdToNativeAmount(value, nativeUsd) || "0" };
}

export function percentOf(balance, pct) {
  const n = Number(balance);
  const p = Number(pct);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || p <= 0) return "";
  const raw = (n * Math.min(p, 100)) / 100;
  // Round down, never up: formatTradeAmount rounds to 6/8 decimals and 100% must not exceed the balance.
  const decimals = raw >= 1 ? 6 : raw >= 0.0001 ? 8 : 12;
  const scale = 10 ** decimals;
  return formatTradeAmount(Math.floor(raw * scale) / scale, 12);
}

export function mobileTradeCta({ connected, displayAmount, side = "buy", pending = false } = {}) {
  if (!connected) return { label: "Connect wallet", disabled: false, kind: "connect" };
  if (pending) return { label: "Processing...", disabled: true, kind: "pending" };
  if (parseTradeNumber(displayAmount) <= 0) return { label: "Enter an amount", disabled: true, kind: "empty" };
  return { label: String(side) === "sell" ? "Sell" : "Buy", disabled: false, kind: "submit" };
}

export function mobileDockCta({ connected, connectLabel } = {}) {
  if (!connected) return { label: String(connectLabel || "Connect wallet"), kind: "connect" };
  return { label: "Buy", kind: "buy" };
}

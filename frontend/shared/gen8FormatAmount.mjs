/**
 * A gen-8 quote amount. 0 is "0". Anything smaller than 0.000001 of one whole token is "< 0.000001".
 * Otherwise up to 6 significant digits after the decimal, with thousands separators on the whole part.
 * The caller adds the symbol, so a tiny receive reads "< 0.000001 ETH".
 * No ethers: the swap widget imports this file and must not pull a provider library.
 */
const FRACTION_SIG = 6;
const DUST_DIVISOR = 1_000_000n;

function withCommas(whole) {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function gen8FormatAmount(raw, decimals = 18) {
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 78) throw new Error("Bad amount decimals.");
  const value = BigInt(raw);
  if (value === 0n) return "0";
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(places);
  if (abs < scale / DUST_DIVISOR) return `${sign}< 0.000001`;

  const whole = abs / scale;
  const frac = abs % scale;
  if (places === 0 || frac === 0n) return sign + withCommas(whole);

  const fracStr = frac.toString().padStart(places, "0");
  const first = whole > 0n ? 0 : fracStr.search(/[1-9]/);
  const keep = Math.min(places, first + FRACTION_SIG);
  const next = fracStr[keep] ?? "0";
  const chars = fracStr.slice(0, keep).split("");
  let carry = next >= "5" ? 1 : 0;
  for (let i = chars.length - 1; carry && i >= 0; i -= 1) {
    const digit = chars[i].charCodeAt(0) - 48 + carry;
    if (digit >= 10) {
      chars[i] = "0";
    } else {
      chars[i] = String(digit);
      carry = 0;
    }
  }
  const wholeOut = carry ? whole + 1n : whole;
  const trimmed = chars.join("").replace(/0+$/, "");
  const wholeText = withCommas(wholeOut);
  return sign + (trimmed ? `${wholeText}.${trimmed}` : wholeText);
}

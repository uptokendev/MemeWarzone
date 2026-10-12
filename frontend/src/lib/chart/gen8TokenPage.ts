/**
 * Generation-8 coin page inputs. The shared chart already works for Solana when the page
 * feeds pool spot, fully diluted supply, and indexer candles. Gen-8 has no campaign
 * contract, so these helpers read the lens and the candle spots instead. They do not
 * touch curve math.
 */

export const GEN8_FDV_WHOLE = 1_000_000_000;

const DEAD = "0x000000000000000000000000000000000000dead";
/** Same Pancake Infinity vaults the indexer census excludes. Chain 97 has none. */
const PANCAKE_INFINITY_VAULT: Record<number, string> = {
  56: "0x238a358808379702088667322f80ac48bad5e6c4",
  4663: "0x4f922d5b15e6691e0469663e4f5c4177f23c5faf",
};

export type Gen8PageState = {
  platformStatus?: string | null;
  postPhase?: boolean | null;
  graduation?: {
    phase?: string | null;
    progressPct?: number | null;
    lensNativeInAWei?: string | null;
    lensNativeTargetAWei?: string | null;
  } | null;
  market?: {
    priceNative?: number | null;
    priceNativeWeiPerCoin?: string | null;
    marketCapNativeWei?: string | null;
  } | null;
};

export type Gen8CandleSpot = {
  bucket_start?: string | null;
  price_o?: string | null;
  price_c?: string | null;
  o?: string | null;
  c?: string | null;
};

/** Platform graduated: latched coins that traded back into bonding stay bonding. */
export function gen8PlatformGraduated(state: Gen8PageState | null | undefined): boolean {
  if (!state) return false;
  if (String(state.platformStatus || "").toLowerCase() === "graduated") return true;
  if (state.postPhase === true) return true;
  return String(state.graduation?.phase || "").toLowerCase() === "graduated";
}

/** ETH (or BNB) per whole coin. Prefer the API number; fall back to the wei string. */
export function gen8SpotNative(state: Gen8PageState | null | undefined): number | null {
  const price = Number(state?.market?.priceNative);
  if (Number.isFinite(price) && price > 0) return price;
  return weiStringToNumber(state?.market?.priceNativeWeiPerCoin);
}

/** Fully diluted native market cap from the lens, not price times curve sold. */
export function gen8MarketCapNative(state: Gen8PageState | null | undefined): number | null {
  return weiStringToNumber(state?.market?.marketCapNativeWei);
}

export function weiStringToNumber(wei: unknown): number | null {
  const raw = String(wei ?? "").trim();
  if (!/^\d+$/.test(raw) || /^0+$/.test(raw)) return null;
  const padded = raw.padStart(19, "0");
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
  const n = Number(`${whole}.${padded.slice(-18)}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function candleSpot(row: Gen8CandleSpot, side: "open" | "close"): number | null {
  const raw = side === "open" ? (row.price_o ?? row.o ?? row.price_c ?? row.c) : (row.price_c ?? row.c ?? row.price_o ?? row.o);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Change vs candle spot, the same basis as the chart. Start is the last close at or
 * before the window. If the whole life is inside the window, start is that first
 * candle's open, so a 5m bucket that contains the launch and the graduation still
 * counts the launch spot. Fill prices are not used.
 */
export function gen8SpotWindowChanges(args: {
  candles: Gen8CandleSpot[] | null | undefined;
  spotNow: number | null;
  nowSec: number;
  windows: Record<string, number>;
}): Record<string, number | null> {
  const points = (args.candles || [])
    .map((row) => {
      const ts = Math.floor(Date.parse(String(row.bucket_start || "")) / 1000);
      return { ts, open: candleSpot(row, "open"), close: candleSpot(row, "close") };
    })
    .filter((point) => Number.isFinite(point.ts) && point.ts > 0 && (point.open != null || point.close != null))
    .sort((a, b) => a.ts - b.ts);

  const spot = args.spotNow != null && Number.isFinite(args.spotNow) && args.spotNow > 0 ? args.spotNow : null;
  const out: Record<string, number | null> = {};
  for (const [key, seconds] of Object.entries(args.windows)) {
    if (spot == null || !Number.isFinite(seconds)) {
      out[key] = null;
      continue;
    }
    const startTs = args.nowSec - seconds;
    let start: number | null = null;
    for (const point of points) {
      if (point.ts <= startTs) start = point.close ?? point.open;
      else break;
    }
    if (start == null) {
      const inside = points.find((point) => point.ts > startTs);
      start = inside ? (inside.open ?? inside.close) : null;
    }
    if (start == null || start <= 0) {
      out[key] = null;
      continue;
    }
    const pct = ((spot - start) / start) * 100;
    out[key] = Number.isFinite(pct) ? (Math.abs(pct) < 0.005 ? 0 : Number(pct.toFixed(2))) : null;
  }
  return out;
}

/** Bonding-side native from the lens. Not pool TVL, and not the 50 native mainnet target. */
export function gen8LensNative(state: Gen8PageState | null | undefined): {
  inCurveWei: bigint | null;
  targetWei: bigint | null;
  remainingWei: bigint | null;
} {
  const inRaw = String(state?.graduation?.lensNativeInAWei ?? "").trim();
  const targetRaw = String(state?.graduation?.lensNativeTargetAWei ?? "").trim();
  const inCurveWei = /^\d+$/.test(inRaw) ? BigInt(inRaw) : null;
  const targetWei = /^\d+$/.test(targetRaw) ? BigInt(targetRaw) : null;
  const remainingWei =
    inCurveWei != null && targetWei != null ? (targetWei > inCurveWei ? targetWei - inCurveWei : 0n) : null;
  return { inCurveWei, targetWei, remainingWei };
}

/** Indexer source `gen8_v4` is a pool swap, before and after graduation. */
export function isGen8DexSource(source: unknown): boolean {
  return String(source || "").trim().toLowerCase() === "gen8_v4";
}

/** Protocol wallets the transfer scan must not count. The coin itself is excluded by the scanner. */
export function gen8HolderExcludeList(input: {
  chainId?: number | null;
  addresses?: Array<string | null | undefined>;
}): string[] {
  const vault = input.chainId != null ? PANCAKE_INFINITY_VAULT[Number(input.chainId)] : undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...(input.addresses || []), vault, DEAD]) {
    const text = String(value ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

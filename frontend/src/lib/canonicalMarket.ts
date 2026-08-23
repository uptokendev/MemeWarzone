/** Single market-cap / ATH / volume definition for Token Details, WTR, and cards. */

export function canonicalMcapNative(spotNative: number, soldWhole: number): number {
  const spot = Number(spotNative);
  const sold = Number(soldWhole);
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(sold) || sold <= 0) return 0;
  const mcap = spot * sold;
  return Number.isFinite(mcap) && mcap > 0 ? mcap : 0;
}

export function canonicalMcapUsd(spotNative: number, soldWhole: number, nativeUsd: number): number {
  const native = canonicalMcapNative(spotNative, soldWhole);
  const usd = Number(nativeUsd);
  if (!native || !Number.isFinite(usd) || usd <= 0) return 0;
  const value = native * usd;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function canonicalAthUsd(currentMcapUsd: number, indexedAthUsd = 0, seriesMaxUsd = 0): number {
  const current = Number(currentMcapUsd) > 0 ? Number(currentMcapUsd) : 0;
  const indexed = Number(indexedAthUsd) > 0 ? Number(indexedAthUsd) : 0;
  const series = Number(seriesMaxUsd) > 0 ? Number(seriesMaxUsd) : 0;
  return Math.max(current, indexed, series);
}

export function volumeUsdFromNative(volNative: number, nativeUsd: number): number {
  const vol = Number(volNative);
  const usd = Number(nativeUsd);
  if (!Number.isFinite(vol) || vol <= 0 || !Number.isFinite(usd) || usd <= 0) return 0;
  const value = vol * usd;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function volumeNativeFromTrades(
  trades: Array<{ nativeWei?: bigint | number | string; timestamp?: number }>,
  nativeDecimals: number,
  nowSec = Math.floor(Date.now() / 1000),
  windowSec = 86_400,
): number {
  const cutoff = nowSec - windowSec;
  const scale = 10 ** nativeDecimals;
  let total = 0;
  for (const trade of trades || []) {
    const ts = Number(trade.timestamp || 0);
    if (Number.isFinite(ts) && ts > 0 && ts < cutoff) continue;
    const raw = trade.nativeWei;
    const n = typeof raw === "bigint" ? Number(raw) / scale : Number(raw);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

export type MarketConsistencyInput = {
  headerMcapUsd: number;
  wtrMcapUsd: number;
  chartLatestMcapUsd: number;
  chartAthUsd: number;
  canonicalAthUsd: number;
  tokenDetailsVol24hUsd: number;
  wtrVol24hUsd: number;
  tokenDetailsHolders: number;
  wtrHolders: number;
};

/** Display rounding only — values must agree within 2% or $0.02. */
export function marketValuesAgree(a: number, b: number, rel = 0.02, abs = 0.02): boolean {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (x <= 0 && y <= 0) return true;
  if (x <= 0 || y <= 0) return false;
  const diff = Math.abs(x - y);
  return diff <= abs || diff / Math.max(x, y) <= rel;
}

export function assertMarketConsistency(input: MarketConsistencyInput): string[] {
  const failures: string[] = [];
  if (!marketValuesAgree(input.headerMcapUsd, input.wtrMcapUsd)) {
    failures.push(`headerMcap ${input.headerMcapUsd} !== wtrMcap ${input.wtrMcapUsd}`);
  }
  if (!marketValuesAgree(input.headerMcapUsd, input.chartLatestMcapUsd)) {
    failures.push(`headerMcap ${input.headerMcapUsd} !== chartLatest ${input.chartLatestMcapUsd}`);
  }
  if (!marketValuesAgree(input.chartAthUsd, input.canonicalAthUsd)) {
    failures.push(`chartATH ${input.chartAthUsd} !== canonicalATH ${input.canonicalAthUsd}`);
  }
  if (!marketValuesAgree(input.tokenDetailsVol24hUsd, input.wtrVol24hUsd)) {
    failures.push(`tdVol ${input.tokenDetailsVol24hUsd} !== wtrVol ${input.wtrVol24hUsd}`);
  }
  if (!marketValuesAgree(input.tokenDetailsHolders, input.wtrHolders, 0, 0.5)) {
    failures.push(`tdHolders ${input.tokenDetailsHolders} !== wtrHolders ${input.wtrHolders}`);
  }
  return failures;
}

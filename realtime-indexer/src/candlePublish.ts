/** Authoritative OHLCV patch. Frontend rejects close-only (`c`/`v`) candle_upsert. */

export function candleUpsertPayload(
  tf: string,
  bucketSec: number,
  row: {
    o?: unknown;
    h?: unknown;
    l?: unknown;
    c?: unknown;
    volume_bnb?: unknown;
    trades_count?: unknown;
  },
) {
  const o = String(row.o ?? row.c ?? "");
  const h = String(row.h ?? row.c ?? "");
  const l = String(row.l ?? row.c ?? "");
  const c = String(row.c ?? "");
  const volume = String(row.volume_bnb ?? "0");
  const tradesCount = Math.max(0, Math.trunc(Number(row.trades_count ?? 1)));
  return {
    type: "candle_upsert" as const,
    tf,
    bucket: bucketSec,
    o,
    h,
    l,
    c,
    v: volume,
    volume_bnb: volume,
    trades_count: tradesCount,
    open: o,
    high: h,
    low: l,
    close: c,
  };
}

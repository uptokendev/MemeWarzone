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
    mcap_o?: unknown;
    mcap_h?: unknown;
    mcap_l?: unknown;
    mcap_c?: unknown;
    price_o?: unknown;
    price_h?: unknown;
    price_l?: unknown;
    price_c?: unknown;
  },
) {
  const o = String(row.o ?? row.c ?? "");
  const h = String(row.h ?? row.c ?? "");
  const l = String(row.l ?? row.c ?? "");
  const c = String(row.c ?? "");
  const volume = String(row.volume_bnb ?? "0");
  const tradesCount = Math.max(0, Math.trunc(Number(row.trades_count ?? 1)));
  // Market cap rides along when the writer stored it (Solana launchpad, DBC). Without it the chart's
  // market-cap view had nothing to draw for the live bucket and dropped the candle until a reload.
  const mcap = [row.mcap_o, row.mcap_h, row.mcap_l, row.mcap_c];
  const hasMcap = mcap.every((value) => value != null && value !== "" && Number.isFinite(Number(value)));
  // Fee-free curve price (EVM bonding). The chart prefers price_* over o/h/l/c, and a live row without
  // it replaced the materialized bucket's price_* with the fee-inclusive fill.
  const price = [row.price_o, row.price_h, row.price_l, row.price_c];
  const hasPrice = price.every((value) => value != null && value !== "" && Number.isFinite(Number(value)));
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
    ...(hasMcap
      ? { mcap_o: String(mcap[0]), mcap_h: String(mcap[1]), mcap_l: String(mcap[2]), mcap_c: String(mcap[3]) }
      : {}),
    ...(hasPrice
      ? { price_o: String(price[0]), price_h: String(price[1]), price_l: String(price[2]), price_c: String(price[3]) }
      : {}),
  };
}

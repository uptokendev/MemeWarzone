/** Bonding-only canonical candle rewrite. DEX rows stay untouched. */

export const BONDING_CANDLE_CONFLICT_UPDATE_COLUMNS = [
  "o",
  "h",
  "l",
  "c",
  "volume_bnb",
  "trades_count",
  "source_mask",
  "bonding_trade_count",
  "bonding_volume_bnb",
  "last_block_number",
  "last_log_index",
  "price_o",
  "price_h",
  "price_l",
  "price_c",
  "mcap_o",
  "mcap_h",
  "mcap_l",
  "mcap_c",
  "canonical_version",
  "canonical_updated_at",
  "updated_at",
] as const;

export const BONDING_CANDLE_PRESERVE_COLUMNS = ["dex_trade_count", "dex_volume_bnb"] as const;

export function bondingCandleConflictSetSql(): string {
  return BONDING_CANDLE_CONFLICT_UPDATE_COLUMNS.map((column) => `${column}=excluded.${column}`).join(",\n       ");
}

export function isObsoleteBondingCandle(row: {
  dexTradeCount?: number | null;
  canonicalUpdatedAt?: Date | string | null;
  rebuildStartedAt: Date;
}): boolean {
  if (Number(row.dexTradeCount || 0) > 0) return false;
  const updatedMs = row.canonicalUpdatedAt ? new Date(row.canonicalUpdatedAt).getTime() : 0;
  const startedMs = row.rebuildStartedAt.getTime();
  if (!Number.isFinite(updatedMs) || !Number.isFinite(startedMs)) return false;
  return updatedMs < startedMs;
}

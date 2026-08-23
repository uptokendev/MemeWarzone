import assert from "node:assert/strict";
import test from "node:test";
import {
  BONDING_CANDLE_CONFLICT_UPDATE_COLUMNS,
  BONDING_CANDLE_PRESERVE_COLUMNS,
  bondingCandleConflictSetSql,
  isObsoleteBondingCandle,
} from "../canonicalCandleRebuild.js";

test("conflict update rewrites full bonding candle and never DEX counts", () => {
  const sql = bondingCandleConflictSetSql();
  for (const column of [
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
  ]) {
    assert.match(sql, new RegExp(`${column}=excluded\\.${column}`));
  }
  assert.equal(BONDING_CANDLE_CONFLICT_UPDATE_COLUMNS.includes("dex_trade_count" as never), false);
  assert.equal(BONDING_CANDLE_CONFLICT_UPDATE_COLUMNS.includes("dex_volume_bnb" as never), false);
  assert.deepEqual([...BONDING_CANDLE_PRESERVE_COLUMNS], ["dex_trade_count", "dex_volume_bnb"]);
  assert.equal(sql.includes("dex_trade_count="), false);
  assert.equal(sql.includes("dex_volume_bnb="), false);
});

test("prune uses rebuildStartedAt, not a moving 2s window", () => {
  const rebuildStartedAt = new Date("2026-08-23T18:00:00.000Z");
  const slowFresh = new Date("2026-08-23T18:00:05.000Z");
  assert.equal(
    isObsoleteBondingCandle({
      dexTradeCount: 0,
      canonicalUpdatedAt: new Date("2026-08-23T17:59:57.000Z"),
      rebuildStartedAt,
    }),
    true,
  );
  assert.equal(
    isObsoleteBondingCandle({
      dexTradeCount: 0,
      canonicalUpdatedAt: rebuildStartedAt,
      rebuildStartedAt,
    }),
    false,
  );
  assert.equal(
    isObsoleteBondingCandle({
      dexTradeCount: 0,
      canonicalUpdatedAt: slowFresh,
      rebuildStartedAt,
    }),
    false,
    "a rebuild taking >2s must keep freshly written candles",
  );
  assert.equal(
    isObsoleteBondingCandle({
      dexTradeCount: 3,
      canonicalUpdatedAt: new Date("2026-08-23T17:00:00.000Z"),
      rebuildStartedAt,
    }),
    false,
    "DEX rows are never pruned",
  );
});

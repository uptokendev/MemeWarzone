/**
 * Throwaway Postgres for the gen-8 integration test (scripts/dbc/throwaway-postgres.mjs + the market tables). The
 * market-continuity foundation is applied up to its first market_trades_v (the tables; its union does not type-check
 * against the test curve_trades, and grants / triggers / backfills are not needed); the current view (20260921_000002)
 * is applied instead. The gen-8 migration is applied twice to prove it
 * is idempotent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export function gen8SchemaFiles(): string[] {
  const foundation = fs.readFileSync(path.join(ROOT, "db/migrations/202607290001_war_trade_room_market_continuity_foundation.sql"), "utf8");
  const start = foundation.indexOf("create or replace view public.market_trades_v");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-schema-")), "foundation-without-view.sql");
  fs.writeFileSync(tmp, foundation.slice(0, start));
  return [
    tmp,
    "db/migrations/20260930_000001_evm_gen5_indexing.sql",
    "realtime-indexer/src/tests/gen8/gen8-test-schema.sql",
    "db/migrations/20260921_000002_market_trades_v_arena_valuation_columns.sql",
    "db/migrations/20261011_000010_evm_gen8_indexer.sql",
    "db/migrations/20261011_000010_evm_gen8_indexer.sql",
  ];
}

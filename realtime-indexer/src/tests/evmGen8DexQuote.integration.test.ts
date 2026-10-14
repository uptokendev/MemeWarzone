/**
 * A post-graduation gen-8 swap is a dex_trades row whose pair_address is the hook, not a dex_pools pair.
 * set_dex_trade_quote_identity (20260930_000003) raises when that row leaves quote_token_address empty, which
 * stalled the display cursor on the first post-graduation swap. insertGen8DexTrade names the wrapped native.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = fs.existsSync(`${PG16}/initdb`);

test("gen-8 dex trade satisfies the quote-identity trigger", { skip: runnable ? false : "Postgres 16 missing", timeout: 120_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.PG_DISABLE_SSL = "1";
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.LOCAL_DISABLE_ABLY = "1";
  delete process.env.WRAPPED_NATIVE_ADDRESS_46630;
  delete process.env.VITE_WRAPPED_NATIVE_ADDRESS_46630;
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const pg = await startThrowawayPostgres({ port: 55463, extraFiles: gen8SchemaFiles() });
  process.env.DATABASE_URL = pg.url;
  try {
    const fn = fs.readFileSync(new URL("../../../db/migrations/20260930_000003_dex_trade_quote_leg_preserved.sql", import.meta.url), "utf8");
    await pg.pool.query(fn);
    await pg.pool.query(
      `alter table public.dex_trades
         add column if not exists base_amount numeric,
         add column if not exists quote_amount numeric,
         add column if not exists price_quote numeric`,
    );
    await pg.pool.query(`alter table public.dex_pools add column if not exists quote_token_address text`);
    await pg.pool.query(
      `create trigger dex_trades_set_quote_identity
         before insert or update of pair_address, native_amount_raw on public.dex_trades
         for each row execute function public.set_dex_trade_quote_identity()`,
    );
    const { insertGen8DexTrade } = await import("../evm/evmGen8Store.js");
    const row = {
      chainId: 46630,
      token: `0x${"11".repeat(20)}`,
      hook: `0x${"22".repeat(20)}`,
      txHash: `0x${"33".repeat(32)}`,
      logIndex: 7,
      blockNumber: 133671392,
      blockHash: `0x${"44".repeat(32)}`,
      blockTime: new Date("2026-10-12T14:30:20Z"),
      side: "sell" as const,
      wallet: `0x${"55".repeat(20)}`,
      swapSender: `0x${"66".repeat(20)}`,
      coinRaw: 10n ** 21n,
      curveRaw: 158564328827n,
      feeRaw: 1601660000n,
      feeBps: 100,
      creatorBuyKind: null,
      leagueExcluded: false,
      soldAfterRaw: null,
    };
    assert.equal(await insertGen8DexTrade(pg.pool, row), true);
    assert.equal(await insertGen8DexTrade(pg.pool, row), false, "same log is idempotent");
    const saved = (await pg.pool.query(`select quote_token_address, quote_asset_type, quote_amount_raw, execution_source from public.dex_trades`)).rows[0];
    assert.equal(saved.quote_token_address, "0x52a47a33930b8a90a2000b1ba3cb96e879569670");
    assert.equal(saved.quote_asset_type, "WRAPPED_NATIVE");
    assert.equal(saved.quote_amount_raw, row.curveRaw.toString());
    assert.equal(saved.execution_source, "gen8_v4");
  } finally {
    await pg.stop();
  }
});

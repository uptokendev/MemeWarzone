/**
 * A gen-8 dex swap restates token_stats from the spot and the current price phase, and that coin's
 * gen-8 dex rows show up in /trades. Gen-6, gen-7 and Solana keep the curve_trades query.
 * The latch-back row stays in dex_trades. No RPC: the repair reads evm_gen8_swaps.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";
import { gen8DisplayStats, sqrtAtTick } from "../evm/evmGen8Math.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = fs.existsSync(`${PG16}/initdb`);

const token = `0x${"11".repeat(20)}`;
const hook = `0x${"22".repeat(20)}`;
const other = `0x${"99".repeat(20)}`;
const wallet = `0x${"55".repeat(20)}`;
const tickStart = -200_000;
const tickGrad = -230_000;
const liqA = 10n ** 23n;

test("latch-back sell restates token_stats and joins the trade list; other coins stay on curve_trades", { skip: runnable ? false : "Postgres 16 missing", timeout: 120_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.PG_DISABLE_SSL = "1";
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.LOCAL_DISABLE_ABLY = "1";
  delete process.env.WRAPPED_NATIVE_ADDRESS_46630;
  delete process.env.VITE_WRAPPED_NATIVE_ADDRESS_46630;
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const pg = await startThrowawayPostgres({ port: 55464, extraFiles: gen8SchemaFiles() });
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

    const sqrtBack = (sqrtAtTick(tickStart) + sqrtAtTick(tickGrad)) / 2n;
    const expect = gen8DisplayStats({ liqA, tickStart, tickGrad, sqrtPriceX96: sqrtBack });
    assert.equal(expect.phase, "bonding");
    assert.ok(expect.soldWhole < 850_000_000);

    const { upsertGen8Pool, insertGen8Swap, insertGen8CurveTrade, insertGen8DexTrade } = await import("../evm/evmGen8Store.js");
    const { repairGen8TokenStatsFromSwaps } = await import("../evm/evmGen8Pool.js");
    const { CURVE_TRADE_LIST_SQL, queryTokenTrades } = await import("../tokenTradeList.js");

    await upsertGen8Pool(pg.pool, {
      chainId: 46630, poolId: `0x${"ab".repeat(32)}`, token, hook, launcher: hook, poolManager: hook, creator: wallet,
      hookCreator: null, creatorProfile: null, feeChoice: null, feeCreatorPct: null,
      targetUsd: null, marketCapNative: null, virtualNative: null, virtualToken: null,
      tickStart, tickGrad, liqA, liqB: 1n, fees: { bondingBps: 200, postBps: 100, creatorPostBps: 50, sniperStartBps: 5000, creatorBondingBps: 0 },
      display: null, firstBuyIn: null, firstBuyOut: null, launchTx: `0x${"44".repeat(32)}`, launchBlock: 1,
      launchTime: new Date("2026-10-12T00:00:00Z"), openAt: null, metadata: {},
    });
    await insertGen8Swap(pg.pool, {
      chainId: 46630, hook, poolId: `0x${"ab".repeat(32)}`, token, txHash: `0x${"ab".repeat(32)}`, logIndex: 4,
      blockNumber: 110, blockTime: new Date("2026-10-12T18:00:00Z"), phase: "post", side: "sell",
      sqrtPriceX96: sqrtBack, price: expect.price, mcap: expect.mcap, volume: 0.01, soldRaw: null,
    });
    await pg.pool.query(`alter table public.token_stats add column if not exists change_5m double precision`);
    await pg.pool.query(
      `insert into public.token_stats(chain_id, campaign_address, last_price_bnb, sold_tokens, marketcap_bnb, vol_24h_bnb)
       values (46630, $1, 999, 850000000, 999, 0)`,
      [token],
    );

    assert.equal(await repairGen8TokenStatsFromSwaps(pg.pool, [46630]), 1);
    const stats = (await pg.pool.query(`select last_price_bnb, sold_tokens, marketcap_bnb, change_5m from public.token_stats where chain_id = 46630`)).rows[0];
    assert.ok(Math.abs(Number(stats.last_price_bnb) - expect.price) / expect.price < 1e-9);
    assert.ok(Math.abs(Number(stats.marketcap_bnb) - expect.mcap) / expect.mcap < 1e-9);
    assert.ok(Math.abs(Number(stats.sold_tokens) - expect.soldWhole) < 1e-6);
    assert.ok(Number(stats.sold_tokens) < 850_000_000);
    assert.equal(stats.change_5m, null);

    const curveHash = `0x${"c1".repeat(32)}`;
    const dexHash = `0x${"d1".repeat(32)}`;
    const trade = {
      chainId: 46630, token, hook, blockHash: `0x${"ee".repeat(32)}`, blockTime: new Date("2026-10-12T18:00:00Z"),
      side: "sell" as const, wallet, swapSender: wallet, coinRaw: 10n ** 18n, curveRaw: 10n ** 14n, feeRaw: 1n, feeBps: 100,
      creatorBuyKind: null, leagueExcluded: false, soldAfterRaw: null,
    };
    assert.equal(await insertGen8CurveTrade(pg.pool, { ...trade, txHash: curveHash, logIndex: 1, blockNumber: 100, side: "buy" }), true);
    assert.equal(await insertGen8DexTrade(pg.pool, { ...trade, txHash: dexHash, logIndex: 4, blockNumber: 110 }), true);
    await pg.pool.query(
      `insert into public.dex_trades(
         chain_id, campaign_address, token_address, pair_address, tx_hash, log_index, block_number, block_hash, block_time,
         side, transaction_from, token_amount_raw, native_amount_raw, token_amount, native_amount, price_bnb,
         quote_token_address, execution_source, origin
       ) values (46630, $1, $1, $2, $3, 9, 120, $4, now(), 'sell', $5, '1', '1', 1, 1, 1, $2, 'topaz_v2', 'topaz')`,
      [token, hook, `0x${"f1".repeat(32)}`, `0x${"ff".repeat(32)}`, wallet],
    );

    const listed = await queryTokenTrades(pg.pool, 46630, token, 50);
    const hashes = listed.rows.map((r: { tx_hash: string }) => r.tx_hash);
    assert.deepEqual(hashes, [dexHash, curveHash]);
    const curveOnly = await pg.pool.query(CURVE_TRADE_LIST_SQL, [46630, token, 50]);
    assert.deepEqual(curveOnly.rows.map((r: { tx_hash: string }) => r.tx_hash), [curveHash]);
    assert.equal((await pg.pool.query(`select count(*)::int as n from public.curve_trades where tx_hash = $1`, [dexHash])).rows[0].n, 0);
    assert.equal((await pg.pool.query(`select count(*)::int as n from public.dex_trades where tx_hash = $1`, [dexHash])).rows[0].n, 1);

    await pg.pool.query(
      `insert into public.curve_trades(
         chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet,
         token_amount_raw, bnb_amount_raw, token_amount, bnb_amount, price_bnb, sold_tokens_after_raw
       ) values
         (56, $1, $2, 1, 10, '2026-10-01T00:00:00Z', 'buy', $3, 1000, 10, 1, 0.01, 0.00001, 1000),
         (101, $1, $4, 2, 20, '2026-10-01T00:01:00Z', 'sell', $3, 2000, 20, 2, 0.02, 0.00002, null)`,
      [other, `0x${"61".repeat(32)}`, wallet, `0x${"71".repeat(32)}`],
    );
    for (const chainId of [56, 101]) {
      const legacy = await pg.pool.query(CURVE_TRADE_LIST_SQL, [chainId, other, 50]);
      const via = await queryTokenTrades(pg.pool, chainId, other, 50);
      assert.equal(JSON.stringify(via.rows), JSON.stringify(legacy.rows), `chain ${chainId} trade list changed`);
      assert.equal(via.rows.length, 1);
    }
  } finally {
    await pg.stop();
  }
});

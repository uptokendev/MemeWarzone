// The live EVM candle writer against a throwaway Postgres: it never folds a trade the canonical
// materializer already counted (production 0xe35aea83…: trades_count 3 for 2 trades, volume doubled,
// h = the fee-inclusive fill), it still adds a newer trade, and the API ATH reads price_h.
import assert from "node:assert/strict";
import test from "node:test";

process.env.DBC_THROWAY_PG_PORT ||= "55499";
process.env.ABLY_API_KEY ||= "test:test";
// @ts-ignore -- plain JS helper
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
const db = pg.pool as any;

const {
  EVM_LIVE_CANDLE_READ_SQL,
  EVM_LIVE_CANDLE_UPSERT_SQL,
  EVM_TRADE_CURVE_POSITION_SQL,
  ROBINHOOD_LOCAL_CANDLE_UPSERT_SQL,
} = await import("../evm/evmCandlePrice.js");
const { canonicalCandleVersionFor } = await import("../canonicalCandleMaterializer.js");

const CHAIN = 4663;
const CAMPAIGN = "0xe35aea83ccc7efd0604edc5dfd0962d9f6b7de60";
const BUCKET = new Date("2026-10-10T14:01:00.000Z");
const TX1 = "0x894bc5dbb58beaa430aada5e5198592eb4d9e75d649d532f7850f3b3d57c9171";
const TX2 = "0xc4f147fc9d8c5ddb94f0ebf5a91d9c65da3dec07093f88709b441ee39fdfb6ff";

await db.query(`
  alter table public.token_candles
    add column if not exists last_block_number bigint,
    add column if not exists last_log_index integer,
    add column if not exists price_o numeric, add column if not exists price_h numeric,
    add column if not exists price_l numeric, add column if not exists price_c numeric,
    add column if not exists mcap_o numeric, add column if not exists mcap_h numeric,
    add column if not exists mcap_l numeric, add column if not exists mcap_c numeric,
    add column if not exists source_mask smallint not null default 0,
    add column if not exists bonding_trade_count integer not null default 0,
    add column if not exists bonding_volume_bnb numeric not null default 0;
  alter table public.curve_trades add column if not exists gross_raw numeric, add column if not exists fee_raw numeric;
`);
await db.query(
  `insert into public.curve_trades(chain_id,campaign_address,tx_hash,log_index,block_number,block_time,side,wallet,
     token_amount_raw,bnb_amount_raw,price_bnb,gross_raw,fee_raw) values
   ($1,$2,$3,16,85052193,'2026-10-10T14:01:40Z','buy','0xa','224086367193610437520932','95173185829053',4.2471653684681067e-10,'65850125115238','29323060713815'),
   ($1,$2,$4,12,85052355,'2026-10-10T14:01:57Z','buy','0xb','267967622812168189246132','94225163475931',3.5162891131059547e-10,'78783581501615','15441581974316')`,
  [CHAIN, CAMPAIGN, TX1, TX2],
);

/** The bucket as the canonical materializer left it on production (2 trades, curve spot, last = trade 2). */
async function seedMaterialized() {
  await db.query(`delete from public.token_candles`);
  await db.query(
    `insert into public.token_candles(chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
       bonding_trade_count,last_block_number,last_log_index,price_o,price_h,price_l,price_c)
     values($1,$2,'1m',$3,2.93795088e-10,2.94082367e-10,2.93795088e-10,2.94082367e-10,0.000189398349304984,2,2,85052355,12,
       2.93795088e-10,2.94082367e-10,2.93795088e-10,2.94082367e-10)`,
    [CHAIN, CAMPAIGN, BUCKET],
  );
}

function liveParams(open: number, close: number, vol: number, block: number, log: number, mcapOpen: number | null = null, mcapClose: number | null = null) {
  return [CHAIN, CAMPAIGN, "1m", BUCKET, open, close, vol, block, log, mcapOpen, mcapClose];
}

async function bucket() {
  return (await db.query(EVM_LIVE_CANDLE_READ_SQL, [CHAIN, CAMPAIGN, "1m", BUCKET])).rows[0];
}

test.after(async () => {
  const { pool } = await import("../db.js");
  await (pool as any)?.end?.().catch(() => {});
  await pg.stop();
});

test("a trade the materializer already counted is not folded in again (the 0xe35a race)", async () => {
  await seedMaterialized();
  // The old writer ran this for trade 2 after the materializer: fill price, trade 2's (block, log).
  const r = await db.query(EVM_LIVE_CANDLE_UPSERT_SQL, liveParams(3.5162891131059547e-10, 3.5162891131059547e-10, 0.000094225163475931, 85052355, 12));
  assert.equal(r.rowCount, 0);
  const row = await bucket();
  assert.equal(Number(row.trades_count), 2);
  assert.equal(Number(row.volume_bnb), 0.000189398349304984);
  assert.equal(Number(row.h), 2.94082367e-10);
});

test("an older trade arriving late (backfill) is skipped too", async () => {
  await seedMaterialized();
  const r = await db.query(EVM_LIVE_CANDLE_UPSERT_SQL, liveParams(2.9e-10, 2.9e-10, 0.0001, 85052193, 16));
  assert.equal(r.rowCount, 0);
  assert.equal(Number((await bucket()).trades_count), 2);
});

test("a newer trade in the same bucket is added, with price_* and mcap_* kept fee-free", async () => {
  await seedMaterialized();
  const r = await db.query(EVM_LIVE_CANDLE_UPSERT_SQL, liveParams(2.94082367e-10, 2.95e-10, 0.0001, 85052355, 13, 1.4e-4, 1.5e-4));
  assert.equal(r.rowCount, 1);
  const row = r.rows[0];
  assert.equal(Number(row.trades_count), 3);
  assert.equal(Number(row.price_o), 2.93795088e-10);
  assert.equal(Number(row.price_h), 2.95e-10);
  assert.equal(Number(row.price_c), 2.95e-10);
  assert.equal(Number(row.c), 2.95e-10);
  assert.equal(Number(row.mcap_c), 1.5e-4);
  const stored = await bucket();
  assert.equal(Number(stored.trades_count), 3);
  // Replaying the same trade (rescan, reconnect) changes nothing.
  const again = await db.query(EVM_LIVE_CANDLE_UPSERT_SQL, liveParams(2.94082367e-10, 2.95e-10, 0.0001, 85052355, 13, 1.4e-4, 1.5e-4));
  assert.equal(again.rowCount, 0);
  assert.equal(Number((await bucket()).trades_count), 3);
});

test("a new bucket opens at the pre-trade spot and closes at the post-trade spot", async () => {
  await db.query(`delete from public.token_candles`);
  const r = await db.query(EVM_LIVE_CANDLE_UPSERT_SQL, liveParams(2.93795088e-10, 2.93925865e-10, 0.0000951, 85052193, 16, 0, 6.586e-5));
  const row = r.rows[0];
  assert.equal(Number(row.o), 2.93795088e-10);
  assert.equal(Number(row.h), 2.93925865e-10);
  assert.equal(Number(row.l), 2.93795088e-10);
  assert.equal(Number(row.c), 2.93925865e-10);
  assert.equal(Number(row.price_h), 2.93925865e-10);
  assert.equal(Number(row.trades_count), 1);
});

test("a row an older writer left without (block, log) still takes the next trade", async () => {
  await db.query(`delete from public.token_candles`);
  await db.query(
    `insert into public.token_candles(chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count)
     values($1,$2,'1m',$3,1,1,1,1,1,1)`,
    [CHAIN, CAMPAIGN, BUCKET],
  );
  const r = await db.query(EVM_LIVE_CANDLE_UPSERT_SQL, liveParams(1, 2, 1, 5, 0));
  assert.equal(r.rowCount, 1);
  assert.equal(Number(r.rows[0].trades_count), 2);
  assert.equal(Number(r.rows[0].price_o), 1);
});

test("the Robinhood local scanner's candle write has the same guard", async () => {
  await db.query(`delete from public.token_candles`);
  const args = [CHAIN, CAMPAIGN, "1m", BUCKET, 2.9e-10, 0.0001, 85052355, 12];
  await db.query(ROBINHOOD_LOCAL_CANDLE_UPSERT_SQL, args);
  await db.query(ROBINHOOD_LOCAL_CANDLE_UPSERT_SQL, args);
  const row = (await db.query(`select trades_count,bonding_trade_count,volume_bnb from public.token_candles`)).rows[0];
  assert.equal(Number(row.trades_count), 1);
  assert.equal(Number(row.bonding_trade_count), 1);
  await db.query(ROBINHOOD_LOCAL_CANDLE_UPSERT_SQL, [CHAIN, CAMPAIGN, "1m", BUCKET, 3e-10, 0.0001, 85052356, 0]);
  assert.equal(Number((await db.query(`select trades_count from public.token_candles`)).rows[0].trades_count), 2);
});

test("curve position: net sold through the trade (inclusive) and its gross_raw", async () => {
  const first = (await db.query(EVM_TRADE_CURVE_POSITION_SQL, [CHAIN, CAMPAIGN, 85052193, 16, TX1])).rows[0];
  assert.equal(first.sold_raw, "224086367193610437520932");
  assert.equal(first.gross_raw, "65850125115238");
  const second = (await db.query(EVM_TRADE_CURVE_POSITION_SQL, [CHAIN, CAMPAIGN, 85052355, 12, TX2])).rows[0];
  // = sold() on the campaign contract.
  assert.equal(second.sold_raw, "492053990005778626767064");
  assert.equal(second.gross_raw, "78783581501615");
});

test("API ATH: max(coalesce(price_h, h)) ignores the polluted h; rows without price_h still count", async () => {
  await db.query(`delete from public.token_candles`);
  // The polluted production row: h = trade 2's fill, price_h = curve spot.
  await db.query(
    `insert into public.token_candles(chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,price_h)
     values($1,$2,'1m',$3,2.93795088e-10,3.5162891131059547e-10,2.93795088e-10,2.94082367e-10,0.000283623512780915,3,2.94082367e-10),
           ($1,$2,'1m',$3::timestamptz - interval '1 minute',1e-10,2e-10,1e-10,2e-10,0,1,null)`,
    [CHAIN, CAMPAIGN, BUCKET],
  );
  const r = await db.query(
    `select max(tc.h) as old_ath, max(coalesce(tc.price_h, tc.h)) as new_ath from public.token_candles tc
      where tc.chain_id=$1 and tc.campaign_address=$2 and tc.timeframe='1m'`,
    [CHAIN, CAMPAIGN],
  );
  assert.equal(Number(r.rows[0].old_ath), 3.5162891131059547e-10);
  assert.equal(Number(r.rows[0].new_ath), 2.94082367e-10);
});

test("canonical version: EVM bonding candles rebuild at 5, Solana stays at 4", () => {
  for (const chainId of [56, 97, 4663, 46630]) assert.equal(canonicalCandleVersionFor(chainId), 5);
  assert.equal(canonicalCandleVersionFor(101), 4);
});

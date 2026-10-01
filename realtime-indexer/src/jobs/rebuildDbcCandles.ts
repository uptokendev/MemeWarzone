/**
 * Rebuild a DBC pool's token_candles at pool spot (2026-10-01).
 *
 * Until then DBC candles were drawn at the fill price (fee included; the anti-sniper fee put MWZDNB's
 * first buy at ~2x the pool price) and the launchpad history repair deleted most of them. curve_trades
 * keeps every trade but not the pool price after it, so each swap is read back from the chain
 * (read-only RPC) and its next_sqrt_price gives the spot.
 *
 *   npx tsx src/jobs/rebuildDbcCandles.ts <poolAddress>           # dry run: prints, writes nothing
 *   npx tsx src/jobs/rebuildDbcCandles.ts <poolAddress> --apply   # replaces the pool's candles
 */
import "dotenv/config";
import { pool } from "../db.js";
import {
  dbcCandlesFromTrades,
  dbcMintSupplyWhole,
  dbcSpotNativeAfterSwap,
  decodeEvtSwap2FromTransaction,
  getTransaction,
  loadDbcPools,
} from "../dbcIndexer.js";

const poolAddress = String(process.argv[2] || "").trim();
const apply = process.argv.includes("--apply");

async function main() {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(poolAddress)) throw new Error("usage: rebuildDbcCandles <poolAddress> [--apply]");
  const row = (await loadDbcPools(pool)).find((p) => p.campaign === poolAddress);
  if (!row) throw new Error(`${poolAddress} is not a DBC pool in public.campaigns`);
  const quoteDecimals = Number(row.quoteDecimals ?? 9);
  const trades = await pool.query(
    `select tx_hash, log_index, block_time, side, bnb_amount, bnb_amount_raw, quote_amount_raw, price_bnb
       from public.curve_trades
      where chain_id=101 and campaign_address=$1
      order by block_number asc, log_index asc`,
    [poolAddress],
  );
  const supply = await dbcMintSupplyWhole(row.token);
  const priced: Array<{ tsSec: number; price: number; volume: number }> = [];
  for (const trade of trades.rows) {
    const tx = await getTransaction(String(trade.tx_hash));
    const event = tx ? decodeEvtSwap2FromTransaction(tx)[Number(trade.log_index)] : null;
    const spot = dbcSpotNativeAfterSwap(event, trade, quoteDecimals);
    if (spot == null) throw new Error(`no spot for ${trade.tx_hash}:${trade.log_index}; nothing written`);
    const fill = Number(trade.price_bnb);
    console.log(JSON.stringify({
      tx: String(trade.tx_hash).slice(0, 12), time: new Date(trade.block_time).toISOString(), side: trade.side,
      fillSol: fill, spotSol: spot, fillOverSpot: Number((fill / spot).toFixed(3)),
      mcapAtFillSol: supply ? fill * supply : null, mcapAtSpotSol: supply ? spot * supply : null,
    }));
    priced.push({ tsSec: Math.floor(new Date(trade.block_time).getTime() / 1000), price: spot, volume: Number(trade.bnb_amount) });
  }
  const candles = dbcCandlesFromTrades(priced, supply);
  console.log(`pool ${poolAddress}: ${trades.rows.length} trades -> ${candles.length} candles (mint supply ${supply})`);
  for (const c of candles.filter((x) => x.timeframe === "1m")) console.log("1m", new Date(c.bucketSec * 1000).toISOString(), c.o, c.c, c.trades);
  if (!apply) { console.log("dry run: nothing written (pass --apply to replace the candles)"); return; }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from public.token_candles where chain_id=101 and campaign_address=$1`, [poolAddress]);
    for (const c of candles) {
      await client.query(
        `insert into public.token_candles(chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,mcap_o,mcap_h,mcap_l,mcap_c)
         values (101,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [poolAddress, c.timeframe, new Date(c.bucketSec * 1000), c.o, c.h, c.l, c.c, c.volume, c.trades, ...(c.mcap ?? [null, null, null, null])],
      );
    }
    await client.query("commit");
    console.log(`replaced: ${candles.length} candles written`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

try {
  await main();
} catch (error) {
  console.error("[rebuild-dbc-candles] fatal", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}

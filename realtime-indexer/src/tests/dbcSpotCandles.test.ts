import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const {
  dbcCandlePrice,
  dbcCandlesFromTrades,
  dbcPriceFromSqrt,
  dbcSpotNativeAfterSwap,
  decodeEvtSwap2FromTransaction,
} = await import("../dbcIndexer.js");
const { candleUpsertPayload } = await import("../candlePublish.js");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const source = (rel: string) => readFileSync(join(here, rel), "utf8");
const SUPPLY = 785_258_348.563332;

test("a SOL pool's candle price is the spot after the swap, not the fee-inclusive fill (mainnet MWZDNB)", () => {
  // 14:13:22 buy (v1 tx) and 14:14:39 buy (legacy tx): fills 7.166e-9 and 1.0927e-8 against pool spots
  // 9.8221e-9 and 1.1669e-8, read back from chain 2026-10-01.
  for (const [name, fill, expected] of [["dbc-swap-v1.json", 7.166e-9, 9.8221e-9], ["dbc-swap-legacy.json", 1.0927e-8, 1.1669e-8]] as const) {
    const [event] = decodeEvtSwap2FromTransaction(fixture(name).result);
    const spot = dbcSpotNativeAfterSwap(event, { bnb_amount_raw: "20000000", quote_amount_raw: "20000000" }, 9);
    assert.equal(spot, dbcPriceFromSqrt(event.nextSqrtPrice!, 6, 9));
    assert.ok(Math.abs(spot! - expected) < 1e-12, `${name} spot ${spot}`);
    assert.equal(dbcCandlePrice(spot, fill), spot);
    assert.equal(dbcCandlePrice(null, fill), fill, "fill only when spot is unknown");
  }
  assert.equal(dbcCandlePrice(null, null), null);
  assert.equal(dbcSpotNativeAfterSwap({ nextSqrtPrice: 0n }, { bnb_amount_raw: "1", quote_amount_raw: "1" }, 9), null);
});

test("a bound pool's spot is converted to SOL at the trade's own SOL/USD and quote/USD", () => {
  const sqrt = 2n ** 64n; // 1 raw quote per raw token -> 1 USDC per token at 6/6 decimals
  const usdc = dbcSpotNativeAfterSwap({ nextSqrtPrice: sqrt }, { sol_usd_micros: "200000000", quote_usd_micros: null, bnb_amount_raw: "0", quote_amount_raw: "0" }, 6);
  assert.ok(Math.abs(usdc! - 1 / 200) < 1e-15, "1 USDC at SOL $200 is 0.005 SOL");
  const stock = dbcSpotNativeAfterSwap({ nextSqrtPrice: sqrt }, { sol_usd_micros: "200000000", quote_usd_micros: "180000000", bnb_amount_raw: "0", quote_amount_raw: "0" }, 6);
  assert.ok(Math.abs(stock! - 180 / 200) < 1e-12, "a stock quote uses its own USD price, not $1");
  // Rows read back from curve_trades carry no micros: the trade's own SOL-per-quote ratio stands in.
  const fromRow = dbcSpotNativeAfterSwap({ nextSqrtPrice: sqrt }, { bnb_amount_raw: "5000000", quote_amount_raw: "1000000" }, 6);
  assert.ok(Math.abs(fromRow! - 0.005) < 1e-15);
  assert.equal(dbcSpotNativeAfterSwap({ nextSqrtPrice: sqrt }, { bnb_amount_raw: "0", quote_amount_raw: "0" }, 6), null);
});

test("DBC candles open at the previous close and carry spot x mint supply (MWZDNB 1m, read from chain)", () => {
  const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const rows = dbcCandlesFromTrades([
    { tsSec: t("2026-10-01T14:11:32Z"), price: 4.1136e-9, volume: 0.01 },
    { tsSec: t("2026-10-01T14:11:32Z"), price: 3.9010e-8, volume: 1.75 },
    { tsSec: t("2026-10-01T14:13:16Z"), price: 4.1136e-9, volume: 0.8575 },
    { tsSec: t("2026-10-01T14:13:22Z"), price: 9.8221e-9, volume: 0.0495 },
    { tsSec: t("2026-10-01T14:14:39Z"), price: 1.1669e-8, volume: 0.02 },
    { tsSec: t("2026-10-01T15:14:28Z"), price: 8.2693e-9, volume: 0.0368 },
  ], SUPPLY, ["1m", "1d"]);
  const m1 = rows.filter((r) => r.timeframe === "1m");
  assert.equal(m1.length, 4);
  assert.deepEqual(m1.map((r) => r.trades), [2, 2, 1, 1]);
  for (let i = 1; i < m1.length; i += 1) assert.equal(m1[i].o, m1[i - 1].c, "no gap between buckets");
  // The one sell at 15:14 is one red candle, opening where the last trade left the pool.
  assert.equal(m1[3].o, 1.1669e-8);
  assert.equal(m1[3].c, 8.2693e-9);
  assert.ok(Math.abs(m1[3].mcap![3] - 8.2693e-9 * SUPPLY) < 1e-9);
  const d1 = rows.filter((r) => r.timeframe === "1d");
  assert.equal(d1.length, 1);
  assert.equal(d1[0].trades, 6);
  assert.equal(d1[0].h, 3.9010e-8);
  assert.equal(dbcCandlesFromTrades([{ tsSec: 1, price: 1, volume: 0 }], null, ["1m"])[0].mcap, null);
});

test("insertDbcSwap draws candles at spot with mint supply, and the stats use the same spot", () => {
  const src = source("../dbcIndexer.ts");
  assert.match(src, /const candlePrice = dbcCandlePrice\(spotNative, row\.price_bnb\)/);
  assert.match(src, /upsertCandle\(db, row\.campaign_address, tf, bucketStart\(tsSec, tf\), candlePrice, row\.bnb_amount, supplyWhole\)/);
  assert.match(src, /patchStats\(db, row\.campaign_address, \{ spotSol: spotNative, supplyWhole \}\)/);
  assert.match(src, /select coalesce\(\(select c from prev\), \$5::numeric\) as o/);
});

test("candle_upsert carries market cap when the writer stored it, and stays price-only otherwise", () => {
  const withMcap = candleUpsertPayload("1m", 60, { o: 1, h: 2, l: 1, c: 2, volume_bnb: 1, trades_count: 1, mcap_o: 10, mcap_h: 20, mcap_l: 10, mcap_c: 20 }) as any;
  assert.equal(withMcap.mcap_o, "10");
  assert.equal(withMcap.mcap_c, "20");
  const priceOnly = candleUpsertPayload("1m", 60, { o: 1, h: 2, l: 1, c: 2, volume_bnb: 1, trades_count: 1, mcap_o: null, mcap_h: null, mcap_l: null, mcap_c: null }) as any;
  assert.equal("mcap_o" in priceOnly, false);
});

test("the launchpad history repair never touches a DBC pool (it deleted MWZDNB's candles)", () => {
  const src = source("../solanaIndexer.ts");
  assert.match(src, /async function isDbcCampaign\(campaign: string\)/);
  const rebuild = src.slice(src.indexOf("export async function rebuildSolanaDerivedFromTrades"));
  assert.match(rebuild.slice(0, 400), /if \(await isDbcCampaign\(normalized\)\) return \{ trades: 0, candles: 0 \};/);
  const backfill = src.slice(src.indexOf("export async function backfillSolanaCampaign"));
  assert.ok(backfill.indexOf("isDbcCampaign(campaign)") < backfill.indexOf("loadSolanaHistoryMeta(campaign)"));
  const tip = src.slice(src.indexOf("export async function ingestSolanaCampaignTip"));
  assert.ok(tip.indexOf("isDbcCampaign(campaign)") > 0 && tip.indexOf("isDbcCampaign(campaign)") < tip.indexOf("getSignaturesForAddress"));
  const repair = src.slice(src.indexOf("export async function repairKnownSolanaCampaignHistory"));
  assert.match(repair.slice(0, 1200), /coalesce\(launch_type, 'launchpad'\) <> 'dbc'/);
  assert.match(src, /and a\.tx_hash=b\.tx_hash\s+and coalesce\(a\.venue,''\) <> 'dbc'/);
});

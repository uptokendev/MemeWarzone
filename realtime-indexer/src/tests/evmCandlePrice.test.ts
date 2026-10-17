// Live EVM bonding candles draw the fee-free curve price, not the fee-inclusive fill.
// Numbers are the Robinhood mainnet coin 0xe35aea83ccc7efd0604edc5dfd0962d9f6b7de60 (gen-7, chain 4663):
// curve params read from the campaign, trades and materialized candles read from production (read-only).
import assert from "node:assert/strict";
import test from "node:test";
import { evmCurveCandlePrice } from "../evm/evmCandlePrice.js";
import { candleUpsertPayload } from "../candlePublish.js";

const params = { kind: "cp" as const, virtualNative: 295900092988160724n, virtualToken: 1007164874618250302625982734n };
const TRADE1 = { tokenRaw: 224086367193610437520932n, gross: 65850125115238n, fill: 4.2471653684681067e-10 };
const TRADE2 = { tokenRaw: 267967622812168189246132n, gross: 78783581501615n, fill: 3.5162891131059547e-10 };

test("a gen-7 buy's candle is curve spot before and after it, matching the materializer's price_o/price_c", () => {
  const first = evmCurveCandlePrice({
    side: "buy",
    tokenRaw: TRADE1.tokenRaw,
    postSoldRaw: TRADE1.tokenRaw,
    params,
    grossRaw: TRADE1.gross,
    fillPrice: TRADE1.fill,
  });
  const second = evmCurveCandlePrice({
    side: "buy",
    tokenRaw: TRADE2.tokenRaw,
    postSoldRaw: TRADE1.tokenRaw + TRADE2.tokenRaw,
    params,
    grossRaw: TRADE2.gross,
    fillPrice: TRADE2.fill,
  });
  assert.equal(first?.source, "spot");
  // token_candles.price_o / price_c on production for the 14:01 bucket.
  assert.equal(first?.open, 2.93795088e-10);
  assert.equal(second?.close, 2.94082367e-10);
  assert.equal(second?.open, first?.close);
  // token_stats.marketcap_bnb on production: spot x sold.
  assert.equal(second?.mcapClose, 0.00014470440207269372);
  // The fills (fee 44.53% and 19.60%) sat 44% and 20% above that.
  assert.ok(TRADE1.fill > (first?.close ?? 0) * 1.4);
  assert.ok(TRADE2.fill > (second?.close ?? 0) * 1.19);
});

test("a sell's candle opens at the pre-sell spot (higher) and closes at the post-sell spot", () => {
  const sold = TRADE1.tokenRaw + TRADE2.tokenRaw;
  const sell = evmCurveCandlePrice({
    side: "sell",
    tokenRaw: TRADE2.tokenRaw,
    postSoldRaw: sold - TRADE2.tokenRaw,
    params,
    grossRaw: null,
    fillPrice: 1e-10,
  });
  assert.equal(sell?.source, "spot");
  assert.equal(sell?.open, 2.94082367e-10);
  assert.equal(sell?.close, 2.93925865e-10);
});

test("without curve params the candle uses gross_raw / tokens, the fill without the fee", () => {
  const candle = evmCurveCandlePrice({
    side: "buy",
    tokenRaw: TRADE2.tokenRaw,
    postSoldRaw: null,
    params: null,
    grossRaw: TRADE2.gross,
    fillPrice: TRADE2.fill,
  });
  assert.equal(candle?.source, "gross");
  assert.equal(candle?.open, candle?.close);
  assert.ok(Math.abs((candle?.close ?? 0) - 2.94004106e-10) < 1e-18);
  assert.equal(candle?.mcapClose, null);
});

test("with neither, the stored fill is kept (older generations, no annotation); nothing at all gives null", () => {
  const fill = evmCurveCandlePrice({ side: "buy", tokenRaw: 1n, postSoldRaw: null, params: null, grossRaw: null, fillPrice: 0.5 });
  assert.deepEqual(fill, { open: 0.5, close: 0.5, mcapOpen: null, mcapClose: null, source: "fill" });
  assert.equal(evmCurveCandlePrice({ side: "buy", tokenRaw: 1n, postSoldRaw: null, params: null, grossRaw: null, fillPrice: null }), null);
});

test("a curve that answers zero spot falls back to gross instead of drawing a zero candle", () => {
  const candle = evmCurveCandlePrice({
    side: "buy",
    tokenRaw: 10n,
    postSoldRaw: 10n,
    params: { kind: "cp", virtualNative: 0n, virtualToken: 0n },
    grossRaw: 20n,
    fillPrice: 3,
  });
  assert.equal(candle?.source, "gross");
  assert.equal(candle?.close, 2);
});

test("candle_upsert carries price_* when the row has them, and omits them otherwise", () => {
  const withPrice = candleUpsertPayload("1m", 60, {
    o: 1, h: 2, l: 1, c: 2, volume_bnb: 1, trades_count: 1,
    price_o: 1, price_h: 2, price_l: 1, price_c: 2,
  });
  assert.equal(withPrice.price_o, "1");
  assert.equal(withPrice.price_h, "2");
  assert.equal(withPrice.price_c, "2");
  const without = candleUpsertPayload("1m", 60, { o: 1, h: 2, l: 1, c: 2, volume_bnb: 1, trades_count: 1, price_o: null });
  assert.equal("price_o" in without, false);
  assert.equal("price_c" in without, false);
});

test("indexer.ts: every curve trade path draws the candle from evmTradeCandlePrice through the guarded upsert", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../indexer.ts", import.meta.url), "utf8");
  assert.equal((src.match(/await evmTradeCandlePrice\(/g) || []).length, 3);
  assert.equal((src.match(/await upsertCandle\([^)]*\bcandle\b/g) || []).length, 3);
  assert.doesNotMatch(src, /upsertCandle\([^)]*priceBnb/);
  assert.match(src, /pool\.query\(EVM_LIVE_CANDLE_UPSERT_SQL, params\)/);
  const materializer = readFileSync(new URL("../canonicalCandleMaterializer.ts", import.meta.url), "utf8");
  assert.match(materializer, /canonical_version,0\) < case when t\.chain_id = 101 then \$3::int else \$2::int end/);
  assert.match(materializer, /canonicalCandleVersionFor\(chainId\),\n    \],/);
});

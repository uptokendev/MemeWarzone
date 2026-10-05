import test from "node:test";
import assert from "node:assert/strict";
import { mergeTradesIntoUsdCandles } from "./importChartPresentation.mjs";

const candles = [
  { bucket_start: "2026-10-05T15:45:00.000Z", o: "0.00005", h: "0.00005", l: "0.00005", c: "0.00005", mcap_o: "48000", mcap_h: "48000", mcap_l: "48000", mcap_c: "48000", volume_usd: "1" },
  { bucket_start: "2026-10-05T16:00:00.000Z", o: "0.00005", h: "0.00005", l: "0.0000499", c: "0.0000499", mcap_o: "48000", mcap_h: "48000", mcap_l: "47904", mcap_c: "47904", volume_usd: "0.1" },
];
const at = (iso) => Date.parse(iso) / 1000;

test("a trade inside the last candle moves its close, high and market cap", () => {
  const out = mergeTradesIntoUsdCandles(candles, [{ volumeUsd: 0.12, tokenAmount: 2000, blockTime: at("2026-10-05T16:05:00Z") }], "15m");
  assert.equal(out.length, 2);
  assert.ok(Math.abs(Number(out[1].c) - 0.00006) < 1e-15);
  assert.ok(Math.abs(Number(out[1].h) - 0.00006) < 1e-15);
  assert.ok(Math.abs(Number(out[1].mcap_c) - 0.00006 * (47904 / 0.0000499)) < 1e-6);
  assert.equal(candles[1].c, "0.0000499", "the input is not changed");
});

test("a later trade opens a new candle from the previous close", () => {
  const out = mergeTradesIntoUsdCandles(candles, [{ volumeUsd: 0.1, tokenAmount: 2500, blockTime: at("2026-10-05T16:20:00Z") }], "15m");
  assert.equal(out.length, 3);
  assert.equal(out[2].bucket_start, "2026-10-05T16:15:00.000Z");
  assert.equal(out[2].o, "0.0000499");
  assert.ok(Math.abs(Number(out[2].c) - 0.00004) < 1e-15);
});

test("older trades, trades without a USD value and unknown resolutions are ignored", () => {
  assert.equal(mergeTradesIntoUsdCandles(candles, [{ volumeUsd: 1, tokenAmount: 1, blockTime: at("2026-10-05T15:00:00Z") }], "15m").length, 2);
  assert.equal(mergeTradesIntoUsdCandles(candles, [{ volumeUsd: null, tokenAmount: 5, blockTime: at("2026-10-05T16:20:00Z") }], "15m").length, 2);
  assert.equal(mergeTradesIntoUsdCandles(candles, [{ volumeUsd: 1, tokenAmount: 1, blockTime: at("2026-10-05T16:20:00Z") }], "2h"), candles);
});

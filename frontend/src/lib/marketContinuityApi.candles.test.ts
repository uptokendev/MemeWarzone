import assert from "node:assert/strict";
import test from "node:test";
import { parseMarketCandlePayload } from "./marketCandlePayload.ts";

test("durable /candles array payload is accepted", () => {
  const parsed = parseMarketCandlePayload([
    { bucket_start: "2026-08-23T20:07:00.000Z", mcap_o: "0", mcap_c: "0.0012", trades_count: 1 },
  ]);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.mcap_o, "0");
});

test("Solana /candles envelope payload is accepted", () => {
  const parsed = parseMarketCandlePayload({
    items: [{ bucket_start: "2026-08-23T10:47:00.000Z", mcap_o: "0", mcap_c: "0.04", trades_count: 1 }],
    historyComplete: true,
    serverTime: "2026-08-23T12:00:00.000Z",
  });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.serverTime, "2026-08-23T12:00:00.000Z");
});

test("empty or unknown payload does not throw", () => {
  assert.equal(parseMarketCandlePayload(null).items.length, 0);
  assert.equal(parseMarketCandlePayload({ ok: true }).items.length, 0);
});

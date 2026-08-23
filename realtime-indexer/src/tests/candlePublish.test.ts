import assert from "node:assert/strict";
import test from "node:test";
import { candleUpsertPayload } from "../candlePublish.js";

test("candle upsert carries full OHLCV and trade count", () => {
  const msg = candleUpsertPayload("1m", 1_750_000_000, {
    o: 1,
    h: 3,
    l: 0.5,
    c: 2,
    volume_bnb: 4.25,
    trades_count: 7,
  });
  assert.equal(msg.type, "candle_upsert");
  assert.equal(msg.tf, "1m");
  assert.equal(msg.bucket, 1_750_000_000);
  assert.equal(msg.o, "1");
  assert.equal(msg.h, "3");
  assert.equal(msg.l, "0.5");
  assert.equal(msg.c, "2");
  assert.equal(msg.v, "4.25");
  assert.equal(msg.volume_bnb, "4.25");
  assert.equal(msg.trades_count, 7);
  assert.equal(msg.open, "1");
  assert.equal(msg.close, "2");
});

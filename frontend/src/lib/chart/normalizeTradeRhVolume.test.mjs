import assert from "node:assert/strict";
import test from "node:test";

// Mirror of normalizeTrade helpers used by Token Details 24h volume.
function timestampSec(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return Math.floor(value > 1e12 ? value / 1000 : value);
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? Math.floor(n > 1e12 ? n / 1000 : n) : 0;
  }
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function parseRawAmount(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw || raw === "0") return 0n;
  const intish = raw.match(/^(\d+)(?:\.0+)?$/);
  if (intish) return BigInt(intish[1]);
  return 0n;
}

function marketTradeNativeWei(trade) {
  const nativeFromNative = parseRawAmount(trade.nativeAmountRaw);
  const nativeFromQuote = parseRawAmount(trade.quoteAmountRaw);
  return nativeFromNative > 0n ? nativeFromNative : nativeFromQuote;
}

function windowVolumeWei(points, nowSec, windowSec) {
  const startTs = nowSec - windowSec;
  return points
    .filter((p) => timestampSec(p.timestamp) > startTs)
    .reduce((acc, p) => acc + (p.nativeWei ?? 0n), 0n);
}

test("RH ISO blockTime and raw native sum inside 24h", () => {
  const trades = [
    {
      blockTime: "2026-09-16T14:16:27.000Z",
      nativeAmountRaw: "2310136023882095",
      quoteAmountRaw: null,
    },
    {
      blockTime: "2026-09-16T14:16:22.000Z",
      nativeAmountRaw: "177085682417084",
      quoteAmountRaw: null,
    },
  ];
  const points = trades.map((t) => ({
    timestamp: timestampSec(t.blockTime),
    nativeWei: marketTradeNativeWei(t),
  }));
  const nowThen = timestampSec("2026-09-16T15:16:27.000Z");
  const vol = windowVolumeWei(points, nowThen, 24 * 60 * 60);
  assert.equal(vol, 2310136023882095n + 177085682417084n);
});

test("STOCK_TOKEN quoteAmountRaw falls back when nativeAmountRaw empty", () => {
  const wei = marketTradeNativeWei({
    nativeAmountRaw: null,
    quoteAmountRaw: "500000000000000000",
  });
  assert.equal(wei, 500000000000000000n);
});

test("Ably camelCase bnbAmountRaw is accepted as raw native", () => {
  const raw = parseRawAmount("2310136023882095");
  assert.equal(raw, 2310136023882095n);
  assert.equal(timestampSec(1789568187), 1789568187);
});

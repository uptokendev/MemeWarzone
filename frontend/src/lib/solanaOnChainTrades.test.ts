import assert from "node:assert/strict";
import test from "node:test";
import { decodeSolanaTradeEvents, decodedTradeToPoint } from "./solanaOnChainTrades.ts";

const BUY_DISC = Buffer.from("9794ade2801ef9be", "hex");
const SELL_DISC = Buffer.from("d953448986e15e2d", "hex");
const FEE_DISC = Buffer.from("a052efc1216d9fac", "hex");
const CAMPAIGN = Buffer.alloc(32, 1);
const TRADER = Buffer.alloc(32, 2);

function u64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function programLine(parts: Buffer[]): string {
  return `Program data: ${Buffer.concat(parts).toString("base64")}`;
}

test("TokensBought after a fee event keeps indexer logIndex=1", () => {
  const buy = Buffer.concat([
    BUY_DISC,
    CAMPAIGN,
    TRADER,
    u64(10_000_000),
    u64(30_000),
    u64(9_970_000),
    u64(1_500_000),
    u64(1_500_000),
    u64(9_970_000),
  ]);
  const fee = Buffer.concat([FEE_DISC, Buffer.alloc(122, 0)]);
  const trades = decodeSolanaTradeEvents(
    [programLine([fee]), programLine([buy])],
    undefined,
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, "TokensBought");
  assert.equal(trades[0].eventIndex, 1);
  assert.equal(trades[0].tokenRaw, 1_500_000n);
  assert.equal(trades[0].nativeRaw, 10_000_000n);
  assert.equal(trades[0].soldTokensAfter, 1_500_000n);
});

test("TokensSold uses net lamports out and sold_tokens_after", () => {
  const sell = Buffer.concat([
    SELL_DISC,
    CAMPAIGN,
    TRADER,
    u64(2_000_000),
    u64(8_000_000),
    u64(24_000),
    u64(7_976_000),
    u64(500_000),
    u64(2_000_000),
  ]);
  const trades = decodeSolanaTradeEvents([programLine([sell])]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, "TokensSold");
  assert.equal(trades[0].eventIndex, 0);
  assert.equal(trades[0].tokenRaw, 2_000_000n);
  assert.equal(trades[0].nativeRaw, 7_976_000n);
  const point = decodedTradeToPoint(
    trades[0],
    "2q4BvTSP3Q1iZ3JLz3tLgq437i1ARgAjxXFRzFGnfQpKpUEhkHyU1PKM1z9kUWDXFaWRuoidFHcCjgJYPVju66mR",
    441143297,
    1787482856,
  );
  assert.equal(point?.type, "sell");
  assert.equal(point?.logIndex, 0);
  assert.equal(point?.soldTokensAfterRaw, 500_000n);
});

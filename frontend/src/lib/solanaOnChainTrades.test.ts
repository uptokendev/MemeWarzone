import assert from "node:assert/strict";
import test from "node:test";
import { decodeSolanaTradeEvents, decodedTradeToPoint, selectSolanaSignaturesToFetch } from "./solanaOnChainTrades.ts";

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

test("mint-route decode still returns the PDA TokensBought event", () => {
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
  const trades = decodeSolanaTradeEvents(
    [programLine([buy])],
    "5h4qpe8Z6SLhVezum7gdkyMBBXHqNa68BbsU9XC2scbo",
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, "TokensBought");
});

test("tip reconcile fetches a later signature the indexer already partially knows", () => {
  const first = "heWs9aJGiKrEgDhQ1pLhabmV7pehtTiz7pP3ZqopaEVxYTCVtpEGpd1pFvr56bjxXCuMBnvocznKwexR4DJqHqP";
  const second = "3oZaXc5EAodXDH6qaZK9Pftds1DjVD8vkizRFU6zJppA272F5hk7xfpZcGpULbZXMySC26C3WdE4tFXiQ939BtXz";
  const missing = selectSolanaSignaturesToFetch({
    signatures: [
      { signature: second, slot: 441256954, err: null },
      { signature: first, slot: 441223620, err: null },
    ],
    knownTxHashes: [first],
    minSlot: 441223620,
  });
  assert.deepEqual(missing.map((item) => item.signature), [second]);
});

test("one chain check keeps later ALMOST buy even if a newer fee signature is first", () => {
  const first = "heWs9aJGiKrEgDhQ1pLhabmV7pehtTiz7pP3ZqopaEVxYTCVtpEGpd1pFvr56bjxXCuMBnvocznKwexR4DJqHqP";
  const second = "3oZaXc5EAodXDH6qaZK9Pftds1DjVD8vkizRFU6zJppA272F5hk7xfpZcGpULbZXMySC26C3WdE4tFXiQ939BtXz";
  const fee = "5x4iy7vmQJBeTP6VL7bNPGUMnawdKYaUBR1ShEtRadNFWzHk9gvYEfiNkmixuUHB3tTLed7oRbwNaaVEfcbawwby";
  const missing = selectSolanaSignaturesToFetch({
    signatures: [
      { signature: fee, slot: 441258513, err: null },
      { signature: second, slot: 441256954, err: null },
      { signature: first, slot: 441223620, err: null },
    ],
    knownTxHashes: [first],
    minSlot: 441223620,
    maxFetch: 8,
  });
  assert.equal(missing.some((item) => item.signature === second), true);
  assert.equal(missing.some((item) => item.signature === first), false);
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

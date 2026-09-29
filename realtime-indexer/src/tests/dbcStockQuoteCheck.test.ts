import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const { mintPaused } = await import("../dbc/dbcStockQuoteCheck.js");

function tlv(type: number, body: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
}

test("the pause flag is read from extension 26, after the 32-byte authority", () => {
  const authority = Buffer.alloc(32, 7);
  const hookBody = Buffer.alloc(64); // TransferHook (14), unrelated
  assert.equal(mintPaused(Buffer.concat([tlv(14, hookBody), tlv(26, Buffer.concat([authority, Buffer.from([1])]))])), true);
  assert.equal(mintPaused(Buffer.concat([tlv(14, hookBody), tlv(26, Buffer.concat([authority, Buffer.from([0])]))])), false);
  assert.equal(mintPaused(tlv(14, hookBody)), false);
});

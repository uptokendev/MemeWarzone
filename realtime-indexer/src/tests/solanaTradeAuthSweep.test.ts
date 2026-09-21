import assert from "node:assert/strict";
import test from "node:test";
import {
  TRADE_AUTHORIZATION_BYTES,
  TRADE_AUTHORIZATION_DISC,
  chunk,
  decodeTradeAuthorization,
  selectExpiredAuthorizations,
} from "../solanaTradeAuthSweep.js";

function account(input: { trader?: number; deadline: number; usedAt?: number; disc?: Buffer; size?: number }) {
  const data = Buffer.alloc(input.size ?? TRADE_AUTHORIZATION_BYTES);
  (input.disc ?? TRADE_AUTHORIZATION_DISC).copy(data, 0);
  data.fill(input.trader ?? 7, 8, 40); // trader
  data.fill(9, 40, 72); // campaign
  data[72] = 1; // side = sell
  data.fill(0xab, 73, 105); // nonce
  data.writeBigInt64LE(BigInt(input.deadline), 105);
  data.writeBigInt64LE(BigInt(input.usedAt ?? 0), 113);
  return data;
}

test("decodes trader, nonce, deadline and used_at from the Anchor layout", () => {
  const decoded = decodeTradeAuthorization("pda", account({ trader: 3, deadline: 1_700_000_000, usedAt: 1_699_999_990 }), 1_605_280);
  assert.ok(decoded);
  assert.equal(decoded.traderBytes.length, 32);
  assert.equal(decoded.traderBytes[0], 3);
  assert.equal(decoded.campaignBytes[31], 9);
  assert.equal(decoded.side, 1);
  assert.equal(decoded.nonce.length, 32);
  assert.equal(decoded.nonce[0], 0xab);
  assert.equal(decoded.deadline, 1_700_000_000);
  assert.equal(decoded.usedAt, 1_699_999_990);
  assert.equal(decoded.lamports, 1_605_280);
});

test("rejects accounts of another type or size instead of guessing", () => {
  assert.equal(decodeTradeAuthorization("x", account({ deadline: 1, disc: Buffer.alloc(8, 1) }), 0), null);
  assert.equal(decodeTradeAuthorization("x", account({ deadline: 1, size: TRADE_AUTHORIZATION_BYTES + 1 }), 0), null);
  assert.equal(decodeTradeAuthorization("x", Buffer.alloc(0), 0), null);
});

test("only authorizations past deadline plus grace are swept, oldest first", () => {
  const now = 10_000;
  const items = [
    { address: "fresh", deadline: now + 100 },
    { address: "just-expired", deadline: now - 10 }, // inside the 30 s grace
    { address: "old", deadline: now - 3_600 },
    { address: "older", deadline: now - 7_200 },
  ];
  assert.deepEqual(
    selectExpiredAuthorizations(items, now).map((item) => item.address),
    ["older", "old"],
  );
  assert.deepEqual(
    selectExpiredAuthorizations(items, now, 0).map((item) => item.address),
    ["older", "old", "just-expired"],
  );
});

test("closes are batched a few per transaction", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
});

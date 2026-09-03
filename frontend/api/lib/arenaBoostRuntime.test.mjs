import assert from "node:assert/strict";
import test from "node:test";

import {
  boostSummary,
  expectedBoostSplit,
  resolveBattleSide,
  serializeBoostSummary,
  validateConfirmedBoost,
} from "./arenaBoostRuntime.mjs";

test("Boost split keeps integer dust in prize while preserving exact conservation", () => {
  for (const gross of [1n, 2n, 9n, 10n, 11n, 99n, 101n, 10_001n, 999_999n]) {
    const split = expectedBoostSplit(gross);
    assert.equal(split.pool + split.protocol, gross);
    assert.equal(split.protocol, (gross * 1_000n) / 10_000n);
  }
});

test("confirmed Boost rejects client-shaped split drift", () => {
  assert.deepEqual(validateConfirmedBoost({ boostUnits: 3, grossNativeRaw: 101, poolNativeRaw: 91, protocolNativeRaw: 10 }), {
    boostUnits: 3n,
    gross: 101n,
    pool: 91n,
    protocol: 10n,
  });
  assert.throws(
    () => validateConfirmedBoost({ boostUnits: 3, grossNativeRaw: 101, poolNativeRaw: 90, protocolNativeRaw: 11 }),
    /exactly 90% prize \/ 10% protocol/,
  );
  assert.throws(() => validateConfirmedBoost({ boostUnits: 0, grossNativeRaw: 101, poolNativeRaw: 91, protocolNativeRaw: 10 }), /positive/);
});

test("side resolution only accepts an actual combatant token", () => {
  const participants = [
    { tokenId: "0xABC" },
    { tokenAddress: "0xDEF" },
  ];
  assert.equal(resolveBattleSide(participants, "0xabc"), "left");
  assert.equal(resolveBattleSide(participants, "0xDEF"), "right");
  assert.equal(resolveBattleSide(participants, "0xBAD"), null);
});

test("summary aggregates confirmed rows without converting raw native values to Number", () => {
  const rows = [
    { side: "left", boost_units: "2", gross_native_raw: "100000000000000001", pool_native_raw: "90000000000000001", protocol_native_raw: "10000000000000000" },
    { side: "right", boost_units: "1", gross_native_raw: "100", pool_native_raw: "90", protocol_native_raw: "10" },
    { side: "left", boost_units: "4", gross_native_raw: "200", pool_native_raw: "180", protocol_native_raw: "20" },
  ];
  const summary = serializeBoostSummary(boostSummary(rows));
  assert.deepEqual(summary.left, {
    boostUnits: "6",
    grossNativeRaw: "100000000000000201",
    poolNativeRaw: "90000000000000181",
    protocolNativeRaw: "10000000000000020",
  });
  assert.equal(summary.total.boostUnits, "7");
  assert.equal(summary.total.grossNativeRaw, "100000000000000301");
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildActivity, buildBoostSummary, buildSupporters, commentFromRow, nativeDecimals, normalizeBattleComment, rawToNative } from "./arenaBattleActivity.js";

test("comments are one line, 1..280 characters", () => {
  assert.equal(normalizeBattleComment("  gm \n\n  both camps ").text, "gm both camps");
  assert.equal(normalizeBattleComment("   ").code, "BATTLE_COMMENT_EMPTY");
  assert.equal(normalizeBattleComment("x".repeat(281)).code, "BATTLE_COMMENT_TOO_LONG");
});

test("native amounts per chain", () => {
  assert.equal(nativeDecimals(101), 9);
  assert.equal(nativeDecimals(56), 18);
  assert.equal(rawToNative("250000000", 9), 0.25);
  assert.equal(rawToNative("1500000000000000000", 18), 1.5);
  assert.equal(rawToNative("bad", 9), 0);
});

test("activity: boosts one by one, votes grouped per 10 minutes, newest first", () => {
  const list = buildActivity({
    decimals: 9,
    boosts: [{ id: 7, at: "2026-10-02T10:05:00Z", side: "right", wallet: "8rEc", boost_units: 2, gross_native_raw: "250000000" }],
    voteBuckets: [{ side: "left", bucket: Math.floor(Date.parse("2026-10-02T10:12:00Z") / 600000), n: 14 }, { side: "left", bucket: 1, n: 0 }],
  });
  assert.deepEqual(list.map((e) => e.kind), ["votes", "boost"]);
  assert.equal(list[0].count, 14);
  assert.equal(list[1].amountNative, 0.25);
  assert.equal(list[1].side, "right");
});

test("supporters and boost summary", () => {
  assert.deepEqual(buildSupporters([{ wallet: "w1", side: "left", boosts: 3, gross_native_raw: "420000000" }], 9), [{ rank: 1, wallet: "w1", side: "left", boosts: 3, amountNative: 0.42 }]);
  const s = buildBoostSummary([{ side: "left", boosts: 2, gross_native_raw: "300000000", pool_native_raw: "270000000" }, { side: "right", boosts: 1, gross_native_raw: "100000000", pool_native_raw: "90000000" }], 9);
  assert.equal(s.total.boosts, 3);
  assert.ok(Math.abs(s.total.poolNative - 0.36) < 1e-9);
});

test("comment rows carry the author's voted side when there is one", () => {
  assert.equal(commentFromRow({ id: 1, created_at: "2026-10-02T10:00:00Z", author_wallet: "w", body: "hi", side: "left" }).side, "left");
  assert.equal(commentFromRow({ id: 1, created_at: "2026-10-02T10:00:00Z", author_wallet: "w", body: "hi", side: null }).side, null);
});

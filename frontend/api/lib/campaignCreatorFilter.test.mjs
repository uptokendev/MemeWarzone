import assert from "node:assert/strict";
import test from "node:test";

import { creatorMatchSql, normalizeCreatorQuery, walletsEqual } from "./campaignCreatorFilter.js";

test("normalizeCreatorQuery trims and keeps Solana case", () => {
  assert.equal(normalizeCreatorQuery("  4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77  "), "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77");
  assert.equal(normalizeCreatorQuery(""), null);
  assert.equal(normalizeCreatorQuery("   "), null);
});

test("creator SQL matches exact and lower() so historical EVM rows still hit", () => {
  const sql = creatorMatchSql("c.creator_address", 13);
  assert.match(sql, /\$13::text is null/);
  assert.match(sql, /c\.creator_address = \$13/);
  assert.match(sql, /lower\(c\.creator_address\) = lower\(\$13\)/);
});

test("walletsEqual preserves Solana equality and allows case-insensitive EVM", () => {
  const sol = "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77";
  assert.equal(walletsEqual(sol, sol), true);
  assert.equal(walletsEqual("0xABC", "0xabc"), true);
  assert.equal(walletsEqual("aaa", "bbb"), false);
});

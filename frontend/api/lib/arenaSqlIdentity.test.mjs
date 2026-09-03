import assert from "node:assert/strict";
import test from "node:test";

import { arenaSqlIdentityEquals } from "./arenaSqlIdentity.js";
import { resolveArenaVoteToken } from "./arenaEligibility.js";

test("Arena SQL identity preserves Solana Base58 case", () => {
  const predicate = arenaSqlIdentityEquals(101, "token_address", "$2");
  assert.equal(predicate, "coalesce(token_address, '') = $2");
  assert.doesNotMatch(predicate, /lower\(/i);
});

test("Arena SQL identity keeps EVM lookup case-insensitive", () => {
  const predicate = arenaSqlIdentityEquals(56, "token_address", "$2");
  assert.equal(predicate, "lower(coalesce(token_address, '')) = lower($2)");
});

test("Arena eligibility uses exact Solana identity for native and imported tokens", async () => {
  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [] };
    },
  };
  await resolveArenaVoteToken(pool, 101, "AbCdEfGhijkLmnoPqrstUvwxYZ123456789ABCDE");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /coalesce\(token_address::text, ''\) = \$2/);
  assert.match(calls[0], /coalesce\(campaign_address::text, ''\) = \$2/);
  assert.match(calls[1], /coalesce\(token_address, ''\) = \$2/);
  assert.doesNotMatch(calls.join("\n"), /lower\(/i);
});

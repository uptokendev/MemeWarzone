import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { liveArenaVotes24hJoin, liveVoteWindowsJoin } from "./liveVoteWindows.js";

const norm = (sql) => sql.replace(/\s+/g, " ");

test("the recount uses the windows and 1 / 0.5 / 0.25 trending weights patchVoteAggregates writes", () => {
  const sql = norm(liveVoteWindowsJoin("va.chain_id", "va.campaign_address"));
  const writer = norm(fs.readFileSync(new URL("../votes-ingest.js", import.meta.url), "utf8"));
  for (const window of ["1 hour", "24 hours", "48 hours", "72 hours"]) {
    assert.ok(sql.includes(`interval '${window}'`) && writer.includes(`interval '${window}'`), window);
  }
  assert.match(writer, /coalesce\(b0,0\) \* 1\.0 \+ coalesce\(b1,0\) \* 0\.5 \+ coalesce\(b2,0\) \* 0\.25/);
  assert.match(sql, /\* 1\.0 .*\* 0\.5 .*\* 0\.25/);
  assert.match(sql, /lv\.status = 'confirmed'/);
  // EVM rows are stored lowercase, Solana rows as given: match both like the two ingest paths do.
  assert.match(sql, /lv\.campaign_address = va\.campaign_address OR lower\(lv\.campaign_address\) = lower\(va\.campaign_address\)/);
});

test("every reader of the vote windows takes them from the recount, not the stored columns", () => {
  for (const file of ["../featured.js", "../campaigns-base.js", "../vote_counts.js", "../warRoom.js"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /liveVoteWindowsJoin\(/, file);
    assert.doesNotMatch(src, /\bva\.(votes_1h|votes_24h|votes_7d|trending_score)\b/, file);
  }
  const arena = fs.readFileSync(new URL("../arenaVotes.js", import.meta.url), "utf8");
  assert.match(arena, /liveArenaVotes24hJoin\(/);
  assert.match(norm(liveArenaVotes24hJoin("ava.chain_id", "ava.token_address")), /coalesce\(lav\.block_timestamp, lav\.created_at\) >= now\(\) - interval '24 hours'/);
});

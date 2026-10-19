import assert from "node:assert/strict";
import test from "node:test";

import {
  futureGen8OpenExists,
  futureScheduledLaunchExists,
  publicLaunchAtSql,
  tradingNotOpenSql,
} from "./publicHiddenSql.js";

test("a future draft schedule hides Solana and EVM coins, and keeps Solana case", () => {
  const sql = futureScheduledLaunchExists("c");
  assert.match(sql, /d_sched\.scheduled_launch_at > now\(\)/);
  assert.match(sql, /chain_id in \(101, 102\)/);
  assert.match(sql, /d_sched\.campaign_address = c\.campaign_address/);
  assert.match(sql, /lower\(d_sched\.token_address\) = lower\(c\.campaign_address\)/);
  assert.doesNotMatch(sql, /evm_gen8_pools/);
});

test("listings omit the gen-8 pool clock until that column is installed", () => {
  assert.doesNotMatch(tradingNotOpenSql("c"), /evm_gen8_pools/);
  const sql = tradingNotOpenSql("c", { gen8OpenAt: true });
  assert.match(sql, /scheduled_launch_at > now\(\)/);
  assert.match(sql, /g8_wait\.open_at > now\(\)/);
  assert.match(futureGen8OpenExists("c"), /lower\(g8_wait\.token_address\) = lower\(c\.token_address\)/);
});

test("the launch card is stamped at the open time, not the create time", () => {
  const plain = publicLaunchAtSql("c");
  assert.match(plain, /max\(d_sched\.scheduled_launch_at\)/);
  assert.doesNotMatch(plain, /evm_gen8_pools/);
  const withPool = publicLaunchAtSql("c", { gen8OpenAt: true });
  assert.match(withPool, /max\(g8_wait\.open_at\)/);
  assert.match(withPool, /g8_wait\.open_at <= now\(\)/);
});

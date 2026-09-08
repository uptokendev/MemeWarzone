import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const migration = fs.readFileSync(
  path.join(repoRoot, "db/migrations/20260828_000007_arena_tournament_support.sql"),
  "utf8",
);
const prepare = fs.readFileSync(path.join(here, "prepare-robinhood-local-db.mjs"), "utf8");

test("tournament support migration creates arena_war_pools on an empty database", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.arena_war_pools/);
  assert.match(migration, /battle_id text PRIMARY KEY/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS kind/);
});

test("isolated Robinhood replay does not skip the tournament support migration", () => {
  const optional = prepare.split("LOCAL_REPLAY_OPTIONAL_MIGRATIONS = new Set([")[1]?.split("]);")[0] || "";
  assert.doesNotMatch(optional, /20260828_000007_arena_tournament_support/);
  assert.match(prepare, /_mwz_local_migrations/);
});

test("Robinhood local replay never aliases chain 46630 to BNB 56", () => {
  assert.doesNotMatch(prepare, /46630[^\n]{0,80}56/);
  assert.doesNotMatch(prepare, /DEFAULT_EVM_CHAIN_ID[^\n]{0,40}56/);
});

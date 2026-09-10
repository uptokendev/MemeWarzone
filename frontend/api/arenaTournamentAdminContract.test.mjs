import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { ARENA_CHAIN_IDS, arenaEnvironmentIdentity } from "./lib/arenaChainEnvironment.js";

const helper = fs.readFileSync(new URL("./lib/arenaTournamentAdminContract.js", import.meta.url), "utf8");
const arena = fs.readFileSync(new URL("./arenaTournaments.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../../db/migrations/20260910_000002_arena_tournament_admin_contract.sql", import.meta.url), "utf8");

test("Tournament admin auth fails closed against legacy-open fallback", () => {
  assert.match(helper, /\["admin", "ops-key"\]\.includes/);
  assert.doesNotMatch(helper, /mode.*=== "disabled"/);
});

test("new admin contract enforces safe power-of-two caps >= 4 without 32-bit bitwise JS", () => {
  assert.match(helper, /function isSafePowerOfTwo/);
  assert.match(helper, /cap < 4 \|\| !isSafePowerOfTwo\(cap\)/);
  assert.doesNotMatch(helper, /cap & \(cap - 1\)/);
});

test("dashboard mutation routes and response shape are authoritative", () => {
  assert.match(helper, /registration\\\/open/);
  assert.match(helper, /registration\\\/close/);
  assert.match(helper, /entrants\\\/\(\[\^\/\]\+\)/);
  assert.match(helper, /tournament: adminItem/);
});

test("CREATE persists canonical generation, environment, cluster, duration, sponsor and invite wallets", () => {
  for (const token of ["admin_contract_version", "environment", "solana_cluster", "round_duration_hours", "sponsor_reference", "invite_wallets"]) {
    assert.match(helper, new RegExp(token));
    assert.match(migration, new RegExp(token));
  }
  assert.match(helper, /Battle Tournament round duration must be exactly 12 or 24 hours/);
  assert.match(helper, /Vote Tournament round duration must be an integer of at least 1 hour/);
});

test("shared Arena identity matches Tournament Admin staging/production contract", () => {
  assert.deepEqual(ARENA_CHAIN_IDS, [56, 97, 101, 4663, 46630]);
  assert.deepEqual(arenaEnvironmentIdentity(56, { environment: "production" }), { chainId: 56, environment: "production", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(97, { environment: "staging" }), { chainId: 97, environment: "staging", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(4663, { environment: "production" }), { chainId: 4663, environment: "production", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(46630, { environment: "staging" }), { chainId: 46630, environment: "staging", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(101, { environment: "staging", solanaCluster: "devnet" }), { chainId: 101, environment: "staging", solanaCluster: "devnet" });
  assert.deepEqual(arenaEnvironmentIdentity(101, { environment: "production", solanaCluster: "mainnet-beta" }), { chainId: 101, environment: "production", solanaCluster: "mainnet-beta" });
  assert.match(helper, /chainId === 97 && explicit !== "staging"/);
  assert.match(helper, /chainId === 56 && explicit !== "production"/);
  assert.match(helper, /chainId === 46630 && explicit !== "staging"/);
  assert.match(helper, /chainId === 4663 && explicit !== "production"/);
  assert.match(helper, /explicit === "staging" \? "devnet" : "mainnet-beta"/);
});

test("START uses existing pool client and admin routes dispatch through authenticated contract", () => {
  assert.match(arena, /const ownsTransaction = db === pool;/);
  assert.match(arena, /handleTournamentAdminContractRoute/);
  assert.match(arena, /requireTournamentAdminAuth\(req, res, "admin\/arena\/tournaments\/start"\)/);
});

test("Vote regulation evolves through tournament duration without rewriting Final Salvo schema", () => {
  assert.match(migration, /make_interval\(hours => tournament_round_hours\)/);
  assert.doesNotMatch(migration, /regulation_duration_seconds/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.arena_vote_tiebreaks/);
});

test("dashboard edit contract persists buyInNative and environment identity", () => {
  assert.match(helper, /buy_in_native = \$17/);
  assert.match(helper, /environment = \$18, solana_cluster = \$19/);
  assert.match(helper, /normalizeEnvironment\(Number\(row\.chain_id\)/);
});

test("new-generation START requires registration closed and reconcile keeps dashboard alias", () => {
  assert.match(arena, /TOURNAMENT_REGISTRATION_NOT_CLOSED/);
  assert.match(arena, /\(\?:reconcile\|reconcile-bracket\)/);
  assert.match(arena, /tournament: mapAdmin/);
});

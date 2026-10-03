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
  assert.match(helper, /Vote Tournament round duration must be exactly 24 hours/);
});

test("CREATE and EDIT write the scoring path and generation the runtime requires per kind", () => {
  assert.match(helper, /battle: Object\.freeze\(\{ contestScoringVersion: "battle_points_v3", competitionGeneration: "arena_competition_v2" \}\)/);
  assert.match(helper, /vote: Object\.freeze\(\{ contestScoringVersion: "vote_tournament_v1", competitionGeneration: "arena_competition_v2" \}\)/);
  assert.match(helper, /contest_scoring_version, competition_generation\n\s+\) values/);
  assert.match(helper, /contest_scoring_version = \$21, competition_generation = \$22/);
});

test("invites: per-chain address validation, versioned add/remove, upcoming only", () => {
  assert.match(helper, /must be a Solana base58 address/);
  assert.match(helper, /must be a 0x-prefixed 40-hex EVM address/);
  assert.match(helper, /invites\$\/\);/);
  assert.match(helper, /handleTournamentInviteAdd/);
  assert.match(helper, /handleTournamentInviteRemove/);
  assert.match(helper, /Invites can change only while the tournament is upcoming/);
  assert.match(helper, /TOURNAMENT_INVITE_HAS_ENTRANT/);
});

test("edit locks environment/cluster and unpaid removal is scoped to one entry", () => {
  assert.match(helper, /export function lockedTournamentIdentity/);
  assert.match(helper, /Tournament environment is locked to/);
  assert.match(helper, /Solana cluster is locked to/);
  assert.match(helper, /TOURNAMENT_ENTRY_TOKEN_REQUIRED/);
  assert.match(helper, /delete from public\.arena_tournament_entries where id = \$1 and tournament_id = \$2 and buy_in_paid = false/);
  assert.doesNotMatch(helper, /delete from public\.arena_tournament_entries where tournament_id = \$1 and lower\(owner_wallet\)/);
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
  assert.match(helper, /const identity = lockedTournamentIdentity\(row, body\);/);
});

test("new-generation START requires registration closed and reconcile keeps dashboard alias", () => {
  assert.match(arena, /TOURNAMENT_REGISTRATION_NOT_CLOSED/);
  assert.match(arena, /\(\?:reconcile\|reconcile-bracket\)/);
  assert.match(arena, /tournament: mapAdmin/);
});

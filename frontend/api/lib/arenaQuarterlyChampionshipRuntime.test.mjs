import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKIN_POINTS,
  DISPATCH_POINTS,
  DRAW_POINTS,
  LOSS_POINTS,
  STREAK_BONUS_POINTS,
  TOURNAMENT_WIN_BONUS,
  WIN_POINTS,
  mwlLedgerPlan,
} from "./arenaLeagueScoreMath.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const repoRoot = path.resolve(apiRoot, "../..");

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readRepo(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("existing MWL scoring constants and planner behavior remain unchanged", () => {
  assert.equal(WIN_POINTS, 3);
  assert.equal(LOSS_POINTS, 1);
  assert.equal(DRAW_POINTS, 0);
  assert.equal(TOURNAMENT_WIN_BONUS, 2);
  assert.equal(CHECKIN_POINTS, 0.1);
  assert.equal(STREAK_BONUS_POINTS, 0.5);
  assert.equal(DISPATCH_POINTS, 0.25);

  const ordinary = mwlLedgerPlan({
    leftToken: "alpha",
    rightToken: "bravo",
    mwlWinnerToken: "alpha",
    isTournament: false,
    isQuarterFinals: false,
    frozen: false,
    pairAlreadyScored: false,
  });
  assert.equal(ordinary.left.points, 3);
  assert.equal(ordinary.right.points, 1);

  const realTournament = mwlLedgerPlan({
    leftToken: "alpha",
    rightToken: "bravo",
    mwlWinnerToken: "alpha",
    isTournament: true,
    isQuarterFinals: false,
    frozen: false,
    pairAlreadyScored: false,
  });
  assert.equal(realTournament.left.points, 5);
  assert.equal(realTournament.right.points, 1);
});

test("new MWL finalization cannot create a quarter-final tournament or invite bracket", () => {
  const league = readApi("arenaLeague.js");
  assert.doesNotMatch(league, /insert into public\.arena_tournaments/i);
  assert.doesNotMatch(league, /insert into public\.arena_tournament_invites/i);
  assert.doesNotMatch(league, /quarterFinalSeeds\s*\(/);
  assert.doesNotMatch(league, /QF_SEED_SIZE|QF_MIN_FIGHTS/);
  assert.match(league, /quarterFinalTournamentCreated:\s*false/);
  assert.match(league, /path === "\/arena\/league\/quarter-finals"\) return handleFinalizeMwl/);
  assert.match(league, /path === "\/arena\/league\/finalize"\) return handleFinalizeMwl/);
});

test("legacy quarter-final identifiers remain readable but are not the new authority", () => {
  const league = readApi("arenaLeague.js");
  const score = readApi("lib/arenaLeagueScore.js");
  const migration = readRepo("db/migrations/20260907_000001_quarterly_championship_runtime.sql");
  assert.match(league, /quarterFinalsTournamentId:\s*row\.quarter_finals_tournament_id/);
  assert.match(score, /export async function freezeSeason/);
  assert.match(score, /origin === "quarter_finals"/);
  assert.doesNotMatch(migration, /drop column\s+quarter_finals_tournament_id/i);
  assert.doesNotMatch(migration, /update\s+public\.arena_tournaments[\s\S]*origin/i);
});

test("new MWL identity is monthly and binds one canonical quarterly championship epoch", () => {
  const score = readApi("lib/arenaLeagueScore.js");
  assert.match(score, /canonicalMonthlyMwlId/);
  assert.match(score, /championship_epoch_id/);
  assert.match(score, /month, quarter, year/);
  assert.doesNotMatch(score, /const id = `mwl-\$\{year\}-q\$\{quarter\}/);
});

test("Championship authority is separate backend persistence and no product bonus values are seeded", () => {
  const migration = readRepo("db/migrations/20260907_000001_quarterly_championship_runtime.sql");
  for (const table of [
    "arena_championship_epochs",
    "arena_championship_bonus_policies",
    "arena_championship_bonus_rules",
    "arena_championship_mwl_results",
    "arena_championship_entries",
    "arena_championship_point_events",
    "arena_championship_mwl_transfers",
    "arena_championship_final_standings",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "i"));
  }
  assert.match(migration, /event_type text NOT NULL DEFAULT 'quarterly_championship'/);
  assert.match(migration, /UNIQUE \(chain_id, year, quarter\)/);
  assert.match(migration, /UNIQUE \(epoch_id, source_kind, source_id, token_address\)/);
  assert.doesNotMatch(migration, /insert into public\.arena_championship_bonus_policies/i);
  assert.doesNotMatch(migration, /insert into public\.arena_championship_bonus_rules/i);
});

test("Championship runtime refuses mutation after closure and close requires all MWL transfers", () => {
  const runtime = readApi("lib/arenaQuarterlyChampionship.js");
  assert.match(runtime, /transfer\.epoch_state !== CHAMPIONSHIP_STATE\.OPEN/);
  assert.match(runtime, /CHAMPIONSHIP_EPOCH_CLOSED/);
  assert.match(runtime, /status<>'applied'/);
  assert.match(runtime, /CHAMPIONSHIP_BONUS_TRANSFERS_PENDING/);
  assert.match(runtime, /arena_championship_final_standings/);
  assert.match(runtime, /payoutPolicy:\s*"NOT_AUTHORITATIVE"/);
});

test("Championship runtime does not import or modify Arena Battle scoring", () => {
  const runtime = readApi("lib/arenaQuarterlyChampionship.js");
  const math = readApi("lib/arenaQuarterlyChampionshipMath.mjs");
  const combined = `${runtime}\n${math}`;
  assert.doesNotMatch(combined, /arenaBattlePoints|battle_points_v2|battle_points_v3|boost_hyperbolic|Battle Boost/);
});

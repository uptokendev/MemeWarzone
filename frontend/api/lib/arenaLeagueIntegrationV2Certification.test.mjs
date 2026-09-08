import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");
const repoRoot = path.join(frontendRoot, "..");

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readRepo(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("battle completion records MWL inside the locked settlement transaction", () => {
  const source = readApi("arenaBattles.js");
  const settle = source.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /await client\.query\(["']begin["']\)/);
  assert.match(settle, /for update/);
  assert.match(settle, /await recordFinishedBattle\([\s\S]*?, client\)/);
  assert.match(settle, /state = 'finished'/);
  assert.match(settle, /await client\.query\(["']commit["']\)/);
  assert.match(settle, /await client\.query\(["']rollback["']\)/);

  const scoreAt = settle.indexOf("await recordFinishedBattle(");
  const finishWriteAt = settle.indexOf("state = 'finished'");
  const commitAt = settle.indexOf('await client.query("commit")', finishWriteAt);
  assert.ok(scoreAt >= 0 && finishWriteAt > scoreAt, "league scoring must occur before the finished battle write");
  assert.ok(commitAt > finishWriteAt, "settlement commit must happen after battle + league writes");
  assert.equal((settle.match(/recordFinishedBattle\s*\(/g) || []).length, 1, "settlement must have one MWL write entry point");
});

test("tournament advancement happens only after battle and MWL settlement commits", () => {
  const source = readApi("arenaBattles.js");
  const settle = source.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  const finishedAt = settle.indexOf("const finished = await client.query");
  const commitAt = settle.indexOf('await client.query("commit")', finishedAt);
  const advanceAt = settle.indexOf("await advanceTournamentFromBattle", commitAt);
  assert.ok(finishedAt >= 0 && commitAt > finishedAt && advanceAt > commitAt);
});

test("MWL battle event writes are idempotent and pair scoring is serialized", () => {
  const writer = readApi("lib/arenaLeagueScore.js");
  const record = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  assert.match(record, /await lockPairScoring\(season\.id, key, db\)/);
  assert.match(record, /await pairScoredRecently\(season\.id, key, db\)/);
  assert.ok(record.indexOf("lockPairScoring") < record.indexOf("pairScoredRecently"));
  assert.match(writer, /on conflict \(season_id, battle_id, token_address, kind\)/);
  assert.match(writer, /do nothing/);
  assert.match(record, /if \(!leftInserted && !rightInserted\) return \{ scored: false, reason: ["']already-scored["'] \}/);
  assert.match(record, /if \(leftInserted\)[\s\S]*await bumpEntry/);
  assert.match(record, /if \(rightInserted\)[\s\S]*await bumpEntry/);

  const migration = readRepo("db/migrations/20260829_000001_arena_settle_idempotency.sql");
  assert.match(migration, /arena_league_point_events_battle_token_kind_idx/);
  assert.match(migration, /season_id, battle_id, token_address, kind/);
});

test("existing MWL planner remains the only place applying tournament league bonus", () => {
  const writer = readApi("lib/arenaLeagueScore.js");
  const math = readApi("lib/arenaLeagueScoreMath.js");
  const record = writer.split("export async function recordFinishedBattle")[1]?.split("export async function creditCheckin")[0] || "";
  assert.match(record, /isTournament:\s*Boolean\(row\.tournament_id\) && !isQuarterFinals/);
  assert.match(math, /export const TOURNAMENT_WIN_BONUS = 2/);
  assert.match(math, /const winPoints = WIN_POINTS \+ \(isTournament \? TOURNAMENT_WIN_BONUS : 0\)/);
});

test("Battle Points engine cannot write League Points or call the league scorer", () => {
  const points = readApi("lib/arenaBattlePoints.js");
  const metrics = readApi("lib/arenaBattleMetrics.js");
  const realtime = readApi("lib/arenaBattleRealtime.js");
  const combined = `${points}\n${metrics}\n${realtime}`;
  assert.doesNotMatch(combined, /arena_league_point_events/);
  assert.doesNotMatch(combined, /arena_league_entries/);
  assert.doesNotMatch(combined, /recordFinishedBattle/);
  assert.doesNotMatch(combined, /TOURNAMENT_WIN_BONUS/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLE_MODE_NORMAL,
  BATTLE_MODE_VOTE,
  battleDurationOptions,
  battleScoreBasis,
  isStandaloneVoteBattle,
  parseBattleDurationHoursForMode,
  parseBattleMode,
  voteBattleRegulationOpen,
  voteBattleScoringColumns,
  voteBattleSide,
} from "./arenaBattleMode.js";

test("mode parse defaults to normal and only accepts vote explicitly", () => {
  assert.equal(parseBattleMode(undefined), BATTLE_MODE_NORMAL);
  assert.equal(parseBattleMode(""), BATTLE_MODE_NORMAL);
  assert.equal(parseBattleMode("boost"), BATTLE_MODE_NORMAL);
  assert.equal(parseBattleMode("vote"), BATTLE_MODE_VOTE);
  assert.equal(parseBattleMode(" VOTE "), BATTLE_MODE_VOTE);
  assert.equal(parseBattleMode(null, BATTLE_MODE_VOTE), BATTLE_MODE_VOTE);
});

test("normal mode keeps the 24 / 72 / 168 set and the day shorthand", () => {
  assert.deepEqual([...battleDurationOptions("normal")], [24, 72, 168]);
  assert.equal(parseBattleDurationHoursForMode("normal", 72), 72);
  assert.equal(parseBattleDurationHoursForMode("normal", 1), 24);
  assert.equal(parseBattleDurationHoursForMode("normal", 3), 72);
  assert.equal(parseBattleDurationHoursForMode("normal", 7), 168);
  assert.equal(parseBattleDurationHoursForMode("normal", 6), 24);
  assert.equal(parseBattleDurationHoursForMode("normal", 6, 168), 168);
  assert.equal(parseBattleDurationHoursForMode("normal", 6, 12), 24);
});

test("vote mode takes exact hours: 1 is one hour, nothing else is coerced", () => {
  assert.deepEqual([...battleDurationOptions("vote")], [1, 6, 12, 24]);
  assert.equal(parseBattleDurationHoursForMode("vote", 1), 1);
  assert.equal(parseBattleDurationHoursForMode("vote", 6), 6);
  assert.equal(parseBattleDurationHoursForMode("vote", 12), 12);
  assert.equal(parseBattleDurationHoursForMode("vote", 24), 24);
  assert.equal(parseBattleDurationHoursForMode("vote", 72), 24);
  assert.equal(parseBattleDurationHoursForMode("vote", 3), 24);
  assert.equal(parseBattleDurationHoursForMode("vote", "x", 6), 6);
  assert.equal(parseBattleDurationHoursForMode("vote", "x", 72), 24);
});

test("score basis and scoring columns follow the mode", () => {
  assert.equal(battleScoreBasis("normal"), "mcap_pct_change");
  assert.equal(battleScoreBasis("vote"), "free_votes");
  assert.deepEqual(voteBattleScoringColumns(), {
    battle_mode: "vote",
    contest_scoring_version: "vote_tournament_v1",
    competition_generation: "arena_competition_v2",
  });
});

test("standalone vote battle excludes tournament rounds and normal battles", () => {
  assert.equal(isStandaloneVoteBattle({ battle_mode: "vote", source: "queue" }), true);
  assert.equal(isStandaloneVoteBattle({ battle_mode: "vote", source: "challenge" }), true);
  assert.equal(isStandaloneVoteBattle({ battle_mode: "vote", source: "tournament" }), false);
  assert.equal(isStandaloneVoteBattle({ battle_mode: "normal", source: "queue" }), false);
  assert.equal(isStandaloneVoteBattle({ source: "queue" }), false);
  assert.equal(isStandaloneVoteBattle(null), false);
});

test("regulation window and side resolution", () => {
  const now = Date.parse("2026-09-21T10:00:00Z");
  const row = {
    state: "live",
    ends_at: "2026-09-21T11:00:00Z",
    challenger_token: "So11111111111111111111111111111111111111112",
    defender_token: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
  };
  assert.equal(voteBattleRegulationOpen(row, now), true);
  assert.equal(voteBattleRegulationOpen(row, Date.parse("2026-09-21T11:00:00Z")), false);
  assert.equal(voteBattleRegulationOpen({ ...row, state: "matched" }, now), false);
  assert.equal(voteBattleRegulationOpen({ ...row, ends_at: null }, now), false);
  assert.equal(voteBattleSide(row, row.challenger_token), "left");
  assert.equal(voteBattleSide(row, row.defender_token.toLowerCase()), "right");
  assert.equal(voteBattleSide(row, row.challenger_token.toLowerCase()), null);
  assert.equal(voteBattleSide(row, ""), null);
});

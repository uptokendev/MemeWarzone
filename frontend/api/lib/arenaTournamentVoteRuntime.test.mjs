import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTournamentVoteMatch,
  tournamentVoteSummary,
  tournamentVoteTokensEqual,
} from "./arenaTournamentVoteRuntime.mjs";

const tokenA = "0x1111111111111111111111111111111111111111";
const tokenB = "0x2222222222222222222222222222222222222222";
const tokenC = "0x3333333333333333333333333333333333333333";

function tournament(overrides = {}) {
  return {
    id: "t-1",
    status: "live",
    battle_mode: "vote",
    round_duration_hours: 24,
    bracket: {
      rounds: [
        {
          round: 1,
          matches: [
            { id: "m1", tokenA, tokenB, battleId: "battle-1", winner: null, bye: false },
          ],
        },
      ],
    },
    ...overrides,
  };
}

test("EVM token identity is case-insensitive", () => {
  assert.equal(tournamentVoteTokensEqual(tokenA.toUpperCase().replace("0X", "0x"), tokenA), true);
});

test("resolves the active bracket match by match id", () => {
  const result = resolveTournamentVoteMatch({ tournament: tournament(), matchRef: "m1", selectedToken: tokenA });
  assert.equal(result.ok, true);
  assert.equal(result.roundNumber, 1);
  assert.equal(result.matchId, "m1");
  assert.equal(result.battleId, "battle-1");
  assert.equal(result.selectedToken, tokenA);
});

test("resolves the active bracket match by battle id", () => {
  const result = resolveTournamentVoteMatch({ tournament: tournament(), matchRef: "battle-1", selectedToken: tokenB });
  assert.equal(result.ok, true);
  assert.equal(result.matchId, "m1");
});

test("rejects a token that is not a participant", () => {
  const result = resolveTournamentVoteMatch({ tournament: tournament(), matchRef: "m1", selectedToken: tokenC });
  assert.deepEqual(result, { ok: false, reason: "selected-token-not-in-match" });
});

test("rejects non-vote tournaments and non-24h vote rounds", () => {
  assert.equal(resolveTournamentVoteMatch({ tournament: tournament({ battle_mode: "normal" }), matchRef: "m1" }).reason, "tournament-not-vote-mode");
  assert.equal(resolveTournamentVoteMatch({ tournament: tournament({ round_duration_hours: 12 }), matchRef: "m1" }).reason, "invalid-round-duration");
});

test("only the latest unresolved round is vote-active", () => {
  const row = tournament({
    bracket: {
      rounds: [
        { round: 1, matches: [{ id: "m1", tokenA, tokenB, battleId: "battle-1", winner: tokenA, bye: false }] },
        { round: 2, matches: [{ id: "r2-m1", tokenA, tokenC, battleId: "battle-2", winner: null, bye: false }] },
      ],
    },
  });
  assert.equal(resolveTournamentVoteMatch({ tournament: row, matchRef: "m1", selectedToken: tokenA }).reason, "match-not-active");
  assert.equal(resolveTournamentVoteMatch({ tournament: row, matchRef: "r2-m1", selectedToken: tokenA }).ok, true);
});

test("rejects finished and bye matchups", () => {
  const finished = tournament({
    bracket: { rounds: [{ round: 1, matches: [{ id: "m1", tokenA, tokenB, battleId: "battle-1", winner: tokenA, bye: false }] }] },
  });
  assert.equal(resolveTournamentVoteMatch({ tournament: finished, matchRef: "m1", selectedToken: tokenA }).reason, "no-active-round");

  const bye = tournament({
    bracket: { rounds: [{ round: 1, matches: [{ id: "m1", tokenA, tokenB: null, battleId: null, winner: null, bye: true }] }] },
  });
  assert.equal(resolveTournamentVoteMatch({ tournament: bye, matchRef: "m1", selectedToken: tokenA }).reason, "no-active-round");
});

test("rejects voting when the tournament is not live", () => {
  const result = resolveTournamentVoteMatch({ tournament: tournament({ status: "finished" }), matchRef: "m1", selectedToken: tokenA });
  assert.deepEqual(result, { ok: false, reason: "tournament-not-live" });
});

test("summarizes authoritative side votes", () => {
  const summary = tournamentVoteSummary([
    { side: "left" },
    { side: "left" },
    { side: "right" },
    { side: "invalid" },
  ], { tokenA, tokenB });
  assert.deepEqual(summary, {
    tokenA,
    tokenB,
    leftVotes: 2,
    rightVotes: 1,
    totalVotes: 3,
    leftPoints: 2,
    rightPoints: 1,
  });
});

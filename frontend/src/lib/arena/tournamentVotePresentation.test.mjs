import assert from "node:assert/strict";
import test from "node:test";

import {
  VOTE_TOURNAMENT_BOOST_POINTS_PER_UNIT,
  VOTE_TOURNAMENT_FREE_VOTE_POINTS,
  VOTE_TOURNAMENT_REGULATION_HOURS,
  presentTournamentVoteSummary,
  shouldShowTournamentVoteControls,
  tournamentVoteMatchRef,
} from "./tournamentVotePresentation.mjs";

test("Vote Tournament locked scoring labels stay 1 free / 2 boost / 24h", () => {
  assert.equal(VOTE_TOURNAMENT_FREE_VOTE_POINTS, 1);
  assert.equal(VOTE_TOURNAMENT_BOOST_POINTS_PER_UNIT, 2);
  assert.equal(VOTE_TOURNAMENT_REGULATION_HOURS, 24);
  const model = presentTournamentVoteSummary({
    votingLive: true,
    roundNumber: 2,
    matchId: "r2-m1",
    summary: { tokenA: "0xaaa", tokenB: "0xbbb", leftVotes: 7, rightVotes: 5, totalVotes: 12 },
  });
  assert.equal(model.leftPoints, 7);
  assert.equal(model.rightPoints, 5);
  assert.equal(model.regulationLabel, "24H REGULATION");
  assert.equal(model.scoringLabel, "FREE VOTE = 1 PT · BOOST = 2 PTS");
  assert.equal(model.scoreScopeLabel, "FREE VOTE SCORE");
});

test("wallet eligibility is derived only from authoritative walletVote", () => {
  const eligible = presentTournamentVoteSummary({ votingLive: true, walletVote: null, summary: {} });
  assert.equal(eligible.walletEligible, true);
  const used = presentTournamentVoteSummary({ votingLive: true, walletVote: "0xaaa", summary: {} });
  assert.equal(used.walletEligible, false);
  assert.equal(used.walletVote, "0xaaa");
});

test("Vote controls only mount for active two-sided Vote Tournament matches", () => {
  const match = { id: "m1", battleId: "b1", tokenA: "0xaaa", tokenB: "0xbbb" };
  assert.equal(shouldShowTournamentVoteControls({ mode: { key: "vote" }, match }), true);
  assert.equal(shouldShowTournamentVoteControls({ mode: { key: "normal" }, match }), false);
  assert.equal(shouldShowTournamentVoteControls({ mode: "vote", match: { ...match, winner: "0xaaa" } }), false);
  assert.equal(shouldShowTournamentVoteControls({ mode: "vote", match: { ...match, bye: true } }), false);
  assert.equal(tournamentVoteMatchRef(match), "m1");
  assert.equal(tournamentVoteMatchRef({ battleId: "b2" }), "b2");
});

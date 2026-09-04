import assert from "node:assert/strict";
import test from "node:test";

import {
  FINAL_SALVO_MAX_SHOTS,
  FINAL_SALVO_SHOT_SECONDS,
  FINAL_SALVO_WIN_TARGET,
  finalSalvoNeedsAnotherShot,
  presentFinalSalvoState,
} from "./finalSalvoPresentation.mjs";

test("Final Salvo stays best-of-five 60-second free-vote only", () => {
  assert.equal(FINAL_SALVO_MAX_SHOTS, 5);
  assert.equal(FINAL_SALVO_SHOT_SECONDS, 60);
  assert.equal(FINAL_SALVO_WIN_TARGET, 3);
  const model = presentFinalSalvoState({
    phase: "final_salvo",
    shotIndex: 2,
    secondsRemaining: 41,
    leftSeriesWins: 1,
    rightSeriesWins: 0,
    leftVotes: 9,
    rightVotes: 7,
    votingLive: true,
  });
  assert.equal(model.title, "FINAL SALVO");
  assert.equal(model.shotLabel, "SHOT 2 / 5");
  assert.equal(model.clockLabel, "41s");
  assert.equal(model.seriesLabel, "1 — 0");
  assert.equal(model.freeVoteOnly, true);
  assert.equal(model.boostAllowed, false);
});

test("wallet eligibility follows only supplied authoritative walletVote", () => {
  const open = presentFinalSalvoState({ phase: "final_salvo", votingLive: true, walletVote: null });
  assert.equal(open.walletEligible, true);
  const used = presentFinalSalvoState({ phase: "final_salvo", votingLive: true, walletVote: "0xabc" });
  assert.equal(used.walletEligible, false);
  const closed = presentFinalSalvoState({ phase: "final_salvo", votingLive: true, shotClosed: true });
  assert.equal(closed.walletEligible, false);
});

test("Sudden Death is represented without inventing Boost or weighted scoring", () => {
  const model = presentFinalSalvoState({
    phase: "sudden_death",
    shotIndex: 6,
    secondsRemaining: 60,
    leftSeriesWins: 2,
    rightSeriesWins: 2,
    leftVotes: 4,
    rightVotes: 4,
    shotClosed: true,
  });
  assert.equal(model.title, "SUDDEN DEATH");
  assert.equal(model.shotLabel, "SUDDEN DEATH · SHOT 6");
  assert.equal(model.boostAllowed, false);
  assert.equal(finalSalvoNeedsAnotherShot(model), true);
});

test("presentation ignores non-salvo phases and stops at three shot wins", () => {
  assert.equal(presentFinalSalvoState({ phase: "regulation" }), null);
  const done = presentFinalSalvoState({ phase: "final_salvo", leftSeriesWins: 3, rightSeriesWins: 1, shotClosed: true });
  assert.equal(finalSalvoNeedsAnotherShot(done), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FINAL_SALVO_MAX_SHOTS,
  FINAL_SALVO_SHOT_SECONDS,
  FINAL_SALVO_WIN_TARGET,
  finalSalvoNeedsAnotherShot,
  presentFinalSalvoState,
} from "./finalSalvoPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

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

test("Agent 3 nested salvo payload is normalized without client-side score logic", () => {
  const model = presentFinalSalvoState({
    state: "salvo",
    active: true,
    phase: "salvo",
    shotIndex: 3,
    secondsRemaining: 29,
    series: { leftWins: 2, rightWins: 1, maxShots: 5 },
    currentShot: {
      leftUniqueVotes: 14,
      rightUniqueVotes: 11,
      walletVote: null,
      walletEligible: true,
    },
    boostAllowed: false,
  });
  assert.equal(model.phase, "final_salvo");
  assert.equal(model.shotLabel, "SHOT 3 / 5");
  assert.equal(model.leftVotes, 14);
  assert.equal(model.rightVotes, 11);
  assert.equal(model.seriesLabel, "2 — 1");
  assert.equal(model.walletEligible, true);
  assert.equal(model.boostAllowed, false);
});

test("authoritative wallet eligibility cannot be upgraded by the browser", () => {
  const denied = presentFinalSalvoState({
    phase: "salvo",
    active: true,
    secondsRemaining: 20,
    currentShot: { walletVote: null, walletEligible: false },
  });
  assert.equal(denied.walletEligible, false);
  const used = presentFinalSalvoState({
    phase: "salvo",
    active: true,
    secondsRemaining: 20,
    currentShot: { walletVote: "0xabc", walletEligible: false },
  });
  assert.equal(used.walletEligible, false);
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

test("Final Salvo client uses only the dedicated API and signed action contract", () => {
  const client = fs.readFileSync(path.join(here, "./finalSalvoClient.ts"), "utf8");
  const controls = fs.readFileSync(path.join(here, "../../components/arena/TournamentFinalSalvoControls.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(here, "../../components/arena/FinalSalvoPanel.tsx"), "utf8");

  assert.match(client, /\/final-salvo/);
  assert.match(controls, /arena_final_salvo_vote/);
  assert.match(controls, /`Phase: \$\{apiPhase\}`/);
  assert.match(controls, /`Shot: \$\{shotIndex\}`/);
  assert.doesNotMatch(client, /boost/i);
  assert.match(panel, /Boost disabled during Final Salvo/);
});

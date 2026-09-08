import assert from "node:assert/strict";
import test from "node:test";

import {
  beginFinalSalvo,
  closeFinalSalvoShot,
  finalSalvoShotWinner,
  shouldResolveSalvoEarly,
} from "./arenaFinalSalvoRuntime.mjs";

const t0 = new Date("2026-09-04T12:00:00.000Z");

function started() {
  const result = beginFinalSalvo({ regulationLeftPoints: 7, regulationRightPoints: 7, now: t0 });
  assert.equal(result.ok, true);
  return result;
}

test("Final Salvo starts only on an exact regulation tie and opens a 60 second shot", () => {
  assert.deepEqual(beginFinalSalvo({ regulationLeftPoints: 2, regulationRightPoints: 1, now: t0 }), {
    ok: false,
    reason: "regulation-not-tied",
  });
  const state = started();
  assert.equal(state.state, "salvo");
  assert.equal(state.currentSalvoIndex, 1);
  assert.equal(state.shotEndsAt, "2026-09-04T12:01:00.000Z");
});

test("tied shot gives no series point and advances to the next shot", () => {
  const state = started();
  const next = closeFinalSalvoShot({ tiebreak: state, leftUnique: 4, rightUnique: 4, now: new Date("2026-09-04T12:01:00.000Z") });
  assert.equal(next.state, "salvo");
  assert.equal(next.currentSalvoIndex, 2);
  assert.equal(next.leftSalvoPoints, 0);
  assert.equal(next.rightSalvoPoints, 0);
  assert.equal(next.shotHistory[0].winnerSide, null);
});

test("best of five resolves early when the trailing side cannot recover", () => {
  let state = started();
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 5, rightUnique: 2, now: new Date("2026-09-04T12:01:00.000Z") });
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 7, rightUnique: 1, now: new Date("2026-09-04T12:02:00.000Z") });
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 3, rightUnique: 0, now: new Date("2026-09-04T12:03:00.000Z") });
  assert.equal(state.state, "resolved");
  assert.equal(state.winnerSide, "left");
  assert.equal(state.leftSalvoPoints, 3);
  assert.equal(state.currentSalvoIndex, 3);
});

test("five shots with an equal series score enter Sudden Death", () => {
  let state = started();
  const outcomes = [[3, 1], [1, 2], [4, 4], [5, 3], [1, 2]];
  outcomes.forEach(([left, right], index) => {
    state = closeFinalSalvoShot({
      tiebreak: state,
      leftUnique: left,
      rightUnique: right,
      now: new Date(t0.getTime() + (index + 1) * 60_000),
    });
  });
  assert.equal(state.state, "sudden_death");
  assert.equal(state.leftSalvoPoints, 2);
  assert.equal(state.rightSalvoPoints, 2);
  assert.equal(state.suddenDeathRound, 1);
});

test("tied Sudden Death shot opens another 60 second round", () => {
  const state = {
    ...started(),
    state: "sudden_death",
    currentSalvoIndex: 5,
    suddenDeathRound: 1,
    leftSalvoPoints: 2,
    rightSalvoPoints: 2,
  };
  const next = closeFinalSalvoShot({ tiebreak: state, leftUnique: 9, rightUnique: 9, now: new Date("2026-09-04T12:06:00.000Z") });
  assert.equal(next.state, "sudden_death");
  assert.equal(next.suddenDeathRound, 2);
  assert.equal(next.winnerSide, null);
});

test("non-tied Sudden Death shot resolves winner", () => {
  const state = {
    ...started(),
    state: "sudden_death",
    currentSalvoIndex: 5,
    suddenDeathRound: 3,
    leftSalvoPoints: 2,
    rightSalvoPoints: 2,
  };
  const next = closeFinalSalvoShot({ tiebreak: state, leftUnique: 8, rightUnique: 11, now: new Date("2026-09-04T12:08:00.000Z") });
  assert.equal(next.state, "resolved");
  assert.equal(next.winnerSide, "right");
  assert.equal(next.suddenDeathRound, 3);
});

test("shot winner uses unique-wallet counts only", () => {
  assert.equal(finalSalvoShotWinner(3, 1), "left");
  assert.equal(finalSalvoShotWinner(1, 3), "right");
  assert.equal(finalSalvoShotWinner(2, 2), null);
});

test("early-resolution helper accounts for tied shots consuming the five-shot budget", () => {
  assert.equal(shouldResolveSalvoEarly({ shotIndex: 3, leftWins: 3, rightWins: 0 }), "left");
  assert.equal(shouldResolveSalvoEarly({ shotIndex: 4, leftWins: 1, rightWins: 1 }), null);
  assert.equal(shouldResolveSalvoEarly({ shotIndex: 4, leftWins: 0, rightWins: 2 }), "right");
});

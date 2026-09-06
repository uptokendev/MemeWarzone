import assert from "node:assert/strict";
import test from "node:test";
import { stepCombatEffects } from "./battleCombatEffects.mjs";

function metrics({ left, right, leader, updatedAt, healthy = true, pointsReady = true }) {
  return {
    metricsUpdatedAt: updatedAt,
    leaderSide: leader,
    dataHealth: { healthy, status: healthy ? "healthy" : "data_delay", reasons: healthy ? [] : ["stale"] },
    sides: {
      left: { pointsReady, points: { total: left } },
      right: { pointsReady, points: { total: right } },
    },
  };
}

function hole(side, id, createdAt = 1) {
  return { id, side, createdAt, severity: 1 };
}

function sides(rows) {
  return [...new Set(rows.map((row) => row.side))].sort();
}

test("scenario A: left leader loses lead and damage ends only on left", () => {
  const step = stepCombatEffects({
    previous: { left: 100, right: 96, leader: "left", updatedAt: "t1" },
    holes: [hole("right", "old-right")],
    metrics: metrics({ left: 100, right: 103, leader: "right", updatedAt: "t2" }),
    now: 100,
  });

  assert.deepEqual(step.attacks, [{ attacker: "right", delta: 7, leadChange: true }]);
  assert.equal(step.attacks[0].leadChange, true);
  assert.ok(step.holes.length > 0);
  assert.deepEqual(sides(step.holes), ["left"]);
  assert.equal(step.holes.some((row) => row.id === "old-right"), false);
});

test("scenario B: lead flips back, old left damage clears and fresh right damage appears", () => {
  const step = stepCombatEffects({
    previous: { left: 100, right: 103, leader: "right", updatedAt: "t2" },
    holes: [hole("left", "old-left-1"), hole("left", "old-left-2")],
    metrics: metrics({ left: 106, right: 103, leader: "left", updatedAt: "t3" }),
    now: 200,
  });

  assert.deepEqual(step.attacks, [{ attacker: "left", delta: 6, leadChange: true }]);
  assert.ok(step.holes.length > 0);
  assert.deepEqual(sides(step.holes), ["right"]);
  assert.equal(step.holes.some((row) => row.id.startsWith("old-left")), false);
});

test("scenario C: same leader increases lead and right-side damage accumulates", () => {
  const step = stepCombatEffects({
    previous: { left: 106, right: 103, leader: "left", updatedAt: "t3" },
    holes: [hole("right", "existing-right")],
    metrics: metrics({ left: 108, right: 103, leader: "left", updatedAt: "t4" }),
    now: 300,
  });

  assert.deepEqual(step.attacks, [{ attacker: "left", delta: 2, leadChange: false }]);
  assert.equal(step.holes.some((row) => row.id === "existing-right"), true);
  assert.ok(step.holes.length > 1);
  assert.deepEqual(sides(step.holes), ["right"]);
});

test("scenario D: trailer gains but remains trailer and cannot damage current leader", () => {
  const step = stepCombatEffects({
    previous: { left: 108, right: 103, leader: "left", updatedAt: "t4" },
    holes: [hole("right", "existing-right"), hole("left", "stale-left")],
    metrics: metrics({ left: 108, right: 105, leader: "left", updatedAt: "t5" }),
    now: 400,
  });

  assert.deepEqual(step.attacks, []);
  assert.deepEqual(sides(step.holes), ["right"]);
  assert.equal(step.holes.some((row) => row.id === "existing-right"), true);
  assert.equal(step.holes.some((row) => row.side === "left"), false);
});

test("scenario E: tie clears bullet-hole damage from both sides", () => {
  const step = stepCombatEffects({
    previous: { left: 108, right: 105, leader: "left", updatedAt: "t5" },
    holes: [hole("left", "left-hole"), hole("right", "right-hole")],
    tracers: [{ id: "old-tracer", from: "left", createdAt: 1, severity: 1 }],
    metrics: metrics({ left: 108, right: 108, leader: null, updatedAt: "t6" }),
    now: 500,
  });

  assert.deepEqual(step.attacks, []);
  assert.deepEqual(step.holes, []);
});

test("scenario F: telemetry loss resets baseline and recovery does not fake catch-up effects", () => {
  const delayed = stepCombatEffects({
    previous: { left: 108, right: 105, leader: "left", updatedAt: "t5" },
    holes: [hole("right", "existing-right")],
    metrics: metrics({ left: 0, right: 0, leader: null, updatedAt: null, healthy: false, pointsReady: false }),
    now: 600,
  });
  assert.equal(delayed.previous, null);
  assert.deepEqual(delayed.attacks, []);
  assert.equal(delayed.spawnedHoles, 0);

  const recovered = stepCombatEffects({
    previous: delayed.previous,
    holes: delayed.holes,
    metrics: metrics({ left: 200, right: 150, leader: "left", updatedAt: "t7" }),
    now: 700,
  });
  assert.deepEqual(recovered.attacks, []);
  assert.equal(recovered.spawnedHoles, 0);
  assert.equal(recovered.previous.left, 200);
});

test("requested visual sequence keeps damage on loser and clears on tie", () => {
  let state = {
    previous: { left: 100, right: 96, leader: "left", updatedAt: "t1" },
    holes: [],
    tracers: [],
  };

  state = stepCombatEffects({
    ...state,
    metrics: metrics({ left: 100, right: 103, leader: "right", updatedAt: "t2" }),
    now: 1_000,
  });
  assert.deepEqual(sides(state.holes), ["left"]);

  state = stepCombatEffects({
    ...state,
    metrics: metrics({ left: 106, right: 103, leader: "left", updatedAt: "t3" }),
    now: 2_000,
  });
  assert.deepEqual(sides(state.holes), ["right"]);

  state = stepCombatEffects({
    ...state,
    metrics: metrics({ left: 106, right: 106, leader: null, updatedAt: "t4" }),
    now: 3_000,
  });
  assert.deepEqual(state.holes, []);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_HOLES_PER_SIDE,
  MAX_TRACERS,
  burstCount,
  capHoles,
  capTracers,
  shouldClearCombatBaseline,
  spawnCombatEffects,
  stepCombatEffects,
} from "./battleCombatEffects.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function metrics({ left, right, leader = "left", healthy = true, updatedAt = "t1", pointsReady = true } = {}) {
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

test("<0.10 produces no impact", () => {
  assert.equal(burstCount(0, false), 0);
  assert.equal(burstCount(0.09, false), 0);
  const step = stepCombatEffects({
    metrics: metrics({ left: 10.09, right: 8, updatedAt: "t2" }),
    previous: { left: 10, right: 8, leader: "left", updatedAt: "t1" },
  });
  assert.equal(step.spawnedHoles, 0);
  assert.equal(step.attacks.length, 0);
});

test("0.10–0.49 produces one impact", () => {
  assert.equal(burstCount(0.1, false), 1);
  assert.equal(burstCount(0.49, false), 1);
  const step = stepCombatEffects({
    metrics: metrics({ left: 10.2, right: 8, updatedAt: "t2" }),
    previous: { left: 10, right: 8, leader: "left", updatedAt: "t1" },
  });
  assert.equal(step.spawnedHoles, 1);
});

test("0.50–1.49 produces a short burst", () => {
  assert.equal(burstCount(0.5, false), 3);
  assert.equal(burstCount(1.49, false), 3);
});

test(">=1.50 produces a heavy burst", () => {
  assert.equal(burstCount(1.5, false), 6);
  assert.equal(burstCount(9, false), 6);
});

test("direct lead change produces a barrage", () => {
  assert.equal(burstCount(0, true), 8);
  const step = stepCombatEffects({
    metrics: metrics({ left: 10, right: 10.2, leader: "right", updatedAt: "t2" }),
    previous: { left: 10, right: 10, leader: "left", updatedAt: "t1" },
  });
  assert.equal(step.attacks.some((attack) => attack.leadChange), true);
  assert.ok(step.spawnedHoles >= 8);
});

test("mobile compact density still fires bounded combat feedback", () => {
  assert.equal(burstCount(0.2, false, { compact: true }), 1);
  assert.equal(burstCount(0.7, false, { compact: true }), 2);
  assert.equal(burstCount(2, false, { compact: true }), 3);
  assert.equal(burstCount(0, true, { compact: true }), 4);
  const step = stepCombatEffects({
    compact: true,
    metrics: metrics({ left: 12, right: 8, updatedAt: "t2" }),
    previous: { left: 10, right: 8, leader: "left", updatedAt: "t1" },
  });
  assert.ok(step.spawnedHoles >= 1);
  assert.equal(step.spawnedTracers, 0);
  assert.ok(step.holes.length <= MAX_HOLES_PER_SIDE * 2);
});

test("reduced-motion collapses bursts and suppresses tracers", () => {
  assert.equal(burstCount(9, true, { reducedMotion: true }), 1);
  const step = stepCombatEffects({
    reducedMotion: true,
    metrics: metrics({ left: 20, right: 8, leader: "left", updatedAt: "t2" }),
    previous: { left: 10, right: 8, leader: "right", updatedAt: "t1" },
  });
  assert.equal(step.spawnedHoles, 1);
  assert.equal(step.spawnedTracers, 0);
});

test("hole and tracer caps remain bounded", () => {
  const holes = capHoles(Array.from({ length: 90 }, (_, i) => ({
    id: `h${i}`,
    side: i % 2 === 0 ? "left" : "right",
    createdAt: i,
  })));
  assert.equal(holes.filter((row) => row.side === "left").length, MAX_HOLES_PER_SIDE);
  assert.equal(holes.filter((row) => row.side === "right").length, MAX_HOLES_PER_SIDE);
  const tracers = capTracers(Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` })));
  assert.equal(tracers.length, MAX_TRACERS);
});

test("unhealthy snapshot with null timestamp clears baseline and fires no catch-up", () => {
  const healthy = metrics({ left: 10, right: 8, updatedAt: "t1" });
  const first = stepCombatEffects({ metrics: healthy, previous: null });
  assert.deepEqual(first.previous, { left: 10, right: 8, leader: "left", updatedAt: "t1" });
  assert.equal(first.spawnedHoles, 0);

  assert.equal(shouldClearCombatBaseline(true, { dataHealth: { healthy: false }, metricsUpdatedAt: null }), true);
  const delayed = stepCombatEffects({
    previous: first.previous,
    metrics: { dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] }, metricsUpdatedAt: null, sides: {} },
  });
  assert.equal(delayed.previous, null);
  assert.equal(delayed.spawnedHoles, 0);

  const recovered = stepCombatEffects({
    previous: delayed.previous,
    metrics: metrics({ left: 44, right: 3, leader: "left", updatedAt: "t3" }),
  });
  assert.equal(recovered.spawnedHoles, 0);
  assert.equal(recovered.attacks.length, 0);
  assert.equal(recovered.previous.left, 44);

  const nextHealthy = stepCombatEffects({
    previous: recovered.previous,
    metrics: metrics({ left: 44.3, right: 3, leader: "left", updatedAt: "t4" }),
  });
  assert.equal(nextHealthy.spawnedHoles, 1);
});

test("disabled path never spawns effects", () => {
  const step = stepCombatEffects({
    enabled: false,
    metrics: metrics({ left: 50, right: 1, updatedAt: "t2" }),
    previous: { left: 1, right: 1, leader: "right", updatedAt: "t1" },
  });
  assert.equal(step.previous, null);
  assert.equal(step.spawnedHoles, 0);
});

test("repeated enabled updates keep DOM counts bounded", () => {
  let state = { previous: { left: 10, right: 10, leader: "tied", updatedAt: "t0" }, holes: [], tracers: [] };
  for (let i = 1; i <= 80; i += 1) {
    state = stepCombatEffects({
      previous: state.previous,
      holes: state.holes,
      tracers: state.tracers,
      now: 1_000 + i * 20,
      metrics: metrics({ left: 10 + i * 1.6, right: 10, leader: "left", updatedAt: `t${i}` }),
    });
  }
  const leftHoles = state.holes.filter((row) => row.side === "right").length;
  assert.ok(leftHoles <= MAX_HOLES_PER_SIDE, `holes ${leftHoles}`);
  assert.ok(state.tracers.length <= MAX_TRACERS, `tracers ${state.tracers.length}`);
  assert.ok(state.holes.length <= MAX_HOLES_PER_SIDE * 2);
  console.log(`combat_profile holes=${state.holes.length} tracers=${state.tracers.length} cap_holes=${MAX_HOLES_PER_SIDE} cap_tracers=${MAX_TRACERS}`);
});

test("canonical Battle Wall mounts BattleCombatEffects without a desktop-only wrapper", () => {
  const wall = fs.readFileSync(path.join(here, "../../components/arena/BattleWallModule.tsx"), "utf8");
  const mount = wall.split("<BattleCombatEffects")[0]?.slice(-220) || "";
  assert.match(wall, /<BattleCombatEffects/);
  assert.match(wall, /shouldMountWallCombatEffects/);
  assert.doesNotMatch(mount, /hidden xl:block/);
  const details = fs.readFileSync(path.join(here, "../../pages/BattleDetails.tsx"), "utf8");
  assert.match(details, /<Navigate to=\{`\/warzone\/battles\//);
  const component = fs.readFileSync(path.join(here, "../../components/arena/BattleCombatEffects.tsx"), "utf8");
  assert.match(component, /shouldClearCombatBaseline/);
  assert.match(component, /compact/);
  assert.match(component, /scope\.querySelector/);
  assert.match(component, /data-battle-effects-for/);
});

test("spawned heavy desktop burst is larger than compact mobile burst and both are bounded", () => {
  const attacks = [{ attacker: "left", delta: 2, leadChange: false }];
  const desktop = spawnCombatEffects(attacks, { compact: false, reducedMotion: false });
  const mobile = spawnCombatEffects(attacks, { compact: true, reducedMotion: false });
  assert.ok(desktop.holes.length > mobile.holes.length);
  assert.ok(mobile.holes.length >= 1);
  assert.equal(mobile.tracers.length, 0);
  assert.ok(desktop.holes.length <= MAX_HOLES_PER_SIDE);
});

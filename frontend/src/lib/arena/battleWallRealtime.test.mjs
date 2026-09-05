import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DATA_DELAY_LABEL, FEED_METRICS_LIMIT, presentArenaMatchRow } from "./arenaMatchRowPresentation.mjs";
import { POINTS_PENDING_LABEL, presentBattleWallModule, wallTabForBattle } from "./battleWallPresentation.mjs";
import { shouldClearCombatBaseline, stepCombatEffects } from "./battleCombatEffects.mjs";
import {
  WALL_REALTIME_CAP,
  classifyWallViewport,
  isWallRealtimeActive,
  isWallRealtimeEligible,
  retainWallRealtimeMetrics,
  sameIdList,
  selectActiveWallRealtimeIds,
  selectWallModuleMetrics,
  shouldMountWallCombatEffects,
  upsertWallViewportReport,
  viewportDistanceFromCenter,
  wallEffectsScopeSelector,
} from "./battleWallRealtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function battle(overrides = {}) {
  return {
    id: "live-1",
    state: "live",
    source: "queue",
    chainId: 56,
    participants: [{ symbol: "ALPHA" }, { symbol: "BRAVO" }],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    battleId: "live-1",
    live: true,
    visibility: "visible",
    ratio: 0.8,
    distanceFromCenter: 40,
    index: 0,
    ...overrides,
  };
}

function delayMetrics() {
  return healthyMetrics({
    dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] },
  });
}

function healthyMetrics(overrides = {}) {
  return {
    settlementMode: "battle_points_v2",
    leaderSide: "left",
    pointDifference: 7.2,
    dataHealth: { healthy: true, status: "healthy", reasons: [] },
    sides: {
      left: { pointsReady: true, points: { total: 58.4 }, current: { marketCapUsd: 842000, holders: 2811, healthy: true }, eligibleBattleVolumeUsd: 98000 },
      right: { pointsReady: true, points: { total: 51.2 }, current: { marketCapUsd: 790000, holders: 2422, healthy: true }, eligibleBattleVolumeUsd: 71000 },
    },
    ...overrides,
  };
}

test("offscreen live battle does not activate heavy realtime", () => {
  const reports = [report({ visibility: "offscreen", ratio: 0 }), report({ battleId: "live-2", visibility: "near", ratio: 0.1 })];
  assert.deepEqual(selectActiveWallRealtimeIds(reports), []);
  assert.equal(isWallRealtimeActive("live-1", []), false);
  assert.equal(shouldMountWallCombatEffects({ live: true, realtimeActive: false, snapshotReady: false }), false);
});

test("visible live battle activates realtime", () => {
  const ids = selectActiveWallRealtimeIds([report({ battleId: "visible-live", ratio: 0.9 })]);
  assert.deepEqual(ids, ["visible-live"]);
  assert.equal(isWallRealtimeActive("visible-live", ids), true);
  assert.equal(shouldMountWallCombatEffects({ live: true, realtimeActive: true, snapshotReady: true }), true);
});

test("leaving viewport deactivates realtime and retains the last snapshot", () => {
  let reports = new Map();
  reports = upsertWallViewportReport(reports, report({ battleId: "A", ratio: 0.9 }));
  assert.deepEqual(selectActiveWallRealtimeIds([...reports.values()]), ["A"]);
  const retained = retainWallRealtimeMetrics(null, true, true, healthyMetrics());
  reports = upsertWallViewportReport(reports, report({ battleId: "A", visibility: "offscreen", ratio: 0 }));
  assert.deepEqual(selectActiveWallRealtimeIds([...reports.values()]), []);
  const selected = selectWallModuleMetrics({
    realtimeActive: false,
    snapshotReady: false,
    realtimeMetrics: null,
    retained,
    feedMetrics: { stale: true },
  });
  assert.equal(selected.source, "retained");
  assert.equal(selected.metrics.leaderSide, "left");
  assert.equal(shouldMountWallCombatEffects({ live: true, realtimeActive: false, snapshotReady: false }), false);
});

test("upcoming and finished battles never activate realtime or effects", () => {
  assert.equal(isWallRealtimeEligible(battle({ state: "matched" })), false);
  assert.equal(isWallRealtimeEligible(battle({ state: "finished" })), false);
  assert.equal(isWallRealtimeEligible(battle({ state: "challenged" })), false);
  assert.equal(isWallRealtimeEligible(battle({ state: "waiting" })), false);
  assert.equal(wallTabForBattle(battle({ state: "matched" })), "upcoming");
  const ids = selectActiveWallRealtimeIds([
    report({ battleId: "up", live: false, visibility: "visible", ratio: 1 }),
    report({ battleId: "fin", live: false, visibility: "visible", ratio: 1 }),
  ]);
  assert.deepEqual(ids, []);
  assert.equal(shouldMountWallCombatEffects({ live: false, realtimeActive: true, snapshotReady: true }), false);
});

test("max active realtime fights is bounded at 2", () => {
  assert.equal(WALL_REALTIME_CAP, 2);
  const ids = selectActiveWallRealtimeIds([
    report({ battleId: "a", ratio: 0.9, index: 0 }),
    report({ battleId: "b", ratio: 0.8, index: 1 }),
    report({ battleId: "c", ratio: 0.7, index: 2 }),
    report({ battleId: "d", ratio: 0.6, index: 3 }),
    report({ battleId: "e", ratio: 0.5, index: 4 }),
  ]);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids, ["a", "b"]);
});

test("three intersecting fights pick the most visible deterministically", () => {
  const ids = selectActiveWallRealtimeIds([
    report({ battleId: "far", ratio: 0.4, distanceFromCenter: 300, index: 0 }),
    report({ battleId: "center", ratio: 0.95, distanceFromCenter: 10, index: 1 }),
    report({ battleId: "near", ratio: 0.6, distanceFromCenter: 80, index: 2 }),
  ]);
  assert.deepEqual(ids, ["center", "near"]);
});

test("focused battle uses the same activation path without a duplicate slot", () => {
  const reports = [
    report({ battleId: "focus-live", ratio: 0.5, distanceFromCenter: 20, index: 1 }),
    report({ battleId: "other", ratio: 0.5, distanceFromCenter: 20, index: 0 }),
  ];
  const ids = selectActiveWallRealtimeIds(reports, { focusedId: "focus-live" });
  assert.equal(ids.length, 2);
  assert.equal(ids[0], "focus-live");
  assert.equal(new Set(ids).size, 2);
  const duplicate = selectActiveWallRealtimeIds(
    [report({ battleId: "focus-live", ratio: 0.9 }), report({ battleId: "focus-live", ratio: 0.8 })],
    { focusedId: "focus-live" },
  );
  assert.deepEqual(duplicate, ["focus-live"]);
});

test("filter or tab removal tears down activation", () => {
  let reports = upsertWallViewportReport(new Map(), report({ battleId: "gone", ratio: 0.9 }));
  assert.deepEqual(selectActiveWallRealtimeIds([...reports.values()]), ["gone"]);
  reports = upsertWallViewportReport(reports, report({ battleId: "gone", visibility: "offscreen" }));
  assert.equal(reports.size, 0);
  assert.deepEqual(selectActiveWallRealtimeIds([...reports.values()]), []);
});

test("unmount cleanup drops observer bookkeeping", () => {
  let reports = new Map();
  for (let index = 0; index < 50; index += 1) {
    reports = upsertWallViewportReport(reports, report({
      battleId: `mod-${index}`,
      live: index < 20,
      visibility: index < 5 ? "visible" : "offscreen",
      ratio: index < 5 ? 0.9 - index * 0.1 : 0,
      index,
    }));
  }
  assert.ok(reports.size <= 50);
  const ids = selectActiveWallRealtimeIds([...reports.values()]);
  assert.equal(ids.length, 2);
  for (let index = 0; index < 50; index += 1) {
    reports = upsertWallViewportReport(reports, report({ battleId: `mod-${index}`, visibility: "offscreen" }));
  }
  assert.equal(reports.size, 0);
  assert.deepEqual(selectActiveWallRealtimeIds([...reports.values()]), []);
});

test("REST snapshot precedes realtime patches", () => {
  const patchy = healthyMetrics({ sides: { left: { pointsReady: true, points: { total: 99 } }, right: { pointsReady: true, points: { total: 1 } } } });
  const beforeRest = selectWallModuleMetrics({
    realtimeActive: true,
    snapshotReady: false,
    realtimeMetrics: patchy,
    feedMetrics: healthyMetrics(),
    feedRequested: true,
    feedLoaded: true,
  });
  assert.equal(beforeRest.source, "feed");
  assert.equal(beforeRest.metrics.sides.left.points.total, 58.4);
  const afterRest = selectWallModuleMetrics({
    realtimeActive: true,
    snapshotReady: true,
    realtimeMetrics: patchy,
    feedMetrics: healthyMetrics(),
  });
  assert.equal(afterRest.source, "realtime");
  assert.equal(afterRest.metrics.sides.left.points.total, 99);
});

test("reconnect REST reconciliation stays on the existing realtime hook", () => {
  const hook = readSrc("../../hooks/useArenaBattleRealtimeDetails.ts");
  const wrapper = readSrc("../../hooks/useBattleWallRealtime.ts");
  assert.match(wrapper, /useArenaBattleRealtimeDetails/);
  assert.match(wrapper, /enabled && battleId/);
  assert.match(hook, /fetchPostGradBattleDetails/);
  assert.match(hook, /fetchArenaBattleMetrics/);
  assert.match(hook, /enabled:\s*Boolean\(battleId && snapshotReady\)/);
  assert.match(hook, /reconnect reconciliation/);
  assert.match(hook, /incomingMetricTs < currentMetricTs/);
});

test("DATA DELAY clears live score and leader interpretation on the wall", () => {
  const presented = presentBattleWallModule(battle(), delayMetrics(), { requested: true, loaded: true });
  assert.equal(presented.scoreKind, "delay");
  assert.equal(presented.statusLabel, DATA_DELAY_LABEL);
  assert.equal(presented.leftPointsLabel, null);
  assert.equal(presented.leaderIndex, null);
  assert.equal(presented.pointGap, null);
});

test("healthy recovery resumes from the fresh baseline with no catch-up burst", () => {
  assert.equal(shouldClearCombatBaseline(true, delayMetrics()), true);
  const delayed = stepCombatEffects({
    previous: { left: 10, right: 8, leader: "left", updatedAt: "t1" },
    metrics: { dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] }, metricsUpdatedAt: null, sides: {} },
  });
  assert.equal(delayed.previous, null);
  assert.equal(delayed.spawnedHoles, 0);
  const recovered = stepCombatEffects({
    previous: delayed.previous,
    metrics: {
      metricsUpdatedAt: "t3",
      leaderSide: "left",
      dataHealth: { healthy: true, status: "healthy", reasons: [] },
      sides: {
        left: { pointsReady: true, points: { total: 44 } },
        right: { pointsReady: true, points: { total: 3 } },
      },
    },
  });
  assert.equal(recovered.spawnedHoles, 0);
  assert.equal(recovered.attacks.length, 0);
  assert.equal(recovered.previous.left, 44);
});

test("BP gain and lead flip still use the existing effects planner", () => {
  const gain = stepCombatEffects({
    previous: { left: 10, right: 8, leader: "left", updatedAt: "t1" },
    metrics: {
      metricsUpdatedAt: "t2",
      leaderSide: "left",
      dataHealth: { healthy: true, status: "healthy", reasons: [] },
      sides: {
        left: { pointsReady: true, points: { total: 10.2 } },
        right: { pointsReady: true, points: { total: 8 } },
      },
    },
  });
  assert.equal(gain.attacks[0].attacker, "left");
  assert.equal(gain.spawnedHoles, 1);
  const flip = stepCombatEffects({
    previous: { left: 10, right: 10, leader: "left", updatedAt: "t1" },
    metrics: {
      metricsUpdatedAt: "t2",
      leaderSide: "right",
      dataHealth: { healthy: true, status: "healthy", reasons: [] },
      sides: {
        left: { pointsReady: true, points: { total: 10 } },
        right: { pointsReady: true, points: { total: 10.2 } },
      },
    },
  });
  assert.equal(flip.attacks.some((attack) => attack.leadChange), true);
  assert.ok(flip.spawnedHoles >= 8);
});

test("battle A effects stay inside Battle A and do not hit Battle B", () => {
  const scopeA = wallEffectsScopeSelector("A");
  const scopeB = wallEffectsScopeSelector("B");
  assert.equal(scopeA, '[data-battle-id="A"] [data-battle-combat-effects]');
  assert.equal(scopeB, '[data-battle-id="B"] [data-battle-combat-effects]');
  assert.notEqual(scopeA, scopeB);
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const effects = readSrc("../../components/arena/BattleCombatEffects.tsx");
  assert.match(moduleSrc, /overflow-hidden/);
  assert.match(moduleSrc, /rootRef=\{moduleRef\}/);
  assert.match(moduleSrc, /data-battle-effects-for|battleId=\{battle\.id\}/);
  assert.match(effects, /rootRef\?\.current/);
  assert.match(effects, /scope\.querySelector/);
  assert.match(effects, /data-battle-effects-for/);
});

test("reduced motion and mobile compact effects remain enabled and bounded", () => {
  const effects = readSrc("../../components/arena/BattleCombatEffects.tsx");
  assert.match(effects, /prefers-reduced-motion: reduce/);
  assert.match(effects, /max-width: 1279px/);
  assert.match(effects, /if \(!reducedMotion && !compact\)/);
  const reduced = stepCombatEffects({
    reducedMotion: true,
    previous: { left: 10, right: 8, leader: "right", updatedAt: "t1" },
    metrics: {
      metricsUpdatedAt: "t2",
      leaderSide: "left",
      dataHealth: { healthy: true, status: "healthy", reasons: [] },
      sides: {
        left: { pointsReady: true, points: { total: 20 } },
        right: { pointsReady: true, points: { total: 8 } },
      },
    },
  });
  assert.equal(reduced.spawnedHoles, 1);
  assert.equal(reduced.spawnedTracers, 0);
  const mobile = stepCombatEffects({
    compact: true,
    previous: { left: 10, right: 8, leader: "left", updatedAt: "t1" },
    metrics: {
      metricsUpdatedAt: "t2",
      leaderSide: "left",
      dataHealth: { healthy: true, status: "healthy", reasons: [] },
      sides: {
        left: { pointsReady: true, points: { total: 12 } },
        right: { pointsReady: true, points: { total: 8 } },
      },
    },
  });
  assert.ok(mobile.spawnedHoles >= 1);
  assert.equal(mobile.spawnedTracers, 0);
});

test("Phase-1 12-metric safety, Phase-2 routing, and historical V1 remain intact", () => {
  assert.equal(FEED_METRICS_LIMIT, 12);
  const thirteenth = presentBattleWallModule(
    battle({ id: "live-13", settlementVersion: null }),
    null,
    { requested: false, loaded: true },
  );
  assert.equal(thirteenth.scoreKind, "pending");
  assert.equal(thirteenth.statusLabel, POINTS_PENDING_LABEL);
  const historical = presentBattleWallModule(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change" }),
    null,
    { requested: false, loaded: true },
  );
  assert.equal(historical.scoreKind, "legacy");
  assert.equal(historical.scoreCaption, "Score");
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const app = readSrc("../../App.tsx");
  assert.match(page, /resolveFocusedWallBattle/);
  assert.match(page, /selectActiveWallRealtimeIds/);
  assert.match(app, /path="\/warzone\/battles\/:battleId"/);
  assert.match(app, /path="\/battle\/:id"/);
});

test("viewport classifier and distance stay deterministic", () => {
  assert.equal(classifyWallViewport({ isIntersecting: false, intersectionRatio: 0 }), "offscreen");
  assert.equal(classifyWallViewport({ isIntersecting: true, intersectionRatio: 0.05 }), "near");
  assert.equal(classifyWallViewport({ isIntersecting: true, intersectionRatio: 0.2 }), "visible");
  assert.equal(
    viewportDistanceFromCenter({
      rootBounds: { top: 0, height: 100 },
      boundingClientRect: { top: 40, height: 20 },
    }),
    0,
  );
  assert.equal(sameIdList(["a", "b"], ["a", "b"]), true);
  assert.equal(sameIdList(["a", "b"], ["b", "a"]), false);
});

test("Battle Wall Phase 3 wiring reuses existing realtime and effects without a second engine", () => {
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const wrapper = readSrc("../../hooks/useBattleWallRealtime.ts");
  const viewport = readSrc("../../hooks/useBattleWallViewport.ts");
  const details = readSrc("../../pages/BattleDetails.tsx");
  const row = readSrc("../../components/postgrad/ArenaMatchRow.tsx");
  const wall = readSrc("./battleWallPresentation.mjs");
  const realtime = readSrc("./battleWallRealtime.mjs");

  assert.match(page, /selectActiveWallRealtimeIds/);
  assert.match(page, /upsertWallViewportReport/);
  assert.match(page, /realtimeActive=\{activeRealtimeIds\.includes\(battle\.id\)\}/);
  assert.doesNotMatch(page, /useAblyBattleChannel/);
  assert.doesNotMatch(page, /BattleCombatEffects/);
  assert.match(moduleSrc, /useBattleWallRealtime/);
  assert.match(moduleSrc, /useBattleWallViewport/);
  assert.match(moduleSrc, /BattleCombatEffects/);
  assert.match(moduleSrc, /shouldMountWallCombatEffects/);
  assert.match(moduleSrc, /overflow-hidden/);
  assert.match(wrapper, /useArenaBattleRealtimeDetails/);
  assert.doesNotMatch(wrapper, /BattleWallRealtimeV2/);
  assert.match(viewport, /IntersectionObserver/);
  assert.match(details, /<BattleCombatEffects/);
  assert.match(details, /useArenaBattleRealtimeDetails/);
  assert.doesNotMatch(row, /BattleCombatEffects/);
  assert.doesNotMatch(row, /useAblyBattleChannel/);
  assert.doesNotMatch(wall, /calculateBattlePoints|marketCapWeight|50\/30\/20/);
  assert.doesNotMatch(realtime, /calculateBattlePoints|marketCapWeight|50\/30\/20/);
  assert.doesNotMatch(moduleSrc, /WarPoolPanel|ArenaStakeButton|share-card|CreatorChallenge/);
  assert.equal(typeof presentArenaMatchRow, "function");
  assert.equal(WALL_REALTIME_CAP, 2);
});

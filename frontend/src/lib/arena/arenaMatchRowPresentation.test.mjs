import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DATA_DELAY_LABEL,
  FEED_METRICS_LIMIT,
  POINTS_UNAVAILABLE_LABEL,
  battleNeedsFeedMetrics,
  presentArenaMatchRow,
  selectFeedMetricBattleIds,
} from "./arenaMatchRowPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function battle(overrides = {}) {
  return {
    id: "battle-1",
    state: "live",
    scoreBasis: "mcap_pct_change",
    settlementVersion: null,
    leaderSide: "right",
    participants: [
      { tokenName: "Dog War", symbol: "DOGWAR", score: 428000, isLeading: false },
      { tokenName: "Cat War", symbol: "CATWAR", score: 91000, isLeading: true },
    ],
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    settlementMode: "battle_points_v2",
    leaderSide: "left",
    pointDifference: 8.7,
    dataHealth: { healthy: true, status: "healthy", reasons: [] },
    finalBattlePoints: null,
    sides: {
      left: { pointsReady: true, points: { total: 12.5, marketCap: 5, holders: 4, volume: 3.5 } },
      right: { pointsReady: true, points: { total: 3.8, marketCap: 1, holders: 1, volume: 1.8 } },
    },
    ...overrides,
  };
}

const FORMULA_MARKERS = [
  "calculateBattlePoints",
  "marketCapWeight",
  "holderWeight",
  "volumeWeight",
  "eligibleBattleVolume",
  "clusterCap",
  "50/30/20",
  "logRatioScore",
  "calculateMatchQuality",
];

test("live Battle V2 row uses server Battle Points, not list MCAP", () => {
  const presented = presentArenaMatchRow(battle(), metrics(), { requested: true, loaded: true });
  assert.equal(presented.scoreKind, "battle_points");
  assert.equal(presented.scoreCaption, "Battle points");
  assert.equal(presented.leftPointsLabel, "12.5");
  assert.equal(presented.rightPointsLabel, "3.8");
  assert.equal(presented.leftTicker, "$DOGWAR");
  assert.equal(presented.rightTicker, "$CATWAR");
  assert.notEqual(presented.leftPointsLabel, "428000.0");
  assert.equal(presented.href, "/battle/battle-1");
});

test("server leader and point gap come from authoritative Battle Points", () => {
  const presented = presentArenaMatchRow(battle({ leaderSide: "right" }), metrics({ leaderSide: "left", pointDifference: 8.7 }), {
    requested: true,
    loaded: true,
  });
  assert.equal(presented.leaderIndex, 0);
  assert.equal(presented.gapLabel, "Gap 8.7");
});

test("valid 0.0 Battle Points displays correctly", () => {
  const presented = presentArenaMatchRow(
    battle(),
    metrics({
      leaderSide: "tied",
      pointDifference: 0,
      sides: {
        left: { pointsReady: true, points: { total: 0 } },
        right: { pointsReady: true, points: { total: 0 } },
      },
    }),
    { requested: true, loaded: true },
  );
  assert.equal(presented.scoreKind, "battle_points");
  assert.equal(presented.leftPointsLabel, "0.0");
  assert.equal(presented.rightPointsLabel, "0.0");
  assert.equal(presented.statusLabel, null);
  assert.notEqual(presented.scoreKind, "unavailable");
});

test("unhealthy metrics show DATA DELAY and do not use list MCAP as points", () => {
  const presented = presentArenaMatchRow(
    battle(),
    metrics({ dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] } }),
    { requested: true, loaded: true },
  );
  assert.equal(presented.scoreKind, "delay");
  assert.equal(presented.statusLabel, DATA_DELAY_LABEL);
  assert.equal(presented.leftPointsLabel, null);
  assert.equal(presented.rightPointsLabel, null);
  assert.equal(presented.leaderIndex, null);
});

test("unready points do not fall back to MCAP-as-points", () => {
  const presented = presentArenaMatchRow(
    battle(),
    metrics({
      sides: {
        left: { pointsReady: false, points: { total: 0 } },
        right: { pointsReady: true, points: { total: 4 } },
      },
    }),
    { requested: true, loaded: true },
  );
  assert.equal(presented.scoreKind, "unavailable");
  assert.equal(presented.statusLabel, POINTS_UNAVAILABLE_LABEL);
  assert.equal(presented.leftPointsLabel, null);
  assert.equal(presented.leaderIndex, null);
});

test("waiting rows invent neither Battle Points nor leader", () => {
  const waiting = battle({ state: "waiting", leaderSide: "left" });
  assert.equal(battleNeedsFeedMetrics(waiting), false);
  const presented = presentArenaMatchRow(waiting, metrics(), { requested: false, loaded: false });
  assert.equal(presented.scoreKind, "none");
  assert.equal(presented.leftPointsLabel, null);
  assert.equal(presented.rightPointsLabel, null);
  assert.equal(presented.leaderIndex, null);
  assert.equal(presented.statusLabel, null);
});

test("historical V1/MCAP finished battle is not relabeled Battle Points", () => {
  const historical = battle({
    state: "finished",
    settlementVersion: 1,
    scoreBasis: "mcap_pct_change",
    leaderSide: "left",
  });
  assert.equal(battleNeedsFeedMetrics(historical), false);
  const presented = presentArenaMatchRow(historical, null, { requested: false, loaded: true });
  assert.equal(presented.scoreKind, "legacy");
  assert.equal(presented.scoreCaption, "Score");
  assert.notEqual(presented.scoreCaption, "Battle points");
  assert.equal(presented.leftPointsLabel, "428000.0");
});

test("finished Battle V2 battle can display its authoritative result", () => {
  const finished = battle({ state: "finished", settlementVersion: 2, leaderSide: "right" });
  assert.equal(battleNeedsFeedMetrics(finished), true);
  const presented = presentArenaMatchRow(
    finished,
    metrics({
      finalBattlePoints: { left: 18.2, right: 11.0 },
      leaderSide: "left",
      pointDifference: 7.2,
    }),
    { requested: true, loaded: true },
  );
  assert.equal(presented.scoreKind, "battle_points");
  assert.equal(presented.leftPointsLabel, "18.2");
  assert.equal(presented.rightPointsLabel, "11.0");
  assert.equal(presented.leaderIndex, 0);
  assert.equal(presented.gapLabel, "Gap 7.2");
});

test("metrics fetch ids stay bounded to rendered Battle V2 rows", () => {
  const rows = [
    battle({ id: "wait-1", state: "waiting" }),
    ...Array.from({ length: 20 }, (_, index) => battle({ id: `live-${index}`, state: "live" })),
    battle({ id: "v1-fin", state: "finished", settlementVersion: 1 }),
  ];
  const ids = selectFeedMetricBattleIds(rows);
  assert.equal(ids.length, FEED_METRICS_LIMIT);
  assert.equal(ids[0], "live-0");
  assert.ok(!ids.includes("wait-1"));
  assert.ok(!ids.includes("v1-fin"));
});

test("feed wiring keeps /battle links and does not mount combat HUD/effects", () => {
  const row = readSrc("../../components/postgrad/ArenaMatchRow.tsx");
  const battlesPage = readSrc("../../pages/ArenaBattles.tsx");
  const arenaPage = readSrc("../../pages/Arena.tsx");
  const hook = readSrc("../../hooks/useArenaFeedBattleMetrics.ts");
  const command = readSrc("../../pages/command-center/CommandCenterBattles.tsx");

  assert.match(row, /to=\{presented\.href\}/);
  assert.match(row, /presentArenaMatchRow/);
  assert.doesNotMatch(row, /BattleCombatEffects/);
  assert.doesNotMatch(row, /BattleScoreHud/);
  assert.doesNotMatch(row, /BattleCombatantCard/);
  assert.match(battlesPage, /useArenaFeedBattleMetrics/);
  assert.match(arenaPage, /useArenaFeedBattleMetrics/);
  assert.match(hook, /fetchArenaBattleMetrics/);
  assert.doesNotMatch(hook, /useAblyBattleChannel/);
  assert.match(command, /FindMatchPanel/);
  assert.match(command, /challengePostGradBattle/);
  assert.match(command, /acceptPostGradBattle/);
  assert.match(command, /counterPostGradBattle/);
  assert.match(command, /declinePostGradBattle/);
});

test("no Battle Points formula exists in the feed overlay slice", () => {
  const files = [
    readSrc("./arenaMatchRowPresentation.mjs"),
    readSrc("../../components/postgrad/ArenaMatchRow.tsx"),
    readSrc("../../hooks/useArenaFeedBattleMetrics.ts"),
    readSrc("../../pages/ArenaBattles.tsx"),
    readSrc("../../pages/Arena.tsx"),
  ];
  for (const source of files) {
    for (const marker of FORMULA_MARKERS) {
      assert.doesNotMatch(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

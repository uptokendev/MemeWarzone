import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DATA_DELAY_LABEL, FEED_METRICS_LIMIT, presentArenaMatchRow, selectFeedMetricBattleIds } from "./arenaMatchRowPresentation.mjs";
import {
  POINTS_PENDING_LABEL,
  battleWallType,
  collectWallBattles,
  filterWallBattles,
  presentBattleWallModule,
  sortWallBattles,
  validBattlePointGap,
  wallTabForBattle,
} from "./battleWallPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function battle(overrides = {}) {
  return {
    id: "wall-1",
    state: "live",
    source: "queue",
    chainId: 56,
    startedAt: "2026-09-03T10:00:00.000Z",
    endsAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T11:00:00.000Z",
    stakeNative: 2,
    durationHours: 24,
    nativeSymbol: "BNB",
    rankedMode: "competitive",
    matchClassification: "strong",
    participants: [
      { tokenId: "0xaaa", tokenName: "Alpha", symbol: "ALPHA", score: 842000, marketCapUsd: 842000, holderCount: 2811, origin: "native", campaignAddress: "0xca" },
      { tokenId: "0xbbb", tokenName: "Bravo", symbol: "BRAVO", score: 790000, marketCapUsd: 790000, holderCount: 2422, origin: "import" },
    ],
    ...overrides,
  };
}

function metrics(overrides = {}) {
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

test("Live Battle Wall presents a rich two-sided module with server Battle Points", () => {
  const presented = presentBattleWallModule(battle(), metrics(), { requested: true, loaded: true });
  assert.equal(presented.tab, "live");
  assert.equal(presented.leftTicker, "$ALPHA");
  assert.equal(presented.rightTicker, "$BRAVO");
  assert.equal(presented.leftPointsLabel, "58.4");
  assert.equal(presented.rightPointsLabel, "51.2");
  assert.equal(presented.scoreKind, "battle_points");
  assert.equal(presented.leaderIndex, 0);
  assert.equal(presented.pointGap, 7.2);
  assert.equal(presented.type, "auto_deploy");
  assert.equal(presented.classification, "RANKED");
  assert.notEqual(presented.leftPointsLabel, "842000.0");
});

test("DATA DELAY does not display stale/legacy scores as current Battle Points", () => {
  const presented = presentBattleWallModule(
    battle(),
    metrics({ dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] } }),
    { requested: true, loaded: true },
  );
  assert.equal(presented.scoreKind, "delay");
  assert.equal(presented.statusLabel, DATA_DELAY_LABEL);
  assert.equal(presented.leftPointsLabel, null);
  assert.equal(presented.pointGap, null);
});

test("valid 0.0 Battle Points remain valid", () => {
  const presented = presentBattleWallModule(
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
  assert.equal(presented.leftPointsLabel, "0.0");
  assert.equal(presented.rightPointsLabel, "0.0");
  assert.equal(presented.scoreKind, "battle_points");
});

test("Upcoming matched battles show no fake Battle Points or timer scores", () => {
  const upcoming = battle({ id: "up-1", state: "matched", source: "queue" });
  assert.equal(wallTabForBattle(upcoming), "upcoming");
  const presented = presentBattleWallModule(upcoming, null, { requested: false, loaded: false });
  assert.equal(presented.tab, "upcoming");
  assert.equal(presented.scoreKind, "none");
  assert.equal(presented.leftPointsLabel, null);
  assert.equal(presented.leaderIndex, null);
});

test("unresolved challenged proposals are not public wall battles", () => {
  assert.equal(wallTabForBattle(battle({ state: "challenged", source: "challenge" })), null);
  const collected = collectWallBattles(
    { liveBattles: [], openForBattleQueue: [battle({ state: "challenged", source: "challenge" })], archivedBattles: [] },
    "upcoming",
  );
  assert.equal(collected.length, 0);
});

test("Finished V2 shows final Battle Points", () => {
  const finished = battle({ id: "fin-v2", state: "finished", settlementVersion: 2 });
  const presented = presentBattleWallModule(
    finished,
    metrics({ finalBattlePoints: { left: 61.0, right: 44.5 }, leaderSide: "left", pointDifference: 16.5 }),
    { requested: true, loaded: true },
  );
  assert.equal(presented.tab, "finished");
  assert.equal(presented.leftPointsLabel, "61.0");
  assert.equal(presented.rightPointsLabel, "44.5");
  assert.equal(presented.scoreKind, "battle_points");
});

test("Historical V1 stays legacy Score", () => {
  const historical = battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change" });
  const presented = presentBattleWallModule(historical, null, { requested: false, loaded: true });
  assert.equal(presented.scoreKind, "legacy");
  assert.equal(presented.scoreCaption, "Score");
  assert.notEqual(presented.scoreCaption, "Battle points");
});

test("explicit live V1 can still use legacy Score", () => {
  const liveV1 = battle({
    id: "live-v1",
    settlementVersion: 1,
    settlementScoringVersion: "mcap_pct_change",
  });
  const presented = presentBattleWallModule(liveV1, null, { requested: false, loaded: true });
  assert.equal(presented.scoreKind, "legacy");
  assert.equal(presented.scoreCaption, "Score");
  assert.equal(presented.leftPointsLabel, "842000.0");
});

test("live rows outside the 12-metric batch do not display list MCAP as Score", () => {
  const lives = Array.from({ length: 13 }, (_, index) =>
    battle({
      id: `live-${index + 1}`,
      settlementVersion: null,
      settlementScoringVersion: undefined,
      participants: [
        { tokenId: `0x${String(index + 1).padStart(40, "a")}`, tokenName: "Alpha", symbol: "ALPHA", score: 842000 + index },
        { tokenId: `0x${String(index + 1).padStart(40, "b")}`, tokenName: "Bravo", symbol: "BRAVO", score: 100000 },
      ],
    }),
  );
  const requested = selectFeedMetricBattleIds(lives);
  assert.equal(requested.length, FEED_METRICS_LIMIT);
  assert.equal(FEED_METRICS_LIMIT, 12);
  assert.ok(requested.includes("live-1"));
  assert.ok(!requested.includes("live-13"));

  const first = presentBattleWallModule(lives[0], metrics(), { requested: true, loaded: true });
  assert.equal(first.scoreKind, "battle_points");
  assert.equal(first.leftPointsLabel, "58.4");

  const thirteenth = presentBattleWallModule(lives[12], null, { requested: false, loaded: true });
  assert.equal(thirteenth.scoreKind, "pending");
  assert.equal(thirteenth.statusLabel, POINTS_PENDING_LABEL);
  assert.equal(thirteenth.leftPointsLabel, null);
  assert.equal(thirteenth.rightPointsLabel, null);
  assert.equal(thirteenth.leaderIndex, null);
  assert.equal(thirteenth.pointGap, null);
  assert.notEqual(thirteenth.leftPointsLabel, "842012.0");
  assert.notEqual(thirteenth.scoreKind, "legacy");

  const presentations = new Map([
    [lives[0].id, first],
    [lives[12].id, thirteenth],
  ]);
  const closest = sortWallBattles([lives[12], lives[0]], "closest_fight", presentations);
  assert.equal(closest[0].id, "live-1");
  assert.equal(closest[1].id, "live-13");
});

test("chain, type, and token search filters work", () => {
  const rows = [
    battle({ id: "bnb-q", chainId: 56, source: "queue", participants: [{ symbol: "DOGE", tokenName: "Dogecoin" }, { symbol: "PEPE", tokenName: "Pepe" }] }),
    battle({ id: "sol-m", chainId: 101, source: "challenge", participants: [{ symbol: "BONK", tokenName: "Bonk" }, { symbol: "WIF", tokenName: "Wif" }] }),
    battle({ id: "rh-t", chainId: 4663, source: "tournament", tournamentId: "t1", participants: [{ symbol: "HOOD", tokenName: "Hood" }, { symbol: "SPY", tokenName: "Spy" }] }),
  ];
  assert.equal(filterWallBattles(rows, { chain: "solana" }).map((row) => row.id).join(), "sol-m");
  assert.equal(filterWallBattles(rows, { type: "manual" }).map((row) => row.id).join(), "sol-m");
  assert.equal(filterWallBattles(rows, { type: "tournament" }).map((row) => row.id).join(), "rh-t");
  assert.equal(filterWallBattles(rows, { search: "doge" }).map((row) => row.id).join(), "bnb-q");
});

test("ending-soon, closest-fight, and newest sorts are deterministic", () => {
  const soon = battle({ id: "soon", endsAt: "2026-09-03T11:10:00.000Z", startedAt: "2026-09-03T09:00:00.000Z" });
  const later = battle({ id: "later", endsAt: "2026-09-03T18:00:00.000Z", startedAt: "2026-09-03T10:00:00.000Z" });
  const newest = battle({ id: "new", endsAt: "2026-09-04T01:00:00.000Z", startedAt: "2026-09-03T11:00:00.000Z" });
  const ending = sortWallBattles([later, soon, newest], "ending_soon");
  assert.deepEqual(ending.map((row) => row.id), ["soon", "later", "new"]);
  const fresh = sortWallBattles([soon, later, newest], "newest");
  assert.deepEqual(fresh.map((row) => row.id), ["new", "later", "soon"]);

  const close = presentBattleWallModule(soon, metrics({ pointDifference: 1.1, sides: { left: { pointsReady: true, points: { total: 10.1 } }, right: { pointsReady: true, points: { total: 9 } } } }), { requested: true, loaded: true });
  const far = presentBattleWallModule(later, metrics({ pointDifference: 20, sides: { left: { pointsReady: true, points: { total: 40 } }, right: { pointsReady: true, points: { total: 20 } } } }), { requested: true, loaded: true });
  const none = presentBattleWallModule(newest, null, { requested: true, loaded: true });
  assert.equal(validBattlePointGap(none), null);
  const presentations = new Map([[soon.id, close], [later.id, far], [newest.id, none]]);
  const closest = sortWallBattles([newest, later, soon], "closest_fight", presentations);
  assert.equal(closest[0].id, "soon");
  assert.equal(closest[1].id, "later");
  assert.equal(closest[2].id, "new");
});

test("tournament fights use the same wall module type path as native/imported", () => {
  const tournament = battle({ id: "tour", source: "tournament", tournamentId: "round-1" });
  const mixed = battle({ id: "mix" });
  assert.equal(battleWallType(tournament), "tournament");
  const presented = presentBattleWallModule(tournament, metrics(), { requested: true, loaded: true });
  const mixedPresented = presentBattleWallModule(mixed, metrics(), { requested: true, loaded: true });
  assert.equal(presented.scoreKind, mixedPresented.scoreKind);
  assert.equal(presented.typeLabel, "Tournament");
});

test("Battle Wall wiring keeps ArenaMatchRow, skips effects/realtime, and leaves challenge flows alone", () => {
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const row = readSrc("../../components/postgrad/ArenaMatchRow.tsx");
  const home = readSrc("../../pages/Arena.tsx");
  const command = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const wall = readSrc("./battleWallPresentation.mjs");

  assert.match(page, /BattleWallModule/);
  assert.match(page, /Upcoming/);
  assert.doesNotMatch(page, /useAblyBattleChannel/);
  assert.doesNotMatch(page, /BattleCombatEffects/);
  assert.match(moduleSrc, /presentBattleWallModule/);
  assert.match(vs, /DATA_DELAY_LABEL/);
  assert.match(row, /export function ArenaMatchRow/);
  assert.match(home, /ArenaMatchRow/);
  assert.match(command, /FindMatchPanel/);
  assert.match(command, /ENABLE AUTO DEPLOY/);
  assert.match(command, /challengePostGradBattle/);
  assert.doesNotMatch(wall, /calculateBattlePoints|marketCapWeight|50\/30\/20/);
  assert.equal(typeof presentArenaMatchRow, "function");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DATA_DELAY_LABEL, FEED_METRICS_LIMIT, presentArenaMatchRow, selectFeedMetricBattleIds } from "./arenaMatchRowPresentation.mjs";
import {
  POINTS_PENDING_LABEL,
  battleDomId,
  battleWallHref,
  battleWallType,
  collectWallBattles,
  commitFocusedFetch,
  filterWallBattles,
  findBattleInFeed,
  focusedRouteStatus,
  focusedWallFilterReset,
  isPublicWallBattle,
  mergeFocusedBattleForRoute,
  mergeFocusedBattleIntoRows,
  finiteBattleMetric,
  firstFiniteBattleMetric,
  formatBattleWallGapText,
  presentBattleWallFightBand,
  presentBattleWallModule,
  publicWallRejectReason,
  resolveFocusedWallBattle,
  shouldApplyFocusedWallReset,
  sortWallBattles,
  validBattlePointGap,
  wallEmptyCopy,
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

test("Upcoming wall modules keep card-vs-card combatants and a deployment HUD", () => {
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const upcoming = presentBattleWallModule(battle({ id: "up-1", state: "matched", source: "queue" }), null, {
    requested: false,
    loaded: false,
  });

  assert.equal(upcoming.tab, "upcoming");
  assert.equal(upcoming.leftPointsLabel, null);
  assert.equal(upcoming.rightPointsLabel, null);
  assert.equal(upcoming.leaderIndex, null);
  assert.equal(upcoming.gapLabel, null);
  assert.equal((moduleSrc.match(/<BattleWallCombatant/g) || []).length, 2);
  assert.match(moduleSrc, /grid-cols-1/);
  assert.match(moduleSrc, /deploymentPending=\{upcoming\}/);
  assert.match(moduleSrc, /pointsLabel=\{upcoming \? null : presented\.leftPointsLabel\}/);
  assert.match(moduleSrc, /leaderIndex=\{upcoming \? null : presented\.leaderIndex\}/);
  assert.match(moduleSrc, /clockLabel=\{upcoming \? null : battleClockLabel\(displayBattle\)\}/);
  assert.match(moduleSrc, /shouldMountWallCombatEffects/);
  assert.match(moduleSrc, /mountEffects \?/);
  assert.doesNotMatch(moduleSrc, /space-y-4 py-6 text-center/);
  assert.doesNotMatch(vs, /data-battle-deployment-hud/);
  assert.match(vs, /Deployment pending/);
  assert.match(vs, /Fight length/);
  assert.match(vs, /stakeLabel/);
  assert.match(vs, /deploymentPending \? null : formatBattleWallGapText/);
  assert.match(vs, /sr-only/);
  assert.match(vs, /data-battle-vs-reticle="true"/);
  assert.match(combatant, /firstFiniteBattleMetric/);
  assert.doesNotMatch(moduleSrc, /ArenaSupportButton/);
});

test("Missing combat metrics render em dash and explicit zeros stay zero", () => {
  assert.equal(finiteBattleMetric(null), null);
  assert.equal(finiteBattleMetric(undefined), null);
  assert.equal(finiteBattleMetric(""), null);
  assert.equal(finiteBattleMetric(0), 0);
  assert.equal(finiteBattleMetric("0"), 0);
  assert.equal(firstFiniteBattleMetric(null, undefined, 0), 0);
  assert.equal(firstFiniteBattleMetric(undefined, null), null);
  assert.equal(firstFiniteBattleMetric(842000, 0), 842000);

  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  assert.match(combatant, /firstFiniteBattleMetric/);
  assert.match(combatant, /ready=\{currentMcap !== null\}/);
  assert.match(combatant, /ready=\{currentHolders !== null\}/);
  assert.match(combatant, /ready=\{battleVolume !== null\}/);
  assert.match(combatant, /ready=\{pointsReady\}/);
  assert.doesNotMatch(combatant, /Number\([^)]+\) \|\| 0/);
  assert.doesNotMatch(combatant, /\?\? 0/);
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

function emptyFeed() {
  return { liveBattles: [], openForBattleQueue: [], archivedBattles: [] };
}

function simulateFocusedRoute() {
  let focusedId = "";
  let fetched = null;
  let appliedId = "";
  let tab = "live";
  let seq = 0;
  let feed = emptyFeed();

  const inFeed = () => findBattleInFeed(feed, focusedId);

  const view = () => {
    const focusedBattle = resolveFocusedWallBattle(focusedId, inFeed(), fetched);
    const status = focusedRouteStatus(focusedId, inFeed(), fetched);
    if (shouldApplyFocusedWallReset(appliedId, focusedId, focusedBattle)) {
      appliedId = focusedId;
      tab = focusedWallFilterReset(focusedBattle).tab;
    }
    const rows = mergeFocusedBattleForRoute(collectWallBattles(feed, tab), focusedBattle, tab, focusedId);
    return {
      focusedBattleId: focusedBattle?.id || null,
      status,
      tab,
      appliedId,
      rowIds: rows.map((row) => row.id),
    };
  };

  return {
    view,
    seq: () => seq,
    setRoute(id, nextFeed = emptyFeed()) {
      focusedId = String(id || "").trim();
      seq += 1;
      feed = nextFeed;
      return view();
    },
    receive(requestSeq, routeId, nextBattle) {
      if (requestSeq !== seq) return view();
      if (String(routeId) !== focusedId) return view();
      const committed = commitFocusedFetch(focusedId, nextBattle);
      if (!committed) return view();
      fetched = committed;
      return view();
    },
  };
}

test("focused routing helpers select public wall tabs and reject private proposals", () => {
  assert.equal(wallTabForBattle(battle({ state: "live" })), "live");
  assert.equal(wallTabForBattle(battle({ state: "matched" })), "upcoming");
  assert.equal(wallTabForBattle(battle({ state: "finished" })), "finished");
  assert.equal(isPublicWallBattle(battle({ state: "challenged", source: "challenge" })), false);
  assert.equal(publicWallRejectReason(battle({ state: "challenged" })), "challenged");
  assert.equal(publicWallRejectReason(battle({ state: "waiting" })), "waiting");
  assert.equal(focusedWallFilterReset(battle({ state: "matched" })).tab, "upcoming");
  assert.equal(focusedWallFilterReset(battle({ state: "live" })).chain, "all");
  assert.equal(battleWallHref("abc123"), "/warzone/battles/abc123");
  assert.equal(battleDomId("abc123"), "battle-abc123");
  const live = battle({ id: "in-feed" });
  const feed = { liveBattles: [live], openForBattleQueue: [], archivedBattles: [] };
  assert.equal(findBattleInFeed(feed, "in-feed")?.id, "in-feed");
  const merged = mergeFocusedBattleIntoRows([live], live, "live");
  assert.equal(merged.length, 1);
  const injected = mergeFocusedBattleIntoRows([], battle({ id: "missing-live" }), "live");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].id, "missing-live");
  assert.equal(mergeFocusedBattleIntoRows([], battle({ id: "ch", state: "challenged" }), "live").length, 0);
});

test("stale fetched live A is never treated as finished B while B loads", () => {
  const sim = simulateFocusedRoute();
  const liveA = battle({ id: "A", state: "live" });
  const finishedB = battle({ id: "B", state: "finished" });
  sim.setRoute("A");
  const resolvedA = sim.receive(sim.seq(), "A", liveA);
  assert.equal(resolvedA.focusedBattleId, "A");
  assert.equal(resolvedA.tab, "live");
  assert.equal(resolvedA.appliedId, "A");

  const loadingB = sim.setRoute("B");
  assert.equal(loadingB.focusedBattleId, null);
  assert.equal(loadingB.status, "loading");
  assert.equal(loadingB.tab, "live");
  assert.equal(loadingB.appliedId, "A");
  assert.equal(loadingB.rowIds.includes("A"), false);
  assert.equal(shouldApplyFocusedWallReset("A", "B", liveA), false);

  const resolvedB = sim.receive(sim.seq(), "B", finishedB);
  assert.equal(resolvedB.focusedBattleId, "B");
  assert.equal(resolvedB.status, "ready");
  assert.equal(resolvedB.tab, "finished");
  assert.equal(resolvedB.appliedId, "B");
  assert.deepEqual(resolvedB.rowIds, ["B"]);
});

test("matched A then live B switches UPCOMING to LIVE", () => {
  const sim = simulateFocusedRoute();
  sim.setRoute("A");
  const upcomingA = sim.receive(sim.seq(), "A", battle({ id: "A", state: "matched" }));
  assert.equal(upcomingA.tab, "upcoming");
  assert.equal(upcomingA.appliedId, "A");

  sim.setRoute("B");
  const liveB = sim.receive(sim.seq(), "B", battle({ id: "B", state: "live" }));
  assert.equal(liveB.focusedBattleId, "B");
  assert.equal(liveB.tab, "live");
  assert.equal(liveB.appliedId, "B");
});

test("rapid A then B then C ignores late A and B results", () => {
  const sim = simulateFocusedRoute();
  sim.setRoute("A");
  const seqA = sim.seq();
  sim.setRoute("B");
  const seqB = sim.seq();
  const onC = sim.setRoute("C");
  const seqC = sim.seq();
  assert.equal(onC.focusedBattleId, null);
  assert.equal(onC.status, "loading");
  assert.equal(onC.appliedId, "");

  const lateA = sim.receive(seqA, "A", battle({ id: "A", state: "live" }));
  assert.equal(lateA.focusedBattleId, null);
  assert.equal(lateA.rowIds.includes("A"), false);

  const lateB = sim.receive(seqB, "B", battle({ id: "B", state: "finished" }));
  assert.equal(lateB.focusedBattleId, null);
  assert.equal(lateB.tab, "live");
  assert.equal(lateB.rowIds.includes("B"), false);

  const resolvedC = sim.receive(seqC, "C", battle({ id: "C", state: "live" }));
  assert.equal(resolvedC.focusedBattleId, "C");
  assert.equal(resolvedC.tab, "live");
  assert.equal(resolvedC.appliedId, "C");
  assert.deepEqual(resolvedC.rowIds, ["C"]);
});

test("returning A then B then A reapplies A's tab and focus", () => {
  const sim = simulateFocusedRoute();
  sim.setRoute("A");
  assert.equal(sim.receive(sim.seq(), "A", battle({ id: "A", state: "live" })).tab, "live");
  sim.setRoute("B");
  assert.equal(sim.receive(sim.seq(), "B", battle({ id: "B", state: "finished" })).tab, "finished");
  const backToA = sim.setRoute("A");
  assert.equal(backToA.focusedBattleId, null);
  assert.equal(backToA.tab, "finished");
  assert.equal(backToA.appliedId, "B");
  const restoredA = sim.receive(sim.seq(), "A", battle({ id: "A", state: "live" }));
  assert.equal(restoredA.focusedBattleId, "A");
  assert.equal(restoredA.tab, "live");
  assert.equal(restoredA.appliedId, "A");
});

test("stale fetched battle is never injected under a mismatched route ID", () => {
  const liveA = battle({ id: "A", state: "live" });
  const fetchedA = commitFocusedFetch("A", liveA);
  assert.equal(resolveFocusedWallBattle("B", null, fetchedA), null);
  assert.equal(focusedRouteStatus("B", null, fetchedA), "loading");
  assert.equal(commitFocusedFetch("B", liveA), null);
  const injected = mergeFocusedBattleForRoute([], liveA, "live", "B");
  assert.equal(injected.length, 0);
  const resolvedThenMerged = mergeFocusedBattleForRoute(
    [],
    resolveFocusedWallBattle("B", null, fetchedA),
    "live",
    "B",
  );
  assert.equal(resolvedThenMerged.length, 0);
});

test("challenged and waiting fetched battles remain rejected for focused routing", () => {
  const challenged = commitFocusedFetch("ch", battle({ id: "ch", state: "challenged", source: "challenge" }));
  const waiting = commitFocusedFetch("wait", battle({ id: "wait", state: "waiting", source: "queue" }));
  assert.equal(resolveFocusedWallBattle("ch", null, challenged), null);
  assert.equal(focusedRouteStatus("ch", null, challenged), "unavailable");
  assert.equal(resolveFocusedWallBattle("wait", null, waiting), null);
  assert.equal(focusedRouteStatus("wait", null, waiting), "unavailable");
  assert.equal(mergeFocusedBattleForRoute([], challenged.battle, "live", "ch").length, 0);
  assert.equal(mergeFocusedBattleForRoute([], waiting.battle, "upcoming", "wait").length, 0);
  assert.equal(shouldApplyFocusedWallReset("", "ch", challenged.battle), false);
});

test("route-keyed merge still avoids duplicating an in-feed focused battle", () => {
  const live = battle({ id: "in-feed" });
  const merged = mergeFocusedBattleForRoute([live], live, "live", "in-feed");
  assert.equal(merged.length, 1);
  const injected = mergeFocusedBattleForRoute([], battle({ id: "missing-live" }), "live", "missing-live");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].id, "missing-live");
});

test("Battle Wall wiring keeps ArenaMatchRow, reuses wall realtime/effects, and leaves challenge flows alone", () => {
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const app = readSrc("../../App.tsx");
  const details = readSrc("../../pages/BattleDetails.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const row = readSrc("../../components/postgrad/ArenaMatchRow.tsx");
  const home = readSrc("../../pages/Arena.tsx");
  const command = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const wall = readSrc("./battleWallPresentation.mjs");
  const focus = readSrc("../../hooks/useBattleWallFocus.ts");

  assert.match(page, /BattleWallModule/);
  assert.match(page, /Upcoming/);
  assert.match(page, /useParams/);
  assert.match(page, /fetchPostGradBattleDetails/);
  assert.match(page, /resolveFocusedWallBattle/);
  assert.match(page, /commitFocusedFetch/);
  assert.match(page, /shouldApplyFocusedWallReset/);
  assert.match(page, /focusRequestSeq/);
  assert.match(page, /Battle unavailable/);
  assert.match(page, /useArenaFeedBattleMetrics/);
  assert.match(page, /selectActiveWallRealtimeIds/);
  assert.match(page, /CreatorChallengeCarousel/);
  assert.doesNotMatch(page, /useAblyBattleChannel/);
  assert.doesNotMatch(page, /BattleCombatEffects/);
  assert.match(app, /path="\/warzone\/battles\/:battleId"/);
  assert.match(app, /path="\/warzone\/battles"/);
  assert.match(app, /path="\/battle\/:id"/);
  assert.match(app, /element=\{<BattleDetails \/>\}/);
  assert.match(details, /export default function BattleDetails|function BattleDetails|export default BattleDetails/);
  assert.match(moduleSrc, /data-battle-id/);
  assert.match(moduleSrc, /motion-reduce:transition-none/);
  assert.match(moduleSrc, /to=\{presented\.href\}/);
  assert.match(moduleSrc, /BattleCombatEffects/);
  assert.match(moduleSrc, /useBattleWallRealtime/);
  assert.match(focus, /prefers-reduced-motion/);
  assert.match(vs, /DATA_DELAY_LABEL/);
  assert.match(row, /export function ArenaMatchRow/);
  assert.match(home, /WarzoneBattlePreview/);
  assert.doesNotMatch(home, /ArenaMatchRow/);
  assert.match(command, /FindMatchPanel/);
  assert.match(command, /ENABLE AUTO DEPLOY/);
  assert.match(command, /challengePostGradBattle/);
  assert.doesNotMatch(wall, /calculateBattlePoints|marketCapWeight|50\/30\/20/);
  assert.equal(typeof presentArenaMatchRow, "function");
  assert.match(presentBattleWallModule(battle(), metrics(), { requested: true, loaded: true }).href, /\/warzone\/battles\/wall-1/);
});

test("Battle Wall polish keeps stacked mobile combat layout and DATA DELAY copy", () => {
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  const effects = readSrc("../../components/arena/BattleCombatEffects.tsx");

  assert.match(moduleSrc, /grid-cols-1/);
  assert.match(moduleSrc, /md:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(moduleSrc, /remaining=\{presented\.tab === "live"\}/);
  assert.match(moduleSrc, /motion-reduce:shadow-none/);
  assert.match(vs, /Score updates temporarily paused/);
  assert.match(vs, /sr-only/);
  assert.match(combatant, /data-battle-combatant-art/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /data-battle-wall-skeleton/);
  assert.match(page, /wallEmptyCopy/);
  assert.match(carousel, /overflow-hidden/);
  assert.match(carousel, /beginChallengePending/);
  assert.match(effects, /pointer-events-none/);
  assert.doesNotMatch(page, /BOOST|Final Salvo|Vote Tournament/);
  assert.doesNotMatch(moduleSrc, /Battle Boost|Final Salvo/);
  assert.equal(wallEmptyCopy({ source: "empty" }).kind, "unavailable");
  assert.equal(wallEmptyCopy({ tab: "live", tabCount: 0, filteredCount: 0 }).title, "No live battles right now.");
  assert.equal(wallEmptyCopy({ tab: "live", tabCount: 4, filteredCount: 0 }).kind, "filters");
  assert.equal(wallEmptyCopy({ loading: true, filteredCount: 0 }).kind, "loading");
});

test("Battle Wall VS gap labels Battle Points as BP and historical V1 as Score gap", () => {
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const delaySpoken = vs.split("const spoken")[1]?.split("return (")[0] || "";

  assert.equal(formatBattleWallGapText("Gap 7.2", "battle_points"), "+7.2 BP");
  assert.equal(formatBattleWallGapText("Gap 7.2", "legacy"), "Gap 7.2");
  assert.doesNotMatch(formatBattleWallGapText("Gap 7.2", "legacy") || "", /BP/);
  assert.equal(formatBattleWallGapText(null, "battle_points"), null);

  const spokenLegacy = ["$ALPHA 8.4 versus $BRAVO 1.2", "$ALPHA LEADS", formatBattleWallGapText("Gap 7.2", "legacy")].join(". ");
  assert.doesNotMatch(spokenLegacy, /BP/);
  assert.match(spokenLegacy, /Gap 7\.2/);

  assert.match(vs, /formatBattleWallGapText\(gapLabel, scoreKind\)/);
  assert.match(delaySpoken, /DATA_DELAY_LABEL/);
  assert.match(delaySpoken, /Score updates temporarily paused/);
  assert.doesNotMatch(delaySpoken.split("?")[1]?.split(":")[0] || "", /BP/);
  assert.match(vs, /DATA_DELAY_LABEL/);

  const historical = presentBattleWallModule(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change" }),
    null,
    { requested: false, loaded: true },
  );
  assert.equal(historical.scoreKind, "legacy");
  assert.equal(historical.scoreCaption, "Score");
  if (historical.gapLabel) {
    assert.equal(formatBattleWallGapText(historical.gapLabel, historical.scoreKind), historical.gapLabel);
    assert.doesNotMatch(formatBattleWallGapText(historical.gapLabel, historical.scoreKind) || "", /BP/);
  }

  const liveV2 = presentBattleWallModule(battle(), metrics(), { requested: true, loaded: true });
  assert.equal(liveV2.scoreKind, "battle_points");
  if (liveV2.gapLabel) {
    assert.equal(formatBattleWallGapText(liveV2.gapLabel, liveV2.scoreKind), "+7.2 BP");
  }
});

test("Battle Wall visual parity uses bounded combatant cards, 2x2 metrics, and no fake Boost", () => {
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const effects = readSrc("../../components/arena/BattleCombatEffects.tsx");
  const page = readSrc("../../pages/ArenaBattles.tsx");

  assert.match(combatant, /data-battle-combatant-art/);
  assert.match(combatant, /object-cover/);
  assert.match(combatant, /data-battle-combatant-layout="split"/);
  assert.match(combatant, /mwz-flat-card/);
  assert.match(combatant, /data-battle-combatant-bleed/);
  assert.match(combatant, /data-battle-combatant-readability/);
  assert.match(combatant, /data-battle-combatant-bounded="true"/);
  assert.doesNotMatch(combatant, /mockTokenArtForTicker/);
  assert.match(combatant, /data-battle-combatant-split="true"/);
  assert.match(combatant, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
  assert.match(combatant, /md:w-\[8\.5rem\]/);
  assert.doesNotMatch(combatant, /grid-cols-1/);
  assert.match(combatant, /aspect-square/);
  assert.doesNotMatch(combatant, /h-44 sm:h-52 md:h-64 lg:h-72/);
  assert.match(combatant, /data-battle-metric-grid/);
  assert.match(combatant, /grid-cols-2/);
  assert.match(combatant, /pointsLabel \|\| "—"/);
  assert.match(combatant, /ready=\{pointsReady\}/);
  assert.match(combatant, /data-battle-combatant-actions/);
  assert.doesNotMatch(combatant, /pointsLabel \|\| "0"|fake 0|Battle Boost|Final Salvo/);
  assert.match(vs, /formatBattleWallGapText\(gapLabel, scoreKind\)/);
  assert.match(vs, /data-battle-vs-reticle="true"/);
  assert.match(vs, /DATA_DELAY_LABEL/);
  assert.match(moduleSrc, /data-battle-wall-open="true"/);
  assert.doesNotMatch(moduleSrc, /mwz-hud-frame/);
  assert.match(moduleSrc, /data-battle-wall-actions/);
  assert.match(moduleSrc, /data-battle-wall-actions-reserved/);
  assert.match(moduleSrc, /grid-cols-1/);
  assert.match(moduleSrc, /md:items-center/);
  assert.match(moduleSrc, /md:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(moduleSrc, /useBattleWallRealtime\(battle\.id, realtimeActive && live\)/);
  assert.equal(moduleSrc.split("useBattleWallRealtime(").length - 1, 1);
  assert.match(effects, /pointer-events-none/);
  assert.match(effects, /overflow-hidden/);
  assert.match(effects, /z-\[12\]/);
  assert.doesNotMatch(moduleSrc, /ArenaSupportButton|WarPoolPanel|BattleMetricBreakdown/);
  assert.match(moduleSrc, /BattleFightActions/);
  assert.doesNotMatch(page, /Battle Boost|Final Salvo|Vote Tournament/);
  assert.doesNotMatch(combatant, /BOOST|Vote Tournament|Final Salvo|sponsorship/i);
  assert.match(moduleSrc, /<BattleWallCombatant/);
  assert.match(moduleSrc, /deploymentPending=\{upcoming\}/);
});

test("Battle Wall mockup parity keeps split combatant cards, SHARE/MORE, and generation-neutral HUD", () => {
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const effects = readSrc("../../components/arena/BattleCombatEffects.tsx");
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  const share = readSrc("../../components/arena/BattleShareMenu.tsx");
  const moreSrc = readSrc("../../components/arena/BattleWallMore.tsx");

  assert.equal((moduleSrc.match(/<BattleWallCombatant/g) || []).length, 2);
  assert.match(moduleSrc, /grid-cols-1/);
  assert.match(moduleSrc, /md:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(combatant, /data-battle-combatant-layout="split"/);
  assert.match(combatant, /mwz-flat-card/);
  assert.match(combatant, /data-battle-combatant-bleed/);
  assert.match(combatant, /data-battle-combatant-readability/);
  assert.match(combatant, /data-battle-combatant-bounded="true"/);
  assert.doesNotMatch(combatant, /mockTokenArtForTicker/);
  assert.match(combatant, /data-battle-combatant-split="true"/);
  assert.match(combatant, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
  assert.match(combatant, /md:w-\[8\.5rem\]/);
  assert.doesNotMatch(combatant, /grid-cols-1/);
  assert.match(combatant, /hidden line-clamp-2[\s\S]*md:block/);
  assert.match(combatant, /firstFiniteBattleMetric/);
  assert.match(combatant, /currentMcap === null \? "—" : formatCompactUsd\(currentMcap\)/);
  assert.match(combatant, /currentHolders === null \? "—" : Number\(currentHolders\)\.toLocaleString\(\)/);
  assert.match(combatant, /battleVolume === null \? "—" : formatCompactUsd\(battleVolume\)/);
  assert.match(combatant, /pointsLabel \|\| "—"/);
  assert.doesNotMatch(combatant, /\?\? 0/);
  assert.match(combatant, /caption.includes\("vote"\) \? "VOTES" : caption.includes\("score"\) \? "SCORE" : "POINTS"/);
  assert.match(combatant, /data-battle-combatant-art-fallback/);
  assert.match(combatant, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.doesNotMatch(combatant, /\|\| "\/placeholder\.svg"/);
  assert.match(combatant, /data-battle-combatant-actions/);
  assert.doesNotMatch(combatant, /BOOST|Battle Boost|onClick=\{.*boost/i);
  assert.match(moduleSrc, /BattleShareMenu/);
  assert.match(share, /Copy battle link/);
  assert.match(share, /Share on X/);
  assert.match(moduleSrc, /data-battle-more-toggle/);
  assert.match(moduleSrc, /moreToggle\.label/);
  assert.match(moreSrc, /BattleFunding/);
  assert.match(moduleSrc, /data-battle-wall-status-band/);
  assert.match(moduleSrc, /presentBattleWallFightBand/);
  assert.match(moduleSrc, /leaderReady && presented\.leaderIndex === 0/);
  assert.match(moduleSrc, /pointsLabel=\{upcoming \? null : presented\.leftPointsLabel\}/);
  assert.match(moduleSrc, /shouldMountWallCombatEffects/);
  assert.match(effects, /data-battle-combat-side/);
  assert.match(effects, /data-battle-effects-for/);
  assert.match(carousel, /beginChallengePending/);
  assert.doesNotMatch(moduleSrc, /CreatorChallengeCarousel/);
  assert.doesNotMatch(combatant, /calculateBattlePoints|50\/30\/20|45\/27\/18|war_pool_v/);
  assert.doesNotMatch(vs, /COMMUNITY VS COMMUNITY/);
  assert.doesNotMatch(moduleSrc, /COMMUNITY VS COMMUNITY/);

  const liveBand = presentBattleWallFightBand(
    presentBattleWallModule(battle(), metrics(), { requested: true, loaded: true }),
    { chainLabel: "BNB Chain", clockLabel: "2h 17m left" },
  );
  assert.equal(liveBand.stateLabel, "LIVE BATTLE");
  assert.equal(liveBand.matchup, "$ALPHA vs $BRAVO");
  assert.equal(liveBand.typeLabel, "AUTO DEPLOY");
  assert.equal(liveBand.classification, "RANKED");
  assert.equal(liveBand.clockLabel, "2h 17m left");
  assert.doesNotMatch(liveBand.stateLabel, /COMMUNITY/);

  const upcomingBand = presentBattleWallFightBand(
    presentBattleWallModule(battle({ id: "up-1", state: "matched" }), null),
    { chainLabel: "BNB Chain", clockLabel: "Stakes due" },
  );
  assert.equal(upcomingBand.stateLabel, "DEPLOYMENT");
  assert.equal(upcomingBand.clockLabel, null);

  const delayed = presentBattleWallModule(
    battle(),
    metrics({ dataHealth: { healthy: false, status: "data_delay", reasons: ["stale"] } }),
    { requested: true, loaded: true },
  );
  assert.equal(delayed.scoreKind, "delay");
  assert.equal(delayed.leftPointsLabel, null);
  assert.equal(delayed.leaderIndex, null);

  const historical = presentBattleWallModule(
    battle({ id: "fin-v1", state: "finished", settlementVersion: 1, scoreBasis: "mcap_pct_change" }),
    null,
    { requested: false, loaded: true },
  );
  assert.equal(historical.scoreKind, "legacy");
  assert.equal(historical.scoreCaption, "Score");

  const zero = firstFiniteBattleMetric(null, undefined, 0);
  assert.equal(zero, 0);
  assert.equal(firstFiniteBattleMetric(undefined, null), null);
});

test("Battle Wall combatant keeps art-left split on mobile instead of stacking internally", () => {
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const effects = readSrc("../../components/arena/BattleCombatEffects.tsx");

  assert.doesNotMatch(combatant, /grid-cols-1/);
  assert.match(combatant, /data-battle-combatant-split="true"/);
  assert.match(combatant, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
  assert.match(combatant, /aspect-square/);
  assert.match(combatant, /w-\[6\.75rem\]/);
  assert.match(combatant, /sm:w-\[7\.25rem\]/);
  assert.match(combatant, /md:w-\[8\.5rem\]/);
  assert.match(combatant, /data-battle-combatant-bounded="true"/);
  assert.match(combatant, /h-auto max-h-\[22rem\]/);
  assert.doesNotMatch(combatant, /100vh|min-h-screen/);
  assert.match(combatant, /hidden line-clamp-2[\s\S]*md:block/);
  assert.match(combatant, /grid-cols-2/);
  assert.match(combatant, /data-battle-combatant-actions/);
  assert.match(moduleSrc, /grid-cols-1/);
  assert.match(moduleSrc, /md:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(vs, /py-1/);
  assert.match(vs, /data-battle-vs-reticle="true"/);
  assert.match(effects, /max-width: 767px/);
  assert.match(effects, /randomBetween\(6, 34\)/);
});

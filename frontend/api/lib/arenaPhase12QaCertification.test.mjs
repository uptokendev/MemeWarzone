import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateBattlePoints } from "./arenaBattlePoints.js";
import {
  calculateMatchQuality,
  recommendMatchCandidates,
} from "./arenaMatchQuality.js";
import { buildPublicBattleMetricsSnapshot } from "./arenaBattleRealtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");
const NOW_MS = Date.parse("2026-09-03T00:00:00.000Z");

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(frontendRoot, rel), "utf8");
}

function profile(overrides = {}) {
  return {
    tokenId: overrides.tokenId || "0x1111111111111111111111111111111111111111",
    ownerWallet: overrides.ownerWallet || "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    marketCapUsd: overrides.marketCapUsd ?? 100_000,
    holderCount: overrides.holderCount ?? 1_000,
    liquidityUsd: overrides.liquidityUsd ?? 25_000,
    volumeUsd: overrides.volumeUsd ?? 10_000,
    marketDataHealthy: overrides.marketDataHealthy ?? true,
    launchedAt: overrides.launchedAt ?? "2026-08-01T00:00:00.000Z",
    origin: overrides.origin || "native",
  };
}

function rival(overrides = {}) {
  return profile({
    tokenId: "0x2222222222222222222222222222222222222222",
    ownerWallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    marketCapUsd: 108_000,
    holderCount: 1_080,
    liquidityUsd: 26_000,
    volumeUsd: 10_500,
    launchedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  });
}

function pointInput(overrides = {}) {
  return {
    baseline: {
      startMcapUsd: 100_000,
      startHolders: 1_000,
      startLiquidityUsd: 25_000,
      baselineTimestamp: "2026-09-02T00:00:00.000Z",
      ...(overrides.baseline || {}),
    },
    current: {
      marketCapUsd: 115_000,
      holders: 1_120,
      liquidityUsd: 26_000,
      updatedAt: "2026-09-02T23:59:30.000Z",
      healthy: true,
      ...(overrides.current || {}),
    },
    eligibleVolume: {
      usd: 5_000,
      rawUsd: 5_000,
      clusters: [
        { clusterId: "a", countedUsd: 1_000 },
        { clusterId: "b", countedUsd: 1_000 },
        { clusterId: "c", countedUsd: 1_000 },
        { clusterId: "d", countedUsd: 1_000 },
        { clusterId: "e", countedUsd: 1_000 },
      ],
      ...(overrides.eligibleVolume || {}),
    },
    now: NOW_MS,
  };
}

test("Phase 12 matchmaking matrix rejects isolated MCAP, holder, and liquidity mismatches", () => {
  const left = profile();
  const cases = [
    ["hard_mcap_ratio", rival({ marketCapUsd: 900_000 })],
    ["hard_holder_ratio", rival({ holderCount: 9_000 })],
    ["hard_liquidity_ratio", rival({ liquidityUsd: 225_000 })],
  ];
  for (const [reason, right] of cases) {
    const result = calculateMatchQuality(left, right, { nowMs: NOW_MS });
    assert.equal(result.rankedEligible, false, `${reason} must not enter ranked matchmaking`);
    assert.equal(result.classification, "open_war");
    assert.ok(result.reasons.includes(reason));
  }
});

test("Phase 12 imported/native parity uses the same normalized Match Quality path", () => {
  const native = profile({ origin: "native" });
  const imported = rival({ origin: "import" });
  const mixed = calculateMatchQuality(native, imported, { nowMs: NOW_MS });
  const bothNative = calculateMatchQuality(native, { ...imported, origin: "native" }, { nowMs: NOW_MS });
  assert.equal(mixed.rankedEligible, true);
  assert.notEqual(mixed.classification, "open_war");
  assert.equal(mixed.matchScore, bothNative.matchScore);
  assert.deepEqual(mixed.components, bothNative.components);
});

test("Phase 12 ranked threshold is inclusive at the exact computed boundary and exclusive below it", () => {
  const left = profile();
  const right = rival({ marketCapUsd: 180_000, holderCount: 1_700, liquidityUsd: 40_000, volumeUsd: 17_000 });
  const unconstrained = calculateMatchQuality(left, right, {
    nowMs: NOW_MS,
    config: { competitiveMinimum: 0 },
  });
  assert.ok(unconstrained.matchScore > 0);

  const exact = calculateMatchQuality(left, right, {
    nowMs: NOW_MS,
    config: { competitiveMinimum: unconstrained.matchScore },
  });
  assert.equal(exact.rankedEligible, true);
  assert.notEqual(exact.classification, "open_war");

  const below = calculateMatchQuality(left, right, {
    nowMs: NOW_MS,
    config: { competitiveMinimum: unconstrained.matchScore + 0.1 },
  });
  assert.equal(below.rankedEligible, false);
  assert.equal(below.classification, "open_war");
  assert.ok(below.reasons.includes("below_ranked_minimum"));
});

test("Phase 12 ranked recommendations never return Open War and cleanly return no opponent", () => {
  const left = profile();
  const weak = [
    rival({ tokenId: "0x3333333333333333333333333333333333333333", marketCapUsd: 10_000_000 }),
    rival({ tokenId: "0x4444444444444444444444444444444444444444", holderCount: 20_000 }),
    rival({ tokenId: "0x5555555555555555555555555555555555555555", liquidityUsd: 1_000_000 }),
    rival({ tokenId: "0x6666666666666666666666666666666666666666", marketDataHealthy: false }),
  ];
  assert.deepEqual(recommendMatchCandidates(left, weak, { nowMs: NOW_MS }), []);

  const recommendations = recommendMatchCandidates(left, [rival(), ...weak], { nowMs: NOW_MS });
  assert.equal(recommendations.length, 1);
  assert.ok(recommendations.every((entry) => entry.rankedEligible && entry.classification !== "open_war"));
});

test("Phase 12 manual mismatch remains available as Open War while auto-match is ranked-only", () => {
  const battles = readApi("arenaBattles.js");
  const challenge = battles.split("async function handleChallenge")[1]?.split("async function handleAccept")[0] || "";
  const autoMatch = battles.split("async function tryAutoMatch")[1]?.split("async function currentMcap")[0] || "";
  assert.match(challenge, /calculateMatchQuality|matchQuality/i);
  assert.doesNotMatch(challenge, /below_ranked_minimum[\s\S]{0,160}return json\(res, 4\d\d/i);
  assert.match(autoMatch, /recommendMatchCandidates/);
});

test("Phase 12 challenge lifecycle keeps challenge, accept, counter, decline, expiry and escrow gates", () => {
  const battles = readApi("arenaBattles.js");
  for (const handler of ["handleChallenge", "handleAccept", "handleCounter", "handleDecline", "expireChallenge"]) {
    assert.match(battles, new RegExp(`(?:async function|function) ${handler}\\b`));
  }
  assert.match(battles, /const MAX_COUNTERS = 12/);
  assert.match(battles, /offer_count/);
  assert.match(battles, /offered_stake_native/);
  assert.match(battles, /offered_duration_hours/);
  assert.match(battles, /state:\s*["']challenged["']/);
  assert.match(battles, /state:\s*["']matched["']/);
  assert.match(battles, /state:\s*["']expired["']/);
  assert.match(battles, /readOnchainPool/);
  assert.match(battles, /escrowRequired/);
  assert.match(battles, /goLiveFromMatched/);
});

test("Phase 12 Battle Points remain deterministic and chain-neutral for the same normalized snapshot", () => {
  const base = pointInput();
  const bnb = calculateBattlePoints({ ...base, chainId: 56 });
  const solana = calculateBattlePoints({ ...base, chainId: 101 });
  const robinhood = calculateBattlePoints({ ...base, chainId: 46630 });
  assert.equal(bnb.totalPoints, solana.totalPoints);
  assert.equal(solana.totalPoints, robinhood.totalPoints);
  assert.deepEqual(bnb.components, robinhood.components);
});

test("Phase 12 server Battle snapshot leader and HUD display use the same persisted point totals", () => {
  const side = (name, points) => ({
    side: name,
    token_id: name,
    scoring_version: "battle_points_v2",
    start_mcap_usd: 100_000,
    start_holders: 1_000,
    start_liquidity_usd: 25_000,
    baseline_healthy: true,
    current_mcap_usd: 110_000,
    current_holders: 1_050,
    current_liquidity_usd: 26_000,
    data_healthy: true,
    eligible_battle_volume_usd: 2_000,
    mcap_points: points * 0.5,
    holder_points: points * 0.3,
    volume_points: points * 0.2,
    battle_points: points,
    metrics_updated_at: "2026-09-03T00:00:00.000Z",
  });
  const snapshot = buildPublicBattleMetricsSnapshot(
    { id: "phase12-score", chain_id: 56, state: "live" },
    [side("left", 62.5), side("right", 57.25)],
  );
  assert.equal(snapshot.sides.left.points.total, 62.5);
  assert.equal(snapshot.sides.right.points.total, 57.25);
  assert.equal(snapshot.leaderSide, "left");
  assert.equal(snapshot.pointDifference, 5.25);

  const hud = readFrontend("src/components/arena/BattleScoreHud.tsx");
  assert.match(hud, /score\(left\?\.points\.total, left\?\.pointsReady === true\)/);
  assert.match(hud, /score\(right\?\.points\.total, right\?\.pointsReady === true\)/);
  assert.doesNotMatch(hud, /calculateBattlePoints/);
});

test("Phase 12 realtime reconciles authoritative REST after gaps and rejects stale patches", () => {
  const hook = readFrontend("src/hooks/useArenaBattleRealtimeDetails.ts");
  const realtime = readFrontend("src/lib/arena/battleRealtime.ts");
  assert.match(hook, /fetchPostGradBattleDetails/);
  assert.match(hook, /fetchArenaBattleMetrics/);
  assert.match(hook, /client\.connection\.on\(["']connected["']/);
  assert.match(hook, /client\.connection\.on\(["']disconnected["']/);
  assert.match(hook, /client\.connection\.on\(["']suspended["']/);
  assert.match(hook, /connectedOnce\.current[\s\S]*reconcile\(\)/);
  assert.match(hook, /incomingMetricTs < currentMetricTs/);
  assert.match(realtime, /arena_battle_finished/);
  assert.match(realtime, /shouldRefetch:\s*true/);
});

test("Phase 12 combat effects are bounded, recover safely, and respect compact/reduced-motion modes", () => {
  const component = readFrontend("src/components/arena/BattleCombatEffects.tsx");
  const helper = readFrontend("src/lib/arena/battleCombatEffects.mjs");
  const helperTests = readFrontend("src/lib/arena/battleCombatEffects.test.mjs");

  assert.match(helper, /MAX_HOLES_PER_SIDE = 40/);
  assert.match(helper, /MAX_TRACERS = 18/);
  assert.match(helper, /HOLE_TTL_MS = 60_000/);
  assert.match(helper, /TRACER_TTL_MS = 950/);
  assert.match(helper, /if \(reducedMotion\) return 1/);
  assert.match(helper, /return rows\.slice\(-MAX_TRACERS\)/);
  assert.match(helper, /shouldClearCombatBaseline/);
  assert.match(helper, /planCombatAttacks/);
  assert.match(component, /prefers-reduced-motion: reduce/);
  assert.match(component, /max-width: 1279px/);
  assert.match(component, /if \(!reducedMotion && !compact\)/);
  assert.match(component, /current\.filter\(\(row\) => now - row\.createdAt < HOLE_TTL_MS\)/);
  assert.match(component, /window\.clearInterval\(timer\)/);
  assert.match(helperTests, /repeated enabled updates keep DOM counts bounded/);
  assert.match(helperTests, /mobile compact density still fires bounded combat feedback/);
  assert.match(helperTests, /unhealthy snapshot with null timestamp clears baseline and fires no catch-up/);
});

test("Phase 12 tournament QA preserves Round-1 similarity, later winner advancement and no duplicate scoring engine", () => {
  const tournaments = readApi("arenaTournaments.js");
  const tournamentCert = readApi("lib/arenaTournamentV2Certification.test.mjs");
  assert.equal((tournaments.match(/optimizeMatchPairings\s*\(/g) || []).length, 1);
  assert.match(tournaments, /captureLiveBaselines/);
  assert.match(tournaments, /advanceTournamentFromBattle/);
  assert.doesNotMatch(tournaments, /calculateBattlePoints\s*\(/);
  assert.match(tournamentCert, /later tournament rounds remain winner-advances/);
  assert.match(tournamentCert, /Tournament Details consumes normalized profiles and canonical Battle metrics/);
});

test("Phase 12 explicitly keeps final-leader settlement parity blocked while Settlement V1 is staged", () => {
  const metrics = readApi("arenaBattleMetrics.js");
  const battles = readApi("arenaBattles.js");
  const hud = readFrontend("src/components/arena/BattleScoreHud.tsx");
  const settle = battles.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";

  assert.match(metrics, /settlementMode:\s*["']v1_mcap_pct_change["']/);
  assert.match(hud, /Settlement V1/);
  assert.match(hud, /Existing V1 settlement remains authoritative/);
  assert.match(settle, /decideBattleSettlement/);
  assert.doesNotMatch(settle, /calculateBattlePoints/);
});

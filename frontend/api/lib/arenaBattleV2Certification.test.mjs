import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  arenaBattleChannelName,
  buildPublicBattleMetricsSnapshot,
} from "./arenaBattleRealtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");

function read(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(frontendRoot, rel), "utf8");
}

function withBattlePointsFlag(value, fn) {
  const previous = process.env.ARENA_BATTLE_POINTS_V2;
  if (value == null) delete process.env.ARENA_BATTLE_POINTS_V2;
  else process.env.ARENA_BATTLE_POINTS_V2 = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.ARENA_BATTLE_POINTS_V2;
    else process.env.ARENA_BATTLE_POINTS_V2 = previous;
  }
}

test("DB-controlled live transition captures both baselines inside updateBattle transaction", () => {
  const battles = read("arenaBattles.js");
  const update = battles.split("async function updateBattle")[1]?.split("async function waitingCandidates")[0] || "";
  const begin = battles.split("async function beginFight")[1]?.split("async function goLiveFromMatched")[0] || "";
  const goLive = battles.split("async function goLiveFromMatched")[1]?.split("export async function promoteMatchedIfFunded")[0] || "";
  const transition = battles.split("async function handleTransition")[1]?.split("export default async function handler")[0] || "";

  assert.match(update, /patch\.state === ["']live["']/);
  assert.match(update, /pool\.connect\(\)/);
  assert.match(update, /for update/i);
  assert.match(update, /captureLiveBaselines\(updated, \{ query:/);
  assert.match(update, /await client\.query\(["']commit["']\)/);
  assert.match(update, /await client\.query\(["']rollback["']\)/);
  assert.doesNotMatch(begin, /captureLiveBaselines/);
  assert.doesNotMatch(goLive, /captureLiveBaselines/);
  assert.doesNotMatch(transition, /captureLiveBaselines/);
});

test("baseline helper uses battle started_at and writes both combatants in one INSERT", () => {
  const metrics = read("lib/arenaBattleMetrics.js");
  assert.match(metrics, /row\.started_at \|\| row\.startedAt/);
  assert.match(metrics, /prepared\.flatMap/);
  assert.match(metrics, /values \(\$\{first\}\),\(\$\{second\}\)/);
  assert.doesNotMatch(metrics, /baselineTimestamp = nowIso/);
});

test("Match Quality active routes hydrate through normalized market snapshot", () => {
  const battles = read("arenaBattles.js");
  const matches = battles.split("async function handleMatches")[1]?.split("async function handleOpen")[0] || "";
  const open = battles.split("async function handleOpen")[1]?.split("async function handleChallenge")[0] || "";
  const challenge = battles.split("async function handleChallenge")[1]?.split("function offerFromToken")[0] || "";
  const autoMatch = battles.split("async function tryAutoMatch")[1]?.split("async function currentMcap")[0] || "";

  assert.match(battles, /getArenaMarketSnapshot/);
  assert.match(matches, /hydrateMatchCoin/);
  assert.match(open, /hydrateMatchCoin/);
  assert.match(challenge, /hydrateMatchCoin/);
  assert.match(autoMatch, /hydrateMatchCoin/);
  assert.doesNotMatch(battles, /votes_24h/);
});

test("tournament seeding uses normalized snapshot and live insert shares a transaction with baselines", () => {
  const tournaments = read("arenaTournaments.js");
  const snapshot = tournaments.split("async function coinSnapshot")[1]?.split("async function handleList")[0] || "";
  const insert = tournaments.split("async function insertTournamentBattle")[1]?.split("async function handleAdminStart")[0] || "";

  assert.match(tournaments, /getArenaMarketSnapshot/);
  assert.doesNotMatch(tournaments, /votes_24h/);
  assert.doesNotMatch(snapshot, /market_cap_bnb/);
  assert.match(insert, /ownsTransaction/);
  assert.match(insert, /client\.query\(["']begin["']\)/);
  assert.match(insert, /startedAt/);
  assert.match(insert, /captureLiveBaselines/);
  assert.match(insert, /snapshots:\s*\{\s*left:\s*leftSnap,\s*right:\s*rightSnap\s*\}/);
  assert.match(insert, /client\.query\(["']commit["']\)/);
  assert.match(insert, /client\.query\(["']rollback["']\)/);
});

test("imported candidates do not fabricate zero native market metrics", () => {
  const battles = read("arenaBattles.js");
  assert.doesNotMatch(battles, /market_cap_bnb:\s*0/);
  assert.doesNotMatch(battles, /liquidity_bnb:\s*0/);
  assert.doesNotMatch(battles, /volume_24h_bnb:\s*0/);
  assert.match(battles, /marketDataHealthy:\s*false/);
});

test("legacy settleLive remains the V1 fallback and does not duplicate Battle Points math", () => {
  const battles = read("arenaBattles.js");
  const settle = battles.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /decideBattleSettlement/);
  assert.match(settle, /canSettleBattle/);
  assert.match(settle, /recordFinishedBattle/);
  assert.doesNotMatch(settle, /calculateBattlePoints/);
  assert.doesNotMatch(battles, /from "\.\/lib\/arenaBattlePoints\.js"/);
});

test("canonical calculator source has no chain branches", () => {
  const source = read("lib/arenaBattlePoints.js");
  assert.doesNotMatch(source, /bnb/i);
  assert.doesNotMatch(source, /solana/i);
  assert.doesNotMatch(source, /robinhood/i);
  assert.match(source, /export function calculateBattlePoints/);
});

test("snapshot and match adapters never map votes_24h to holders", () => {
  const snapshot = read("lib/arenaMarketSnapshot.js");
  const match = read("lib/arenaMatchQuality.js");
  assert.doesNotMatch(snapshot, /votes_24h/);
  assert.doesNotMatch(match, /votes_24h/);
  assert.match(snapshot, /token_holder_balances/);
});

test("public Battle metrics snapshot is sanitized and settlement mode follows the rollout without relabeling history", () => {
  const battle = {
    id: "arena-test-1",
    chain_id: 56,
    state: "live",
  };
  const metric = (side, points, healthy = true) => ({
    battle_id: battle.id,
    token_id: side === "left" ? "0x1111111111111111111111111111111111111111" : "0x2222222222222222222222222222222222222222",
    side,
    scoring_version: "battle_points_v2",
    start_mcap_usd: 100000,
    start_holders: 1000,
    start_liquidity_usd: 25000,
    baseline_timestamp: "2026-09-02T20:00:00.000Z",
    baseline_market_data_updated_at: "2026-09-02T20:00:00.000Z",
    baseline_healthy: true,
    baseline_data_source: "normalized_market_stats",
    current_mcap_usd: 120000,
    current_holders: 1100,
    current_liquidity_usd: 28000,
    market_data_updated_at: "2026-09-02T20:01:00.000Z",
    data_lag_seconds: 3,
    data_healthy: healthy,
    data_source: "normalized_market_stats",
    eligible_battle_volume_usd: 5000,
    mcap_points: points / 2,
    holder_points: points / 3,
    volume_points: points / 6,
    battle_points: points,
    metrics_updated_at: "2026-09-02T20:01:05.000Z",
    wallet: "0xshould-never-leak",
    cluster_id: "internal-cluster",
  });

  withBattlePointsFlag("0", () => {
    const snapshot = buildPublicBattleMetricsSnapshot(battle, [metric("left", 60), metric("right", 45)]);
    assert.equal(snapshot.settlementMode, "v1_mcap_pct_change");
  });
  withBattlePointsFlag("1", () => {
    const snapshot = buildPublicBattleMetricsSnapshot(battle, [metric("left", 60), metric("right", 45)]);
    assert.equal(snapshot.leaderSide, "left");
    assert.equal(snapshot.pointDifference, 15);
    assert.equal(snapshot.settlementMode, "battle_points_v2");
    assert.equal(snapshot.scoringVersion, "battle_points_v2");
    assert.equal(snapshot.dataHealth.healthy, true);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /should-never-leak/);
    assert.doesNotMatch(serialized, /internal-cluster/);
    assert.doesNotMatch(serialized, /cluster_id|wallet/i);
  });
  withBattlePointsFlag("1", () => {
    const historical = buildPublicBattleMetricsSnapshot(
      { ...battle, state: "finished", settlement_version: 1 },
      [metric("left", 60), metric("right", 45)],
    );
    assert.equal(historical.settlementMode, "v1_mcap_pct_change");
  });
  assert.equal(arenaBattleChannelName(battle.id), `arena:battle:${battle.id}`);
});

test("Phase 6 marks public Battle telemetry DATA DELAY when a side is unhealthy", () => {
  const snapshot = buildPublicBattleMetricsSnapshot(
    { id: "arena-delay", chain_id: 46630, state: "live" },
    [
      {
        side: "left", token_id: "left", scoring_version: "battle_points_v2",
        current_mcap_usd: 1, current_holders: 1, current_liquidity_usd: 1,
        data_healthy: false, battle_points: 10,
      },
      {
        side: "right", token_id: "right", scoring_version: "battle_points_v2",
        current_mcap_usd: 1, current_holders: 1, current_liquidity_usd: 1,
        data_healthy: true, battle_points: 10,
      },
    ],
  );
  assert.equal(snapshot.dataHealth.healthy, false);
  assert.equal(snapshot.dataHealth.status, "data_delay");
  assert.ok(snapshot.dataHealth.reasons.includes("left_market_data_unhealthy"));
});

test("Phase 6 worker serializes refreshes but never row-locks or mutates arena_battles", () => {
  const source = read("lib/arenaBattleRealtime.js");
  assert.match(source, /pg_try_advisory_xact_lock/);
  assert.doesNotMatch(source, /for update/i);
  assert.doesNotMatch(source, /update public\.arena_battles/i);
  assert.match(source, /settlementMode:\s*arenaSettlementMode\(battleRow\)/);
  assert.match(source, /ARENA_BATTLE_REALTIME_ENABLED/);
});

test("Battle Ably auth is subscribe-only and frontend reconciles REST before realtime", () => {
  const auth = read("ably/token.js");
  const battleScope = auth.split('scope === "battle"')[1]?.split("} else {")[0] || "";
  assert.match(battleScope, /arena:battle:/);
  assert.match(battleScope, /capability\[`arena:battle:\$\{battleId\}`\]\s*=\s*\["subscribe"\]/);
  assert.doesNotMatch(battleScope, /capability\[`arena:battle:[^\n]+\]\s*=\s*\[[^\]]*(?:"publish"|"presence")/);

  const hook = readFrontend("src/hooks/useArenaBattleRealtimeDetails.ts");
  assert.match(hook, /snapshotReady/);
  assert.match(hook, /fetchPostGradBattleDetails/);
  assert.match(hook, /fetchArenaBattleMetrics/);
  assert.match(hook, /enabled:\s*Boolean\(battleId && snapshotReady\)/);
  assert.match(hook, /client\.connection\.on\(["']connected["']/);
  assert.match(hook, /reconnect reconciliation/);
  assert.match(hook, /incomingMetricTs < currentMetricTs/);
  assert.match(hook, /arena_battle_finished|shouldRefetch/);
});

test("Railway Battle worker is isolated from API liveness for realtime and V2 settlement", () => {
  const start = readFrontend("scripts/run-railway-api-start.mjs");
  assert.match(start, /ARENA_BATTLE_REALTIME_ENABLED/);
  assert.match(start, /ARENA_BATTLE_POINTS_V2/);
  assert.match(start, /run-arena-battle-realtime-worker\.mjs/);
  assert.match(start, /API remains live/);
});

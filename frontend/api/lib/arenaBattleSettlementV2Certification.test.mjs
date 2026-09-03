import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");
const repoRoot = path.join(frontendRoot, "..");

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(frontendRoot, rel), "utf8");
}

test("V2 settlement locks the due battle before final reconciliation and rolls back unsafe scores", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const lockAt = service.indexOf("for update");
  const reconcileAt = service.indexOf("finalScore = await reconcileBattlePointsAtClose(current");
  const decisionAt = service.indexOf("decision = decideBattlePointsSettlement({");
  const leagueAt = service.indexOf("await recordFinishedBattle({");
  const battleWriteAt = service.indexOf("update public.arena_battles set");

  assert.ok(lockAt >= 0 && reconcileAt > lockAt, "final score must be reconciled after the battle row lock");
  assert.ok(decisionAt > reconcileAt, "winner decision must consume final reconciled score");
  assert.ok(leagueAt > decisionAt, "MWL write must consume the V2 decision");
  assert.ok(battleWriteAt > leagueAt, "battle finish write must remain after the MWL write in the same transaction");
  assert.match(service, /if \(!finalScore\.ok\)[\s\S]{0,300}client\.query\(["']rollback["']\)/);
  assert.match(service, /if \(!decision\.ok\)[\s\S]{0,220}client\.query\(["']rollback["']\)/);
  assert.equal((service.match(/await recordFinishedBattle\s*\(/g) || []).length, 1);
});

test("V2 settlement reuses canonical competition policy and never duplicates scoring math", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  assert.match(service, /import \{ battleLeagueEligibility \} from "\.\/arenaBattleCompetition\.js"/);
  assert.match(service, /if \(league\.eligible\)/);
  assert.doesNotMatch(service, /calculateMatchQuality/);
  assert.doesNotMatch(service, /calculateBattlePoints\s*\(/);
  assert.doesNotMatch(service, /arenaMatchProfileFromParticipant/);
});

test("V2 final reconciliation is bounded to battle close and uses the canonical Battle Points persistence path", () => {
  const finalScore = readApi("lib/arenaBattleFinalScore.js");
  assert.match(finalScore, /finishAt:\s*closeAt/);
  assert.match(finalScore, /loadBattleWindowTrades/);
  assert.match(finalScore, /loadVolumeContext/);
  assert.match(finalScore, /refreshCombatantVolumeAndPoints/);
  assert.match(finalScore, /selectPreCloseMarketSnapshot/);
  assert.match(finalScore, /PRE_CLOSE_MARKET_DATA_MISSING/);
  assert.match(finalScore, /FINAL_SCORE_UNHEALTHY/);
  assert.doesNotMatch(finalScore, /calculateBattlePoints\s*\(/);
});

test("V2 settlement evidence is persisted while the legacy integer generation remains compatible", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const settle = readApi("lib/arenaBattleSettle.js");
  const migration = fs.readFileSync(
    path.join(repoRoot, "db/migrations/20260903_000002_arena_battle_points_v2_settlement.sql"),
    "utf8",
  );

  for (const field of [
    "settlement_scoring_version",
    "challenger_battle_points",
    "defender_battle_points",
    "challenger_mcap_points",
    "defender_mcap_points",
    "challenger_holder_points",
    "defender_holder_points",
    "challenger_volume_points",
    "defender_volume_points",
    "settlement_metrics_updated_at",
    "settlement_tie_break_used",
  ]) {
    assert.match(service, new RegExp(field));
    assert.match(migration, new RegExp(field));
  }
  assert.match(settle, /settlement_version:\s*decision\.settlementVersion/);
  assert.match(migration, /Historical settlement_version=1 rows remain untouched/);
  assert.match(migration, /'battle_points'/);
  assert.match(migration, /'mcap_component'/);
  assert.match(migration, /'holder_component'/);
  assert.match(migration, /'volume_component'/);
});

test("legacy V1 settlement is disabled only when the existing Battle Points V2 flag is enabled", () => {
  const settle = readApi("lib/arenaBattleSettle.js");
  const config = readApi("lib/arenaBattlePointsConfig.js");
  const battles = readApi("arenaBattles.js");

  assert.match(settle, /battlePointsV2PersistenceEnabled\(\)/);
  assert.match(settle, /if \(battlePointsV2PersistenceEnabled\(\)\) return false/);
  assert.match(config, /process\.env\.ARENA_BATTLE_POINTS_V2/);
  assert.match(battles, /decideBattleSettlement/);
  assert.match(battles, /canSettleBattle/);
  assert.doesNotMatch(battles, /settleBattlePointsV2ById/);
});

test("V2 worker scans due live battles, keeps API liveness isolated, and publishes only after settlement", () => {
  const worker = readFrontend("scripts/run-arena-battle-realtime-worker.mjs");
  const start = readFrontend("scripts/run-railway-api-start.mjs");

  assert.match(worker, /settleBattlePointsV2ById/);
  assert.match(worker, /state = 'live'/);
  assert.match(worker, /ends_at <= now\(\)/);
  assert.match(worker, /ARENA_BATTLE_SETTLEMENT_SCAN_MS/);
  const settleAt = worker.indexOf("settleBattlePointsV2ById(row.id)");
  const publishAt = worker.indexOf("publishBattleFinished(settled.battle");
  assert.ok(settleAt >= 0 && publishAt > settleAt, "finished event must follow committed V2 settlement service result");

  assert.match(start, /process\.env\.ARENA_BATTLE_POINTS_V2/);
  assert.match(start, /run-arena-battle-realtime-worker\.mjs/);
  assert.match(start, /API remains live/);
});

test("tournament advancement remains post-commit and WarPool accounting is untouched", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const commitAt = service.lastIndexOf('await client.query("commit")');
  const advanceAt = service.indexOf("await advanceTournamentFromBattle({");
  assert.ok(commitAt >= 0 && advanceAt > commitAt, "tournament advancement must remain after settlement commit");
  assert.doesNotMatch(service, /WarPool|arena_war_pool|pool_deposit|claim/i);
});

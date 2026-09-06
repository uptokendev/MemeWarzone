import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");
const repoRoot = path.join(frontendRoot, "..");

function readApi(rel) { return fs.readFileSync(path.join(apiRoot, rel), "utf8"); }
function readFrontend(rel) { return fs.readFileSync(path.join(frontendRoot, rel), "utf8"); }

test("historical V2 settlement still locks the battle before final reconciliation and rolls back unsafe scores", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const lockAt = service.indexOf("for update");
  const reconcileAt = service.indexOf("finalScore = await reconcileBattlePointsAtClose(current");
  const decisionAt = service.indexOf("decision = decideBattlePointsSettlement({");
  const leagueAt = service.indexOf("await recordFinishedBattle({");
  const battleWriteAt = service.indexOf("update public.arena_battles set");
  assert.ok(lockAt >= 0 && reconcileAt > lockAt);
  assert.ok(decisionAt > reconcileAt);
  assert.ok(leagueAt > decisionAt);
  assert.ok(battleWriteAt > leagueAt);
  assert.match(service, /if \(!finalScore\.ok\)[\s\S]*?rollback/);
  assert.match(service, /if \(!decision\.ok\)[\s\S]*?rollback/);
  assert.equal((service.match(/await recordFinishedBattle\s*\(/g) || []).length, 1);
});

test("historical V2 service is selected only from an immutable battle_points_v2 metrics lock", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const runtime = readApi("lib/arenaBattleSettlementRuntime.js");
  assert.match(service, /bool_and\(coalesce\(m\.scoring_generation, m\.scoring_version\) = 'battle_points_v2'\)/);
  assert.match(service, /having count\(\*\) = 2/i);
  assert.match(runtime, /BATTLE_POINTS_V2/);
  assert.match(runtime, /settleBattlePointsV2ById\(row\.id, \{ \.\.\.deps, force: true \}\)/);
  assert.match(runtime, /battle_metric_generation_mismatch/);
});

test("V2 reconciliation stays 50/30/20 with no Boost path and no duplicate calculator", () => {
  const finalScore = readApi("lib/arenaBattleFinalScore.js");
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const config = readApi("lib/arenaBattlePointsConfig.js");
  assert.match(config, /mcap:\s*50/);
  assert.match(config, /holders:\s*30/);
  assert.match(config, /volume:\s*20/);
  assert.match(finalScore, /finishAt:\s*closeAt/);
  assert.match(finalScore, /loadBattleWindowTrades/);
  assert.match(finalScore, /loadVolumeContext/);
  assert.match(finalScore, /refreshCombatantVolumeAndPoints/);
  assert.match(finalScore, /selectPreCloseMarketSnapshot/);
  assert.doesNotMatch(service, /calculateBattlePoints\s*\(|calculateBattlePointsV3Boost|confirmedBoostUnits/);
});

test("V2 settlement evidence persists without rewriting historical rows", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const migration = fs.readFileSync(path.join(repoRoot, "db/migrations/20260903_000002_arena_battle_points_v2_settlement.sql"), "utf8");
  const activation = fs.readFileSync(path.join(repoRoot, "db/migrations/20260906_000006_arena_battle_v3_runtime_activation.sql"), "utf8");
  for (const field of [
    "settlement_scoring_version", "challenger_battle_points", "defender_battle_points",
    "challenger_mcap_points", "defender_mcap_points", "challenger_holder_points",
    "defender_holder_points", "challenger_volume_points", "defender_volume_points",
    "settlement_metrics_updated_at", "settlement_tie_break_used",
  ]) {
    assert.match(service, new RegExp(field));
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /Historical settlement_version=1 rows remain untouched/);
  assert.doesNotMatch(activation, /update\s+public\.arena_battle_metrics/i);
});

test("global flags cannot reinterpret an already locked V2 Battle", () => {
  const runtime = readApi("lib/arenaBattleSettlementRuntime.js");
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  assert.match(runtime, /scoring_generation/);
  assert.match(runtime, /version:\s*2/);
  assert.match(runtime, /force:\s*true/);
  assert.doesNotMatch(runtime, /ARENA_BATTLE_POINTS_V2|process\.env/);
  assert.match(service, /if \(!deps\.force && !battlePointsV2SettlementEnabled\(\)\)/);
});

test("existing V2 worker and post-commit tournament advancement remain intact", () => {
  const service = readApi("lib/arenaBattleSettlementV2Service.js");
  const worker = readFrontend("scripts/run-arena-battle-realtime-worker.mjs");
  const start = readFrontend("scripts/run-railway-api-start.mjs");
  assert.match(worker, /settleBattlePointsV2ById/);
  assert.match(worker, /state = 'live'/);
  assert.match(worker, /ends_at <= now\(\)/);
  assert.match(worker, /ARENA_BATTLE_SETTLEMENT_SCAN_MS/);
  assert.match(start, /run-arena-battle-realtime-worker\.mjs/);
  const commitAt = service.lastIndexOf('await client.query("commit")');
  const advanceAt = service.indexOf("await advanceTournamentFromBattle({");
  assert.ok(commitAt >= 0 && advanceAt > commitAt);
  assert.doesNotMatch(service, /WarPool|arena_war_pool|pool_deposit|claim/i);
});

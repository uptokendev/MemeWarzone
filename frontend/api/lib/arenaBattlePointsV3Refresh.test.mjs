import assert from "node:assert/strict";
import test from "node:test";

import { refreshCombatantVolumeAndPoints } from "./arenaBattleMetrics.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function fixture() {
  return {
    row: {
      id: "battle-v3-refresh",
      state: "live",
      started_at: "2026-09-03T11:00:00.000Z",
      ends_at: "2026-09-03T13:00:00.000Z",
    },
    metricsRow: {
      battle_id: "battle-v3-refresh",
      token_id: "0xabc",
      side: "left",
      start_mcap_usd: 10_000,
      start_holders: 1_000,
      start_liquidity_usd: 4_000,
      baseline_timestamp: "2026-09-03T11:00:00.000Z",
      baseline_market_data_updated_at: "2026-09-03T11:00:00.000Z",
      data_source: "fixture",
    },
    snapshot: {
      marketCapUsd: 12_000,
      holders: 1_200,
      liquidityUsd: 4_500,
      updatedAt: "2026-09-03T11:59:00.000Z",
      healthy: true,
      dataLagSeconds: 60,
      dataSource: "fixture",
    },
    trades: [],
    volumeContext: {},
    now: NOW,
  };
}

function querySpy() {
  const calls = [];
  const query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes("insert into public.arena_battle_points_v3")) {
      return {
        rows: [{
          battle_id: "battle-v3-refresh",
          side: "left",
          total_points: null,
          boost_curve_version: "boost_hyperbolic_100_v1",
          boost_curve_parameters: { maxPoints: 10, halfSaturationUnits: 100, unitUsdMicros: 1_000_000 },
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  };
  return { calls, query };
}

test("V3 refresh projection is completely absent while feature flag is off", async () => {
  const spy = querySpy();
  const result = await refreshCombatantVolumeAndPoints(fixture(), {
    query: spy.query,
    env: {},
  });

  assert.equal(result.scored.scoringVersion, "battle_points_v2");
  assert.ok(spy.calls.some((call) => call.sql.includes("update public.arena_battle_metrics")));
  assert.equal(spy.calls.some((call) => call.sql.includes("arena_battle_points_v3")), false);
});

test("V3 refresh projection writes after V2 and cannot replace V2 scoring", async () => {
  const spy = querySpy();
  const result = await refreshCombatantVolumeAndPoints(fixture(), {
    query: spy.query,
    env: { ARENA_BATTLE_POINTS_V3: "true" },
  });

  const v2Index = spy.calls.findIndex((call) => call.sql.includes("update public.arena_battle_metrics"));
  const v3Index = spy.calls.findIndex((call) => call.sql.includes("insert into public.arena_battle_points_v3"));

  assert.ok(v2Index >= 0);
  assert.ok(v3Index > v2Index);
  assert.equal(result.scored.scoringVersion, "battle_points_v2");
  const v3Sql = spy.calls[v3Index].sql;
  assert.match(v3Sql, /mcap_points = excluded\.mcap_points/);
  assert.doesNotMatch(v3Sql, /boost_points\s*=\s*excluded/i);
  assert.doesNotMatch(v3Sql, /total_points\s*=\s*excluded/i);
});

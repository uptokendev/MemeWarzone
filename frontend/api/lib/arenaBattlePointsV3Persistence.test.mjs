import assert from "node:assert/strict";
import test from "node:test";

import { calculateBattlePointsV3Market } from "./arenaBattlePointsV3.js";
import { persistBattlePointsV3MarketProjection } from "./arenaBattlePointsV3Persistence.js";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const CURVE = "boost_hyperbolic_100_v1";
const PARAMS = { maxPoints: 10, halfSaturationUnits: 100, unitUsdMicros: 1_000_000 };

function score() {
  return calculateBattlePointsV3Market({
    baseline: { startMcapUsd: 10_000, startHolders: 1_000 },
    current: { marketCapUsd: 12_000, holders: 1_200, updatedAt: "2026-09-03T11:59:00.000Z", healthy: true },
    eligibleVolume: {
      usd: 10_000,
      rawUsd: 10_000,
      cappedUsd: 10_000,
      clusters: [
        { clusterId: "a", countedUsd: 5_000 },
        { clusterId: "b", countedUsd: 5_000 },
      ],
    },
    now: NOW,
  });
}

test("V3 projection upsert writes founder weights and immutable curve identity", async () => {
  let captured = null;
  const fakeRow = { battle_id: "battle-1", side: "left", boost_units: "77", total_points: null, boost_curve_version: CURVE, boost_curve_parameters: PARAMS };
  const query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [fakeRow] };
  };

  const result = await persistBattlePointsV3MarketProjection(
    { battleId: "battle-1", tokenId: "0xabc", side: "left", score: score() },
    { query },
  );

  assert.equal(result, fakeRow);
  assert.ok(captured.sql.includes("mcap_points = excluded.mcap_points"));
  assert.ok(captured.sql.includes("holder_points = excluded.holder_points"));
  assert.ok(captured.sql.includes("volume_points = excluded.volume_points"));
  assert.ok(!/boost_units\s*=\s*excluded/i.test(captured.sql));
  assert.ok(!/boost_points\s*=\s*excluded/i.test(captured.sql));
  assert.ok(!/total_points\s*=\s*excluded/i.test(captured.sql));
  assert.ok(!/boost_curve_version\s*=\s*excluded/i.test(captured.sql));
  assert.ok(!/boost_curve_parameters\s*=\s*excluded/i.test(captured.sql));
  assert.deepEqual(captured.params.slice(3, 9), [50, 25, 15, 10, CURVE, JSON.stringify(PARAMS)]);
});

test("V3 projection rejects an incompatible pre-existing curve", async () => {
  await assert.rejects(
    persistBattlePointsV3MarketProjection(
      { battleId: "battle-1", tokenId: "0xabc", side: "left", score: score() },
      { query: async () => ({ rows: [{ boost_curve_version: "old_curve", boost_curve_parameters: {} }] }) },
    ),
    /incompatible immutable Boost curve/,
  );
});

test("V3 projection rejects non-V3 scores and malformed identity", async () => {
  await assert.rejects(
    persistBattlePointsV3MarketProjection(
      { battleId: "battle-1", tokenId: "0xabc", side: "left", score: { scoringVersion: "battle_points_v2" } },
      { query: async () => ({ rows: [] }) },
    ),
    /V3 market score is required/,
  );
  await assert.rejects(
    persistBattlePointsV3MarketProjection(
      { battleId: "battle-1", tokenId: "0xabc", side: "middle", score: score() },
      { query: async () => ({ rows: [] }) },
    ),
    /identity is invalid/,
  );
});

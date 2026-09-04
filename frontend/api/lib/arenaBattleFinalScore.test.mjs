import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FINAL_SCORE_REASON,
  selectPreCloseMarketSnapshot,
} from "./arenaBattleFinalScore.js";
import { BATTLE_POINTS_CONFIG } from "./arenaBattlePointsConfig.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function identitySnapshot(overrides = {}) {
  return {
    tokenAddress: "0x1111111111111111111111111111111111111111",
    campaignAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    marketCapUsd: 120_000,
    holders: 1_200,
    liquidityUsd: 30_000,
    updatedAt: "2026-09-03T10:00:00.000Z",
    dataSource: "normalized_market_stats",
    healthy: true,
    reasons: [],
    ...overrides,
  };
}

function metricsRow(overrides = {}) {
  return {
    current_mcap_usd: 115_000,
    current_holders: 1_150,
    current_liquidity_usd: 28_000,
    market_data_updated_at: "2026-09-03T09:59:45.000Z",
    data_source: "normalized_market_stats",
    data_healthy: true,
    ...overrides,
  };
}

test("final settlement accepts a healthy shared-market state sampled at or before battle close", () => {
  const snapshot = selectPreCloseMarketSnapshot(
    identitySnapshot({ updatedAt: "2026-09-03T09:59:55.000Z" }),
    metricsRow(),
    "2026-09-03T10:00:00.000Z",
  );
  assert.ok(snapshot);
  assert.equal(snapshot.marketCapUsd, 120_000);
  assert.equal(snapshot.holders, 1_200);
  assert.equal(snapshot.dataLagSeconds, 5);
});

test("post-close latest state is rejected in favor of the last fresh persisted pre-close metric", () => {
  const snapshot = selectPreCloseMarketSnapshot(
    identitySnapshot({
      marketCapUsd: 999_999,
      holders: 9_999,
      updatedAt: "2026-09-03T10:00:10.000Z",
    }),
    metricsRow({
      current_mcap_usd: 115_000,
      current_holders: 1_150,
      market_data_updated_at: "2026-09-03T09:59:45.000Z",
    }),
    "2026-09-03T10:00:00.000Z",
  );
  assert.ok(snapshot);
  assert.equal(snapshot.marketCapUsd, 115_000);
  assert.equal(snapshot.holders, 1_150);
  assert.equal(snapshot.updatedAt, "2026-09-03T09:59:45.000Z");
});

test("stale persisted state fails closed when the latest snapshot is post-close", () => {
  const tooOldMs = Date.parse("2026-09-03T10:00:00.000Z") - (BATTLE_POINTS_CONFIG.staleSeconds + 1) * 1000;
  const snapshot = selectPreCloseMarketSnapshot(
    identitySnapshot({ updatedAt: "2026-09-03T10:00:10.000Z" }),
    metricsRow({ market_data_updated_at: new Date(tooOldMs).toISOString() }),
    "2026-09-03T10:00:00.000Z",
  );
  assert.equal(snapshot, null);
});

test("unhealthy persisted state is never promoted into a final settlement snapshot", () => {
  const snapshot = selectPreCloseMarketSnapshot(
    identitySnapshot({ updatedAt: "2026-09-03T10:00:10.000Z" }),
    metricsRow({ data_healthy: false }),
    "2026-09-03T10:00:00.000Z",
  );
  assert.equal(snapshot, null);
});

test("final reconciler uses canonical market, volume and Battle Points persistence helpers", () => {
  const source = fs.readFileSync(path.join(here, "arenaBattleFinalScore.js"), "utf8");
  assert.match(source, /getArenaMarketSnapshot/);
  assert.match(source, /loadBattleWindowTrades/);
  assert.match(source, /loadVolumeContext/);
  assert.match(source, /refreshCombatantVolumeAndPoints/);
  assert.match(source, /finishAt:\s*closeAt/);
  assert.match(source, /FINAL_SCORE_UNHEALTHY/);
  assert.doesNotMatch(source, /calculateBattlePoints\s*\(/);
  assert.equal(FINAL_SCORE_REASON.PRE_CLOSE_MARKET_DATA_MISSING, "pre_close_market_data_missing");
});

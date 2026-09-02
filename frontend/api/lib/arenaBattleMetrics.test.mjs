import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureLiveBaselines, BASELINE_INSERT_SQL } from "./arenaBattleMetrics.js";
import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";
import { BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const TOKEN_L = "0x1111111111111111111111111111111111111111";
const TOKEN_R = "0x2222222222222222222222222222222222222222";

function createMetricsMemory() {
  const metrics = [];
  async function query(sql, params) {
    const text = String(sql);
    if (/INSERT INTO public.arena_battle_metrics/i.test(text) || /insert into public.arena_battle_metrics/i.test(text)) {
      const exists = metrics.some((row) => row.battle_id === params[0] && row.side === params[2]);
      if (exists) return { rowCount: 0, rows: [] };
      const row = {
        battle_id: params[0],
        token_id: params[1],
        side: params[2],
        scoring_version: params[3],
        start_mcap_usd: params[4],
        start_holders: params[5],
        start_liquidity_usd: params[6],
        baseline_timestamp: params[7],
        baseline_market_data_updated_at: params[8],
        baseline_data_source: params[9],
        baseline_healthy: params[10],
        current_mcap_usd: params[11],
        current_holders: params[12],
        current_liquidity_usd: params[13],
        market_data_updated_at: params[14],
        data_lag_seconds: params[15],
        data_source: params[16],
        data_healthy: params[17],
      };
      metrics.push(row);
      return { rowCount: 1, rows: [row] };
    }
    if (/from public.arena_battle_metrics/i.test(text)) {
      return { rows: metrics.filter((row) => row.battle_id === params[0]) };
    }
    return { rows: [], rowCount: 0 };
  }
  return { metrics, query };
}

function liveRow() {
  return {
    id: "arena-test-1",
    chain_id: 56,
    state: "live",
    challenger_token: TOKEN_L,
    defender_token: TOKEN_R,
    started_at: "2026-09-02T12:00:00.000Z",
  };
}

function snap(partial) {
  return {
    marketCapUsd: 10_000,
    holders: 200,
    liquidityUsd: 3_000,
    updatedAt: "2026-09-02T12:00:00.000Z",
    dataSource: "market_stats",
    healthy: true,
    dataLagSeconds: 5,
    ...partial,
  };
}

test("live capture writes both sides with mcap/holders/liquidity/timestamp/scoring_version", async () => {
  const db = createMetricsMemory();
  const result = await captureLiveBaselines(liveRow(), {
    query: db.query,
    now: new Date("2026-09-02T12:00:00.000Z"),
    snapshots: { left: snap(), right: snap({ marketCapUsd: 8_000, holders: 150 }) },
  });
  assert.equal(result.captured, true);
  assert.equal(db.metrics.length, 2);
  const left = db.metrics.find((row) => row.side === "left");
  assert.equal(left.token_id, TOKEN_L);
  assert.equal(left.start_mcap_usd, 10_000);
  assert.equal(left.start_holders, 200);
  assert.equal(left.start_liquidity_usd, 3_000);
  assert.equal(left.baseline_timestamp, "2026-09-02T12:00:00.000Z");
  assert.equal(left.scoring_version, BATTLE_POINTS_V2);
});

test("second live capture does not replace start_* or baseline_timestamp", async () => {
  const db = createMetricsMemory();
  const row = liveRow();
  await captureLiveBaselines(row, {
    query: db.query,
    now: new Date("2026-09-02T12:00:00.000Z"),
    snapshots: { left: snap(), right: snap({ marketCapUsd: 8_000 }) },
  });
  await captureLiveBaselines(row, {
    query: db.query,
    now: new Date("2026-09-02T13:00:00.000Z"),
    snapshots: {
      left: snap({ marketCapUsd: 99_000, holders: 9_999, liquidityUsd: 1 }),
      right: snap({ marketCapUsd: 1 }),
    },
  });
  assert.equal(db.metrics.length, 2);
  const left = db.metrics.find((row) => row.side === "left");
  assert.equal(left.start_mcap_usd, 10_000);
  assert.equal(left.start_holders, 200);
  assert.equal(left.baseline_timestamp, "2026-09-02T12:00:00.000Z");
});

test("unhealthy snapshot still inserts a baseline row", async () => {
  const db = createMetricsMemory();
  await captureLiveBaselines(liveRow(), {
    query: db.query,
    now: new Date("2026-09-02T12:00:00.000Z"),
    snapshots: {
      left: snap({ marketCapUsd: null, healthy: false, dataSource: "none" }),
      right: snap({ healthy: false, reason: "stale" }),
    },
  });
  assert.equal(db.metrics.length, 2);
  assert.equal(db.metrics[0].baseline_healthy, false);
  assert.equal(db.metrics[1].baseline_healthy, false);
});

test("non-live rows are not captured", async () => {
  const db = createMetricsMemory();
  const result = await captureLiveBaselines({ ...liveRow(), state: "matched" }, {
    query: db.query,
    snapshots: { left: snap(), right: snap() },
  });
  assert.equal(result.captured, false);
  assert.equal(db.metrics.length, 0);
});

test("migration is additive and idempotent", () => {
  const sql = fs.readFileSync(path.join(root, "db/migrations/20260902_000003_arena_battle_metrics.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public.arena_battle_metrics/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public.arena_battle_volume_audit/);
  assert.match(sql, /PRIMARY KEY \(battle_id, side\)/);
  assert.doesNotMatch(sql, /DROP TABLE public.arena_battles/);
  assert.doesNotMatch(sql, /ALTER TABLE public.arena_battles DROP/);
  assert.match(BASELINE_INSERT_SQL, /ON CONFLICT \(battle_id, side\) DO NOTHING/);
});

test("getArenaMarketSnapshot converts native units with FX and never uses votes as holders", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    const text = String(sql);
    if (text.includes("from public.campaigns")) {
      return {
        rows: [{
          chain_id: 56,
          campaign_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token_address: TOKEN_L,
          creator_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          fee_recipient_address: null,
        }],
      };
    }
    if (text.includes("from public.market_stats") && !text.includes("join public.campaigns")) {
      return {
        rows: [{
          market_cap_bnb: 10,
          liquidity_bnb: 2,
          holders: 42,
          volume_24h_bnb: 1,
          updated_at: "2026-09-02T12:00:00.000Z",
          data_lag_seconds: 8,
        }],
      };
    }
    return { rows: [] };
  };
  const snap = await getArenaMarketSnapshot(56, TOKEN_L, {
    query,
    resolveNativeUsd: async () => ({ price: 600, source: "env" }),
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(snap.marketCapUsd, 6000);
  assert.equal(snap.liquidityUsd, 1200);
  assert.equal(snap.holders, 42);
  assert.equal(snap.healthy, true);
  assert.ok(!calls.some((sql) => /votes_24h/i.test(sql)));
});

test("missing FX does not label native units as USD", async () => {
  const query = async (sql) => {
    const text = String(sql);
    if (text.includes("from public.campaigns")) {
      return {
        rows: [{
          chain_id: 56,
          campaign_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token_address: TOKEN_L,
          creator_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          fee_recipient_address: null,
        }],
      };
    }
    if (text.includes("from public.market_stats") && !text.includes("join public.campaigns")) {
      return {
        rows: [{
          market_cap_bnb: 10,
          liquidity_bnb: 2,
          holders: 10,
          volume_24h_bnb: 1,
          updated_at: "2026-09-02T12:00:00.000Z",
          data_lag_seconds: 1,
        }],
      };
    }
    return { rows: [] };
  };
  const snap = await getArenaMarketSnapshot(56, TOKEN_L, {
    query,
    resolveNativeUsd: async () => ({ price: 0, source: "none" }),
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(snap.marketCapUsd, null);
  assert.equal(snap.healthy, false);
  assert.equal(snap.reason, "native_units_unpriced");
});

test("stale market stats are marked unhealthy", async () => {
  const query = async (sql) => {
    const text = String(sql);
    if (text.includes("from public.campaigns")) {
      return {
        rows: [{
          chain_id: 56,
          campaign_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token_address: TOKEN_L,
          creator_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          fee_recipient_address: null,
        }],
      };
    }
    if (text.includes("from public.market_stats") && !text.includes("join public.campaigns")) {
      return {
        rows: [{
          market_cap_bnb: 10,
          liquidity_bnb: 2,
          holders: 10,
          volume_24h_bnb: 1,
          updated_at: "2026-09-02T11:00:00.000Z",
          data_lag_seconds: 400,
        }],
      };
    }
    return { rows: [] };
  };
  const snap = await getArenaMarketSnapshot(56, TOKEN_L, {
    query,
    resolveNativeUsd: async () => ({ price: 600, source: "env" }),
    nowMs: Date.parse("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(snap.marketCapUsd, 6000);
  assert.equal(snap.healthy, false);
  assert.equal(snap.reason, "stale");
});

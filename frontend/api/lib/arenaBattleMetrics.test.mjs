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

function metricRow(params, offset) {
  return {
    battle_id: params[offset],
    token_id: params[offset + 1],
    side: params[offset + 2],
    scoring_version: params[offset + 3],
    start_mcap_usd: params[offset + 4],
    start_holders: params[offset + 5],
    start_liquidity_usd: params[offset + 6],
    baseline_timestamp: params[offset + 7],
    baseline_market_data_updated_at: params[offset + 8],
    baseline_data_source: params[offset + 9],
    baseline_healthy: params[offset + 10],
    current_mcap_usd: params[offset + 11],
    current_holders: params[offset + 12],
    current_liquidity_usd: params[offset + 13],
    market_data_updated_at: params[offset + 14],
    data_lag_seconds: params[offset + 15],
    data_source: params[offset + 16],
    data_healthy: params[offset + 17],
  };
}

function createMetricsMemory() {
  const metrics = [];
  async function query(sql, params) {
    const text = String(sql);
    if (/insert into public.arena_battle_metrics/i.test(text)) {
      const rows = params.length >= 36 ? [metricRow(params, 0), metricRow(params, 18)] : [metricRow(params, 0)];
      let inserted = 0;
      for (const row of rows) {
        const exists = metrics.some((existing) => existing.battle_id === row.battle_id && existing.side === row.side);
        if (!exists) {
          metrics.push(row);
          inserted += 1;
        }
      }
      return { rowCount: inserted, rows: [] };
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
    dataSource: "normalized_market_stats",
    healthy: true,
    dataLagSeconds: 5,
    ...partial,
  };
}

test("live capture writes both sides atomically with authoritative started_at", async () => {
  const db = createMetricsMemory();
  const result = await captureLiveBaselines(liveRow(), {
    query: db.query,
    now: new Date("2026-09-02T12:09:59.000Z"),
    snapshots: { left: snap(), right: snap({ marketCapUsd: 8_000, holders: 150 }) },
  });
  assert.equal(result.captured, true);
  assert.equal(result.insertedRows, 2);
  assert.equal(db.metrics.length, 2);
  const left = db.metrics.find((row) => row.side === "left");
  assert.equal(left.token_id, TOKEN_L);
  assert.equal(left.start_mcap_usd, 10_000);
  assert.equal(left.start_holders, 200);
  assert.equal(left.start_liquidity_usd, 3_000);
  assert.equal(left.baseline_timestamp, "2026-09-02T12:00:00.000Z");
  assert.equal(left.scoring_version, BATTLE_POINTS_V2);
});

test("snapshot failure occurs before any baseline write", async () => {
  const db = createMetricsMemory();
  await assert.rejects(
    captureLiveBaselines(liveRow(), {
      query: db.query,
      getSnapshot: async (_chainId, tokenId) => {
        if (tokenId === TOKEN_R) throw new Error("right snapshot unavailable");
        return snap();
      },
    }),
    /right snapshot unavailable/,
  );
  assert.equal(db.metrics.length, 0);
});

test("live capture refuses a missing authoritative started_at", async () => {
  const db = createMetricsMemory();
  await assert.rejects(
    captureLiveBaselines({ ...liveRow(), started_at: null }, {
      query: db.query,
      snapshots: { left: snap(), right: snap() },
    }),
    /missing authoritative started_at/,
  );
  assert.equal(db.metrics.length, 0);
});

test("second live capture does not replace start_* or baseline_timestamp", async () => {
  const db = createMetricsMemory();
  const row = liveRow();
  await captureLiveBaselines(row, {
    query: db.query,
    snapshots: { left: snap(), right: snap({ marketCapUsd: 8_000 }) },
  });
  await captureLiveBaselines(row, {
    query: db.query,
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

test("unhealthy authoritative snapshot remains recorded and flagged", async () => {
  const db = createMetricsMemory();
  await captureLiveBaselines(liveRow(), {
    query: db.query,
    snapshots: {
      left: snap({ marketCapUsd: null, healthy: false, dataSource: "none", updatedAt: null }),
      right: snap({ healthy: false, reason: "stale" }),
    },
  });
  assert.equal(db.metrics.length, 2);
  assert.equal(db.metrics[0].baseline_healthy, false);
  assert.equal(db.metrics[0].baseline_market_data_updated_at, null);
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

test("migrations remain additive and detailed volume audit becomes internal", () => {
  const original = fs.readFileSync(path.join(root, "db/migrations/20260902_000003_arena_battle_metrics.sql"), "utf8");
  const correction = fs.readFileSync(path.join(root, "db/migrations/20260902_000004_arena_battle_v2_corrections.sql"), "utf8");
  assert.match(original, /CREATE TABLE IF NOT EXISTS public.arena_battle_metrics/);
  assert.match(original, /CREATE TABLE IF NOT EXISTS public.arena_battle_volume_audit/);
  assert.match(original, /PRIMARY KEY \(battle_id, side\)/);
  assert.doesNotMatch(original, /DROP TABLE public.arena_battles/);
  assert.doesNotMatch(original, /ALTER TABLE public.arena_battles DROP/);
  assert.match(BASELINE_INSERT_SQL, /ON CONFLICT \(battle_id, side\) DO NOTHING/);
  assert.match(correction, /REVOKE SELECT ON TABLE public\.arena_battle_volume_audit FROM anon, authenticated/i);
  assert.match(correction, /DROP POLICY IF EXISTS arena_battle_volume_audit_public_read/i);
  assert.match(correction, /"quoteAssetType"/);
  assert.match(correction, /"volumeUsd"/);
});

function nativeQuery(statsRow) {
  return async (sql) => {
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
    if (text.includes("from public.market_stats") && !text.includes("join public.campaigns")) return { rows: [statsRow] };
    return { rows: [] };
  };
}

test("native compatibility converts legacy native units with explicit FX labeling", async () => {
  const market = await getArenaMarketSnapshot(56, TOKEN_L, {
    query: nativeQuery({
      market_cap_usd: null,
      liquidity_usd: null,
      volume_24h_usd: null,
      market_cap_bnb: 10,
      liquidity_bnb: 2,
      holders: 42,
      volume_24h_bnb: 1,
      quote_asset_type: "WRAPPED_NATIVE",
      updated_at: "2026-09-02T12:00:00.000Z",
      data_lag_seconds: 8,
    }),
    resolveNativeUsd: async () => ({ price: 600, source: "env" }),
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(market.marketCapUsd, 6000);
  assert.equal(market.liquidityUsd, 1200);
  assert.equal(market.holders, 42);
  assert.equal(market.dataSource, "legacy_native_market_stats+fx");
  assert.equal(market.healthy, true);
});

test("explicit normalized USD fields take precedence over legacy native columns", async () => {
  const market = await getArenaMarketSnapshot(56, TOKEN_L, {
    query: nativeQuery({
      market_cap_usd: 7777,
      liquidity_usd: 2222,
      volume_24h_usd: 3333,
      market_cap_bnb: 999,
      liquidity_bnb: 999,
      holders: 42,
      volume_24h_bnb: 999,
      quote_asset_type: "WRAPPED_NATIVE",
      updated_at: "2026-09-02T12:00:00.000Z",
      data_lag_seconds: 8,
    }),
    resolveNativeUsd: async () => ({ price: 600, source: "env" }),
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(market.marketCapUsd, 7777);
  assert.equal(market.liquidityUsd, 2222);
  assert.equal(market.volume24hUsd, 3333);
  assert.equal(market.dataSource, "normalized_market_stats");
});

test("Stock quote markets use explicit normalized USD and never call native FX", async () => {
  const market = await getArenaMarketSnapshot(4663, TOKEN_L, {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes("from public.campaigns")) {
        return { rows: [{
          chain_id: 4663,
          campaign_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token_address: TOKEN_L,
          creator_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          fee_recipient_address: null,
        }] };
      }
      if (text.includes("from public.market_stats") && !text.includes("join public.campaigns")) {
        return { rows: [{
          market_cap_usd: 25_000,
          liquidity_usd: 8_000,
          volume_24h_usd: 5_000,
          market_cap_bnb: 999,
          liquidity_bnb: 999,
          holders: 350,
          volume_24h_bnb: 999,
          quote_asset_type: "STOCK_TOKEN",
          quote_token_address: "0x9999999999999999999999999999999999999999",
          updated_at: "2026-09-02T12:00:00.000Z",
          data_lag_seconds: 5,
        }] };
      }
      return { rows: [] };
    },
    resolveNativeUsd: async () => { throw new Error("native FX must not be used for Stock quote"); },
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(market.marketCapUsd, 25_000);
  assert.equal(market.liquidityUsd, 8_000);
  assert.equal(market.volume24hUsd, 5_000);
  assert.equal(market.quoteAssetType, "STOCK_TOKEN");
  assert.equal(market.dataSource, "normalized_stock_market_stats");
  assert.equal(market.healthy, true);
});

test("Stock quote markets fail closed when normalized USD is missing even if legacy native fields exist", async () => {
  const market = await getArenaMarketSnapshot(4663, TOKEN_L, {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes("from public.campaigns")) {
        return { rows: [{ chain_id: 4663, campaign_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token_address: TOKEN_L }] };
      }
      if (text.includes("from public.market_stats") && !text.includes("join public.campaigns")) {
        return { rows: [{
          market_cap_usd: null,
          liquidity_usd: null,
          volume_24h_usd: null,
          market_cap_bnb: 10,
          liquidity_bnb: 2,
          holders: 42,
          volume_24h_bnb: 1,
          quote_asset_type: "STOCK_TOKEN",
          updated_at: "2026-09-02T12:00:00.000Z",
          data_lag_seconds: 5,
        }] };
      }
      return { rows: [] };
    },
    resolveNativeUsd: async () => ({ price: 9999, source: "must_not_apply" }),
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(market.marketCapUsd, null);
  assert.equal(market.liquidityUsd, null);
  assert.equal(market.healthy, false);
  assert.ok(market.reasons.includes("stock_market_cap_usd_missing"));
  assert.ok(market.reasons.includes("stock_liquidity_usd_missing"));
});

test("import scan metadata is not fabricated into authoritative market data", async () => {
  const market = await getArenaMarketSnapshot(56, TOKEN_L, {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes("from public.campaigns")) return { rows: [] };
      if (text.includes("from public.arena_token_imports")) {
        return { rows: [{
          chain_id: 56,
          token_address: TOKEN_L,
          owner_wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          scan_json: { totalSupply: "1000000000000000000", decimals: 18, pool: "0xcccccccccccccccccccccccccccccccccccccccc" },
        }] };
      }
      return { rows: [] };
    },
  });
  assert.equal(market.origin, "import");
  assert.equal(market.marketCapUsd, null);
  assert.equal(market.healthy, false);
  assert.equal(market.reason, "import_market_data_missing");
});

test("missing native FX does not relabel native units as USD", async () => {
  const market = await getArenaMarketSnapshot(56, TOKEN_L, {
    query: nativeQuery({
      market_cap_usd: null,
      liquidity_usd: null,
      volume_24h_usd: null,
      market_cap_bnb: 10,
      liquidity_bnb: 2,
      holders: 10,
      volume_24h_bnb: 1,
      quote_asset_type: "WRAPPED_NATIVE",
      updated_at: "2026-09-02T12:00:00.000Z",
      data_lag_seconds: 1,
    }),
    resolveNativeUsd: async () => ({ price: 0, source: "none" }),
    nowMs: Date.parse("2026-09-02T12:00:10.000Z"),
  });
  assert.equal(market.marketCapUsd, null);
  assert.equal(market.healthy, false);
  assert.ok(market.reasons.includes("market_cap_usd_missing"));
  assert.ok(market.reasons.includes("native_usd_price_missing"));
});

test("stale market stats are marked unhealthy", async () => {
  const market = await getArenaMarketSnapshot(56, TOKEN_L, {
    query: nativeQuery({
      market_cap_usd: null,
      liquidity_usd: null,
      volume_24h_usd: null,
      market_cap_bnb: 10,
      liquidity_bnb: 2,
      holders: 10,
      volume_24h_bnb: 1,
      quote_asset_type: "WRAPPED_NATIVE",
      updated_at: "2026-09-02T11:00:00.000Z",
      data_lag_seconds: 400,
    }),
    resolveNativeUsd: async () => ({ price: 600, source: "env" }),
    nowMs: Date.parse("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(market.marketCapUsd, 6000);
  assert.equal(market.healthy, false);
  assert.ok(market.reasons.includes("stale"));
});

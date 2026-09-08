import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BATTLE_POINTS_V3, BATTLE_POINTS_V3_BOOST_CURVE, BATTLE_POINTS_V3_CONFIG } from "./arenaBattlePointsConfig.js";
import {
  applyConfirmedNormalBattleBoostV3,
  loadNormalBattleV3SaleAuthority,
  normalBattleRegulationOpen,
  validateHistoricalNormalPaymentIdentity,
} from "./arenaSolanaNormalBoostAuthority.mjs";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const END = "2026-09-05T12:01:00.000Z";
const LOCK = {
  battle_id: "b1",
  scoring_version: BATTLE_POINTS_V3,
  boost_curve_version: BATTLE_POINTS_V3_BOOST_CURVE,
  boost_curve_parameters: { ...BATTLE_POINTS_V3_CONFIG.boost.curveParameters },
  locked_at: "2026-09-05T11:00:00.000Z",
};
function row(side, token) {
  return {
    battle_id: "b1", token_id: token, side, scoring_version: BATTLE_POINTS_V3,
    mcap_weight: 45, holder_weight: 27, volume_weight: 18, boost_weight: 10,
    boost_curve_version: BATTLE_POINTS_V3_BOOST_CURVE,
    boost_curve_parameters: { ...BATTLE_POINTS_V3_CONFIG.boost.curveParameters },
    boost_units: "0", boost_gross_native_raw: "0", boost_pool_native_raw: "0", boost_protocol_native_raw: "0",
    boost_points: 0, mcap_points: 10, holder_points: 8, volume_points: 6, total_points: 24,
    metrics_updated_at: "2026-09-05T11:59:30.000Z", updated_at: "2026-09-05T11:59:30.000Z",
  };
}
const BATTLE = { id: "b1", chain_id: 101, state: "live", source: "direct", battle_mode: "normal", competition_generation: "arena_competition_v2", ends_at: END };
const METRICS = ["left", "right"].map((side) => ({ battle_id: "b1", side, data_healthy: true, data_lag_seconds: 30, market_data_updated_at: "2026-09-05T11:59:30.000Z", metrics_updated_at: "2026-09-05T11:59:30.000Z" }));
const ENV = { ARENA_BATTLE_POINTS_V3: "true", ARENA_BATTLE_POINTS_V3_SETTLEMENT: "true" };

function authorityDb({ lock = LOCK, rows = [row("left", "A"), row("right", "B")] } = {}) {
  return { async query(sql) {
    if (sql.includes("arena_battle_scoring_locks")) return { rows: lock ? [lock] : [] };
    if (sql.includes("arena_battle_points_v3")) return { rows };
    if (sql.includes("arena_battle_metrics")) return { rows: METRICS };
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test("locked V3 Normal Battle is eligible while historical/unlocked generations are not", async () => {
  const active = await loadNormalBattleV3SaleAuthority({ battle: BATTLE, db: authorityDb(), env: ENV, now: NOW });
  assert.equal(active.active, true);
  assert.equal(active.lock.scoring_version, BATTLE_POINTS_V3);
  assert.equal(active.lock.boost_curve_version, BATTLE_POINTS_V3_BOOST_CURVE);
  assert.deepEqual(active.projections.map((p) => p.side), ["left", "right"]);

  const historical = await loadNormalBattleV3SaleAuthority({ battle: BATTLE, db: authorityDb({ lock: null }), env: ENV, now: NOW });
  assert.equal(historical.active, false);
  assert.equal(historical.reason, "historical_scoring_generation");

  const scaffold = await loadNormalBattleV3SaleAuthority({ battle: BATTLE, db: authorityDb({ lock: { ...LOCK, boost_curve_version: "founder_pending" } }), env: ENV, now: NOW });
  assert.equal(scaffold.active, false);
  assert.equal(scaffold.reason, "historical_scoring_generation");
});

test("Normal Battle regulation cutoff is exact at ends_at", () => {
  assert.equal(normalBattleRegulationOpen(BATTLE, Date.parse(END) - 1), true);
  assert.equal(normalBattleRegulationOpen(BATTLE, Date.parse(END)), false);
  assert.equal(normalBattleRegulationOpen(BATTLE, Date.parse(END) + 1), false);
});

test("historical recovery identity is independent of live state but exact on operation identity", () => {
  const closed = { ...BATTLE, state: "settled" };
  const quote = { id: "q1", product_kind: "normal_battle", battle_id: "b1", chain_id: 101, wallet: "W", target_token: "A", side: "left", competition_id: "0xabc", funding_id: "f1", signature_reference: "sig", receipt_pda: "receipt" };
  const good = validateHistoricalNormalPaymentIdentity({ route: { battleId: "b1" }, quote, battle: closed, targetToken: "A", side: "left", competitionId: "0xAbC" });
  assert.equal(good.ok, true);
  assert.equal(validateHistoricalNormalPaymentIdentity({ route: { battleId: "wrong" }, quote, battle: closed, targetToken: "A", side: "left", competitionId: "0xabc" }).ok, false);
  assert.equal(validateHistoricalNormalPaymentIdentity({ route: { battleId: "b1" }, quote, battle: closed, targetToken: "B", side: "left", competitionId: "0xabc" }).ok, false);
  assert.equal(validateHistoricalNormalPaymentIdentity({ route: { battleId: "b1" }, quote, battle: closed, targetToken: "A", side: "right", competitionId: "0xabc" }).ok, false);
  assert.equal(validateHistoricalNormalPaymentIdentity({ route: { battleId: "b1" }, quote, battle: closed, targetToken: "A", side: "left", competitionId: "0xdef" }).ok, false);
});

test("confirmed SOL Boost updates only an existing exact V3 projection with canonical curve and preserves market freshness", async () => {
  const projection = row("left", "A");
  const queries = [];
  const client = { async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes("arena_battle_scoring_locks")) return { rows: [LOCK] };
    if (sql.includes("from public.arena_battle_points_v3") && sql.includes("for update")) return { rows: [projection] };
    if (sql.includes("from public.arena_battle_metrics")) return { rows: [METRICS[0]] };
    if (sql.startsWith("update public.arena_battle_points_v3")) return { rows: [{ ...projection, boost_units: params[2], boost_points: params[6] }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const result = await applyConfirmedNormalBattleBoostV3(client, { battle_id: "b1", side: "left", boost_units: "100", gross_lamports: "1000", prize_lamports: "900", protocol_lamports: "100" }, { now: NOW });
  assert.equal(result.updated, true);
  assert.equal(result.boostPoints, 5);
  const update = queries.find((entry) => entry.sql.startsWith("update public.arena_battle_points_v3"));
  assert.ok(update);
  assert.equal(update.sql.includes("insert into public.arena_battle_points_v3"), false);
  assert.equal(update.sql.includes("metrics_updated_at"), false);
  assert.equal(update.params[2], "100");
  assert.equal(update.params[6], 5);
});

test("historical V2 receipt cannot create V3 authority", async () => {
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.includes("arena_battle_scoring_locks")) return { rows: [] };
    throw new Error("historical path must stop before projection mutation");
  } };
  const result = await applyConfirmedNormalBattleBoostV3(client, { battle_id: "b1", side: "left", boost_units: "1", gross_lamports: "10", prize_lamports: "9", protocol_lamports: "1" });
  assert.deepEqual(result, { updated: false, reason: "historical_scoring_generation" });
  assert.equal(queries.some((sql) => sql.includes("insert into public.arena_battle_points_v3")), false);
});

test("production handler separates new-sale authority from historical recovery and rejects post-end/receipt mismatch", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(here, "../arenaSolanaBoosts.js"), "utf8");
  assert.match(source, /normalBattleRegulationOpen\(battle\)/);
  assert.match(source, /loadNormalBattleV3SaleAuthority\(\{ battle, db: pool \}\)/);
  assert.match(source, /async function normalPaymentContext/);
  assert.doesNotMatch(source.match(/async function normalPaymentContext[\s\S]*?\n\}/)?.[0] || "", /normalContext\(/);
  assert.match(source, /receipt_identity_mismatch_landed/);
  assert.match(source, /receiptMs >= new Date\(context\.battle\.ends_at\)\.getTime\(\)/);
  assert.match(source, /applyConfirmedNormalBattleBoostV3\(client, quote\)/);
  assert.doesNotMatch(source, /insert into public\.arena_battle_points_v3/);
  assert.doesNotMatch(source, /metrics_updated_at=now\(\)/);
  assert.match(source, /expectedWallet: quote\.wallet/);
  assert.match(source, /signature_reference && quote\.signature_reference !== signature/);
  assert.match(source, /verifySolanaBoostPayment\(\{ chainId: quote\.chain_id, signature/);
});

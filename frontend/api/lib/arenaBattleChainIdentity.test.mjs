import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  battleBelongsToChain,
  battleIdFromPath,
  chainIdFromMutation,
  filterBattleFeedByChain,
  loadBattleOnChain,
  optionalChainId,
} from "./arenaBattleChainIdentity.js";
import {
  BATTLE_POINTS_CONFIG,
  BATTLE_POINTS_V3_BOOST_CURVE,
  BATTLE_POINTS_V3_CONFIG,
} from "./arenaBattlePointsConfig.js";
import { calculateBattlePointsV3Boost } from "./arenaBattlePointsV3.js";

const BNB = 56;
const SOLANA = 101;
const ROBINHOOD = 4663;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const row = (chainId, id = "same-battle-id") => ({ id, chain_id: chainId });

test("BNB Battle is accessible on BNB and rejected through Solana/Robinhood context", () => {
  const battle = row(BNB);
  assert.equal(battleBelongsToChain(battle, BNB), true);
  assert.equal(battleBelongsToChain(battle, SOLANA), false);
  assert.equal(battleBelongsToChain(battle, ROBINHOOD), false);
});

test("Solana Battle is rejected through BNB context", () => {
  assert.equal(battleBelongsToChain(row(SOLANA), BNB), false);
});

test("Robinhood Battle is rejected through BNB context", () => {
  assert.equal(battleBelongsToChain(row(ROBINHOOD), BNB), false);
});

test("Battle lookup binds id plus chain, so identical ids cannot cross chains", async () => {
  let observed = null;
  const query = async (sql, params) => {
    observed = { sql, params };
    return { rows: params[1] === BNB ? [row(BNB)] : [] };
  };
  assert.equal((await loadBattleOnChain(query, "same-battle-id", BNB)).chain_id, BNB);
  assert.equal(await loadBattleOnChain(query, "same-battle-id", SOLANA), null);
  assert.match(observed.sql, /where id = \$1 and chain_id = \$2/i);
});

test("ACCEPT COUNTER DECLINE cancel and LIVE transition all resolve the same guarded Battle identity", () => {
  for (const suffix of ["", "/accept", "/counter", "/decline", "/cancel-open", "/transition"]) {
    assert.equal(battleIdFromPath(`/arena/battles/same-battle-id${suffix}`), "same-battle-id");
  }
  assert.equal(battleIdFromPath("/arena/battles/challenge"), "");
  assert.equal(battleIdFromPath("/arena/battles/open"), "");
});

test("Battle list/feed is chain isolated while aggregate payload can remain chain-aware", () => {
  const payload = {
    liveBattles: [row(BNB, "bnb-live"), row(SOLANA, "sol-live"), row(ROBINHOOD, "rh-live")],
    openForBattleQueue: [row(BNB, "bnb-open"), row(SOLANA, "sol-open")],
    archivedBattles: [{ battle: row(BNB, "bnb-old") }, { battle: row(ROBINHOOD, "rh-old") }],
  };
  const bnb = filterBattleFeedByChain(payload, BNB);
  assert.deepEqual(bnb.liveBattles.map((b) => b.id), ["bnb-live"]);
  assert.deepEqual(bnb.openForBattleQueue.map((b) => b.id), ["bnb-open"]);
  assert.deepEqual(bnb.archivedBattles.map((e) => e.battle.id), ["bnb-old"]);
});

test("challenge lifecycle chain context is taken from explicit body or signed auth and cannot be silently reinterpreted", async () => {
  const fromBody = await chainIdFromMutation({}, { readJson: async () => ({ chainId: SOLANA }) });
  assert.equal(fromBody.chainId, SOLANA);
  const fromAuth = await chainIdFromMutation({}, { readJson: async () => ({ auth: { chainId: ROBINHOOD } }) });
  assert.equal(fromAuth.chainId, ROBINHOOD);
  assert.throws(() => optionalChainId("not-a-chain"), /Invalid Arena chain id/);
});

test("AUTO DEPLOY candidate selection is chain-scoped in the Normal Battle implementation", () => {
  const source = fs.readFileSync(path.join(API_ROOT, "arenaBattles.js"), "utf8");
  assert.match(source, /async function waitingCandidates\(chainId[\s\S]*where chain_id = \$1 and state = 'waiting'/i);
  assert.match(source, /const candidates = await waitingCandidates\(chainId,/);
});

test("LIVE transition baseline uses the Battle row chain identity", () => {
  const source = fs.readFileSync(path.join(HERE, "arenaBattleMetrics.js"), "utf8");
  assert.match(source, /export async function captureLiveBaselines\(row[\s\S]*const chainId = Number\(row\.chain_id \?\? row\.chainId\)/);
  assert.match(source, /getArenaMarketSnapshot\(chainId, tokenId/);
});

test("settlement market evidence is resolved from current Battle chain", () => {
  const source = fs.readFileSync(path.join(HERE, "arenaBattleSettlementV3Service.js"), "utf8");
  assert.match(source, /const chainId = Number\(current\.chain_id\)/);
  assert.match(source, /getArenaMarketSnapshot\)\(chainId, metricsRow\.token_id/);
  assert.match(source, /loadBattleWindowTrades\(\{[\s\S]*chainId,/);
});

test("V3 scoring remains 45/27/18/10 with founder-locked hyperbolic curve", () => {
  assert.equal(BATTLE_POINTS_V3_CONFIG.mcap.weight, 45);
  assert.equal(BATTLE_POINTS_V3_CONFIG.holders.weight, 27);
  assert.equal(BATTLE_POINTS_V3_CONFIG.volume.weight, 18);
  assert.equal(BATTLE_POINTS_V3_CONFIG.boost.weight, 10);
  assert.equal(BATTLE_POINTS_V3_BOOST_CURVE, "boost_hyperbolic_100_v1");
  assert.equal(calculateBattlePointsV3Boost(100), 5);
  assert.equal(calculateBattlePointsV3Boost(0), 0);
  assert.ok(calculateBattlePointsV3Boost(1_000_000) < 10);
});

test("historical V2 scoring remains 50/30/20 and has no Boost allocation", () => {
  assert.equal(BATTLE_POINTS_CONFIG.mcap.weight, 50);
  assert.equal(BATTLE_POINTS_CONFIG.holders.weight, 30);
  assert.equal(BATTLE_POINTS_CONFIG.volume.weight, 20);
  assert.equal("boost" in BATTLE_POINTS_CONFIG, false);
});

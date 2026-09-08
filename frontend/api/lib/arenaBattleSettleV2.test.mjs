import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLE_POINTS_MONEY_TIE_BREAK,
  BATTLE_POINTS_SETTLEMENT_VERSION,
  BATTLE_POINTS_TIE_EPSILON,
  INVALID_BATTLE_POINTS_SNAPSHOT,
  decideBattlePointsSettlement,
} from "./arenaBattleSettleV2.js";
import { MWL_RESULT } from "./arenaLeagueScoreMath.js";

const LEFT = "0x1111111111111111111111111111111111111111";
const RIGHT = "0x2222222222222222222222222222222222222222";

function scored({
  total = 60,
  mcap = 30,
  holders = 20,
  volume = 10,
  startMcap = 100_000,
  endMcap = 120_000,
  healthy = true,
} = {}) {
  return {
    scoringVersion: "battle_points_v2",
    totalPoints: total,
    mcap: { start: startMcap, current: endMcap, changePct: (endMcap - startMcap) / startMcap, points: mcap },
    holders: { points: holders },
    volume: { points: volume },
    components: { mcapPoints: mcap, holderPoints: holders, volumePoints: volume },
    performance: { mcapPct: (endMcap - startMcap) / startMcap },
    dataHealth: { healthy, status: healthy ? "healthy" : "stale", reasons: healthy ? [] : ["stale"] },
  };
}

test("higher Battle Points wins both ranked result and money settlement", () => {
  const decision = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: scored({ total: 72, mcap: 40, holders: 22, volume: 10 }),
    rightScored: scored({ total: 64, mcap: 36, holders: 18, volume: 10 }),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.settlementVersion, BATTLE_POINTS_SETTLEMENT_VERSION);
  assert.equal(decision.settlementScoringVersion, "battle_points_v2");
  assert.equal(decision.mwlResult, MWL_RESULT.LEFT_WIN);
  assert.equal(decision.mwlDraw, false);
  assert.equal(decision.mwlWinnerToken, LEFT);
  assert.equal(decision.moneyWinnerToken, LEFT);
  assert.equal(decision.moneyTieBreak, BATTLE_POINTS_MONEY_TIE_BREAK.BATTLE_POINTS);
  assert.equal(decision.tieBreakUsed, false);
});

test("functionally equal total scores produce MWL draw but MCAP component selects payout recipient", () => {
  const decision = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: scored({ total: 60, mcap: 31, holders: 19, volume: 10 }),
    rightScored: scored({ total: 60 + BATTLE_POINTS_TIE_EPSILON / 2, mcap: 30, holders: 20, volume: 10 }),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.mwlResult, MWL_RESULT.DRAW);
  assert.equal(decision.mwlDraw, true);
  assert.equal(decision.mwlWinnerToken, null);
  assert.equal(decision.moneyWinnerToken, LEFT);
  assert.equal(decision.moneyTieBreak, BATTLE_POINTS_MONEY_TIE_BREAK.MCAP_COMPONENT);
  assert.equal(decision.tieBreakUsed, true);
});

test("component tie-break hierarchy is MCAP, holders, volume, then token identity", () => {
  const holderDecision = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: scored({ total: 60, mcap: 30, holders: 21, volume: 9 }),
    rightScored: scored({ total: 60, mcap: 30, holders: 20, volume: 10 }),
  });
  assert.equal(holderDecision.moneyWinnerToken, LEFT);
  assert.equal(holderDecision.moneyTieBreak, BATTLE_POINTS_MONEY_TIE_BREAK.HOLDER_COMPONENT);

  const volumeDecision = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: scored({ total: 60, mcap: 30, holders: 20, volume: 10 }),
    rightScored: scored({ total: 60, mcap: 30, holders: 20, volume: 9 }),
  });
  assert.equal(volumeDecision.moneyWinnerToken, LEFT);
  assert.equal(volumeDecision.moneyTieBreak, BATTLE_POINTS_MONEY_TIE_BREAK.VOLUME_COMPONENT);

  const identityDecision = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: scored({ total: 60, mcap: 30, holders: 20, volume: 10 }),
    rightScored: scored({ total: 60, mcap: 30, holders: 20, volume: 10 }),
  });
  assert.equal(identityDecision.moneyWinnerToken, RIGHT);
  assert.equal(identityDecision.moneyTieBreak, BATTLE_POINTS_MONEY_TIE_BREAK.TOKEN_ADDRESS);
});

test("Solana token identity remains case-sensitive in the final deterministic tie-break", () => {
  const left = "AbCdEfSolanaToken111111111111111111111111111";
  const right = "aBcDeFSolanaToken111111111111111111111111111";
  const decision = decideBattlePointsSettlement({
    leftToken: left,
    rightToken: right,
    leftScored: scored(),
    rightScored: scored(),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.moneyTieBreak, BATTLE_POINTS_MONEY_TIE_BREAK.TOKEN_ADDRESS);
  assert.equal(decision.moneyWinnerToken, right);
});

test("unhealthy or non-V2 score snapshots fail closed without a winner", () => {
  const unhealthy = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: scored({ healthy: false }),
    rightScored: scored(),
  });
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.reason, INVALID_BATTLE_POINTS_SNAPSHOT);
  assert.equal(unhealthy.moneyWinnerToken, null);
  assert.equal(unhealthy.mwlWinnerToken, null);

  const legacy = scored();
  legacy.scoringVersion = "mcap_pct_change";
  const wrongVersion = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: legacy,
    rightScored: scored(),
  });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.reason, INVALID_BATTLE_POINTS_SNAPSHOT);
});

test("invalid totals/components fail closed rather than silently coercing", () => {
  const bad = scored();
  bad.totalPoints = null;
  const decision = decideBattlePointsSettlement({
    leftToken: LEFT,
    rightToken: RIGHT,
    leftScored: bad,
    rightScored: scored(),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, INVALID_BATTLE_POINTS_SNAPSHOT);
});

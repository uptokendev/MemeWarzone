import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DRAW_POINTS,
  INVALID_MARKET_CAP_SNAPSHOT,
  LOSS_POINTS,
  MISSING_BATTLE_CHAIN_ID,
  MONEY_TIE_BREAK,
  MWL_RESULT,
  PAIR_WINDOW_DAYS,
  REMATCH_FIGHT_POLICY,
  SETTLEMENT_VERSION,
  TOURNAMENT_WIN_BONUS,
  WIN_POINTS,
  battlePointPlan,
  compareTokenIdentity,
  moneyWinner,
  mwlLedgerPlan,
  mwlOutcome,
  pairKey,
  pairPointsEligible,
  pairScoringLockKey,
  pctChange,
  requireBattleChainId,
  settleBattleResult,
} from "./arenaLeagueScoreMath.js";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const here = path.dirname(fileURLToPath(import.meta.url));

test("locked MWL points are win 3 / loss 1 / draw 0", () => {
  assert.equal(WIN_POINTS, 3);
  assert.equal(LOSS_POINTS, 1);
  assert.equal(DRAW_POINTS, 0);
  assert.equal(TOURNAMENT_WIN_BONUS, 2);
  assert.equal(PAIR_WINDOW_DAYS, 7);
  assert.equal(SETTLEMENT_VERSION, 1);
});

test("pctChange is a ratio and treats zero start as +100% when end is positive", () => {
  assert.equal(pctChange(100, 110), 0.1);
  assert.equal(pctChange(100, 90), -0.1);
  assert.equal(pctChange(0, 50), 1);
  assert.equal(pctChange(0, 0), 0);
});

test("normal A (left) win: MWL + money follow performance", () => {
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 130,
    rightEndMcap: 110,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mwlResult, MWL_RESULT.LEFT_WIN);
  assert.equal(result.mwlDraw, false);
  assert.equal(result.mwlWinnerToken, TOKEN_A);
  assert.equal(result.moneyWinnerToken, TOKEN_A);
  assert.equal(result.moneyTieBreak, MONEY_TIE_BREAK.PERFORMANCE);
  assert.equal(result.ledger.left.points, WIN_POINTS);
  assert.equal(result.ledger.right.points, LOSS_POINTS);
  assert.equal(result.ledger.left.kind, "battle_win");
  assert.equal(result.ledger.right.kind, "battle_loss");
});

test("normal B (right) win: loser still receives 1 MWL point", () => {
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 90,
    rightEndMcap: 120,
  });
  assert.equal(result.mwlResult, MWL_RESULT.RIGHT_WIN);
  assert.equal(result.mwlWinnerToken, TOKEN_B);
  assert.equal(result.moneyWinnerToken, TOKEN_B);
  assert.equal(result.moneyTieBreak, MONEY_TIE_BREAK.PERFORMANCE);
  assert.equal(result.ledger.left.points, LOSS_POINTS);
  assert.equal(result.ledger.right.points, WIN_POINTS);
});

test("percentage draw adds 0/0 MWL points and still picks a money winner", () => {
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 200,
    leftEndMcap: 110,
    rightEndMcap: 220,
  });
  assert.equal(result.leftPct, result.rightPct);
  assert.equal(result.mwlResult, MWL_RESULT.DRAW);
  assert.equal(result.mwlDraw, true);
  assert.equal(result.mwlWinnerToken, null);
  assert.equal(result.ledger.left.points, DRAW_POINTS);
  assert.equal(result.ledger.right.points, DRAW_POINTS);
  assert.equal(result.ledger.left.kind, "battle_draw");
  assert.equal(result.ledger.right.kind, "battle_draw");
  assert.equal(result.moneyWinnerToken, TOKEN_B);
  assert.equal(result.moneyTieBreak, MONEY_TIE_BREAK.ENDING_MCAP);
});

test("percentage draw → higher ending mcap picks money winner", () => {
  const money = moneyWinner({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftPct: 0.05,
    rightPct: 0.05,
    leftEndMcap: 500,
    rightEndMcap: 80,
  });
  assert.equal(money.moneyWinnerToken, TOKEN_A);
  assert.equal(money.moneyTieBreak, MONEY_TIE_BREAK.ENDING_MCAP);
  assert.equal(mwlOutcome({ leftPct: 0.05, rightPct: 0.05 }).mwlDraw, true);
});

test("absolute ending-mcap tie → address tie-break", () => {
  assert.ok(compareTokenIdentity(TOKEN_B, TOKEN_A) > 0);
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 100,
    rightEndMcap: 100,
  });
  assert.equal(result.mwlDraw, true);
  assert.equal(result.moneyWinnerToken, TOKEN_B);
  assert.equal(result.moneyTieBreak, MONEY_TIE_BREAK.TOKEN_ADDRESS);
});

test("performance winner ignores a larger ending mcap on the loser", () => {
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 50,
    rightStartMcap: 1000,
    leftEndMcap: 100,
    rightEndMcap: 1010,
  });
  assert.ok(result.leftPct > result.rightPct);
  assert.ok(result.rightEndMcap > result.leftEndMcap);
  assert.equal(result.mwlWinnerToken, TOKEN_A);
  assert.equal(result.moneyWinnerToken, TOKEN_A);
  assert.equal(result.moneyTieBreak, MONEY_TIE_BREAK.PERFORMANCE);
});

test("Solana token-address tie-break is case-sensitive", () => {
  const lower = "tokenaaa1111111111111111111111111111111111";
  const upper = "TokenAaa1111111111111111111111111111111111";
  assert.notEqual(compareTokenIdentity(lower, upper), 0);
  const money = moneyWinner({
    leftToken: upper,
    rightToken: lower,
    leftPct: 0,
    rightPct: 0,
    leftEndMcap: 10,
    rightEndMcap: 10,
  });
  assert.equal(money.moneyTieBreak, MONEY_TIE_BREAK.TOKEN_ADDRESS);
  assert.equal(money.moneyWinnerToken, lower > upper ? lower : upper);
});

test("mwlLedgerPlan never awards MWL points from a money winner on a draw", () => {
  const trap = battlePointPlan({ winner: TOKEN_A, left: TOKEN_A, right: TOKEN_B });
  assert.equal(trap.left.points, WIN_POINTS);
  const honest = mwlLedgerPlan({
    mwlDraw: true,
    mwlWinnerToken: TOKEN_A,
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
  });
  assert.equal(honest.left.points, DRAW_POINTS);
  assert.equal(honest.right.points, DRAW_POINTS);
  assert.equal(honest.left.kind, "battle_draw");
});

test("pair scoring lock key is season plus canonical pair key", () => {
  const key = pairKey(TOKEN_A, TOKEN_B);
  assert.equal(pairScoringLockKey("mwl-2026-q3-c101", key), `mwl-2026-q3-c101:${key}`);
});

test("EVM pair keys ignore 0x casing; Solana pair keys preserve base58 case", () => {
  const evmA = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
  const evmB = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
  assert.equal(pairKey(evmA, evmB), pairKey(evmA.toLowerCase(), `0x${evmB.slice(2).toUpperCase()}`));
  assert.equal(pairKey(evmA, evmB), pairKey(evmB, evmA));

  const solA = "So11111111111111111111111111111111111111112";
  const solB = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  assert.equal(pairKey(solA, solB), pairKey(solB, solA));
  assert.notEqual(pairKey(solA, solB), pairKey(solA.toLowerCase(), solB));
});

test("missing battle chain_id is an explicit fail-closed reason", () => {
  assert.equal(requireBattleChainId({}).reason, MISSING_BATTLE_CHAIN_ID);
  assert.equal(requireBattleChainId({ chain_id: 0 }).ok, false);
  assert.equal(requireBattleChainId({ chainId: 56 }).ok, true);
  assert.equal(requireBattleChainId({ chain_id: "101" }).chainId, 101);
});

test("7-day rematch adds no second MWL points but still counts the fight", () => {
  assert.equal(REMATCH_FIGHT_POLICY, "count_fight_skip_points");
  assert.equal(pairPointsEligible({ pairAlreadyScored: true }).eligible, false);
  const rematch = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 140,
    rightEndMcap: 90,
    pairAlreadyScored: true,
  });
  assert.equal(rematch.mwlResult, MWL_RESULT.LEFT_WIN);
  assert.equal(rematch.moneyWinnerToken, TOKEN_A);
  assert.equal(rematch.ledger.skipPoints, true);
  assert.equal(rematch.ledger.countFight, true);
  assert.equal(rematch.ledger.left.points, 0);
  assert.equal(rematch.ledger.right.points, 0);
  assert.equal(rematch.ledger.left.kind, null);
});

test("pure settle is deterministic: rerunning the same snapshot returns the same result", () => {
  const input = {
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 80,
    rightStartMcap: 80,
    leftEndMcap: 80,
    rightEndMcap: 96,
  };
  assert.deepEqual(settleBattleResult(input), settleBattleResult(input));
});

test("QF and frozen seasons skip both points and fight counts", () => {
  const qf = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 150,
    rightEndMcap: 100,
    isQuarterFinals: true,
  });
  assert.equal(qf.ledger.skipPoints, true);
  assert.equal(qf.ledger.countFight, false);
  const frozen = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 150,
    rightEndMcap: 100,
    frozen: true,
  });
  assert.equal(frozen.ledger.skipPoints, true);
  assert.equal(frozen.ledger.countFight, false);
});

test("non-QF tournament win adds +2 on the battle win only", () => {
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 100,
    rightStartMcap: 100,
    leftEndMcap: 150,
    rightEndMcap: 100,
    isTournament: true,
  });
  assert.equal(result.ledger.left.points, WIN_POINTS + TOURNAMENT_WIN_BONUS);
  assert.equal(result.ledger.right.points, LOSS_POINTS);
});

test("equal proportional performance is an MWL draw (300→330 vs 900→990)", () => {
  const result = settleBattleResult({
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 300,
    rightStartMcap: 900,
    leftEndMcap: 330,
    rightEndMcap: 990,
  });
  assert.equal(result.ok, true);
  assert.equal(result.leftPct, result.rightPct);
  assert.equal(result.mwlResult, MWL_RESULT.DRAW);
  assert.equal(result.mwlDraw, true);
  assert.equal(result.mwlWinnerToken, null);
  assert.equal(result.ledger.left.points, DRAW_POINTS);
  assert.equal(result.ledger.right.points, DRAW_POINTS);
  assert.equal(result.moneyWinnerToken, TOKEN_B);
  assert.equal(result.moneyTieBreak, MONEY_TIE_BREAK.ENDING_MCAP);
});

test("invalid or missing market-cap snapshots fail closed with no MWL or money winner", () => {
  function assertInvalid(result) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, INVALID_MARKET_CAP_SNAPSHOT);
    assert.equal(result.mwlResult, null);
    assert.equal(result.mwlDraw, null);
    assert.equal(result.mwlWinnerToken, null);
    assert.equal(result.moneyWinnerToken, null);
    assert.equal(result.moneyTieBreak, null);
    assert.equal(result.ledger, null);
  }
  const base = {
    leftToken: TOKEN_A,
    rightToken: TOKEN_B,
    leftStartMcap: 10000,
    rightStartMcap: 10000,
    leftEndMcap: 20000,
    rightEndMcap: 15000,
  };
  assertInvalid(settleBattleResult({ ...base, leftStartMcap: undefined }));
  assertInvalid(settleBattleResult({ ...base, leftStartMcap: 0 }));
  assertInvalid(settleBattleResult({ ...base, leftStartMcap: NaN }));
  assertInvalid(settleBattleResult({ ...base, leftStartMcap: "nope" }));
  assertInvalid(settleBattleResult({ ...base, leftEndMcap: undefined }));
  assertInvalid(settleBattleResult({ ...base, leftEndMcap: NaN }));
  assertInvalid(settleBattleResult({ ...base, rightEndMcap: "x" }));
  assertInvalid(settleBattleResult({ ...base, leftStartMcap: -1 }));
  assertInvalid(settleBattleResult({ ...base, rightEndMcap: -5 }));
  const valid = settleBattleResult(base);
  assert.equal(valid.ok, true);
  assert.notEqual(valid.mwlResult, null);
  assert.notEqual(valid.moneyWinnerToken, null);
});

test("MWL score math cannot mint points from UpVotes", () => {
  const math = fs.readFileSync(path.join(here, "arenaLeagueScoreMath.js"), "utf8");
  const writer = fs.readFileSync(path.join(here, "arenaLeagueScore.js"), "utf8");
  assert.doesNotMatch(math, /upvote/i);
  assert.doesNotMatch(writer, /upvote/i);
  assert.doesNotMatch(writer, /arena_votes/);
  assert.match(writer, /mwlLedgerPlan/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  decideVoteBattleSettlement,
  decorateVoteBattleParticipants,
  settleVoteBattle,
} from "./arenaVoteBattleSettlement.js";

const tokenA = "So11111111111111111111111111111111111111112";
const tokenB = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("more points wins: money and MWL winner are the same token, no draw", () => {
  const decision = decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 5, rightPoints: 3 });
  assert.equal(decision.ok, true);
  assert.equal(decision.winnerSide, "left");
  assert.equal(decision.moneyWinnerToken, tokenA);
  assert.equal(decision.mwlWinnerToken, tokenA);
  assert.equal(decision.mwlResult, "left_win");
  assert.equal(decision.mwlDraw, false);
  assert.equal(decision.moneyTieBreak, null);
  assert.equal(decision.tieBreakUsed, false);
  assert.equal(decision.settlementVersion, 4);
  assert.equal(decision.settlementScoringVersion, "vote_tournament_v1");

  const right = decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 0, rightPoints: 1 });
  assert.equal(right.winnerSide, "right");
  assert.equal(right.mwlResult, "right_win");
  assert.equal(right.moneyWinnerToken, tokenB);
});

test("a tie is not decided here; Final Salvo supplies the side", () => {
  assert.deepEqual(decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 2, rightPoints: 2 }), { ok: false, reason: "tied" });
  const salvo = decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 2, rightPoints: 2, winnerSide: "right", tieBreakUsed: true });
  assert.equal(salvo.ok, true);
  assert.equal(salvo.winnerSide, "right");
  assert.equal(salvo.tieBreakUsed, true);
  assert.equal(decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 3, rightPoints: 1, winnerSide: "right" }).reason, "winner_side_contradicts_points");
  assert.equal(decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenA, leftPoints: 1, rightPoints: 0 }).reason, "invalid_tokens");
  assert.equal(decideVoteBattleSettlement({ leftToken: "", rightToken: tokenB, leftPoints: 1, rightPoints: 0 }).reason, "invalid_tokens");
});

test("participants carry their vote points and the leader flag", () => {
  const decision = decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 5, rightPoints: 3 });
  const parts = decorateVoteBattleParticipants([{ tokenId: tokenA, symbol: "A" }, { tokenId: tokenB, symbol: "B" }], decision);
  assert.deepEqual(parts, [
    { tokenId: tokenA, symbol: "A", votePoints: 5, isLeading: true },
    { tokenId: tokenB, symbol: "B", votePoints: 3, isLeading: false },
  ]);
});

test("settlement write targets a live row and records league + notification", async () => {
  const calls = [];
  const finishedRow = {
    id: "arena-vote-1", chain_id: 101, state: "finished", source: "queue", battle_mode: "vote",
    challenger_token: tokenA, defender_token: tokenB, tournament_id: null,
    money_winner_token: tokenA, mwl_result: "left_win", settlement_version: 4,
  };
  const client = { query: async (text, params) => { calls.push({ text, params }); return { rows: [finishedRow] }; } };
  const decision = decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 5, rightPoints: 3 });
  const recorded = [];
  const notified = [];
  const finished = await settleVoteBattle(
    client,
    { id: "arena-vote-1", participants: [{ tokenId: tokenA }, { tokenId: tokenB }] },
    decision,
    "2026-09-21T16:00:00.000Z",
    {
      battleLeagueEligibility: () => ({ eligible: true, reason: "ranked_queue" }),
      recordFinishedBattle: async (row, db) => { recorded.push({ row, db }); return { scored: true }; },
      notifyBattleWinnerConfirmed: async (db, row) => { notified.push({ db, row }); return true; },
    },
  );
  assert.equal(finished, finishedRow);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /update public\.arena_battles set/);
  assert.match(calls[0].text, /state = 'finished', winner_token = \$2, money_winner_token = \$2, money_tie_break = null/);
  assert.match(calls[0].text, /mwl_result = \$3, mwl_draw = false, mwl_winner_token = \$2/);
  assert.match(calls[0].text, /where id = \$1 and state = 'live'/);
  assert.doesNotMatch(calls[0].text, /challenger_battle_points/);
  assert.deepEqual(calls[0].params.slice(0, 8), ["arena-vote-1", tokenA, "left_win", 4, "vote_tournament_v1", "arena_competition_v2", false, "2026-09-21T16:00:00.000Z"]);
  assert.deepEqual(JSON.parse(calls[0].params[8]), [
    { tokenId: tokenA, votePoints: 5, isLeading: true },
    { tokenId: tokenB, votePoints: 3, isLeading: false },
  ]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].db, client);
  assert.equal(recorded[0].row.mwlWinnerToken, tokenA);
  assert.equal(recorded[0].row.mwlResult, "left_win");
  assert.equal(recorded[0].row.mwlDraw, false);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].row, finishedRow);
});

test("settlement returns null on a lost race and never records the league", async () => {
  const client = { query: async () => ({ rows: [] }) };
  const decision = decideVoteBattleSettlement({ leftToken: tokenA, rightToken: tokenB, leftPoints: 1, rightPoints: 0 });
  let recorded = 0;
  const finished = await settleVoteBattle(client, { id: "x", participants: [] }, decision, "2026-09-21T16:00:00.000Z", {
    recordFinishedBattle: async () => { recorded += 1; },
    notifyBattleWinnerConfirmed: async () => { recorded += 1; },
  });
  assert.equal(finished, null);
  assert.equal(recorded, 0);
  await assert.rejects(() => settleVoteBattle(client, { id: "x" }, { ok: false, reason: "tied" }, "now"), /vote-battle-settlement-invalid:tied/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  listVoteBattleVotes,
  loadVoteBattle,
  recordVoteBattleFreeVote,
  voteBattleAvailability,
  voteBattleMatch,
  voteBattlePayload,
  voteBattleScore,
  walletVoteToken,
} from "./arenaBattleVoteRuntime.js";

const tokenA = "So11111111111111111111111111111111111111112";
const tokenB = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function battle(overrides = {}) {
  return {
    id: "arena-vote-1",
    chain_id: 101,
    state: "live",
    source: "queue",
    battle_mode: "vote",
    tournament_id: null,
    challenger_token: tokenA,
    defender_token: tokenB,
    participants: [{ tokenId: tokenA }, { tokenId: tokenB }],
    started_at: "2026-09-21T10:00:00Z",
    ends_at: "2026-09-21T16:00:00Z",
    duration_hours: 6,
    contest_scoring_version: "vote_tournament_v1",
    competition_generation: "arena_competition_v2",
    ...overrides,
  };
}

function fakeQuery(responses = []) {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    const next = responses.shift();
    return typeof next === "function" ? next(text, params) : next || { rows: [] };
  };
  return { query, calls };
}

test("matchup is the battle itself: match_id = battle id, round 1", () => {
  assert.deepEqual(voteBattleMatch(battle()), {
    battleId: "arena-vote-1",
    matchId: "arena-vote-1",
    roundNumber: 1,
    tokenA,
    tokenB,
  });
});

test("availability: only a live standalone vote battle inside regulation", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  assert.equal(voteBattleAvailability(battle(), { nowMs: now }).ok, true);
  assert.equal(voteBattleAvailability(null).code, "BATTLE_NOT_FOUND");
  assert.equal(voteBattleAvailability(battle({ battle_mode: "normal" }), { nowMs: now }).code, "BATTLE_NOT_VOTE_MODE");
  assert.equal(voteBattleAvailability(battle({ source: "tournament" }), { nowMs: now }).code, "BATTLE_NOT_VOTE_MODE");
  assert.equal(voteBattleAvailability(battle({ competition_generation: "arena_competition_v1" }), { nowMs: now }).code, "BATTLE_NOT_V2");
  assert.equal(voteBattleAvailability(battle({ defender_token: null }), { nowMs: now }).code, "VOTE_BATTLE_NOT_LIVE");
  assert.equal(voteBattleAvailability(battle({ state: "matched" }), { nowMs: now }).code, "VOTE_BATTLE_NOT_LIVE");
  assert.equal(voteBattleAvailability(battle(), { nowMs: Date.parse("2026-09-21T16:00:00Z") }).code, "VOTE_BATTLE_REGULATION_ENDED");
  assert.equal(voteBattleAvailability(battle(), { nowMs: now, tiebreak: { battle_id: "arena-vote-1", state: "salvo" } }).code, "FINAL_SALVO_ACTIVE");
});

test("free vote insert binds tournament_id null, match_id = battle id, round 1, 1 point", async () => {
  const { query, calls } = fakeQuery([{ rows: [{ id: 7, side: "left", created_at: "2026-09-21T12:00:00Z" }] }]);
  const result = await recordVoteBattleFreeVote(query, battle(), { wallet: "wallet-1", side: "left" });
  assert.equal(result.inserted.id, 7);
  assert.equal(result.existingSide, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /insert into public\.arena_contest_actions/);
  assert.match(calls[0].text, /values \(\$1,null,\$2,\$3,\$4,'regulation',null,\$5,\$6,'free_vote',0,\$7,0,0,0,now\(\)\)/);
  assert.match(calls[0].text, /on conflict do nothing/);
  assert.deepEqual(calls[0].params, [101, "arena-vote-1", "arena-vote-1", 1, "left", "wallet-1", 1]);
});

test("second free vote from the same wallet reports the side already used", async () => {
  const { query, calls } = fakeQuery([{ rows: [] }, { rows: [{ side: "right" }] }]);
  const result = await recordVoteBattleFreeVote(query, battle(), { wallet: "wallet-1", side: "left" });
  assert.equal(result.inserted, null);
  assert.equal(result.existingSide, "right");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, ["arena-vote-1", 1, "arena-vote-1", "wallet-1", 101]);
});

test("vote listing and score read only this battle's regulation actions", async () => {
  const { query, calls } = fakeQuery([
    { rows: [{ side: "left", wallet: "w1" }, { side: "left", wallet: "w2" }, { side: "right", wallet: "w3" }] },
    { rows: [{ side: "left", points: "6" }, { side: "right", points: "1" }] },
  ]);
  const rows = await listVoteBattleVotes(query, battle());
  const score = await voteBattleScore(query, battle());
  assert.equal(rows.length, 3);
  assert.match(calls[0].text, /tournament_id is null/);
  assert.match(calls[0].text, /action_type = 'free_vote'/);
  assert.deepEqual(calls[0].params, ["arena-vote-1", 1, "arena-vote-1", 101]);
  assert.match(calls[1].text, /confirmed_at is not null/);
  assert.deepEqual(calls[1].params, ["arena-vote-1", 1]);
  assert.deepEqual(score, { leftPoints: 6, rightPoints: 1 });

  const payload = voteBattlePayload({
    battle: battle(),
    rows,
    score,
    walletVote: walletVoteToken(rows, "w3", voteBattleMatch(battle())),
    nowIso: "2026-09-21T12:00:00Z",
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.battleMode, "vote");
  assert.equal(payload.roundNumber, 1);
  assert.equal(payload.matchId, "arena-vote-1");
  assert.equal(payload.freeVotePoints, 1);
  assert.equal(payload.boostPointsPerUsd, 2);
  assert.equal(payload.durationHours, 6);
  assert.equal(payload.regulationEndsAt, "2026-09-21T16:00:00Z");
  assert.deepEqual(payload.summary, { tokenA, tokenB, leftVotes: 2, rightVotes: 1, totalVotes: 3, leftPoints: 2, rightPoints: 1 });
  assert.deepEqual(payload.score, { leftPoints: 6, rightPoints: 1 });
  assert.equal(payload.walletVote, tokenB);
});

test("loadVoteBattle selects the scoring columns and can lock the row", async () => {
  const { query, calls } = fakeQuery([{ rows: [battle()] }, { rows: [] }]);
  const row = await loadVoteBattle(query, "arena-vote-1", { forUpdate: true });
  assert.equal(row.id, "arena-vote-1");
  assert.match(calls[0].text, /battle_mode/);
  assert.match(calls[0].text, /contest_scoring_version, competition_generation/);
  assert.match(calls[0].text, /for update$/);
  assert.equal(await loadVoteBattle(query, "missing"), null);
  assert.doesNotMatch(calls[1].text, /for update/);
});

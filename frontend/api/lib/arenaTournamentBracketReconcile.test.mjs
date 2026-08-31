import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  planTournamentBracketReconcile,
  tokensEqual,
  unorderedPairKey,
} from "./arenaTournamentBracketReconcile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const TOKEN_C = "0x3333333333333333333333333333333333333333";
const TOKEN_D = "0x4444444444444444444444444444444444444444";
const SOL_A = "So11111111111111111111111111111111111111112";
const SOL_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOURNAMENT_ID = "tourney-1";
const BATTLE_ID = "arena-final-1";

function match(overrides = {}) {
  return {
    id: "m1",
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
    battleId: BATTLE_ID,
    winner: null,
    bye: false,
    ...overrides,
  };
}

function bracket(rounds) {
  return { rounds };
}

function tournament(overrides = {}) {
  return {
    id: TOURNAMENT_ID,
    status: "live",
    chain_id: 101,
    winner_token: null,
    bracket: bracket([{ round: 1, matches: [match()] }]),
    ...overrides,
  };
}

function battle(overrides = {}) {
  return {
    id: BATTLE_ID,
    tournament_id: TOURNAMENT_ID,
    source: "tournament",
    state: "finished",
    chain_id: 101,
    challenger_token: TOKEN_A,
    defender_token: TOKEN_B,
    money_winner_token: TOKEN_A,
    mwl_winner_token: TOKEN_B,
    mwl_draw: false,
    winner_token: TOKEN_A,
    ...overrides,
  };
}

function orphan(overrides = {}) {
  return {
    id: "arena-orphan-1",
    tournament_id: TOURNAMENT_ID,
    source: "tournament",
    state: "live",
    chain_id: 101,
    challenger_token: TOKEN_A,
    defender_token: TOKEN_C,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("Solana pair matching is case-sensitive; EVM is not", () => {
  const evmMixed = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
  assert.equal(tokensEqual(evmMixed, evmMixed.toLowerCase()), true);
  assert.equal(tokensEqual(SOL_A, SOL_A.slice(0, 2).toLowerCase() + SOL_A.slice(2)), false);
  assert.notEqual(unorderedPairKey(SOL_A, SOL_B), unorderedPairKey(SOL_A.toLowerCase(), SOL_B));
});

test("live or unfinished battles cannot reconcile", () => {
  assert.equal(planTournamentBracketReconcile({ tournament: tournament(), battle: battle({ state: "live" }) }).reason, "battle-not-finished");
  assert.equal(planTournamentBracketReconcile({ tournament: tournament(), battle: battle({ source: "queue" }) }).reason, "not-tournament-battle");
  assert.equal(planTournamentBracketReconcile({ tournament: tournament(), battle: battle({ money_winner_token: "" }) }).reason, "missing-money-winner");
  assert.equal(
    planTournamentBracketReconcile({
      tournament: tournament(),
      battle: battle({ money_winner_token: TOKEN_C, winner_token: TOKEN_C, mwl_winner_token: TOKEN_A }),
    }).reason,
    "money-winner-not-in-battle",
  );
});

test("upcoming or cancelled tournaments block; finished mismatch blocks; matching finished skips", () => {
  assert.equal(planTournamentBracketReconcile({ tournament: tournament({ status: "upcoming" }), battle: battle() }).reason, "tournament-not-live");
  assert.equal(planTournamentBracketReconcile({ tournament: tournament({ status: "cancelled" }), battle: battle() }).reason, "tournament-not-live");
  assert.equal(
    planTournamentBracketReconcile({
      tournament: tournament({ status: "finished", winner_token: TOKEN_B }),
      battle: battle(),
    }).reason,
    "finished-winner-mismatch",
  );
  const skip = planTournamentBracketReconcile({
    tournament: tournament({ status: "finished", winner_token: TOKEN_A }),
    battle: battle(),
  });
  assert.equal(skip.action, "skip");
  assert.equal(skip.reason, "already-finished");
  assert.equal(skip.battlesToInsert.length, 0);
});

test("invalid bracket, missing match, and different persisted match winner block", () => {
  assert.equal(planTournamentBracketReconcile({ tournament: tournament({ bracket: [] }), battle: battle() }).reason, "invalid-bracket");
  assert.equal(planTournamentBracketReconcile({ tournament: tournament({ bracket: { rounds: [] } }), battle: battle() }).reason, "battle-not-in-bracket");
  assert.equal(
    planTournamentBracketReconcile({
      tournament: tournament({ bracket: bracket([{ round: 1, matches: [match({ winner: TOKEN_B })] }]) }),
      battle: battle(),
    }).reason,
    "match-winner-mismatch",
  );
});

test("MWL isolation: stamp money_winner_token even when mwl_draw and mwl winner differ", () => {
  const planned = planTournamentBracketReconcile({
    tournament: tournament(),
    battle: battle({ mwl_draw: true, mwl_winner_token: TOKEN_B, money_winner_token: TOKEN_A }),
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.action, "apply");
  assert.equal(planned.matchWinner, TOKEN_A);
  assert.equal(planned.nextBracket.rounds[0].matches[0].winner, TOKEN_A);
  assert.equal(planned.finished, true);
  assert.equal(planned.winner, TOKEN_A);
  assert.equal(planned.battlesToInsert.length, 0);
});

test("stamp missing winner on an incomplete last round and do not insert", () => {
  const planned = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([{
        round: 1,
        matches: [match(), match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: null })],
      }]),
    }),
    battle: battle(),
  });
  assert.equal(planned.action, "apply");
  assert.equal(planned.nextBracket.rounds[0].matches[0].winner, TOKEN_A);
  assert.equal(planned.nextBracket.rounds[0].matches[1].winner, null);
  assert.equal(planned.nextBracket.rounds.length, 1);
  assert.equal(planned.battlesToInsert.length, 0);
});

test("already-recorded winner on an incomplete last round skips without inserts", () => {
  const skip = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([{
        round: 1,
        matches: [
          match({ winner: TOKEN_A }),
          match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: null }),
        ],
      }]),
    }),
    battle: battle(),
  });
  assert.equal(skip.action, "skip");
  assert.equal(skip.reason, "match-already-recorded");
  assert.equal(skip.battlesToInsert.length, 0);
  assert.equal(skip.nextBracket, null);
});

test("existing next round is frozen; missing earlier stamp is applied only", () => {
  const round2 = {
    round: 2,
    matches: [{ id: "r2-m1", tokenA: TOKEN_A, tokenB: TOKEN_C, battleId: "arena-final-2", winner: null, bye: false }],
  };
  const planned = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([
        { round: 1, matches: [match({ winner: null }), match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: TOKEN_C })] },
        round2,
      ]),
    }),
    battle: battle(),
  });
  assert.equal(planned.action, "apply");
  assert.equal(planned.nextBracket.rounds[0].matches[0].winner, TOKEN_A);
  assert.deepEqual(planned.nextBracket.rounds[1], round2);
  assert.equal(planned.battlesToInsert.length, 0);
});

test("already-recorded winner with a later round present skips", () => {
  const skip = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([
        { round: 1, matches: [match({ winner: TOKEN_A }), match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: TOKEN_C })] },
        { round: 2, matches: [{ id: "r2-m1", tokenA: TOKEN_A, tokenB: TOKEN_C, battleId: "arena-final-2", winner: null, bye: false }] },
      ]),
    }),
    battle: battle(),
  });
  assert.equal(skip.action, "skip");
  assert.equal(skip.reason, "already-advanced");
  assert.equal(skip.battlesToInsert.length, 0);
});

test("complete last round reuses the oldest unused tournament-scoped orphan and does not insert", () => {
  const planned = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([{
        round: 1,
        matches: [
          match({ winner: null }),
          match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: TOKEN_C }),
        ],
      }]),
    }),
    battle: battle(),
    existingBattles: [
      orphan({ id: "arena-newer", created_at: "2026-08-02T00:00:00.000Z", challenger_token: TOKEN_C, defender_token: TOKEN_A }),
      orphan({ id: "arena-older", created_at: "2026-08-01T00:00:00.000Z", challenger_token: TOKEN_A, defender_token: TOKEN_C }),
      orphan({ id: "arena-other-tourney", tournament_id: "tourney-2", created_at: "2026-07-01T00:00:00.000Z", challenger_token: TOKEN_A, defender_token: TOKEN_C }),
      orphan({ id: "arena-attached", challenger_token: TOKEN_C, defender_token: TOKEN_D, id: "arena-other" }),
    ],
  });
  assert.equal(planned.action, "apply");
  assert.deepEqual(planned.battlesToInsert, []);
  assert.deepEqual(planned.battlesToAttach, [{ tokenA: TOKEN_A, tokenB: TOKEN_C, battleId: "arena-older" }]);
  assert.equal(planned.nextBracket.rounds[1].matches[0].battleId, "arena-older");
  assert.equal(planned.finished, false);
});

test("missing orphan inserts exactly one next-round pair; second call after persist skips", () => {
  const first = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([{
        round: 1,
        matches: [
          match({ winner: TOKEN_A }),
          match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: TOKEN_C }),
        ],
      }]),
    }),
    battle: battle(),
    existingBattles: [],
  });
  assert.equal(first.action, "apply");
  assert.deepEqual(first.battlesToInsert, [{ tokenA: TOKEN_A, tokenB: TOKEN_C }]);
  assert.equal(first.battlesToAttach.length, 0);

  const second = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: first.nextBracket,
    }),
    battle: battle(),
    existingBattles: [{ id: "arena-new", tournament_id: TOURNAMENT_ID, source: "tournament", chain_id: 101, challenger_token: TOKEN_A, defender_token: TOKEN_C, created_at: "2026-08-03T00:00:00.000Z" }],
  });
  assert.equal(second.action, "skip");
  assert.equal(second.reason, "already-advanced");
  assert.equal(second.battlesToInsert.length, 0);
});

test("odd leftover from a completed last round creates a bye and does not finish", () => {
  const planned = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([{
        round: 1,
        matches: [
          match({ winner: null }),
          match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: TOKEN_C }),
          match({ id: "m3", tokenA: "0x5555555555555555555555555555555555555555", tokenB: null, battleId: null, winner: "0x5555555555555555555555555555555555555555", bye: true }),
        ],
      }]),
    }),
    battle: battle(),
  });
  assert.equal(planned.action, "apply");
  assert.equal(planned.finished, false);
  assert.equal(planned.nextBracket.rounds[1].matches.length, 2);
  assert.equal(planned.nextBracket.rounds[1].matches[1].bye, true);
  assert.deepEqual(planned.battlesToInsert, [{ tokenA: TOKEN_A, tokenB: TOKEN_C }]);
});

test("foreign-tournament or already-attached rows are not reusable", () => {
  const planned = planTournamentBracketReconcile({
    tournament: tournament({
      bracket: bracket([{
        round: 1,
        matches: [
          match({ winner: TOKEN_A }),
          match({ id: "m2", tokenA: TOKEN_C, tokenB: TOKEN_D, battleId: "arena-other", winner: TOKEN_C }),
        ],
      }]),
    }),
    battle: battle(),
    existingBattles: [
      orphan({ id: "arena-other", challenger_token: TOKEN_A, defender_token: TOKEN_C }),
      orphan({ tournament_id: "elsewhere", id: "arena-foreign", challenger_token: TOKEN_A, defender_token: TOKEN_C }),
    ],
  });
  assert.deepEqual(planned.battlesToAttach, []);
  assert.deepEqual(planned.battlesToInsert, [{ tokenA: TOKEN_A, tokenB: TOKEN_C }]);
});

test("planner and apply sources never rescore MWL, resettle, or send the pot", () => {
  const helper = fs.readFileSync(path.join(here, "arenaTournamentBracketReconcile.js"), "utf8");
  const api = fs.readFileSync(path.join(here, "../arenaTournaments.js"), "utf8");
  const battles = fs.readFileSync(path.join(here, "../arenaBattles.js"), "utf8");
  const netlify = fs.readFileSync(path.join(here, "../../netlify/functions/api.mjs"), "utf8");
  for (const source of [helper, api.split("export async function reconcileTournamentBracket")[1] || ""]) {
    assert.doesNotMatch(source, /recordFinishedBattle/);
    assert.doesNotMatch(source, /settleLive/);
    assert.doesNotMatch(source, /mwlLedgerPlan/);
    assert.doesNotMatch(source, /planTournamentResolve/);
    assert.doesNotMatch(source, /hydrateLifecycle/);
  }
  assert.match(helper, /money_winner_token/);
  assert.doesNotMatch(helper, /battle\?\.winner_token/);
  assert.doesNotMatch(helper, /mwl_winner_token/);
  const settle = battles.split("async function settleLive")[1]?.split("async function expireChallenge")[0] || "";
  assert.match(settle, /advanceTournamentFromBattle/);
  assert.doesNotMatch(settle, /reconcileTournamentBracket/);
  const apply = api.split("export async function reconcileTournamentBracket")[1]?.split("export default async function handler")[0] || "";
  assert.ok(apply.indexOf("for update") < apply.indexOf("planTournamentBracketReconcile"));
  assert.ok(apply.indexOf("begin") < apply.indexOf("for update"));
  assert.match(apply, /money_winner_token/);
  assert.match(api, /requireAdminOrOps/);
  assert.match(api, /reconcile-bracket/);
  assert.match(netlify, /admin\/arena\/tournaments\/:id\/reconcile-bracket/);
  const insert = api.split("async function insertTournamentBattle")[1]?.split("async function handleAdminStart")[0] || "";
  assert.match(insert, /'live'/);
  assert.match(insert, /'tournament'/);
});

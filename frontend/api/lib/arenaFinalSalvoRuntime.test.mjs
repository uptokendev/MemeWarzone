import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FINAL_SALVO_CHAIN_IDS,
  FINAL_SALVO_MAX_SHOTS,
  FINAL_SALVO_SHOT_SECONDS,
  beginFinalSalvo,
  closeFinalSalvoShot,
  finalSalvoEntryDecision,
  finalSalvoIdentityMatches,
  finalSalvoShotWinner,
  requiredFinalSalvoChainId,
  shouldResolveSalvoEarly,
} from "./arenaFinalSalvoRuntime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const endpointSource = fs.readFileSync(path.join(apiDir, "arenaFinalSalvo.js"), "utf8");
const finalizerSource = fs.readFileSync(path.join(here, "arenaFinalSalvoFinalizer.js"), "utf8");
const migrationSource = fs.readFileSync(path.join(repoRoot, "db", "migrations", "20260909_000001_arena_final_salvo_identity.sql"), "utf8");
const foundationSource = fs.readFileSync(path.join(repoRoot, "db", "migrations", "20260903_000104_arena_vote_boost_sponsorship_v1_foundation.sql"), "utf8");

const BNB = 56;
const SOLANA = 101;
const ROBINHOOD = 4663;
const t0 = new Date("2026-09-09T00:00:00.000Z");

function started() {
  const result = beginFinalSalvo({ regulationLeftPoints: 7, regulationRightPoints: 7, now: t0 });
  assert.equal(result.ok, true);
  return result;
}

test("STEP 1: Final Salvo supports exactly BNB, Solana and Robinhood production identities", () => {
  assert.deepEqual(FINAL_SALVO_CHAIN_IDS, [BNB, SOLANA, ROBINHOOD]);
  for (const chainId of FINAL_SALVO_CHAIN_IDS) assert.equal(requiredFinalSalvoChainId(chainId), chainId);
  for (const chainId of [97, 102, 46630, 1, 0, -1, "wrong"]) assert.throws(() => requiredFinalSalvoChainId(chainId), /Unsupported Final Salvo chain id/);
});

test("STEP 1: regulation must be ended and exactly tied", () => {
  assert.deepEqual(finalSalvoEntryDecision({ battleEndsAt: new Date(t0.getTime() + 1_000), now: t0, regulationLeftPoints: 7, regulationRightPoints: 7 }), { ok: false, reason: "regulation-active" });
  assert.deepEqual(finalSalvoEntryDecision({ battleEndsAt: new Date(t0.getTime() - 1_000), now: t0, regulationLeftPoints: 8, regulationRightPoints: 7 }), { ok: false, reason: "regulation-not-tied" });
  assert.deepEqual(finalSalvoEntryDecision({ battleEndsAt: new Date(t0.getTime() - 1_000), now: t0, regulationLeftPoints: 7, regulationRightPoints: 7 }), { ok: true, reason: "exact-regulation-tie", leftPoints: 7, rightPoints: 7 });
});

test("STEP 1: chain+tournament+matchup+round identity fails closed", () => {
  const row = { chain_id: BNB, tournament_id: "vote-1", battle_id: "battle-1", match_id: "match-1", round_number: 2 };
  const expected = { chainId: BNB, tournamentId: "vote-1", battleId: "battle-1", matchId: "match-1", roundNumber: 2 };
  assert.equal(finalSalvoIdentityMatches(row, expected), true);
  for (const change of [{ chainId: SOLANA }, { chainId: ROBINHOOD }, { tournamentId: "vote-2" }, { battleId: "battle-2" }, { matchId: "match-2" }, { roundNumber: 3 }]) {
    assert.equal(finalSalvoIdentityMatches(row, { ...expected, ...change }), false);
  }
});

test("STEP 2: Final Salvo starts only on an exact tie and opens shot one for 60 seconds", () => {
  assert.deepEqual(beginFinalSalvo({ regulationLeftPoints: 2, regulationRightPoints: 1, now: t0 }), { ok: false, reason: "regulation-not-tied" });
  const state = started();
  assert.equal(FINAL_SALVO_MAX_SHOTS, 5);
  assert.equal(FINAL_SALVO_SHOT_SECONDS, 60);
  assert.equal(state.state, "salvo");
  assert.equal(state.currentSalvoIndex, 1);
  assert.equal(new Date(state.shotEndsAt).getTime() - new Date(state.shotStartedAt).getTime(), 60_000);
});

test("STEP 2: tied shot gives no series point and advances to another 60 second shot", () => {
  const next = closeFinalSalvoShot({ tiebreak: started(), leftUnique: 4, rightUnique: 4, now: new Date(t0.getTime() + 60_000) });
  assert.equal(next.state, "salvo");
  assert.equal(next.currentSalvoIndex, 2);
  assert.equal(next.leftSalvoPoints, 0);
  assert.equal(next.rightSalvoPoints, 0);
  assert.equal(next.shotHistory[0].winnerSide, null);
  assert.equal(new Date(next.shotEndsAt).getTime() - new Date(next.shotStartedAt).getTime(), 60_000);
});

test("STEP 2: persistence allows free vote only in Salvo and one vote per wallet per shot", () => {
  assert.match(foundationSource, /action_type = 'boost' AND phase = 'regulation'/);
  assert.match(foundationSource, /arena_contest_actions_salvo_free_vote_uidx[\s\S]*salvo_index,[\s\S]*wallet[\s\S]*phase IN \('salvo', 'sudden_death'\)/);
  assert.match(endpointSource, /'free_vote',0,1,0,0,0,now\(\)/);
  assert.doesNotMatch(endpointSource, /marketCap|holderCount|volumeUsd/);
});

test("STEP 3: best of five may resolve mathematically early", () => {
  let state = started();
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 5, rightUnique: 2, now: new Date(t0.getTime() + 60_000) });
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 7, rightUnique: 1, now: new Date(t0.getTime() + 120_000) });
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 3, rightUnique: 0, now: new Date(t0.getTime() + 180_000) });
  assert.equal(state.state, "resolved");
  assert.equal(state.winnerSide, "left");
  assert.equal(shouldResolveSalvoEarly({ shotIndex: 3, leftWins: 3, rightWins: 0 }), "left");
});

test("STEP 3: five shots tied overall enter repeated sudden death until a winner exists", () => {
  let state = started();
  const outcomes = [[3, 1], [1, 2], [4, 4], [5, 3], [1, 2]];
  outcomes.forEach(([left, right], index) => {
    state = closeFinalSalvoShot({ tiebreak: state, leftUnique: left, rightUnique: right, now: new Date(t0.getTime() + (index + 1) * 60_000) });
  });
  assert.equal(state.state, "sudden_death");
  assert.equal(state.leftSalvoPoints, 2);
  assert.equal(state.rightSalvoPoints, 2);
  assert.equal(state.suddenDeathRound, 1);
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 9, rightUnique: 9, now: new Date(t0.getTime() + 360_000) });
  assert.equal(state.state, "sudden_death");
  assert.equal(state.suddenDeathRound, 2);
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 10, rightUnique: 9, now: new Date(t0.getTime() + 420_000) });
  assert.equal(state.state, "resolved");
  assert.equal(state.winnerSide, "left");
});

test("STEP 3: resolved runtime cannot be replayed into a second winner", () => {
  assert.deepEqual(closeFinalSalvoShot({ tiebreak: { ...started(), state: "resolved", winnerSide: "left" }, leftUnique: 0, rightUnique: 99, now: t0 }), { ok: false, reason: "tiebreak-not-active" });
  assert.match(migrationSource, /OLD\.state = 'resolved'[\s\S]*FINAL_SALVO_RESULT_IMMUTABLE/);
  assert.match(finalizerSource, /existingWinner && existingWinner !== ident\(winnerToken\)[\s\S]*FINAL_SALVO_RESULT_IMMUTABLE/);
});

test("STEP 4: restart-safe finalizer locks persisted authority and idempotently ignores active/resolved retries", () => {
  assert.match(finalizerSource, /arena_vote_tiebreaks where battle_id=\$1 for update/);
  assert.match(finalizerSource, /current\.state === "resolved"[\s\S]*advanced: false/);
  assert.match(finalizerSource, /new Date\(now\)\.getTime\(\) < new Date\(current\.shot_ends_at\)\.getTime\(\)[\s\S]*advanced: false/);
  assert.match(finalizerSource, /chain_id=\$1 and tournament_id=\$2 and battle_id=\$3 and round_number=\$4[\s\S]*coalesce\(match_id,battle_id\)=\$5/);
  assert.match(migrationSource, /FINAL_SALVO_IDENTITY_IMMUTABLE/);
});

test("STEP 4: persisted shot history is bound to immutable identity", () => {
  for (const needle of ["chainId: identity.chainId", "tournamentId: identity.tournamentId", "battleId: identity.battleId", "matchId: identity.matchId", "roundNumber: identity.roundNumber"]) {
    assert.match(finalizerSource, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("STEP 5: endpoint is explicit-chain fail-closed and Final Salvo-only", () => {
  assert.match(endpointSource, /requiredFinalSalvoChainId\(value\)/);
  assert.match(endpointSource, /where id = \$1 and chain_id = \$2/);
  assert.match(endpointSource, /battle_mode !== "vote"/);
  assert.match(endpointSource, /boostAllowed: false/);
  assert.match(endpointSource, /marketMetricsAllowed: false/);
  assert.doesNotMatch(endpointSource, /reward-claim|graduation|sponsorship|quarterly|arenaLeague/);
});

test("shot winner uses unique-wallet counts only", () => {
  assert.equal(finalSalvoShotWinner(3, 1), "left");
  assert.equal(finalSalvoShotWinner(1, 3), "right");
  assert.equal(finalSalvoShotWinner(2, 2), null);
});

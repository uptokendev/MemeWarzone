import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveTournamentVoteMatch, tournamentVoteSummary } from "./arenaTournamentVoteRuntime.mjs";
import { beginFinalSalvo, closeFinalSalvoShot } from "./arenaFinalSalvoRuntime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(here, "..");
const frontendRoot = path.join(apiRoot, "..");

function readApi(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(frontendRoot, rel), "utf8");
}

test("Tournament Round 1 reuses canonical Match Quality exactly once", () => {
  const tournaments = readApi("arenaTournaments.js");
  assert.match(tournaments, /const seeded = optimizeMatchPairings\(start\.roster/);
  assert.match(tournaments, /getProfile:\s*\(entry\) => snapshots\.get/);
  assert.match(tournaments, /matchQuality:\s*pairing\.matchQuality/);
  assert.match(tournaments, /classification:\s*pairing\.classification/);
  assert.match(tournaments, /ranked:\s*pairing\.ranked/);
  const optimizerCalls = tournaments.match(/optimizeMatchPairings\s*\(/g) || [];
  assert.equal(optimizerCalls.length, 1, "similarity optimization must be limited to initial Round 1 seeding");
});

test("later tournament rounds remain winner-advances and reuse the normal battle insertion path", () => {
  const tournaments = readApi("arenaTournaments.js");
  assert.match(tournaments, /const winners = matches\.map\(\(match\) => ident\(match\.winner\)\)\.filter\(Boolean\)/);
  assert.match(tournaments, /for \(let i = 0; i < winners\.length; i \+= 2\)/);
  assert.match(tournaments, /const battleId = await insertTournamentBattle\(/);
  assert.match(tournaments, /advanceTournamentFromBattle/);
  assert.match(tournaments, /reconcileTournamentBracket/);
});

test("every tournament-created fight captures Battle V2 baselines without a tournament-specific calculator", () => {
  const tournaments = readApi("arenaTournaments.js");
  assert.match(tournaments, /async function insertTournamentBattle/);
  assert.match(tournaments, /source, stake_native[\s\S]*'tournament'/);
  assert.match(tournaments, /captureLiveBaselines\(/);
  assert.doesNotMatch(tournaments, /calculateBattlePoints\s*\(/);
  assert.doesNotMatch(tournaments, /mcapPoints\s*=/);
  assert.doesNotMatch(tournaments, /holderPoints\s*=/);
  assert.doesNotMatch(tournaments, /volumePoints\s*=/);
});

test("Tournament Details consumes normalized profiles and canonical Battle metrics", () => {
  const details = readFrontend("src/hooks/useTournamentCommandState.ts");
  const matchCard = readFrontend("src/components/arena/TournamentMatchCard.tsx");
  const identity = readFrontend("src/components/arena/TournamentTokenIdentity.tsx");
  const registration = readFrontend("src/components/arena/TournamentRegistrationModal.tsx");

  assert.match(details, /fetchArenaBattleMetrics/);
  assert.match(details, /setInterval\(\(\) => void load\(\), 15_000\)/);
  assert.match(registration, /TournamentTokenIdentity/);
  assert.match(matchCard, /metrics\?\.sides\.left/);
  assert.match(matchCard, /Latest Battle Points/);
  assert.match(matchCard, /Live Battle Points/);
  assert.match(matchCard, /Official tournament advancement is recorded from the settled battle result/);
  assert.match(matchCard, /battleFightHref\(match\.battleId\)/);
  assert.doesNotMatch(matchCard, /to=\{`\/battle\//);
  assert.match(identity, /useArenaTokenProfile/);
});

test("Tournament presentation does not duplicate Battle Points math or bypass canonical settlement selection", () => {
  const details = readFrontend("src/hooks/useTournamentCommandState.ts");
  const matchCard = readFrontend("src/components/arena/TournamentMatchCard.tsx");
  const metricsApi = readApi("arenaBattleMetrics.js");
  const combined = `${details}\n${matchCard}`;

  assert.doesNotMatch(combined, /calculateBattlePoints/);
  assert.doesNotMatch(combined, /marketCapWeight|holderWeight|volumeWeight/);
  assert.match(metricsApi, /import\s*\{\s*arenaSettlementMode\s*\}\s*from\s*["']\.\/lib\/arenaSettlementMode\.js["']/);
  assert.match(metricsApi, /const settlementMode = arenaSettlementMode\(battle\);/);
  assert.doesNotMatch(metricsApi, /settlementMode:\s*["']v1_mcap_pct_change["']/);
});

test("Vote Tournament runtime binds free votes to the active 24-hour vote matchup", () => {
  const tokenA = "0x1111111111111111111111111111111111111111";
  const tokenB = "0x2222222222222222222222222222222222222222";
  const tournament = {
    status: "live",
    battle_mode: "vote",
    round_duration_hours: 24,
    bracket: {
      rounds: [{ round: 1, matches: [{ id: "m1", tokenA, tokenB, battleId: "battle-1", winner: null, bye: false }] }],
    },
  };
  const match = resolveTournamentVoteMatch({ tournament, matchRef: "m1", selectedToken: tokenA });
  assert.equal(match.ok, true);
  assert.equal(match.battleId, "battle-1");
  assert.equal(match.roundNumber, 1);
  assert.deepEqual(tournamentVoteSummary([{ side: "left" }, { side: "right" }, { side: "left" }], match), {
    tokenA,
    tokenB,
    leftVotes: 2,
    rightVotes: 1,
    totalVotes: 3,
    leftPoints: 2,
    rightPoints: 1,
  });
});

test("Final Salvo certifies exact-tie entry, 60-second shots, early win and Sudden Death", () => {
  const start = new Date("2026-09-04T12:00:00.000Z");
  let state = beginFinalSalvo({ regulationLeftPoints: 9, regulationRightPoints: 9, now: start });
  assert.equal(state.ok, true);
  assert.equal(state.shotEndsAt, "2026-09-04T12:01:00.000Z");

  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 4, rightUnique: 1, now: new Date("2026-09-04T12:01:00.000Z") });
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 3, rightUnique: 1, now: new Date("2026-09-04T12:02:00.000Z") });
  state = closeFinalSalvoShot({ tiebreak: state, leftUnique: 5, rightUnique: 2, now: new Date("2026-09-04T12:03:00.000Z") });
  assert.equal(state.state, "resolved");
  assert.equal(state.winnerSide, "left");

  let tied = beginFinalSalvo({ regulationLeftPoints: 4, regulationRightPoints: 4, now: start });
  for (let index = 0; index < 5; index += 1) {
    tied = closeFinalSalvoShot({
      tiebreak: tied,
      leftUnique: 2,
      rightUnique: 2,
      now: new Date(start.getTime() + (index + 1) * 60_000),
    });
  }
  assert.equal(tied.state, "sudden_death");
  assert.equal(tied.suddenDeathRound, 1);
});

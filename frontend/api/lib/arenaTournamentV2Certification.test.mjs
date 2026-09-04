import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveTournamentVoteMatch, tournamentVoteSummary } from "./arenaTournamentVoteRuntime.mjs";
import { beginFinalSalvo, closeFinalSalvoShot } from "./arenaFinalSalvoRuntime.mjs";
import { tournamentBoostMatchId, tournamentBoostPoolId } from "./arenaTournamentBoostVerification.mjs";

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

test("Vote Tournament finalizer is lease-protected and never dispatches Vote battles into Battle V2 settlement", () => {
  const finalizer = readApi("lib/arenaVoteTournamentFinalizationService.js");
  const worker = readFrontend("scripts/run-arena-battle-realtime-worker.mjs");
  assert.match(finalizer, /pg_try_advisory_xact_lock/);
  assert.match(finalizer, /arena-vote-finalize:/);
  assert.match(finalizer, /phase = 'regulation'/);
  assert.match(finalizer, /insert into public\.arena_vote_tiebreaks/);
  assert.match(worker, /coalesce\(b\.battle_mode\s*,\s*'normal'\)\s*<>\s*'vote'/);
  assert.match(worker, /finalizeDueVoteTournamentBattle/);
  assert.match(worker, /advanceDueFinalSalvo/);
});

test("Final Salvo API is free-vote-only, shot-bound and exposes no Boost path", () => {
  const salvo = readApi("arenaFinalSalvo.js");
  assert.match(salvo, /action:\s*"arena_final_salvo_vote"/);
  assert.match(salvo, /action_type, boost_units, points/);
  assert.match(salvo, /'free_vote',0,1/);
  assert.match(salvo, /select now\(\) as now/);
  assert.match(salvo, /boostAllowed:\s*false/);
  assert.doesNotMatch(salvo, /arena_battle_boost_quote|BattleBoosted|boostUnits:\s*[1-9]/);
});

test("Vote Tournament Boost binds V2 event identity, 2 points per unit and 90/10 economics", () => {
  const boosts = readApi("arenaTournamentBoosts.js");
  const verifier = readApi("lib/arenaTournamentBoostVerification.mjs");
  const poolId = tournamentBoostPoolId("t-1");
  const matchId = tournamentBoostMatchId({ tournamentId: "t-1", roundNumber: 2, matchId: "r2-m1" });
  assert.match(poolId, /^0x[0-9a-f]{64}$/i);
  assert.match(matchId, /^0x[0-9a-f]{64}$/i);
  assert.match(verifier, /event TournamentBoosted/);
  assert.match(verifier, /event\.unitPriceNativeRaw \* event\.boostUnits !== event\.grossNativeRaw/);
  assert.match(boosts, /points = split\.boostUnits \* 2n/);
  assert.match(boosts, /prizeBps:\s*9000, protocolBps:\s*1000, leagueBps:\s*0/);
  assert.match(boosts, /competition_generation \|\| ""\) !== "arena_competition_v2"/);
  assert.match(boosts, /TOURNAMENT_BOOST_OUTSIDE_REGULATION/);
  assert.match(boosts, /arena_tournament_boost_quote/);
  assert.match(boosts, /requireInternalAuth\(req, res, \{ routeLabel: "arena_tournament_boost_confirm" \}\)/);
});

test("V2 Vote Tournament settlement advances winner and next round in the same transaction", () => {
  const finalizer = readApi("lib/arenaVoteTournamentFinalizationService.js");
  const bracket = readApi("lib/arenaVoteTournamentBracketService.js");
  assert.match(finalizer, /import \{ advanceVoteTournamentBracket \}/);
  assert.match(finalizer, /competition_generation === "arena_competition_v2"/);
  assert.match(finalizer, /contest_scoring_version === "vote_tournament_v1"/);
  assert.match(finalizer, /const finished = await finishVoteBattle[\s\S]*await advanceVoteTournamentBracket[\s\S]*await client\.query\("commit"\)/);
  assert.match(finalizer, /persistTiebreakState[\s\S]*finishVoteBattle[\s\S]*advanceVoteTournamentBracket[\s\S]*client\.query\("commit"\)/);
  assert.match(bracket, /from public\.arena_tournaments[\s\S]*for update/);
  assert.match(bracket, /competition_generation !== "arena_competition_v2"/);
  assert.match(bracket, /contest_scoring_version !== "vote_tournament_v1"/);
  assert.match(bracket, /insert into public\.arena_battles/);
  assert.match(bracket, /captureLiveBaselines\(/);
  assert.match(bracket, /isSolanaChainId/);
  assert.match(bracket, /token_address = \$2/);
  assert.match(bracket, /lower\(token_address\) = lower\(\$2\)/);
});

test("V2 Vote Tournament setup locks $0.25 entry and generation-routes historical receipt URLs", () => {
  const setup = readApi("arenaVoteTournamentSetup.js");
  const buyIn = readApi("lib/arenaTournamentBuyInV2.mjs");
  const routing = readApi("postgrad.js");
  assert.match(buyIn, /TOURNAMENT_BUY_IN_USD_MICROS = 250_000n/);
  assert.match(buyIn, /usdMicros:\s*TOURNAMENT_BUY_IN_USD_MICROS/);
  assert.match(buyIn, /function buyIns\(bytes32 poolId,address wallet\)/);
  assert.match(buyIn, /function pools\(bytes32 poolId\)/);
  assert.match(buyIn, /buyInAmount !== expected/);
  assert.match(buyIn, /paid !== expected/);
  assert.match(setup, /'vote',24,'vote_tournament_v1','arena_competition_v2'/);
  assert.match(setup, /action:\s*"arena_tournament_buy_in_v2"/);
  assert.match(setup, /readAuthoritativeBuyInReceipt/);
  assert.match(setup, /BigInt\(String\(onchain\.buyInLamports \|\| 0\)\) !== expectedRaw/);
  assert.match(setup, /verifyEvmTournamentBuyInV2/);
  assert.match(setup, /await client\.query\("begin"\)/);
  assert.match(setup, /await client\.query\("commit"\)/);
  assert.match(setup, /handleGenerationAwareLegacyReceipt/);
  assert.match(setup, /isSolanaChainId\(chainId\)[\s\S]*token_address = \$2/);
  assert.doesNotMatch(setup, /PRIVATE_KEY|new Wallet\(/);
  assert.match(routing, /pattern:\s*\/\^\\\/arena\\\/tournaments\\\/\[\^\/\]\+\\\/(?:\(\?:)?v2-buy-in-receipt\|buy-in-receipt/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  VOTE_TOURNAMENT_CHAIN_IDS,
  assertVoteTournamentBattleIdentity,
  optionalVoteTournamentChainId,
  requiredVoteTournamentChainId,
  voteTournamentIdentityError,
} from "./arenaVoteTournamentChainIdentity.js";

const BNB = 56;
const SOLANA = 101;
const ROBINHOOD = 4663;
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const votesSource = fs.readFileSync(path.join(apiDir, "arenaTournamentVotes.js"), "utf8");
const gateSource = fs.readFileSync(path.join(apiDir, "arenaVoteTournamentIdentityGate.js"), "utf8");
const setupSource = fs.readFileSync(path.join(apiDir, "arenaVoteTournamentSetup.js"), "utf8");
const tournamentsSource = fs.readFileSync(path.join(apiDir, "arenaTournaments.js"), "utf8");
const postgradSource = fs.readFileSync(path.join(apiDir, "postgrad.js"), "utf8");

function tournament(chainId, id = `vote-${chainId}`) {
  return { id, chain_id: chainId, battle_mode: "vote" };
}

test("Vote Tournament supports exactly BNB, Solana, and Robinhood production identities", () => {
  assert.deepEqual(VOTE_TOURNAMENT_CHAIN_IDS, [BNB, SOLANA, ROBINHOOD]);
  for (const chainId of VOTE_TOURNAMENT_CHAIN_IDS) {
    assert.equal(requiredVoteTournamentChainId(chainId), chainId);
    assert.equal(optionalVoteTournamentChainId(chainId), chainId);
  }
  for (const chainId of [97, 102, 46630, 1, -1, "not-a-chain"]) {
    assert.throws(() => optionalVoteTournamentChainId(chainId), /Unsupported Vote Tournament chain id/);
  }
  assert.throws(() => requiredVoteTournamentChainId(null), /chain id is required/i);
});

test("BNB Vote Tournament rejects Solana and Robinhood tournament contexts", () => {
  const row = tournament(BNB, "same-tournament-ref");
  assert.equal(voteTournamentIdentityError(row, BNB), null);
  assert.equal(voteTournamentIdentityError(row, SOLANA)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(row, ROBINHOOD)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("Solana Vote Tournament rejects BNB and Robinhood tournament contexts", () => {
  const row = tournament(SOLANA, "same-tournament-ref");
  assert.equal(voteTournamentIdentityError(row, SOLANA), null);
  assert.equal(voteTournamentIdentityError(row, BNB)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(row, ROBINHOOD)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("Robinhood Vote Tournament rejects BNB and Solana tournament contexts", () => {
  const row = tournament(ROBINHOOD, "same-tournament-ref");
  assert.equal(voteTournamentIdentityError(row, ROBINHOOD), null);
  assert.equal(voteTournamentIdentityError(row, BNB)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(row, SOLANA)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("Vote endpoints cannot be used against a Normal Tournament row", () => {
  const error = voteTournamentIdentityError({ id: "normal", chain_id: BNB, battle_mode: "normal" }, BNB);
  assert.equal(error?.code, "VOTE_TOURNAMENT_NOT_FOUND");
});

test("bracket Battle identity binds chain plus tournament id", () => {
  const row = tournament(BNB, "vote-a");
  assert.equal(assertVoteTournamentBattleIdentity({ id: "b1", chain_id: BNB, tournament_id: "vote-a", source: "tournament", battle_mode: "vote" }, row), true);
  assert.equal(assertVoteTournamentBattleIdentity({ id: "b1", chain_id: SOLANA, tournament_id: "vote-a", source: "tournament", battle_mode: "vote" }, row), false);
  assert.equal(assertVoteTournamentBattleIdentity({ id: "b1", chain_id: BNB, tournament_id: "vote-other", source: "tournament", battle_mode: "vote" }, row), false);
});

test("Vote creation and quote require explicit supported chain while receipt preserves canonical row chain", () => {
  assert.match(gateSource, /buy-in-quote[\s\S]*voteTournamentChainIdFromQuery\(req, \{ required: true \}\)/);
  assert.match(gateSource, /\/v2\/create[\s\S]*voteTournamentChainIdFromBody\(bodyOf\(req\), \{ required: true \}\)/);
  assert.match(gateSource, /v2-buy-in-receipt\|buy-in-receipt[\s\S]*voteTournamentIdentityError\(tournament, requestedChainId\)/);
  assert.match(setupSource, /insert into public\.arena_tournaments[\s\S]*id, chain_id[\s\S]*values \(\$1,\$2/);
});

test("Vote state and wallet vote association are chain-scoped", () => {
  assert.match(votesSource, /from public\.arena_contest_actions[\s\S]*and chain_id = \$5[\s\S]*action_type = 'free_vote'/);
  assert.match(votesSource, /where id = \$1 and chain_id = \$2 and battle_mode = 'vote'/);
  assert.match(votesSource, /wallet = \$5[\s\S]*and chain_id = \$6/);
  assert.match(votesSource, /tournament_id = \$1[\s\S]*and chain_id = \$5[\s\S]*action_type = 'free_vote'/);
});

test("Vote Tournament Boost routes are gated for EVM and Solana and verify matchup Battle chain", () => {
  assert.match(gateSource, /validateMatchBattleIdentity\(tournament, matchRef\)/);
  assert.match(gateSource, /assertVoteTournamentBattleIdentity\(battle, tournament\)/);
  assert.match(gateSource, /solanaOnly && Number\(tournament\.chain_id\) !== 101/);
  assert.match(postgradSource, /boosts\\\/\(\?:solana-quote\|solana-payment\)[\s\S]*arenaVoteTournamentSolanaBoostsIdentityGate/);
  assert.match(postgradSource, /boosts\(\?:\\\/\.\*\)\?\$[\s\S]*arenaVoteTournamentBoostsIdentityGate/);
});

test("generic tournament feed/detail/participants and winner settlement remain chain-scoped for Vote rows", () => {
  assert.match(tournamentsSource, /handleList[\s\S]*chainClause = context\.chainId == null \? "" : " and chain_id = \$1"/);
  assert.match(tournamentsSource, /handleDetail[\s\S]*loadTournamentRow\(id, context\.chainId\)/);
  assert.match(tournamentsSource, /listEntries\(id, row\.chain_id\)/);
  assert.match(tournamentsSource, /set status = 'finished'[\s\S]*where id = \$1 and chain_id = \$4/);
});

test("legacy Normal Tournament buy-in receipt remains delegated unchanged", () => {
  assert.match(gateSource, /receipt\[2\] === "buy-in-receipt" && tournament && tournament\.battle_mode !== "vote"[\s\S]*return arenaVoteTournamentSetup\(req, res\)/);
});

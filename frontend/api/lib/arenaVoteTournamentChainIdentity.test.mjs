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
  voteTournamentEnvironmentIdentity,
  voteTournamentIdentityError,
} from "./arenaVoteTournamentChainIdentity.js";

const BNB = 56;
const BNB_STAGING = 97;
const SOLANA = 101;
const ROBINHOOD = 4663;
const ROBINHOOD_STAGING = 46630;
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const votesSource = fs.readFileSync(path.join(apiDir, "arenaTournamentVotes.js"), "utf8");
const gateSource = fs.readFileSync(path.join(apiDir, "arenaVoteTournamentIdentityGate.js"), "utf8");
const setupSource = fs.readFileSync(path.join(apiDir, "arenaVoteTournamentSetup.js"), "utf8");
const tournamentsSource = fs.readFileSync(path.join(apiDir, "arenaTournaments.js"), "utf8");
const postgradSource = fs.readFileSync(path.join(apiDir, "postgrad.js"), "utf8");

function tournament(chainId, id = `vote-${chainId}`, identity = {}) {
  const defaults = chainId === SOLANA
    ? { environment: "production", solana_cluster: "mainnet-beta" }
    : chainId === BNB_STAGING || chainId === ROBINHOOD_STAGING
      ? { environment: "staging", solana_cluster: null }
      : { environment: "production", solana_cluster: null };
  return { id, chain_id: chainId, battle_mode: "vote", ...defaults, ...identity };
}

test("Vote Tournament supports exact production and staging chain identities", () => {
  assert.deepEqual(VOTE_TOURNAMENT_CHAIN_IDS, [BNB, BNB_STAGING, SOLANA, ROBINHOOD, ROBINHOOD_STAGING]);
  for (const chainId of VOTE_TOURNAMENT_CHAIN_IDS) {
    assert.equal(requiredVoteTournamentChainId(chainId), chainId);
    assert.equal(optionalVoteTournamentChainId(chainId), chainId);
  }
  for (const chainId of [102, 1, 8453, -1, "not-a-chain"]) {
    assert.throws(() => optionalVoteTournamentChainId(chainId), /Unsupported Vote Tournament chain id/);
  }
  assert.throws(() => requiredVoteTournamentChainId(null), /chain id is required/i);
});

test("Vote Tournament preserves explicit environment identity", () => {
  assert.deepEqual(voteTournamentEnvironmentIdentity(BNB, { environment: "production" }), { chainId: BNB, environment: "production", solanaCluster: null });
  assert.deepEqual(voteTournamentEnvironmentIdentity(BNB_STAGING, { environment: "staging" }), { chainId: BNB_STAGING, environment: "staging", solanaCluster: null });
  assert.deepEqual(voteTournamentEnvironmentIdentity(ROBINHOOD, { environment: "production" }), { chainId: ROBINHOOD, environment: "production", solanaCluster: null });
  assert.deepEqual(voteTournamentEnvironmentIdentity(ROBINHOOD_STAGING, { environment: "staging" }), { chainId: ROBINHOOD_STAGING, environment: "staging", solanaCluster: null });
  assert.deepEqual(voteTournamentEnvironmentIdentity(SOLANA, { environment: "staging", solanaCluster: "devnet" }), { chainId: SOLANA, environment: "staging", solanaCluster: "devnet" });
  assert.deepEqual(voteTournamentEnvironmentIdentity(SOLANA, { environment: "production", solanaCluster: "mainnet-beta" }), { chainId: SOLANA, environment: "production", solanaCluster: "mainnet-beta" });
  assert.throws(() => voteTournamentEnvironmentIdentity(SOLANA, { environment: "production", solanaCluster: "devnet" }), /requires mainnet-beta|requires devnet/);
  assert.throws(() => voteTournamentEnvironmentIdentity(BNB_STAGING, { environment: "production" }), /requires staging/);
  assert.throws(() => voteTournamentEnvironmentIdentity(ROBINHOOD, { environment: "staging" }), /requires production/);
});

test("BNB Vote Tournament rejects Solana and Robinhood tournament contexts", () => {
  const row = tournament(BNB, "same-tournament-ref");
  assert.equal(voteTournamentIdentityError(row, BNB), null);
  assert.equal(voteTournamentIdentityError(row, SOLANA)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(row, ROBINHOOD)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("staging Vote Tournament identities do not collapse into production", () => {
  assert.equal(voteTournamentIdentityError(tournament(BNB_STAGING), BNB_STAGING), null);
  assert.equal(voteTournamentIdentityError(tournament(BNB_STAGING), BNB)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(tournament(ROBINHOOD_STAGING), ROBINHOOD_STAGING), null);
  assert.equal(voteTournamentIdentityError(tournament(ROBINHOOD_STAGING), ROBINHOOD)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("Solana Vote Tournament requires and preserves devnet vs mainnet-beta identity", () => {
  const production = tournament(SOLANA, "same-tournament-ref");
  const staging = tournament(SOLANA, "same-tournament-ref", { environment: "staging", solana_cluster: "devnet" });
  assert.equal(voteTournamentIdentityError(production, SOLANA, { environment: "production", solanaCluster: "mainnet-beta" }), null);
  assert.equal(voteTournamentIdentityError(staging, SOLANA, { environment: "staging", solanaCluster: "devnet" }), null);
  assert.equal(voteTournamentIdentityError(production, SOLANA)?.code, "TOURNAMENT_ENVIRONMENT_REQUIRED");
  assert.equal(voteTournamentIdentityError(staging, SOLANA, { environment: "production", solanaCluster: "mainnet-beta" })?.code, "TOURNAMENT_ENVIRONMENT_MISMATCH");
  assert.equal(voteTournamentIdentityError(production, SOLANA, { environment: "staging", solanaCluster: "devnet" })?.code, "TOURNAMENT_ENVIRONMENT_MISMATCH");
  assert.equal(voteTournamentIdentityError(production, BNB)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(production, ROBINHOOD)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("Robinhood Vote Tournament rejects BNB and Solana tournament contexts", () => {
  const row = tournament(ROBINHOOD, "same-tournament-ref");
  assert.equal(voteTournamentIdentityError(row, ROBINHOOD), null);
  assert.equal(voteTournamentIdentityError(row, BNB)?.code, "TOURNAMENT_CHAIN_MISMATCH");
  assert.equal(voteTournamentIdentityError(row, SOLANA)?.code, "TOURNAMENT_CHAIN_MISMATCH");
});

test("Vote endpoints cannot be used against a Normal Tournament row", () => {
  const error = voteTournamentIdentityError({ id: "normal", chain_id: BNB, battle_mode: "normal", environment: "production" }, BNB);
  assert.equal(error?.code, "VOTE_TOURNAMENT_NOT_FOUND");
});

test("bracket Battle identity binds chain plus tournament id", () => {
  const row = tournament(BNB, "vote-a");
  assert.equal(assertVoteTournamentBattleIdentity({ id: "b1", chain_id: BNB, tournament_id: "vote-a", source: "tournament", battle_mode: "vote" }, row), true);
  assert.equal(assertVoteTournamentBattleIdentity({ id: "b1", chain_id: SOLANA, tournament_id: "vote-a", source: "tournament", battle_mode: "vote" }, row), false);
  assert.equal(assertVoteTournamentBattleIdentity({ id: "b1", chain_id: BNB, tournament_id: "vote-other", source: "tournament", battle_mode: "vote" }, row), false);
});

test("Vote creation, quote, receipt and Boost gates preserve canonical environment identity", () => {
  assert.match(gateSource, /buy-in-quote[\s\S]*voteTournamentChainIdFromQuery\(req, \{ required: true \}\)/);
  assert.match(gateSource, /\/v2\/create[\s\S]*voteTournamentChainIdFromBody\(body, \{ required: true \}\)/);
  assert.match(gateSource, /select id, chain_id[\s\S]*environment, solana_cluster/);
  assert.match(gateSource, /voteTournamentIdentityError\(tournament, requestedChainId, requestedEnvironment\(req, body\)\)/);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ARENA_CHAIN_IDS, arenaEnvironmentIdentity, requiredArenaChainId } from "./arenaChainEnvironment.js";
import { VOTE_TOURNAMENT_CHAIN_IDS, voteTournamentEnvironmentIdentity } from "./arenaVoteTournamentChainIdentity.js";
import { FINAL_SALVO_CHAIN_IDS, FINAL_SALVO_SHOT_SECONDS, finalSalvoEnvironmentIdentity } from "./arenaFinalSalvoRuntime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
const voteGate = fs.readFileSync(path.join(apiRoot, "arenaVoteTournamentIdentityGate.js"), "utf8");
const finalSalvoEndpoint = fs.readFileSync(path.join(apiRoot, "arenaFinalSalvo.js"), "utf8");

const EXPECTED = [56, 97, 101, 4663, 46630];

test("canonical Arena identity accepts exactly the supported production and staging chains", () => {
  assert.deepEqual(ARENA_CHAIN_IDS, EXPECTED);
  assert.deepEqual(VOTE_TOURNAMENT_CHAIN_IDS, EXPECTED);
  assert.deepEqual(FINAL_SALVO_CHAIN_IDS, EXPECTED);
  for (const chainId of EXPECTED) assert.equal(requiredArenaChainId(chainId), chainId);
  for (const chainId of [1, 10, 102, 8453, 42161, 99999, 0, -1]) {
    assert.throws(() => requiredArenaChainId(chainId), /Unsupported Arena chain id/);
  }
});

test("BNB and Robinhood production/staging environments never collapse", () => {
  assert.deepEqual(arenaEnvironmentIdentity(56), { chainId: 56, environment: "production", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(97), { chainId: 97, environment: "staging", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(4663), { chainId: 4663, environment: "production", solanaCluster: null });
  assert.deepEqual(arenaEnvironmentIdentity(46630), { chainId: 46630, environment: "staging", solanaCluster: null });
  assert.throws(() => arenaEnvironmentIdentity(97, { environment: "production" }), /requires staging/);
  assert.throws(() => arenaEnvironmentIdentity(56, { environment: "staging" }), /requires production/);
  assert.throws(() => arenaEnvironmentIdentity(46630, { environment: "production" }), /requires staging/);
  assert.throws(() => arenaEnvironmentIdentity(4663, { environment: "staging" }), /requires production/);
});

test("Solana 101 remains explicitly split between devnet and mainnet-beta", () => {
  const devnet = { environment: "staging", solanaCluster: "devnet" };
  const mainnet = { environment: "production", solanaCluster: "mainnet-beta" };
  assert.deepEqual(voteTournamentEnvironmentIdentity(101, devnet), { chainId: 101, ...devnet });
  assert.deepEqual(voteTournamentEnvironmentIdentity(101, mainnet), { chainId: 101, ...mainnet });
  assert.deepEqual(finalSalvoEnvironmentIdentity(101, devnet), { chainId: 101, ...devnet });
  assert.deepEqual(finalSalvoEnvironmentIdentity(101, mainnet), { chainId: 101, ...mainnet });
  assert.throws(() => voteTournamentEnvironmentIdentity(101, { environment: "production", solanaCluster: "devnet" }), /requires mainnet-beta|requires devnet/);
  assert.throws(() => finalSalvoEnvironmentIdentity(101, { environment: "staging", solanaCluster: "mainnet-beta" }), /requires mainnet-beta|requires devnet/);
});

test("Vote Tournament request gate loads and validates persisted environment identity", () => {
  assert.match(voteGate, /environment, solana_cluster/);
  assert.match(voteGate, /voteTournamentEnvironmentFromQuery/);
  assert.match(voteGate, /voteTournamentEnvironmentFromBody/);
  assert.match(voteGate, /voteTournamentIdentityError\(tournament, requestedChainId, requestedEnvironment\(req, body\)\)/);
});

test("Final Salvo request gate loads and validates persisted environment identity", () => {
  assert.match(finalSalvoEndpoint, /round_duration_hours, environment, solana_cluster/);
  assert.match(finalSalvoEndpoint, /assertTournamentEnvironment\(tournament, chainId, requestedEnvironment\(req, body\)\)/);
  assert.match(finalSalvoEndpoint, /FINAL_SALVO_ENVIRONMENT_REQUIRED/);
  assert.match(finalSalvoEndpoint, /FINAL_SALVO_ENVIRONMENT_MISMATCH/);
});

test("Final Salvo remains 60 seconds and does not inherit Vote Tournament round duration", () => {
  assert.equal(FINAL_SALVO_SHOT_SECONDS, 60);
  assert.match(finalSalvoEndpoint, /const roundHours = Number\(tournament\.round_duration_hours\)/);
  assert.match(finalSalvoEndpoint, /!Number\.isInteger\(roundHours\) \|\| roundHours < 1/);
  assert.doesNotMatch(finalSalvoEndpoint, /Number\(tournament\.round_duration_hours\) !== 24/);
  assert.doesNotMatch(finalSalvoEndpoint, /roundHours === 24|roundHours !== 24/);
});

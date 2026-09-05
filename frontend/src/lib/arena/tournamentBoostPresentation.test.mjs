import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function read(relativePath) {
  return fs.readFileSync(path.join(here, relativePath), "utf8");
}

test("Tournament Boost uses the dedicated signed quote and treasury call only", () => {
  const client = read("./tournamentBoostClient.ts");

  assert.match(client, /arena_tournament_boost_quote/);
  assert.match(client, /\/boosts\/quote/);
  assert.match(client, /boostTournament/);
  assert.doesNotMatch(client, /\/confirm/);
  assert.match(client, /Wallet chain does not match Tournament Boost quote/);
  assert.match(client, /Tournament Boost quote belongs to another wallet/);
  assert.match(client, /receipt\.status/);
});

test("Tournament Boost UI displays founder-locked 2-point and 90\/10 regulation rules", () => {
  const controls = read("../../components/arena/TournamentBoostControls.tsx");

  assert.match(controls, /TOURNAMENT BOOST · \$1 = 2 PTS/);
  assert.match(controls, /90% PRIZE · 10% PROTOCOL/);
  assert.match(controls, /authoritative Free Vote points \+ confirmed Boost points/);
  assert.match(controls, /Winner and bracket advancement remain server-authoritative/);
  assert.doesNotMatch(controls, /winnerIndex|leaderIndex|advanceTournament|resolveWinner/);
});

test("Tournament Boost stays EVM-only and disappears for Final Salvo", () => {
  const controls = read("../../components/arena/TournamentBoostControls.tsx");

  assert.match(controls, /isSolanaChainId/);
  assert.match(controls, /waiting on the Solana money path/);
  assert.match(controls, /salvoActive/);
  assert.match(controls, /if \(salvoActive\) return null/);
});

test("Vote Tournament live-round stack mounts Free Vote, Boost, then Final Salvo consumers", () => {
  const liveRound = read("../../components/arena/TournamentLiveRoundBattles.tsx");

  assert.match(liveRound, /TournamentVoteControls/);
  assert.match(liveRound, /TournamentBoostControls/);
  assert.match(liveRound, /TournamentFinalSalvoControls/);
  assert.match(liveRound, /showVoteModeActions/);
});

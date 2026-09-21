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
  // Quotes are match-scoped: /api/arena/tournaments/:id/matches/:ref/quote
  // for EVM, /solana-quote for Solana, and /solana-payment to register the
  // signed attempt durably before broadcast.
  assert.match(client, /"\/quote"\)/);
  assert.match(client, /"\/solana-quote"\)/);
  assert.match(client, /"\/solana-payment"\)/);
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
  assert.match(controls, /authoritative Free Vote points \+ backend-confirmed Boost points/);
  assert.match(controls, /Winner and bracket advancement remain server-authoritative/);
  assert.doesNotMatch(controls, /winnerIndex|leaderIndex|advanceTournament|resolveWinner/);
});

test("Tournament Boost pays through the Solana money path on Solana and disappears for Final Salvo", () => {
  const controls = read("../../components/arena/TournamentBoostControls.tsx");

  // Solana is no longer "waiting on the money path": ArenaMoneyV2 quotes are
  // requested and paid through the durable Solana lifecycle.
  assert.match(controls, /isSolanaChainId/);
  assert.match(controls, /createSolanaTournamentBoostQuote/);
  assert.doesNotMatch(controls, /waiting on the Solana money path/);
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

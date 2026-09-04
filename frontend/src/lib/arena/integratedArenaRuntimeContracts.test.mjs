import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(here, "../../..");
const read = (relative) => fs.readFileSync(path.join(frontendRoot, relative), "utf8");

const battleClient = read("src/lib/arena/battleBoostClient.ts");
const battleApi = read("api/arenaBoosts.js");
const voteClient = read("src/lib/arena/tournamentVoteClient.ts");
const voteApi = read("api/arenaTournamentVotes.js");
const tournamentBoostClient = read("src/lib/arena/tournamentBoostClient.ts");
const tournamentBoostApi = read("api/arenaTournamentBoosts.js");
const salvoClient = read("src/lib/arena/finalSalvoClient.ts");
const salvoControls = read("src/components/arena/TournamentFinalSalvoControls.tsx");
const salvoApi = read("api/arenaFinalSalvo.js");
const sponsorshipApi = read("api/arenaSponsorships.js");
const sponsorshipClient = read("src/lib/arena/eventSponsorshipClient.ts");

test("Normal Battle Boost client matches merged EVM runtime and never ingests confirmations", () => {
  assert.match(battleClient, /\/api\/arena\/boosts\/quote/);
  assert.match(battleClient, /arena_battle_boost_quote/);
  assert.match(battleClient, /boostBattle\(/);
  assert.match(battleClient, /quote\.value\.booster/);
  assert.match(battleClient, /Wallet chain does not match Battle Boost quote/);
  assert.match(battleClient, /Battle Boost quote belongs to another wallet/);
  assert.doesNotMatch(battleClient, /boosts\/confirm/);
  assert.match(battleApi, /arena_battle_boost_quote/);
  assert.match(battleApi, /active EVM money path/);
  assert.match(battleApi, /boost_curve_founder_pending|boost_hyperbolic_100_v1/);
  assert.match(battleApi, /arena_boost_confirm/);
});

test("Vote Tournament Free Vote remains backend-authoritative and regulation-only", () => {
  assert.match(voteClient, /\/votes/);
  assert.doesNotMatch(voteClient, /localStorage|sessionStorage/);
  assert.match(voteApi, /arena_tournament_vote/);
  assert.match(voteApi, /regulation/);
  assert.match(voteApi, /walletVote/);
  assert.match(voteApi, /free_vote/);
});

test("Vote Tournament paid Boost matches merged EVM runtime and disappears for Final Salvo", () => {
  assert.match(tournamentBoostClient, /arena_tournament_boost_quote/);
  assert.match(tournamentBoostClient, /boostTournament\(/);
  assert.match(tournamentBoostClient, /Wallet chain does not match Tournament Boost quote/);
  assert.doesNotMatch(tournamentBoostClient, /boosts\/confirm/);
  assert.match(tournamentBoostApi, /round_duration_hours/);
  assert.match(tournamentBoostApi, /pointsPerBoost: 2/);
  assert.match(tournamentBoostApi, /prizeBps: 9000, protocolBps: 1000, leagueBps: 0/);
  assert.match(tournamentBoostApi, /Boost is disabled during Final Salvo/);
  assert.match(tournamentBoostApi, /active EVM money path/);
});

test("Final Salvo consumes authoritative state and exposes no paid Boost transaction path", () => {
  assert.match(salvoClient, /\/final-salvo/);
  assert.match(salvoControls, /arena_final_salvo_vote/);
  assert.match(salvoControls, /shotEndsAt/);
  assert.doesNotMatch(salvoControls, /boostTournament|boostBattle|\/boosts\/quote/);
  assert.match(salvoApi, /boostAllowed: false/);
  assert.match(salvoApi, /walletEligible/);
  assert.match(salvoApi, /shotIndex/);
  assert.match(salvoApi, /winnerToken/);
  assert.match(salvoApi, /arena_final_salvo_vote/);
});

test("Event Sponsorship frontend targets declared public reads and never calls internal confirm", () => {
  assert.match(sponsorshipClient, /\/api\/arena\/sponsorships\/options/);
  assert.match(sponsorshipClient, /\/api\/arena\/sponsorships\/\$\{encodeURIComponent\(eventId\)\}\/state/);
  assert.match(sponsorshipClient, /\/api\/arena\/sponsorships\/payments\/\$\{encodeURIComponent\(quoteId\)\}/);
  assert.match(sponsorshipClient, /\/api\/arena\/sponsorships\/solana-quote/);
  assert.match(sponsorshipClient, /\/api\/arena\/sponsorships\/solana-payment/);
  assert.doesNotMatch(sponsorshipClient, /sponsorships\/confirm/);

  assert.match(sponsorshipApi, /\/arena\/sponsorships\/quote/);
  assert.match(sponsorshipApi, /\/arena\/sponsorships\/confirm/);
  assert.match(sponsorshipApi, /arena_sponsorship_quote/);
  assert.match(sponsorshipApi, /Tier: \$\{tier\.code\}/);
  assert.match(sponsorshipApi, /Minimum USD cents: \$\{minimumCents\}/);
  assert.match(sponsorshipApi, /arena_sponsorship_confirm/);
  assert.match(sponsorshipApi, /prizeBps: 7000/);
  assert.match(sponsorshipApi, /marketingOpsBps: 2000/);
  assert.match(sponsorshipApi, /protocolBps: 1000/);
});

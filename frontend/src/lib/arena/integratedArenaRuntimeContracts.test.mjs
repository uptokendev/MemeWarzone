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
const solanaBoostApi = read("api/arenaSolanaBoosts.js");
const solanaBrowser = read("src/lib/arena/solanaArenaBrowserTransaction.ts");
const salvoClient = read("src/lib/arena/finalSalvoClient.ts");
const salvoControls = read("src/components/arena/TournamentFinalSalvoControls.tsx");
const salvoPresentation = read("src/lib/arena/finalSalvoPresentation.mjs");
const salvoApi = read("api/arenaFinalSalvo.js");
const sponsorshipApi = read("api/arenaSponsorships.js");
const sponsorshipPublicApi = read("api/arenaSponsorshipPublic.js");
const sponsorshipClient = read("src/lib/arena/eventSponsorshipClient.ts");

test("Normal Battle Boost client matches merged EVM runtime and never ingests confirmations", () => {
  assert.match(battleClient, /\/api\/arena\/boosts\/quote/);
  assert.match(battleClient, /arena_battle_boost_quote/);
  assert.match(battleClient, /boostBattle\(/);
  assert.match(battleClient, /quote\.value\.booster/);
  assert.doesNotMatch(battleClient, /boosts\/confirm/);
  assert.match(battleApi, /arena_battle_boost_quote/);
  assert.match(battleApi, /BATTLE_POINTS_V3_CONFIG/);
  assert.match(battleApi, /calculateBattlePointsV3Boost/);
  assert.doesNotMatch(battleApi, /founder_pending|boost_curve_founder_pending/);
});

test("Vote Tournament Free Vote remains backend-authoritative and regulation-only", () => {
  assert.match(voteClient, /\/votes/);
  assert.doesNotMatch(voteClient, /localStorage|sessionStorage/);
  assert.match(voteApi, /arena_tournament_vote/);
  assert.match(voteApi, /regulation/);
  assert.match(voteApi, /walletVote/);
  assert.match(voteApi, /free_vote/);
});

test("Vote Tournament paid Boost consumes EVM and frozen Solana runtime without client receipt authority", () => {
  assert.match(tournamentBoostClient, /arena_tournament_boost_quote/);
  assert.match(tournamentBoostClient, /arena_tournament_boost_payment/);
  assert.match(tournamentBoostClient, /\/solana-quote/);
  assert.match(tournamentBoostClient, /\/solana-payment/);
  assert.match(tournamentBoostClient, /sendSolanaArenaInstruction/);
  assert.doesNotMatch(tournamentBoostClient, /findProgramAddress|receiptPda.*===|getAccountInfo/);
  assert.match(tournamentBoostApi, /pointsPerBoost: 2/);
  assert.match(tournamentBoostApi, /prizeBps: 9000, protocolBps: 1000, leagueBps: 0/);
  assert.match(tournamentBoostApi, /Boost is disabled during Final Salvo/);
  assert.match(solanaBoostApi, /pointsPerBoost: 2/);
  assert.match(solanaBoostApi, /FINAL_SALVO_BOOST_DISABLED/);
  assert.match(solanaBoostApi, /verifySolanaBoostPayment/);
  assert.match(solanaBrowser, /transaction\.accounts\.map|envelope\.accounts\.map/);
  assert.doesNotMatch(solanaBrowser, /findProgramAddress|derive.*Pda|verifySolanaBoostPayment/);
});

test("Final Salvo consumes authoritative state and exposes no paid Boost transaction path", () => {
  assert.match(salvoClient, /\/final-salvo/);
  assert.match(salvoControls, /arena_final_salvo_vote/);
  assert.match(salvoControls, /presentFinalSalvoState/);
  assert.match(salvoPresentation, /shotEndsAt/);
  assert.match(salvoPresentation, /boostAllowed: false/);
  assert.doesNotMatch(salvoControls, /boostTournament|boostBattle|\/boosts\/quote/);
  assert.match(salvoApi, /boostAllowed: false/);
  assert.match(salvoApi, /walletEligible/);
});

test("Event Sponsorship consumes public authority routes and never calls internal confirm", () => {
  for (const route of ["options", "solana-quote", "solana-payment"]) assert.match(sponsorshipClient, new RegExp(`sponsorships\\/${route}`));
  assert.match(sponsorshipClient, /sponsorships\/payments\/\$\{encodeURIComponent\(quoteId\)\}/);
  assert.match(sponsorshipClient, /\/state/);
  assert.match(sponsorshipClient, /arena_sponsorship_quote/);
  assert.match(sponsorshipClient, /arena_sponsorship_payment/);
  assert.doesNotMatch(sponsorshipClient, /sponsorships\/confirm/);
  assert.match(sponsorshipPublicApi, /SUPPORTED_EVENT_TYPES/);
  assert.match(sponsorshipPublicApi, /individualBattleSponsorship: false/);
  assert.match(sponsorshipPublicApi, /verifySolanaSponsorshipPayment/);
  assert.match(sponsorshipPublicApi, /prizeBps: 7000/);
  assert.match(sponsorshipPublicApi, /marketingOpsBps: 2000/);
  assert.match(sponsorshipPublicApi, /protocolBps: 1000/);
  assert.match(sponsorshipApi, /arena_sponsorship_confirm/);
});

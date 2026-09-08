import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { presentBattleWallModule } from "./battleWallPresentation.mjs";
import {
  presentCurrentRoundMatches,
  presentTournamentFightActions,
  presentTournamentFightMode,
  presentVoteTournamentFight,
} from "./tournamentFightPresentation.mjs";
import { getMockTournamentBattles, getMockTournamentDetails, getMockTournamentEvents } from "../../features/postgrad/mockTournamentFixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

test("normal and vote Tournament fights share the Battle Wall module and 24h mode labels", () => {
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const actions = readSrc("../../components/arena/BattleFightActions.tsx");
  assert.match(moduleSrc, /BattleFightActions/);
  assert.match(moduleSrc, /data-battle-mode-label/);
  assert.match(moduleSrc, /md:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(combatant, /data-battle-combatant-split="true"/);
  assert.doesNotMatch(combatant, /BOOST|Vote Tournament/);
  assert.match(actions, /data-mock-battle-action="boost"/);
  assert.match(actions, /data-mock-battle-action="vote"/);
  assert.match(actions, /disabled=\{presented\.mockOnly\}/);
  assert.equal(presentTournamentFightMode({ battleMode: "normal" }).bandLabel, "NORMAL · 24H");
  assert.equal(presentTournamentFightMode({ battleMode: "vote" }).bandLabel, "VOTE · 24H");
  assert.equal(presentTournamentFightMode({ battleMode: "normal" }).durationHours, 24);
  assert.equal(presentTournamentFightMode({ battleMode: "vote" }).durationHours, 24);
});

test("normal mode never exposes Vote and production stays fail-closed without runtime or mocks", () => {
  const productionNormal = presentTournamentFightActions({ mode: "normal", mocksEnabled: false, boostRuntime: false, voteRuntime: false });
  assert.equal(productionNormal.showBoost, false);
  assert.equal(productionNormal.showVote, false);
  const mockNormal = presentTournamentFightActions({ mode: "normal", mocksEnabled: true });
  assert.equal(mockNormal.showBoost, true);
  assert.equal(mockNormal.showVote, false);
  assert.equal(mockNormal.mockOnly, true);
  const mockVote = presentTournamentFightActions({ mode: "vote", mocksEnabled: true });
  assert.equal(mockVote.showVote, true);
  assert.equal(mockVote.showBoost, true);
  const runtimeBoost = presentTournamentFightActions({ mode: "normal", boostRuntime: true });
  assert.equal(runtimeBoost.showBoost, true);
  assert.equal(runtimeBoost.showVote, false);
});

test("Vote Tournament never uses normal Battle Points as the deciding score", () => {
  const battle = {
    id: "vote-1",
    state: "live",
    battleMode: "vote",
    durationHours: 24,
    tournamentId: "event-tournament-vote-05",
    participants: [
      { tokenName: "Redline Rats", symbol: "RATS", voteScore: 12, score: 80 },
      { tokenName: "Storm Doge", symbol: "SDOGE", voteScore: 9, score: 10 },
    ],
  };
  const presented = presentBattleWallModule(battle, {
    settlementMode: "battle_points_v2",
    dataHealth: { healthy: true },
    sides: {
      left: { pointsReady: true, points: { total: 80 } },
      right: { pointsReady: true, points: { total: 10 } },
    },
  }, { requested: true, loaded: true });
  assert.equal(presented.fightMode.key, "vote");
  assert.equal(presented.scoreKind, "vote");
  assert.equal(presented.scoreCaption, "Votes");
  assert.equal(presented.leftPointsLabel, "12");
  assert.equal(presented.rightPointsLabel, "9");
  assert.notEqual(presented.leftPointsLabel, "80.0");
  const votes = presentVoteTournamentFight(battle);
  assert.equal(votes.scoreKind, "vote");
});

test("mock live Tournaments exist only in fixtures and expose four current-round fights", () => {
  const events = getMockTournamentEvents();
  const normal = events.find((event) => event.id === "event-tournament-live-04");
  const vote = events.find((event) => event.id === "event-tournament-vote-05");
  assert.equal(normal.battleMode, "normal");
  assert.equal(vote.battleMode, "vote");
  assert.equal(normal.bracketStage, "quarterfinals");
  assert.equal(vote.bracketStage, "quarterfinals");
  const normalDetails = getMockTournamentDetails("event-tournament-live-04");
  const voteDetails = getMockTournamentDetails("event-tournament-vote-05");
  const normalRound = presentCurrentRoundMatches(normalDetails.bracket.rounds);
  const voteRound = presentCurrentRoundMatches(voteDetails.bracket.rounds);
  assert.equal(normalRound.length, 4);
  assert.equal(voteRound.length, 4);
  assert.equal(normalRound.every((match) => !match.winner && match.battleId), true);
  const battles = getMockTournamentBattles();
  assert.equal(battles.filter((battle) => battle.tournamentId === "event-tournament-live-04").length, 4);
  assert.equal(battles.filter((battle) => battle.tournamentId === "event-tournament-vote-05").length, 4);
  assert.equal(battles.every((battle) => battle.durationHours === 24), true);
  const apiClient = readSrc("../../features/postgrad/apiClient.ts");
  assert.doesNotMatch(apiClient, /event-tournament-vote-05|getMockTournamentBattles/);
  const feed = readSrc("../../hooks/useArenaEventFeed.ts");
  assert.match(feed, /allowMockFallback = postGradFlags.mocks/);
});

test("Watch Live Round is a card dropdown of the same Battle Wall modules", () => {
  const card = readSrc("../../components/arena/TournamentEventCard.tsx");
  const panel = readSrc("../../components/arena/TournamentLiveRoundBattles.tsx");
  const drawer = readSrc("../../components/arena/TournamentLiveRoundDrawer.tsx");
  const liveModal = readSrc("../../components/arena/TournamentLiveOverviewModal.tsx");
  assert.match(card, /data-tournament-watch-live-round/);
  assert.match(card, /data-tournament-live-round-dropdown/);
  assert.match(card, /TournamentLiveRoundPanel/);
  assert.match(card, /Watch live round/);
  assert.match(panel, /<BattleWallModule/);
  assert.match(panel, /postGradFlags.mocks/);
  assert.match(drawer, /TournamentLiveRoundBattles/);
  assert.match(liveModal, /Watch live round/);
  assert.match(liveModal, /liveBattleIds.length/);
});

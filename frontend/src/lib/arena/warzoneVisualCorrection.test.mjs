import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { presentChampionship, presentSymmetricBracket } from "./tournamentBracketPresentation.mjs";
import { getMockTournamentDetails } from "../../features/postgrad/mockTournamentFixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

test("production artwork never ticker-matches mock portraits", () => {
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const preview = readSrc("../../components/warzone/WarzoneBattlePreview.tsx");
  assert.doesNotMatch(combatant, /mockTokenArtForTicker|MOCK_TOKEN_ART/);
  assert.doesNotMatch(preview, /mockTokenArtForTicker|MOCK_TOKEN_ART/);
  assert.match(combatant, /participant\?\.imageUrl \|\| participant\?\.logoUri/);
  assert.match(preview, /participant\?\.imageUrl \|\| participant\?\.logoUri/);
});

test("Battle combatant height is content-bounded and bleed is decorative", () => {
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  assert.match(combatant, /data-battle-combatant-bounded="true"/);
  assert.match(combatant, /h-auto max-h-\[22rem\]/);
  assert.match(combatant, /h-\[6\.75rem\]/);
  assert.match(combatant, /md:h-\[8\.5rem\]/);
  assert.match(combatant, /data-battle-combatant-bleed="true"/);
  assert.match(combatant, /absolute inset-0 z-0/);
  assert.doesNotMatch(combatant, /100vh|min-h-screen|h-screen/);
  assert.doesNotMatch(combatant, /data-selected=\{isLeader/);
  assert.match(moduleSrc, /md:items-start/);
});

test("canonical Warzone routes remain unchanged", () => {
  const app = readSrc("../../App.tsx");
  assert.match(app, /path="\/warzone"/);
  assert.match(app, /path="\/warzone\/battles"/);
  assert.match(app, /path="\/warzone\/battles\/:battleId"/);
  assert.match(app, /path="\/warzone\/tournaments"/);
  assert.match(app, /path="\/warzone\/tournaments\/:tournamentId"/);
  assert.match(app, /path="\/warzone\/tournament\/:id"/);
  assert.match(app, /path="\/warzone\/major-war-league"/);
  assert.match(app, /path="\/battle\/:id"/);
});

test("public copy no longer explains implementation internals", () => {
  const files = [
    readSrc("../../pages/Arena.tsx"),
    readSrc("../../pages/PostGradLeague.tsx"),
    readSrc("../../pages/ArenaTournaments.tsx"),
    readSrc("../../components/arena/TournamentCommand.tsx"),
    readSrc("../../components/arena/TournamentEventCard.tsx"),
  ];
  for (const src of files) {
    assert.doesNotMatch(src, /Post-grad command|POST-GRAD COMMAND/);
    assert.doesNotMatch(src, /Weekly table for graduated/);
    assert.doesNotMatch(src, /Prize Leagues stay on \/league/);
    assert.doesNotMatch(src, /Win 3 \/ loss 1 \/ draw 0/);
    assert.doesNotMatch(src, /shared Battle telemetry engine/);
    assert.doesNotMatch(src, /treasury address in this environment/);
    assert.doesNotMatch(src, /same Warzone feed/);
  }
});

test("MWL champion is not a selected-state control", () => {
  const league = readSrc("../../pages/PostGradLeague.tsx");
  assert.match(league, /data-warzone-mwl-champion="true"/);
  assert.doesNotMatch(league, /data-selected="true"/);
  assert.match(league, /The monthly fight for Warzone supremacy/);
});

test("bracket modal uses current rounds and does not invent a champion", () => {
  const modal = readSrc("../../components/arena/TournamentBracketModal.tsx");
  const command = readSrc("../../components/arena/TournamentCommand.tsx");
  assert.match(command, /TournamentBracketModal/);
  assert.match(modal, /presentSymmetricBracket/);
  assert.match(modal, /champion \?/);
  assert.doesNotMatch(modal, /inferred|guess|leaderSide/);

  const live = getMockTournamentDetails("event-tournament-live-04");
  const presented = presentSymmetricBracket(live.bracket.rounds, {});
  assert.equal(presented.empty, false);
  assert.equal(presented.championship.champion, null);
  assert.equal(presentChampionship({ tokenA: "a", tokenB: "b", winner: null }).champion, null);
  assert.equal(presentChampionship({ tokenA: "a", tokenB: "b", winner: "a" }).champion.tokenAddress, "a");
});

test("mock tournament fixture supplies 16-entrant live bracket without injecting into API mode", () => {
  const command = readSrc("../../components/arena/TournamentCommand.tsx");
  const details = getMockTournamentDetails("event-tournament-live-04");
  assert.equal(details.entries.length, 16);
  assert.equal(details.bracket.rounds[0].matches.length, 8);
  assert.equal(details.bracket.rounds[3].matches.length, 1);
  assert.equal(details.bracket.rounds[3].matches[0].winner, null);
  assert.match(command, /postGradFlags\.mocks \? getMockTournamentDetails/);
});

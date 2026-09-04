import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  WARZONE_CONTENT_MAX_CLASS,
  WARZONE_CONTENT_MAX_WIDTH_PX,
  presentWarzoneCommandStrip,
  presentWarzoneLeagueBoard,
  presentWarzoneLeagueEmpty,
  presentWarzoneLeagueStatus,
} from "./warzoneChrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

test("Warzone pages share the same centered content width", () => {
  const frame = readSrc("../../components/warzone/WarzoneContent.tsx");
  const overview = readSrc("../../pages/Arena.tsx");
  const battles = readSrc("../../pages/ArenaBattles.tsx");
  const league = readSrc("../../pages/PostGradLeague.tsx");
  const tournaments = readSrc("../../pages/ArenaTournaments.tsx");
  const details = readSrc("../../components/arena/TournamentCommand.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");

  assert.equal(WARZONE_CONTENT_MAX_WIDTH_PX, 1280);
  assert.equal(WARZONE_CONTENT_MAX_CLASS, "max-w-[1280px]");
  assert.match(frame, /data-warzone-content="true"/);
  assert.match(frame, /max-w-\[1280px\]/);
  assert.match(frame, /maxWidth:\s*1280/);
  assert.doesNotMatch(frame, /WARZONE_CONTENT_MAX_CLASS/);
  assert.match(frame, /px-3/);
  assert.match(frame, /md:px-4/);
  for (const src of [overview, battles, league, tournaments]) {
    assert.match(src, /WarzoneContent/);
    assert.doesNotMatch(src, /ContentContainer/);
  }
  assert.doesNotMatch(details, /ContentContainer/);
  assert.match(details, /data-tournament-command/);
  assert.doesNotMatch(battles, /max-w-full space-y-4/);
  assert.match(combatant, /data-battle-combatant-split="true"/);
  assert.match(combatant, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
  assert.match(combatant, /aspect-square/);
  assert.match(combatant, /self-stretch/);
});

test("Overview still reads existing feeds and does not add battle realtime", () => {
  const overview = readSrc("../../pages/Arena.tsx");
  const preview = readSrc("../../components/warzone/WarzoneBattlePreview.tsx");
  assert.match(overview, /useArenaBattleFeed/);
  assert.match(overview, /useArenaFeedBattleMetrics/);
  assert.match(overview, /useArenaEventFeed/);
  assert.match(overview, /useArenaLeagueFeed/);
  assert.match(overview, /useArenaFeaturedVotes/);
  assert.match(overview, /ArenaUpvoteDialog/);
  assert.match(overview, /WarzoneBattlePreview/);
  assert.match(overview, /data-warzone-featured="true"/);
  assert.match(overview, /data-warzone-active-battles/);
  assert.match(overview, /data-warzone-overview-pillars/);
  assert.match(overview, /data-warzone-mwl-preview/);
  assert.ok(overview.indexOf("data-warzone-featured") < overview.indexOf("data-warzone-active-battles"));
  assert.doesNotMatch(overview, /Post-grad command|treasury address/);
  assert.doesNotMatch(overview, /useBattleWallRealtime|useAblyBattleChannel|BattleCombatEffects/);
  assert.match(preview, /presentBattleWallModule/);
  assert.match(preview, /presented\.href/);
  assert.doesNotMatch(preview, /\/battle\//);
  assert.doesNotMatch(preview, /useBattleWallRealtime|BattleCombatEffects/);
});

test("MWL standings, token links, and Quarter Finals route stay authoritative", () => {
  const league = readSrc("../../pages/PostGradLeague.tsx");
  const board = presentWarzoneLeagueBoard([
    { tokenId: "a", tokenName: "Alpha", symbol: "ALPHA", points: 144, wins: 12, losses: 2, finishedFights: 14, movement: "promoted" },
    { tokenId: "b", tokenName: "Bravo", symbol: "BRAVO", points: 131, wins: 10, losses: 3, finishedFights: 13, movement: "safe" },
    { tokenId: "c", tokenName: "Charlie", symbol: "CHAR", points: 118, wins: 8, losses: 4, finishedFights: 12, movement: "safe" },
    { tokenId: "d", tokenName: "Delta", symbol: "DELT", points: 94, wins: 7, losses: 6, finishedFights: 0, movement: "relegated" },
  ]);
  assert.equal(board.podium.length, 3);
  assert.equal(board.podium[0].points, 144);
  assert.equal(board.podium[0].wins, 12);
  assert.equal(board.table[0].rank, 4);
  assert.equal(board.table[0].points, 94);
  assert.equal(board.table[0].finishedFights, 0);
  assert.equal(presentWarzoneLeagueStatus(board.podium[0]), "PROMOTED");
  assert.equal(presentWarzoneLeagueStatus(board.podium[1]), null);
  assert.equal(presentWarzoneLeagueStatus(board.table[0]), "RELEGATED");
  assert.match(league, /getArenaTokenRoute/);
  assert.match(league, /\/warzone\/tournaments\/\$\{encodeURIComponent\(quarterFinalsId\)\}/);
  assert.match(league, /Enter Quarter Finals/);
  assert.equal(presentWarzoneLeagueEmpty("empty").kind, "unavailable");
  assert.equal(presentWarzoneLeagueEmpty("api").kind, "initializing");
  assert.match(league, /data-warzone-mwl-podium/);
  assert.match(league, /data-warzone-mwl-table/);
});

test("Warzone composition keeps cards floating without outer frames", () => {
  const overview = readSrc("../../pages/Arena.tsx");
  const league = readSrc("../../pages/PostGradLeague.tsx");
  const header = readSrc("../../components/warzone/WarzonePageHeader.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  const battles = readSrc("../../pages/ArenaBattles.tsx");

  assert.doesNotMatch(header, /mwz-hud-frame/);
  assert.doesNotMatch(moduleSrc, /mwz-hud-frame/);
  assert.match(moduleSrc, /data-battle-wall-open="true"/);
  assert.match(combatant, /mwz-flat-card/);
  assert.match(combatant, /data-battle-combatant-bleed/);
  assert.match(combatant, /data-battle-combatant-readability/);
  assert.match(vs, /data-battle-vs-reticle="true"/);
  assert.match(vs, /bg-transparent/);
  assert.doesNotMatch(vs, /data-battle-deployment-hud/);
  assert.doesNotMatch(overview, /mwz-hud-frame/);
  assert.match(overview, /mwz-flat-card/);
  assert.doesNotMatch(league, /mwz-hud-frame/);
  assert.match(league, /data-warzone-mwl-table/);
  assert.doesNotMatch(battles, /section className="mwz-hud-frame/);
});

test("Slice A does not invent money, Vote Tournament, or Battle formulas", () => {
  const files = [
    readSrc("./warzoneChrome.mjs"),
    readSrc("../../pages/Arena.tsx"),
    readSrc("../../pages/PostGradLeague.tsx"),
    readSrc("../../components/warzone/WarzoneBattlePreview.tsx"),
    readSrc("../../components/warzone/WarzoneContent.tsx"),
  ];
  for (const src of files) {
    assert.doesNotMatch(src, /calculateBattlePoints|50\/30\/20|45\/27\/18|war_pool_v|75\/20\/5|85\/5\/10/);
    assert.doesNotMatch(src, /Vote Tournament|Final Salvo|Battle Boost/);
  }
  const strip = presentWarzoneCommandStrip({ liveBattleCount: 2, liveTournamentCount: 1, season: { week: 4, label: "Season One" } });
  assert.equal(strip.liveBattleCount, 2);
  assert.equal(strip.week, 4);
});

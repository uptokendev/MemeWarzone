import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  WARZONE_CONTENT_MAX_CLASS,
  WARZONE_CONTENT_MAX_WIDTH_PX,
  presentLeaguePhase,
  presentOwnedLeagueTokens,
  presentQuarterFinalField,
  presentRankedLeagueEntries,
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
  assert.match(league, /tournamentHref\(quarterFinalsId\)/);
  assert.match(league, /View Quarter Finals/);
  assert.equal(presentWarzoneLeagueEmpty("empty").kind, "unavailable");
  assert.equal(presentWarzoneLeagueEmpty("api").kind, "initializing");
  assert.match(league, /data-warzone-mwl-podium/);
  assert.match(league, /data-warzone-mwl-table/);
  assert.match(league, /data-warzone-mwl-your-tokens/);
  assert.match(league, /data-mwl-qualification-cut/);
  assert.doesNotMatch(league, /Quarterly Championship/);
  assert.doesNotMatch(league, /Enter Quarter Finals/);
  assert.doesNotMatch(league, /Quarter Finals open when the season table is frozen/);
});

test("MWL public table is Top 10, Your Tokens keep real off-table ranks, and QF projection stays labeled", () => {
  const ranked = presentRankedLeagueEntries([
    { tokenId: "a", tokenName: "Alpha", symbol: "AAA", points: 144, wins: 12, losses: 2, finishedFights: 14 },
    { tokenId: "b", tokenName: "Bravo", symbol: "BBB", points: 131, wins: 11, losses: 3, finishedFights: 14 },
    { tokenId: "c", tokenName: "Charlie", symbol: "CCC", points: 118, wins: 9, losses: 4, finishedFights: 13 },
    { tokenId: "d", tokenName: "Delta", symbol: "DDD", points: 104, wins: 8, losses: 4, finishedFights: 12 },
    { tokenId: "e", tokenName: "Echo", symbol: "EEE", points: 98, wins: 7, losses: 4, finishedFights: 11 },
    { tokenId: "f", tokenName: "Foxtrot", symbol: "FFF", points: 94, wins: 7, losses: 5, finishedFights: 12 },
    { tokenId: "g", tokenName: "Golf", symbol: "GGG", points: 88, wins: 6, losses: 5, finishedFights: 11 },
    { tokenId: "h", tokenName: "Hotel", symbol: "HHH", points: 76, wins: 6, losses: 6, finishedFights: 12 },
    { tokenId: "i", tokenName: "India", symbol: "III", points: 73, wins: 5, losses: 6, finishedFights: 11 },
    { tokenId: "j", tokenName: "Juliet", symbol: "JJJ", points: 71, wins: 5, losses: 6, finishedFights: 11 },
    { tokenId: "k", tokenName: "Kilo", symbol: "KKK", points: 70, wins: 4, losses: 6, finishedFights: 10 },
    { tokenId: "mwl-mycoin", tokenName: "My Coin", symbol: "MYCOIN", points: 64, wins: 4, losses: 5, finishedFights: 9 },
    { tokenId: "mwl-second", tokenName: "Second Coin", symbol: "SECOND", points: 21, wins: 1, losses: 7, finishedFights: 8 },
  ]);
  const board = presentWarzoneLeagueBoard(ranked);
  assert.equal(board.podium.length, 3);
  assert.equal(board.podium[0].rank, 1);
  assert.equal(board.table.length, 7);
  assert.equal(board.table[0].rank, 4);
  assert.equal(board.table[board.table.length - 1].rank, 10);
  assert.equal(board.table.some((entry) => entry.rank === 11), false);
  assert.equal(board.ranked.find((entry) => entry.tokenId === "mwl-mycoin").rank, 12);
  const yours = presentOwnedLeagueTokens(board.ranked, ["mwl-mycoin", "mwl-second", "a"]);
  assert.equal(yours.length, 3);
  assert.equal(yours.some((entry) => entry.rank === 1), true);
  assert.equal(yours.find((entry) => entry.tokenId === "mwl-mycoin").rank, 12);
  assert.equal(yours.find((entry) => entry.tokenId === "mwl-second").rank, 13);
  const projected = presentQuarterFinalField({ state: "live" }, ranked);
  assert.equal(projected.phase.projected, true);
  assert.equal(projected.label, "PROJECTED QUALIFIERS · LIVE");
  assert.equal(projected.field.length, 8);
  assert.equal(projected.cut.inside.rank, 8);
  assert.equal(projected.cut.outside.rank, 9);
  const official = presentQuarterFinalField({ state: "quarter_finals", quarterFinalsTournamentId: "qf-1", frozenAt: "2026-05-01T00:00:00.000Z" }, ranked);
  assert.equal(official.phase.projected, false);
  assert.equal(official.label, "QUARTER FINALISTS");
  assert.equal(official.tournamentId, "qf-1");
  assert.equal(presentLeaguePhase({ state: "live" }).label, "LIVE");
  const truncated = presentOwnedLeagueTokens(presentRankedLeagueEntries(ranked.slice(0, 10)), ["mwl-mycoin"]);
  assert.equal(truncated.length, 0);
  const mockReg = readSrc("../../features/postgrad/mockRegistry.ts");
  const apiClient = readSrc("../../features/postgrad/apiClient.ts");
  const feed = readSrc("../../hooks/useArenaLeagueFeed.ts");
  assert.match(mockReg, /mwl-mycoin/);
  assert.match(mockReg, /mwl-second/);
  assert.match(mockReg, /MOCK_LEAGUE_OWNED_TOKEN_IDS/);
  assert.doesNotMatch(apiClient, /mwl-mycoin|MOCK_LEAGUE_OWNED_TOKEN_IDS/);
  assert.match(feed, /MOCK_LEAGUE_OWNED_TOKEN_IDS/);
  assert.match(feed, /source === "qa-runtime"/);
  assert.match(feed, /fetchPostGradLeagueFeed\(signal, options\)/);
  const page = readSrc("../../pages/PostGradLeague.tsx");
  assert.match(page, /WarzoneRankCard/);
  assert.match(page, /data-warzone-mwl-your-tokens/);
  assert.match(page, /quarterFinals\.label/);
  assert.match(readSrc("./warzoneChrome.mjs"), /PROJECTED QUALIFIERS · LIVE/);
  assert.match(page, /tournamentHref/);
  assert.doesNotMatch(page, /Quarterly Championship/);
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

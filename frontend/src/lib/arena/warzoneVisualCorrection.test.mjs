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

test("Battle combatant bleed is an absolute decorative layer outside card flow", () => {
  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const layer = readSrc("../../components/warzone/WarzoneDecorativeLayer.tsx");
  const css = readSrc("../../styles/card-cleanup.css");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  assert.match(layer, /data-mwz-decorative-layer="true"/);
  assert.match(layer, /position: "absolute"/);
  assert.match(layer, /inset: 0/);
  assert.match(layer, /zIndex: 0/);
  assert.match(css, /\.mwz-app-shell \.mwz-flat-card > \[data-mwz-decorative-layer\]/);
  assert.match(css, /position: absolute !important/);
  assert.match(css, /z-index: 0 !important/);
  assert.match(combatant, /WarzoneDecorativeLayer/);
  assert.match(combatant, /data-battle-combatant-bounded="true"/);
  assert.match(combatant, /h-auto max-h-\[22rem\]/);
  assert.match(combatant, /aspect-square/);
  assert.match(combatant, /h-0 min-h-full w-auto shrink-0 self-stretch/);
  assert.match(combatant, /data-battle-combatant-bleed="true"/);
  assert.match(combatant, /absolute inset-0 z-0/);
  assert.match(combatant, /<WarzoneDecorativeLayer[\s\S]*data-battle-combatant-bleed="true"/);
  assert.doesNotMatch(combatant, /100vh|min-h-screen|h-screen/);
  assert.doesNotMatch(combatant, /data-selected=\{isLeader/);
  assert.match(moduleSrc, /md:items-center/);
});

test("WarzoneContent emits a static 1280px max width Tailwind can scan", () => {
  const frame = readSrc("../../components/warzone/WarzoneContent.tsx");
  const css = readSrc("../../styles/card-cleanup.css");
  assert.match(frame, /max-w-\[1280px\]/);
  assert.match(frame, /maxWidth:\s*1280/);
  assert.doesNotMatch(frame, /WARZONE_CONTENT_MAX_CLASS/);
  assert.match(css, /data-mwz-decorative-layer/);
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

test("Overview puts Featured first and three balanced pillar modules below", () => {
  const overview = readSrc("../../pages/Arena.tsx");
  const preview = readSrc("../../components/warzone/WarzoneBattlePreview.tsx");
  const featured = overview.indexOf('data-warzone-featured="true"');
  const pillars = overview.indexOf('data-warzone-overview-pillars="true"');
  const battles = overview.indexOf('data-warzone-active-battles="true"');
  const tournaments = overview.indexOf("data-warzone-tournament-preview");
  const mwl = overview.indexOf('data-warzone-mwl-preview="true"');
  assert.ok(featured >= 0 && pillars > featured);
  assert.ok(battles > pillars && tournaments > pillars && mwl > pillars);
  assert.match(overview, /lg:grid-cols-3/);
  assert.match(overview, /lg:items-stretch/);
  assert.doesNotMatch(preview, /scale-110 object-cover opacity-\[0\.12\] blur/);
  assert.doesNotMatch(preview, /mwz-flat-card/);
  assert.match(preview, /participant\?\.tokenName/);
  assert.match(preview, /BattleVsMark/);
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

test("MWL top 3 share WarzoneRankCard and #1 is not a giant bleed card", () => {
  const league = readSrc("../../pages/PostGradLeague.tsx");
  const overview = readSrc("../../pages/Arena.tsx");
  const rankCard = readSrc("../../components/warzone/WarzoneRankCard.tsx");
  assert.match(league, /WarzoneRankCard/);
  assert.match(overview, /WarzoneRankCard/);
  assert.match(league, /rank=\{1\}/);
  assert.match(league, /rank=\{2\}/);
  assert.match(league, /rank=\{3\}/);
  assert.match(rankCard, /data-warzone-rank-card=\{rank\}/);
  assert.match(rankCard, /data-warzone-mwl-champion=\{champion \? "true"/);
  assert.doesNotMatch(rankCard, /blur-\[12px\]|object-cover opacity-\[0\.14\]/);
  assert.doesNotMatch(league, /data-selected="true"/);
  assert.doesNotMatch(league, /md:col-start-2 md:row-start-1/);
  assert.match(league, /The monthly fight for Warzone supremacy/);
});

test("Battle VS mark is a close overlapping pair, not opposite-corner Pixeboy", () => {
  const vs = readSrc("../../components/arena/BattleWallVs.tsx");
  assert.match(vs, /data-battle-vs-reticle="true"/);
  assert.match(vs, /data-battle-vs-mark="true"/);
  assert.match(vs, /font-black/);
  assert.match(vs, /font-sans/);
  assert.match(vs, /md:text-\[3\.75rem\]/);
  assert.doesNotMatch(vs, /font-retro/);
  assert.doesNotMatch(vs, /left-0\.5 top-0/);
  assert.doesNotMatch(vs, /bottom-0 right-0\.5/);
  assert.match(vs, /translate\(-72%, -62%\)/);
  assert.match(vs, /translate\(-28%, -38%\)/);
});

test("Tournament enter opens a details modal and View Bracket never page-hops", () => {
  const page = readSrc("../../pages/ArenaTournaments.tsx");
  const card = readSrc("../../components/arena/TournamentEventCard.tsx");
  const modal = readSrc("../../components/arena/TournamentDetailsModal.tsx");
  const registration = readSrc("../../components/arena/TournamentRegistrationModal.tsx");
  const identity = readSrc("../../components/arena/TournamentTokenIdentity.tsx");
  assert.match(page, /TournamentRegistrationModal/);
  assert.match(page, /setLocalModal\(\{ kind: "registration", id \}\)/);
  assert.match(page, /navigate\("\/warzone\/tournaments", \{ replace: true \}\)/);
  assert.doesNotMatch(page, /\{focusedId \? <TournamentCommand/);
  assert.doesNotMatch(page, /data-tournament-standings/);
  assert.match(modal, /TournamentRegistrationModal/);
  assert.match(registration, /data-tournament-registration-modal="true"/);
  assert.match(registration, /signArenaWalletAction|handleOptIn/);
  assert.match(card, /fetchPostGradTournamentDetails/);
  assert.match(card, /data-tournament-view-bracket/);
  assert.match(card, /TournamentProgressionBar/);
  assert.doesNotMatch(card, /canOpenBracket \?/);
  assert.doesNotMatch(card, />View bracket<\/Link>/);
  assert.match(identity, /LOADING TOKEN/);
  assert.match(identity, /profile\?\.symbol \|\| symbol/);
  assert.doesNotMatch(identity, /Loading token profile/);
});

test("Warzone Featured reuses the exact Pre-Grad FeaturedCampaignCard", () => {
  const overview = readSrc("../../pages/Arena.tsx");
  const showcase = readSrc("../../components/home/SafeFeaturedCampaigns.tsx");
  const card = readSrc("../../components/home/FeaturedCampaignCard.tsx");
  assert.match(overview, /FeaturedCampaignCard/);
  assert.match(overview, /ArenaUpvoteDialog/);
  assert.match(showcase, /FeaturedCampaignCard/);
  assert.match(card, /h-\[150px\]/);
  assert.match(card, /w-\[150px\]/);
  assert.match(card, /data-featured-campaign-card="true"/);
  assert.doesNotMatch(overview, /WarzoneTokenMark imageUrl=\{item\.imageUrl\}/);
});

test("bracket modal uses current rounds, fight links, and does not invent a champion", () => {
  const modal = readSrc("../../components/arena/TournamentBracketModal.tsx");
  const card = readSrc("../../components/arena/TournamentEventCard.tsx");
  assert.match(card, /TournamentBracketModal/);
  assert.match(modal, /presentSymmetricBracket/);
  assert.match(modal, /champion \?/);
  assert.match(modal, /battleFightHref\(match\.battleId\)/);
  assert.doesNotMatch(modal, /to=\{`\/battle\//);
  assert.doesNotMatch(modal, /inferred|guess|leaderSide/);

  const live = getMockTournamentDetails("event-tournament-live-04");
  const presented = presentSymmetricBracket(live.bracket.rounds, {});
  assert.equal(presented.empty, false);
  assert.equal(presented.championship.champion, null);
  assert.equal(presentChampionship({ tokenA: "a", tokenB: "b", winner: null }).champion, null);
  assert.equal(presentChampionship({ tokenA: "a", tokenB: "b", winner: "a" }).champion.tokenAddress, "a");
});

test("Live Tournament modal uses telemetry-confirmed live Battles only", () => {
  const liveModal = readSrc("../../components/arena/TournamentLiveOverviewModal.tsx");
  const registration = readSrc("../../components/arena/TournamentRegistrationModal.tsx");
  const results = readSrc("../../components/arena/TournamentResultsModal.tsx");
  const hook = readSrc("../../hooks/useTournamentCommandState.ts");
  const drawer = readSrc("../../components/arena/TournamentLiveRoundDrawer.tsx");
  const card = readSrc("../../components/arena/TournamentEventCard.tsx");
  assert.match(liveModal, /loadMetrics: true/);
  assert.match(liveModal, /open \? tournamentId : ""/);
  assert.match(liveModal, /data-tournament-watch-live-round/);
  assert.match(liveModal, /TournamentLiveRoundDrawer/);
  assert.doesNotMatch(liveModal, /View live battles/);
  assert.match(card, /data-tournament-watch-live-round=\{card\.id\}/);
  assert.match(card, /TournamentLiveRoundPanel/);
  assert.match(card, /data-tournament-live-round-dropdown/);
  assert.match(registration, /loadMetrics: false/);
  assert.match(results, /loadMetrics: false/);
  assert.match(hook, /presentConfirmedLiveBattles/);
  assert.match(drawer, /TournamentLiveRoundBattles/);
  assert.match(drawer, /data-tournament-live-round-drawer/);
});

test("mock tournament fixture supplies 16-entrant live bracket without injecting into API mode", () => {
  const hook = readSrc("../../hooks/useTournamentCommandState.ts");
  const details = getMockTournamentDetails("event-tournament-live-04");
  assert.equal(details.entries.length, 16);
  assert.equal(details.bracket.rounds[0].matches.length, 8);
  assert.equal(details.bracket.rounds[3].matches.length, 1);
  assert.equal(details.bracket.rounds[3].matches[0].winner, null);
  assert.match(hook, /postGradFlags\.mocks \? getMockTournamentDetails/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  battleFightHref,
  presentConfirmedLiveBattles,
  presentTournamentCard,
  presentTournamentChampion,
  presentTournamentEmpty,
  presentTournamentMode,
  presentTournamentProgression,
  presentTournamentRegistration,
  presentTournamentStandingsEmpty,
  tournamentHref,
} from "./tournamentCommandPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

test("canonical tournament routes use the focused command surface", () => {
  const app = readSrc("../../App.tsx");
  const page = readSrc("../../pages/ArenaTournaments.tsx");
  const command = readSrc("../../components/arena/TournamentCommand.tsx");
  const details = readSrc("../../pages/TournamentDetails.tsx");
  const overview = readSrc("../../pages/Arena.tsx");
  const league = readSrc("../../pages/PostGradLeague.tsx");

  assert.equal(tournamentHref("tour-9"), "/warzone/tournaments/tour-9");
  assert.equal(battleFightHref("fight-1"), "/warzone/battles/fight-1");
  assert.match(app, /path="\/warzone\/tournaments"/);
  assert.match(app, /path="\/warzone\/tournaments\/:tournamentId"/);
  assert.match(app, /path="\/warzone\/tournament\/:id"/);
  assert.match(app, /path="\/tournament\/:id"/);
  assert.match(app, /Navigate to=\{`\/warzone\/tournaments\/\$\{encodeURIComponent\(String\(id \|\| ""\)\)\}`\}/);
  assert.match(page, /useParams/);
  assert.match(page, /useNavigate/);
  assert.match(page, /TournamentRegistrationModal/);
  assert.match(page, /navigate\("\/warzone\/tournaments"/);
  assert.match(page, /data-warzone-tournaments/);
  assert.doesNotMatch(page, /\{focusedId \? <TournamentCommand/);
  assert.doesNotMatch(page, /data-tournament-standings/);
  assert.doesNotMatch(page, /data-tournament-opt-in/);
  const hook = readSrc("../../hooks/useTournamentCommandState.ts");
  assert.match(hook, /optInPostGradTournament/);
  assert.match(hook, /signArenaWalletAction/);
  assert.match(hook, /action: "arena_tournament_opt_in"/);
  const registration = readSrc("../../components/arena/TournamentRegistrationModal.tsx");
  const resultsModal = readSrc("../../components/arena/TournamentResultsModal.tsx");
  assert.match(registration, /ArenaBuyInButton/);
  assert.match(registration, /data-tournament-opt-in/);
  assert.match(resultsModal, /CLAIM TOURNAMENT REWARDS/);
  assert.match(details, /TournamentCommand/);
  const modal = readSrc("../../components/arena/TournamentDetailsModal.tsx");
  assert.match(modal, /TournamentRegistrationModal/);
  assert.doesNotMatch(modal, /TournamentCommand/);
  assert.match(overview, /TournamentEventCard/);
  assert.match(overview, /\/warzone\/tournaments/);
  assert.match(league, /\/warzone\/tournaments\/\$\{encodeURIComponent\(quarterFinalsId\)\}/);
});

test("tournament cards only present authoritative fields and never fabricate boost or vote UI", () => {
  const card = presentTournamentCard({
    id: "t1",
    title: "Rookie Crown Qualifier",
    status: "scheduled",
    startsAt: "2026-09-04T22:00:00.000Z",
    endsAt: "2026-09-05T22:00:00.000Z",
    participantCount: 16,
    summary: "",
    chainId: 56,
    bracketStage: "registration",
    buyInNative: 0.1,
    nativeSymbol: "BNB",
  });
  assert.equal(card.href, "/warzone/tournaments/t1");
  assert.equal(card.status.label, "UPCOMING");
  assert.equal(card.chain.label, "BNB");
  assert.equal(card.registration.label, "REGISTRATION OPEN");
  assert.equal(card.participantLabel, "16 COINS");
  assert.equal(card.buyIn.label, "0.1 BNB");
  assert.equal(presentTournamentMode({ battleMode: "vote" }).key, "vote");
  assert.equal(presentTournamentMode({ battleMode: "normal" }).key, "normal");
  assert.equal(presentTournamentMode({ battleMode: "boost" }), null);
  assert.equal(presentTournamentRegistration({}), null);
  assert.equal(presentTournamentEmpty("live", "api").title, "NO LIVE TOURNAMENTS");
  assert.equal(presentTournamentStandingsEmpty().title, "STANDINGS INITIALIZING");

  const files = [
    readSrc("../../pages/ArenaTournaments.tsx"),
    readSrc("../../components/arena/TournamentCommand.tsx"),
    readSrc("../../components/arena/TournamentEventCard.tsx"),
    readSrc("./tournamentCommandPresentation.mjs"),
  ];
  for (const src of files) {
    assert.doesNotMatch(src, /normal \/ boost|Battle Boost|Final Salvo/);
    assert.doesNotMatch(src, /85%|75%|5% protocol|10% Major/);
    assert.doesNotMatch(src, /WarPoolPanel/);
  }
});

test("tournament command preserves opt-in, buy-in, claims, standings, bracket, and matches without extra realtime", () => {
  const hook = readSrc("../../hooks/useTournamentCommandState.ts");
  const matchCard = readSrc("../../components/arena/TournamentMatchCard.tsx");
  const page = readSrc("../../pages/ArenaTournaments.tsx");
  const registration = readSrc("../../components/arena/TournamentRegistrationModal.tsx");

  assert.match(hook, /signArenaWalletAction/);
  assert.match(hook, /action: "arena_tournament_opt_in"/);
  assert.match(registration, /ArenaBuyInButton/);
  assert.match(hook, /fetchArenaBattleMetrics/);
  assert.match(hook, /setInterval\(\(\) => void load\(\), 15_000\)/);
  assert.match(hook, /loadMetrics/);
  assert.doesNotMatch(page, /useAblyBattleChannel|useBattleWallRealtime/);
  assert.doesNotMatch(page, /mwz-hud-frame/);
  assert.match(matchCard, /mwz-flat-card/);
  assert.match(matchCard, /battleFightHref/);
  assert.doesNotMatch(matchCard, /\/battle\//);
  assert.match(page, /WarzoneContent/);
  assert.match(page, /Upcoming/);
  assert.match(page, /Live/);
  assert.match(page, /Results/);
});

test("progression and champion stay authoritative", () => {
  const upcoming = presentTournamentProgression({ cap: 16, bracketStage: "registration" });
  assert.equal(upcoming.nodes.map((node) => node.size).join(","), "16,8,4,2,1");
  assert.equal(upcoming.nodes[0].current, true);
  assert.equal(upcoming.nodes.every((node) => !node.complete), true);
  assert.equal(presentTournamentChampion({ status: "completed" }), null);
  const eight = presentTournamentProgression({ cap: 8, bracketStage: "semifinals" });
  assert.equal(eight.nodes[0].size, 8);
  const card = presentTournamentCard({
    id: "t1",
    title: "Rookie Crown Qualifier",
    status: "scheduled",
    startsAt: "2026-05-23T20:00:00.000Z",
    participantCount: 16,
    chainId: 56,
    bracketStage: "registration",
    buyInNative: 0.1,
    nativeSymbol: "BNB",
    cap: 16,
  });
  assert.equal(card.primaryCta, "Enter tournament");
  assert.equal(card.bracketCta, "View bracket");
});

test("confirmed live Battles require telemetry state live, not merely an unsettled match", () => {
  const unsettled = [
    { id: "m1", tokenA: "a", tokenB: "b", battleId: "fight-scheduled", winner: null, bye: false },
    { id: "m2", tokenA: "c", tokenB: "d", battleId: "fight-live", winner: null, bye: false },
    { id: "m3", tokenA: "e", tokenB: "f", battleId: "fight-won", winner: "e", bye: false },
    { id: "m4", tokenA: "g", tokenB: null, battleId: "fight-bye", winner: null, bye: true },
  ];
  assert.deepEqual(presentConfirmedLiveBattles(unsettled, {}), []);
  assert.deepEqual(presentConfirmedLiveBattles(unsettled, { "fight-scheduled": { state: "upcoming" } }), []);
  assert.equal(presentConfirmedLiveBattles(unsettled, { "fight-live": { state: "matched" } }).length, 0);
  const live = presentConfirmedLiveBattles(unsettled, {
    "fight-scheduled": { state: "upcoming" },
    "fight-live": { state: "live" },
    "fight-won": { state: "live" },
  });
  assert.equal(live.length, 1);
  assert.equal(live[0].battleId, "fight-live");
  assert.equal(battleFightHref(live[0].battleId), "/warzone/battles/fight-live");
});

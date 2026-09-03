import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  battleFightHref,
  presentTournamentCard,
  presentTournamentEmpty,
  presentTournamentMode,
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
  assert.match(page, /TournamentDetailsModal/);
  assert.match(page, /navigate\("\/warzone\/tournaments"/);
  assert.match(page, /data-warzone-tournaments/);
  assert.doesNotMatch(page, /\{focusedId \? <TournamentCommand/);
  assert.match(command, /optInPostGradTournament/);
  assert.match(command, /ArenaBuyInButton/);
  assert.match(command, /CLAIM TOURNAMENT REWARDS/);
  assert.match(command, /data-tournament-standings/);
  assert.match(command, /data-tournament-bracket/);
  assert.match(command, /TournamentBracketModal/);
  assert.match(command, /data-tournament-matches/);
  assert.match(command, /data-tournament-opt-in/);
  assert.match(details, /TournamentCommand/);
  const modal = readSrc("../../components/arena/TournamentDetailsModal.tsx");
  assert.match(modal, /data-tournament-details-modal/);
  assert.match(modal, /TournamentCommand/);
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
  const command = readSrc("../../components/arena/TournamentCommand.tsx");
  const matchCard = readSrc("../../components/arena/TournamentMatchCard.tsx");
  const page = readSrc("../../pages/ArenaTournaments.tsx");

  assert.match(command, /signArenaWalletAction/);
  assert.match(command, /action: "arena_tournament_opt_in"/);
  assert.match(command, /ArenaBuyInButton/);
  assert.match(command, /ArenaWarPoolClaimButton/);
  assert.match(command, /fetchArenaBattleMetrics/);
  assert.match(command, /setInterval\(\(\) => void load\(\), 15_000\)/);
  assert.match(command, /TournamentMatchCard/);
  assert.match(command, /battleFightHref/);
  assert.doesNotMatch(command, /useAblyBattleChannel|useBattleWallRealtime/);
  assert.doesNotMatch(command, /mwz-hud-frame/);
  assert.match(matchCard, /mwz-flat-card/);
  assert.match(matchCard, /battleFightHref/);
  assert.doesNotMatch(matchCard, /\/battle\//);
  assert.match(page, /WarzoneContent/);
  assert.match(page, /Upcoming/);
  assert.match(page, /Live/);
  assert.match(page, /Results/);
});

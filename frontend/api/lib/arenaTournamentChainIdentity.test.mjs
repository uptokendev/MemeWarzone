import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  chainIdFromBody,
  filterTournamentFeedByChain,
  optionalChainId,
  tournamentBelongsToChain,
} from "./arenaTournamentChainIdentity.js";

const BNB = 56;
const SOLANA = 101;
const ROBINHOOD = 4663;
const here = path.dirname(fileURLToPath(import.meta.url));
const tournamentsSource = fs.readFileSync(path.join(here, "..", "arenaTournaments.js"), "utf8");

const bnbTournament = { id: "t-bnb", chain_id: BNB };
const solTournament = { id: "t-sol", chain_id: SOLANA };
const rhTournament = { id: "t-rh", chain_id: ROBINHOOD };

test("BNB tournament is accessible only in BNB context", () => {
  assert.equal(tournamentBelongsToChain(bnbTournament, BNB), true);
  assert.equal(tournamentBelongsToChain(bnbTournament, SOLANA), false);
  assert.equal(tournamentBelongsToChain(bnbTournament, ROBINHOOD), false);
});

test("Solana and Robinhood tournaments reject BNB context", () => {
  assert.equal(tournamentBelongsToChain(solTournament, BNB), false);
  assert.equal(tournamentBelongsToChain(rhTournament, BNB), false);
});

test("feed filtering preserves only the requested chain", () => {
  const payload = {
    events: [bnbTournament, solTournament, rhTournament].map((row) => ({ ...row, chainId: row.chain_id })),
    archivedEvents: [{ ...bnbTournament, chainId: BNB }, { ...solTournament, chainId: SOLANA }],
  };
  const filtered = filterTournamentFeedByChain(payload, SOLANA);
  assert.deepEqual(filtered.events.map((row) => row.id), ["t-sol"]);
  assert.deepEqual(filtered.archivedEvents.map((row) => row.id), ["t-sol"]);
});

test("registration chain context comes from explicit body or signed auth", () => {
  assert.equal(chainIdFromBody({ chainId: BNB }), BNB);
  assert.equal(chainIdFromBody({ auth: { chainId: SOLANA } }), SOLANA);
  assert.equal(chainIdFromBody({ chain_id: ROBINHOOD }), ROBINHOOD);
  assert.throws(() => optionalChainId("not-a-chain"), /Invalid Arena chain id/);
});

test("detail lookup binds tournament id and chain id", () => {
  assert.match(tournamentsSource, /select \* from public\.arena_tournaments where id = \$1\$\{chainClause\} limit 1/);
  assert.match(tournamentsSource, /chainClause = chainId == null \? "" : " and chain_id = \$2"/);
  assert.match(tournamentsSource, /handleDetail[\s\S]*loadTournamentRow\(id, context\.chainId\)/);
});

test("registration cannot bind a wrong-chain tournament", () => {
  assert.match(tournamentsSource, /handleOptIn[\s\S]*loadTournamentRow\(id, context\.chainId\)/);
  assert.match(tournamentsSource, /insert into public\.arena_tournament_entries[\s\S]*where t\.id = \$1 and t\.chain_id = \$4/);
  assert.match(tournamentsSource, /arena_tournament_opt_in[\s\S]*chainId: Number\(row\.chain_id\)/);
});

test("payment association cannot update a wrong-chain tournament entry", () => {
  assert.match(tournamentsSource, /handleBuyInReceipt[\s\S]*loadTournamentRow\(id, context\.chainId\)/);
  assert.match(tournamentsSource, /update public\.arena_tournament_entries e[\s\S]*where t\.id = e\.tournament_id and t\.chain_id = \$4/);
  assert.match(tournamentsSource, /readSolanaArenaPool\(chainId, id, "tournament"\)/);
});

test("bracket and round lookup cannot cross chains", () => {
  assert.match(tournamentsSource, /reconcileTournamentBracket\(\{ tournamentId, battleId, chainId = null \}\)/);
  assert.match(tournamentsSource, /loadTournamentRow\(id, requestedChain, client, \{ forUpdate: true \}\)/);
  assert.match(tournamentsSource, /where id = \$1 and tournament_id = \$2 and chain_id = \$3/);
  assert.match(tournamentsSource, /where tournament_id = \$1 and chain_id = \$2 and coalesce\(source, ''\) = 'tournament'/);
});

test("winner/result settlement requires the settled Battle chain", () => {
  assert.match(tournamentsSource, /battleChain = optionalChainId\(row\?\.chain_id \?\? row\?\.chainId\)/);
  assert.match(tournamentsSource, /loadTournamentRow\(tournamentId, battleChain\)/);
  assert.match(tournamentsSource, /set status = 'finished'[\s\S]*where id = \$1 and chain_id = \$4/);
  assert.match(tournamentsSource, /set bracket = \$2::jsonb[\s\S]*where id = \$1 and chain_id = \$3/);
});

test("tournament battle creation remains row-chain specific", () => {
  assert.match(tournamentsSource, /insertTournamentBattle\(\{ chainId, tournamentId/);
  assert.match(tournamentsSource, /id, chain_id, state, source[\s\S]*values \(\$1,\$2,'live','tournament'/);
  assert.match(tournamentsSource, /captureLiveBaselines\(\{[\s\S]*chain_id: chainId/);
});

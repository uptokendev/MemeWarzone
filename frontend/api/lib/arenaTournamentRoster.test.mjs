import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isExactTournamentBracketSize, tournamentStartRoster } from "./arenaTournamentRoster.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const paid = { tokenAddress: "A", buyInPaid: true, buyInIntent: true };
const unpaid = { tokenAddress: "B", buyInPaid: false, buyInIntent: true };
const unpaidMissing = { tokenAddress: "C", buyInIntent: true };

function entries(count, { paid: paidFlag = true } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    tokenAddress: `TOKEN-${index + 1}`,
    buyInIntent: true,
    buyInPaid: paidFlag,
  }));
}

test("exact tournament bracket sizes are powers of two with at least two entrants", () => {
  for (const size of [2, 4, 8, 16, 32]) assert.equal(isExactTournamentBracketSize(size), true);
  for (const size of [0, 1, 3, 5, 6, 7, 9, 15, 17, 2.5, NaN]) assert.equal(isExactTournamentBracketSize(size), false);
});

test("new tournament start fails closed before seeding a bye", () => {
  for (const size of [0, 1, 3, 5, 6, 7]) {
    const result = tournamentStartRoster(entries(size), { buyInNative: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-bracket-size");
    assert.equal(result.code, "TOURNAMENT_EXACT_BRACKET_REQUIRED");
    assert.equal(result.participantCount, size);
    assert.deepEqual(result.roster, []);
  }
});

test("historical generation can explicitly replay a non-exact roster", () => {
  const result = tournamentStartRoster(entries(3), { buyInNative: 0, exactBracketRequired: false });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no-buy-in");
  assert.equal(result.roster.length, 3);
});

test("zero buy-in tournaments can start from an exact opted-in roster", () => {
  const result = tournamentStartRoster(entries(4), { buyInNative: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no-buy-in");
  assert.equal(result.roster.length, 4);
});

test("positive buy-in refuses to start while any entry is unpaid", () => {
  const mixed = tournamentStartRoster([paid, unpaid], { buyInNative: 0.1 });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "unpaid-roster");
  assert.equal(mixed.code, "UNPAID_TOURNAMENT_ROSTER");
  assert.equal(mixed.roster.length, 0);
  assert.equal(mixed.unpaid.length, 1);

  const missingFlag = tournamentStartRoster([paid, unpaidMissing], { buyInNative: 1 });
  assert.equal(missingFlag.ok, false);
  assert.equal(missingFlag.reason, "unpaid-roster");
});

test("positive buy-in starts only when every entry is buyInPaid", () => {
  const result = tournamentStartRoster([paid, { ...unpaid, buyInPaid: true }], { buyInNative: 0.05 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "paid");
  assert.equal(result.roster.length, 2);
});

test("handleAdminStart serializes and atomically creates the exact Round-1 bracket", () => {
  const source = fs.readFileSync(path.join(here, "../arenaTournaments.js"), "utf8");
  const handler = source.split("async function handleAdminStart")[1]?.split("export async function advanceTournamentFromBattle")[0] || "";
  assert.match(handler, /const client = await pool\.connect\(\)/);
  assert.match(handler, /client\.query\("begin"\)/);
  assert.match(handler, /loadTournamentRow\(id, context\.chainId, client, \{ forUpdate: true \}\)/);
  assert.match(handler, /TOURNAMENT_START_TIME_NOT_REACHED/);
  assert.match(handler, /tournamentStartRoster/);
  assert.match(handler, /optimizeMatchPairings/);
  assert.ok(handler.indexOf("tournamentStartRoster") < handler.indexOf("optimizeMatchPairings"));
  assert.match(handler, /TOURNAMENT_SEEDING_BYE_FORBIDDEN/);
  assert.doesNotMatch(handler, /matches\.push\([\s\S]*?bye:\s*true/);
  assert.match(handler, /db:\s*client/);
  assert.match(handler, /where id = \$1 and chain_id = \$3 and status = 'upcoming'/);
  assert.match(handler, /client\.query\("commit"\)/);
  assert.match(handler, /client\.query\("rollback"\)/);
});

test("new-generation DB authority forbids byes, early battles and concurrent roster mutation", () => {
  const migration = fs.readFileSync(
    path.join(repoRoot, "db/migrations/20260910_000001_arena_tournament_exact_bracket_control.sql"),
    "utf8",
  );
  assert.match(migration, /exact_bracket_required/);
  assert.match(migration, /CASE WHEN status = 'upcoming' THEN true ELSE false END/);
  assert.match(migration, /SET DEFAULT true/);
  assert.match(migration, /TOURNAMENT_EXACT_BRACKET_REQUIRED/);
  assert.match(migration, /TOURNAMENT_BYE_FORBIDDEN/);
  assert.match(migration, /TOURNAMENT_START_TIME_NOT_REACHED/);
  assert.match(migration, /NEW\.source = 'tournament'/);
  assert.match(migration, /enforce_arena_tournament_roster_open/);
  assert.match(migration, /FOR KEY SHARE/);
  assert.match(migration, /TOURNAMENT_REGISTRATION_CLOSED/);
  assert.match(migration, /BEFORE INSERT ON public\.arena_tournament_entries/);
  assert.match(migration, /BEFORE UPDATE OF buy_in_intent, owner_wallet ON public\.arena_tournament_entries/);
});

test("Normal Tournament battle duration is exactly 24 hours in API and DB authority", () => {
  const source = fs.readFileSync(path.join(here, "../arenaTournaments.js"), "utf8");
  const insert = source.split("async function insertTournamentBattle")[1]?.split("async function handleAdminStart")[0] || "";
  assert.match(insert, /interval '24 hours'/);
  assert.doesNotMatch(insert, /interval '12 hours'/);

  const migration = fs.readFileSync(
    path.join(repoRoot, "db/migrations/20260903_000103_arena_tournament_battle_modes.sql"),
    "utf8",
  );
  assert.match(migration, /tournament_mode = 'normal'/);
  assert.match(migration, /NEW\.ends_at := NEW\.started_at \+ interval '24 hours'/);
});

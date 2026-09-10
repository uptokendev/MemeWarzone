import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isExactTournamentBracketSize, tournamentStartRoster } from "./arenaTournamentRoster.js";

const here = path.dirname(fileURLToPath(import.meta.url));

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

test("handleAdminStart consumes tournamentStartRoster before tournament seeding", () => {
  const source = fs.readFileSync(path.join(here, "../arenaTournaments.js"), "utf8");
  const handler = source.split("async function handleAdminStart")[1]?.split("export async function advanceTournamentFromBattle")[0] || "";
  assert.match(handler, /tournamentStartRoster/);
  assert.match(handler, /optimizeMatchPairings/);
  assert.ok(handler.indexOf("tournamentStartRoster") < handler.indexOf("optimizeMatchPairings"));
  assert.match(handler, /buy_in_native/);
});

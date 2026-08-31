import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tournamentStartRoster } from "./arenaTournamentRoster.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const paid = { tokenAddress: "A", buyInPaid: true, buyInIntent: true };
const unpaid = { tokenAddress: "B", buyInPaid: false, buyInIntent: true };
const unpaidMissing = { tokenAddress: "C", buyInIntent: true };

test("zero buy-in tournaments can start from the opted-in roster", () => {
  const result = tournamentStartRoster([paid, unpaid], { buyInNative: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no-buy-in");
  assert.equal(result.roster.length, 2);
});

test("positive buy-in refuses to start while any entry is unpaid", () => {
  const mixed = tournamentStartRoster([paid, unpaid], { buyInNative: 0.1 });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "unpaid-roster");
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

test("handleAdminStart consumes tournamentStartRoster and does not seed unpaid entries", () => {
  const source = fs.readFileSync(path.join(here, "../arenaTournaments.js"), "utf8");
  const handler = source.split("async function handleAdminStart")[1]?.split("export async function advanceTournamentFromBattle")[0] || "";
  assert.match(handler, /tournamentStartRoster/);
  assert.match(handler, /UNPAID_TOURNAMENT_ROSTER/);
  assert.match(handler, /buy_in_native/);
});

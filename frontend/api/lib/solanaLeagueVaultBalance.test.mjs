import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://unused/unused";
const { leagueEpochOutstanding } = await import("./solanaLeagueVaultBalance.js");

function epochAccount(total, claimed) {
  const buf = Buffer.alloc(8 + 1 + 8 + 32 + 8 + 8 + 3);
  buf.writeBigUInt64LE(BigInt(total), 8 + 1 + 8 + 32);
  buf.writeBigUInt64LE(BigInt(claimed), 8 + 1 + 8 + 32 + 8);
  return buf;
}

test("a posted root still owes total - claimed", () => {
  // Weekly 2026-09-21 on mainnet: total 105513760, first claim 9964724.
  assert.equal(leagueEpochOutstanding(epochAccount(105_513_760n, 9_964_724n)), 95_549_036n);
  assert.equal(leagueEpochOutstanding(epochAccount(493_926n, 493_926n)), 0n);
  assert.equal(leagueEpochOutstanding(Buffer.alloc(10)), 0n);
});

test("the live pot subtracts what earlier winners are still owed", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "solanaLeagueVaultBalance.js"), "utf8");
  assert.match(src, /spendableRaw: free > outstandingRaw \? free - outstandingRaw : 0n/);
  assert.match(src, /from public\.league_epoch_roots/);
});

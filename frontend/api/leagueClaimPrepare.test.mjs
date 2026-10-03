import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 2026-10-03 ($ASK): a claim prepare recorded the prize as claimed before the wallet signed, so a
// failed claim hid the prize; and the Command Center passed the "already paid" answer on as claim
// data, which crashed as "Invalid category hash".
const league = await readFile(new URL("./league.js", import.meta.url), "utf8");
const claims = await readFile(new URL("../src/pages/command-center/CommandCenterClaims.tsx", import.meta.url), "utf8");

test("preparing a claim writes no league_epoch_claims row; only the record step does", () => {
  const claimBranch = league.split('if (action === "claim") {')[1].split('// action === "record"')[0];
  assert.doesNotMatch(claimBranch, /INSERT INTO league_epoch_claims/);
  const recordBranch = league.split('// action === "record"')[1];
  assert.match(recordBranch, /INSERT INTO league_epoch_claims/);
  assert.match(recordBranch, /INSERT INTO league_epoch_payouts/);
});

test("Command Center: an already-paid answer is not sent to the Solana claim", () => {
  assert.match(claims, /if \(json\?\.mode !== "solana_treasury"\) \{\s*if \(json\?\.txHash\) return \{ alreadyPaid: true, txHash: String\(json\.txHash\) \};/);
  assert.match(claims, /if \("alreadyPaid" in prepared\) \{/);
});

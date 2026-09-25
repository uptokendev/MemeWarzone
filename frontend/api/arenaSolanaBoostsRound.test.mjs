import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const src = fs.readFileSync(new URL("./arenaSolanaBoosts.js", import.meta.url), "utf8");

// arena_contest_actions has CHECK (round_number >= 1); battle quotes carry round_number 0. Writing the
// quote's round made every verified Solana battle boost throw after it landed on chain (2026-09-25).
test("verified Solana battle boosts are recorded as round 1, tournament rounds keep theirs", () => {
  assert.match(src, /const roundNumber = route\.product === "normal_battle" \? 1 : Number\(quote\.round_number\);/);
  assert.match(src, /quote\.battle_id, quote\.match_id, roundNumber, quote\.side/);
  assert.doesNotMatch(src, /quote\.battle_id, quote\.match_id, quote\.round_number, quote\.side/);
});

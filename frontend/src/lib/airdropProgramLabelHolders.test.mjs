// Holder payouts of gen-7's own creator vault (program "airdrop_holders_gen7") read as holder payouts, like gen-6's.
import assert from "node:assert/strict";
import test from "node:test";
import { airdropProgramKind, airdropProgramLabel, airdropRankNoun, isHolderPayoutProgram } from "./airdropProgramLabel.mjs";

test("gen-7 holder batches are holder payouts, not draws", () => {
  for (const program of ["airdrop_holders", "airdrop_holders_gen7", "dbc_holders"]) {
    assert.equal(isHolderPayoutProgram(program), true, program);
    assert.equal(airdropProgramLabel(program), "Holder payout");
    assert.equal(airdropProgramKind(program), "Holder payout");
    assert.equal(airdropRankNoun(program), "payout");
  }
  assert.equal(airdropProgramLabel("airdrop_trader"), "Trader draw");
});

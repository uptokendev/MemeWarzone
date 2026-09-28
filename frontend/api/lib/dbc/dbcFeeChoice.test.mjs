import assert from "node:assert/strict";
import test from "node:test";
import { feeChoiceLine, parseFeeChoice } from "./dbcFeeChoice.mjs";

test("keep is creator mode; holders split buyback are platform", () => {
  assert.deepEqual(parseFeeChoice("keep"), { ok: true, feeChoice: "keep", creatorSharePct: null, creatorFeeMode: "creator" });
  assert.equal(parseFeeChoice("holders").creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("buyback").creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("split", 25).creatorSharePct, 25);
  assert.equal(parseFeeChoice("split", 0).ok, false);
  assert.equal(parseFeeChoice("split", 100).ok, false);
});

test("fee choice line for the creator panel", () => {
  assert.equal(feeChoiceLine({ feeChoice: "keep" }), null);
  assert.equal(feeChoiceLine({ feeChoice: "holders" }), "Holders: LP fees go to holders each week");
  assert.equal(feeChoiceLine({ feeChoice: "buyback" }), "Buyback: LP fees are bought back and burned");
  assert.equal(feeChoiceLine({ feeChoice: "split", creatorSharePct: 60 }), "Split: 60% to the creator, 40% to holders");
});

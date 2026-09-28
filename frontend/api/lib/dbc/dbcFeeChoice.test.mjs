import assert from "node:assert/strict";
import test from "node:test";
import { parseFeeChoice } from "./dbcFeeChoice.mjs";

test("keep is creator mode; holders split buyback are platform", () => {
  assert.deepEqual(parseFeeChoice("keep"), { ok: true, feeChoice: "keep", creatorSharePct: null, creatorFeeMode: "creator" });
  assert.equal(parseFeeChoice("holders").creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("buyback").creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("split", 25).creatorSharePct, 25);
  assert.equal(parseFeeChoice("split", 0).ok, false);
  assert.equal(parseFeeChoice("split", 100).ok, false);
});

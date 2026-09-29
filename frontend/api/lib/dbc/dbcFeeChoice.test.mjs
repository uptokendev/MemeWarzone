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
  // Trading fees on the curve and LP fees after graduation both follow the choice (D5, D19).
  assert.equal(feeChoiceLine({ feeChoice: "holders" }), "Holders: creator fees go to holders each week");
  assert.equal(feeChoiceLine({ feeChoice: "buyback" }), "Buyback: creator fees buy the coin back and burn it");
  assert.equal(feeChoiceLine({ feeChoice: "split", creatorSharePct: 60 }), "Split: 60% to the creator, 40% to holders");
});

test("fee choice line with what step 5b has paid", () => {
  assert.equal(
    feeChoiceLine({ feeChoice: "holders", totals: { holdersLamports: "840000000" } }),
    "Holders: 0.84 SOL paid to holders so far, next payout Monday.",
  );
  assert.equal(
    feeChoiceLine({ feeChoice: "buyback", totals: { buybackLamports: "1200000000", tokensBurned: "3400000000000" } }),
    "Buyback: 1.20 SOL spent and 3,400,000 tokens burned so far.",
  );
  assert.equal(
    feeChoiceLine({ feeChoice: "split", creatorSharePct: 60, totals: { creatorLamports: "5000000", holdersLamports: "3000000" } }),
    "Split: 60% to the creator, 40% to holders. Paid so far: 0.005 SOL to the creator, 0.003 SOL to holders.",
  );
});

test("a coin paired with NVDAx shows creator and buyback amounts in NVDAx, holders in SOL", () => {
  const quote = { symbol: "NVDAx", decimals: 8 };
  assert.equal(
    feeChoiceLine({ feeChoice: "buyback", quote, totals: { buybackLamports: "4271279", tokensBurned: "143556264680" } }),
    "Buyback: 0.0427 NVDAx spent and 143,556 tokens burned so far.",
  );
  assert.equal(
    feeChoiceLine({ feeChoice: "split", creatorSharePct: 60, quote, totals: { creatorLamports: "12311040", holdersLamports: "41036800" } }),
    "Split: 60% to the creator, 40% to holders. Paid so far: 0.1231 NVDAx to the creator, 0.041 SOL to holders.",
  );
});

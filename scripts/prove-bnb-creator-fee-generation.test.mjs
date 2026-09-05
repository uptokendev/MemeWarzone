import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATOR_ABSOLUTE_BPS_OF_VOLUME,
  CREATOR_SHARE_OF_FEE_POT_BPS,
  OG_LINKED,
  PROTOCOL_FEE_BPS,
  STANDARD_LINKED,
  STANDARD_UNLINKED,
  creatorAbsoluteBpsOfVolume,
  expectedFeeFromNotional,
  expectedTradeSplit,
  proveBnbCreatorFeeGeneration,
} from "./bnbCreatorFeeGeneration.mjs";

test("locked creator royalty is 0.10% of volume, which is 5% of the 2% fee pot", () => {
  assert.equal(PROTOCOL_FEE_BPS, 200);
  assert.equal(CREATOR_SHARE_OF_FEE_POT_BPS, 500);
  assert.equal(creatorAbsoluteBpsOfVolume(), 10);
  assert.equal(CREATOR_ABSOLUTE_BPS_OF_VOLUME, 10);
  assert.equal(PROTOCOL_FEE_BPS * CREATOR_SHARE_OF_FEE_POT_BPS, CREATOR_ABSOLUTE_BPS_OF_VOLUME * 10_000);
});

test("Standard, OG, and Unlinked keep the creator slice and consume the whole fee pot", () => {
  const notional = 5_000_000n;
  const fee = expectedFeeFromNotional(notional);
  assert.equal(fee, 100_000n);
  for (const profile of [STANDARD_LINKED, STANDARD_UNLINKED, OG_LINKED]) {
    const split = expectedTradeSplit(fee, profile);
    assert.equal(split.creator, 5_000n);
    assert.equal(split.league + split.creator + split.recruiter + split.airdrop + split.squad + split.protocol, fee);
  }
  assert.equal(expectedTradeSplit(fee, STANDARD_LINKED).recruiter, 12_500n);
  assert.equal(expectedTradeSplit(fee, STANDARD_UNLINKED).airdrop, 15_000n);
  assert.equal(expectedTradeSplit(fee, OG_LINKED).recruiter, 15_000n);
});

test("source-head 4/3 Topaz V2 fee-router V3 math stays in source and live BNB stays 3/2", () => {
  const proof = proveBnbCreatorFeeGeneration();
  assert.equal(proof.math.creatorAbsoluteBpsOfVolume, 10);
  assert.equal(proof.source.liveBnb, "3/2");
  assert.equal(proof.source.uniswapV3Rejected, true);
});

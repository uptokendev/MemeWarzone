import assert from "node:assert/strict";
import test from "node:test";
import { combineReferredUsd, scoreUniversalRecruiter, squadRoleCounts, weiToNative } from "./leagueRecruiterScore.js";

const WEIGHTS = {
  linkedWallets: 1,
  linkedCreators: 3,
  linkedTraders: 2,
  routedVolumeBnb: 0.05,
  totalEarnedBnb: 1,
};

test("SolKillers squad roles use member_role, not campaign history", () => {
  const counts = squadRoleCounts(["trader", "trader", "trader", "trader", "trader", "both"]);
  assert.equal(counts.squad, 6);
  assert.equal(counts.creators, 1);
  assert.equal(counts.traders, 6);
});

test("previous-week SolKillers 0.203 SOL displays as real USD, not the ranking input", () => {
  const sol = weiToNative("203335961", 9);
  assert.ok(sol > 0.203 && sol < 0.204);
  const money = combineReferredUsd({ referredVolumeSol: sol, bnbUsd: 600, solUsd: 95 });
  assert.ok(money.referredVolumeUsd > 19 && money.referredVolumeUsd < 20);
  assert.notEqual(money.referredVolumeUsd, money.normalizedScoreVolume);
});

test("Solana lamports are not read as 18-decimal BNB", () => {
  const lamports = "203335961";
  const asSol = weiToNative(lamports, 9);
  const asBnb = weiToNative(lamports, 18);
  assert.ok(asSol > 0.2 && asSol < 0.21);
  assert.ok(asBnb < 1e-9);
  const usd = combineReferredUsd({
    referredVolumeSol: asSol,
    bnbUsd: 600,
    solUsd: 150,
  });
  assert.ok(usd.referredVolumeUsd > 30 && usd.referredVolumeUsd < 32);
});

test("mixed BNB + SOL volume is summed in USD only", () => {
  const usd = combineReferredUsd({
    referredVolumeBnb: 1.25,
    referredVolumeSol: 3.41,
    bnbUsd: 600,
    solUsd: 150,
  });
  assert.equal(usd.referredVolumeUsd, 1.25 * 600 + 3.41 * 150);
});

test("Robinhood ETH remains a separate native lane while ranking uses USD", () => {
  const money = combineReferredUsd({
    referredVolumeBnb: 1,
    referredVolumeSol: 2,
    referredVolumeEth: 0.5,
    epochEarnedBnb: 0.01,
    epochEarnedSol: 0.02,
    epochEarnedEth: 0.003,
    bnbUsd: 600,
    solUsd: 150,
    ethUsd: 3000,
  });
  assert.equal(money.referredVolumeUsd, 600 + 300 + 1500);
  assert.equal(money.epochEarnedUsd, 6 + 3 + 9);
  assert.equal(money.normalizedScoreVolume, 2400 / 600);
  assert.equal(money.normalizedScoreEarnings, 18 / 600);
});

test("Robinhood-only recruiter is not discarded when BNB volume is zero", () => {
  const scored = scoreUniversalRecruiter({
    linkedWalletCount: 2,
    linkedCreatorsCount: 1,
    linkedTradersCount: 2,
    referredVolumeEth: 1.25,
    epochEarnedEth: 0.004,
    bnbUsd: 600,
    solUsd: 150,
    ethUsd: 3000,
  }, WEIGHTS);
  assert.equal(scored.referredVolumeUsd, 3750);
  assert.equal(scored.epochEarnedUsd, 12);
  assert.ok(scored.weightedScore > 0);
});

test("old active links still score without epoch trades", () => {
  const scored = scoreUniversalRecruiter({
    linkedWalletCount: 10,
    linkedCreatorsCount: 2,
    linkedTradersCount: 8,
    referredVolumeBnb: 0,
    referredVolumeSol: 0,
    referredVolumeEth: 0,
    bnbUsd: 600,
    solUsd: 150,
    ethUsd: 3000,
  }, WEIGHTS);
  assert.equal(scored.weightedScore, 10 * 1 + 2 * 3 + 8 * 2);
  assert.equal(scored.referredVolumeUsd, 0);
});

test("ranking inputs are named score fields, not claim balances", () => {
  const money = combineReferredUsd({
    referredVolumeBnb: 1,
    referredVolumeSol: 2,
    epochEarnedBnb: 0.01,
    epochEarnedSol: 0.02,
    bnbUsd: 600,
    solUsd: 150,
  });
  assert.equal(money.referredVolumeUsd, 600 + 300);
  assert.equal(money.epochEarnedUsd, 0.01 * 600 + 0.02 * 150);
  assert.equal(money.normalizedScoreVolume, (600 + 300) / 600);
  assert.equal(money.normalizedScoreEarnings, (6 + 3) / 600);
  assert.equal(money.volumeBnbEquivalent, undefined);
  assert.equal(money.earnedBnbEquivalent, undefined);
});

test("native BNB SOL and ETH amounts stay separate from USD ranking totals", () => {
  const scored = scoreUniversalRecruiter({
    linkedWalletCount: 0,
    linkedCreatorsCount: 0,
    linkedTradersCount: 0,
    referredVolumeBnb: 1.25,
    referredVolumeSol: 3.41,
    referredVolumeEth: 0.2,
    epochEarnedBnb: 0.003,
    epochEarnedSol: 0.018,
    epochEarnedEth: 0.001,
    bnbUsd: 600,
    solUsd: 150,
    ethUsd: 3000,
  }, WEIGHTS);
  assert.equal(scored.referredVolumeUsd, 1.25 * 600 + 3.41 * 150 + 0.2 * 3000);
  assert.ok(scored.normalizedScoreVolume > 0);
  assert.notEqual(scored.normalizedScoreVolume, scored.referredVolumeUsd);
  assert.equal(scored.referredVolumeBnb, undefined);
  assert.equal(scored.referredVolumeEth, undefined);
});

test("chain selector does not alter one universal recruiter score", () => {
  const input = {
    linkedWalletCount: 9,
    linkedCreatorsCount: 3,
    linkedTradersCount: 6,
    referredVolumeBnb: 1,
    referredVolumeSol: 2,
    referredVolumeEth: 0.1,
    bnbUsd: 600,
    solUsd: 150,
    ethUsd: 3000,
  };
  const a = scoreUniversalRecruiter(input, WEIGHTS);
  const b = scoreUniversalRecruiter(input, WEIGHTS);
  assert.equal(a.weightedScore, b.weightedScore);
  assert.equal(a.referredVolumeUsd, 600 + 300 + 300);
});

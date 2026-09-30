import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignFromFactoryConfig,
  curveArea,
  decodeEvmFeeChoice,
  encodeEvmFeeChoice,
  escrowSummary,
  escrowVested,
  evmAntiSniperLine,
  evmCreatorBadge,
  evmFeeChoiceLine,
  evmGraduationStatus,
  evmTradeFeeBps,
  findNextStepTime,
  firstBuyLimits,
  gen6CreateFields,
  isEvmGen6Pair,
  nextEscrowRelease,
  planFirstBuy,
  quoteFirstBuy,
} from "./evmGen6.mjs";

const DAY = 86_400;
// LaunchFactory constructor defaults (BNB, V2): 1e27 supply, 70% curve, base 1e9, slope 1080.
const BNB_CONFIG = { totalSupply: 10n ** 27n, curveBps: 7000n, liquidityTokenBps: 2800n, basePrice: 10n ** 9n, priceSlope: 1080n };

test("only the 6/5 pair is the new generation; every older pair keeps today's path", () => {
  assert.equal(isEvmGen6Pair(6, 5), true);
  for (const [f, c] of [[3, 2], [4, 2], [4, 3], [5, 4], [6, 4], [0, 0]]) assert.equal(isEvmGen6Pair(f, c), false);
});

test("fee choice codes match CreatorRewardsVaultV2.Choice and the factory's pct rule", () => {
  assert.deepEqual(encodeEvmFeeChoice("keep"), { feeChoice: 1, feeCreatorPct: 0 });
  assert.deepEqual(encodeEvmFeeChoice("holders", 40), { feeChoice: 2, feeCreatorPct: 0 });
  assert.deepEqual(encodeEvmFeeChoice("split", "60"), { feeChoice: 3, feeCreatorPct: 60 });
  assert.deepEqual(encodeEvmFeeChoice("buyback"), { feeChoice: 4, feeCreatorPct: 0 });
  assert.throws(() => encodeEvmFeeChoice("split", 0));
  assert.throws(() => encodeEvmFeeChoice("split", 100));
  assert.throws(() => encodeEvmFeeChoice("burn"));
  assert.deepEqual(decodeEvmFeeChoice(3, 25), { choice: "split", creatorSharePct: 25 });
  assert.deepEqual(decodeEvmFeeChoice(1, 0), { choice: "keep", creatorSharePct: null });
  assert.equal(decodeEvmFeeChoice(0, 0).choice, null);
});

test("fee choice lines use the DBC words", () => {
  assert.equal(evmFeeChoiceLine("split", 60), "Split: 60% to the creator, 40% to holders");
  assert.equal(evmFeeChoiceLine("holders"), "Holders: creator fees go to holders each week");
  assert.equal(evmFeeChoiceLine("buyback"), "Buyback: creator fees buy the coin back and burn it");
});

test("curve area matches LaunchCampaign._area", () => {
  const x = 10n ** 26n; // 100M tokens
  // 1e26 * 1e9 / 1e18 + 1080 * 1e52 / 2e36
  assert.equal(curveArea(x, 10n ** 9n, 1080n), 10n ** 17n + 1080n * 10n ** 52n / (2n * 10n ** 36n));
  const q = quoteFirstBuy({ tokens: x, basePrice: 10n ** 9n, priceSlope: 1080n, protocolFeeBps: 200 });
  assert.equal(q.fee, (q.costNoFee * 200n) / 10_000n);
  assert.equal(q.total, q.costNoFee + q.fee);
});

test("first buy is capped at 10% of supply when the target is large", () => {
  const c = campaignFromFactoryConfig(BNB_CONFIG);
  const limits = firstBuyLimits({ ...c, protocolFeeBps: 200, nativeTargetWei: 10n ** 24n });
  assert.equal(limits.maxTokens, 10n ** 26n);
  assert.equal(limits.limitedBy, "supply");
});

test("first buy is capped at 50% of the native target: the cost before fee never passes it", () => {
  const c = campaignFromFactoryConfig(BNB_CONFIG);
  const target = 2n * 10n ** 18n; // a tiny target so the 10% cap is out of reach
  const limits = firstBuyLimits({ ...c, protocolFeeBps: 200, nativeTargetWei: target });
  assert.equal(limits.limitedBy, "target");
  const at = curveArea(limits.maxTokens, c.basePrice, c.priceSlope);
  const above = curveArea(limits.maxTokens + 1n, c.basePrice, c.priceSlope);
  assert.ok(at * 10_000n <= target * 5_000n);
  assert.ok(above * 10_000n > target * 5_000n);
});

test("planFirstBuy turns a native budget into the exact tokens and cost the factory will charge", () => {
  const plan = planFirstBuy({ budgetWei: 10n ** 16n, config: BNB_CONFIG, protocolFeeBps: 200, nativeTargetWei: 30n * 10n ** 18n });
  assert.ok(plan.tokens > 0n);
  assert.ok(plan.total <= 10n ** 16n);
  const more = quoteFirstBuy({ tokens: plan.tokens + 1n, basePrice: 10n ** 9n, priceSlope: 1080n, protocolFeeBps: 200 });
  assert.ok(more.total > 10n ** 16n);
  assert.equal(plan.exceedsCap, false);
  const fields = gen6CreateFields({ choice: "split", creatorSharePct: 70, firstBuy: plan });
  assert.deepEqual(fields, { firstBuyTokens: plan.tokens, firstBuyMaxCost: plan.total, feeChoice: 3, feeCreatorPct: 70, value: plan.total });
});

test("a budget above the cap buys the cap and says so", () => {
  const plan = planFirstBuy({ budgetWei: 10n ** 24n, config: BNB_CONFIG, protocolFeeBps: 200, nativeTargetWei: 10n ** 24n });
  assert.equal(plan.tokens, plan.maxTokens);
  assert.equal(plan.supplyBps, 1000);
  assert.equal(plan.exceedsCap, true);
});

test("no first buy sends no value", () => {
  assert.deepEqual(gen6CreateFields({ choice: "keep", firstBuy: null }), {
    firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0, value: 0n,
  });
});

test("trade fee equals LaunchCampaign.currentTradeFeeBps: 5000 - 80 * elapsed with a 200 base", () => {
  const launchAt = 1_000_000;
  for (const [elapsed, bps] of [[-30, 5000], [0, 5000], [1, 4920], [5, 4600], [30, 2600], [59, 280], [60, 200], [3600, 200]]) {
    assert.equal(evmTradeFeeBps({ launchAt, nowUnix: launchAt + elapsed }), bps, `at ${elapsed}s`);
  }
});

test("the anti-sniper line is the DBC line", () => {
  const launchAt = 1_700_000_000;
  assert.match(evmAntiSniperLine({ launchAt, nowUnix: launchAt + 5, timeZone: "UTC" }), /^Launch fee: 46% now, 2% from \d{1,2}:\d\d:\d\d.*\.$/);
  assert.equal(evmAntiSniperLine({ launchAt, nowUnix: launchAt + 61 }), "Launch fee: 2% now.");
});

test("escrow reference model: 0 before 30 days, a fifth at 30 days, all at 58 days", () => {
  const buys = [{ at: 1000, amount: 500n }];
  assert.equal(escrowVested(buys, 1000 + 30 * DAY - 1), 0n);
  assert.equal(escrowVested(buys, 1000 + 30 * DAY), 100n);
  assert.equal(escrowVested(buys, 1000 + 37 * DAY), 200n);
  assert.equal(escrowVested(buys, 1000 + 58 * DAY), 500n);
  const two = [{ at: 0, amount: 500n }, { at: 10 * DAY, amount: 1000n }];
  assert.equal(escrowVested(two, 40 * DAY), 200n + 200n);
  assert.equal(nextEscrowRelease(two, 30 * DAY), 37 * DAY);
  assert.equal(nextEscrowRelease(two, 68 * DAY), 0);
});

test("findNextStepTime finds the exact next release by probing the contract view", async () => {
  const buys = [{ at: 5_000, amount: 1000n }, { at: 5_000 + 3 * DAY + 17, amount: 250n }];
  let calls = 0;
  const probe = async (t) => {
    calls += 1;
    return escrowVested(buys, t);
  };
  const now = 5_000 + 31 * DAY;
  const next = await findNextStepTime(probe, now, now + 58 * DAY);
  assert.equal(next, nextEscrowRelease(buys, now));
  assert.ok(calls < 80, `probes: ${calls}`);
  assert.equal(await findNextStepTime(probe, 5_000 + 70 * DAY, 5_000 + 128 * DAY), 0);
});

test("escrow summary and the coin badge", () => {
  assert.deepEqual(escrowSummary({ total: 1000n, claimed: 200n, vestedNow: 400n }), { held: 800n, locked: 600n, claimable: 200n });
  const supply = 10n ** 27n;
  const badge = evmCreatorBadge({
    walletBalance: 10n ** 25n,
    escrowHeld: 10n ** 25n,
    locked: 5n * 10n ** 24n,
    totalSupply: supply,
    fullyFreeUnix: 2_000_000_000,
    nowUnix: 1_900_000_000,
  });
  assert.match(badge, /^Creator holds 2\.00% of supply, 0\.50% locked until /);
});

test("graduation states: trading, pending, native fallback note, graduated", () => {
  assert.equal(evmGraduationStatus({ launched: false, graduationPending: false }).phase, "trading");
  const native = evmGraduationStatus({ launched: false, graduationPending: true, pendingSince: 100, quoteToken: "0x" + "0".repeat(40), nowUnix: 200 });
  assert.equal(native.line, "Graduating: the pool is being created.");
  assert.equal(native.note, null);
  const quote = "0x" + "1".repeat(40);
  const early = evmGraduationStatus({ launched: false, graduationPending: true, pendingSince: 100, quoteToken: quote, quoteSymbol: "USDT", nativeSymbol: "BNB", nowUnix: 200 });
  assert.equal(early.fallbackDue, false);
  assert.equal(early.fallbackAt, 100 + 7 * DAY);
  assert.match(early.note, /USDT route is still closed on .*, the coin can graduate into a BNB pool instead\./);
  const due = evmGraduationStatus({ launched: false, graduationPending: true, pendingSince: 100, quoteToken: quote, quoteSymbol: "USDT", nativeSymbol: "BNB", nowUnix: 100 + 7 * DAY });
  assert.equal(due.fallbackDue, true);
  const switched = evmGraduationStatus({ launched: false, graduationPending: true, pendingSince: 100, quoteToken: quote, nativeFallback: true, quoteSymbol: "USDT", nativeSymbol: "BNB", nowUnix: 100 + 8 * DAY });
  assert.match(switched.note, /now graduates into a BNB pool/);
  assert.equal(evmGraduationStatus({ launched: true }).phase, "graduated");
});

test("user-facing copy has no em dashes", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./evmGen6.mjs", import.meta.url), "utf8");
  assert.equal(src.includes("\u2014"), false);
});

test("findFirstTime finds when the escrow is fully free", async () => {
  const buys = [{ at: 0, amount: 1000n }, { at: 9 * DAY + 3, amount: 1000n }];
  const t = await (await import("./evmGen6.mjs")).findFirstTime(async (x) => escrowVested(buys, x) >= 2000n, DAY, DAY + 120 * DAY);
  assert.equal(t, 9 * DAY + 3 + 58 * DAY);
});

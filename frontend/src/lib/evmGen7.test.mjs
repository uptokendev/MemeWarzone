import assert from "node:assert/strict";
import test from "node:test";
import {
  EVM_GEN7_DEFAULT_GRADUATION_TARGET_WEI,
  EVM_GEN7_FIRST_BUY_SLACK_BPS,
  GEN7_LAUNCH_FEE_NOTE,
  curveForMarketCap,
  evmGen7DexName,
  evmGen7GraduationTiers,
  evmLaunchGeneration,
  gen7AntiSniperLine,
  gen7CreateFields,
  gen7FirstBuyMaxCost,
  gen7FirstBuyOverBalance,
  gen7MarketCapNative,
  gen7MaxFirstBuyBudget,
  gen7ShowsGraduationRefund,
  gen7TradeFeeBps,
  planGen7FirstBuy,
} from "./evmGen7.mjs";
import { creatorStateFromApi, gen6CreateFields, isEvmGen6Pair } from "./evmGen6.mjs";
import { evmCurveSpotChanges, evmCurveSpotWei, evmGen7CurveSpotWei } from "./fullyDilutedMarketCap.mjs";

const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const CONFIG = { totalSupply: SUPPLY, curveBps: 8500n, liquidityTokenBps: 1300n, graduationTarget: 50_000n * E18 };
// $50K market cap at a $600 BNB: 83.33 BNB for the whole supply.
const MC_50K_AT_600 = (50_000n * E18 * E18) / (600n * E18);

test("generation pairs: 6/5 is 6, 7/6 is 7, everything else is null", () => {
  assert.equal(evmLaunchGeneration(6, 5), 6);
  assert.equal(evmLaunchGeneration(7, 6), 7);
  for (const [f, c] of [[3, 2], [4, 3], [6, 6], [7, 5], [0, 0]]) assert.equal(evmLaunchGeneration(f, c), null);
  // The gen-6 check itself is unchanged: 7/6 is not a gen-6 pair.
  assert.equal(isEvmGen6Pair(7, 6), false);
});

test("first-buy max cost is the quote plus 2%, rounded up; no first buy sends nothing", () => {
  assert.equal(EVM_GEN7_FIRST_BUY_SLACK_BPS, 200n);
  assert.equal(gen7FirstBuyMaxCost(10_000n), 10_200n);
  assert.equal(gen7FirstBuyMaxCost(1n), 2n);
  assert.equal(gen7FirstBuyMaxCost(0n), 0n);
  const plan = planGen7FirstBuy({ budgetWei: E18, config: CONFIG, protocolFeeBps: 200n, marketCapNativeWei: MC_50K_AT_600 });
  const fields = gen7CreateFields({ choice: "split", creatorSharePct: 40, firstBuy: plan });
  assert.equal(fields.firstBuyTokens, plan.tokens);
  assert.equal(fields.firstBuyMaxCost, gen7FirstBuyMaxCost(plan.total));
  assert.equal(fields.value, fields.firstBuyMaxCost);
  assert.equal(fields.feeChoice, 3);
  assert.equal(fields.feeCreatorPct, 40);
  assert.deepEqual(gen7CreateFields({ choice: "keep", firstBuy: null }), {
    firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0, value: 0n,
  });
  // Gen-6 keeps the exact cost (no slack).
  assert.equal(gen6CreateFields({ choice: "keep", firstBuy: { tokens: 5n, total: 100n } }).firstBuyMaxCost, 100n);
});

test("the gen-7 plan: 70% of supply, no cost cap, start market cap 2.4355% of the target", () => {
  const plan = planGen7FirstBuy({ budgetWei: 10n ** 30n, config: CONFIG, protocolFeeBps: 200n, marketCapNativeWei: MC_50K_AT_600 });
  assert.equal(plan.maxTokens, (SUPPLY * 7000n) / 10_000n);
  assert.equal(plan.limitedBy, "supply");
  assert.equal(plan.exceedsCap, true);
  assert.equal(plan.tokens, plan.maxTokens);
  assert.equal(plan.supplyBps, 7000);
  // A 70% buy costs about 42.1% of the raise to graduate (plan section 2).
  const share = Number((plan.costNoFee * 10_000n) / plan.graduationRaiseWei) / 100;
  assert.ok(share > 41.5 && share < 42.7, `70% costs ${share}% of the raise`);
  const { virtualNative, virtualToken } = curveForMarketCap(MC_50K_AT_600, SUPPLY);
  const startMc = gen7MarketCapNative({ virtualNative, virtualToken, sold: 0n, totalSupply: SUPPLY });
  const startPct = Number((startMc * 1_000_000n) / MC_50K_AT_600) / 10_000;
  assert.ok(Math.abs(startPct - 2.4355) < 0.002, `start market cap ${startPct}% of target`);
});

test("balance: MAX by balance fits exactly, one wei more does not", () => {
  const reserve = 5n * 10n ** 15n;
  const balance = 3n * E18;
  const max = gen7MaxFirstBuyBudget({ balanceWei: balance, gasReserveWei: reserve });
  assert.equal(gen7FirstBuyOverBalance({ totalWei: max, balanceWei: balance, gasReserveWei: reserve }), false);
  assert.equal(gen7FirstBuyOverBalance({ totalWei: max + 2n, balanceWei: balance, gasReserveWei: reserve }), true);
  assert.equal(gen7MaxFirstBuyBudget({ balanceWei: reserve, gasReserveWei: reserve }), 0n);
  // Unknown balance or no first buy never blocks.
  assert.equal(gen7FirstBuyOverBalance({ totalWei: E18, balanceWei: null, gasReserveWei: reserve }), false);
  assert.equal(gen7FirstBuyOverBalance({ totalWei: 0n, balanceWei: 0n, gasReserveWei: reserve }), false);
});

test("graduation tiers are market caps, $50K preselected, $150 only on test chains with the test tier on", () => {
  assert.equal(EVM_GEN7_DEFAULT_GRADUATION_TARGET_WEI, 50_000n * E18);
  const bnb = evmGen7GraduationTiers(56, { testTierEnabled: true });
  assert.deepEqual(bnb.map((t) => [t.id, t.label, t.targetWei]), [
    ["fast", "$30K MC", 30_000n * E18],
    ["normal", "$50K MC", 50_000n * E18],
  ]);
  assert.equal(bnb[0].description, "Moves to a Topaz pool when the market cap reaches $30K.");
  const rh = evmGen7GraduationTiers(46630, { testTierEnabled: true });
  assert.deepEqual(rh.map((t) => t.label), ["$150", "$30K MC", "$50K MC"]);
  assert.equal(rh[0].targetWei, 150n * E18);
  assert.equal(rh[0].testOnly, true);
  assert.equal(rh[1].description, "Moves to a Uniswap pool when the market cap reaches $30K.");
  assert.deepEqual(evmGen7GraduationTiers(97, { testTierEnabled: false }).map((t) => t.label), ["$30K MC", "$50K MC"]);
  assert.equal(evmGen7DexName(4663), "Uniswap");
  assert.equal(evmGen7DexName(97), "Topaz");
  for (const tier of [...bnb, ...rh]) assert.doesNotMatch(tier.description, /\u2014/);
});

test("launch fee: LaunchCampaignGen7.currentTradeFeeBps, 90% to the base over 60 s", () => {
  const launchAt = 1_800_000_000;
  assert.equal(gen7TradeFeeBps({ launchAt, nowUnix: launchAt - 30, baseFeeBps: 200 }), 9000);
  assert.equal(gen7TradeFeeBps({ launchAt, nowUnix: launchAt, baseFeeBps: 200 }), 9000);
  assert.equal(gen7TradeFeeBps({ launchAt, nowUnix: launchAt + 30, baseFeeBps: 200 }), 200 + Math.floor((8800 * 30) / 60));
  assert.equal(gen7TradeFeeBps({ launchAt, nowUnix: launchAt + 59, baseFeeBps: 200 }), 200 + Math.floor(8800 / 60));
  assert.equal(gen7TradeFeeBps({ launchAt, nowUnix: launchAt + 60, baseFeeBps: 200 }), 200);
  assert.match(gen7AntiSniperLine({ launchAt, nowUnix: launchAt + 30, baseFeeBps: 200, timeZone: "UTC" }), /^Launch fee: 46% now, 2% from \d{1,2}:\d\d:\d\d.*\.$/);
  assert.equal(gen7AntiSniperLine({ launchAt, nowUnix: launchAt + 61, baseFeeBps: 200 }), "Launch fee: 2% now.");
  assert.match(GEN7_LAUNCH_FEE_NOTE, /starts at 90% and falls to 2% within 60 seconds/);
});

test("creator panel: no graduation row on gen-7 unless the pool left a refund", () => {
  assert.equal(gen7ShowsGraduationRefund({ launched: false, pendingGraduation: 5n, pendingGraduationQuote: 0n }), false);
  assert.equal(gen7ShowsGraduationRefund({ launched: true, pendingGraduation: 0n, pendingGraduationQuote: 0n }), false);
  assert.equal(gen7ShowsGraduationRefund({ launched: true, pendingGraduation: 1n, pendingGraduationQuote: 0n }), true);
  assert.equal(gen7ShowsGraduationRefund({ launched: true, pendingGraduation: 0n, pendingGraduationQuote: 3n }), true);
});

test("campaign-state economics: graduationCreatorBps is passed through when present, null otherwise", () => {
  const base = { supported: true, creatorEscrow: {}, creatorClaims: {} };
  assert.equal(creatorStateFromApi(base, {}).graduationCreatorBps, null);
  assert.equal(creatorStateFromApi({ ...base, economics: { graduationCreatorBps: 0 } }, {}).graduationCreatorBps, 0);
  assert.equal(creatorStateFromApi({ ...base, economics: { graduationCreatorBps: 1980 } }, {}).graduationCreatorBps, 1980);
});

test("spot changes on the gen-7 curve: buy then full sell is 0%, a held buy is a rise", () => {
  const { virtualNative, virtualToken } = curveForMarketCap(MC_50K_AT_600, SUPPLY);
  const WINDOWS = { "5m": 300, "1h": 3600 };
  const now = 1_800_000_000;
  const flat = evmCurveSpotChanges({
    trades: [
      { timestamp: now - 1000, type: "buy", tokensWei: 50_000_000n * E18 },
      { timestamp: now - 900, type: "sell", tokensWei: 50_000_000n * E18 },
    ],
    soldNowRaw: 0n, basePriceWei: 0n, priceSlopeWei: 0n, nowSec: now, windows: WINDOWS,
    virtualNativeWei: virtualNative, virtualTokenRaw: virtualToken,
  });
  assert.deepEqual(flat, { "5m": 0, "1h": 0 });
  const up = evmCurveSpotChanges({
    trades: [{ timestamp: now - 1000, type: "buy", tokensWei: 100_000_000n * E18 }],
    soldNowRaw: 100_000_000n * E18, basePriceWei: 0n, priceSlopeWei: 0n, nowSec: now, windows: WINDOWS,
    virtualNativeWei: virtualNative, virtualTokenRaw: virtualToken,
  });
  assert.equal(up["5m"], 0);
  const start = Number(evmGen7CurveSpotWei(virtualNative, virtualToken, 0n));
  const end = Number(evmGen7CurveSpotWei(virtualNative, virtualToken, 100_000_000n * E18));
  assert.ok(Math.abs(up["1h"] - ((end - start) / start) * 100) < 1e-9);
  assert.ok(up["1h"] > 0);
  // Without virtual reserves the linear path is used, exactly as before.
  assert.equal(evmCurveSpotWei(1_000_000_000n, 850n, 0n), 1_000_000_000n);
  const linear = evmCurveSpotChanges({ trades: [], soldNowRaw: 0n, basePriceWei: 0n, priceSlopeWei: 0n, nowSec: now, windows: WINDOWS });
  assert.deepEqual(linear, { "5m": null, "1h": null });
});

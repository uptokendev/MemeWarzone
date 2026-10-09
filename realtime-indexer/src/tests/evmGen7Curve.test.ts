// EVM launch generation 7 (factory 7 / campaign 6) in the indexer: the TS curve copy against the shared
// frontend/shared/evmGen7Curve.mjs, spot/mcap for token_stats and candles, generation storage, the gen-7
// launch fee in trade annotations, the keeper's sold-out-only due filter, the creator-choice impact
// estimate and the ABI pins against the gen-7 artifacts. Every gen-7 branch is paired with a check that
// the gen-6 result is what it was.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import {
  BNB_CURVE_PARAM_FRAGMENTS,
  BNB_WAD,
  bnbCpCurveState,
  bnbCurveState,
  bnbCurveStateFor,
  readBnbCurveParams,
} from "../bnbCurvePricing.js";
import {
  EVM_GEN7_CAMPAIGN_GENERATION,
  EVM_GEN7_FACTORY_GENERATION,
  GEN7_ANTI_SNIPER_START_BPS,
  gen7BuyCostNoFee,
  gen7CurveNative,
  gen7CurvePriceAfter,
  gen7GraduationRaise,
  gen7SellPayoutNoFee,
  gen7SpotPrice,
  isEvmGen7CampaignGeneration,
} from "../evm/evmGen7Curve.js";
import { GEN5_CAMPAIGN_ABI, GEN6_FACTORY_ABI } from "../evm/evmGen5Abi.js";
import { CAMPAIGN_CREATED_EVENT_V3 } from "../abis.js";
import { ANTI_SNIPER_START_BPS, annotateGen5Trade, gen5TradeFeeBps } from "../evm/evmGen5Trade.js";
import { annotationForTrade, type Gen5TradeContext } from "../evm/evmGen5CampaignLogs.js";
import {
  clearGenerationCaches,
  forcedGen7Factories,
  resolveCampaignGeneration,
  type CampaignGenerationInfo,
} from "../evm/evmGen5Store.js";
import { isLikelyDue, listDueCampaigns, listTradingDueCandidates, type KeeperReader } from "../evm/evmGraduationKeeper.js";
import { linearCurvePriceAfter } from "../evm/evmCreatorChoice.js";
import { listPlatformCoins } from "../evm/evmCreatorChoicePass.js";

// @ts-ignore -- the app's canonical copy, plain JS
const shared = await import("../../../frontend/shared/evmGen7Curve.mjs");

const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const CURVE_SUPPLY = (SUPPLY * 8500n) / 10_000n;
const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "../../../artifacts/contracts/gen7");

/** Real gen-7 curves: $30K / $50K / $150 market caps at a few native prices (MC in native wei). */
const CURVES: Array<{ label: string; vN: bigint; vT: bigint }> = [
  ["$30K @ BNB $600", 50n * E18],
  ["$50K @ BNB $600", (50_000n * E18) / 600n],
  ["$30K @ ETH $2500", 12n * E18],
  ["$150 @ BNB $600 (testnet)", (150n * E18) / 600n],
  ["$50K @ BNB $50", 1_000n * E18],
].map(([label, mc]) => {
  const c = shared.curveForMarketCap(mc, SUPPLY);
  return { label: label as string, vN: c.virtualNative as bigint, vT: c.virtualToken as bigint };
});

function soldPoints(): bigint[] {
  return [0n, 1n, E18, 12_345_678n * E18 + 987n, CURVE_SUPPLY / 3n, (CURVE_SUPPLY * 7000n) / 8500n, CURVE_SUPPLY - 1n, CURVE_SUPPLY];
}

// ------------------------------------------------------------------------------------ the curve copy

test("constants match the shared module", () => {
  assert.equal(EVM_GEN7_FACTORY_GENERATION, shared.EVM_GEN7_FACTORY_GENERATION);
  assert.equal(EVM_GEN7_CAMPAIGN_GENERATION, shared.EVM_GEN7_CAMPAIGN_GENERATION);
  assert.equal(GEN7_ANTI_SNIPER_START_BPS, BigInt(shared.GEN7_ANTI_SNIPER_START_BPS));
  assert.equal(isEvmGen7CampaignGeneration(6), true);
  assert.equal(isEvmGen7CampaignGeneration(5), false); // gen-6 contracts
  assert.equal(isEvmGen7CampaignGeneration(null), false);
  assert.equal(isEvmGen7CampaignGeneration(undefined), false);
});

test("TS curve copy equals frontend/shared/evmGen7Curve.mjs to the wei on real gen-7 curves", () => {
  for (const { label, vN, vT } of CURVES) {
    for (const s of soldPoints()) {
      assert.equal(gen7CurveNative(vN, vT, s), shared.curveNative(vN, vT, s), `${label} Y(${s})`);
      assert.equal(gen7SpotPrice(vN, vT, s), shared.spotPrice(vN, vT, s), `${label} price(${s})`);
      if (s + E18 <= CURVE_SUPPLY) {
        assert.equal(gen7BuyCostNoFee(vN, vT, s, E18), shared.buyCostNoFee(vN, vT, s, E18), `${label} buy at ${s}`);
      }
      if (s >= E18) {
        assert.equal(gen7SellPayoutNoFee(vN, vT, s, E18), shared.sellPayoutNoFee(vN, vT, s, E18), `${label} sell at ${s}`);
      }
    }
    assert.equal(gen7GraduationRaise(vN, vT, CURVE_SUPPLY), shared.graduationRaise(vN, vT, CURVE_SUPPLY), label);
  }
  assert.throws(() => gen7CurveNative(1n, 10n, 10n));
  assert.throws(() => shared.curveNative(1n, 10n, 10n));
});

// ---------------------------------------------------------------------- spot / mcap (stats, candles)

test("gen-7 spot is LaunchCampaignGen7._currentPrice; mcap keeps the spot x sold basis", () => {
  for (const { label, vN, vT } of CURVES) {
    for (const s of soldPoints()) {
      const state = bnbCpCurveState(vN, vT, s);
      const spotRaw: bigint = shared.spotPrice(vN, vT, s);
      const whole = Number(s / BNB_WAD) + Number(s % BNB_WAD) / 1e18;
      const spot = Number(spotRaw / BNB_WAD) + Number(spotRaw % BNB_WAD) / 1e18;
      assert.equal(state.soldRaw, s);
      assert.equal(state.spotNative, spot, `${label} spot at ${s}`);
      assert.equal(state.soldWhole, whole);
      assert.equal(state.mcapNative, s === 0n ? 0 : spot * whole, `${label} mcap at ${s}`);
      assert.deepEqual(bnbCurveStateFor({ kind: "cp", virtualNative: vN, virtualToken: vT }, s), state);
    }
  }
});

test("gen-7 at sell-out: spot x total supply is the graduation market cap; spot x sold is 85% of it", () => {
  const mc = 50n * E18; // $30K at $600
  const c = shared.curveForMarketCap(mc, SUPPLY);
  const state = bnbCpCurveState(c.virtualNative, c.virtualToken, CURVE_SUPPLY);
  const fdv = shared.gen7MarketCapNative({ virtualNative: c.virtualNative, virtualToken: c.virtualToken, sold: CURVE_SUPPLY, totalSupply: SUPPLY });
  // The factory sizes the curve so the sold-out FDV lands on the target (within the 1 bp pool margin).
  assert.ok(fdv <= mc && fdv * 10_000n >= mc * 9_990n, `fdv ${fdv} vs target ${mc}`);
  const ratio = state.mcapNative / (Number(fdv) / 1e18);
  assert.ok(Math.abs(ratio - 0.85) < 1e-9, `spot x sold / fdv = ${ratio}`);
});

test("gen-7 guards: sold at or past vT, zero reserves, negative sold -> no spot (callers fall back as for a missing curve)", () => {
  const { vN, vT } = CURVES[0];
  assert.deepEqual(bnbCpCurveState(vN, vT, vT), { soldRaw: vT, spotNative: 0, soldWhole: Number(vT / E18) + Number(vT % E18) / 1e18, mcapNative: 0 });
  assert.equal(bnbCpCurveState(0n, vT, E18).spotNative, 0);
  assert.equal(bnbCpCurveState(vN, 0n, E18).spotNative, 0);
  const neg = bnbCpCurveState(vN, vT, -5n);
  assert.equal(neg.soldRaw, 0n);
  assert.equal(neg.spotNative, Number(shared.spotPrice(vN, vT, 0n)) / 1e18);
  assert.equal(neg.mcapNative, 0);
});

test("gen-6 unchanged: linear params go through bnbCurveState exactly", () => {
  const cases: Array<[bigint, bigint, bigint]> = [
    [1_000_000_000n, 850n, 1_253_249_124_496_015_052_091_146n],
    [1_000_000_000n, 850n, 0n],
    [3_000_000_000n, 12_345n, 700_000_000n * E18],
    [1n, 1n, -1n],
  ];
  for (const [base, slope, sold] of cases) {
    assert.deepEqual(bnbCurveStateFor({ kind: "linear", base, slope }, sold), bnbCurveState(base, slope, sold));
  }
  // The pinned SBF figures of bnbCurvePricing.test.ts, through the new entry point.
  const s = bnbCurveStateFor({ kind: "linear", base: 1_000_000_000n, slope: 850n }, 1_253_249_124_496_015_052_091_146n);
  assert.equal(s.spotNative, 2.065261755e-9);
  assert.equal(s.mcapNative, 0.0025882874863088533);
});

function fakeCurveContract(opts: { linear?: [bigint, bigint]; cp?: [bigint, bigint]; linearError?: Error }) {
  const calls: string[] = [];
  const revert = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error(`${name} reverted`));
  };
  const ok = (name: string, v: bigint) => () => {
    calls.push(name);
    return Promise.resolve(v);
  };
  return {
    calls,
    basePrice: opts.linear ? ok("basePrice", opts.linear[0]) : opts.linearError ? () => (calls.push("basePrice"), Promise.reject(opts.linearError)) : revert("basePrice"),
    priceSlope: opts.linear ? ok("priceSlope", opts.linear[1]) : revert("priceSlope"),
    virtualNative: opts.cp ? ok("virtualNative", opts.cp[0]) : revert("virtualNative"),
    virtualToken: opts.cp ? ok("virtualToken", opts.cp[1]) : revert("virtualToken"),
  };
}

test("readBnbCurveParams: gen-6 reads only basePrice/priceSlope (as before); gen-7 falls back to the virtual reserves", async () => {
  const g6 = fakeCurveContract({ linear: [1_000_000_000n, 850n] });
  assert.deepEqual(await readBnbCurveParams(g6), { kind: "linear", base: 1_000_000_000n, slope: 850n });
  assert.deepEqual(g6.calls.sort(), ["basePrice", "priceSlope"]);

  const { vN, vT } = CURVES[0];
  const g7 = fakeCurveContract({ cp: [vN, vT] });
  assert.deepEqual(await readBnbCurveParams(g7), { kind: "cp", virtualNative: vN, virtualToken: vT });

  // Neither answers (RPC down, not a campaign): the linear read's error, as the callers reported before.
  const original = new Error("timeout on basePrice");
  const none = fakeCurveContract({ linearError: original });
  await assert.rejects(readBnbCurveParams(none), (e) => e === original);
  // A zero virtual token is not a curve.
  await assert.rejects(readBnbCurveParams(fakeCurveContract({ cp: [vN, 0n] })), /basePrice reverted/);
});

test("the indexer's curve-param ABI keeps the linear fragments and adds the gen-7 views", () => {
  const iface = new ethers.Interface(BNB_CURVE_PARAM_FRAGMENTS as unknown as string[]);
  for (const n of ["basePrice", "priceSlope", "virtualNative", "virtualToken"]) assert.ok(iface.getFunction(n), n);
});

// ---------------------------------------------------------------------------- generation storage

const FACTORY = "0x00000000000000000000000000000000000000fa";
const CAMPAIGN = "0x00000000000000000000000000000000000000ca";
const CREATOR = "0x00000000000000000000000000000000000000cc";

function fakeProvider(answers: Record<string, unknown[]>) {
  const iface = new ethers.Interface([...GEN5_CAMPAIGN_ABI, ...GEN6_FACTORY_ABI] as unknown as string[]);
  const seen: string[] = [];
  return {
    seen,
    provider: {
      async call(tx: { to?: string; data?: string }) {
        const fn = iface.getFunction(String(tx.data).slice(0, 10))!;
        seen.push(fn.name);
        if (!(fn.name in answers)) throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x" });
        return iface.encodeFunctionResult(fn, answers[fn.name]);
      },
    } as unknown as ethers.Provider,
  };
}

function genDb(row: Record<string, unknown>) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  return {
    writes,
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*select factory_address/.test(sql)) return { rows: [row] };
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
}

test("generation from the factory's constants: a gen-7 factory (7 / 6) is a launch-generation coin stored as 7 / 6", async () => {
  clearGenerationCaches();
  const { provider } = fakeProvider({
    FACTORY_GENERATION: [7],
    CAMPAIGN_GENERATION: [6],
    launchAt: [1_000],
    protocolFeeBps: [200],
    graduationQuoteToken: [ethers.ZeroAddress],
  });
  const db = genDb({ factory_address: FACTORY, creator_address: CREATOR, factory_generation: null, campaign_generation: null });
  const info = await resolveCampaignGeneration(db, provider, 97, CAMPAIGN, {} as any);
  assert.equal(info.gen5, true);
  assert.equal(info.factoryGeneration, 7);
  assert.equal(info.campaignGeneration, 6);
  assert.equal(info.launchAt, 1_000n);
  const upd = db.writes.find((w) => /update public\.campaigns/.test(w.sql))!;
  assert.deepEqual(upd.params, [97, CAMPAIGN, 7, 6, FACTORY]);
  const ins = db.writes.find((w) => /insert into public\.evm_campaign_gen5_state/.test(w.sql))!;
  assert.deepEqual(ins.params.slice(0, 5), [97, CAMPAIGN, FACTORY, 7, 6]);
});

test("EVM_GEN7_FACTORIES_<chainId> forces 7 / 6 without a call; EVM_GEN5_FACTORIES_<chainId> still forces 6 / 5", async () => {
  const answers = { launchAt: [1_000], protocolFeeBps: [200] };
  clearGenerationCaches();
  const g7 = fakeProvider(answers);
  const db7 = genDb({ factory_address: FACTORY, creator_address: CREATOR, factory_generation: null, campaign_generation: null });
  const info7 = await resolveCampaignGeneration(db7, g7.provider, 97, CAMPAIGN, { EVM_GEN7_FACTORIES_97: FACTORY.toUpperCase().replace("0X", "0x") } as any);
  assert.equal(info7.factoryGeneration, 7);
  assert.equal(info7.campaignGeneration, 6);
  assert.ok(!g7.seen.includes("FACTORY_GENERATION"));

  clearGenerationCaches();
  const g6 = fakeProvider(answers);
  const db6 = genDb({ factory_address: FACTORY, creator_address: CREATOR, factory_generation: null, campaign_generation: null });
  const info6 = await resolveCampaignGeneration(db6, g6.provider, 97, CAMPAIGN, { EVM_GEN5_FACTORIES_97: FACTORY } as any);
  assert.equal(info6.factoryGeneration, 6);
  assert.equal(info6.campaignGeneration, 5);
  assert.ok(!g6.seen.includes("FACTORY_GENERATION"));

  assert.deepEqual([...forcedGen7Factories(56, { EVM_GEN7_FACTORIES_56: `${FACTORY}, bad,` } as any)], [FACTORY]);
  assert.equal(forcedGen7Factories(56, {} as any).size, 0);
  clearGenerationCaches();
});

// ---------------------------------------------------------------------------- trade fee annotation

function ctx(campaignGeneration: number): Gen5TradeContext {
  const info: CampaignGenerationInfo = {
    campaign: CAMPAIGN,
    factory: FACTORY,
    factoryGeneration: campaignGeneration === 6 ? 7 : 6,
    campaignGeneration,
    gen5: true,
    creator: CREATOR,
    launchAt: 500n,
    baseFeeBps: 200n,
  };
  return { info, firstBuys: new Map() };
}

const TRADER = "0x00000000000000000000000000000000000000dd";
const TX = `0x${"33".repeat(32)}`;

test("launch fee: gen-7 starts at 9000 bps, gen-6 at 5000, same 60 s window and base", () => {
  assert.equal(ANTI_SNIPER_START_BPS, 5_000n);
  for (const t of [400n, 500n, 515n, 530n, 559n, 560n, 600n]) {
    assert.equal(gen5TradeFeeBps(200n, 500n, t), gen5TradeFeeBps(200n, 500n, t, 5_000n), "default is gen-6");
  }
  assert.equal(gen5TradeFeeBps(200n, 500n, 500n, 9_000n), 9_000n);
  assert.equal(gen5TradeFeeBps(200n, 500n, 530n, 9_000n), 200n + (8_800n * 30n) / 60n);
  assert.equal(gen5TradeFeeBps(200n, 500n, 560n, 9_000n), 200n);
});

test("trade annotation: a gen-7 sniper buy and sell are inverted at 9000 bps; gen-6 stays at 5000", () => {
  // Gen-7, launch second: cost 1000 -> fee 900.
  const buy7 = annotationForTrade(ctx(6), { side: "buy", wallet: TRADER, amountRaw: 1_900n, tokenRaw: 1n, txHash: TX, blockTimeSec: 500 });
  assert.equal(buy7.feeBps, 9_000);
  assert.equal(buy7.grossRaw, 1_000n);
  assert.equal(buy7.feeRaw, 900n);
  // Sell gross 1000 at 9000 bps -> payout 100 (the fee may be a few wei ambiguous; the gross stays consistent).
  const sell7 = annotationForTrade(ctx(6), { side: "sell", wallet: TRADER, amountRaw: 100n, tokenRaw: 1n, txHash: TX, blockTimeSec: 500 });
  assert.equal(sell7.feeBps, 9_000);
  assert.ok(sell7.grossRaw !== null && sell7.grossRaw - ((sell7.grossRaw * 9_000n) / 10_000n) === 100n);
  // After the window both generations charge the base fee.
  const late7 = annotationForTrade(ctx(6), { side: "buy", wallet: TRADER, amountRaw: 1_020n, tokenRaw: 1n, txHash: TX, blockTimeSec: 600 });
  assert.equal(late7.feeBps, 200);
  assert.equal(late7.grossRaw, 1_000n);

  // Gen-6 (campaign generation 5): the same inputs give what they gave before gen-7 existed.
  const buy6 = annotationForTrade(ctx(5), { side: "buy", wallet: TRADER, amountRaw: 1_500n, tokenRaw: 1n, txHash: TX, blockTimeSec: 500 });
  assert.deepEqual(buy6, annotateGen5Trade({
    side: "buy", amountRaw: 1_500n, blockTimeSec: 500n, launchAt: 500n, baseFeeBps: 200n, wallet: TRADER, creator: CREATOR, firstBuy: null,
  }));
  assert.equal(buy6.feeBps, 5_000);
  assert.equal(buy6.grossRaw, 1_000n);
  // A gen-6 trade read with the gen-7 schedule would be mis-annotated; the generation decides.
  const wrong = annotationForTrade(ctx(5), { side: "buy", wallet: TRADER, amountRaw: 1_900n, tokenRaw: 1n, txHash: TX, blockTimeSec: 500 });
  assert.equal(wrong.feeBps, 5_000);
});

// --------------------------------------------------------------------------- keeper due filter

test("isLikelyDue: gen-7 is due only at sell-out; the raise branch is gen-6 only", () => {
  const near = { netRaisedWei: 99n * E18, soldRaw: CURVE_SUPPLY - 1n, curveSupply: CURVE_SUPPLY, nativeTarget: 100n * E18, slackBps: 200 };
  assert.equal(isLikelyDue(near), true, "gen-6: within 2% of the native target");
  assert.equal(isLikelyDue({ ...near, soldOutOnly: false }), true);
  assert.equal(isLikelyDue({ ...near, soldOutOnly: true }), false, "gen-7: not sold out, not due");
  assert.equal(isLikelyDue({ ...near, soldRaw: CURVE_SUPPLY, soldOutOnly: true }), true);
  assert.equal(isLikelyDue({ ...near, netRaisedWei: 0n, soldRaw: CURVE_SUPPLY, nativeTarget: null, soldOutOnly: true }), true);
});

const G6 = "0x00000000000000000000000000000000000006c1";
const G7 = "0x00000000000000000000000000000000000007c1";
const G7_OUT = "0x00000000000000000000000000000000000007c2";

function dueDb(rows: Array<Record<string, unknown>>) {
  const seen: string[] = [];
  return {
    seen,
    async query(sql: string) {
      seen.push(sql);
      if (/join public\.curve_trades t/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

test("due candidates: gen-7 rows carry soldOutOnly; gen-6 rows keep their exact old shape and order column", async () => {
  const db = dueDb([
    { campaign_address: G6, net_raised_raw: String(49n * E18), sold_raw: "12", campaign_generation: 5 },
    { campaign_address: G7, net_raised_raw: String(49n * E18), sold_raw: "12", campaign_generation: 6 },
    { campaign_address: G6, net_raised_raw: "1", sold_raw: "1", campaign_generation: null },
  ]);
  const out = await listTradingDueCandidates(db, 97, 5);
  assert.deepEqual(out, [
    { campaign: G6, netRaisedWei: 49n * E18, soldRaw: 12n },
    { campaign: G7, netRaisedWei: 49n * E18, soldRaw: 12n, soldOutOnly: true },
    { campaign: G6, netRaisedWei: 1n, soldRaw: 1n },
  ]);
  // `order by 2` must still be the net raise: the generation column is appended last.
  const sql = db.seen[0];
  const select = sql.slice(sql.indexOf("select") + 6, sql.indexOf("from public.campaigns"));
  const cols = select.split(/\)::text as |,\n\s*max\(/);
  assert.match(cols[0], /c\.campaign_address,/);
  assert.match(cols[1] ?? "", /^net_raised_raw/);
  assert.match(sql, /max\(c\.campaign_generation\) as campaign_generation\s+from public\.campaigns c/);
  assert.match(sql, /order by 2 desc, c\.campaign_address/);
});

test("listDueCampaigns: a gen-7 coin within 2% of its raise is not simulated; sold out it is; gen-6 as before", async () => {
  const db = dueDb([
    { campaign_address: G6, net_raised_raw: String(99n * E18), sold_raw: "1", campaign_generation: 5 },
    { campaign_address: G7, net_raised_raw: String(99n * E18), sold_raw: String(CURVE_SUPPLY - 1n), campaign_generation: 6 },
    { campaign_address: G7_OUT, net_raised_raw: String(100n * E18), sold_raw: String(CURVE_SUPPLY), campaign_generation: 6 },
  ]);
  const r: KeeperReader = {
    async readCampaign() {
      throw new Error("unused");
    },
    async simulate() {
      throw new Error("unused");
    },
    async blockTimestamp() {
      return 0n;
    },
    async repairContext() {
      return null;
    },
    async dueInputs() {
      return { curveSupply: CURVE_SUPPLY, nativeTarget: 100n * E18 };
    },
  };
  const due = await listDueCampaigns({ db, chainId: 97, reader: r, cfg: { maxGas: 1n, minFlushWei: 1n, maxRepairHalvings: 1, dueSlackBps: 200 } });
  assert.deepEqual(due, [G6, G7_OUT]);
});

// ------------------------------------------------------------------- creator-choice impact estimate

test("buyback impact: the gen-7 estimate is the curve's own after-price; the linear one understates it on a CP curve", () => {
  const { vN, vT } = CURVES[0];
  for (const s of [0n, CURVE_SUPPLY / 4n, CURVE_SUPPLY / 2n]) {
    const a = 5_000_000n * E18;
    const before: bigint = shared.spotPrice(vN, vT, s);
    const cost: bigint = shared.buyCostNoFee(vN, vT, s, a);
    const exactAfter: bigint = shared.spotPrice(vN, vT, s + a);
    const est = gen7CurvePriceAfter(before, cost, a);
    const diff = est > exactAfter ? est - exactAfter : exactAfter - est;
    assert.ok(diff * 1_000_000n <= exactAfter, `gen-7 estimate ${est} vs exact ${exactAfter}`);
    assert.ok(linearCurvePriceAfter(before, cost, a) < exactAfter, "the linear midpoint understates CP impact");
  }
  assert.equal(gen7CurvePriceAfter(100n, 0n, 0n), 100n);
  assert.equal(gen7CurvePriceAfter(100n, 1n, 10n * E18), 100n, "never below the price before");
});

test("platform coins carry the campaign generation (absent column -> null, the gen-6 estimate)", async () => {
  const VAULT = "0x00000000000000000000000000000000000000fe";
  const rows = [
    { campaign_address: G6.toUpperCase().replace("0X", "0x"), graduation_stage: "trading", graduated_pool: null, fee_choice: 4, token_address: null, creator_address: null, created_block: 3, campaign_generation: 5 },
    { campaign_address: G7, graduation_stage: "trading", graduated_pool: null, fee_choice: 4, token_address: null, creator_address: null, created_block: 4, campaign_generation: 6 },
    { campaign_address: G7_OUT, graduation_stage: "trading", graduated_pool: null, fee_choice: 4, token_address: null, creator_address: null, created_block: 5 },
  ];
  let sql = "";
  const coins = await listPlatformCoins({ async query(q: string) { sql = q; return { rows }; } }, 97, VAULT);
  assert.match(sql, /s\.campaign_generation/);
  assert.deepEqual(coins.map((c) => c.campaignGeneration), [5, 6, null]);
  assert.equal(coins[0].campaign, G6);
});

// ------------------------------------------------------------------------- ABI pins (gen-7 artifacts)

function artifactIface(path: string): ethers.Interface | null {
  const file = join(ARTIFACTS, path);
  if (!existsSync(file)) return null;
  return new ethers.Interface(JSON.parse(readFileSync(file, "utf8")).abi);
}

function sighashes(iface: ethers.Interface): Set<string> {
  const out = new Set<string>();
  iface.forEachFunction((f) => out.add(`fn ${f.format("sighash")}`));
  iface.forEachEvent((e) => out.add(`ev ${e.format("sighash")}`));
  iface.forEachError((e) => out.add(`er ${e.format("sighash")}`));
  return out;
}

function assertAbiCovered(abi: readonly string[], artifact: ethers.Interface, label: string) {
  const have = sighashes(artifact);
  const mine = new ethers.Interface(abi as unknown as string[]);
  mine.forEachFunction((f) => assert.ok(have.has(`fn ${f.format("sighash")}`), `${label} lacks ${f.format("sighash")}`));
  mine.forEachEvent((e) => assert.ok(have.has(`ev ${e.format("sighash")}`), `${label} lacks event ${e.format("sighash")}`));
  mine.forEachError((e) => assert.ok(have.has(`er ${e.format("sighash")}`), `${label} lacks error ${e.format("sighash")}`));
}

test("gen-7 artifacts answer every campaign/factory fragment the indexer decodes with (skipped when not compiled)", (t) => {
  const campaigns = [
    "LaunchCampaignGen7.sol/LaunchCampaignGen7.json",
    "BnbQuoteLaunchCampaignGen7.sol/BnbQuoteLaunchCampaignGen7.json",
    "RobinhoodStockLaunchCampaignGen7.sol/RobinhoodStockLaunchCampaignGen7.json",
  ];
  const factory = artifactIface("LaunchFactoryGen7.sol/LaunchFactoryGen7.json");
  if (!factory) {
    t.skip("artifacts/contracts/gen7 not compiled in this checkout");
    return;
  }
  for (const path of campaigns) {
    const iface = artifactIface(path);
    if (!iface) continue;
    assertAbiCovered(GEN5_CAMPAIGN_ABI, iface, path);
    // The curve views: gen-7 has the virtual reserves and no linear params.
    assert.ok(iface.getFunction("virtualNative") && iface.getFunction("virtualToken"), path);
    assert.equal(iface.getFunction("basePrice"), null, path);
    assert.equal(iface.getFunction("priceSlope"), null, path);
    assert.ok(iface.getFunction("sold"), path);
  }
  assertAbiCovered(GEN6_FACTORY_ABI, factory, "LaunchFactoryGen7");
  assertAbiCovered([CAMPAIGN_CREATED_EVENT_V3], factory, "LaunchFactoryGen7");
  const basic = artifactIface("BnbBasicLaunchFactoryGen7.sol/BnbBasicLaunchFactoryGen7.json");
  if (basic) assertAbiCovered(GEN6_FACTORY_ABI, basic, "BnbBasicLaunchFactoryGen7");
});

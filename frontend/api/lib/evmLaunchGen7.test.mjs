import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  Gen6CreateOptionError,
  prepareGen6CreateOptions,
  quoteCreatorFirstBuyForContext,
  quoteGen6CreatorFirstBuy,
  readGen6FactoryCreateContext,
  validateGen6FirstBuy,
} from "./evmLaunchGen6.js";
import {
  curveForMarketCap,
  gen7CurveFromConfig,
  graduationRaise,
  quoteGen7FirstBuy,
} from "../../shared/evmGen7Curve.mjs";

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const FACTORY = "0x1111111111111111111111111111111111111111";
const ORACLE = "0x2222222222222222222222222222222222222222";

// A $50K market cap at $600 per BNB: 83.33 BNB for the whole supply at the graduation price.
const MC = (50_000n * WAD * WAD) / (600n * WAD);
const gen7Curve = gen7CurveFromConfig({ totalSupply: SUPPLY, curveBps: 8500n, liquidityTokenBps: 1300n, marketCapNativeWei: MC });
const gen7Context = {
  factoryGeneration: 7,
  totalSupply: SUPPLY,
  curveBps: 8500n,
  liquidityTokenBps: 1300n,
  curveSupply: gen7Curve.curveSupply,
  virtualNative: gen7Curve.virtualNative,
  virtualToken: gen7Curve.virtualToken,
  protocolFeeBps: 200n,
  graduationTargetUsdWad: 50_000n * WAD,
  marketCapNativeWei: MC,
  graduationRaiseWei: graduationRaise(gen7Curve.virtualNative, gen7Curve.virtualToken, gen7Curve.curveSupply),
};
// The generation 6 context of evmLaunchGen6.test.mjs (no factoryGeneration: read as generation 6).
const gen6Context = {
  totalSupply: SUPPLY,
  curveBps: 8000n,
  basePrice: 1_000_000_000n,
  priceSlope: 1_000n,
  protocolFeeBps: 200n,
  nativeTargetWei: 40n * WAD,
};

function code(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Gen6CreateOptionError, `expected Gen6CreateOptionError, got ${error}`);
    return { code: error.code, message: error.message };
  }
  assert.fail("expected a refusal");
}

test("gen-7 first buy: exactly 70% of supply passes with no cost cap; 70% + 1 is refused with a 70% message", () => {
  const max = (SUPPLY * 7000n) / 10_000n;
  const q = quoteGen7FirstBuy({ tokens: max, ...gen7Curve, protocolFeeBps: 200n });
  // Plan section 2: a 70% first buy costs 42.1% of the raise, whatever the target.
  assert.equal((q.costNoFee * 1000n) / gen7Context.graduationRaiseWei, 421n);
  // No cost cap: nativeTargetWei is not part of a gen-7 context, and a tiny one would not matter.
  const ok = validateGen6FirstBuy({ firstBuyTokens: max, firstBuyMaxCost: q.total }, { ...gen7Context, nativeTargetWei: 1n });
  assert.equal(ok.quotedCost, q.total.toString());
  assert.equal(ok.costNoFee, q.costNoFee.toString());
  assert.equal(ok.fee, q.fee.toString());
  assert.equal(ok.generation, 7);
  assert.equal(ok.maxTokens, max.toString());
  assert.deepEqual(ok.curve, {
    kind: "cp",
    virtualNative: gen7Curve.virtualNative.toString(),
    virtualToken: gen7Curve.virtualToken.toString(),
    curveSupply: gen7Curve.curveSupply.toString(),
    marketCapNativeWei: MC.toString(),
    graduationRaiseWei: gen7Context.graduationRaiseWei.toString(),
  });

  const tooLarge = code(() => validateGen6FirstBuy({ firstBuyTokens: max + 1n, firstBuyMaxCost: q.total * 2n }, gen7Context));
  assert.equal(tooLarge.code, "GEN6_FIRST_BUY_TOO_LARGE");
  assert.match(tooLarge.message, /at most 70% of the supply/);
});

test("gen-7 first buy: tokens above the curve are refused even under the 70% cap", () => {
  const smallCurve = { ...gen7Context, curveBps: 6000n };
  const tokens = (SUPPLY * 6500n) / 10_000n;
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: 10n ** 30n }, smallCurve)).code, "GEN6_FIRST_BUY_TOO_LARGE");
});

test("gen-7 first buy: max cost must cover the exact cost and stay within the slack", () => {
  const tokens = 100_000_000n * WAD;
  const { total } = quoteGen7FirstBuy({ tokens, ...gen7Curve, protocolFeeBps: 200n });
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: total - 1n }, gen7Context)).code, "GEN6_FIRST_BUY_MAX_COST_TOO_LOW");
  const ceiling = total + (total * 500n) / 10_000n;
  assert.equal(validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: ceiling }, gen7Context, { slackBps: 500n }).maxCost, ceiling.toString());
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: ceiling + 1n }, gen7Context, { slackBps: 500n })).code, "GEN6_FIRST_BUY_MAX_COST_TOO_HIGH");
});

test("gen-6 results are unchanged: same quote, same 10% rule and message, same cost cap, same return shape", () => {
  const tokens = 1_000_000n * WAD;
  const legacy = quoteGen6CreatorFirstBuy({ tokens, ...gen6Context });
  assert.deepEqual(quoteCreatorFirstBuyForContext(tokens, gen6Context), legacy);
  assert.deepEqual(quoteCreatorFirstBuyForContext(tokens, { ...gen6Context, factoryGeneration: 6 }), legacy);
  const out = validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: legacy.cost }, gen6Context);
  assert.deepEqual(Object.keys(out), ["tokens", "maxCost", "costNoFee", "fee", "quotedCost"]);
  assert.deepEqual(out, validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: legacy.cost }, { ...gen6Context, factoryGeneration: 6 }));

  const cheap = { ...gen6Context, nativeTargetWei: 10n ** 30n };
  const tenPct = SUPPLY / 10n;
  const tooLarge = code(() => validateGen6FirstBuy({ firstBuyTokens: tenPct + 1n, firstBuyMaxCost: 10n ** 30n }, cheap));
  assert.equal(tooLarge.code, "GEN6_FIRST_BUY_TOO_LARGE");
  assert.equal(tooLarge.message, `The first buy can be at most 10% of the supply (${tenPct.toString()} token units); asked for ${(tenPct + 1n).toString()}.`);

  const tight = { ...gen6Context, nativeTargetWei: 1n };
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: legacy.cost }, tight)).code, "GEN6_FIRST_BUY_TOO_EXPENSIVE");
});

test("gen-7 prepare: a saved draft's tokens get the gen-7 exact cost plus the slack as max cost", async () => {
  const tokens = 300_000_000n * WAD;
  const out = await prepareGen6CreateOptions({
    source: { feeChoice: 2, firstBuyTokens: tokens.toString() },
    graduationTarget: "0",
    readContext: async () => gen7Context,
    autoMaxCost: true,
    slackBps: 500,
  });
  const { total } = quoteGen7FirstBuy({ tokens, ...gen7Curve, protocolFeeBps: 200n });
  assert.equal(out.requestFields.firstBuyMaxCost, (total + (total * 500n) / 10_000n).toString());
  assert.equal(out.firstBuy.quotedCost, total.toString());
  assert.equal(out.firstBuy.curve.kind, "cp");
});

// ------------------------------------------------------------------ context reader against a fake chain

const GEN6_ABI = [
  "function config() view returns (uint256 totalSupply,uint256 curveBps,uint256 liquidityTokenBps,uint256 basePrice,uint256 priceSlope,uint256 graduationTarget)",
  "function protocolFeeBps() view returns (uint256)",
  "function graduationOracle() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
];
const GEN7_ABI = [
  "function config() view returns (uint256 totalSupply,uint256 curveBps,uint256 liquidityTokenBps,uint256 graduationTarget)",
  "function protocolFeeBps() view returns (uint256)",
  "function graduationOracle() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
  "function curveForMarketCap(uint256,uint256,uint256,uint256) view returns (uint256 virtualNative,uint256 virtualToken)",
];
const ORACLE_ABI = ["function nativeTargetForUsd(uint256) view returns (uint256)"];

/** A provider whose eth_call answers from per-address handlers; records every call. */
function fakeChain(contracts) {
  const calls = [];
  const ifaces = Object.fromEntries(Object.entries(contracts).map(([addr, c]) => [addr.toLowerCase(), { iface: new ethers.Interface(c.abi), handlers: c.handlers }]));
  return {
    calls,
    async call(tx) {
      const target = ifaces[String(tx.to).toLowerCase()];
      if (!target) throw new Error(`no contract at ${tx.to}`);
      const parsed = target.iface.parseTransaction({ data: tx.data });
      calls.push(`${tx.to}:${parsed.name}`);
      const value = target.handlers[parsed.name](...parsed.args);
      return target.iface.encodeFunctionResult(parsed.name, Array.isArray(value) ? value : [value]);
    },
  };
}

function gen7Chain({ curveOverride } = {}) {
  return fakeChain({
    [FACTORY]: {
      abi: GEN7_ABI,
      handlers: {
        config: () => [SUPPLY, 8500n, 1300n, 50_000n * WAD],
        protocolFeeBps: () => 200n,
        graduationOracle: () => ORACLE,
        FACTORY_GENERATION: () => 7n,
        curveForMarketCap: (mc, supply, curveBps, liqBps) => {
          const c = curveForMarketCap(mc, supply, curveBps, liqBps);
          return curveOverride ? curveOverride(c) : [c.virtualNative, c.virtualToken];
        },
      },
    },
    [ORACLE]: { abi: ORACLE_ABI, handlers: { nativeTargetForUsd: (usd) => (usd * WAD) / (600n * WAD) } },
  });
}

test("context reader: a gen-7 factory is read with its 4-field config and the curve cross-checked against the factory", async () => {
  const provider = gen7Chain();
  const ctx = await readGen6FactoryCreateContext({ provider, factoryAddress: FACTORY, graduationTarget: 0, factoryGeneration: 7 });
  assert.equal(ctx.factoryGeneration, 7);
  assert.equal(ctx.graduationTargetUsdWad, 50_000n * WAD, "0 means the factory default target");
  assert.equal(ctx.marketCapNativeWei, MC);
  assert.equal(ctx.virtualNative, gen7Curve.virtualNative);
  assert.equal(ctx.virtualToken, gen7Curve.virtualToken);
  assert.equal(ctx.curveSupply, (SUPPLY * 8500n) / 10_000n);
  assert.equal(ctx.graduationRaiseWei, gen7Context.graduationRaiseWei);
  assert.ok(provider.calls.some((c) => c.endsWith(":curveForMarketCap")));

  const at30 = await readGen6FactoryCreateContext({ provider: gen7Chain(), factoryAddress: FACTORY, graduationTarget: (30_000n * WAD).toString() });
  assert.equal(at30.graduationTargetUsdWad, 30_000n * WAD);
  assert.equal(at30.marketCapNativeWei, (30_000n * WAD) / 600n);
});

test("context reader: a factory curve that differs from the API maths refuses (no signature)", async () => {
  const provider = gen7Chain({ curveOverride: (c) => [c.virtualNative + 1n, c.virtualToken] });
  await assert.rejects(readGen6FactoryCreateContext({ provider, factoryAddress: FACTORY }), /differs/);
  // and through prepare it is the usual 503 price-unavailable refusal
  await assert.rejects(
    prepareGen6CreateOptions({
      source: { feeChoice: 1, firstBuyTokens: (1_000n * WAD).toString(), firstBuyMaxCost: "1" },
      graduationTarget: "0",
      readContext: ({ graduationTarget }) => readGen6FactoryCreateContext({ provider, factoryAddress: FACTORY, graduationTarget }),
    }),
    (error) => error.code === "GEN6_FIRST_BUY_PRICE_UNAVAILABLE" && error.httpStatus === 503,
  );
});

test("context reader: the caller's generation must match the factory's own", async () => {
  await assert.rejects(
    readGen6FactoryCreateContext({ provider: gen7Chain(), factoryAddress: FACTORY, factoryGeneration: 6 }),
    /reports generation 7, not 6/,
  );
});

test("context reader: a gen-6 factory returns the same values as before (plus factoryGeneration)", async () => {
  const provider = fakeChain({
    [FACTORY]: {
      abi: GEN6_ABI,
      handlers: {
        config: () => [SUPPLY, 7000n, 2800n, 1_000_000_000n, 1_000n, 30_000n * WAD],
        protocolFeeBps: () => 200n,
        graduationOracle: () => ORACLE,
        FACTORY_GENERATION: () => 6n,
      },
    },
    [ORACLE]: { abi: ORACLE_ABI, handlers: { nativeTargetForUsd: (usd) => (usd * WAD) / (600n * WAD) } },
  });
  const ctx = await readGen6FactoryCreateContext({ provider, factoryAddress: FACTORY, graduationTarget: 0, factoryGeneration: 6 });
  assert.deepEqual(ctx, {
    factoryGeneration: 6,
    totalSupply: SUPPLY,
    curveBps: 7000n,
    basePrice: 1_000_000_000n,
    priceSlope: 1_000n,
    protocolFeeBps: 200n,
    graduationTargetUsdWad: 30_000n * WAD,
    nativeTargetWei: (30_000n * WAD) / 600n,
  });
  assert.ok(!provider.calls.some((c) => c.endsWith(":curveForMarketCap")), "no gen-7 read on a gen-6 factory");
  const explicit = await readGen6FactoryCreateContext({ provider, factoryAddress: FACTORY, graduationTarget: (15_000n * WAD).toString() });
  assert.equal(explicit.nativeTargetWei, (15_000n * WAD) / 600n);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  Gen6CreateOptionError,
  assertNoGen6FieldsForLegacy,
  curveArea,
  hasGen6CreateFields,
  parseGen6CreateOptions,
  prepareGen6CreateOptions,
  quoteGen6CreatorFirstBuy,
  validateGen6FirstBuy,
} from "./evmLaunchGen6.js";

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
// A realistic curve: base 1e9 wei per token, slope 1e3 (docs: real slopes ~1e3), 80% on the curve.
const context = {
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
    return error.code;
  }
  assert.fail("expected a refusal");
}

test("fee choice: 1..4 or names; split needs 1..99; the others need 0", () => {
  assert.equal(parseGen6CreateOptions({ feeChoice: 1 }).feeChoice, 1);
  assert.equal(parseGen6CreateOptions({ feeChoice: "buyback" }).feeChoice, 4);
  assert.equal(parseGen6CreateOptions({ feeChoice: "split", feeCreatorPct: 40 }).feeCreatorPct, 40);
  assert.equal(parseGen6CreateOptions({ feeChoice: 2, feeCreatorPct: 0 }).feeCreatorPct, 0);
  assert.equal(code(() => parseGen6CreateOptions({})), "GEN6_FEE_CHOICE_REQUIRED");
  for (const bad of [0, 5, -1, 1.5, "hold"]) assert.equal(code(() => parseGen6CreateOptions({ feeChoice: bad })), "GEN6_FEE_CHOICE_INVALID");
  for (const bad of [0, 100, 1.5, undefined]) {
    assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 3, feeCreatorPct: bad })), "GEN6_FEE_CREATOR_PCT_INVALID");
  }
  assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 1, feeCreatorPct: 5 })), "GEN6_FEE_CREATOR_PCT_INVALID");
  assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 4, feeCreatorPct: 99 })), "GEN6_FEE_CREATOR_PCT_INVALID");
});

test("first buy fields: whole wei only; max cost iff tokens", () => {
  const none = parseGen6CreateOptions({ feeChoice: 1 });
  assert.equal(none.firstBuyTokens, 0n);
  assert.equal(none.firstBuyMaxCost, 0n);
  assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 1, firstBuyTokens: "1.5" })), "GEN6_FIRST_BUY_TOKENS_INVALID");
  assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 1, firstBuyTokens: "-1" })), "GEN6_FIRST_BUY_TOKENS_INVALID");
  assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 1, firstBuyMaxCost: "5" })), "GEN6_FIRST_BUY_MAX_COST_INVALID");
  assert.equal(code(() => parseGen6CreateOptions({ feeChoice: 1, firstBuyTokens: "5" })), "GEN6_FIRST_BUY_MAX_COST_INVALID");
  assert.equal(parseGen6CreateOptions({ feeChoice: 1, firstBuyTokens: "5" }, { autoMaxCost: true }).firstBuyMaxCost, 0n);
});

test("curve math is LaunchCampaign._area with floors", () => {
  const x = 12_345n * WAD + 7n;
  const expected = (x * context.basePrice) / WAD + (context.priceSlope * x * x) / (2n * WAD * WAD);
  assert.equal(curveArea(x, context.basePrice, context.priceSlope), expected);
  const q = quoteGen6CreatorFirstBuy({ tokens: x, ...context });
  assert.equal(q.fee, (q.costNoFee * 200n) / 10_000n);
  assert.equal(q.cost, q.costNoFee + q.fee);
});

test("first buy: exactly 10% passes when affordable, 10% + 1 is refused", () => {
  const tenPct = SUPPLY / 10n;
  const cheap = { ...context, nativeTargetWei: 10n ** 30n };
  const { cost } = quoteGen6CreatorFirstBuy({ tokens: tenPct, ...cheap });
  const ok = validateGen6FirstBuy({ firstBuyTokens: tenPct, firstBuyMaxCost: cost }, cheap);
  assert.equal(ok.quotedCost, cost.toString());
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tenPct + 1n, firstBuyMaxCost: cost * 2n }, cheap)), "GEN6_FIRST_BUY_TOO_LARGE");
});

test("first buy: cost above half the live native target is refused (FirstBuyTooExpensive)", () => {
  const tokens = 100_000_000n * WAD;
  const { costNoFee, cost } = quoteGen6CreatorFirstBuy({ tokens, ...context });
  const atLimit = { ...context, nativeTargetWei: costNoFee * 2n };
  assert.doesNotThrow(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: cost }, atLimit));
  const below = { ...context, nativeTargetWei: costNoFee * 2n - 1n };
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: cost }, below)), "GEN6_FIRST_BUY_TOO_EXPENSIVE");
});

test("first buy: max cost between the exact cost and cost + slack", () => {
  const tokens = 1_000_000n * WAD;
  const { cost } = quoteGen6CreatorFirstBuy({ tokens, ...context });
  assert.equal(code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: cost - 1n }, context)), "GEN6_FIRST_BUY_MAX_COST_TOO_LOW");
  const ceiling = cost + (cost * 500n) / 10_000n;
  assert.doesNotThrow(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: ceiling }, context, { slackBps: 500n }));
  assert.equal(
    code(() => validateGen6FirstBuy({ firstBuyTokens: tokens, firstBuyMaxCost: ceiling + 1n }, context, { slackBps: 500n })),
    "GEN6_FIRST_BUY_MAX_COST_TOO_HIGH",
  );
});

test("prepareGen6CreateOptions: no chain read without a first buy; auto max cost for saved drafts; price failure is a 503", async () => {
  let reads = 0;
  const readContext = async () => {
    reads += 1;
    return context;
  };
  const plain = await prepareGen6CreateOptions({ source: { feeChoice: "holders" }, graduationTarget: "0", readContext });
  assert.equal(reads, 0);
  assert.deepEqual(plain.requestFields, { firstBuyTokens: "0", firstBuyMaxCost: "0", feeChoice: 2, feeCreatorPct: 0 });
  assert.equal(plain.feeChoiceName, "holders");

  const tokens = 2_000_000n * WAD;
  const auto = await prepareGen6CreateOptions({ source: { feeChoice: 1, firstBuyTokens: tokens.toString() }, readContext, autoMaxCost: true, slackBps: 500n });
  const { cost } = quoteGen6CreatorFirstBuy({ tokens, ...context });
  assert.equal(auto.requestFields.firstBuyMaxCost, (cost + (cost * 500n) / 10_000n).toString());
  assert.equal(auto.firstBuy.quotedCost, cost.toString());
  assert.equal(reads, 1);

  await assert.rejects(
    prepareGen6CreateOptions({ source: { feeChoice: 1, firstBuyTokens: "1", firstBuyMaxCost: "1" }, readContext: async () => { throw new Error("rpc down"); } }),
    (error) => error.code === "GEN6_FIRST_BUY_PRICE_UNAVAILABLE" && error.httpStatus === 503,
  );
});

test("legacy factories refuse the generation-6 fields; zeros and absence pass", () => {
  assert.doesNotThrow(() => assertNoGen6FieldsForLegacy({ name: "x" }, 4));
  assert.doesNotThrow(() => assertNoGen6FieldsForLegacy({ firstBuyTokens: "0" }, 4));
  assert.equal(hasGen6CreateFields({ feeChoice: 1 }), true);
  assert.equal(code(() => assertNoGen6FieldsForLegacy({ feeChoice: 1 }, 4)), "GEN6_FIELDS_ON_LEGACY_FACTORY");
  assert.equal(code(() => assertNoGen6FieldsForLegacy({ firstBuyTokens: "10" }, 4)), "GEN6_FIELDS_ON_LEGACY_FACTORY");
});

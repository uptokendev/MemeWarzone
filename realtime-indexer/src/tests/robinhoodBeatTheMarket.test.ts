import test from "node:test";
import assert from "node:assert/strict";

const {
  calculateRobinhoodBeatTheMarket,
  ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION,
} = await import("../robinhoodBeatTheMarket.js");

test("computes mathematically explicit relative return instead of percentage-point subtraction", () => {
  const metric = calculateRobinhoodBeatTheMarket({
    startMemeUsd: "1",
    endMemeUsd: "1.2",
    startQuoteUsd: "100",
    endQuoteUsd: "110",
  });
  assert.equal(metric.healthy, true);
  if (!metric.healthy) return;
  assert.equal(metric.formulaVersion, ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION);
  assert.equal(metric.memeReturn, "0.2");
  assert.equal(metric.quoteAssetReturn, "0.1");
  assert.equal(metric.relativeReturn, "0.090909090909090909");
  assert.equal(metric.percentagePointDifference, "0.1");
});

test("equal MEME and Stock Token returns produce zero relative performance", () => {
  const metric = calculateRobinhoodBeatTheMarket({
    startMemeUsd: "0.004",
    endMemeUsd: "0.0036",
    startQuoteUsd: "250",
    endQuoteUsd: "225",
  });
  assert.equal(metric.healthy, true);
  if (!metric.healthy) return;
  assert.equal(metric.memeReturn, "-0.1");
  assert.equal(metric.quoteAssetReturn, "-0.1");
  assert.equal(metric.relativeReturn, "0");
  assert.equal(metric.percentagePointDifference, "0");
});

test("can outperform a falling Stock Token even while MEME also falls", () => {
  const metric = calculateRobinhoodBeatTheMarket({
    startMemeUsd: "2",
    endMemeUsd: "1.8",
    startQuoteUsd: "100",
    endQuoteUsd: "80",
  });
  assert.equal(metric.healthy, true);
  if (!metric.healthy) return;
  assert.equal(metric.memeReturn, "-0.1");
  assert.equal(metric.quoteAssetReturn, "-0.2");
  assert.equal(metric.relativeReturn, "0.125");
  assert.equal(metric.percentagePointDifference, "0.1");
});

test("uses bigint fixed-point math for tiny normalized prices and large quote prices", () => {
  const metric = calculateRobinhoodBeatTheMarket({
    startMemeUsd: "0.000000000123456789",
    endMemeUsd: "0.000000000246913578",
    startQuoteUsd: "123456789012.123456789",
    endQuoteUsd: "185185183518.1851851835",
  });
  assert.equal(metric.healthy, true);
  if (!metric.healthy) return;
  assert.equal(metric.memeReturn, "1");
  assert.equal(metric.quoteAssetReturn, "0.5");
  assert.equal(metric.relativeReturn, "0.333333333333333333");
});

test("fails closed when any normalized boundary price is missing, zero, negative, or malformed", () => {
  for (const bad of [null, "", "0", "-1", "not-a-price"]) {
    const metric = calculateRobinhoodBeatTheMarket({
      startMemeUsd: "1",
      endMemeUsd: "1.1",
      startQuoteUsd: "100",
      endQuoteUsd: bad,
    });
    assert.equal(metric.healthy, false);
    assert.equal(metric.formulaVersion, ROBINHOOD_BEAT_THE_MARKET_FORMULA_VERSION);
  }
});

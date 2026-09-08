import test from "node:test";
import assert from "node:assert/strict";

process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
process.env.ABLY_API_KEY ||= "test.test";

const { evaluateNativeUsdRound } = await import("../robinhoodNativeUsdOracle.js");

test("accepts a fresh positive native USD oracle round", () => {
  const result = evaluateNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 42n,
    answeredInRound: 42n,
    answer: 250_000_000_000n,
    updatedAtSeconds: 9_950,
    decimals: 8,
    maxAgeSeconds: 900,
  });
  assert.equal(result.healthy, true);
  assert.equal(result.priceUsd, "2500.0");
  assert.equal(result.error, null);
});

test("rejects stale, incomplete and non-positive native USD oracle rounds", () => {
  const stale = evaluateNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 42n,
    answeredInRound: 42n,
    answer: 250_000_000_000n,
    updatedAtSeconds: 8_000,
    decimals: 8,
    maxAgeSeconds: 900,
  });
  assert.equal(stale.healthy, false);
  assert.match(stale.error || "", /stale/);

  const incomplete = evaluateNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 42n,
    answeredInRound: 41n,
    answer: 250_000_000_000n,
    updatedAtSeconds: 9_950,
    decimals: 8,
    maxAgeSeconds: 900,
  });
  assert.equal(incomplete.healthy, false);
  assert.match(incomplete.error || "", /answeredInRound/);

  const nonPositive = evaluateNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 42n,
    answeredInRound: 42n,
    answer: 0n,
    updatedAtSeconds: 9_950,
    decimals: 8,
    maxAgeSeconds: 900,
  });
  assert.equal(nonPositive.healthy, false);
  assert.match(nonPositive.error || "", /non-positive/);
});

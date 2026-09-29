import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const { jupiterRawUnitUsd } = await import("../solanaMarketStats.js");

const reply = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

test("a scaled mint is priced per raw unit from Jupiter's prescaled price", async () => {
  const mint = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
  const got = await jupiterRawUnitUsd(mint, reply({ [mint]: { usdPrice: 230.717, scaledUiConfig: { usdPricePrescaled: 231.109 } } }));
  assert.deepEqual({ value: got?.value, prescaled: got?.prescaled }, { value: 231.109, prescaled: true });
});

test("a mint without a multiplier reports its plain price, not prescaled", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const got = await jupiterRawUnitUsd(mint, reply({ [mint]: { usdPrice: 0.9998 } }));
  assert.deepEqual({ value: got?.value, prescaled: got?.prescaled }, { value: 0.9998, prescaled: false });
});

import assert from "node:assert/strict";
import test from "node:test";

import { harvestLpFees, lockerAddressFor, lpHarvestMode, LP_LOCKER_MAINNET_DEFAULTS } from "./evmLpHarvestCrank.js";

const POOL_A = "0x1111111111111111111111111111111111111111";
const POOL_B = "0x2222222222222222222222222222222222222222";
const OLD = "0x3333333333333333333333333333333333333333";
const WBNB = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";

test("mode and locker addresses", () => {
  assert.equal(lpHarvestMode({}), "off");
  assert.equal(lpHarvestMode({ EVM_LP_HARVEST: "Send" }), "send");
  assert.equal(lockerAddressFor(56, {}), LP_LOCKER_MAINNET_DEFAULTS[56]);
  assert.equal(lockerAddressFor(4663, {}), LP_LOCKER_MAINNET_DEFAULTS[4663]);
  assert.equal(lockerAddressFor(97, {}), "", "testnets need the env");
  assert.equal(lockerAddressFor(56, { LP_LOCKER_ADDRESS_56: "0xabc" }), "0xabc");
});

function fakeChain({ fees = {}, pending = {}, balance = 10n ** 16n } = {}) {
  const sent = [];
  const fn = (name, impl) => {
    const f = async (...args) => { sent.push({ name, args }); return { hash: `0x${name}`, wait: async () => ({ status: 1 }) }; };
    f.staticCall = impl;
    return f;
  };
  const contract = {
    harvest: fn("harvest", async (pool) => {
      if (!(pool in fees)) throw Object.assign(new Error("execution reverted"), { revert: { name: "PoolNotRegistered" } });
      return fees[pool];
    }),
    pendingProtocolToken: async (token) => pending[token] || 0n,
    retryPendingProtocolToken: fn("retryPendingProtocolToken", async () => 1n),
  };
  return { sent, c: { wallet: { address: "0xop" }, provider: { getBalance: async () => balance }, contract, poolTokens: async () => [TOKEN, WBNB] } };
}

const rows = [
  { chain_id: 56, campaign_address: "0xc1", symbol: "AAA", dex_pair_address: POOL_A },
  { chain_id: 56, campaign_address: "0xc2", symbol: "BBB", dex_pair_address: POOL_B },
  { chain_id: 56, campaign_address: "0xc3", symbol: "OLD", dex_pair_address: OLD },
];
const db = { query: async () => ({ rows }) };

test("harvests only pools whose simulation collects something; unknown pools are skipped for a day", async () => {
  const chain = fakeChain({ fees: { [POOL_A]: [10n, 0n], [POOL_B]: [0n, 0n] } });
  const skip = new Map();
  const out = await harvestLpFees({ db, mode: "send", skip, nowMs: 1000, chainFor: (id) => (id === 56 ? chain.c : null) });
  assert.deepEqual(chain.sent.map((s) => [s.name, s.args[0].toLowerCase()]), [["harvest", POOL_A]]);
  assert.equal(out[0].amount0, "10");
  assert.equal(out[0].status, "sent");
  assert.ok(skip.get(`56:${OLD}`) > 1000);
  // The unknown pool is not simulated again within the day.
  const again = fakeChain({ fees: { [POOL_A]: [0n, 0n], [POOL_B]: [0n, 0n] } });
  let simulatedOld = false;
  const orig = again.c.contract.harvest.staticCall;
  again.c.contract.harvest.staticCall = async (pool, ...rest) => { if (pool === OLD) simulatedOld = true; return orig(pool, ...rest); };
  await harvestLpFees({ db, mode: "send", skip, nowMs: 2000, chainFor: (id) => (id === 56 ? again.c : null) });
  assert.equal(simulatedOld, false);
});

test("a parked protocol share is retried once per token per pass", async () => {
  const chain = fakeChain({ fees: { [POOL_A]: [0n, 0n], [POOL_B]: [0n, 0n] }, pending: { [WBNB]: 7n } });
  const out = await harvestLpFees({ db, mode: "send", chainFor: (id) => (id === 56 ? chain.c : null) });
  const retries = chain.sent.filter((s) => s.name === "retryPendingProtocolToken");
  assert.equal(retries.length, 1, "WBNB is shared by both pools but retried once");
  assert.equal(out.find((o) => o.step === "retryPendingProtocolToken").amount, "7");
});

test("dry and no-gas never send", async () => {
  const dry = fakeChain({ fees: { [POOL_A]: [10n, 5n], [POOL_B]: [0n, 0n] } });
  const out = await harvestLpFees({ db, mode: "dry", chainFor: (id) => (id === 56 ? dry.c : null) });
  assert.equal(dry.sent.length, 0);
  assert.equal(out[0].status, "dry-run");
  const poor = fakeChain({ fees: { [POOL_A]: [10n, 5n], [POOL_B]: [0n, 0n] }, balance: 0n });
  const [o] = await harvestLpFees({ db, mode: "send", chainFor: (id) => (id === 56 ? poor.c : null) });
  assert.equal(o.status, "no-gas");
  assert.equal(poor.sent.length, 0);
  assert.deepEqual(await harvestLpFees({ db: { query: async () => { throw new Error("must not query"); } }, mode: "off" }), []);
});

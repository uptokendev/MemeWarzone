import assert from "node:assert/strict";
import test from "node:test";

import { extraLockersFor, harvestLpFees, lockerAddressFor, lpHarvestMode, LP_LOCKER_MAINNET_DEFAULTS } from "./evmLpHarvestCrank.js";

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
  const out = await harvestLpFees({ db, mode: "send", skip, nowMs: 1000, chainFor: (id) => (id === 56 ? chain.c : null), gen7ChainFor: () => null });
  assert.deepEqual(chain.sent.map((s) => [s.name, s.args[0].toLowerCase()]), [["harvest", POOL_A]]);
  assert.equal(out[0].amount0, "10");
  assert.equal(out[0].status, "sent");
  assert.ok(skip.get(`56:${OLD}`) > 1000);
  // The unknown pool is not simulated again within the day.
  const again = fakeChain({ fees: { [POOL_A]: [0n, 0n], [POOL_B]: [0n, 0n] } });
  let simulatedOld = false;
  const orig = again.c.contract.harvest.staticCall;
  again.c.contract.harvest.staticCall = async (pool, ...rest) => { if (pool === OLD) simulatedOld = true; return orig(pool, ...rest); };
  await harvestLpFees({ db, mode: "send", skip, nowMs: 2000, chainFor: (id) => (id === 56 ? again.c : null), gen7ChainFor: () => null });
  assert.equal(simulatedOld, false);
});

test("a parked protocol share is retried once per token per pass", async () => {
  const chain = fakeChain({ fees: { [POOL_A]: [0n, 0n], [POOL_B]: [0n, 0n] }, pending: { [WBNB]: 7n } });
  const out = await harvestLpFees({ db, mode: "send", chainFor: (id) => (id === 56 ? chain.c : null), gen7ChainFor: () => null });
  const retries = chain.sent.filter((s) => s.name === "retryPendingProtocolToken");
  assert.equal(retries.length, 1, "WBNB is shared by both pools but retried once");
  assert.equal(out.find((o) => o.step === "retryPendingProtocolToken").amount, "7");
});

test("dry and no-gas never send", async () => {
  const dry = fakeChain({ fees: { [POOL_A]: [10n, 5n], [POOL_B]: [0n, 0n] } });
  const out = await harvestLpFees({ db, mode: "dry", chainFor: (id) => (id === 56 ? dry.c : null), gen7ChainFor: () => null });
  assert.equal(dry.sent.length, 0);
  assert.equal(out[0].status, "dry-run");
  const poor = fakeChain({ fees: { [POOL_A]: [10n, 5n], [POOL_B]: [0n, 0n] }, balance: 0n });
  const [o] = await harvestLpFees({ db, mode: "send", chainFor: (id) => (id === 56 ? poor.c : null), gen7ChainFor: () => null });
  assert.equal(o.status, "no-gas");
  assert.equal(poor.sent.length, 0);
  assert.deepEqual(await harvestLpFees({ db: { query: async () => { throw new Error("must not query"); } }, mode: "off" }), []);
});

const GEN7_LOCKER = "0x6666666666666666666666666666666666666666";
const GEN6_LOCKER_56 = "0xEEEfa12B14ea922B21bAf05Ad4aa79B2643c8eA6";

test("gen-7 lockers from EVM_GEN7_LOCKER_<id> are harvested after the pinned locker, with their own skip keys", async () => {
  const base = fakeChain({ fees: { [POOL_A]: [10n, 0n] } });
  const gen7 = fakeChain({ fees: { [POOL_B]: [0n, 3n] } });
  const asked = [];
  const skip = new Map();
  const out = await harvestLpFees({
    db,
    env: { EVM_GEN7_LOCKER_56: ` ${GEN7_LOCKER}, not-an-address ` },
    mode: "send",
    skip,
    nowMs: 1000,
    chainFor: (id) => (id === 56 ? base.c : null),
    gen7ChainFor: (id, locker) => {
      asked.push([id, locker]);
      return locker === GEN7_LOCKER ? gen7.c : fakeChain({ fees: {} }).c;
    },
  });
  assert.deepEqual(asked.filter(([id]) => id === 56), [[56, GEN6_LOCKER_56], [56, GEN7_LOCKER]], "the built-in gen-6 locker, then only the valid env address");
  assert.deepEqual(asked.filter(([id]) => id !== 56).map(([id]) => id), [4663], "the env address only on its own chain; 4663 gets its gen-6 locker");
  assert.deepEqual(base.sent.map((s) => s.args[0].toLowerCase()), [POOL_A]);
  assert.deepEqual(gen7.sent.map((s) => s.args[0].toLowerCase()), [POOL_B]);
  const fromGen7 = out.find((o) => o.pool.toLowerCase() === POOL_B);
  assert.equal(fromGen7.locker, GEN7_LOCKER);
  assert.equal(out.find((o) => o.pool.toLowerCase() === POOL_A).locker, undefined, "pinned-locker outcomes keep their shape");
  // Each locker skips the pools it does not know under its own key.
  assert.ok(skip.get(`56:${POOL_B}`) > 1000, "POOL_B is not on the pinned locker");
  assert.ok(skip.get(`56:${GEN7_LOCKER.toLowerCase()}:${POOL_A}`) > 1000, "POOL_A is not on the gen-7 locker");
  assert.ok(skip.get(`56:${OLD}`) > 1000);
});

test("without EVM_GEN7_LOCKER_<id> the only extra locker is the built-in gen-6 one (mainnet), none on testnets", async () => {
  const base = fakeChain({ fees: { [POOL_A]: [10n, 0n], [POOL_B]: [0n, 0n] } });
  const gen6 = fakeChain({ fees: {} });
  const asked = [];
  await harvestLpFees({
    db,
    env: {},
    mode: "send",
    chainFor: (id) => (id === 56 || id === 97 ? base.c : null),
    gen7ChainFor: (id, locker) => {
      asked.push([id, locker]);
      return gen6.c;
    },
  });
  assert.deepEqual(asked, [[56, GEN6_LOCKER_56], [4663, "0x615b1AbE348edA2e5a44eCe32fb50fbC45d2AF07"]], "gen-6 lockers on both mainnets, none on testnets");
  assert.deepEqual(base.sent.map((s) => s.args[0].toLowerCase()), [POOL_A]);
});

test("extraLockersFor: gen-6 mainnet lockers first, env lockers after, no duplicates, none on testnets", () => {
  assert.deepEqual(extraLockersFor(56, {}), [GEN6_LOCKER_56]);
  assert.deepEqual(extraLockersFor(4663, {}), ["0x615b1AbE348edA2e5a44eCe32fb50fbC45d2AF07"]);
  assert.deepEqual(extraLockersFor(97, {}), []);
  assert.deepEqual(extraLockersFor(56, { EVM_GEN7_LOCKER_56: `${GEN6_LOCKER_56.toLowerCase()},${GEN7_LOCKER}` }), [GEN6_LOCKER_56, GEN7_LOCKER]);
});

// Gen-8 API config (inert until both launcher and hook are set) and the migration guard.
import assert from "node:assert/strict";
import test from "node:test";
import { configuredGen8ChainIds, evmGen8ApiConfig, gen8ConfigFor, isGen8Launcher } from "./evmGen8Config.js";
import { clearGen8SchemaCache, gen8Tables, isSchemaMissingError } from "./evmGen8Schema.js";

const L = "0x1111111111111111111111111111111111111111";
const H = "0x2222222222222222222222222222222222222222";

test("inert unless launcher and hook are both set", () => {
  assert.equal(evmGen8ApiConfig(56, {}).reason, "unset");
  assert.equal(gen8ConfigFor(56, { EVM_GEN8_LAUNCHER_56: L }), null);
  assert.equal(evmGen8ApiConfig(56, { EVM_GEN8_LAUNCHER_56: L }).reason, "launcher and hook must both be set");
  assert.deepEqual(configuredGen8ChainIds({}), []);
  assert.equal(evmGen8ApiConfig(101, { EVM_GEN8_LAUNCHER_101: L, EVM_GEN8_HOOK_101: H }).config, null, "Solana never");
});

test("valid config, canonical PoolManager on mainnets, @block suffix, malformed env disables", () => {
  const cfg = gen8ConfigFor(56, { EVM_GEN8_LAUNCHER_56: `${L}@123`, EVM_GEN8_HOOK_56: H });
  assert.equal(cfg.launcher, L);
  assert.equal(cfg.poolManager.toLowerCase(), "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df");
  assert.equal(cfg.lens, null);
  assert.equal(gen8ConfigFor(97, { EVM_GEN8_LAUNCHER_97: L, EVM_GEN8_HOOK_97: H }), null, "testnet needs EVM_GEN8_POOL_MANAGER_97");
  assert.match(evmGen8ApiConfig(56, { EVM_GEN8_LAUNCHER_56: L, EVM_GEN8_HOOK_56: H, EVM_GEN8_LENS_56: "0x12" }).reason, /invalid gen-8 env: EVM_GEN8_LENS_56/);
  assert.equal(isGen8Launcher(56, L.toUpperCase().replace("0X", "0x"), { EVM_GEN8_LAUNCHER_56: L, EVM_GEN8_HOOK_56: H }), true);
  assert.deepEqual(configuredGen8ChainIds({ EVM_GEN8_LAUNCHER_4663: L, EVM_GEN8_HOOK_4663: H }), [4663]);
});

test("migration guard: missing tables, query errors and the cache", async () => {
  let calls = 0;
  const present = { query: async () => { calls += 1; return { rows: [{ pools: true, accruals: true, route_runs: false, side_pools: true }] }; } };
  const t1 = await gen8Tables(present, { now: 1000 });
  assert.deepEqual({ ...t1 }, { pools: true, accruals: true, routeRuns: false, sidePools: true });
  await gen8Tables(present, { now: 2000 });
  assert.equal(calls, 1, "cached");
  clearGen8SchemaCache(present);
  await gen8Tables(present, { now: 3000 });
  assert.equal(calls, 2);
  const broken = { query: async () => { throw Object.assign(new Error("down"), { code: "57P01" }); } };
  assert.deepEqual({ ...(await gen8Tables(broken)) }, { pools: false, accruals: false, routeRuns: false, sidePools: false });
  assert.equal(isSchemaMissingError({ code: "42P01" }), true);
  assert.equal(isSchemaMissingError({ code: "23505" }), false);
});

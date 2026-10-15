// Gen-8 venue seam (barkswap plan t17; spec section 4 Principle / API, B7): every gen-8 chain has a venue, DogeOS
// (6281971) is on `barkswap`, BNB and Robinhood stay on `v4` with exactly the config they had. The V4-only paths
// (the swap widget, finance) never take a Barkswap config.
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";

const { GEN8_CHAIN_VENUE, GEN8_TARGET_TEST_USD, GEN8_TARGET_DEFAULT_USD, GEN8_TEST_TARGET_CHAIN_IDS, gen8VenueFor, isGen8TargetAllowed } = await import("../../shared/evmGen8.mjs");
const { GEN8_API_CHAIN_IDS, configuredGen8ChainIds, evmGen8ApiConfig, gen8ConfigFor, isGen8Launcher } = await import("./evmGen8Config.js");
const { Gen8SwapError, gen8SwapSetup } = await import("../gen8Swap.js");
const { financeGen8 } = await import("../admin/finance.js");

const DOGE = 6281971;
const V4_CHAINS = [56, 97, 4663, 46630, 31337];
const L = "0x1111111111111111111111111111111111111111";
const H = "0x2222222222222222222222222222222222222222";
const P = "0x3333333333333333333333333333333333333333";
const PM = "0x4444444444444444444444444444444444444444";
const LENS = "0x5555555555555555555555555555555555555555";
const SPLITTER = "0x6666666666666666666666666666666666666666";
const BARK_ENV = { EVM_GEN8_LAUNCHER_6281971: `${L}@8600000`, EVM_GEN8_PLUGIN_6281971: `${P}@8600000`, EVM_GEN8_LENS_6281971: LENS, EVM_GEN8_SPLITTER_6281971: SPLITTER };

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

test("venue map: V4 on BNB, Robinhood and the local chain; Barkswap on DogeOS; nothing else", () => {
  for (const id of V4_CHAINS) assert.equal(gen8VenueFor(id), "v4", String(id));
  assert.equal(gen8VenueFor(DOGE), "barkswap");
  assert.equal(gen8VenueFor(String(DOGE)), "barkswap");
  for (const id of [1, 101, 102, 0, null, undefined, "constructor", "nope"]) assert.equal(gen8VenueFor(id), null, String(id));
  assert.ok(Object.isFrozen(GEN8_CHAIN_VENUE));
  assert.deepEqual([...GEN8_API_CHAIN_IDS].sort((a, b) => a - b), Object.keys(GEN8_CHAIN_VENUE).map(Number).sort((a, b) => a - b), "API chain list = venue map");
});

test("the $150 test target is allowed on DogeOS (spec section 2), mainnets unchanged", () => {
  assert.ok(GEN8_TEST_TARGET_CHAIN_IDS.includes(DOGE));
  assert.equal(isGen8TargetAllowed(DOGE, GEN8_TARGET_TEST_USD), true);
  assert.equal(isGen8TargetAllowed(DOGE, GEN8_TARGET_DEFAULT_USD), true);
  assert.equal(isGen8TargetAllowed(56, GEN8_TARGET_TEST_USD), false);
  assert.equal(isGen8TargetAllowed(4663, GEN8_TARGET_TEST_USD), false);
  assert.equal(isGen8TargetAllowed(97, GEN8_TARGET_TEST_USD), true);
  assert.equal(isGen8TargetAllowed(46630, GEN8_TARGET_TEST_USD), true);
});

test("API config: DogeOS is inert until launcher and plugin are both set", () => {
  assert.equal(evmGen8ApiConfig(DOGE, {}).reason, "unset");
  assert.equal(gen8ConfigFor(DOGE, {}), null);
  assert.equal(evmGen8ApiConfig(DOGE, { EVM_GEN8_LAUNCHER_6281971: L }).reason, "launcher and plugin must both be set");
  assert.equal(evmGen8ApiConfig(DOGE, { EVM_GEN8_PLUGIN_6281971: P }).reason, "launcher and plugin must both be set");
  assert.equal(gen8ConfigFor(DOGE, { EVM_GEN8_LAUNCHER_6281971: L, EVM_GEN8_HOOK_6281971: H }), null, "a hook is not a plugin");
  assert.deepEqual(configuredGen8ChainIds({}), []);
});

test("API config: DogeOS on barkswap with launcher, plugin and the gen-8 periphery; no hook, no PoolManager", () => {
  const cfg = gen8ConfigFor(DOGE, BARK_ENV);
  assert.deepEqual(cfg, {
    chainId: DOGE,
    venue: "barkswap",
    launcher: getAddress(L),
    plugin: getAddress(P),
    hook: null,
    poolManager: null,
    lens: getAddress(LENS),
    splitter: getAddress(SPLITTER),
    choiceVault: null,
    reserveLock: null,
    escrow: null,
  });
  assert.equal(isGen8Launcher(DOGE, L, BARK_ENV), true);
  assert.deepEqual(configuredGen8ChainIds(BARK_ENV), [DOGE]);
});

test("API config: Uniswap V4 settings on DogeOS and malformed DogeOS env disable it (fail closed)", () => {
  assert.match(evmGen8ApiConfig(DOGE, { ...BARK_ENV, EVM_GEN8_HOOK_6281971: H }).reason, /EVM_GEN8_HOOK_6281971.*barkswap/);
  assert.match(evmGen8ApiConfig(DOGE, { ...BARK_ENV, EVM_GEN8_POOL_MANAGER_6281971: PM }).reason, /EVM_GEN8_POOL_MANAGER_6281971.*barkswap/);
  assert.match(evmGen8ApiConfig(DOGE, { ...BARK_ENV, EVM_GEN8_PLUGIN_6281971: "0x12" }).reason, /invalid gen-8 env: EVM_GEN8_PLUGIN_6281971/);
  assert.match(evmGen8ApiConfig(DOGE, { ...BARK_ENV, EVM_GEN8_ESCROW_6281971: "nope" }).reason, /invalid gen-8 env: EVM_GEN8_ESCROW_6281971/);
  assert.equal(gen8ConfigFor(DOGE, { ...BARK_ENV, EVM_GEN8_HOOK_6281971: H }), null);
});

test("API config: V4 chains keep their config, now tagged venue v4; a plugin env there is ignored", () => {
  const cfg = gen8ConfigFor(56, { EVM_GEN8_LAUNCHER_56: `${L}@123`, EVM_GEN8_HOOK_56: H, EVM_GEN8_PLUGIN_56: P });
  assert.deepEqual(cfg, {
    chainId: 56,
    venue: "v4",
    launcher: getAddress(L),
    hook: getAddress(H),
    lens: null,
    poolManager: getAddress("0x28e2ea090877bf75740558f6bfb36a5ffee9e9df"),
    splitter: null,
    choiceVault: null,
    reserveLock: null,
    escrow: null,
  });
  assert.equal(gen8ConfigFor(97, { EVM_GEN8_LAUNCHER_97: L, EVM_GEN8_PLUGIN_97: P }), null, "V4 chains still need launcher + hook");
  assert.equal(gen8ConfigFor(46630, { EVM_GEN8_LAUNCHER_46630: L, EVM_GEN8_HOOK_46630: H, EVM_GEN8_POOL_MANAGER_46630: PM }).venue, "v4");
  assert.deepEqual(configuredGen8ChainIds({ ...BARK_ENV, EVM_GEN8_LAUNCHER_4663: L, EVM_GEN8_HOOK_4663: H }), [4663, DOGE]);
});

test("the gen-8 swap widget is V4-only: a Barkswap config is refused before any router lookup", () => {
  const env = { ...BARK_ENV, EVM_GEN8_UNIVERSAL_ROUTER_6281971: "0x00000000000000000000000000000000000000a1", EVM_GEN8_V4_QUOTER_6281971: "0x00000000000000000000000000000000000000b2" };
  assert.throws(() => gen8SwapSetup(DOGE, env), (e) => e instanceof Gen8SwapError && e.code === "GEN8_NOT_CONFIGURED" && e.status === 400);
});

test("finance stays out for DogeOS: chainId=all lists only V4 chains, chainId=6281971 is refused", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, BARK_ENV, { EVM_GEN8_LAUNCHER_4663: L, EVM_GEN8_HOOK_4663: H });
    const built = [];
    const build = async ({ chainId }) => { built.push(chainId); return { chainId, configured: true }; };
    const principal = { isOwner: true, permissions: [] };
    const all = fakeRes();
    await financeGen8({ method: "GET", query: { chainId: "all" }, dashboardPrincipal: principal }, all, { build, db: {} });
    assert.equal(all.statusCode, 200);
    assert.deepEqual(built, [4663]);
    const doge = fakeRes();
    await financeGen8({ method: "GET", query: { chainId: String(DOGE) }, dashboardPrincipal: principal }, doge, { build, db: {} });
    assert.equal(doge.statusCode, 400);
    assert.deepEqual(built, [4663], "nothing is built for DogeOS");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

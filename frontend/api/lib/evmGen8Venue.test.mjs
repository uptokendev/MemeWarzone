// Gen-8 venue seam (barkswap plan t17; spec section 4 Principle / API, B7): every gen-8 chain has a venue, DogeOS
// (6281971) is on `barkswap`, BNB and Robinhood stay on `v4` with exactly the config they had. The V4-only paths
// (the swap widget, finance) never take a Barkswap config.
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";

const { GEN8_CHAIN_VENUE, GEN8_TARGET_TEST_USD, GEN8_TARGET_DEFAULT_USD, GEN8_TEST_TARGET_CHAIN_IDS, gen8VenueFor, isGen8TargetAllowed } = await import("../../shared/evmGen8.mjs");
const { GEN8_API_CHAIN_IDS, configuredGen8ChainIds, evmGen8ApiConfig, gen8ConfigFor, gen8V4ConfigFor, isGen8Launcher, isGen8V4Config } = await import("./evmGen8Config.js");
const { Gen8SwapError, gen8SwapSetup } = await import("../gen8Swap.js");
const { financeGen8 } = await import("../admin/finance.js");
const { gen8CreateAuthorization, gen8RoutingStatus, isGen8CreateRequest } = await import("../dev-fix/evmGen8CreateAuthorization.js");
const { gen8IndexedCampaignState, readGen8CampaignState, readGen8Pool } = await import("./evmGen8CampaignState.js");
const { evmCampaignStateHandler, clearEvmCampaignStateCache } = await import("../evmCampaignState.js");
const { findGen8Coin } = await import("./evmGen8Coins.js");
const { buildGen8Finance } = await import("./financeGen8.js");
const { gen8ItemProgress } = await import("./evmCampaignProgress.js");

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

test("API config: a V4 setting alone on DogeOS gets the named refusal, not 'unset'", () => {
  assert.match(evmGen8ApiConfig(DOGE, { EVM_GEN8_HOOK_6281971: H }).reason, /EVM_GEN8_HOOK_6281971.*barkswap/);
  assert.match(evmGen8ApiConfig(DOGE, { EVM_GEN8_POOL_MANAGER_6281971: PM }).reason, /EVM_GEN8_POOL_MANAGER_6281971.*barkswap/);
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

// ------------------------------------------------------------------ V4-only readers (plan t17 review): until the
// Barkswap branches exist (t21), a Barkswap config never reaches code that reads a hook, PoolManager or MwzV4Launcher.

/** process.env with `vars` for the duration of `fn` (the readers below default to process.env). */
async function withProcessEnv(vars, fn) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, vars);
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** A provider / db / lens reader that fails the test when anything calls it. */
const untouchable = (what) => new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : () => { throw new Error(`${what}.${String(prop)} must not be called`); }) });

test("gen8V4ConfigFor: the V4 config on V4 chains, null on the Barkswap venue", () => {
  const env56 = { EVM_GEN8_LAUNCHER_56: L, EVM_GEN8_HOOK_56: H };
  assert.deepEqual(gen8V4ConfigFor(56, env56), gen8ConfigFor(56, env56));
  assert.equal(gen8V4ConfigFor(56, {}), null);
  assert.equal(gen8V4ConfigFor(DOGE, BARK_ENV), null);
  assert.ok(gen8ConfigFor(DOGE, BARK_ENV), "the shared (SQL) consumers still see DogeOS as gen-8");
  assert.equal(isGen8V4Config(gen8ConfigFor(56, env56)), true);
  assert.equal(isGen8V4Config({ launcher: L, hook: H }), true, "a config without venue is the pre-seam V4 shape");
  assert.equal(isGen8V4Config(gen8ConfigFor(DOGE, BARK_ENV)), false);
  assert.equal(isGen8V4Config(null), false);
});

test("create authorization: a DogeOS create is not a V4 gen-8 request and is never signed by the V4 path", async () => {
  assert.equal(isGen8CreateRequest({ chainId: DOGE, generation: 8 }, BARK_ENV), false);
  assert.equal(isGen8CreateRequest({ chainId: DOGE, launcherAddress: L }, BARK_ENV), false);
  assert.equal(isGen8CreateRequest({ chainId: 56, generation: 8 }, { EVM_GEN8_LAUNCHER_56: L, EVM_GEN8_HOOK_56: H }), true);
  const auth = await gen8CreateAuthorization({ chainId: DOGE, generation: 8 }, { env: BARK_ENV, signer: untouchable("signer"), getProvider: untouchable("getProvider") });
  assert.equal(auth.status, 400);
  assert.equal(auth.body.code, "GEN8_NOT_CONFIGURED");
  const status = await gen8RoutingStatus({ chainId: DOGE, signer: null, getProvider: () => { throw new Error("no RPC expected"); }, env: BARK_ENV });
  assert.deepEqual(status, { ok: false, status: "gen8_not_configured", chainId: DOGE });
});

test("campaign state: the V4 readers refuse a Barkswap config without touching the chain", async () => {
  const cfg = gen8ConfigFor(DOGE, BARK_ENV);
  const token = "0x7777777777777777777777777777777777777777";
  assert.equal(await readGen8Pool({ provider: untouchable("provider"), cfg, token }), null);
  assert.equal(await readGen8CampaignState({ provider: untouchable("provider"), cfg, token, pool: { poolId: "0x01" } }), null);
  assert.equal(gen8IndexedCampaignState({ cfg, indexed: { token, openAt: 1, lastPhase: "bonding" } }), null);
});

test("campaign-state endpoint: DogeOS with Barkswap env falls through to the campaign reader, no gen-8 V4 read", async () => {
  clearEvmCampaignStateCache();
  const campaign = "0x00000000000000000000000000000000000000c9";
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
  await withProcessEnv(BARK_ENV, () => evmCampaignStateHandler({ method: "GET", url: `/api/evm/campaign-state?chainId=${DOGE}&campaign=${campaign}` }, res, {
    getProvider: async () => ({}),
    readGen8Pool: () => { throw new Error("the V4 hook read must not run for DogeOS"); },
    readGen8State: () => { throw new Error("the V4 state read must not run for DogeOS"); },
    loadGen8Indexed: () => { throw new Error("the V4 indexed fallback must not run for DogeOS"); },
    readState: async () => ({ campaignAddress: campaign, supported: false }),
    db: null,
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.supported, false);
  clearEvmCampaignStateCache();
});

test("coins, finance and progress: DogeOS answers 'not configured' / null, never reads a null hook or lens", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  assert.equal(await findGen8Coin({ chainId: DOGE, address: token, db: untouchable("db"), getProvider: untouchable("getProvider"), env: BARK_ENV }), null);
  assert.deepEqual(await buildGen8Finance({ db: untouchable("db"), chainId: DOGE, env: BARK_ENV }), { chainId: DOGE, configured: false });
  const item = { chainId: DOGE, gen8: { poolId: "0x01", pool: null, phase: "bonding" } };
  assert.equal(await gen8ItemProgress(item, { readLens: () => { throw new Error("no V4 lens read for DogeOS"); }, env: BARK_ENV }), null);
});

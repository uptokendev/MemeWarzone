import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { ethers } from "ethers";

import { evmGen7DexName } from "./evmGen7.mjs";
import { DOGEOS_DEX_LABEL } from "./dogeosPresentation.mjs";

// DogeOS Chikyu testnet (6281971) launches on gen-8 only (Barkswap venue). Its gen-7 / Robinhood V3 family
// branches are removed (plan t12 and t33, spec section 4 "Removed (B8)"): the V3 trade library refuses 6281971,
// the token page's graduated-trade gates, the gen-7 buy switch, USD-target read, launch options and LP harvest are
// Robinhood-only again, and the launchpad safety adapter for 6281971 is the gen-8 Barkswap one (the Bark client,
// plan t22), which fails closed without the app's Barkswap config. Create readiness on 6281971 is gen-8's: the Bark
// launcher. What stays is chain identity: 6281971 never falls back to 46630, 56 or 97. Robinhood 46630 is asserted
// next to it so the existing behaviour stays pinned.

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");
const read = (rel) => readFileSync(path.join(srcRoot, rel), "utf8");

const DOGEOS = 6281971;
const RH_TESTNET = 46630;

// DogeOS's venue on Chikyu, from the t8 fork recording (test/fixtures/dogeos/barkSwapEvent.json): Barkswap's
// SwapRouter / QuoterV2 / factory and WDOGE, and our Bark launcher and plugin. The V3 refusal test serves them as a
// DogeOS V3 env and market row (the shape the removed gen-7 path read), so the refusal is checked on realistic input.
const BARK_FIXTURE = JSON.parse(readFileSync(path.resolve(frontendRoot, "..", "test/fixtures/dogeos/barkSwapEvent.json"), "utf8")).contracts;
const BARK = {
  FACTORY: ethers.getAddress(BARK_FIXTURE.AlgebraFactory.toLowerCase()),
  SMART_ROUTER: ethers.getAddress(BARK_FIXTURE.SwapRouter.toLowerCase()),
  QUOTER_V2: ethers.getAddress(BARK_FIXTURE.QuoterV2.toLowerCase()),
  WDOGE: ethers.getAddress(BARK_FIXTURE.WDOGE.toLowerCase()),
  LAUNCHER: ethers.getAddress(BARK_FIXTURE.MwzBarkLauncher.toLowerCase()),
  PLUGIN: ethers.getAddress(BARK_FIXTURE.MwzBarkPlugin.toLowerCase()),
};

const addr = (n) => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const DOGEOS_S1_ADAPTER = addr(0x5101);
const RH = {
  FACTORY: addr(0x4601),
  ROUTER: addr(0x4602),
  QUOTER: addr(0x4603),
  WETH: addr(0x4604),
  ADAPTER: addr(0x4605),
};
const TOKEN = addr(0x7001);
const POOL = addr(0x7002);
const CAMPAIGN = addr(0x7003);
const USER = addr(0x7004);

// Robinhood addresses on the unsuffixed names, as a shared TEST build carries them. DogeOS must never borrow them.
const BASE_ENV = {
  DEV: false,
  PROD: true,
  VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630,6281971",
  VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS: RH.ROUTER,
  VITE_ROBINHOOD_V3_FACTORY_ADDRESS: RH.FACTORY,
  VITE_ROBINHOOD_V3_QUOTER_ADDRESS: RH.QUOTER,
  VITE_WRAPPED_NATIVE_ADDRESS: RH.WETH,
  VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS: RH.ADAPTER,
  VITE_ROBINHOOD_STOCK_ETH_ROUTING: "1",
};
// Intentionally dead names: the removed gen-7 / V3 DogeOS path read these. No code reads them any more; they are set
// only so the refusal tests prove 6281971 gets no V3 route even when a stale env still names them.
const DOGEOS_ENV = {
  VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971: BARK.SMART_ROUTER,
  VITE_ROBINHOOD_V3_FACTORY_ADDRESS_6281971: BARK.FACTORY,
  VITE_ROBINHOOD_V3_QUOTER_ADDRESS_6281971: BARK.QUOTER_V2,
  VITE_WRAPPED_NATIVE_ADDRESS_6281971: BARK.WDOGE,
  VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_6281971: DOGEOS_S1_ADAPTER,
};
// The app's gen-8 Barkswap config (evmGen8Client.mjs gen8AppConfig): launcher + plugin.
const BARK_APP_ENV = {
  VITE_EVM_GEN8_LAUNCHER_6281971: `${BARK.LAUNCHER}@8578734`,
  VITE_EVM_GEN8_PLUGIN_6281971: `${BARK.PLUGIN}@8578734`,
};

// fetchMarketRoute is the network edge of resolveRobinhoodV3Route; the stub serves the test's market rows.
const marketStubPlugin = {
  name: "market-route-stub",
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/marketContinuityApi$/ }, () => ({ path: "market-route-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export function fetchMarketRoute(campaign, chainId) { return globalThis.__mwzMarketRoute(campaign, chainId); }",
      loader: "js",
    }));
  },
};

const harnessCache = new Map();
const harnessDirs = [];
after(async () => {
  await Promise.all(harnessDirs.map((tmp) => rm(tmp, { recursive: true, force: true })));
});
const LAUNCH_PATH_ENTRY = `
import * as graduationTiers from "./graduationTiers.ts";
import * as v3Trade from "./robinhoodV3Trade.ts";
import * as lpFeeHarvest from "./lpFeeHarvest.ts";
import * as launchpadAdapter from "../features/launchpad/useLaunchpadAdapter.ts";
import * as robinhoodAdapter from "../features/launchpad/robinhoodAdapter.ts";
import * as dogeosAdapter from "../features/launchpad/dogeosBarkswapAdapter.ts";
import * as tradeBalanceReserve from "./tradeBalanceReserve.ts";
export { graduationTiers, v3Trade, lpFeeHarvest, launchpadAdapter, robinhoodAdapter, dogeosAdapter, tradeBalanceReserve };
`;
async function loadHarness(name, env, contents = LAUNCH_PATH_ENTRY) {
  if (harnessCache.has(name)) return harnessCache.get(name);
  const compiled = await build({
    absWorkingDir: dir,
    stdin: {
      contents,
      resolveDir: dir,
      sourcefile: `${name}.ts`,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@": srcRoot },
    plugins: [marketStubPlugin],
    define: { "import.meta.env": JSON.stringify(env) },
  });
  // Inside the frontend package tree so Node resolves frontend/node_modules (gitignored dir, removed after()).
  const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-dogeos-launch-path-"));
  harnessDirs.push(tmpDir);
  const outfile = path.join(tmpDir, `${name}.mjs`);
  await writeFile(outfile, compiled.outputFiles[0].text);
  const loaded = await import(pathToFileURL(outfile).href);
  harnessCache.set(name, loaded);
  return loaded;
}

const fullHarness = () => loadHarness("dogeos-launch-path-full", { ...BASE_ENV, ...DOGEOS_ENV });
const robinhoodOnlyHarness = () => loadHarness("dogeos-launch-path-rh-only", BASE_ENV);
const barkHarness = () => loadHarness("dogeos-launch-path-bark", { ...BASE_ENV, ...DOGEOS_ENV, ...BARK_APP_ENV });

// ---------------------------------------------------------------- chain fakes (ethers Provider / Signer surface)

const iface = (abi) => new ethers.Interface(abi);
const ROUTER_IFACE = iface(["function factory() view returns (address)", "function WETH9() view returns (address)"]);
const ADAPTER_IFACE = iface([
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function buyExactNativeIn(address tokenOut,uint24 fee,uint256 amountOutMinimum,address recipient,uint256 deadline) payable returns (uint256 amountOut)",
  "function sellExactTokenIn(address tokenIn,uint24 fee,uint256 amountIn,uint256 amountOutMinimum,address recipient,uint256 deadline) returns (uint256 amountOut)",
]);
const QUOTER_V2_IFACE = iface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const V3_LOCKER_IFACE = iface([
  "function harvest(address pool) returns (uint256 collected0,uint256 collected1)",
  "function poolInfo(address pool) view returns (address campaign,address creator,address creatorFeeRecipient,address poolAddress,address token0,address token1,uint256 tokenId,uint128 lockedLiquidity,uint24 feeTier,uint16 creatorFeeBps,uint16 protocolFeeBps,bool registered)",
]);

/**
 * One V3 venue on one chain: a router (factory/WETH9), a native swap adapter (swapRouter/wrappedNative)
 * and a QuoterV2. Answers only the reads resolveRobinhoodV3Route and the quote make; records every call.
 */
function fakeVenue({ chainId, router, factory, wrapped, adapter, quoter }) {
  const calls = [];
  const deployed = new Set([TOKEN, POOL, router, factory, wrapped, adapter, quoter].map((a) => a.toLowerCase()));
  const provider = {
    async getNetwork() {
      return { chainId: BigInt(chainId) };
    },
    async getCode(address) {
      return deployed.has(String(address).toLowerCase()) ? "0x60016000" : "0x";
    },
    async call(tx) {
      const to = ethers.getAddress(tx.to);
      const selector = String(tx.data).slice(0, 10);
      calls.push({ to, data: tx.data });
      if (to === router) {
        const fn = ROUTER_IFACE.getFunction(selector);
        if (fn?.name === "factory") return ROUTER_IFACE.encodeFunctionResult("factory", [factory]);
        if (fn?.name === "WETH9") return ROUTER_IFACE.encodeFunctionResult("WETH9", [wrapped]);
      }
      if (to === adapter) {
        const fn = ADAPTER_IFACE.getFunction(selector);
        if (fn?.name === "swapRouter") return ADAPTER_IFACE.encodeFunctionResult("swapRouter", [router]);
        if (fn?.name === "wrappedNative") return ADAPTER_IFACE.encodeFunctionResult("wrappedNative", [wrapped]);
      }
      if (to === quoter && selector === QUOTER_V2_IFACE.getFunction("quoteExactInputSingle").selector) {
        const [params] = QUOTER_V2_IFACE.decodeFunctionData("quoteExactInputSingle", tx.data);
        return QUOTER_V2_IFACE.encodeFunctionResult("quoteExactInputSingle", [params.amountIn * 2n, 0n, 0, 0n]);
      }
      throw Object.assign(new Error(`unexpected call to ${to} ${selector}`), { code: "CALL_EXCEPTION", data: null });
    },
  };
  return { provider, calls };
}

function fakeSigner(provider) {
  const sent = [];
  const signer = {
    provider: { ...provider, async getBlock() { return { timestamp: 1_000 }; } },
    async getAddress() { return USER; },
    async call(tx) { return provider.call(tx); },
    async sendTransaction(tx) {
      sent.push(tx);
      return { hash: `0x${"ab".repeat(32)}`, async wait() { return { hash: `0x${"ab".repeat(32)}` }; } };
    },
  };
  return { signer, sent };
}

function marketRow(overrides) {
  return {
    marketStage: "DEX_ACTIVE",
    campaignAddress: CAMPAIGN,
    token: TOKEN,
    pair: POOL,
    stable: false,
    verified: true,
    tradingEnabled: true,
    verifiedAt: null,
    lastError: null,
    quoteAssetType: "WRAPPED_NATIVE",
    routeKind: "DIRECT_NATIVE",
    referenceOracle: null,
    ...overrides,
  };
}

function serveMarket(row) {
  globalThis.__mwzMarketRoute = async (campaign, chainId) => ({ ...row, chainId });
}

// A DogeOS market row naming Barkswap's router (fee_bps as the removed V3 pool indexer stored a 1% pool: 100).
const dogeosMarket = (overrides = {}) =>
  marketRow({ router: BARK.SMART_ROUTER, factory: BARK.FACTORY, wrappedNative: BARK.WDOGE, quoteToken: BARK.WDOGE, feeBps: 100, ...overrides });
const robinhoodMarket = (overrides = {}) =>
  marketRow({ router: RH.ROUTER, factory: RH.FACTORY, wrappedNative: RH.WETH, quoteToken: RH.WETH, feeBps: 30, ...overrides });
const dogeosVenue = () =>
  fakeVenue({ chainId: DOGEOS, router: BARK.SMART_ROUTER, factory: BARK.FACTORY, wrapped: BARK.WDOGE, adapter: DOGEOS_S1_ADAPTER, quoter: BARK.QUOTER_V2 });
const robinhoodVenue = () =>
  fakeVenue({ chainId: RH_TESTNET, router: RH.ROUTER, factory: RH.FACTORY, wrapped: RH.WETH, adapter: RH.ADAPTER, quoter: RH.QUOTER });

// ---------------------------------------------------------------- adapter selection

/** Records every fetch the adapters make; answers an allowed preflight. */
async function withFetchRecorder(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ preflight: { allowed: true, reasons: [], warnings: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("6281971 resolves to the gen-8 Barkswap adapter, never to 46630, 56 or 97", async () => {
  const { launchpadAdapter, robinhoodAdapter, dogeosAdapter } = await fullHarness();
  // The venue comes from the gen-8 config (GEN8_CHAIN_VENUE, t17): Barkswap on 6281971 only.
  assert.equal(dogeosAdapter.isDogeosBarkswapChainId(DOGEOS), true);
  assert.equal(dogeosAdapter.isDogeosBarkswapChainId(String(DOGEOS)), true);
  for (const id of [56, 97, 101, 4663, 46630, 31337, 0, null, undefined, "x"]) {
    assert.equal(dogeosAdapter.isDogeosBarkswapChainId(id), false, String(id));
  }
  // Whatever chain family a caller names, the chain id wins: never the Robinhood or BNB adapter for 6281971.
  for (const chain of [undefined, null, "", "robinhood", "rh", "bnb", "bsc", "dogeos"]) {
    for (const chainId of [DOGEOS, String(DOGEOS)]) {
      assert.equal(launchpadAdapter.getLaunchpadAdapter({ chain, chainId }).chain, "dogeos", `${chain} ${chainId}`);
    }
  }
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chain: "dogeos" }).chain, "dogeos");
  // The Robinhood adapter's chain resolver refuses 6281971 instead of returning its 46630 default (or 56/97).
  assert.throws(() => robinhoodAdapter.resolveRobinhoodChainId(DOGEOS), /DogeOS/);
  assert.throws(() => robinhoodAdapter.resolveRobinhoodChainId(String(DOGEOS)), /DogeOS/);

  // Without the app's Barkswap config the Bark client fails closed: no API call, a clear "not available yet".
  await withFetchRecorder(async (calls) => {
    const adapter = launchpadAdapter.getLaunchpadAdapter({ chainId: DOGEOS });
    const status = await adapter.getStatus();
    assert.equal(status.chain, "dogeos");
    assert.equal(status.protocolLive, false);
    assert.equal(status.routeAuthorizationReady, false);
    assert.equal(status.message, dogeosAdapter.DOGEOS_TRADE_UNAVAILABLE);
    assert.match(dogeosAdapter.DOGEOS_TRADE_UNAVAILABLE, /DogeOS/);
    assert.match(dogeosAdapter.DOGEOS_TRADE_UNAVAILABLE, /Barkswap/);
    assert.match(dogeosAdapter.DOGEOS_TRADE_UNAVAILABLE, /not available yet/);
    for (const side of ["buy", "sell"]) {
      for (const walletAddress of [USER, null]) {
        const preflight = await adapter.preflightTrade({ side, walletAddress, campaignAddress: CAMPAIGN, chainId: DOGEOS });
        assert.equal(preflight.allowed, false, `${side} ${walletAddress}`);
        assert.equal(preflight.chain, "dogeos");
        assert.equal(preflight.side, side);
        assert.deepEqual(preflight.reasons, [dogeosAdapter.DOGEOS_TRADE_UNAVAILABLE]);
      }
      // The Robinhood adapter, handed 6281971, refuses the same way and never posts a 46630 preflight.
      const viaRobinhood = await robinhoodAdapter
        .createRobinhoodLaunchpadAdapter()
        .preflightTrade({ side, walletAddress: USER, campaignAddress: CAMPAIGN, chainId: DOGEOS });
      assert.equal(viaRobinhood.allowed, false);
      assert.equal(viaRobinhood.chain, "dogeos");
      assert.deepEqual(viaRobinhood.reasons, [dogeosAdapter.DOGEOS_TRADE_UNAVAILABLE]);
    }
    assert.deepEqual(calls, [], "no API call is made for 6281971");
  });

  // Robinhood still posts its own chain id (and its 46630 default for an unknown one).
  await withFetchRecorder(async (calls) => {
    const rh = robinhoodAdapter.createRobinhoodLaunchpadAdapter();
    for (const [chainId, posted] of [[46630, 46630], [4663, 4663], [undefined, 46630]]) {
      const preflight = await rh.preflightTrade({ side: "buy", walletAddress: USER, campaignAddress: CAMPAIGN, chainId });
      assert.equal(preflight.allowed, true, String(chainId));
      assert.equal(preflight.chain, "robinhood");
      assert.match(calls.at(-1).url, /\/api\/launchpad\/preflight-buy$/);
      assert.equal(calls.at(-1).body.chainId, posted, String(chainId));
    }
  });

  // With the Barkswap config (t22): live, no trade authorization to wait for, and the API's chain-free safety
  // preflight is posted with 6281971 (never 46630), from the DogeOS adapter or via the Robinhood one.
  const bark = await barkHarness();
  assert.equal(bark.dogeosAdapter.isDogeosBarkswapReady(), true);
  await withFetchRecorder(async (calls) => {
    const adapter = bark.launchpadAdapter.getLaunchpadAdapter({ chainId: DOGEOS });
    const status = await adapter.getStatus();
    assert.equal(status.chain, "dogeos");
    assert.equal(status.protocolLive, true);
    assert.equal(status.routeAuthorizationReady, true);
    assert.equal(status.message, bark.dogeosAdapter.DOGEOS_TRADE_READY);
    assert.match(status.message, /Barkswap/);
    for (const side of ["buy", "sell"]) {
      const preflight = await adapter.preflightTrade({ side, walletAddress: USER, campaignAddress: CAMPAIGN, chainId: DOGEOS });
      assert.equal(preflight.allowed, true, side);
      assert.equal(preflight.chain, "dogeos");
      assert.match(calls.at(-1).url, side === "buy" ? /\/api\/launchpad\/preflight-buy$/ : /\/api\/launchpad\/preflight-sell$/);
      assert.equal(calls.at(-1).body.chainId, DOGEOS);
      assert.equal(calls.at(-1).body.campaignAddress, CAMPAIGN.toLowerCase());
      const viaRobinhood = await bark.robinhoodAdapter
        .createRobinhoodLaunchpadAdapter()
        .preflightTrade({ side, walletAddress: USER, campaignAddress: CAMPAIGN, chainId: DOGEOS });
      assert.equal(viaRobinhood.chain, "dogeos");
      assert.equal(calls.at(-1).body.chainId, DOGEOS);
    }
    // no wallet: campaign checks only, no wallet preflight posted; a bad campaign is refused without a call
    const before = calls.length;
    const anon = await adapter.preflightTrade({ side: "buy", walletAddress: null, campaignAddress: CAMPAIGN, chainId: DOGEOS });
    assert.equal(anon.allowed, true);
    assert.match(anon.warnings[0], /DogeOS wallet/);
    const bad = await adapter.preflightTrade({ side: "buy", walletAddress: USER, campaignAddress: "0x12", chainId: DOGEOS });
    assert.equal(bad.allowed, false);
    assert.equal(calls.length, before);
    assert.ok(calls.every((c) => c.body?.chainId === DOGEOS), "every DogeOS preflight names 6281971");
  });
  // the safety API down or answering garbage: blocked with a reason, never an empty refusal
  const original = globalThis.fetch;
  try {
    for (const fail of [async () => { throw new TypeError("Failed to fetch"); }, async () => new Response("<html>", { status: 502 })]) {
      globalThis.fetch = fail;
      const preflight = await bark.launchpadAdapter.getLaunchpadAdapter({ chainId: DOGEOS }).preflightTrade({ side: "buy", walletAddress: USER, campaignAddress: CAMPAIGN, chainId: DOGEOS });
      assert.equal(preflight.allowed, false);
      assert.equal(preflight.reasons.length, 1);
      assert.match(preflight.reasons[0], /safety check did not answer/);
    }
  } finally {
    globalThis.fetch = original;
  }

  // unchanged for the existing chains
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chainId: 46630 }).chain, "robinhood");
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chainId: 4663 }).chain, "robinhood");
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chainId: 97 }).chain, "bnb");
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chainId: 101 }).chain, "solana");
  assert.equal(robinhoodAdapter.resolveRobinhoodChainId(4663), 4663);
  assert.equal(robinhoodAdapter.resolveRobinhoodChainId(46630), 46630);
  assert.equal(robinhoodAdapter.resolveRobinhoodChainId(97), 46630);
});

// ---------------------------------------------------------------- graduation target and tiers

test("the gen-7 USD graduation-target read and bonding buy switch are Robinhood-only again; the read chain keeps 6281971", () => {
  const client = read("lib/launchpadClient.ts");
  // B8 (t33): DogeOS has no gen-7 campaign, so these are the starting commit's Robinhood-only lines again.
  assert.match(client, /const isRobinhoodRead = evmReadChainId === ROBINHOOD_CHAIN_ID \|\| evmReadChainId === ROBINHOOD_TESTNET_CHAIN_ID;/);
  assert.match(client, /readBig\("graduationNativeTarget", isRobinhoodRead \? 0n : graduationTarget\)/);
  assert.match(client, /const isRobinhoodBuy = targetChainId === ROBINHOOD_CHAIN_ID \|\| targetChainId === ROBINHOOD_TESTNET_CHAIN_ID;/);
  assert.match(client, /throw new Error\(`Switch your EVM wallet to Robinhood chain \$\{targetChainId\} and try again\.`\);/);
  assert.match(client, /throw new Error\(`Wallet did not switch to Robinhood chain \$\{targetChainId\}\.`\);/);
  // The one DogeOS read-chain branch left (t22) keeps the gen-7 factory away from 6281971; no other may come back.
  const GEN7_FACTORY_GUARD = 'const factoryAddress = isDogeosChainId(evmReadChainId) ? "" : bnbAddresses.launchFactory;';
  assert.equal(client.split(GEN7_FACTORY_GUARD).length, 2);
  assert.doesNotMatch(client.replace(GEN7_FACTORY_GUARD, ""), /buyChainName|isDogeosChainId\((evmReadChainId|targetChainId)\)/);
  // Chain identity stays: a wallet on 6281971 reads its own chain, never BNB.
  assert.match(
    client,
    /if \(productChain === ROBINHOOD_CHAIN_ID \|\| productChain === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosChainId\(productChain\)\) \{\s*return productChain;/,
  );
});

test("the $150 test tier stays reachable on 6281971 and the DogeOS DEX label is Barkswap", async () => {
  const { graduationTiers } = await fullHarness();
  const staging = { environment: "staging", cluster: "devnet" };
  assert.equal(graduationTiers.isTestGraduationChain(DOGEOS, staging), true);
  assert.equal(graduationTiers.isTestGraduationChain(97, staging), true);
  assert.equal(graduationTiers.isTestGraduationChain(46630, staging), true);
  assert.equal(graduationTiers.isTestGraduationChain(56, staging), false);
  assert.equal(graduationTiers.isTestGraduationChain(4663, staging), false);

  assert.equal(DOGEOS_DEX_LABEL, "Barkswap");
  assert.equal(evmGen7DexName(46630), "Uniswap");
  assert.equal(evmGen7DexName(97), "Topaz");
});

test("create surfaces: gen-7 launch options are Robinhood-only again; the create page keeps 6281971's own chain", () => {
  const create = read("pages/Create.tsx");
  const options = read("components/create/EvmGen6LaunchOptions.tsx");
  const chainConfig = read("lib/chainConfig.ts");
  assert.match(create, /const robinhoodSelected = isRobinhoodChain\(Number\(configuredEvmChainId\)\) \|\| isDogeosChainId\(Number\(configuredEvmChainId\)\);/);
  // B8 (t33): no gen-7 factory on DogeOS, so the gen-7 launch reserve is the starting commit's Robinhood/BNB choice.
  assert.match(options, /const isRobinhood = isRobinhoodChainId\(input\.chainId\);/);
  assert.match(options, /const isRobinhood = isRobinhoodChainId\(chainId\);/);
  assert.doesNotMatch(options, /isDogeos/);
  // isRobinhoodChainId itself never learns 6281971 (it also drives ETH symbols and stock logic).
  assert.match(chainConfig, /export function isRobinhoodChainId\(chainId\?: number \| null\): boolean \{\s*return chainId === ROBINHOOD_CHAIN_ID \|\| chainId === ROBINHOOD_TESTNET_CHAIN_ID;\s*\}/);
});

test("token page entry, war-room row and trade panel keep 6281971 instead of defaulting to 56 or 46630", () => {
  const entry = read("pages/TokenDetailsLiveEntry.tsx");
  const row = read("components/postgrad/WarRoomCampaignRow.tsx");
  const panel = read("components/postgrad/RobinhoodWarRoomTradePanel.tsx");
  // Chain identity only (t33 renamed the gen-7 "V3 family" helper): an EVM product chain of its own, never BNB.
  assert.doesNotMatch(entry, /isV3FamilyChainId/);
  assert.match(entry, /function isOwnEvmProductChainId\(chainId: number\): boolean \{\s*return isRobinhoodChainId\(chainId\) \|\| isDogeosChainId\(chainId\);/);
  assert.match(entry, /const selectedEvmChainId = isOwnEvmProductChainId\(Number\(selectedFeedChainId\)\) \|\| isBnbChainId/);
  assert.match(entry, /const effectiveEvmChainId = isOwnEvmProductChainId\(forcedChainId\) \|\| isBnbChainId\(forcedChainId\)/);
  assert.match(entry, /const robinhoodRoute = isOwnEvmProductChainId\(effectiveEvmChainId\);/);
  assert.match(entry, /: isOwnEvmProductChainId\(forcedChainId\) \|\| isBnbChainId\(forcedChainId\)\s*\? forcedChainId/);
  assert.match(row, /inferredChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\| inferredChainId === DOGEOS_TESTNET_CHAIN_ID\s*\? inferredChainId/);
  // B8 (t33): a DogeOS row is no Robinhood row; t22: it gets the gen-8 Bark trade card (dogeosWarRoomRow.test.mjs renders it).
  assert.match(row, /const isDogeosRow = isDogeosChainId\(rowChainId\);\s*const isRobinhoodRow = rowChainId === ROBINHOOD_CHAIN_ID \|\| rowChainId === ROBINHOOD_TESTNET_CHAIN_ID;/);
  assert.match(row, /\{isDogeosRow \? \([^<]*<DogeosWarRoomTradeCard campaign=\{campaign\} \/>/);
  assert.match(row, /<Gen8TradePanel chainId=\{DOGEOS_TESTNET_CHAIN_ID\}/);
  assert.doesNotMatch(row, /This coin trades in DOGE on DogeOS/);
  assert.match(row, /rowChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\|\s*rowChainId === DOGEOS_TESTNET_CHAIN_ID \|\|\s*rowChainId === 101\s*\) \{\s*setSelectedFeedChainId\(rowChainId\);/);
  // Token page: the gen-7/MuchFi V3 gate (isV3GraduatedTradePage) is removed (B8). Every graduated-trade site is
  // Robinhood-only again, exactly as on release/evm-gen8; DogeOS keeps its presentation flag and the DOGE reserve.
  const page = read("pages/TokenDetails.tsx");
  assert.doesNotMatch(page, /isV3GraduatedTradePage/);
  assert.match(page, /const isDogeosPage = isDogeosChainId\(chainIdForStorage\);/);
  assert.match(page, /const isTopazTradingActive = isSolanaPage \|\| isRobinhoodPage\s*\? false/);
  assert.match(page, /const isUniswapTradingActive =\s*isRobinhoodPage &&/);
  assert.match(page, /const rhGraduatedTrade = isRobinhoodPage && \(contractGraduated \|\| isUniswapTradingActive\);/);
  assert.match(page, /const bnbGraduatedImportTrade = !isSolanaPage && !isRobinhoodPage && isDexStage/);
  assert.match(page, /\) : isRobinhoodPage && \(contractGraduated \|\| isUniswapTradingActive\) \? \(/);
  assert.match(page, /enabled: hasValidCampaignAddress && contractGraduatedEarly && !isSolanaPage && !isRobinhoodPage,/);
  assert.match(page, /if \(isRobinhoodPage && contractGraduatedEarly\) \{\s*const indexed = Number\(unifiedMarket\.summary\?\.last_price_bnb\);/);
  // gen8State is gen-8's own dependency (release/evm-gen8, merged in 126ffbc8b); the order is gen-8's.
  assert.match(page, /contractGraduatedEarly,\s*gen8State,\s*isRobinhoodPage,\s*isSolanaPage,\s*metrics\?\.currentPrice,/);
  assert.match(page, /if \(isRobinhoodPage && unifiedNative\) \{/);
  assert.match(page, /if \(isRobinhoodPage && isDexStage\) return "—";/);
  assert.equal((page.match(/evmBuyGasReserveWeiForChain\(chainIdForStorage\)/g) || []).length, 3);
  assert.doesNotMatch(page, /evmBuyGasReserveWei\(/);
  // the Robinhood USD-raise line is untouched (evmGen7Wiring pin)
  assert.match(page, /isRobinhoodPage && !isDexStage && !evmGen7Coin && \(metrics\?\.graduationTarget \?\? 0n\) > 0n/);
  // The Robinhood panel keeps 6281971's own id (never the 46630 default) only to refuse it; its texts are Robinhood's.
  assert.match(panel, /return id === ROBINHOOD_CHAIN_ID \|\| id === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosChainId\(id\) \? id : ROBINHOOD_TESTNET_CHAIN_ID;/);
  assert.match(panel, /if \(isDogeosChainId\(chainId\)\) \{\s*return \(\s*<p[^>]*data-war-room-trade-unavailable="dogeos"/);
  assert.match(panel, /const networkName = "Robinhood";/);
  assert.match(panel, /const venueLabel = "Robinhood V3";/);
  assert.doesNotMatch(panel, /DOGEOS_DEX_LABEL|MuchFi/);
  assert.match(panel, /const buyGasReserveWei = evmBuyGasReserveWeiForChain\(chainId\);/);
  assert.match(panel, /amountIn \+ buyGasReserveWei > nativeBalance/);
  assert.match(panel, /Keep about \$\{ethers\.formatEther\(buyGasReserveWei\)\} \$\{nativeSymbol\}/);
  assert.doesNotMatch(panel, /ETH_BUY_GAS_RESERVE_WEI/);
  // the direct panel names the chain's own coin, never a hard-coded ETH, on screen
  assert.doesNotMatch(panel, /formatAmount\([^)]*"ETH"\)/);
  assert.doesNotMatch(panel, />ETH</);
});

test("buy gas reserve: 0.01 DOGE on 6281971 (L2 gas + L1 data fee); Robinhood and BNB unchanged", async () => {
  const { tradeBalanceReserve: r } = await fullHarness();
  assert.equal(r.DOGE_BUY_GAS_RESERVE_WEI, 10n ** 16n);
  assert.equal(r.evmBuyGasReserveWeiForChain(DOGEOS), 10n ** 16n);
  assert.equal(r.evmBuyGasReserveWeiForChain(46630), 200_000_000_000_000n);
  assert.equal(r.evmBuyGasReserveWeiForChain(4663), 200_000_000_000_000n);
  assert.equal(r.evmBuyGasReserveWeiForChain(97), 500_000_000_000_000n);
  assert.equal(r.evmBuyGasReserveWeiForChain(56), 500_000_000_000_000n);
  // identical to the boolean selector every existing caller used (isRobinhoodPage) on every other chain
  for (const id of [4663, 46630, 56, 97, 101]) {
    assert.equal(r.evmBuyGasReserveWeiForChain(id), r.evmBuyGasReserveWei(id === 4663 || id === 46630), String(id));
  }
  assert.equal(r.evmBuyGasReserveWei(true), r.ETH_BUY_GAS_RESERVE_WEI);
  assert.equal(r.evmBuyGasReserveWei(false), r.BNB_BUY_GAS_RESERVE_WEI);
});

// ---------------------------------------------------------------- post-graduation trade (gen-7/MuchFi removed, B8)

test("the Robinhood V3 trade library refuses 6281971: no MuchFi fee-10000 route, whatever the env or market row", async () => {
  // Even with a DogeOS V3 env and a served MuchFi market row (fee_bps 100 or 10000), DogeOS gets no route and no chain
  // call is made: the gen-7 DogeOS trade path is gone, so it can neither trade at fee 10000 nor borrow Robinhood's env.
  for (const harness of [fullHarness, robinhoodOnlyHarness]) {
    const { v3Trade } = await harness();
    for (const feeBps of [null, 100, 10000]) {
      const venue = dogeosVenue();
      serveMarket(dogeosMarket({ feeBps }));
      await assert.rejects(
        v3Trade.resolveRobinhoodV3Route({ provider: venue.provider, campaignAddress: CAMPAIGN, chainId: DOGEOS, expectedTokenAddress: TOKEN }),
        /Robinhood V3 route requested for a non-Robinhood chain\./,
        `feeBps ${feeBps}`,
      );
      assert.deepEqual(venue.calls, [], "no MuchFi or Robinhood contract is read for 6281971");
    }
  }
});

test("Robinhood 46630 trade is unchanged: fee 3000 from fee_bps 30 or none, unsuffixed env still read", async () => {
  const { v3Trade } = await robinhoodOnlyHarness();
  for (const feeBps of [30, null]) {
    const venue = robinhoodVenue();
    serveMarket(robinhoodMarket({ feeBps, router: null, factory: null, wrappedNative: null }));
    const route = await v3Trade.resolveRobinhoodV3Route({ provider: venue.provider, campaignAddress: CAMPAIGN, chainId: RH_TESTNET });
    assert.equal(route.fee, 3000, `feeBps ${feeBps}`);
    assert.equal(route.routerAddress, RH.ROUTER);
    const quote = await v3Trade.quoteRobinhoodV3Buy(venue.provider, route, 7n, 100);
    const call = venue.calls.find((c) => c.to === RH.QUOTER);
    assert.equal(Number(QUOTER_V2_IFACE.decodeFunctionData("quoteExactInputSingle", call.data)[0].fee), 3000);
    const { signer, sent } = fakeSigner(venue.provider);
    await v3Trade.executeRobinhoodV3Buy({ signer, quote });
    assert.equal(Number(ADAPTER_IFACE.decodeFunctionData("buyExactNativeIn", sent[0].data).fee), 3000);
  }
  // the 1% tier on Robinhood keeps today's reading of fee_bps 100
  serveMarket(robinhoodMarket({ feeBps: 100 }));
  const route = await v3Trade.resolveRobinhoodV3Route({ provider: robinhoodVenue().provider, campaignAddress: CAMPAIGN, chainId: RH_TESTNET });
  assert.equal(route.fee, 100);
  // a non-V3 chain is still refused
  await assert.rejects(
    v3Trade.resolveRobinhoodV3Route({ provider: robinhoodVenue().provider, campaignAddress: CAMPAIGN, chainId: 97 }),
    /non-Robinhood chain/,
  );
});

// ---------------------------------------------------------------- LP fee harvest (no LP locker on DogeOS, B8)

test("LP fee harvest refuses 6281971 before any read or send; Robinhood keeps its V3 position-locker path", async () => {
  const { lpFeeHarvest } = await fullHarness();
  const LOCKER = addr(0x9001);
  const unregistered = V3_LOCKER_IFACE.encodeFunctionResult("poolInfo", [
    ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, POOL, ethers.ZeroAddress, ethers.ZeroAddress, 0n, 0n, 10000, 0, 0, false,
  ]);
  const fakeSignerFor = (chainId, calls) => ({
    provider: { async getNetwork() { calls.push("getNetwork"); return { chainId: BigInt(chainId) }; } },
    async call(tx) { calls.push(tx); return unregistered; },
    async sendTransaction() { throw new Error("harvest must not be sent"); },
  });
  // DogeOS: no gen-7 locker (the MuchFi V3 position locker is gone), so no locker of any shape is read or called,
  // whatever locker address or pool the caller passes; the API's lp-fees answers null for 6281971 the same way.
  for (const [pairAddress, lockerAddress] of [[POOL, LOCKER], [POOL, null], ["0x1234", LOCKER]]) {
    const calls = [];
    await assert.rejects(
      lpFeeHarvest.harvestLpFeesWithWallet({ chainId: DOGEOS, pairAddress, signer: fakeSignerFor(DOGEOS, calls), lockerAddress }),
      /no LP locker on DogeOS/,
    );
    assert.deepEqual(calls, [], `${pairAddress} ${lockerAddress}`);
  }
  // Robinhood is unchanged: one poolInfo read, then the registration refusal.
  const calls = [];
  await assert.rejects(
    lpFeeHarvest.harvestLpFeesWithWallet({ chainId: RH_TESTNET, pairAddress: POOL, signer: fakeSignerFor(RH_TESTNET, calls), lockerAddress: LOCKER }),
    /Robinhood V3 position is not registered with locked liquidity\./,
  );
  const reads = calls.filter((c) => c !== "getNetwork");
  assert.equal(reads.length, 1);
  assert.equal(String(reads[0].data).slice(0, 10), V3_LOCKER_IFACE.getFunction("poolInfo").selector);
  await assert.rejects(
    lpFeeHarvest.harvestLpFeesWithWallet({ chainId: RH_TESTNET, pairAddress: "0x1234", signer: {}, lockerAddress: LOCKER }),
    /Invalid Robinhood V3 pool address\./,
  );
  const lib = read("lib/lpFeeHarvest.ts");
  assert.doesNotMatch(lib, /MuchFi|isV3PositionLockerChainId/);
});

// ---------------------------------------------------------------- create readiness (t37, gen-8 since t22)

// DogeOS launches on gen-8 only, on Barkswap (B8: no gen-7 factory, campaign, router, vaults or LP locker). Its create
// readiness is the app's gen-8 Barkswap config: launchFactory = the Bark launcher (VITE_EVM_GEN8_LAUNCHER_6281971 with
// VITE_EVM_GEN8_PLUGIN_6281971), the only contract required there; gen-7 env names for 6281971 are not read. Every
// other chain's required set stays exactly as before.
const READINESS_ENTRY = `export * from "./bnbContracts.ts";`;
const READINESS_ENV_NAMES = [
  "VITE_FACTORY_ADDRESS",
  "VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS",
  "VITE_TREASURY_ROUTER_ADDRESS",
  "VITE_TREASURY_VAULT_ADDRESS",
  "VITE_RECRUITER_REWARDS_VAULT_ADDRESS",
  "VITE_COMMUNITY_REWARDS_VAULT_ADDRESS",
  "VITE_PROTOCOL_REVENUE_VAULT_ADDRESS",
  "VITE_RISK_REGISTRY_ADDRESS",
  "VITE_GRADUATION_ORACLE_ADDRESS",
  "VITE_PERMANENT_LP_LOCKER_ADDRESS",
  "VITE_TOPAZ_ROUTER_ADDRESS",
  "VITE_TOPAZ_FACTORY_ADDRESS",
  "VITE_TOPAZ_WBNB_ADDRESS",
];
const READINESS_CHAINS = [56, 97, 4663, 46630, DOGEOS];
// Every contract except the creator registry and vote treasury, suffixed per chain (the names the t24 DogeOS block emits).
function readinessEnv() {
  const env = { DEV: false, PROD: true };
  for (const chainId of READINESS_CHAINS) {
    READINESS_ENV_NAMES.forEach((name, i) => {
      env[`${name}_${chainId}`] = addr(0x9000 + chainId * 0x100 + i);
    });
  }
  return env;
}
const readinessHarness = () => loadHarness("dogeos-readiness", { ...readinessEnv(), ...BARK_APP_ENV }, READINESS_ENTRY);
const readinessHarnessWithoutBarkPlugin = () =>
  loadHarness("dogeos-readiness-no-plugin", { ...readinessEnv(), VITE_EVM_GEN8_LAUNCHER_6281971: BARK.LAUNCHER }, READINESS_ENTRY);
const readinessHarnessGen7Only = () => loadHarness("dogeos-readiness-gen7-only", readinessEnv(), READINESS_ENTRY);

// The required set every EVM chain had before t37, in item order.
const COMMON_REQUIRED = [
  "launchFactory",
  "launchCampaignImplementation",
  "treasuryRouter",
  "treasuryVault",
  "recruiterRewardsVault",
  "communityRewardsVault",
  "protocolRevenueVault",
  "creatorRegistry",
  "riskRegistry",
  "graduationOracle",
  "permanentLpLocker",
  "voteTreasury",
];
const TOPAZ_REQUIRED = ["topazRouter", "topazFactory", "topazWbnb"];
const requiredKeys = (readiness) => readiness.items.filter((item) => item.required).map((item) => item.key);
// The contract half of Create.tsx's direct-deploy gate (evmContractsConfigured), pinned against its source below.
const directDeployContractsConfigured = (m, chainId) =>
  m.getBnbContractReadiness(chainId).ready && Boolean(m.getBnbContractAddresses(chainId).launchFactory);

test("create readiness on 6281971 is gen-8: the Bark launcher, nothing of gen-7", async () => {
  const m = await readinessHarness();
  const readiness = m.getBnbContractReadiness(DOGEOS);
  assert.deepEqual(readiness.missingRequired, []);
  assert.equal(readiness.ready, true);
  assert.deepEqual(requiredKeys(readiness), ["launchFactory"]);
  const byKey = Object.fromEntries(readiness.items.map((item) => [item.key, item]));
  assert.equal(byKey.launchFactory.address, BARK.LAUNCHER);
  assert.match(byKey.launchFactory.label, /MwzBarkLauncher/);
  // the gen-7 env names set for 6281971 are not read: no gen-7 factory, campaign, router, vault or locker on DogeOS
  const addresses = m.getBnbContractAddresses(DOGEOS);
  assert.equal(addresses.launchFactory, BARK.LAUNCHER);
  for (const [key, value] of Object.entries(addresses)) if (key !== "launchFactory") assert.equal(value, "", key);
  assert.equal(m.summarizeMissingBnbContracts(readiness), `All required EVM launchpad contracts are configured for chain ${DOGEOS}.`);
  assert.equal(directDeployContractsConfigured(m, DOGEOS), true);
});

test("create readiness on 6281971 needs the complete Bark config; a gen-7 factory alone is not ready", async () => {
  for (const harness of [readinessHarnessWithoutBarkPlugin, readinessHarnessGen7Only]) {
    const m = await harness();
    const readiness = m.getBnbContractReadiness(DOGEOS);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missingRequired.map((item) => item.key), ["launchFactory"]);
    assert.equal(m.getBnbContractAddresses(DOGEOS).launchFactory, "", "never the gen-7 VITE_FACTORY_ADDRESS_6281971");
    assert.equal(directDeployContractsConfigured(m, DOGEOS), false);
  }
});

test("create readiness on 56/97/4663/46630 still requires the creator registry and vote treasury", async () => {
  const m = await readinessHarness();
  for (const chainId of [56, 97, 4663, 46630]) {
    const readiness = m.getBnbContractReadiness(chainId);
    const bnb = chainId === 56 || chainId === 97;
    assert.deepEqual(requiredKeys(readiness), bnb ? [...COMMON_REQUIRED, ...TOPAZ_REQUIRED] : COMMON_REQUIRED, String(chainId));
    assert.equal(readiness.ready, false, String(chainId));
    assert.deepEqual(readiness.missingRequired.map((item) => item.key), ["creatorRegistry", "voteTreasury"], String(chainId));
    assert.equal(directDeployContractsConfigured(m, chainId), false, String(chainId));
  }
});

test("Create's direct-deploy gate follows the bnbContracts readiness of the configured EVM chain", () => {
  const create = read("pages/Create.tsx");
  assert.match(create, /const evmContractReadiness = useMemo\(\s*\(\) => getBnbContractReadiness\(configuredEvmChainId\),/);
  assert.match(create, /const evmAddresses = useMemo\(\s*\(\) => getBnbContractAddresses\(configuredEvmChainId\),/);
  assert.match(create, /const evmContractsConfigured = evmContractReadiness\.ready && Boolean\(evmAddresses\.launchFactory\);/);
  assert.match(create, /!isSolanaCreator && evmDirectDeployEnabled && evmContractsConfigured && walletOkForEvmDeploy;/);
  // the gen-8 readiness lives in the lib and is keyed on isDogeosChainId, never on the Robinhood sets
  const lib = read("lib/bnbContracts.ts");
  assert.match(lib, /isDogeosChainId\(chainId\)/);
  assert.match(lib, /gen8AppConfig\(DOGEOS_TESTNET_CHAIN_ID\)\?\.launcher/);
  assert.doesNotMatch(lib, /isRobinhoodChainId/);
  // the gen-7 client never reads or writes the Bark launcher as a gen-7 factory on DogeOS
  const client = read("lib/launchpadClient.ts");
  assert.match(client, /const factoryAddress = isDogeosChainId\(evmReadChainId\) \? "" : bnbAddresses\.launchFactory;/);
});

// Gate 2 I2: the create page's creator-eligibility read and PushDraftLive ask getScheduledFactoryAddress for the
// chain's scheduled (gen-7) factory. DogeOS has none (launchpad.factoryAddress is ""), so the unsuffixed BNB-era names
// must never answer for 6281971. 56/97 keep the unsuffixed fallback; Robinhood keeps exactly what it reads today.
const BNB_SCHEDULED = addr(0x5601);
const BNB_SCHEDULED_LAUNCH = addr(0x5602);
const SCHEDULED_97 = addr(0x9701);
const scheduledHarness = (name, extra) =>
  loadHarness(name, { ...BASE_ENV, ...BARK_APP_ENV, ...extra }, `export * from "./scheduledFactoryConfig.ts";`);

test("6281971 never resolves to the unsuffixed BNB scheduled factory; 56/97 and Robinhood keep their reads", async () => {
  const both = await scheduledHarness("dogeos-scheduled-both", {
    VITE_SCHEDULED_FACTORY_ADDRESS: BNB_SCHEDULED,
    VITE_SCHEDULED_LAUNCH_FACTORY_ADDRESS: BNB_SCHEDULED_LAUNCH,
    VITE_SCHEDULED_FACTORY_ADDRESS_97: SCHEDULED_97,
  });
  const launchOnly = await scheduledHarness("dogeos-scheduled-launch-only", { VITE_SCHEDULED_LAUNCH_FACTORY_ADDRESS: BNB_SCHEDULED_LAUNCH });
  for (const m of [both, launchOnly]) {
    // what the create page and PushDraftLive pass on DogeOS: launchpad.factoryAddress = ""
    assert.equal(m.getScheduledFactoryAddress(DOGEOS, ""), "");
    assert.equal(m.getScheduledFactoryAddress(DOGEOS, null), "");
    assert.equal(m.getScheduledFactoryAddress(DOGEOS), "");
  }
  // BNB: the per-chain name first, then the unsuffixed ones (unchanged)
  assert.equal(both.getScheduledFactoryAddress(97, ""), SCHEDULED_97);
  assert.equal(both.getScheduledFactoryAddress(56, ""), BNB_SCHEDULED);
  assert.equal(launchOnly.getScheduledFactoryAddress(56, ""), BNB_SCHEDULED_LAUNCH);
  assert.equal(launchOnly.getScheduledFactoryAddress(97, ""), BNB_SCHEDULED_LAUNCH);
  // Robinhood reads what it read before this fix (the unsuffixed names apply to it today)
  for (const rh of [4663, RH_TESTNET]) {
    assert.equal(both.getScheduledFactoryAddress(rh, ""), BNB_SCHEDULED, String(rh));
    assert.equal(launchOnly.getScheduledFactoryAddress(rh, RH.FACTORY), BNB_SCHEDULED_LAUNCH, String(rh));
  }
  // the obsolete BSC testnet factory stays refused on 97
  const obsolete = await scheduledHarness("dogeos-scheduled-obsolete", { VITE_SCHEDULED_FACTORY_ADDRESS: both.OBSOLETE_BSC_TESTNET_SCHEDULED_FACTORY });
  assert.equal(obsolete.getScheduledFactoryAddress(97, ""), "");
  assert.equal(obsolete.getScheduledFactoryAddress(56, ""), both.OBSOLETE_BSC_TESTNET_SCHEDULED_FACTORY);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { ethers } from "ethers";

import { evmGen7DexName, evmGen7GraduationTiers } from "./evmGen7.mjs";
import { DOGEOS_DEX_LABEL } from "./dogeosPresentation.mjs";

// DogeOS Chikyu testnet (6281971) on the gen-7 launch path: it takes the Robinhood V3 family branches
// (adapter, USD graduation target, $150 test tier, V3 post-graduation trade) through isDogeosChainId,
// never through isRobinhoodChainId, and its post-graduation trade runs on MuchFi (fee 10000).
// Robinhood 46630 is asserted next to it so the existing behaviour stays pinned.

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");
const read = (rel) => readFileSync(path.join(srcRoot, rel), "utf8");

const DOGEOS = 6281971;
const RH_TESTNET = 46630;

// Global constraints / spec section 1 (MuchFi on Chikyu, verified on a fork by t30).
const MUCHFI = {
  FACTORY: "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  SMART_ROUTER: "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  QUOTER_V2: "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
  WDOGE: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
};
const MUCHFI_POOL_FEE = 10000;

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
const DOGEOS_ENV = {
  VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971: MUCHFI.SMART_ROUTER,
  VITE_ROBINHOOD_V3_FACTORY_ADDRESS_6281971: MUCHFI.FACTORY,
  VITE_ROBINHOOD_V3_QUOTER_ADDRESS_6281971: MUCHFI.QUOTER_V2,
  VITE_WRAPPED_NATIVE_ADDRESS_6281971: MUCHFI.WDOGE,
  VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_6281971: DOGEOS_S1_ADAPTER,
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
async function loadHarness(name, env) {
  if (harnessCache.has(name)) return harnessCache.get(name);
  const compiled = await build({
    absWorkingDir: dir,
    stdin: {
      contents: `
import * as graduationTiers from "./graduationTiers.ts";
import * as v3Trade from "./robinhoodV3Trade.ts";
import * as lpFeeHarvest from "./lpFeeHarvest.ts";
import * as launchpadAdapter from "../features/launchpad/useLaunchpadAdapter.ts";
import * as robinhoodAdapter from "../features/launchpad/robinhoodAdapter.ts";
export { graduationTiers, v3Trade, lpFeeHarvest, launchpadAdapter, robinhoodAdapter };
`,
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
  // Inside the frontend package tree so Node resolves frontend/node_modules (gitignored dir).
  const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-feed-isolation-"));
  const outfile = path.join(tmpDir, `${name}.mjs`);
  await writeFile(outfile, compiled.outputFiles[0].text);
  const loaded = await import(pathToFileURL(outfile).href);
  harnessCache.set(name, loaded);
  return loaded;
}

const fullHarness = () => loadHarness("dogeos-launch-path-full", { ...BASE_ENV, ...DOGEOS_ENV });
const robinhoodOnlyHarness = () => loadHarness("dogeos-launch-path-rh-only", BASE_ENV);

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

// What the V3 pool indexer stores for a 1% MuchFi pool: fee_bps = feePpm / 100 = 100.
const dogeosMarket = (overrides = {}) =>
  marketRow({ router: MUCHFI.SMART_ROUTER, factory: MUCHFI.FACTORY, wrappedNative: MUCHFI.WDOGE, quoteToken: MUCHFI.WDOGE, feeBps: 100, ...overrides });
const robinhoodMarket = (overrides = {}) =>
  marketRow({ router: RH.ROUTER, factory: RH.FACTORY, wrappedNative: RH.WETH, quoteToken: RH.WETH, feeBps: 30, ...overrides });
const dogeosVenue = () =>
  fakeVenue({ chainId: DOGEOS, router: MUCHFI.SMART_ROUTER, factory: MUCHFI.FACTORY, wrapped: MUCHFI.WDOGE, adapter: DOGEOS_S1_ADAPTER, quoter: MUCHFI.QUOTER_V2 });
const robinhoodVenue = () =>
  fakeVenue({ chainId: RH_TESTNET, router: RH.ROUTER, factory: RH.FACTORY, wrapped: RH.WETH, adapter: RH.ADAPTER, quoter: RH.QUOTER });

// ---------------------------------------------------------------- adapter selection

test("6281971 selects the V3-family launchpad adapter and keeps its own chain id", async () => {
  const { launchpadAdapter, robinhoodAdapter } = await fullHarness();
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chainId: DOGEOS }).chain, "robinhood");
  assert.equal(launchpadAdapter.getLaunchpadAdapter({ chainId: String(DOGEOS) }).chain, "robinhood");
  // never the 46630 default
  assert.equal(robinhoodAdapter.resolveRobinhoodChainId(DOGEOS), DOGEOS);
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

test("the USD graduation-target read and the bonding buy switch treat 6281971 like Robinhood", () => {
  const client = read("lib/launchpadClient.ts");
  assert.match(
    client,
    /const isRobinhoodRead =\s*evmReadChainId === ROBINHOOD_CHAIN_ID \|\| evmReadChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosChainId\(evmReadChainId\);/,
  );
  assert.match(client, /readBig\("graduationNativeTarget", isRobinhoodRead \? 0n : graduationTarget\)/);
  assert.match(
    client,
    /const isRobinhoodBuy = targetChainId === ROBINHOOD_CHAIN_ID \|\| targetChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosChainId\(targetChainId\);/,
  );
  assert.match(
    client,
    /if \(productChain === ROBINHOOD_CHAIN_ID \|\| productChain === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosChainId\(productChain\)\) \{\s*return productChain;/,
  );
});

test("the $150 gen-7 test tier is reachable on 6281971 and its pools are named MuchFi", async () => {
  const { graduationTiers } = await fullHarness();
  const staging = { environment: "staging", cluster: "devnet" };
  assert.equal(graduationTiers.isTestGraduationChain(DOGEOS, staging), true);
  assert.equal(graduationTiers.isTestGraduationChain(97, staging), true);
  assert.equal(graduationTiers.isTestGraduationChain(46630, staging), true);
  assert.equal(graduationTiers.isTestGraduationChain(56, staging), false);
  assert.equal(graduationTiers.isTestGraduationChain(4663, staging), false);

  assert.equal(DOGEOS_DEX_LABEL, "MuchFi");
  assert.equal(evmGen7DexName(DOGEOS), "MuchFi");
  assert.equal(evmGen7DexName(46630), "Uniswap");
  assert.equal(evmGen7DexName(97), "Topaz");
  const tiers = evmGen7GraduationTiers(DOGEOS, { testTierEnabled: true });
  assert.deepEqual(tiers.map((tier) => tier.label), ["$150", "$30K MC", "$50K MC"]);
  assert.match(tiers[1].description, /Moves to a MuchFi pool/);
});

test("create surfaces use the V3-family branch for 6281971, through isDogeosChainId only", () => {
  const create = read("pages/Create.tsx");
  const options = read("components/create/EvmGen6LaunchOptions.tsx");
  const chainConfig = read("lib/chainConfig.ts");
  assert.match(create, /const robinhoodSelected = isRobinhoodChain\(Number\(configuredEvmChainId\)\) \|\| isDogeosChainId\(Number\(configuredEvmChainId\)\);/);
  assert.equal((options.match(/const isRobinhood = isRobinhoodChainId\((input\.)?chainId\) \|\| isDogeosChainId\((input\.)?chainId\);/g) || []).length, 2);
  // isRobinhoodChainId itself never learns 6281971 (it also drives ETH symbols and stock logic).
  assert.match(chainConfig, /export function isRobinhoodChainId\(chainId\?: number \| null\): boolean \{\s*return chainId === ROBINHOOD_CHAIN_ID \|\| chainId === ROBINHOOD_TESTNET_CHAIN_ID;\s*\}/);
});

test("token page entry, war-room row and trade panel keep 6281971 instead of defaulting to 56 or 46630", () => {
  const entry = read("pages/TokenDetailsLiveEntry.tsx");
  const row = read("components/postgrad/WarRoomCampaignRow.tsx");
  const panel = read("components/postgrad/RobinhoodWarRoomTradePanel.tsx");
  assert.match(entry, /function isV3FamilyChainId\(chainId: number\): boolean \{\s*return isRobinhoodChainId\(chainId\) \|\| isDogeosChainId\(chainId\);/);
  assert.match(entry, /const selectedEvmChainId = isV3FamilyChainId\(Number\(selectedFeedChainId\)\) \|\| isBnbChainId/);
  assert.match(entry, /const effectiveEvmChainId = isV3FamilyChainId\(forcedChainId\) \|\| isBnbChainId\(forcedChainId\)/);
  assert.match(entry, /const robinhoodRoute = isV3FamilyChainId\(effectiveEvmChainId\);/);
  assert.match(entry, /: isV3FamilyChainId\(forcedChainId\) \|\| isBnbChainId\(forcedChainId\)\s*\? forcedChainId/);
  assert.match(row, /inferredChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\| inferredChainId === DOGEOS_TESTNET_CHAIN_ID\s*\? inferredChainId/);
  assert.match(row, /const isRobinhoodRow = rowChainId === ROBINHOOD_CHAIN_ID \|\| rowChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosRow;/);
  assert.match(row, /rowChainId === ROBINHOOD_TESTNET_CHAIN_ID \|\|\s*rowChainId === DOGEOS_TESTNET_CHAIN_ID \|\|\s*rowChainId === 101\s*\) \{\s*setSelectedFeedChainId\(rowChainId\);/);
  assert.match(panel, /return id === ROBINHOOD_CHAIN_ID \|\| id === ROBINHOOD_TESTNET_CHAIN_ID \|\| isDogeosChainId\(id\) \? id : ROBINHOOD_TESTNET_CHAIN_ID;/);
  // the direct panel names the chain's own coin, never a hard-coded ETH, on screen
  assert.doesNotMatch(panel, /formatAmount\([^)]*"ETH"\)/);
  assert.doesNotMatch(panel, />ETH</);
});

// ---------------------------------------------------------------- MuchFi post-graduation trade

test("DogeOS trade: route on the MuchFi SmartRouter, QuoterV2 quote and S1 swap at fee 10000", async () => {
  const { v3Trade } = await fullHarness();
  const venue = dogeosVenue();
  serveMarket(dogeosMarket());
  const route = await v3Trade.resolveRobinhoodV3Route({ provider: venue.provider, campaignAddress: CAMPAIGN, chainId: DOGEOS, expectedTokenAddress: TOKEN });
  assert.equal(route.fee, MUCHFI_POOL_FEE);
  assert.equal(route.routerAddress, MUCHFI.SMART_ROUTER);
  assert.equal(route.factoryAddress, MUCHFI.FACTORY);
  assert.equal(route.wrappedNativeAddress, MUCHFI.WDOGE);
  assert.equal(route.executionAdapterAddress, DOGEOS_S1_ADAPTER);
  assert.equal(route.routeKind, "DIRECT_NATIVE");

  const quote = await v3Trade.quoteRobinhoodV3Buy(venue.provider, route, 10n ** 18n, 100);
  assert.equal(quote.amountOutRaw, 2n * 10n ** 18n);
  const quoterCalls = venue.calls.filter((c) => c.to === MUCHFI.QUOTER_V2);
  assert.equal(quoterCalls.length, 1);
  const [params] = QUOTER_V2_IFACE.decodeFunctionData("quoteExactInputSingle", quoterCalls[0].data);
  assert.equal(Number(params.fee), MUCHFI_POOL_FEE);
  assert.equal(params.tokenIn, MUCHFI.WDOGE);
  assert.equal(params.tokenOut, TOKEN);
  assert.ok(!venue.calls.some((c) => Object.values(RH).includes(c.to)), "no Robinhood address is ever called");

  const { signer, sent } = fakeSigner(venue.provider);
  await v3Trade.executeRobinhoodV3Buy({ signer, quote });
  assert.equal(sent.length, 1);
  assert.equal(ethers.getAddress(sent[0].to), DOGEOS_S1_ADAPTER);
  const buy = ADAPTER_IFACE.decodeFunctionData("buyExactNativeIn", sent[0].data);
  assert.equal(Number(buy.fee), MUCHFI_POOL_FEE);
  assert.equal(BigInt(sent[0].value), 10n ** 18n);

  const sellQuote = await v3Trade.quoteRobinhoodV3Sell(venue.provider, route, 5n, 100);
  const sold = fakeSigner(venue.provider);
  await v3Trade.executeRobinhoodV3Sell({ signer: sold.signer, quote: sellQuote });
  assert.equal(Number(ADAPTER_IFACE.decodeFunctionData("sellExactTokenIn", sold.sent[0].data).fee), MUCHFI_POOL_FEE);
});

test("DogeOS trade: fee 10000 whatever fee_bps the market row carries", async () => {
  const { v3Trade } = await fullHarness();
  for (const feeBps of [null, 0, 30, 100, 10000]) {
    serveMarket(dogeosMarket({ feeBps }));
    const route = await v3Trade.resolveRobinhoodV3Route({ provider: dogeosVenue().provider, campaignAddress: CAMPAIGN, chainId: DOGEOS });
    assert.equal(route.fee, MUCHFI_POOL_FEE, `feeBps ${feeBps}`);
  }
});

test("V3 trade env for 6281971 reads only the _6281971 names, never the unsuffixed Robinhood ones", async () => {
  // A market row without router/factory/wrapped-native falls back to this build's env.
  serveMarket(dogeosMarket({ router: null, factory: null, wrappedNative: null }));
  const full = await fullHarness();
  const route = await full.v3Trade.resolveRobinhoodV3Route({ provider: dogeosVenue().provider, campaignAddress: CAMPAIGN, chainId: DOGEOS });
  assert.equal(route.routerAddress, MUCHFI.SMART_ROUTER);
  assert.equal(route.factoryAddress, MUCHFI.FACTORY);
  assert.equal(route.wrappedNativeAddress, MUCHFI.WDOGE);

  // Only the unsuffixed (Robinhood) names set: DogeOS refuses instead of borrowing them.
  const rhOnly = await robinhoodOnlyHarness();
  await assert.rejects(
    rhOnly.v3Trade.resolveRobinhoodV3Route({ provider: dogeosVenue().provider, campaignAddress: CAMPAIGN, chainId: DOGEOS }),
    /Invalid Robinhood V3 router/,
  );
  // Stock routing stays off for DogeOS even with the unsuffixed flag on; 46630 keeps its own rule.
  assert.equal(full.v3Trade.robinhoodV3TradeInternals.stockEthRoutingEnabled(DOGEOS), false);
  assert.equal(full.v3Trade.robinhoodV3TradeInternals.stockEthRoutingEnabled(RH_TESTNET), true);
  assert.equal(full.v3Trade.robinhoodV3TradeInternals.stockEthRoutingEnabled(4663), true);
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

// ---------------------------------------------------------------- LP fee harvest (MuchFi position locker)

test("LP fee harvest on 6281971 uses the V3 position-locker path with MuchFi wording", async () => {
  const { lpFeeHarvest } = await fullHarness();
  const LOCKER = addr(0x9001);
  const unregistered = V3_LOCKER_IFACE.encodeFunctionResult("poolInfo", [
    ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, POOL, ethers.ZeroAddress, ethers.ZeroAddress, 0n, 0n, 10000, 0, 0, false,
  ]);
  for (const [chainId, words] of [[DOGEOS, /MuchFi position is not registered/], [RH_TESTNET, /Robinhood V3 position is not registered/]]) {
    const calls = [];
    const provider = { async getNetwork() { return { chainId: BigInt(chainId) }; } };
    const signer = {
      provider,
      async call(tx) { calls.push(tx); return unregistered; },
      async sendTransaction() { throw new Error("harvest must not be sent for an unregistered position"); },
    };
    await assert.rejects(
      lpFeeHarvest.harvestLpFeesWithWallet({ chainId, pairAddress: POOL, signer, lockerAddress: LOCKER }),
      words,
    );
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].data).slice(0, 10), V3_LOCKER_IFACE.getFunction("poolInfo").selector);
  }
  await assert.rejects(
    lpFeeHarvest.harvestLpFeesWithWallet({ chainId: DOGEOS, pairAddress: "0x1234", signer: {}, lockerAddress: LOCKER }),
    /Invalid MuchFi pool address\./,
  );
  await assert.rejects(
    lpFeeHarvest.harvestLpFeesWithWallet({ chainId: RH_TESTNET, pairAddress: "0x1234", signer: {}, lockerAddress: LOCKER }),
    /Invalid Robinhood V3 pool address\./,
  );
});

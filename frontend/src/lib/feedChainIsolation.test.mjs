import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");

const BASE_ALLOWED_CHAIN_IDS = "56,97,101,4663,46630";
const DOGEOS_ALLOWED_CHAIN_IDS = `${BASE_ALLOWED_CHAIN_IDS},6281971`;

async function loadHarness(allowedChainIds) {
  const compiled = await build({
    absWorkingDir: dir,
    stdin: {
      contents: `
export { resolveTokenPageChainId, isEvmTokenRoutePath } from "./chainConfig.ts";
export { getBnbCampaignFeedChainIds } from "./feedChainConfig.ts";
export { isSolanaTokenRouteId } from "./tokenDetailsPath.ts";
export { getLaunchpadAdapter } from "../features/launchpad/useLaunchpadAdapter.ts";
export {
  ACTIVE_EVM_CHAIN_IDS,
  KNOWN_EVM_CHAIN_IDS,
  buildEvmWalletChainParams,
  isActiveEvmChainId,
  isKnownEvmChainId,
} from "./evmChainAdapter.ts";
export { chainIdForWalletKind, readStoredFeedChainId } from "./activeWalletChain.ts";
export { parseEmbedChartPath } from "./embedChart.ts";
export { resolveMarketIdentityAcrossEvm } from "./marketIdentity.ts";
export { searchChainIds } from "./searchClient.ts";
export {
  resolveDogeosFeedChainId,
  resolveRobinhoodFeedChainId,
  setSelectedFeedChainId,
} from "../components/common/ChainFeedSwitch.tsx";
export { draftFeedChainIds } from "../components/home/DraftCampaignGrid.tsx";
`,
      resolveDir: dir,
      sourcefile: "feedIsolationHarness.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@": srcRoot },
    jsx: "automatic",
    define: {
      "import.meta.env": JSON.stringify({
        DEV: false,
        PROD: true,
        VITE_DEFAULT_CHAIN_ID: "97",
        VITE_ALLOWED_CHAIN_IDS: allowedChainIds,
      }),
    },
  });

  // Keep the generated ESM harness inside the frontend package tree so Node's
  // normal package resolution can reach frontend/node_modules for external deps.
  const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-feed-isolation-"));
  const outfile = path.join(tmpDir, "feedIsolationHarness.mjs");
  await writeFile(outfile, compiled.outputFiles[0].text);
  return import(pathToFileURL(outfile).href);
}

const harness = await loadHarness(BASE_ALLOWED_CHAIN_IDS);
const dogeosHarness = await loadHarness(DOGEOS_ALLOWED_CHAIN_IDS);
const {
  resolveTokenPageChainId,
  isEvmTokenRoutePath,
  getBnbCampaignFeedChainIds,
  isSolanaTokenRouteId,
  getLaunchpadAdapter,
  ACTIVE_EVM_CHAIN_IDS,
  KNOWN_EVM_CHAIN_IDS,
  buildEvmWalletChainParams,
  isActiveEvmChainId,
  isKnownEvmChainId,
} = harness;

const BNB_CAMPAIGN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOLANA_MINT = "MWZSoLanaTestMint111111111111111111111";

test("0x Token Details never inherit Solana from ?chainId=101", () => {
  const chainId = resolveTokenPageChainId({
    pathname: `/token/${BNB_CAMPAIGN}`,
    search: "?chainId=101",
    routeId: BNB_CAMPAIGN,
  });
  assert.notEqual(chainId, 101);
  assert.ok(chainId === 56 || chainId === 97);
  assert.equal(isEvmTokenRoutePath(`/token/${BNB_CAMPAIGN}`), true);
  assert.equal(isSolanaTokenRouteId(BNB_CAMPAIGN), false);
});

test("base58 Token Details stay Solana even when the feed latch is BNB", () => {
  const chainId = resolveTokenPageChainId({
    pathname: `/token/${SOLANA_MINT}`,
    search: "?chainId=97",
    routeId: SOLANA_MINT,
  });
  assert.equal(chainId, 101);
  assert.equal(isEvmTokenRoutePath(`/token/${SOLANA_MINT}`), false);
  assert.equal(isSolanaTokenRouteId(SOLANA_MINT), true);
});

test("Solana feed selection does not merge BNB inventory", () => {
  assert.deepEqual(getBnbCampaignFeedChainIds(101), [101]);
});

test("Robinhood feed selection stays isolated from BNB and Solana inventory", () => {
  assert.deepEqual(getBnbCampaignFeedChainIds(4663), [4663]);
  assert.deepEqual(getBnbCampaignFeedChainIds(46630), [46630]);
});

test("BNB feeds may merge 56+97 but must never include Solana or Robinhood", () => {
  for (const selected of [56, 97, null, undefined]) {
    const ids = getBnbCampaignFeedChainIds(selected);
    assert.ok(ids.length >= 1);
    assert.ok(!ids.includes(101));
    assert.ok(!ids.includes(4663));
    assert.ok(!ids.includes(46630));
    assert.ok(ids.every((id) => id === 56 || id === 97));
  }
});

test("launchpad adapter preserves Robinhood as a first-class product identity", () => {
  assert.equal(getLaunchpadAdapter({ chainId: 56 }).chain, "bnb");
  assert.equal(getLaunchpadAdapter({ chainId: 101 }).chain, "solana");
  assert.equal(getLaunchpadAdapter({ chainId: 4663 }).chain, "robinhood");
  assert.equal(getLaunchpadAdapter({ chainId: 46630 }).chain, "robinhood");
  assert.equal(getLaunchpadAdapter({ chain: "robinhood" }).chain, "robinhood");
});

test("Robinhood is known to the generic EVM layer but remains inactive until protocol activation", () => {
  assert.deepEqual(KNOWN_EVM_CHAIN_IDS, [56, 97, 4663, 46630, 6281971]);
  assert.deepEqual(ACTIVE_EVM_CHAIN_IDS, [56, 97]);
  assert.equal(isKnownEvmChainId(4663), true);
  assert.equal(isKnownEvmChainId(46630), true);
  assert.equal(isActiveEvmChainId(4663), false);
  assert.equal(isActiveEvmChainId(46630), false);
});

test("BNB wallet chain parameters remain protocol-compatible", () => {
  const mainnet = buildEvmWalletChainParams(56, ["https://rpc.example/56"]);
  assert.equal(mainnet.chainId, "0x38");
  assert.equal(mainnet.chainName, "BNB Smart Chain");
  assert.deepEqual(mainnet.nativeCurrency, { name: "BNB", symbol: "BNB", decimals: 18 });
  assert.deepEqual(mainnet.blockExplorerUrls, ["https://bscscan.com/"]);

  const testnet = buildEvmWalletChainParams(97, ["https://rpc.example/97"]);
  assert.equal(testnet.chainId, "0x61");
  assert.equal(testnet.chainName, "BNB Smart Chain Testnet");
  assert.deepEqual(testnet.nativeCurrency, { name: "tBNB", symbol: "tBNB", decimals: 18 });
  assert.deepEqual(testnet.blockExplorerUrls, ["https://testnet.bscscan.com/"]);
});

test("Robinhood wallet parameters are constructible without activating the chain", () => {
  const mainnet = buildEvmWalletChainParams(4663, ["https://rpc.mainnet.chain.robinhood.com"]);
  assert.equal(mainnet.chainId, "0x1237");
  assert.equal(mainnet.chainName, "Robinhood Chain");
  assert.deepEqual(mainnet.nativeCurrency, { name: "ETH", symbol: "ETH", decimals: 18 });
  assert.deepEqual(mainnet.blockExplorerUrls, ["https://robinhoodchain.blockscout.com/"]);
  assert.equal(isActiveEvmChainId(4663), false);

  const testnet = buildEvmWalletChainParams(46630, ["https://rpc.testnet.chain.robinhood.com"]);
  assert.equal(testnet.chainId, "0xb626");
  assert.equal(testnet.chainName, "Robinhood Chain Testnet");
  assert.deepEqual(testnet.nativeCurrency, { name: "ETH", symbol: "ETH", decimals: 18 });
  assert.deepEqual(testnet.blockExplorerUrls, ["https://explorer.testnet.chain.robinhood.com/"]);
  assert.equal(isActiveEvmChainId(46630), false);
});

const DOGEOS = 6281971;
const MIXED_CASE_TOKEN = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

/** Minimal browser globals for the storage-backed selectors; removed again after each use. */
async function withBrowserStorage(entries, fn) {
  const store = new Map(Object.entries(entries));
  const hadWindow = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = {
    location: { hostname: "memewar.zone", search: "", pathname: "/" },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    dispatchEvent: () => true,
  };
  try {
    return await fn(store);
  } finally {
    if (hadWindow) globalThis.window = previous;
    else delete globalThis.window;
  }
}

/** Records every chainId the token-page EVM probe asks /api/market/resolve for. */
async function probedMarketChains(h) {
  const chains = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const match = String(url).match(/[?&]chainId=(\d+)/);
    if (match) chains.push(Number(match[1]));
    return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "content-type": "application/json" } });
  };
  try {
    await h.resolveMarketIdentityAcrossEvm({ address: BNB_CAMPAIGN });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return chains;
}

test("DogeOS feed selection is isolated to 6281971 when VITE_ALLOWED_CHAIN_IDS includes it", () => {
  assert.deepEqual(dogeosHarness.getBnbCampaignFeedChainIds(DOGEOS), [DOGEOS]);
  for (const selected of [56, 97, 101, 4663, 46630, null, undefined]) {
    assert.ok(!dogeosHarness.getBnbCampaignFeedChainIds(selected).includes(DOGEOS), `selected ${selected}`);
  }
  // Existing isolation is unchanged when DogeOS is allowed.
  assert.deepEqual(dogeosHarness.getBnbCampaignFeedChainIds(101), [101]);
  assert.deepEqual(dogeosHarness.getBnbCampaignFeedChainIds(4663), [4663]);
  assert.deepEqual(dogeosHarness.getBnbCampaignFeedChainIds(46630), [46630]);
  assert.deepEqual(dogeosHarness.getBnbCampaignFeedChainIds(56), [97, 56]);
});

test("DogeOS never appears in any feed when VITE_ALLOWED_CHAIN_IDS leaves it out", () => {
  for (const selected of [DOGEOS, 56, 97, 101, 4663, 46630, null, undefined]) {
    assert.ok(!getBnbCampaignFeedChainIds(selected).includes(DOGEOS), `selected ${selected}`);
  }
  assert.ok(!harness.searchChainIds().includes(DOGEOS));
  assert.equal(harness.resolveDogeosFeedChainId(), null);
  assert.notEqual(harness.setSelectedFeedChainId(DOGEOS), DOGEOS);
});

test("search covers DogeOS only when it is allowed, and keeps the existing chains", () => {
  assert.deepEqual(harness.searchChainIds(), [101, 97, 56, 4663, 46630]);
  assert.deepEqual(dogeosHarness.searchChainIds(), [101, 97, 56, 4663, 46630, DOGEOS]);
});

test("chain switch selects DogeOS as its own isolated feed when allowed", () => {
  assert.equal(dogeosHarness.resolveDogeosFeedChainId(), DOGEOS);
  assert.equal(dogeosHarness.setSelectedFeedChainId(DOGEOS), DOGEOS);
  // Robinhood and Solana selection are untouched by DogeOS.
  assert.equal(dogeosHarness.resolveRobinhoodFeedChainId(), harness.resolveRobinhoodFeedChainId());
  assert.equal(dogeosHarness.setSelectedFeedChainId(46630), 46630);
  assert.equal(dogeosHarness.setSelectedFeedChainId(101), 101);
});

test("draft discovery keeps DogeOS isolated the way Robinhood testnet is", () => {
  assert.deepEqual(dogeosHarness.draftFeedChainIds(DOGEOS), [DOGEOS]);
  assert.deepEqual(harness.draftFeedChainIds(46630), [46630]);
  assert.deepEqual(harness.draftFeedChainIds(4663), [4663]);
  assert.deepEqual(harness.draftFeedChainIds(101), [101]);
  assert.deepEqual(harness.draftFeedChainIds(56), [56, 97]);
  assert.deepEqual(harness.draftFeedChainIds(97), [56, 97]);
});

test("stored feed chain and wallet-kind chain accept DogeOS like the other EVM chains", async () => {
  assert.equal(harness.chainIdForWalletKind("bnb", DOGEOS), DOGEOS);
  assert.equal(harness.chainIdForWalletKind("bnb", 46630), 46630);
  assert.equal(harness.chainIdForWalletKind("solana", DOGEOS), 101);
  await withBrowserStorage({ "mwz:selected_feed_chain_id": String(DOGEOS) }, () => {
    assert.equal(harness.readStoredFeedChainId(), DOGEOS);
    assert.equal(harness.chainIdForWalletKind("bnb", null), DOGEOS);
  });
  await withBrowserStorage({ "mwz:selected_feed_chain_id": "46630" }, () => {
    assert.equal(harness.readStoredFeedChainId(), 46630);
    assert.equal(harness.chainIdForWalletKind("bnb", null), 46630);
  });
  await withBrowserStorage({ "mwz:selected_feed_chain_id": "8453" }, () => {
    assert.equal(harness.readStoredFeedChainId(), null);
    assert.equal(harness.chainIdForWalletKind("bnb", null), 56);
  });
});

test("partner chart embed accepts DogeOS and lowercases its EVM token", () => {
  assert.deepEqual(harness.parseEmbedChartPath(`/embed/chart/${DOGEOS}/${MIXED_CASE_TOKEN}`), {
    chainId: DOGEOS,
    token: MIXED_CASE_TOKEN.toLowerCase(),
  });
  assert.deepEqual(harness.parseEmbedChartPath(`/embed/chart/46630/${MIXED_CASE_TOKEN}`), {
    chainId: 46630,
    token: MIXED_CASE_TOKEN.toLowerCase(),
  });
  assert.equal(harness.parseEmbedChartPath(`/embed/chart/8453/${MIXED_CASE_TOKEN}`), null);
});

test("token-page EVM probe adds DogeOS last, only when it is allowed", async () => {
  assert.deepEqual(await probedMarketChains(harness), [97, 56, 46630, 4663]);
  assert.deepEqual(await probedMarketChains(dogeosHarness), [97, 56, 46630, 4663, DOGEOS]);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");

const compiled = await build({
  absWorkingDir: dir,
  stdin: {
    contents: `
export { resolveTokenPageChainId, isEvmTokenRoutePath } from "./chainConfig.ts";
export { getBnbCampaignFeedChainIds } from "./feedChainConfig.ts";
export { isSolanaTokenRouteId } from "./tokenDetailsPath.ts";
export {
  ACTIVE_EVM_CHAIN_IDS,
  KNOWN_EVM_CHAIN_IDS,
  buildEvmWalletChainParams,
  isActiveEvmChainId,
  isKnownEvmChainId,
} from "./evmChainAdapter.ts";
`,
    resolveDir: dir,
    sourcefile: "feedIsolationHarness.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  alias: { "@": srcRoot },
  define: {
    "import.meta.env": JSON.stringify({
      DEV: false,
      PROD: true,
      VITE_DEFAULT_CHAIN_ID: "97",
    }),
  },
});

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mwz-feed-isolation-"));
const outfile = path.join(tmpDir, "feedIsolationHarness.mjs");
await writeFile(outfile, compiled.outputFiles[0].text);
const {
  resolveTokenPageChainId,
  isEvmTokenRoutePath,
  getBnbCampaignFeedChainIds,
  isSolanaTokenRouteId,
  ACTIVE_EVM_CHAIN_IDS,
  KNOWN_EVM_CHAIN_IDS,
  buildEvmWalletChainParams,
  isActiveEvmChainId,
  isKnownEvmChainId,
} = await import(pathToFileURL(outfile).href);

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

test("BNB feeds may merge 56+97 but must never include Solana 101", () => {
  for (const selected of [56, 97, null, undefined]) {
    const ids = getBnbCampaignFeedChainIds(selected);
    assert.ok(ids.length >= 1);
    assert.ok(!ids.includes(101));
    assert.ok(ids.every((id) => id === 56 || id === 97));
  }
});

test("Robinhood is known to the generic EVM layer but remains inactive", () => {
  assert.deepEqual(KNOWN_EVM_CHAIN_IDS, [56, 97, 4663, 46630]);
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

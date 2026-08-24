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

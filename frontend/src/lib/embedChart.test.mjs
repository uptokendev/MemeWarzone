import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");

const compiled = await build({
  absWorkingDir: dir,
  stdin: {
    contents: `export * from "./embedChart.ts";`,
    resolveDir: dir,
    sourcefile: "embedChartHarness.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { "@": srcRoot },
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`;
const {
  EMBED_CHART_DEFAULT_RESOLUTION,
  EMBED_CHART_FRAME_ANCESTORS,
  EMBED_CHART_POLL_MS,
  buildEmbedChartPath,
  isEmbedChartPath,
  isEmbedPath,
  liveNativeFromSummary,
  nativeUsdFromSummary,
  parseEmbedChartPath,
  parseEmbedChartResolution,
} = await import(moduleUrl);

const K88_MINT = "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77";
const K88_CAMPAIGN = "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA";

test("embed paths are recognized without treating token pages as embeds", () => {
  assert.equal(isEmbedPath("/embed/chart/101/" + K88_MINT), true);
  assert.equal(isEmbedChartPath("/embed/chart/101/" + K88_MINT), true);
  assert.equal(isEmbedPath("/embed"), true);
  assert.equal(isEmbedChartPath("/token/" + K88_CAMPAIGN), false);
  assert.equal(isEmbedPath("/token/" + K88_CAMPAIGN), false);
});

test("K88 mint and campaign PDA both parse as Solana embed identities", () => {
  assert.deepEqual(parseEmbedChartPath(`/embed/chart/101/${K88_MINT}`), {
    chainId: 101,
    token: K88_MINT,
  });
  assert.deepEqual(parseEmbedChartPath(`/embed/chart/101/${K88_CAMPAIGN}`), {
    chainId: 101,
    token: K88_CAMPAIGN,
  });
  assert.equal(parseEmbedChartPath("/embed/chart/101/not-an-address"), null);
  assert.equal(parseEmbedChartPath("/embed/chart/999/" + K88_MINT), null);
});

test("EVM embed tokens are lowercased; Solana case is preserved", () => {
  const evm = parseEmbedChartPath("/embed/chart/56/0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA");
  assert.equal(evm?.token, "0x35e93d0b0f4a2809264fa8d9922e2d0d1609c9ba");
  const solana = parseEmbedChartPath(`/embed/chart/101/${K88_MINT}`);
  assert.equal(solana?.token, K88_MINT);
});

test("interval query defaults to 1m and accepts chart timeframes", () => {
  assert.equal(parseEmbedChartResolution(""), EMBED_CHART_DEFAULT_RESOLUTION);
  assert.equal(parseEmbedChartResolution("interval=1h"), "1h");
  assert.equal(parseEmbedChartResolution("tf=15m"), "15m");
  assert.equal(parseEmbedChartResolution("resolution=nope"), EMBED_CHART_DEFAULT_RESOLUTION);
});

test("partner iframe path for K88 is the CrypticPump drop-in", () => {
  assert.equal(
    buildEmbedChartPath(101, K88_MINT),
    `/embed/chart/101/${encodeURIComponent(K88_MINT)}`,
  );
  assert.equal(
    buildEmbedChartPath(101, K88_MINT, { interval: "1h" }),
    `/embed/chart/101/${encodeURIComponent(K88_MINT)}?interval=1h`,
  );
});

test("native USD comes from indexer summary fields, never a missing fallback of 1", () => {
  assert.equal(nativeUsdFromSummary({ reference_price_usd: "118.23" }), 118.23);
  assert.equal(
    nativeUsdFromSummary({ market_cap_usd: "6529.517755918239", market_cap_bnb: "55.22724990204043" }).toFixed(2),
    (6529.517755918239 / 55.22724990204043).toFixed(2),
  );
  assert.equal(nativeUsdFromSummary(null), 0);
  assert.deepEqual(liveNativeFromSummary({ last_price_bnb: "0.000000217", market_cap_bnb: "55.22" }), {
    priceNative: 0.000000217,
    mcapNative: 55.22,
  });
});

test("embed poll is indexer-paced and CrypticPump is the framed partner", () => {
  assert.equal(EMBED_CHART_POLL_MS, 15_000);
  assert.ok(EMBED_CHART_FRAME_ANCESTORS.includes("https://crypticpump.com"));
});

const RPC_IMPORT_RE =
  /solanaReadConnection|solanaOnChainTrades|solanaCampaignRead|getPublicRpcUrl|getReadProvider|useWallet|useAblyTokenChannel|api\.coingecko\.com|WalletProvider/;

function importedForbidden(source) {
  return source
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line))
    .some((line) => RPC_IMPORT_RE.test(line));
}

test("embed page and feed hook never import wallet, Ably, or chain RPC", async () => {
  const page = await readFile(path.join(srcRoot, "pages/EmbedChartPage.tsx"), "utf8");
  const hook = await readFile(path.join(srcRoot, "hooks/useEmbedChartMarket.ts"), "utf8");
  const app = await readFile(path.join(srcRoot, "App.tsx"), "utf8");
  assert.equal(importedForbidden(page), false, "EmbedChartPage imported a forbidden module");
  assert.equal(importedForbidden(hook), false, "useEmbedChartMarket imported a forbidden module");
  assert.match(hook, /fetchMarketCandles/);
  assert.match(hook, /fetchMarketSummary/);
  assert.match(app, /isEmbedPath\(location\.pathname\)/);
  const walletIdx = app.indexOf("<WalletProvider>");
  const embedIdx = app.indexOf("if (isEmbedPath(location.pathname))");
  assert.ok(embedIdx >= 0 && walletIdx >= 0 && embedIdx < walletIdx, "embed shell must return before WalletProvider");
});

test("Netlify and _headers allow CrypticPump to frame only /embed/chart", async () => {
  const headers = await readFile(path.resolve(srcRoot, "../public/_headers"), "utf8");
  const netlify = await readFile(path.resolve(srcRoot, "../netlify.toml"), "utf8");
  assert.match(headers, /\/embed\/chart\/\*/);
  assert.match(headers, /frame-ancestors 'self' https:\/\/crypticpump\.com https:\/\/www\.crypticpump\.com/);
  assert.match(netlify, /for = "\/embed\/chart\/\*"/);
  assert.match(netlify, /frame-ancestors 'self' https:\/\/crypticpump\.com https:\/\/www\.crypticpump\.com/);
});

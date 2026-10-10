// DogeOS Chikyū testnet (6281971) presentation: native symbol, chain label, explorer, DEX name and the
// DOGE/USD price source. Every helper gets an explicit 6281971 branch (never the BNB/ETH fallthrough),
// and the existing chains (56, 97, 101, 4663, 46630) keep exactly the values they had before.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import {
  DOGEOS_CHAIN_LABEL,
  DOGEOS_SHORT_LABEL,
  DOGEOS_DEX_LABEL,
  DOGEOS_EXPLORER_BASE,
  DOGEOS_NATIVE_SYMBOL,
  DOGEOS_TESTNET_CHAIN_ID,
  isDogeosTestnetChain,
} from "./dogeosPresentation.mjs";
import {
  EVM_NATIVE_LAUNCH_CHAIN_IDS,
  bondingCurrency,
  chainGraduationCopy,
  directDeployBindPath,
  draftGraduationSelection,
  evmNativeLaunchQuote,
  isEvmNativeLaunchQuote,
  nativeProviderKey,
  nativeSymbol,
  providerLabel,
} from "./graduationMarketPresentation.mjs";
import { chainLabel as walletGuardChainLabel } from "./walletChainGuard.mjs";
import { tokenShareChainLabel } from "./tokenShareCard.mjs";
import {
  buildEvmLaunchpadSafetyStatus,
  getEvmLaunchpadPresentation,
  isBnbEvmLaunchpadChain,
  isRobinhoodEvmLaunchpadChain,
} from "./launchpad/adapters/evmLaunchpadSafetyPresentation.mjs";

const DOGE = 6281971;
const EXISTING = [56, 97, 101, 4663, 46630];
const FOREIGN = /\b(BNB|ETH|SOL|WETH|WBNB)\b|bscscan|robinhood|solana|Topaz|Uniswap|Meteora|PancakeSwap/i;

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");

let harnessPromise;
async function loadHarness() {
  harnessPromise ??= (async () => {
    const compiled = await build({
      absWorkingDir: dir,
      stdin: {
        contents: `
export { getNativeSymbol, getChainLabel, getExplorerTxBase, DOGEOS_TESTNET_CHAIN_ID as CONFIG_DOGEOS_CHAIN_ID } from "./chainConfig.ts";
export { nativeSymbolFor, chainNameFor, dexNameFor, formatNative } from "./homeFeedData.ts";
export { nativeSymbolForChain } from "./rewardProgramsApi.ts";
export { getExplorerBase as profileExplorerBase } from "./profile/profileFormatters.ts";
export {
  feedChainLabel,
  feedNativeSymbol,
  chartExplorerTxUrl,
  draftChainLabel,
  draftChainBadgeClass,
  publicProfileExplorerBase,
  tokenDetailsExplorerBase,
  evmPageNativeUnit,
  evmPageDexVenueLabel,
  rewardNativeSymbol,
  rewardChainLabel,
  profileNativeSymbol,
  upvoteNativeUnit,
  upvoteNetworkLabel,
} from "./chainPresentation.ts";
export { nativeUsdPriceSource } from "../hooks/useNativeUsdPrice.ts";
export { fetchDogeUsdFromSources } from "../hooks/useDogeUsdPrice.ts";
`,
        resolveDir: dir,
        sourcefile: "dogeosPresentationHarness.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      packages: "external",
      alias: { "@": srcRoot },
      define: {
        "import.meta.env": JSON.stringify({
          DEV: false,
          PROD: true,
          VITE_DEFAULT_CHAIN_ID: "97",
          VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630,6281971",
        }),
      },
      logLevel: "silent",
    });
    const tmp = await mkdtemp(path.join(frontendRoot, ".mwz-dogeos-presentation-"));
    const file = path.join(tmp, "harness.mjs");
    await writeFile(file, compiled.outputFiles[0].text);
    try {
      return await import(pathToFileURL(file).href);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  })();
  return harnessPromise;
}

test("the DogeOS display constants match chainConfig", async () => {
  const h = await loadHarness();
  assert.equal(DOGEOS_TESTNET_CHAIN_ID, DOGE);
  assert.equal(h.CONFIG_DOGEOS_CHAIN_ID, DOGE);
  assert.equal(DOGEOS_NATIVE_SYMBOL, "DOGE");
  assert.equal(h.getNativeSymbol(DOGE), DOGEOS_NATIVE_SYMBOL);
  assert.equal(DOGEOS_CHAIN_LABEL, "DogeOS Chikyū Testnet");
  assert.equal(h.getChainLabel(DOGE), DOGEOS_CHAIN_LABEL);
  assert.equal(DOGEOS_SHORT_LABEL, "DogeOS");
  assert.equal(DOGEOS_EXPLORER_BASE, "https://dogeos-testnet.l2scan.co");
  assert.equal(h.getExplorerTxBase(DOGE), `${DOGEOS_EXPLORER_BASE}/tx/`);
  assert.equal(DOGEOS_DEX_LABEL, "MuchFi");
  assert.equal(isDogeosTestnetChain(DOGE), true);
  assert.equal(isDogeosTestnetChain("6281971"), true);
  for (const id of EXISTING) assert.equal(isDogeosTestnetChain(id), false, String(id));
});

test("graduation market: DOGE bonding, native launch default, DogeOS provider", () => {
  assert.equal(nativeSymbol(DOGE), "DOGE");
  assert.equal(nativeSymbol("6281971"), "DOGE");
  assert.equal(bondingCurrency(DOGE), "DOGE");
  assert.deepEqual(chainGraduationCopy(DOGE).lines[0], "Bonding stays in DOGE.");
  assert.ok(EVM_NATIVE_LAUNCH_CHAIN_IDS.has(DOGE));
  const doge = evmNativeLaunchQuote(DOGE);
  assert.equal(doge.id, "native:6281971");
  assert.equal(doge.chainId, "6281971");
  assert.equal(doge.symbol, "DOGE");
  assert.equal(doge.displayName, "DOGE");
  assert.equal(doge.contractAddressOrMint, "native:6281971");
  assert.equal(doge.provider.key, "dogeos-basic");
  assert.equal(doge.provider.displayName, "DogeOS");
  assert.equal(nativeProviderKey(DOGE), "dogeos-basic");
  assert.equal(providerLabel({ chainId: "6281971", provider: { key: "dogeos-basic" } }), "DogeOS");
  assert.equal(isEvmNativeLaunchQuote(doge), true);
  assert.equal(directDeployBindPath(doge), "native");
  assert.deepEqual(draftGraduationSelection(doge, DOGE), {
    graduationQuoteAssetId: "",
    graduationQuoteStateVersion: 0,
    policyVersion: "chain-native-default",
    chainId: DOGE,
  });
});

test("graduation market: existing chains unchanged", () => {
  assert.deepEqual(EXISTING.map(nativeSymbol), ["BNB", "BNB", "SOL", "ETH", "ETH"]);
  assert.deepEqual(EXISTING.map(nativeProviderKey), ["bnb-basic", "bnb-basic", "solana-basic", "robinhood-basic", "robinhood-basic"]);
  assert.deepEqual([...EVM_NATIVE_LAUNCH_CHAIN_IDS].sort((a, b) => a - b), [56, 97, 4663, 46630, DOGE]);
  assert.equal(evmNativeLaunchQuote(101), null);
  assert.deepEqual([56, 97, 4663, 46630].map((id) => evmNativeLaunchQuote(id).provider.displayName), ["BNB", "BNB", "Robinhood", "Robinhood"]);
  assert.equal(providerLabel({ chainId: "56", provider: { key: "bnb-basic" } }), "BNB");
  assert.equal(providerLabel({ chainId: "4663", provider: { key: "robinhood-basic" } }), "Robinhood");
  assert.equal(providerLabel({ chainId: "1", provider: { key: "x", displayName: "Other" } }), "Other");
});

test("wallet chain guard and share card label DogeOS, existing chains unchanged", () => {
  assert.equal(walletGuardChainLabel(DOGE), "DogeOS Chikyū Testnet");
  assert.deepEqual(EXISTING.map(walletGuardChainLabel), ["BNB Chain", "BNB testnet", "chain 101", "Robinhood Chain", "Robinhood testnet"]);
  assert.equal(tokenShareChainLabel(DOGE), "DOGEOS");
  assert.deepEqual(EXISTING.map(tokenShareChainLabel), ["BNB CHAIN", "BNB CHAIN", "SOLANA", "ROBINHOOD", "ROBINHOOD"]);
});

test("EVM launchpad safety presentation has a DogeOS block that never says BNB or Robinhood", () => {
  const p = getEvmLaunchpadPresentation(DOGE);
  assert.equal(p.chainLabel, "DogeOS Chikyū Testnet");
  assert.equal(p.nativeSymbol, "DOGE");
  assert.equal(p.walletLabel, "EVM wallet");
  assert.equal(p.graduationLabel, "MuchFi graduation");
  assert.equal(p.isBnb, false);
  assert.equal(p.isRobinhood, false);
  assert.equal(p.isDogeos, true);
  for (const value of Object.values(p)) {
    if (typeof value === "string") assert.doesNotMatch(value, FOREIGN, value);
  }
  assert.equal(isBnbEvmLaunchpadChain(DOGE), false);
  assert.equal(isRobinhoodEvmLaunchpadChain(DOGE), false);

  const readiness = { chainId: DOGE, ready: false, items: [{ key: "launchFactory", required: true, ready: false }], missingRequired: [{ key: "launchFactory" }] };
  for (const hasAccount of [false, true]) {
    const status = buildEvmLaunchpadSafetyStatus({ chainId: DOGE, walletChainId: DOGE, hasAccount, hasSigner: hasAccount, factoryAddress: "0x1", contractReadiness: readiness });
    const text = JSON.stringify(status);
    assert.doesNotMatch(text, /BNB|Robinhood|Topaz/, text);
    const network = status.checks.find((c) => c.id === "network");
    assert.match(network.detail, /DogeOS Chikyū Testnet \(chain 6281971\)\. Gas is paid in DOGE\./);
    assert.ok(status.checks.every((c) => c.id !== "topazContracts"));
  }
});

test("EVM launchpad safety presentation: existing chains unchanged", () => {
  const pick = (p) => [p.chainLabel, p.nativeSymbol, p.walletLabel, p.graduationLabel, p.isBnb, p.isRobinhood, "isDogeos" in p];
  assert.deepEqual(pick(getEvmLaunchpadPresentation(56)), ["BNB Smart Chain", "BNB", "BNB-compatible wallet", "Topaz graduation", true, false, false]);
  assert.deepEqual(pick(getEvmLaunchpadPresentation(97)), ["BNB Testnet", "BNB", "BNB-compatible wallet", "Topaz graduation", true, false, false]);
  assert.deepEqual(pick(getEvmLaunchpadPresentation(4663)), ["Robinhood Chain", "ETH", "EVM wallet", "Robinhood graduation", false, true, false]);
  assert.deepEqual(pick(getEvmLaunchpadPresentation(46630)), ["Robinhood Chain Testnet", "ETH", "EVM wallet", "Robinhood graduation", false, true, false]);
  assert.throws(() => getEvmLaunchpadPresentation(101), /Unsupported EVM launchpad chain 101/);
  const readiness = { chainId: 97, ready: true, items: [], missingRequired: [] };
  const bnb = buildEvmLaunchpadSafetyStatus({ chainId: 97, walletChainId: 97, hasAccount: false, hasSigner: false, factoryAddress: "0x1", contractReadiness: readiness });
  assert.equal(bnb.checks.find((c) => c.id === "network").detail, "Connect a BNB-compatible wallet on BNB Testnet (chain 97).");
  assert.equal(bnb.checks.find((c) => c.id === "signer").detail, "Connect a BNB-compatible wallet to continue.");
  const rh = buildEvmLaunchpadSafetyStatus({ chainId: 46630, walletChainId: 46630, hasAccount: true, hasSigner: true, factoryAddress: "0x1", contractReadiness: { ...readiness, chainId: 46630 } });
  assert.equal(rh.checks.find((c) => c.id === "network").detail, "Wallet connected to Robinhood Chain Testnet (chain 46630). Gas is paid in ETH.");
});

test("home feed: DOGE, DogeOS label and MuchFi; existing chains unchanged", async () => {
  const h = await loadHarness();
  assert.equal(h.nativeSymbolFor(DOGE), "DOGE");
  assert.equal(h.chainNameFor(DOGE), "DogeOS");
  assert.equal(h.dexNameFor(DOGE), "MuchFi");
  assert.equal(h.formatNative(2.5, DOGE), "2.5 DOGE");
  const all = [...EXISTING, 102];
  assert.deepEqual(all.map(h.nativeSymbolFor), ["BNB", "BNB", "SOL", "ETH", "ETH", "SOL"]);
  assert.deepEqual(all.map(h.chainNameFor), ["BNB", "BNB", "Solana", "Robinhood", "Robinhood", "Solana"]);
  assert.deepEqual(all.map(h.dexNameFor), ["Topaz", "Topaz", "Meteora", "Uniswap", "Uniswap", "Meteora"]);
});

test("reward and claim symbols: DOGE for DogeOS, never the BNB fallback; existing chains unchanged", async () => {
  const h = await loadHarness();
  assert.equal(h.nativeSymbolForChain(DOGE, null), "DOGE");
  assert.equal(h.nativeSymbolForChain(DOGE, "BNB"), "DOGE");
  assert.deepEqual(EXISTING.map((id) => h.nativeSymbolForChain(id, "X")), ["BNB", "BNB", "SOL", "ETH", "ETH"]);
  assert.equal(h.nativeSymbolForChain(1, "X"), "X");
  assert.equal(h.nativeSymbolForChain(1, null), "BNB");
  assert.equal(h.rewardNativeSymbol(DOGE), "DOGE");
  assert.equal(h.rewardChainLabel(DOGE), "DogeOS");
  assert.deepEqual(EXISTING.map(h.rewardNativeSymbol), ["BNB", "BNB", "SOL", "ETH", "ETH"]);
  assert.deepEqual(EXISTING.map(h.rewardChainLabel), ["BNB", "BNB", "Solana", "Robinhood", "Robinhood"]);
});

test("explorers point DogeOS at L2Scan; existing chains unchanged", async () => {
  const h = await loadHarness();
  const L2SCAN = "https://dogeos-testnet.l2scan.co";
  assert.equal(h.profileExplorerBase(DOGE), L2SCAN);
  assert.equal(h.publicProfileExplorerBase(DOGE), L2SCAN);
  assert.equal(h.tokenDetailsExplorerBase(DOGE), L2SCAN);
  assert.equal(h.chartExplorerTxUrl(DOGE, "0xabc"), `${L2SCAN}/tx/0xabc`);

  assert.deepEqual([56, 97, 101, 102, 4663, 46630, 1].map(h.profileExplorerBase), [
    "https://bscscan.com", "https://testnet.bscscan.com", "https://explorer.solana.com", "https://explorer.solana.com",
    "https://robinhoodchain.blockscout.com", "https://explorer.testnet.chain.robinhood.com", "",
  ]);
  assert.deepEqual([56, 97, 101, 102, 4663, 46630, 1].map(h.publicProfileExplorerBase), [
    "https://bscscan.com", "https://testnet.bscscan.com", "https://explorer.solana.com", "https://explorer.solana.com",
    "https://explorer.chain.robinhood.com", "https://explorer.testnet.chain.robinhood.com", "https://bscscan.com",
  ]);
  assert.deepEqual([56, 97, 101, 4663, 46630, 1].map(h.tokenDetailsExplorerBase), [
    "https://bscscan.com", "https://testnet.bscscan.com", "https://explorer.solana.com",
    "https://explorer.chain.robinhood.com", "https://explorer.testnet.chain.robinhood.com", "https://bscscan.com",
  ]);
  assert.deepEqual([56, 97, 4663, 46630].map((id) => h.chartExplorerTxUrl(id, "0xabc")), [
    "https://bscscan.com/tx/0xabc", "https://testnet.bscscan.com/tx/0xabc",
    "https://explorer.chain.robinhood.com/tx/0xabc", "https://explorer.testnet.chain.robinhood.com/tx/0xabc",
  ]);
  assert.equal(h.chartExplorerTxUrl(101, "sig"), "https://explorer.solana.com/tx/sig");
});

test("feed cards, ticker, drafts, profile, upvote and creator protection: DogeOS branches; existing chains unchanged", async () => {
  const h = await loadHarness();
  assert.equal(h.feedChainLabel(DOGE), "DogeOS");
  assert.equal(h.feedNativeSymbol(DOGE), "DOGE");
  assert.deepEqual([...EXISTING, 102, 1].map(h.feedChainLabel), ["BNB", "BNB", "Solana", "Robinhood", "Robinhood", "Solana", null]);
  assert.deepEqual([...EXISTING, 102, 1].map(h.feedNativeSymbol), ["BNB", "BNB", "SOL", "ETH", "ETH", "SOL", "BNB"]);

  // The ticker bar and the creator-protection dialog price in getNativeSymbol directly.
  assert.equal(h.getNativeSymbol(DOGE), "DOGE");
  assert.deepEqual(EXISTING.map(h.getNativeSymbol), ["BNB", "BNB", "SOL", "ETH", "ETH"]);

  assert.equal(h.draftChainLabel(DOGE), "DogeOS");
  assert.deepEqual(EXISTING.map(h.draftChainLabel), ["BNB", "BNB", "Solana", "Robinhood", "Robinhood"]);
  const bnbBadge = h.draftChainBadgeClass(56);
  assert.equal(bnbBadge, "border-amber-400/60 bg-amber-400/10 text-amber-300");
  assert.equal(h.draftChainBadgeClass(97), bnbBadge);
  assert.equal(h.draftChainBadgeClass(101), "border-violet-400/60 bg-violet-400/10 text-violet-300");
  assert.equal(h.draftChainBadgeClass(4663), "border-sky-400/60 bg-sky-400/10 text-sky-300");
  assert.equal(h.draftChainBadgeClass(46630), "border-sky-400/60 bg-sky-400/10 text-sky-300");
  const dogeBadge = h.draftChainBadgeClass(DOGE);
  for (const id of EXISTING) assert.notEqual(dogeBadge, h.draftChainBadgeClass(id), String(id));

  assert.equal(h.profileNativeSymbol(DOGE), "DOGE");
  assert.deepEqual([56, 97, 4663, 46630].map(h.profileNativeSymbol), ["BNB", "BNB", "ETH", "ETH"]);

  assert.equal(h.upvoteNativeUnit(DOGE, false), "DOGE");
  assert.equal(h.upvoteNetworkLabel(DOGE), "DogeOS");
  assert.deepEqual([56, 97, 4663, 46630].map((id) => h.upvoteNativeUnit(id, false)), ["BNB", "BNB", "ETH", "ETH"]);
  assert.equal(h.upvoteNativeUnit(101, true), "SOL");
  assert.equal(h.upvoteNativeUnit(101, false), "BNB", "an EVM vote on a Solana-routed chain id keeps its old BNB unit");
  assert.deepEqual([56, 97, 4663, 46630].map(h.upvoteNetworkLabel), ["BNB", "BNB", "Robinhood", "Robinhood"]);
});

test("pages and components import the chain helpers instead of exporting their own (Fast Refresh)", async () => {
  const files = {
    "components/feed/FeedCards.tsx": ["chainLabel", "nativeSymbol"],
    "components/home/CampaignTickerBar.tsx": ["nativeTickerSymbol"],
    "components/home/DraftCampaignGrid.tsx": ["draftChainLabel", "draftChainBadgeClass"],
    "components/token/CreatorProtectionDialog.tsx": ["creatorProtectionNativeSymbol"],
    "components/token/UnifiedMarketChart.tsx": ["explorerTxUrl"],
    "components/token/UpvoteDialog.tsx": ["upvoteNativeUnit", "upvoteNetworkLabel"],
    "pages/PublicProfile.tsx": ["getExplorerBase"],
    "pages/TokenDetails.tsx": ["getExplorerBase", "evmPageNativeUnit", "evmPageDexVenueLabel"],
    "pages/command-center/CommandCenterClaims.tsx": ["rewardNativeSymbol", "rewardChainLabel"],
  };
  for (const [file, names] of Object.entries(files)) {
    const source = await readFile(path.join(srcRoot, file), "utf8");
    for (const name of names) {
      assert.doesNotMatch(source, new RegExp(`^(export )?function ${name}\\(`, "m"), `${file} defines ${name}`);
    }
  }
  assert.ok(
    (await readFile(path.join(srcRoot, "components/home/CampaignTickerBar.tsx"), "utf8")).includes("const symbol = getNativeSymbol(chainId);"),
  );
  assert.ok(
    (await readFile(path.join(srcRoot, "components/token/CreatorProtectionDialog.tsx"), "utf8")).includes("return getNativeSymbol(Number(getActiveChainId()));"),
  );
});

test("token page: DOGE native unit and MuchFi venue for DogeOS; existing chains unchanged", async () => {
  const h = await loadHarness();
  assert.equal(h.evmPageNativeUnit(DOGE), "DOGE");
  assert.equal(h.evmPageDexVenueLabel(DOGE), "MuchFi");
  assert.deepEqual([56, 97, 4663, 46630].map(h.evmPageNativeUnit), ["BNB", "BNB", "ETH", "ETH"]);
  assert.deepEqual([56, 97, 4663, 46630].map(h.evmPageDexVenueLabel), ["Topaz", "Topaz", "Uniswap", "Uniswap"]);
});

test("native USD price: DogeOS reads DOGE/USD, never BNB; existing chains unchanged", async () => {
  const h = await loadHarness();
  assert.equal(h.nativeUsdPriceSource(DOGE), "doge");
  assert.deepEqual([...EXISTING, null].map(h.nativeUsdPriceSource), ["bnb", "bnb", "sol", "eth", "eth", "bnb"]);

  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("binance")) return { ok: false, status: 451, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { amount: "0.1234" } }) };
    };
    assert.equal(await h.fetchDogeUsdFromSources(), 0.1234);
    assert.equal(calls[0], "https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT");
    assert.equal(calls[1], "https://api.coinbase.com/v2/prices/DOGE-USD/spot");
    calls.length = 0;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ price: "0.2", dogecoin: { usd: 0.2 } }) };
    };
    assert.equal(await h.fetchDogeUsdFromSources(), 0.2);
    assert.deepEqual(calls, ["https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT"]);
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(h.fetchDogeUsdFromSources(), /DOGE\/USD price unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DBC_QUOTE_MINT,
  DBC_QUOTE_DECIMALS,
  DBC_DEVNET_TEST_TARGET_USD_MICROS,
  DBC_TARGET_USD_MICROS,
  DBC_RESERVE_WHOLE,
  migrationSplitLamports,
  thresholdLamportsFor,
} from "./dbcEconomics.mjs";
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_MAINNET,
  WSOL_MINT,
  NVDAX_MINT,
  enabledQuotes,
  findQuote,
  isNativeQuoteMint,
  nativeQuote,
  quotesForCluster,
  requireEnabledQuote,
  thresholdQuoteRaw,
  quoteScale,
  stableStep,
} from "./dbcQuotes.mjs";

test("SOL is the default and matches today's literals", () => {
  assert.equal(WSOL_MINT, "So11111111111111111111111111111111111111112");
  assert.equal(DBC_QUOTE_MINT, WSOL_MINT);
  assert.equal(DBC_QUOTE_DECIMALS, 9);
  assert.equal(nativeQuote("devnet").mint, WSOL_MINT);
  assert.equal(nativeQuote("mainnet-beta").decimals, 9);
  assert.equal(nativeQuote("solana-mainnet-beta").kind, "native");
  assert.equal(isNativeQuoteMint(DBC_QUOTE_MINT), true);
});

test("registry decimals and program per quote", () => {
  const sol = findQuote("mainnet-beta", WSOL_MINT);
  const usdc = findQuote("mainnet-beta", USDC_MINT_MAINNET);
  const usdt = findQuote("mainnet-beta", USDT_MINT_MAINNET);
  const nvda = findQuote("mainnet-beta", NVDAX_MINT);
  const devUsdc = findQuote("devnet", USDC_MINT_DEVNET);
  assert.equal(sol.decimals, 9);
  assert.equal(sol.tokenProgram.startsWith("Tokenkeg"), true);
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.kind, "stable");
  assert.equal(usdc.enabled, true);
  assert.equal(usdt.decimals, 6);
  assert.equal(usdt.enabled, true);
  assert.equal(devUsdc.mint, USDC_MINT_DEVNET);
  assert.equal(devUsdc.decimals, 6);
  assert.equal(nvda.decimals, 8);
  assert.equal(nvda.kind, "stock");
  assert.equal(nvda.enabled, false);
  assert.equal(nvda.tokenProgram.startsWith("Tokenz"), true);
});

test("7a enabled quotes: SOL + stables; stocks stay off", () => {
  const main = enabledQuotes("mainnet-beta").map((q) => q.symbol).sort();
  assert.deepEqual(main, ["SOL", "USDC", "USDT"]);
  const dev = enabledQuotes("devnet").map((q) => q.symbol).sort();
  assert.deepEqual(dev, ["SOL", "USDC"]);
  assert.throws(() => requireEnabledQuote("mainnet-beta", NVDAX_MINT), /not enabled/);
  assert.throws(() => requireEnabledQuote("devnet", USDC_MINT_MAINNET), /not in the DBC registry/);
});

test("threshold conversion: USDC 6, SOL 9, same dollar target", () => {
  const target = DBC_TARGET_USD_MICROS[15000];
  const solStep = 118_000_000n;
  const sol = nativeQuote("mainnet-beta");
  const usdc = findQuote("mainnet-beta", USDC_MINT_MAINNET);
  const solT = thresholdQuoteRaw(target, sol, solStep);
  assert.equal(solT, thresholdLamportsFor(target, solStep));
  const usdcT = thresholdQuoteRaw(target, usdc);
  assert.equal(usdcT, 15_000n * 1_000_000n);
  assert.equal(quoteScale(usdc), 1_000_000n);
  const testUsdc = thresholdQuoteRaw(DBC_DEVNET_TEST_TARGET_USD_MICROS, findQuote("devnet", USDC_MINT_DEVNET));
  assert.equal(testUsdc, 150n * 1_000_000n);
  const splitSol = migrationSplitLamports(solT);
  const splitUsdc = migrationSplitLamports(usdcT);
  assert.equal(splitSol.poolLamports + splitSol.feeLamports, solT);
  assert.equal(splitUsdc.poolLamports + splitUsdc.feeLamports, usdcT);
  assert.equal(splitSol.creatorGraduationLamports + splitSol.ourGraduationLamports, splitSol.feeLamports);
  assert.equal(splitUsdc.creatorGraduationLamports + splitUsdc.ourGraduationLamports, splitUsdc.feeLamports);
  assert.equal(DBC_RESERVE_WHOLE, 20_000_000n);
  assert.equal(stableStep().stepIndex, 0);
});

test("8-decimal stock scale is listed for 7b (disabled)", () => {
  const nvda = findQuote("mainnet-beta", NVDAX_MINT);
  assert.equal(quoteScale(nvda), 100_000_000n);
  assert.throws(() => thresholdQuoteRaw(DBC_TARGET_USD_MICROS[15000], nvda), /7b/);
});

test("quotesForCluster never drops SOL", () => {
  for (const cluster of ["devnet", "mainnet-beta", "solana-mainnet-beta", ""]) {
    const list = quotesForCluster(cluster);
    assert.equal(list[0].kind, "native");
    assert.equal(list[0].mint, WSOL_MINT);
  }
});

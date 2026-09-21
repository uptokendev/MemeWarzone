import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_SOL_MINT,
  SOLANA_QUOTE_CATALOG_BY_MINT_SQL,
  describeSolanaQuoteAsset,
  loadSolanaQuoteAssetMeta,
  quoteAssetTypeForMint,
} from "../solanaQuoteAssetMeta.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("native SOL needs no catalog row", () => {
  const meta = describeSolanaQuoteAsset({ quoteMint: NATIVE_SOL_MINT, row: null });
  assert.deepEqual(meta, { quoteMint: NATIVE_SOL_MINT, quoteSymbol: "SOL", quoteDecimals: 9, quoteAssetClass: "NATIVE", quoteAssetType: "WRAPPED_NATIVE", quoteDeploymentId: null, quoteReferenceUsd: null });
  assert.equal(quoteAssetTypeForMint(NATIVE_SOL_MINT), "WRAPPED_NATIVE");
  assert.equal(quoteAssetTypeForMint(USDC), "OTHER");
});

test("a catalog stablecoin carries symbol, decimals and the USD reference", () => {
  const meta = describeSolanaQuoteAsset({
    quoteMint: USDC,
    row: { deployment_id: "a2100000-0000-4000-8000-000000000202", symbol: "USDC", asset_class: "stablecoin", decimals: "6", reference_usd_micros: "1000000" },
  });
  assert.equal(meta.quoteSymbol, "USDC");
  assert.equal(meta.quoteDecimals, 6);
  assert.equal(meta.quoteAssetClass, "STABLECOIN");
  assert.equal(meta.quoteAssetType, "OTHER");
  assert.equal(meta.quoteReferenceUsd, 1);
});

test("an unknown mint is still recorded, without symbol or reference", () => {
  const meta = describeSolanaQuoteAsset({ quoteMint: USDC, row: null });
  assert.equal(meta.quoteSymbol, null);
  assert.equal(meta.quoteDecimals, null);
  assert.equal(meta.quoteReferenceUsd, null);
  assert.equal(meta.quoteAssetType, "OTHER");
});

test("loader queries by chain id text and mint, and survives a failing catalog", async () => {
  const calls: unknown[][] = [];
  const db = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [{ symbol: "USDC", decimals: 6 }] }; } };
  const meta = await loadSolanaQuoteAssetMeta(db, { chainId: 101, quoteMint: USDC });
  assert.deepEqual(calls, [["101", USDC]]);
  assert.equal(meta.quoteSymbol, "USDC");
  assert.match(SOLANA_QUOTE_CATALOG_BY_MINT_SQL, /contract_address_or_mint = \$2/);
  const native = await loadSolanaQuoteAssetMeta({ query: async () => { throw new Error("no"); } }, { chainId: 101, quoteMint: NATIVE_SOL_MINT });
  assert.equal(native.quoteSymbol, "SOL");
  const broken = await loadSolanaQuoteAssetMeta({ query: async () => { throw new Error("catalog down"); } }, { chainId: 101, quoteMint: USDC });
  assert.equal(broken.quoteMint, USDC);
  assert.equal(broken.quoteSymbol, null);
});

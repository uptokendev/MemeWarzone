import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NATIVE_SOL_MINT,
  SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL,
  describeSolanaGraduationQuoteBinding,
  loadSolanaCampaignQuoteSelection,
  selectSolanaGraduationOperatorCommand,
} from "../solanaGraduationQuoteBinding.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOL_ID = "a2100000-0000-4000-8000-000000000201";
const USDC_ID = "a2100000-0000-4000-8000-000000000202";

function usdcSelection(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: "draft-1",
    quote_asset_id: USDC_ID,
    policy_version: "1",
    selected_state_version: "3",
    deployment_id: USDC_ID,
    identity_kind: "SOLANA_MINT",
    contract_address_or_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    catalog_state: "ACTIVE",
    symbol: "USDC",
    asset_class: "STABLECOIN",
    ...overrides,
  };
}

test("keeper SQL is byte-identical to the API copy", () => {
  const api = fs.readFileSync(path.resolve(here, "../../../frontend/api/lib/solanaCampaignGraduationQuote.js"), "utf8");
  const start = api.indexOf("export const SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL = `");
  const end = api.indexOf("`;", start);
  const apiSql = api.slice(start + "export const SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL = `".length, end);
  assert.equal(SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL, apiSql);
});

test("no selection is a native campaign; a USDC selection is bound and non-native", () => {
  const native = describeSolanaGraduationQuoteBinding({ selection: null, nativeQuoteConfigId: SOL_ID });
  assert.equal(native.source, "native_default");
  assert.equal(native.native, true);
  assert.equal(native.quoteConfigId, SOL_ID);
  assert.equal(native.quoteMint, NATIVE_SOL_MINT);
  const usdc = describeSolanaGraduationQuoteBinding({ selection: usdcSelection(), nativeQuoteConfigId: SOL_ID });
  assert.equal(usdc.source, "draft_selection");
  assert.equal(usdc.native, false);
  assert.equal(usdc.resolved, true);
  assert.equal(usdc.quoteConfigId, USDC_ID);
  assert.equal(usdc.symbol, "USDC");
  assert.equal(usdc.decimals, 6);
  const sol = describeSolanaGraduationQuoteBinding({ selection: usdcSelection({ quote_asset_id: SOL_ID, deployment_id: SOL_ID, identity_kind: "NATIVE", asset_class: "NATIVE", symbol: "SOL", decimals: 9 }) });
  assert.equal(sol.native, true);
  assert.equal(sol.quoteMint, NATIVE_SOL_MINT);
});

test("dispatch: native -> native command, quote -> quote command, missing quote command blocks", () => {
  const native = describeSolanaGraduationQuoteBinding({ selection: null, nativeQuoteConfigId: SOL_ID });
  const usdc = describeSolanaGraduationQuoteBinding({ selection: usdcSelection() });
  assert.equal(selectSolanaGraduationOperatorCommand({ binding: native, nativeCommand: "node native.mjs", quoteCommand: "node quote.mjs" }).command, "node native.mjs");
  assert.equal(selectSolanaGraduationOperatorCommand({ binding: native, nativeCommand: "", quoteCommand: "node quote.mjs" }).command, "node quote.mjs");
  const quote = selectSolanaGraduationOperatorCommand({ binding: usdc, nativeCommand: "node native.mjs", quoteCommand: "node quote.mjs" });
  assert.equal(quote.command, "node quote.mjs");
  assert.deepEqual(quote.env, {
    SOLANA_GRADUATION_QUOTE_PROFILE: "quote",
    SOLANA_GRADUATION_QUOTE_CONFIG_ID: USDC_ID,
    SOLANA_GRADUATION_QUOTE_SYMBOL: "USDC",
    SOLANA_GRADUATION_QUOTE_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  });
  const blocked = selectSolanaGraduationOperatorCommand({ binding: usdc, nativeCommand: "node native.mjs", quoteCommand: "" });
  assert.equal(blocked.command, null);
  assert.match(String(blocked.reason), /refusing to graduate a USDC campaign/);
  const unresolved = describeSolanaGraduationQuoteBinding({ selection: usdcSelection({ deployment_id: null, symbol: null, asset_class: null, identity_kind: null }) });
  assert.equal(unresolved.resolved, false);
  assert.equal(selectSolanaGraduationOperatorCommand({ binding: unresolved, nativeCommand: "node native.mjs", quoteCommand: "node quote.mjs" }).command, null);
});

test("loader passes chain id and trimmed campaign address", async () => {
  const calls: unknown[][] = [];
  const db = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [usdcSelection()] }; } };
  const row = await loadSolanaCampaignQuoteSelection(db, { chainId: 101, campaignAddress: " Camp " });
  assert.deepEqual(calls, [[101, "Camp"]]);
  assert.equal(row?.symbol, "USDC");
  assert.equal(await loadSolanaCampaignQuoteSelection(db, { chainId: 101, campaignAddress: "" }), null);
});

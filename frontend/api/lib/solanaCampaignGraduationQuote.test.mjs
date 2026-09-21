import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_SOL_MINT,
  SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL,
  SolanaGraduationQuoteBindingError,
  decideSolanaGraduationQuoteConfigId,
  describeSolanaGraduationQuoteBinding,
  resolveSolanaCampaignGraduationQuote,
  selectSolanaGraduationOperatorCommand,
  solanaGraduationOperatorEnv,
} from "./solanaCampaignGraduationQuote.js";

const SOL_ID = "a2100000-0000-4000-8000-000000000201";
const USDC_ID = "a2100000-0000-4000-8000-000000000202";

function usdcSelection(overrides = {}) {
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

test("no selection: native default binding", () => {
  const binding = describeSolanaGraduationQuoteBinding({ selection: null, nativeQuoteConfigId: SOL_ID });
  assert.equal(binding.source, "native_default");
  assert.equal(binding.native, true);
  assert.equal(binding.quoteConfigId, SOL_ID);
  assert.equal(binding.quoteMint, NATIVE_SOL_MINT);
  assert.equal(binding.symbol, "SOL");
  assert.equal(binding.decimals, 9);
  assert.equal(describeSolanaGraduationQuoteBinding({ selection: null }).quoteConfigId, null);
});

test("USDC selection: bound, non-native, carries mint and decimals", () => {
  const binding = describeSolanaGraduationQuoteBinding({ selection: usdcSelection(), nativeQuoteConfigId: SOL_ID });
  assert.equal(binding.source, "draft_selection");
  assert.equal(binding.native, false);
  assert.equal(binding.resolved, true);
  assert.equal(binding.quoteConfigId, USDC_ID);
  assert.equal(binding.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(binding.symbol, "USDC");
  assert.equal(binding.decimals, 6);
  assert.equal(binding.draftId, "draft-1");
  assert.equal(binding.selectedStateVersion, 3);
});

test("explicit SOL selection is native and keeps the catalog id", () => {
  const binding = describeSolanaGraduationQuoteBinding({
    selection: usdcSelection({ quote_asset_id: SOL_ID.toUpperCase(), deployment_id: SOL_ID, identity_kind: "NATIVE", contract_address_or_mint: "native:101", decimals: 9, symbol: "SOL", asset_class: "NATIVE" }),
  });
  assert.equal(binding.native, true);
  assert.equal(binding.quoteConfigId, SOL_ID);
  assert.equal(binding.quoteMint, NATIVE_SOL_MINT);
});

test("selection pointing at a deployment the catalog no longer has is unresolved", () => {
  const binding = describeSolanaGraduationQuoteBinding({
    selection: usdcSelection({ deployment_id: null, identity_kind: null, contract_address_or_mint: null, decimals: null, symbol: null, asset_class: null }),
  });
  assert.equal(binding.resolved, false);
  assert.equal(binding.native, false);
  assert.equal(binding.quoteMint, null);
  assert.throws(() => decideSolanaGraduationQuoteConfigId({ requestedConfigId: "", binding }), (error) => error instanceof SolanaGraduationQuoteBindingError && error.code === "SOLANA_GRADUATION_QUOTE_BINDING_UNRESOLVED");
  assert.equal(selectSolanaGraduationOperatorCommand({ binding, nativeCommand: "node native.mjs", quoteCommand: "node quote.mjs" }).command, null);
});

test("bound campaign: the selection wins, a different request is refused", () => {
  const binding = describeSolanaGraduationQuoteBinding({ selection: usdcSelection() });
  assert.equal(decideSolanaGraduationQuoteConfigId({ requestedConfigId: "", binding }), USDC_ID);
  assert.equal(decideSolanaGraduationQuoteConfigId({ requestedConfigId: USDC_ID.toUpperCase(), binding }), USDC_ID);
  assert.throws(
    () => decideSolanaGraduationQuoteConfigId({ requestedConfigId: SOL_ID, binding }),
    (error) => error instanceof SolanaGraduationQuoteBindingError && error.code === "SOLANA_GRADUATION_QUOTE_BINDING_MISMATCH" && error.httpStatus === 409,
  );
});

test("unbound campaign: request, then native default, then a 400", () => {
  const withDefault = describeSolanaGraduationQuoteBinding({ selection: null, nativeQuoteConfigId: SOL_ID });
  assert.equal(decideSolanaGraduationQuoteConfigId({ requestedConfigId: USDC_ID, binding: withDefault }), USDC_ID);
  assert.equal(decideSolanaGraduationQuoteConfigId({ requestedConfigId: "", binding: withDefault }), SOL_ID);
  const withoutDefault = describeSolanaGraduationQuoteBinding({ selection: null });
  assert.throws(() => decideSolanaGraduationQuoteConfigId({ requestedConfigId: "", binding: withoutDefault }), (error) => error.httpStatus === 400);
});

test("operator dispatch: native campaigns use the native command, quote campaigns need the quote command", () => {
  const nativeBinding = describeSolanaGraduationQuoteBinding({ selection: null, nativeQuoteConfigId: SOL_ID });
  const usdcBinding = describeSolanaGraduationQuoteBinding({ selection: usdcSelection() });
  assert.deepEqual(selectSolanaGraduationOperatorCommand({ binding: nativeBinding, nativeCommand: "node native.mjs", quoteCommand: "node quote.mjs" }), {
    command: "node native.mjs",
    env: { SOLANA_GRADUATION_QUOTE_PROFILE: "native", SOLANA_GRADUATION_QUOTE_CONFIG_ID: SOL_ID, SOLANA_GRADUATION_QUOTE_SYMBOL: "SOL", SOLANA_GRADUATION_QUOTE_MINT: NATIVE_SOL_MINT },
  });
  assert.equal(selectSolanaGraduationOperatorCommand({ binding: nativeBinding, nativeCommand: "", quoteCommand: "node quote.mjs" }).command, "node quote.mjs");
  assert.equal(selectSolanaGraduationOperatorCommand({ binding: nativeBinding, nativeCommand: "", quoteCommand: "" }).command, null);
  const usdc = selectSolanaGraduationOperatorCommand({ binding: usdcBinding, nativeCommand: "node native.mjs", quoteCommand: "node quote.mjs" });
  assert.equal(usdc.command, "node quote.mjs");
  assert.equal(usdc.env.SOLANA_GRADUATION_QUOTE_PROFILE, "quote");
  assert.equal(usdc.env.SOLANA_GRADUATION_QUOTE_CONFIG_ID, USDC_ID);
  const refused = selectSolanaGraduationOperatorCommand({ binding: usdcBinding, nativeCommand: "node native.mjs", quoteCommand: "" });
  assert.equal(refused.command, null);
  assert.match(refused.reason, /refusing to graduate a USDC campaign with the native operator/);
  assert.deepEqual(solanaGraduationOperatorEnv(describeSolanaGraduationQuoteBinding({ selection: null })), { SOLANA_GRADUATION_QUOTE_PROFILE: "native", SOLANA_GRADUATION_QUOTE_SYMBOL: "SOL", SOLANA_GRADUATION_QUOTE_MINT: NATIVE_SOL_MINT });
});

test("resolver queries by chain and campaign address and reads the newest selection", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [usdcSelection()] }; } };
  const binding = await resolveSolanaCampaignGraduationQuote(db, { chainId: "101", campaignAddress: " CampaignPda ", nativeQuoteConfigId: SOL_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL);
  assert.deepEqual(calls[0].params, [101, "CampaignPda"]);
  assert.match(calls[0].sql, /order by s\.updated_at desc\s+limit 1/);
  assert.equal(binding.quoteConfigId, USDC_ID);
  const empty = await resolveSolanaCampaignGraduationQuote({ query: async () => ({ rows: [] }) }, { chainId: 101, campaignAddress: "x", nativeQuoteConfigId: SOL_ID });
  assert.equal(empty.source, "native_default");
  const skipped = await resolveSolanaCampaignGraduationQuote({ query: async () => { throw new Error("must not query"); } }, { chainId: 101, campaignAddress: "", nativeQuoteConfigId: SOL_ID });
  assert.equal(skipped.source, "native_default");
});

import assert from "node:assert/strict";
import test from "node:test";
import { catalogQuoteSelectionReference, isStaleOrDisabledCatalogQuote } from "./draftGraduationQuoteSelection.js";

function item(overrides = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    chainId: "56",
    stateVersion: 4,
    newGraduationEligible: true,
    adminState: "enabled",
    policy: { version: 2, policyKey: "bnb-native-basic" },
    ...overrides,
  };
}

test("draft selection is a catalog reference: id, selected state version, policy version", () => {
  const reference = catalogQuoteSelectionReference(item(), 56);
  assert.deepEqual(reference, {
    quoteAssetId: "22222222-2222-2222-2222-222222222222",
    chainId: 56,
    selectedStateVersion: 4,
    policyVersion: "2",
  });
  assert.equal("quoteContractOrMint" in reference, false);
  assert.equal("provider" in reference, false);
});

test("persist rejects presentation defaults and missing catalog ids", () => {
  assert.throws(() => catalogQuoteSelectionReference({ ...item(), presentationDefault: true }, 56), /catalog quote asset/);
  assert.throws(() => catalogQuoteSelectionReference({ ...item(), id: "" }, 56), /id is required/);
});

test("stale or disabled catalog quotes cannot be stored as a new selection", () => {
  assert.throws(() => catalogQuoteSelectionReference(item({ newGraduationEligible: false }), 56), /not eligible/);
  assert.equal(isStaleOrDisabledCatalogQuote(item({ newGraduationEligible: false })), true);
  assert.equal(isStaleOrDisabledCatalogQuote(item({ adminState: "disabled" })), true);
  assert.equal(isStaleOrDisabledCatalogQuote(item()), false);
});

test("catalog chain must match the draft chain", () => {
  assert.throws(() => catalogQuoteSelectionReference(item({ chainId: "101" }), 56), /does not match this draft chain/);
});

test("Robinhood stock compatibility ids are stored as catalog references, not copied addresses", () => {
  const reference = catalogQuoteSelectionReference(item({
    id: "rh-stock:33333333-3333-3333-3333-333333333333",
    chainId: "4663",
    contractAddressOrMint: "0x1111111111111111111111111111111111111111",
    provider: { key: "robinhood-stock-token" },
    policy: { version: 9, authority: "delegated" },
    stateVersion: 9,
  }), 4663);
  assert.equal(reference.quoteAssetId, "rh-stock:33333333-3333-3333-3333-333333333333");
  assert.equal(reference.policyVersion, "9");
  assert.equal(reference.selectedStateVersion, 9);
});

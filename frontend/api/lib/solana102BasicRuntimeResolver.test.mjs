import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  APPROVED_QUOTE_CATALOG,
  assertManifestIdentity,
  candidateCanActivate,
  filterCreatorGraduationAssets,
  findManifestAsset,
} from "./approvedQuoteCatalog.js";

const legacy = {
  chainId: "102",
  provider: { key: "solana-basic", displayName: "Solana BASIC" },
  contractAddressOrMint: "native:102",
  symbol: "SOL",
  displayName: "Legacy Solana",
  assetClass: "NATIVE",
  newGraduationEligible: true,
  adminState: "enabled",
  proposedState: "ACTIVE",
  identity: "VERIFIED",
  transferability: "VERIFIED",
  security: "VERIFIED",
  route: "VERIFIED",
  price: "VERIFIED",
  lp: "VERIFIED",
  lastVerifiedAt: "2099-01-01T00:00:00.000Z",
};

test("legacy Solana 102 cannot become selectable or routable even with forged-positive runtime flags", () => {
  assert.equal(filterCreatorGraduationAssets([legacy]).length, 0);
  assert.equal(findManifestAsset({ chainId: 102, provider: "solana-basic", address: "native:102" }), null);
  assert.throws(
    () => assertManifestIdentity({ chainId: 102, provider: "solana-basic", address: "native:102", expectedChainId: 102, expectedProvider: "solana-basic" }),
    /LEGACY_SOLANA_CHAIN_NOT_CURRENT_AUTHORITY/,
  );
  assert.equal(candidateCanActivate(legacy, { now: Date.parse("2026-09-12T10:00:00.000Z") }), false);
  assert.equal(APPROVED_QUOTE_CATALOG.assets.some((asset) => String(asset.chainId) === "102" && asset.proposedState === "ACTIVE"), false);
});

test("database BASIC authority permanently disables 102 approval and graduation authorization", () => {
  const sql = fs.readFileSync(new URL("../../supabase/migrations/20260911210000_disable_legacy_solana_102_basic_quotes.sql", import.meta.url), "utf8");
  assert.match(sql, /d\.chain_id = '102'/);
  assert.match(sql, /policy_status = 'retired'/);
  assert.match(sql, /basic_approved = false/);
  assert.match(sql, /new_graduation_enabled = false/);
  assert.match(sql, /admin_state = 'disabled'/);
  assert.match(sql, /existing_market_support = false/);
  assert.match(sql, /check \(chain_id <> '102' or admin_state = 'disabled'\)/);
  assert.match(sql, /raise exception 'legacy Solana chain 102 remains routable in BASIC quote catalog'/);
});

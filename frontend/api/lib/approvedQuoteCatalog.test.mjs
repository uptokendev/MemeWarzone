import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const {
  APPROVED_QUOTE_CATALOG,
  assertManifestIdentity,
  candidateCanActivate,
  filterCreatorGraduationAssets,
  findManifestAsset,
  quoteIdentityKey,
  summarizeCandidateInventory,
} = await import("./approvedQuoteCatalog.js");

test("launch inventory meets researched breadth without manufacturing ACTIVE status", () => {
  const summary = summarizeCandidateInventory();
  assert.ok(summary["56"].researched >= 20);
  assert.ok(summary["101"].researched >= 20);
  assert.ok(summary["4663"].researched >= 30);
  assert.equal(summary["101"].activeSnapshot, 2);
  assert.equal(summary["56"].activeSnapshot, 0);
});

test("identity includes chain, provider and exact contract/mint rather than symbol", () => {
  const solPyth = findManifestAsset({ chainId: 101, provider: "pyth", address: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" });
  const bnbPyth = findManifestAsset({ chainId: 56, provider: "pyth", address: "0xb0188B0bb2cD4a6D2744637fC83C94a284B247Da" });
  assert.equal(solPyth.symbol, "PYTH");
  assert.equal(bnbPyth.symbol, "PYTH");
  assert.notEqual(
    quoteIdentityKey({ chainId: solPyth.chainId, provider: solPyth.provider, address: solPyth.address }),
    quoteIdentityKey({ chainId: bnbPyth.chainId, provider: bnbPyth.provider, address: bnbPyth.address }),
  );
});

test("wrong-chain and provider mismatch fail closed", () => {
  assert.throws(
    () => assertManifestIdentity({ chainId: 56, provider: "solana-basic", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", expectedChainId: 101, expectedProvider: "solana-basic" }),
    /WRONG_CHAIN_QUOTE_IDENTITY/,
  );
  assert.throws(
    () => assertManifestIdentity({ chainId: 101, provider: "xstocks", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", expectedChainId: 101, expectedProvider: "solana-basic" }),
    /QUOTE_PROVIDER_MISMATCH/,
  );
});

test("stale security/identity evidence and admin suspension prevent activation", () => {
  const active = {
    adminState: "enabled",
    proposedState: "ACTIVE",
    identity: "VERIFIED",
    transferability: "VERIFIED",
    security: "VERIFIED",
    route: "VERIFIED",
    price: "VERIFIED",
    lp: "VERIFIED",
    lastVerifiedAt: "2026-09-07T12:00:00.000Z",
  };
  assert.equal(candidateCanActivate(active, { now: Date.parse("2026-09-07T13:00:00.000Z") }), true);
  assert.equal(candidateCanActivate(active, { now: Date.parse("2026-09-09T13:00:00.000Z") }), false);
  assert.equal(candidateCanActivate({ ...active, adminState: "disabled" }, { now: Date.parse("2026-09-07T13:00:00.000Z") }), false);
  assert.equal(candidateCanActivate({ ...active, security: "PENDING" }, { now: Date.parse("2026-09-07T13:00:00.000Z") }), false);
});

test("creator catalog never emits pending, rejected, or existing-market-only assets", () => {
  const items = [
    { chainId: "101", provider: { key: "solana-basic", displayName: "Solana BASIC" }, contractAddressOrMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", displayName: "USD Coin", assetClass: "STABLECOIN", newGraduationEligible: true },
    { chainId: "56", provider: { key: "bnb-native", displayName: "BNB" }, contractAddressOrMint: "native:56", symbol: "BNB", displayName: "BNB", assetClass: "NATIVE", newGraduationEligible: false, existingMarketSupport: true },
    { chainId: "101", provider: { key: "xstocks", displayName: "xStocks" }, contractAddressOrMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", symbol: "AAPLx", displayName: "Apple xStock", assetClass: "PUBLIC_RWA", newGraduationEligible: false },
  ];
  const publicItems = filterCreatorGraduationAssets(items);
  assert.deepEqual(publicItems.map((item) => item.symbol), ["USDC"]);
  assert.equal(publicItems[0].category, "STABLES_CURRENCIES");
  assert.equal(filterCreatorGraduationAssets(items, { search: "usd" }).length, 1);
  assert.equal(filterCreatorGraduationAssets(items, { category: "CORE" }).length, 0);
});

test("existing #216 Solana BASIC identifiers remain byte-stable in the original migration", () => {
  const migration = fs.readFileSync(new URL("../../supabase/migrations/20260907001000_solana_basic_quote_catalog.sql", import.meta.url), "utf8");
  for (const id of [
    "a2100000-0000-4000-8000-000000000001",
    "a2100000-0000-4000-8000-000000000101",
    "a2100000-0000-4000-8000-000000000102",
    "a2100000-0000-4000-8000-000000000201",
    "a2100000-0000-4000-8000-000000000202",
    "a2100000-0000-4000-8000-000000000301",
    "a2100000-0000-4000-8000-000000000302",
  ]) assert.match(migration, new RegExp(id));
});

test("Robinhood Stock candidates remain delegated inventory, never static activation authority", () => {
  const stocks = APPROVED_QUOTE_CATALOG.assets.filter((asset) => asset.provider === "robinhood-stock-token");
  assert.ok(stocks.length >= 30);
  assert.ok(stocks.every((asset) => asset.proposedState === "IDENTITY_VERIFIED"));
  assert.ok(stocks.every((asset) => asset.newGraduationEligibility === false));
  assert.ok(stocks.every((asset) => asset.route === "DELEGATED_RUNTIME"));
});

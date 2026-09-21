import assert from "node:assert/strict";
import test from "node:test";

import {
  applyQuoteCatalogSync,
  isActiveEligible,
  legacyStatuses,
  manifestIdentity,
  planQuoteCatalogSync,
  policyConfigFor,
} from "./quoteAssetCatalogSync.js";
import { APPROVED_QUOTE_CATALOG } from "./approvedQuoteCatalog.js";

const manifest = {
  chains: { 101: { family: "SOLANA" }, 56: { family: "EVM" }, 4663: { family: "EVM" } },
  assets: [
    { chainId: "101", provider: "solana-basic", providerAssetId: "sol-native", symbol: "SOL", displayName: "Solana", address: "native:101", decimals: 9, assetClass: "NATIVE", category: "CORE", canonicalStatus: "IDENTITY_VERIFIED", nativeWrappedStatus: "NATIVE_WRAPPED_PATH", identity: "VERIFIED", transferability: "VERIFIED", security: "VERIFIED", route: "VERIFIED", price: "VERIFIED", lp: "VERIFIED", newGraduationEligibility: true, existingMarketSupport: true, adminState: "enabled", proposedState: "ACTIVE", evidence: ["repo:seed"], lastVerifiedAt: "2026-09-07T00:10:00.000Z" },
    { chainId: "101", provider: "xstocks", providerAssetId: "NVDAx", symbol: "NVDAx", displayName: "NVIDIA xStock", address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, assetClass: "PUBLIC_RWA", category: "STOCKS", tags: ["STOCK"], canonicalStatus: "IDENTITY_VERIFIED", nativeWrappedStatus: "CANONICAL", identity: "VERIFIED", transferability: "VERIFIED", security: "PENDING", route: "PENDING", price: "PENDING", lp: "PENDING", newGraduationEligibility: false, existingMarketSupport: false, adminState: "enabled", proposedState: "ROUTE_PENDING", evidence: ["https://xstocks.com/products"], lastVerifiedAt: "2026-09-07T21:55:00.000Z" },
    { chainId: "56", provider: "binance-peg", providerAssetId: "USDT", symbol: "USDT", displayName: "Tether USD", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18, assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", canonicalStatus: "IDENTITY_VERIFIED", nativeWrappedStatus: "CANONICAL", identity: "VERIFIED", transferability: "VERIFIED", security: "PENDING", route: "PENDING", price: "PENDING", lp: "PENDING", newGraduationEligibility: false, existingMarketSupport: false, adminState: "enabled", proposedState: "ROUTE_PENDING", evidence: [], lastVerifiedAt: null },
    { chainId: "4663", provider: "robinhood-stock-token", providerAssetId: "CRM", symbol: "CRM", displayName: "Salesforce Stock Token", address: "0xd95B44124e475743a7589e68F3D74008A5536D44", decimals: 18, assetClass: "PUBLIC_RWA", category: "STOCKS", identity: "VERIFIED", transferability: "VERIFIED", security: "DELEGATED_RUNTIME", route: "DELEGATED_RUNTIME", price: "DELEGATED_RUNTIME", lp: "DELEGATED_RUNTIME", newGraduationEligibility: false, existingMarketSupport: false, adminState: "delegated", proposedState: "IDENTITY_VERIFIED", evidence: [], lastVerifiedAt: null },
  ],
};

test("identity normalization per chain family", () => {
  assert.deepEqual(manifestIdentity("SOLANA", "native:101"), { identityKind: "NATIVE", contractAddressOrMint: "native:101", identityKey: "native:101" });
  assert.deepEqual(manifestIdentity("SOLANA", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"), { identityKind: "SOLANA_MINT", contractAddressOrMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", identityKey: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" });
  const evm = manifestIdentity("EVM", "0x55d398326f99059ff775485246999027b3197955");
  assert.equal(evm.identityKind, "EVM_ADDRESS");
  assert.equal(evm.contractAddressOrMint, "0x55d398326f99059fF775485246999027B3197955");
  assert.equal(evm.identityKey, "0x55d398326f99059ff775485246999027b3197955");
  assert.throws(() => manifestIdentity("EVM", "0x0000000000000000000000000000000000000000"), /invalid EVM address/);
});

test("legacy tri-state statuses and active eligibility follow the six gates", () => {
  assert.deepEqual(legacyStatuses(manifest.assets[0]), { identity_status: "verified", security_status: "verified", market_health_status: "healthy" });
  assert.deepEqual(legacyStatuses(manifest.assets[1]), { identity_status: "verified", security_status: "pending", market_health_status: "pending" });
  assert.equal(isActiveEligible(manifest.assets[0]), true);
  assert.equal(isActiveEligible(manifest.assets[1]), false);
  assert.equal(isActiveEligible({ ...manifest.assets[0], newGraduationEligibility: false }), false);
});

test("policy config: Solana native vs Jupiter-acquired mint, EVM quote token", () => {
  const sol = policyConfigFor(manifest.assets[0], "SOLANA", manifestIdentity("SOLANA", "native:101"));
  assert.equal(sol.solanaGraduation.quoteMint, "So11111111111111111111111111111111111111112");
  assert.equal(sol.solanaGraduation.acquisitionProgram, "11111111111111111111111111111111");
  assert.equal(sol.solanaGraduation.maxSlippageBps, 0);
  const nvda = policyConfigFor(manifest.assets[1], "SOLANA", manifestIdentity("SOLANA", manifest.assets[1].address));
  assert.equal(nvda.solanaGraduation.quoteMint, manifest.assets[1].address);
  assert.equal(nvda.solanaGraduation.acquisitionProgram, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  assert.equal(nvda.solanaGraduation.decimals, 8);
  assert.equal(nvda.solanaGraduation.referenceUsdMicros, null);
  const usdt = policyConfigFor(manifest.assets[2], "EVM", manifestIdentity("EVM", manifest.assets[2].address));
  assert.equal(usdt.evmGraduation.quoteToken, "0x55d398326f99059fF775485246999027B3197955");
  assert.equal(usdt.evmGraduation.referenceUsdMicros, 1_000_000);
});

test("plan: registry provider skipped, chain filter, active vs draft policies", () => {
  const plan = planQuoteCatalogSync({ manifest, chainIds: ["101", "56", "4663"] });
  assert.deepEqual(plan.providers.map((p) => p.provider_key).sort(), ["binance-peg", "solana-basic", "xstocks"]);
  assert.equal(plan.providers.find((p) => p.provider_key === "xstocks").provider_class, "PROVIDER_RWA");
  assert.deepEqual(plan.assets.map((a) => `${a.provider_key}::${a.asset_key}`), ["solana-basic::sol-native", "xstocks::nvdax", "binance-peg::usdt"]);
  assert.equal(plan.deployments.length, 3);
  const nvda = plan.deployments.find((d) => d.asset_key === "nvdax");
  assert.equal(nvda.identity_kind, "SOLANA_MINT");
  assert.equal(nvda.catalog_state, "ROUTE_PENDING");
  assert.equal(nvda.acquisition_route_status, "PENDING");
  assert.equal(nvda.transferability_status, "VERIFIED");
  assert.equal(nvda.market_health_status, "pending");
  assert.deepEqual(plan.policies.map((p) => [p.asset_key, p.policy_status, p.basic_approved]), [["sol-native", "active", true], ["nvdax", "draft", false], ["usdt", "draft", false]]);
  assert.equal(plan.policies[0].policy_key, "solana-basic-sol-native-101-v1");
  const solanaOnly = planQuoteCatalogSync({ manifest, chainIds: ["101"] });
  assert.equal(solanaOnly.deployments.length, 2);
});

test("the real manifest plans without throwing and never touches the Robinhood registry provider", () => {
  const plan = planQuoteCatalogSync({ manifest: APPROVED_QUOTE_CATALOG, chainIds: ["101", "56", "4663"] });
  assert.ok(plan.deployments.length >= 40, `deployments ${plan.deployments.length}`);
  assert.equal(plan.providers.some((p) => p.provider_key === "robinhood-stock-token"), false);
  assert.equal(plan.policies.filter((p) => p.policy_status === "active").length, 2, "only SOL and USDC on 101 are ACTIVE in the manifest");
  for (const d of plan.deployments) {
    assert.ok(["NATIVE", "SOLANA_MINT", "EVM_ADDRESS"].includes(d.identity_kind));
    assert.ok(["CANDIDATE", "IDENTITY_VERIFIED", "ROUTE_PENDING", "PRICE_PENDING", "LP_PENDING", "ACTIVE", "SUSPENDED", "REJECTED"].includes(d.catalog_state), d.catalog_state);
  }
});

function recorder(state) {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("select id, authority_mode from public.quote_asset_providers")) {
      const row = state.providers.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.quote_asset_providers")) {
      const row = { id: `prov-${params[0]}`, authority_mode: params[2] };
      state.providers.set(params[0], row);
      return { rows: [row] };
    }
    if (sql.startsWith("select id, asset_class, symbol, display_name, category")) {
      const row = state.assets.get(`${params[0]}::${params[1]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.quote_assets")) {
      const row = { id: `asset-${params[1]}`, asset_class: params[2], symbol: params[3], display_name: params[4], category: params[5], tags: params[6], provider_asset_id: params[7] };
      state.assets.set(`${params[0]}::${params[1]}`, row);
      return { rows: [row] };
    }
    if (sql.startsWith("update public.quote_assets")) {
      const row = state.assets.get(`${params[0]}::${params[1]}`);
      Object.assign(row, { asset_class: params[2], symbol: params[3], display_name: params[4], category: params[5], tags: params[6], provider_asset_id: params[7] });
      return { rows: [] };
    }
    if (sql.startsWith("select id, quote_asset_id, identity_kind")) {
      const row = state.deployments.get(`${params[0]}:${params[1]}:${params[2]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.quote_asset_deployments")) {
      const [assetId, providerId, chainId, identityKind, contract, identityKey, decimals, chainFamily, identityStatus, securityStatus, marketHealth, existingSupport, canonical, nativeWrapped, transferability, route, price, lp, catalogState] = params;
      const row = { id: `dep-${identityKey}`, quote_asset_id: assetId, identity_kind: identityKind, contract_address_or_mint: contract, decimals, chain_family: chainFamily, identity_status: identityStatus, security_status: securityStatus, market_health_status: marketHealth, existing_market_support: existingSupport, canonical_status: canonical, native_wrapped_status: nativeWrapped, transferability_status: transferability, acquisition_route_status: route, price_authority_status: price, lp_venue_status: lp, catalog_state: catalogState, state_version: 1 };
      state.deployments.set(`${providerId}:${chainId}:${identityKey}`, row);
      return { rows: [row] };
    }
    if (sql.startsWith("update public.quote_asset_deployments")) {
      const row = [...state.deployments.values()].find((r) => r.id === params[0]);
      Object.assign(row, { identity_kind: params[1], contract_address_or_mint: params[2], decimals: params[3], chain_family: params[4], identity_status: params[5], security_status: params[6], market_health_status: params[7], existing_market_support: params[8], canonical_status: params[9], native_wrapped_status: params[10], transferability_status: params[11], acquisition_route_status: params[12], price_authority_status: params[13], lp_venue_status: params[14], catalog_state: params[15], state_version: row.state_version + 1 });
      return { rows: [] };
    }
    if (sql.startsWith("insert into public.quote_asset_decision_history")) { state.decisions.push(params); return { rows: [] }; }
    if (sql.startsWith("select id, policy_status from public.quote_asset_policy_versions")) {
      const rows = state.policies.filter((p) => p.quote_asset_id === params[0]);
      return { rows: rows.length ? [rows[0]] : [] };
    }
    if (sql.startsWith("insert into public.quote_asset_policy_versions")) {
      state.policies.push({ id: `pol-${params[2]}`, quote_asset_id: params[0], policy_status: params[4] });
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  };
  return { query, calls };
}

function freshState() {
  return { providers: new Map(), assets: new Map(), deployments: new Map(), decisions: [], policies: [] };
}

test("apply: dry run writes nothing; apply inserts everything once; re-run is a no-op", async () => {
  const plan = planQuoteCatalogSync({ manifest, chainIds: ["101", "56"] });
  const state = freshState();
  const dry = recorder(state);
  const dryReport = await applyQuoteCatalogSync(dry.query, plan, { dryRun: true });
  assert.equal(dryReport.dryRun, true);
  assert.equal(dryReport.providers.inserted, 3);
  assert.equal(dry.calls.some((c) => /^\s*(insert|update)/i.test(c.text)), false, "dry run must not write");
  assert.equal(state.providers.size, 0);

  const live = recorder(state);
  const report = await applyQuoteCatalogSync(live.query, plan, { dryRun: false });
  assert.equal(report.providers.inserted, 3);
  assert.equal(report.assets.inserted, 3);
  assert.equal(report.deployments.inserted, 3);
  assert.equal(report.policies.inserted, 3);
  assert.equal(report.decisions, 3);
  assert.equal(state.deployments.size, 3);
  assert.deepEqual(state.policies.map((p) => p.policy_status), ["active", "draft", "draft"]);
  assert.deepEqual(state.decisions.map((d) => d[3]), ["eligible", "review", "review"]);
  assert.equal(state.decisions[0][6], "quote-catalog-sync");

  const again = recorder(state);
  const second = await applyQuoteCatalogSync(again.query, plan, { dryRun: false });
  assert.equal(second.providers.inserted, 0);
  assert.equal(second.assets.inserted + second.assets.updated, 0);
  assert.equal(second.deployments.inserted + second.deployments.updated, 0);
  assert.equal(second.policies.inserted, 0);
  assert.equal(second.policies.existingActive, 1);
  assert.equal(second.policies.existingDraft, 2);
  assert.equal(again.calls.some((c) => /^\s*(insert|update)/i.test(c.text)), false, "unchanged plan must not write");
});

test("apply: a manifest promotion to ACTIVE updates the deployment, records a decision and adds the active policy as version 2", async () => {
  const state = freshState();
  const first = recorder(state);
  await applyQuoteCatalogSync(first.query, planQuoteCatalogSync({ manifest, chainIds: ["101"] }), { dryRun: false });
  const promoted = {
    ...manifest,
    assets: manifest.assets.map((a) => (a.symbol === "NVDAx" ? { ...a, security: "VERIFIED", route: "VERIFIED", price: "VERIFIED", lp: "VERIFIED", proposedState: "ACTIVE", newGraduationEligibility: true } : a)),
  };
  const second = recorder(state);
  const report = await applyQuoteCatalogSync(second.query, planQuoteCatalogSync({ manifest: promoted, chainIds: ["101"] }), { dryRun: false });
  assert.equal(report.deployments.updated, 1);
  assert.equal(report.decisions, 1);
  assert.equal(report.policies.inserted, 1);
  const nvda = [...state.deployments.values()].find((d) => d.identity_kind === "SOLANA_MINT");
  assert.equal(nvda.catalog_state, "ACTIVE");
  assert.equal(nvda.market_health_status, "healthy");
  assert.equal(nvda.state_version, 2);
  const inserted = second.calls.find((c) => c.text.includes("insert into public.quote_asset_policy_versions"));
  assert.equal(inserted.params[3], 2, "active policy goes in as version 2 on top of the draft");
  assert.equal(inserted.params[4], "active");
  assert.equal(state.decisions.at(-1)[3], "eligible");
});

test("apply refuses to sync into a registry-driven provider", async () => {
  const state = freshState();
  state.providers.set("xstocks", { id: "prov-xstocks", authority_mode: "ROBINHOOD_STOCK_REGISTRY" });
  const rec = recorder(state);
  await assert.rejects(() => applyQuoteCatalogSync(rec.query, planQuoteCatalogSync({ manifest, chainIds: ["101"] }), { dryRun: false }), /registry-driven/);
});

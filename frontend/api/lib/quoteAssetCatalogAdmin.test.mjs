import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/test";

const {
  QuoteCatalogAdminError,
  actionPolicyFor,
  buildApprovedPolicyConfig,
  decideQuoteCatalogDeployment,
  mapAdminRow,
  normalizeCandidateInput,
  resolveQuoteCatalogChain,
} = await import("./quoteAssetCatalogAdmin.js");

function adminRow(overrides = {}) {
  return {
    deployment_id: "d1", quote_asset_id: "a1", provider_id: "p1", chain_id: "101", chain_family: "SOLANA", network_cluster: null,
    identity_kind: "SOLANA_MINT", contract_address_or_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", identity_key: "EPjF", decimals: 6,
    identity_status: "verified", security_status: "verified", market_health_status: "healthy", existing_market_support: true,
    deployment_admin_state: "enabled", deployment_state_version: "3", catalog_state: "ACTIVE", canonical_status: "IDENTITY_VERIFIED", native_wrapped_status: "NONE",
    transferability_status: "VERIFIED", acquisition_route_status: "VERIFIED", price_authority_status: "VERIFIED", lp_venue_status: "VERIFIED",
    evidence_sources: ["https://example"], last_scan_at: null, asset_key: "usdc", asset_class: "STABLECOIN", symbol: "USDC", display_name: "USD Coin", logo_url: null,
    category: "STABLES_CURRENCIES", tags: [], provider_asset_id: null, asset_admin_state: "enabled", provider_key: "canonical-stable", provider_display_name: "Canonical Stablecoins",
    authority_mode: "GENERIC_POLICY", provider_class: "STABLECOIN", provider_admin_state: "enabled",
    policy_version_id: "pv1", policy_key: "canonical-stable-usdc-101-v1", policy_version: 1, policy_status: "active", basic_approved: true, new_graduation_enabled: true,
    require_identity_verified: true, require_security_verified: true, require_market_healthy: true, policy_config: { solanaGraduation: { decimals: 6 } },
    ...overrides,
  };
}

test("chains: keys resolve, Solana devnet shares chain 101 with a devnet cluster", () => {
  assert.equal(resolveQuoteCatalogChain("101").cluster, "mainnet-beta");
  assert.equal(resolveQuoteCatalogChain("101:devnet").cluster, "devnet");
  assert.equal(resolveQuoteCatalogChain("97").label, "BNB Smart Chain Testnet");
  assert.equal(resolveQuoteCatalogChain("46630").bondingAsset, "ETH");
  assert.throws(() => resolveQuoteCatalogChain("1"), (error) => error instanceof QuoteCatalogAdminError && error.code === "QUOTE_CATALOG_CHAIN_UNKNOWN");
});

test("candidate input: identities are normalized per family and devnet keys never collide with mainnet", () => {
  const evm = normalizeCandidateInput({ chain: "97", providerKey: "BNB-Native", symbol: "WBNB", assetClass: "native", category: "core", contractAddressOrMint: "0xae13d989dac2f0debff460ac112a837c89baa7cd", decimals: "18", reason: "test" });
  assert.equal(evm.identity.identityKind, "EVM_ADDRESS");
  assert.equal(evm.identity.identityKey, "0xae13d989dac2f0debff460ac112a837c89baa7cd");
  assert.equal(evm.identity.contractAddressOrMint, "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd");
  assert.equal(evm.nativeWrappedStatus, "WRAPPED_NATIVE");
  assert.equal(evm.providerKey, "bnb-native");
  const nativeDevnet = normalizeCandidateInput({ chain: "101:devnet", providerKey: "solana-basic", symbol: "SOL", assetClass: "NATIVE", category: "CORE", contractAddressOrMint: "", decimals: 9, reason: "test" });
  assert.deepEqual(nativeDevnet.identity, { identityKind: "NATIVE", contractAddressOrMint: "native:101", identityKey: "native:101:devnet" });
  const usdcDevnet = normalizeCandidateInput({ chain: "101:devnet", providerKey: "solana-basic", symbol: "USDC", assetClass: "STABLECOIN", category: "STABLES_CURRENCIES", contractAddressOrMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, tags: "popular, stable", reason: "test" });
  assert.equal(usdcDevnet.identity.identityKey, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:devnet");
  assert.deepEqual(usdcDevnet.tags, ["POPULAR", "STABLE"]);
  assert.throws(() => normalizeCandidateInput({ chain: "56", providerKey: "xprov", symbol: "A", assetClass: "STABLECOIN", category: "CORE", contractAddressOrMint: "nope", decimals: 18, reason: "r" }), (error) => error.code === "QUOTE_CATALOG_IDENTITY_INVALID");
  assert.throws(() => normalizeCandidateInput({ chain: "56", providerKey: "xprov", symbol: "A", assetClass: "WEIRD", category: "CORE", contractAddressOrMint: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", decimals: 18, reason: "r" }), (error) => error.code === "QUOTE_CATALOG_ASSET_CLASS_INVALID");
});

test("approved policy config: sync shape plus operator price/route overrides, bps capped", () => {
  const item = mapAdminRow(adminRow());
  const config = buildApprovedPolicyConfig(item, { coinGeckoId: "usd-coin", maxSlippageBps: "75" });
  assert.equal(config.solanaGraduation.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(config.solanaGraduation.referenceUsdMicros, 1_000_000);
  assert.equal(config.solanaGraduation.coinGeckoId, "usd-coin");
  assert.equal(config.solanaGraduation.maxSlippageBps, 75);
  assert.equal(config.solanaGraduation.chainId, "101");
  assert.equal(config.solanaGraduation.cluster, "mainnet-beta");
  const evm = buildApprovedPolicyConfig(mapAdminRow(adminRow({ chain_id: "97", chain_family: "EVM", identity_kind: "EVM_ADDRESS", contract_address_or_mint: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", asset_class: "NATIVE", decimals: 18 })), {});
  assert.equal(evm.evmGraduation.quoteToken, "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd");
  assert.equal(evm.evmGraduation.chainId, "97");
  assert.throws(() => buildApprovedPolicyConfig(item, { maxImpactBps: 500 }), (error) => error.code === "QUOTE_CATALOG_POLICY_INVALID");
});

test("admin row: eligibility follows the generic authority; action policy follows state", () => {
  const active = mapAdminRow(adminRow());
  assert.equal(active.newGraduationEligible, true);
  assert.equal(active.chainKey, "101");
  assert.deepEqual(active.actionPolicy, { canApprove: false, canSuspend: true, canReject: true, canReview: true, requiresExpectedVersion: true, requiresReason: true });
  const candidate = mapAdminRow(adminRow({ catalog_state: "CANDIDATE", identity_status: "pending", policy_version_id: null, network_cluster: "devnet" }));
  assert.equal(candidate.newGraduationEligible, false);
  assert.equal(candidate.chainKey, "101:devnet");
  assert.equal(candidate.policy, null);
  assert.equal(candidate.actionPolicy.canApprove, true);
  assert.equal(candidate.actionPolicy.canReview, false);
  assert.deepEqual(actionPolicyFor({ catalog_state: "REJECTED", eligible: false }), { canApprove: true, canSuspend: false, canReject: false, canReview: true, requiresExpectedVersion: true, requiresReason: true });
});

function fakeDb(rowState) {
  const log = [];
  const client = {
    async query(sql, params = []) {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/^select id, quote_asset_id, provider_id, chain_id, state_version, catalog_state from public\.quote_asset_deployments/.test(sql)) return { rows: [rowState.lock] };
      if (/^\s*select\s+d\.id as deployment_id/.test(sql)) return { rows: [adminRow({ catalog_state: rowState.catalogState, deployment_state_version: String(rowState.version), policy_version_id: rowState.policy ? "pv1" : null, ...(rowState.row || {}) })] };
      if (/from public\.quote_asset_policy_versions where quote_asset_id = \$1::uuid and \(deployment_id/.test(sql)) return { rows: [] };
      if (/select policy_key, max\(version\)/.test(sql)) return { rows: [] };
      if (/select coalesce\(max\(version\), 0\)/.test(sql)) return { rows: [{ version: 0 }] };
      if (/insert into public\.quote_asset_policy_versions/.test(sql)) return { rows: [{ id: "pv-new" }] };
      if (/quote_asset_scan_history where deployment_id|quote_asset_decision_history where deployment_id/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() { log.push({ sql: "release", params: [] }); },
  };
  return { log, db: { connect: async () => client, query: client.query } };
}

test("approve: attests gates, retires and rebinds the policy, records scan and decision inside one transaction", async () => {
  const { db, log } = fakeDb({ lock: { id: "d1", quote_asset_id: "a1", provider_id: "p1", chain_id: "101", state_version: 3, catalog_state: "CANDIDATE" }, catalogState: "CANDIDATE", version: 3, policy: false });
  const detail = await decideQuoteCatalogDeployment({ id: "d1", action: "approve", expectedVersion: 3, reason: "checked route", policyOverrides: { coinGeckoId: "usd-coin" }, evidence: ["https://x"], actorIdentity: "admin:1:a@b", db });
  assert.ok(detail);
  const sqls = log.map((entry) => entry.sql);
  assert.equal(sqls[0], "begin");
  assert.ok(sqls.some((sql) => sql.startsWith("update public.quote_asset_deployments set catalog_state = 'ACTIVE'")));
  assert.ok(sqls.some((sql) => sql.startsWith("insert into public.quote_asset_scan_history")));
  assert.ok(sqls.some((sql) => sql.startsWith("update public.quote_asset_policy_versions set policy_status = 'retired'")));
  const policyInsert = log.find((entry) => entry.sql.startsWith("insert into public.quote_asset_policy_versions"));
  assert.deepEqual(policyInsert.params.slice(0, 5), ["a1", "p1", "d1", "canonical-stable-usdc-101-v1", 1]);
  assert.equal(JSON.parse(policyInsert.params[5]).solanaGraduation.coinGeckoId, "usd-coin");
  const decision = log.find((entry) => entry.sql.startsWith("insert into public.quote_asset_decision_history"));
  assert.deepEqual(decision.params.slice(0, 6), ["d1", "p1", "pv-new", 4, "eligible", "checked route"]);
  const commitAt = sqls.indexOf("commit");
  assert.ok(commitAt > sqls.findIndex((sql) => sql.startsWith("insert into public.quote_asset_decision_history")), "decision recorded before commit");
  assert.equal(sqls.at(-1), "release");
});

test("decisions: version conflict rolls back with the current row; missing reason and bad actions are refused up front", async () => {
  const { db, log } = fakeDb({ lock: { id: "d1", quote_asset_id: "a1", provider_id: "p1", chain_id: "101", state_version: 4, catalog_state: "ACTIVE" }, catalogState: "ACTIVE", version: 4, policy: true });
  await assert.rejects(
    () => decideQuoteCatalogDeployment({ id: "d1", action: "suspend", expectedVersion: 3, reason: "stale", actorIdentity: "admin", db }),
    (error) => error instanceof QuoteCatalogAdminError && error.code === "STATE_VERSION_CONFLICT" && error.httpStatus === 409 && error.current?.stateVersion === 4,
  );
  assert.ok(log.some((entry) => entry.sql === "rollback"));
  await assert.rejects(() => decideQuoteCatalogDeployment({ id: "d1", action: "suspend", expectedVersion: 4, reason: "", actorIdentity: "admin", db }), (error) => error.code === "REASON_REQUIRED");
  await assert.rejects(() => decideQuoteCatalogDeployment({ id: "d1", action: "nuke", expectedVersion: 4, reason: "x", actorIdentity: "admin", db }), (error) => error.code === "QUOTE_CATALOG_ACTION_UNKNOWN");
});

test("approve on Robinhood Chain refuses a catalog asset that is not native: no adapter exists for it, only the stock registry", async () => {
  const usdg = { chain_id: "4663", chain_family: "EVM", identity_kind: "EVM_ADDRESS", contract_address_or_mint: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", identity_key: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, asset_class: "STABLECOIN", symbol: "USDG", native_wrapped_status: "NONE", policy_key: "robinhood-basic-usdg-4663-v1", policy_config: {} };
  const lock = { id: "d1", quote_asset_id: "a1", provider_id: "p1", chain_id: "4663", state_version: 3, catalog_state: "CANDIDATE" };
  const refused = fakeDb({ lock, catalogState: "CANDIDATE", version: 3, policy: false, row: usdg });
  await assert.rejects(
    () => decideQuoteCatalogDeployment({ id: "d1", action: "approve", expectedVersion: 3, reason: "manual approve", actorIdentity: "admin", db: refused.db }),
    (error) => error instanceof QuoteCatalogAdminError && error.code === "ROBINHOOD_CATALOG_ROUTE_UNAVAILABLE" && error.httpStatus === 409 && /USDG cannot be approved on Robinhood Chain/.test(error.message),
  );
  assert.ok(refused.log.some((entry) => entry.sql === "rollback"), "the transaction is rolled back");
  assert.ok(!refused.log.some((entry) => entry.sql.startsWith("update public.quote_asset_deployments set catalog_state = 'ACTIVE'")), "nothing was activated");

  // rejecting that same candidate is still an allowed decision
  const rejected = fakeDb({ lock, catalogState: "CANDIDATE", version: 3, policy: false, row: usdg });
  assert.ok(await decideQuoteCatalogDeployment({ id: "d1", action: "reject", expectedVersion: 3, reason: "no adapter on Robinhood", actorIdentity: "admin", db: rejected.db }));
  assert.ok(rejected.log.some((entry) => entry.sql === "commit"));

  // native ETH on Robinhood is the one catalog asset that can graduate there, and still approves
  const eth = { chain_id: "4663", chain_family: "EVM", identity_kind: "NATIVE", contract_address_or_mint: "native:4663", identity_key: "native:4663", decimals: 18, asset_class: "NATIVE", symbol: "ETH", native_wrapped_status: "NATIVE", policy_key: "robinhood-basic-eth-4663-v1", policy_config: {} };
  const approved = fakeDb({ lock, catalogState: "CANDIDATE", version: 3, policy: false, row: eth });
  assert.ok(await decideQuoteCatalogDeployment({ id: "d1", action: "approve", expectedVersion: 3, reason: "native", actorIdentity: "admin", db: approved.db }));
  assert.ok(approved.log.some((entry) => entry.sql.startsWith("update public.quote_asset_deployments set catalog_state = 'ACTIVE'")));

  // the same non-native asset on BNB is untouched by this rule (BNB has a quote adapter)
  const bnb = fakeDb({ lock: { ...lock, chain_id: "56" }, catalogState: "CANDIDATE", version: 3, policy: false, row: { ...usdg, chain_id: "56", policy_key: "bnb-basic-usdg-56-v1" } });
  assert.ok(await decideQuoteCatalogDeployment({ id: "d1", action: "approve", expectedVersion: 3, reason: "bnb route verified", actorIdentity: "admin", db: bnb.db }));
});


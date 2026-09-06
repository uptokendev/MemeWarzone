import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const { pool } = await import("../frontend/server/db.js");
const { listGraduationQuoteAssets } = await import("../frontend/api/lib/quoteAssetCatalog.js");
const { buildBnbBasicQuoteCatalogBinding, BNB_BASIC_CAMPAIGN_GENERATION, BNB_BASIC_FACTORY_GENERATION } = await import("../frontend/api/lib/bnbBasicQuoteCatalogBinding.js");
const { bindBnbGraduatedMarketToCatalogResult } = await import("../realtime-indexer/dist/normalizedMarketAuthority.js");

const quoteAddress = "0x00000000000000000000000000000000000000AA";
const row = {
  deployment_id: "11111111-1111-1111-1111-111111111111",
  quote_asset_id: "22222222-2222-2222-2222-222222222222",
  provider_id: "33333333-3333-3333-3333-333333333333",
  chain_id: "56",
  identity_kind: "EVM_ADDRESS",
  contract_address_or_mint: quoteAddress,
  identity_status: "verified",
  security_status: "verified",
  market_health_status: "healthy",
  existing_market_support: true,
  deployment_admin_state: "enabled",
  deployment_state_version: 12,
  last_scan_at: "2026-09-06T22:00:00.000Z",
  asset_class: "STABLECOIN",
  symbol: "USDC",
  display_name: "Canonical USDC",
  logo_url: null,
  asset_admin_state: "enabled",
  provider_key: "bnb-basic-canonical",
  provider_display_name: "BNB BASIC Canonical",
  authority_mode: "GENERIC",
  provider_class: "STABLECOIN",
  provider_admin_state: "enabled",
  policy_version_id: "44444444-4444-4444-4444-444444444444",
  policy_key: "bnb-basic-stable",
  policy_version: 7,
  policy_status: "active",
  basic_approved: true,
  new_graduation_enabled: true,
  require_identity_verified: true,
  require_security_verified: true,
  require_market_healthy: true,
};

const originalQuery = pool.query.bind(pool);
pool.query = async (sql) => {
  if (String(sql).includes("from public.quote_asset_deployments")) return { rows: [row] };
  throw new Error(`unexpected DB call in Agent1/Agent3/Agent4 binding certification: ${String(sql).slice(0, 100)}`);
};

try {
  const [agent1] = await listGraduationQuoteAssets({ chainId: "56" });
  assert.ok(agent1, "Agent 1 catalog result missing");
  assert.equal(agent1.newGraduationEligible, true, "eligibility decision must come from Agent 1");

  const agent3 = buildBnbBasicQuoteCatalogBinding(agent1);
  assert.equal(agent3.deploymentId, agent1.id);
  assert.equal(agent3.quoteToken.toLowerCase(), agent1.contractAddressOrMint.toLowerCase());
  assert.equal(agent3.providerKey, agent1.provider.key);
  assert.equal(agent3.policyKey, agent1.policy.policyKey);
  assert.equal(String(agent3.policyVersion), String(agent1.policy.version));
  assert.equal(agent3.factoryGeneration, BNB_BASIC_FACTORY_GENERATION);
  assert.equal(agent3.campaignGeneration, BNB_BASIC_CAMPAIGN_GENERATION);

  // Agent 3's BNB graduation contract tests separately prove that this catalog-bound quoteToken
  // becomes the quote side of the actual permanent MEME/QUOTE Topaz pair. Agent 4 consumes that
  // graduated pair identity; it does not invent or substitute a quote.
  const graduatedMarket = {
    baseAsset: "MEME",
    baseAddress: "0x0000000000000000000000000000000000000abc",
    quoteAsset: agent1.symbol,
    quoteAddress: agent3.quoteToken,
    poolAddress: "0x0000000000000000000000000000000000000def",
    venue: "TOPAZ",
    chainId: agent1.chainId,
    campaignGeneration: String(agent3.campaignGeneration),
    marketGeneration: String(agent3.factoryGeneration),
  };

  const normalized = bindBnbGraduatedMarketToCatalogResult(graduatedMarket, agent3, agent1);

  assert.equal(normalized.quoteDeploymentId, agent1.id);
  assert.equal(normalized.quoteAssetId, agent1.assetId);
  assert.equal(normalized.quoteAddress.toLowerCase(), agent1.contractAddressOrMint.toLowerCase());
  assert.equal(normalized.provider, agent1.provider.key);
  assert.equal(normalized.quotePolicyKey, agent1.policy.policyKey);
  assert.equal(normalized.quotePolicyVersion, agent1.policy.version);
  assert.equal(normalized.quoteAssetClass, agent1.assetClass);
  assert.equal(normalized.chainId, agent1.chainId);

  console.log("agent1_agent3_agent4_bnb_market_binding=ok");
  console.log(JSON.stringify({
    quoteDeploymentId: normalized.quoteDeploymentId,
    quoteAssetId: normalized.quoteAssetId,
    quoteAddress: normalized.quoteAddress,
    provider: normalized.provider,
    policyKey: normalized.quotePolicyKey,
    policyVersion: normalized.quotePolicyVersion,
    quoteClass: normalized.quoteAssetClass,
    chainId: normalized.chainId,
  }));
} finally {
  pool.query = originalQuery;
  await pool.end().catch(() => {});
}

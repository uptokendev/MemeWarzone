import assert from "node:assert/strict";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
const { pool } = await import("../frontend/server/db.js");
const { listGraduationQuoteAssets } = await import("../frontend/api/lib/quoteAssetCatalog.js");
const { bindMarketToCatalogResult } = await import("../realtime-indexer/dist/normalizedMarketAuthority.js");

const exactAddress = "0x00000000000000000000000000000000000000AA";
const row = {
  deployment_id:"11111111-1111-1111-1111-111111111111", quote_asset_id:"22222222-2222-2222-2222-222222222222",
  provider_id:"33333333-3333-3333-3333-333333333333", chain_id:"56", identity_kind:"EVM_ADDRESS", contract_address_or_mint:exactAddress,
  identity_status:"verified", security_status:"verified", market_health_status:"healthy", existing_market_support:true,
  deployment_admin_state:"enabled", deployment_state_version:9, last_scan_at:"2026-09-06T22:00:00.000Z",
  asset_class:"STABLECOIN", symbol:"USDC", display_name:"Canonical USDC", logo_url:null, asset_admin_state:"enabled",
  provider_key:"canonical-usdc", provider_display_name:"Canonical USDC Provider", authority_mode:"GENERIC", provider_class:"STABLECOIN", provider_admin_state:"enabled",
  policy_version_id:"44444444-4444-4444-4444-444444444444", policy_key:"bnb-usdc-basic", policy_version:4, policy_status:"active",
  basic_approved:true, new_graduation_enabled:true, require_identity_verified:true, require_security_verified:true, require_market_healthy:true,
};
const originalQuery = pool.query.bind(pool);
pool.query = async (sql) => {
  if (String(sql).includes("from public.quote_asset_deployments")) return { rows:[row] };
  throw new Error(`unexpected DB call in Agent1/Agent4 binding certification: ${String(sql).slice(0,80)}`);
};
try {
  const results = await listGraduationQuoteAssets({ chainId:"56" });
  assert.equal(results.length,1);
  const agent1 = results[0];
  assert.equal(agent1.newGraduationEligible,true);
  const bound = bindMarketToCatalogResult({
    baseAsset:"MEME", baseAddress:"0x0000000000000000000000000000000000000abc", quoteAsset:"display-only",
    quoteAddress:exactAddress.toLowerCase(), poolAddress:"0x0000000000000000000000000000000000000def", venue:"TOPAZ", chainId:"56",
    campaignGeneration:"basic-multi-quote-v1", marketGeneration:"normalized-market-v1",
  }, agent1);
  assert.equal(bound.quoteDeploymentId,row.deployment_id);
  assert.equal(bound.quoteAssetId,row.quote_asset_id);
  assert.equal(bound.provider,row.provider_key);
  assert.equal(bound.quotePolicyKey,row.policy_key);
  assert.equal(bound.quotePolicyVersion,row.policy_version);
  assert.equal(bound.quotePolicyAuthority,"generic");
  assert.equal(bound.quoteAddress,exactAddress.toLowerCase());
  assert.equal(bound.quoteAssetClass,row.asset_class);
  assert.equal(bound.chainId,row.chain_id);
  console.log("agent1_agent4_catalog_binding=ok");
} finally { pool.query = originalQuery; await pool.end().catch(()=>{}); }

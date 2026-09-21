/**
 * Approved quote catalog -> database sync.
 *
 * The creator picker only shows what is in quote_asset_deployments with an
 * active policy, but until now nothing wrote the approved manifest
 * (frontend/api/data/approved-quote-catalog.v1.json) into those tables: only
 * the two Solana seed rows existed. This module plans and applies an
 * idempotent sync per chain:
 *
 *   providers       insert-only (admin_state never changed here)
 *   quote_assets    upsert display fields; admin_state never changed here
 *   deployments     upsert identity + the six verification gates + catalog
 *                   state from the manifest; admin_state never changed here
 *   policies        one active policy for an ACTIVE + eligible asset, one
 *                   draft policy for everything else; an existing active
 *                   policy is never modified
 *   decisions       append-only history row for every deployment whose
 *                   catalog state changed
 *
 * The Robinhood stock registry keeps its own provider (authority mode
 * ROBINHOOD_STOCK_REGISTRY) and is never written from the manifest.
 * `planQuoteCatalogSync` is pure; `applyQuoteCatalogSync` takes a query
 * function so it runs inside the caller's transaction (or a recorder in tests).
 */
import { ethers } from "ethers";
import { APPROVED_QUOTE_CATALOG } from "./approvedQuoteCatalog.js";

export const SYNC_ACTOR = "quote-catalog-sync";
export const REGISTRY_PROVIDERS = Object.freeze(["robinhood-stock-token"]);
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export const PROVIDER_DISPLAY = Object.freeze({
  "solana-basic": { displayName: "Solana BASIC Quote Assets", providerClass: "BASIC" },
  "canonical-stable": { displayName: "Canonical Stablecoins", providerClass: "STABLECOIN" },
  jupiter: { displayName: "Jupiter", providerClass: "ECOSYSTEM" },
  pyth: { displayName: "Pyth", providerClass: "ECOSYSTEM" },
  jito: { displayName: "Jito", providerClass: "ECOSYSTEM" },
  orca: { displayName: "Orca", providerClass: "ECOSYSTEM" },
  xstocks: { displayName: "xStocks (Backed)", providerClass: "PROVIDER_RWA" },
  "bnb-native": { displayName: "BNB Chain Native", providerClass: "BASIC" },
  "binance-peg": { displayName: "Binance-Peg", providerClass: "ECOSYSTEM" },
  "first-digital": { displayName: "First Digital", providerClass: "STABLECOIN" },
  pancakeswap: { displayName: "PancakeSwap", providerClass: "ECOSYSTEM" },
  "robinhood-basic": { displayName: "Robinhood BASIC Quote Assets", providerClass: "BASIC" },
});

function text(value) {
  return String(value ?? "").trim();
}

function gate(value) {
  return text(value).toUpperCase() === "VERIFIED" ? "VERIFIED" : "PENDING";
}

export function manifestIdentity(chainFamily, address) {
  const raw = text(address);
  if (raw.startsWith("native:")) return { identityKind: "NATIVE", contractAddressOrMint: raw, identityKey: raw };
  if (chainFamily === "SOLANA") {
    if (raw.length < 32 || raw.length > 64) throw new Error(`invalid Solana mint ${raw}`);
    return { identityKind: "SOLANA_MINT", contractAddressOrMint: raw, identityKey: raw };
  }
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`invalid EVM address ${raw}`);
  return { identityKind: "EVM_ADDRESS", contractAddressOrMint: ethers.getAddress(raw), identityKey: ethers.getAddress(raw).toLowerCase() };
}

/** Legacy tri-state the runtime authority (deriveGenericQuoteAuthority) reads. */
export function legacyStatuses(asset) {
  const identityVerified = text(asset.identity).toUpperCase() === "VERIFIED";
  const securityVerified = text(asset.security).toUpperCase() === "VERIFIED";
  const marketVerified = ["route", "price", "lp"].every((key) => text(asset[key]).toUpperCase() === "VERIFIED");
  return {
    identity_status: identityVerified ? "verified" : "pending",
    security_status: securityVerified ? "verified" : "pending",
    market_health_status: marketVerified ? "healthy" : "pending",
  };
}

/** quote_asset_decision_history.decision is an enum: eligible | ineligible | existing_market_only | disabled | review. */
export function decisionFor(deployment) {
  if (deployment.active_eligible) return "eligible";
  if (deployment.existing_market_support) return "existing_market_only";
  if (deployment.catalog_state === "REJECTED") return "ineligible";
  if (deployment.catalog_state === "SUSPENDED") return "disabled";
  return "review";
}

export function isActiveEligible(asset) {
  return text(asset.proposedState).toUpperCase() === "ACTIVE"
    && asset.newGraduationEligibility === true
    && ["identity", "transferability", "security", "route", "price", "lp"].every((key) => text(asset[key]).toUpperCase() === "VERIFIED");
}

export function policyConfigFor(asset, chainFamily, identity) {
  const decimals = Number(asset.decimals);
  const stable = text(asset.assetClass).toUpperCase() === "STABLECOIN";
  if (chainFamily === "SOLANA") {
    const native = identity.identityKind === "NATIVE";
    return {
      solanaGraduation: {
        quoteMint: native ? "So11111111111111111111111111111111111111112" : identity.contractAddressOrMint,
        decimals,
        acquisitionProgram: native ? SOLANA_SYSTEM_PROGRAM : JUPITER_V6,
        referenceUsdMicros: stable ? 1_000_000 : null,
        maxSlippageBps: native ? 0 : 100,
        maxImpactBps: native ? 0 : 100,
        maxDeviationBps: native ? 0 : 100,
      },
    };
  }
  return {
    evmGraduation: {
      quoteToken: identity.identityKind === "NATIVE" ? null : identity.contractAddressOrMint,
      native: identity.identityKind === "NATIVE",
      decimals,
      referenceUsdMicros: stable ? 1_000_000 : null,
      maxSlippageBps: identity.identityKind === "NATIVE" ? 0 : 100,
      maxImpactBps: identity.identityKind === "NATIVE" ? 0 : 100,
      maxDeviationBps: identity.identityKind === "NATIVE" ? 0 : 100,
    },
  };
}

/**
 * Pure plan. `chainIds` limits the sync; `manifest` defaults to the approved
 * catalog. Returns the desired rows keyed the way the tables are unique.
 */
export function planQuoteCatalogSync({ manifest = APPROVED_QUOTE_CATALOG, chainIds } = {}) {
  const wanted = new Set((chainIds || []).map((id) => String(id)));
  const providers = new Map();
  const assets = new Map();
  const deployments = [];
  const policies = [];
  for (const asset of manifest.assets || []) {
    const chainId = String(asset.chainId);
    if (wanted.size && !wanted.has(chainId)) continue;
    const provider = text(asset.provider).toLowerCase();
    if (!provider || REGISTRY_PROVIDERS.includes(provider)) continue;
    const chain = manifest.chains?.[chainId];
    if (!chain?.family) throw new Error(`manifest has no chain entry for ${chainId}`);
    const display = PROVIDER_DISPLAY[provider] || { displayName: provider, providerClass: "ECOSYSTEM" };
    providers.set(provider, { provider_key: provider, display_name: display.displayName, authority_mode: "GENERIC_POLICY", provider_class: display.providerClass });

    const assetKey = text(asset.providerAssetId || asset.symbol).toLowerCase();
    if (!assetKey) throw new Error(`manifest asset without providerAssetId/symbol on ${chainId}`);
    const assetId = `${provider}::${assetKey}`;
    if (!assets.has(assetId)) {
      assets.set(assetId, {
        provider_key: provider,
        asset_key: assetKey,
        asset_class: text(asset.assetClass) || "OTHER",
        symbol: text(asset.symbol) || null,
        display_name: text(asset.displayName) || null,
        category: text(asset.category) || "ECOSYSTEM",
        tags: Array.isArray(asset.tags) ? asset.tags : [],
        provider_asset_id: text(asset.providerAssetId) || null,
      });
    }

    const identity = manifestIdentity(chain.family, asset.address);
    const legacy = legacyStatuses(asset);
    deployments.push({
      provider_key: provider,
      asset_key: assetKey,
      chain_id: chainId,
      chain_family: chain.family,
      identity_kind: identity.identityKind,
      contract_address_or_mint: identity.contractAddressOrMint,
      identity_key: identity.identityKey,
      decimals: Number.isFinite(Number(asset.decimals)) ? Number(asset.decimals) : null,
      ...legacy,
      existing_market_support: asset.existingMarketSupport === true,
      canonical_status: text(asset.canonicalStatus) || "CANDIDATE",
      native_wrapped_status: text(asset.nativeWrappedStatus) || "NONE",
      transferability_status: gate(asset.transferability),
      acquisition_route_status: gate(asset.route),
      price_authority_status: gate(asset.price),
      lp_venue_status: gate(asset.lp),
      catalog_state: text(asset.proposedState) || "CANDIDATE",
      evidence_sources: Array.isArray(asset.evidence) ? asset.evidence : [],
      last_verified_at: asset.lastVerifiedAt || null,
      active_eligible: isActiveEligible(asset),
    });

    const active = isActiveEligible(asset);
    policies.push({
      provider_key: provider,
      asset_key: assetKey,
      chain_id: chainId,
      policy_key: `${provider}-${assetKey}-${chainId}-v1`,
      version: 1,
      policy_status: active ? "active" : "draft",
      basic_approved: active,
      new_graduation_enabled: active,
      policy_config: policyConfigFor(asset, chain.family, identity),
    });
  }
  return { providers: [...providers.values()], assets: [...assets.values()], deployments, policies };
}

async function one(query, sql, params) {
  const result = await query(sql, params);
  return result?.rows?.[0] || null;
}

/**
 * Applies a plan through `query` (pool.query or a transaction client's query).
 * `dryRun` computes every change without writing. Returns a report of what
 * was inserted, updated or left alone.
 */
export async function applyQuoteCatalogSync(query, plan, { dryRun = true, actorIdentity = SYNC_ACTOR } = {}) {
  const report = { dryRun, providers: { inserted: 0, existing: 0 }, assets: { inserted: 0, updated: 0, unchanged: 0 }, deployments: { inserted: 0, updated: 0, unchanged: 0 }, policies: { inserted: 0, existingActive: 0, existingDraft: 0 }, decisions: 0, changes: [] };
  const providerIds = new Map();
  const assetIds = new Map();

  for (const provider of plan.providers) {
    const existing = await one(query, `select id, authority_mode from public.quote_asset_providers where provider_key = $1`, [provider.provider_key]);
    if (existing) {
      if (existing.authority_mode !== "GENERIC_POLICY") throw new Error(`provider ${provider.provider_key} is registry-driven; refusing to sync`);
      providerIds.set(provider.provider_key, existing.id);
      report.providers.existing += 1;
      continue;
    }
    report.providers.inserted += 1;
    report.changes.push({ kind: "provider", action: "insert", key: provider.provider_key });
    if (dryRun) { providerIds.set(provider.provider_key, null); continue; }
    const inserted = await one(query,
      `insert into public.quote_asset_providers (provider_key, display_name, authority_mode, provider_class, admin_state, state_version)
       values ($1,$2,$3,$4,'enabled',1) returning id`,
      [provider.provider_key, provider.display_name, provider.authority_mode, provider.provider_class]);
    providerIds.set(provider.provider_key, inserted.id);
  }

  for (const asset of plan.assets) {
    const providerId = providerIds.get(asset.provider_key);
    const key = `${asset.provider_key}::${asset.asset_key}`;
    const existing = providerId
      ? await one(query, `select id, asset_class, symbol, display_name, category, tags::text as tags, provider_asset_id from public.quote_assets where provider_id = $1 and asset_key = $2`, [providerId, asset.asset_key])
      : null;
    if (existing) {
      assetIds.set(key, existing.id);
      const same = existing.asset_class === asset.asset_class && (existing.symbol || null) === asset.symbol && (existing.display_name || null) === asset.display_name
        && existing.category === asset.category && JSON.stringify(JSON.parse(existing.tags || "[]")) === JSON.stringify(asset.tags) && (existing.provider_asset_id || null) === asset.provider_asset_id;
      if (same) { report.assets.unchanged += 1; continue; }
      report.assets.updated += 1;
      report.changes.push({ kind: "asset", action: "update", key });
      if (!dryRun) {
        await query(
          `update public.quote_assets set asset_class=$3, symbol=$4, display_name=$5, category=$6, tags=$7::jsonb, provider_asset_id=$8, state_version=state_version+1, updated_at=now()
            where provider_id=$1 and asset_key=$2`,
          [providerId, asset.asset_key, asset.asset_class, asset.symbol, asset.display_name, asset.category, JSON.stringify(asset.tags), asset.provider_asset_id]);
      }
      continue;
    }
    report.assets.inserted += 1;
    report.changes.push({ kind: "asset", action: "insert", key });
    if (dryRun || !providerId) { assetIds.set(key, null); continue; }
    const inserted = await one(query,
      `insert into public.quote_assets (provider_id, asset_key, asset_class, symbol, display_name, category, tags, provider_asset_id, admin_state, state_version)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'enabled',1) returning id`,
      [providerId, asset.asset_key, asset.asset_class, asset.symbol, asset.display_name, asset.category, JSON.stringify(asset.tags), asset.provider_asset_id]);
    assetIds.set(key, inserted.id);
  }

  const deploymentIds = new Map();
  for (const d of plan.deployments) {
    const providerId = providerIds.get(d.provider_key);
    const assetId = assetIds.get(`${d.provider_key}::${d.asset_key}`);
    const key = `${d.chain_id}:${d.provider_key}:${d.identity_key}`;
    const existing = providerId
      ? await one(query,
        `select id, quote_asset_id, identity_kind, contract_address_or_mint, decimals, chain_family, identity_status, security_status, market_health_status, existing_market_support,
                canonical_status, native_wrapped_status, transferability_status, acquisition_route_status, price_authority_status, lp_venue_status, catalog_state, state_version
           from public.quote_asset_deployments where provider_id = $1 and chain_id = $2 and identity_key = $3`,
        [providerId, d.chain_id, d.identity_key])
      : null;
    if (existing) {
      deploymentIds.set(key, existing.id);
      const fields = ["identity_kind", "contract_address_or_mint", "decimals", "chain_family", "identity_status", "security_status", "market_health_status", "existing_market_support",
        "canonical_status", "native_wrapped_status", "transferability_status", "acquisition_route_status", "price_authority_status", "lp_venue_status", "catalog_state"];
      const changed = fields.filter((f) => String(existing[f] ?? "") !== String(d[f] ?? ""));
      if (!changed.length) { report.deployments.unchanged += 1; continue; }
      report.deployments.updated += 1;
      report.changes.push({ kind: "deployment", action: "update", key, changed });
      if (!dryRun) {
        await query(
          `update public.quote_asset_deployments set identity_kind=$2, contract_address_or_mint=$3, decimals=$4, chain_family=$5,
                  identity_status=$6, security_status=$7, market_health_status=$8, existing_market_support=$9,
                  canonical_status=$10, native_wrapped_status=$11, transferability_status=$12, acquisition_route_status=$13,
                  price_authority_status=$14, lp_venue_status=$15, catalog_state=$16, evidence_sources=$17::jsonb,
                  last_scan_at=coalesce($18::timestamptz, last_scan_at), state_version=state_version+1, updated_at=now()
            where id=$1`,
          [existing.id, d.identity_kind, d.contract_address_or_mint, d.decimals, d.chain_family, d.identity_status, d.security_status, d.market_health_status, d.existing_market_support,
            d.canonical_status, d.native_wrapped_status, d.transferability_status, d.acquisition_route_status, d.price_authority_status, d.lp_venue_status, d.catalog_state,
            JSON.stringify(d.evidence_sources), d.last_verified_at]);
        if (changed.includes("catalog_state")) {
          await query(
            `insert into public.quote_asset_decision_history (deployment_id, provider_id, state_version, decision, reason, decision_snapshot, actor_identity)
             values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
            [existing.id, providerId, Number(existing.state_version) + 1, decisionFor(d), `approved quote catalog manifest sync: catalog_state ${existing.catalog_state} -> ${d.catalog_state}`, JSON.stringify({ from: existing.catalog_state, to: d.catalog_state, changed }), actorIdentity]);
          report.decisions += 1;
        }
      }
      continue;
    }
    report.deployments.inserted += 1;
    report.changes.push({ kind: "deployment", action: "insert", key, catalogState: d.catalog_state });
    if (dryRun || !providerId || !assetId) { deploymentIds.set(key, null); continue; }
    const inserted = await one(query,
      `insert into public.quote_asset_deployments (quote_asset_id, provider_id, chain_id, identity_kind, contract_address_or_mint, identity_key, decimals, chain_family,
              identity_status, security_status, market_health_status, existing_market_support, canonical_status, native_wrapped_status, transferability_status,
              acquisition_route_status, price_authority_status, lp_venue_status, catalog_state, evidence_sources, last_scan_at, admin_state, state_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::timestamptz,'enabled',1) returning id`,
      [assetId, providerId, d.chain_id, d.identity_kind, d.contract_address_or_mint, d.identity_key, d.decimals, d.chain_family,
        d.identity_status, d.security_status, d.market_health_status, d.existing_market_support, d.canonical_status, d.native_wrapped_status, d.transferability_status,
        d.acquisition_route_status, d.price_authority_status, d.lp_venue_status, d.catalog_state, JSON.stringify(d.evidence_sources), d.last_verified_at]);
    deploymentIds.set(key, inserted.id);
    await query(
      `insert into public.quote_asset_decision_history (deployment_id, provider_id, state_version, decision, reason, decision_snapshot, actor_identity)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [inserted.id, providerId, 1, decisionFor(d), `approved quote catalog manifest sync: catalog_state ${d.catalog_state}`, JSON.stringify({ from: null, to: d.catalog_state }), actorIdentity]);
    report.decisions += 1;
  }

  for (const p of plan.policies) {
    const providerId = providerIds.get(p.provider_key);
    const assetId = assetIds.get(`${p.provider_key}::${p.asset_key}`);
    const key = `${p.chain_id}:${p.provider_key}:${p.asset_key}`;
    const existing = providerId && assetId
      ? await one(query, `select id, policy_status from public.quote_asset_policy_versions where quote_asset_id = $1 order by (policy_status = 'active') desc, version desc limit 1`, [assetId])
      : null;
    if (existing?.policy_status === "active") { report.policies.existingActive += 1; continue; }
    if (existing && p.policy_status === "draft") { report.policies.existingDraft += 1; continue; }
    // A draft exists and the asset is now ACTIVE: add the active version on top.
    const version = existing ? 2 : p.version;
    report.policies.inserted += 1;
    report.changes.push({ kind: "policy", action: "insert", key, status: p.policy_status, version });
    if (dryRun || !providerId || !assetId) continue;
    await query(
      `insert into public.quote_asset_policy_versions (quote_asset_id, provider_id, policy_key, version, policy_status, basic_approved, new_graduation_enabled,
              require_identity_verified, require_security_verified, require_market_healthy, policy_config)
       values ($1,$2,$3,$4,$5,$6,$7,true,true,true,$8::jsonb)
       on conflict (provider_id, policy_key, version) do nothing`,
      [assetId, providerId, p.policy_key, version, p.policy_status, p.basic_approved, p.new_graduation_enabled, JSON.stringify(p.policy_config)]);
  }
  return report;
}

export async function syncApprovedQuoteCatalog({ db, chainIds, dryRun = true, actorIdentity = SYNC_ACTOR, manifest } = {}) {
  const plan = planQuoteCatalogSync({ manifest, chainIds });
  if (dryRun) return { plan, report: await applyQuoteCatalogSync((text, params) => db.query(text, params), plan, { dryRun: true, actorIdentity }) };
  const client = await db.connect();
  try {
    await client.query("begin");
    const report = await applyQuoteCatalogSync((text, params) => client.query(text, params), plan, { dryRun: false, actorIdentity });
    await client.query("commit");
    return { plan, report };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Quote Asset Catalog administration (Command Center "Graduation Markets").
 *
 * The public catalog (quoteAssetCatalog.js) only shows assets whose deployment
 * is ACTIVE and fully verified. This module is where an operator gets an asset
 * there: list every deployment on a chain whatever its state, add a candidate,
 * approve it (which attests the verification gates, activates a policy bound
 * to that deployment and records the decision), suspend, reject or reopen it.
 * Every mutation is optimistic on state_version and leaves a row in
 * quote_asset_decision_history (and quote_asset_scan_history for attestations).
 */
import { pool } from "../../server/db.js";
import { deriveGenericQuoteAuthority, normalizeQuoteIdentity, normalizeSolanaCluster } from "./quoteAssetCatalog.js";
import { policyConfigFor } from "./quoteAssetCatalogSync.js";
import { listRobinhoodStockRegistry } from "./robinhoodStockGraduationRegistry.js";

export const QUOTE_CATALOG_CHAINS = Object.freeze([
  { key: "101", chainId: "101", cluster: "mainnet-beta", label: "Solana Mainnet", family: "SOLANA", bondingAsset: "SOL", testnet: false },
  { key: "101:devnet", chainId: "101", cluster: "devnet", label: "Solana Devnet", family: "SOLANA", bondingAsset: "SOL", testnet: true },
  { key: "56", chainId: "56", cluster: null, label: "BNB Chain", family: "EVM", bondingAsset: "BNB", testnet: false },
  { key: "97", chainId: "97", cluster: null, label: "BNB Smart Chain Testnet", family: "EVM", bondingAsset: "BNB", testnet: true },
  { key: "4663", chainId: "4663", cluster: null, label: "Robinhood Chain", family: "EVM", bondingAsset: "ETH", testnet: false },
  { key: "46630", chainId: "46630", cluster: null, label: "Robinhood Chain Testnet", family: "EVM", bondingAsset: "ETH", testnet: true },
]);

const ROBINHOOD_CHAIN_IDS = new Set(["4663", "46630"]);
const ASSET_CLASSES = ["NATIVE", "STABLECOIN", "PUBLIC_RWA", "PRE_IPO_RWA", "COMMODITY", "CRYPTO", "LEVERAGED_OR_YIELD", "COLLECTIBLE", "PROVIDER_RWA", "MWZ_NATIVE", "COMMUNITY", "OTHER"];
const CATEGORIES = ["CORE", "STABLES_CURRENCIES", "STOCKS", "ETFS", "RWA_COMMODITIES", "ECOSYSTEM", "MEMEWARZONE", "COMMUNITY"];
const PROVIDER_CLASSES = ["BASIC", "STABLECOIN", "ECOSYSTEM", "PROVIDER_RWA", "MWZ_NATIVE", "COMMUNITY"];
export const QUOTE_CATALOG_ACTIONS = Object.freeze(["approve", "suspend", "reject", "review"]);

export class QuoteCatalogAdminError extends Error {
  constructor(message, { code = "QUOTE_CATALOG_ADMIN_ERROR", httpStatus = 400, current = null } = {}) {
    super(message);
    this.name = "QuoteCatalogAdminError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.current = current;
  }
}

function text(value) { return String(value ?? "").trim(); }

export function resolveQuoteCatalogChain(key) {
  const wanted = text(key);
  const chain = QUOTE_CATALOG_CHAINS.find((entry) => entry.key === wanted)
    || QUOTE_CATALOG_CHAINS.find((entry) => entry.chainId === wanted && (entry.cluster === null || entry.cluster === "mainnet-beta"));
  if (!chain) throw new QuoteCatalogAdminError(`Unknown chain ${wanted || "(empty)"}.`, { code: "QUOTE_CATALOG_CHAIN_UNKNOWN" });
  return chain;
}

/** Deployment rows whose cluster matches the chain entry (EVM: all rows on the chain id). */
function clusterWhere(chain, alias = "d") {
  if (chain.family !== "SOLANA") return { sql: "", params: [] };
  return { sql: ` and coalesce(${alias}.network_cluster, 'mainnet-beta') = $CLUSTER`, params: [chain.cluster] };
}

const ADMIN_SELECT = `
select
  d.id as deployment_id,
  d.quote_asset_id,
  d.provider_id,
  d.chain_id,
  d.chain_family,
  d.network_cluster,
  d.identity_kind,
  d.contract_address_or_mint,
  d.identity_key,
  d.decimals,
  d.identity_status,
  d.security_status,
  d.market_health_status,
  d.existing_market_support,
  d.admin_state as deployment_admin_state,
  d.state_version as deployment_state_version,
  d.catalog_state,
  d.canonical_status,
  d.native_wrapped_status,
  d.transferability_status,
  d.acquisition_route_status,
  d.price_authority_status,
  d.lp_venue_status,
  d.evidence_sources,
  d.last_scan_at,
  d.last_identity_verified_at,
  d.last_security_verified_at,
  d.last_route_verified_at,
  d.last_price_verified_at,
  d.last_lp_verified_at,
  d.created_at as deployment_created_at,
  d.updated_at as deployment_updated_at,
  d.verification,
  d.verified_at,
  a.asset_key,
  a.asset_class,
  a.symbol,
  a.display_name,
  a.logo_url,
  a.category,
  a.tags,
  a.provider_asset_id,
  a.admin_state as asset_admin_state,
  p.provider_key,
  p.display_name as provider_display_name,
  p.authority_mode,
  p.provider_class,
  p.admin_state as provider_admin_state,
  pv.id as policy_version_id,
  pv.policy_key,
  pv.version as policy_version,
  pv.policy_status,
  pv.basic_approved,
  pv.new_graduation_enabled,
  pv.require_identity_verified,
  pv.require_security_verified,
  pv.require_market_healthy,
  pv.policy_config,
  pv.created_at as policy_created_at
from public.quote_asset_deployments d
join public.quote_assets a on a.id = d.quote_asset_id
join public.quote_asset_providers p on p.id = d.provider_id and p.id = a.provider_id
left join public.quote_asset_policy_versions pv
  on pv.quote_asset_id = a.id
 and pv.policy_status = 'active'
 and (pv.deployment_id = d.id or pv.deployment_id is null)
`;

export function mapAdminRow(row) {
  const provider = { admin_state: row.provider_admin_state };
  const asset = { admin_state: row.asset_admin_state };
  const deployment = {
    admin_state: row.deployment_admin_state,
    identity_status: row.identity_status,
    security_status: row.security_status,
    market_health_status: row.market_health_status,
    existing_market_support: row.existing_market_support,
  };
  const policy = row.policy_version_id
    ? {
        policy_status: row.policy_status,
        basic_approved: row.basic_approved,
        new_graduation_enabled: row.new_graduation_enabled,
        require_identity_verified: row.require_identity_verified,
        require_security_verified: row.require_security_verified,
        require_market_healthy: row.require_market_healthy,
        version: row.policy_version,
        policy_key: row.policy_key,
      }
    : null;
  const authority = deriveGenericQuoteAuthority({ provider, asset, deployment, policy });
  const chainKey = row.chain_family === "SOLANA" && String(row.network_cluster || "mainnet-beta") === "devnet"
    ? `${row.chain_id}:devnet`
    : String(row.chain_id);
  return {
    id: row.deployment_id,
    assetId: row.quote_asset_id,
    chainKey,
    chainId: String(row.chain_id),
    chainFamily: row.chain_family || null,
    solanaCluster: row.chain_family === "SOLANA" ? String(row.network_cluster || "mainnet-beta") : null,
    provider: {
      id: row.provider_id,
      key: row.provider_key,
      displayName: row.provider_display_name,
      authorityMode: row.authority_mode,
      providerClass: row.provider_class,
      adminState: row.provider_admin_state,
    },
    assetKey: row.asset_key,
    assetClass: row.asset_class,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    providerAssetId: row.provider_asset_id || null,
    symbol: row.symbol,
    displayName: row.display_name,
    logoUrl: row.logo_url || null,
    identityKind: row.identity_kind,
    contractAddressOrMint: row.contract_address_or_mint,
    identityKey: row.identity_key,
    decimals: row.decimals == null ? null : Number(row.decimals),
    catalogState: row.catalog_state,
    canonicalStatus: row.canonical_status,
    nativeWrappedStatus: row.native_wrapped_status,
    transferabilityStatus: row.transferability_status,
    acquisitionRouteStatus: row.acquisition_route_status,
    priceAuthorityStatus: row.price_authority_status,
    lpVenueStatus: row.lp_venue_status,
    identityStatus: row.identity_status,
    securityStatus: row.security_status,
    marketHealthStatus: row.market_health_status,
    existingMarketSupport: row.existing_market_support === true,
    adminState: row.deployment_admin_state,
    assetAdminState: row.asset_admin_state,
    stateVersion: Number(row.deployment_state_version),
    newGraduationEligible: authority.newGraduationEligible,
    policy: row.policy_version_id
      ? {
          id: row.policy_version_id,
          policyKey: row.policy_key,
          version: Number(row.policy_version),
          status: row.policy_status,
          basicApproved: row.basic_approved === true,
          newGraduationEnabled: row.new_graduation_enabled === true,
          config: row.policy_config || {},
          createdAt: row.policy_created_at,
        }
      : null,
    evidenceSources: Array.isArray(row.evidence_sources) ? row.evidence_sources : [],
    lastScanAt: row.last_scan_at,
    lastVerified: {
      identity: row.last_identity_verified_at,
      security: row.last_security_verified_at,
      route: row.last_route_verified_at,
      price: row.last_price_verified_at,
      lp: row.last_lp_verified_at,
    },
    createdAt: row.deployment_created_at,
    updatedAt: row.deployment_updated_at,
    verification: row.verification && typeof row.verification === "object" ? row.verification : null,
    verifiedAt: row.verified_at || null,
    actionPolicy: actionPolicyFor({ catalog_state: row.catalog_state, eligible: authority.newGraduationEligible }),
  };
}

export function actionPolicyFor({ catalog_state, eligible }) {
  const state = String(catalog_state || "");
  return {
    canApprove: !(state === "ACTIVE" && eligible),
    canSuspend: state !== "SUSPENDED" && state !== "REJECTED",
    canReject: state !== "REJECTED",
    canReview: state === "ACTIVE" || state === "SUSPENDED" || state === "REJECTED",
    requiresExpectedVersion: true,
    requiresReason: true,
  };
}

function bindParams(sql, params, cluster) {
  if (!cluster.sql) return { sql, params };
  const index = params.length + 1;
  return { sql: sql + cluster.sql.replace("$CLUSTER", `$${index}`), params: [...params, ...cluster.params] };
}

export async function listQuoteCatalogAdmin({ chain: chainKey, db = pool } = {}) {
  const chain = resolveQuoteCatalogChain(chainKey);
  const bound = bindParams(`${ADMIN_SELECT} where d.chain_id = $1`, [chain.chainId], clusterWhere(chain));
  const result = await db.query(`${bound.sql} order by d.catalog_state = 'ACTIVE' desc, a.asset_class, a.symbol nulls last`, bound.params);
  const items = result.rows.map(mapAdminRow);
  const stockRegistry = ROBINHOOD_CHAIN_IDS.has(chain.chainId)
    ? await listRobinhoodStockRegistry({ chainId: Number(chain.chainId) }).catch(() => [])
    : [];
  return { chain, items, stockRegistry };
}

export async function listQuoteCatalogChains({ db = pool } = {}) {
  const counts = await db.query(
    `select chain_id, coalesce(network_cluster, 'mainnet-beta') as cluster, chain_family, catalog_state, count(*)::int as n
       from public.quote_asset_deployments group by 1, 2, 3, 4`,
  );
  return QUOTE_CATALOG_CHAINS.map((chain) => {
    const rows = counts.rows.filter((row) => String(row.chain_id) === chain.chainId && (chain.family !== "SOLANA" || row.cluster === chain.cluster));
    const sum = (predicate) => rows.filter(predicate).reduce((total, row) => total + Number(row.n), 0);
    return {
      ...chain,
      counts: {
        total: sum(() => true),
        active: sum((row) => row.catalog_state === "ACTIVE"),
        candidate: sum((row) => !["ACTIVE", "SUSPENDED", "REJECTED"].includes(row.catalog_state)),
        suspended: sum((row) => row.catalog_state === "SUSPENDED"),
        rejected: sum((row) => row.catalog_state === "REJECTED"),
      },
    };
  });
}

export async function getQuoteCatalogAdminDetail(id, { db = pool } = {}) {
  const result = await db.query(`${ADMIN_SELECT} where d.id = $1::uuid limit 1`, [id]);
  if (!result.rows[0]) return null;
  const item = mapAdminRow(result.rows[0]);
  const [policies, scans, decisions] = await Promise.all([
    db.query(
      `select id, policy_key, version, policy_status, basic_approved, new_graduation_enabled, deployment_id, policy_config, created_at
         from public.quote_asset_policy_versions where quote_asset_id = $1::uuid and (deployment_id = $2::uuid or deployment_id is null)
        order by created_at desc limit 50`,
      [item.assetId, id],
    ),
    db.query(
      `select id, state_version, scan_kind, identity_status, security_status, market_health_status, evidence, scanner_identity, created_at
         from public.quote_asset_scan_history where deployment_id = $1::uuid order by created_at desc limit 100`,
      [id],
    ),
    db.query(
      `select id, policy_version_id, state_version, decision, reason, decision_snapshot, actor_identity, created_at
         from public.quote_asset_decision_history where deployment_id = $1::uuid order by created_at desc limit 100`,
      [id],
    ),
  ]);
  return { item, policies: policies.rows, scans: scans.rows, decisions: decisions.rows };
}

/** Validates and normalizes a candidate submitted from the dashboard. Pure. */
export function normalizeCandidateInput(input = {}) {
  const chain = resolveQuoteCatalogChain(input.chain);
  const providerKey = text(input.providerKey).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(providerKey)) throw new QuoteCatalogAdminError("providerKey must be a lowercase slug.", { code: "QUOTE_CATALOG_PROVIDER_INVALID" });
  const symbol = text(input.symbol);
  if (!symbol || symbol.length > 24) throw new QuoteCatalogAdminError("symbol is required (max 24 chars).", { code: "QUOTE_CATALOG_SYMBOL_INVALID" });
  const assetClass = text(input.assetClass).toUpperCase();
  if (!ASSET_CLASSES.includes(assetClass)) throw new QuoteCatalogAdminError(`assetClass must be one of ${ASSET_CLASSES.join(", ")}.`, { code: "QUOTE_CATALOG_ASSET_CLASS_INVALID" });
  const category = text(input.category).toUpperCase();
  if (!CATEGORIES.includes(category)) throw new QuoteCatalogAdminError(`category must be one of ${CATEGORIES.join(", ")}.`, { code: "QUOTE_CATALOG_CATEGORY_INVALID" });
  const providerClass = text(input.providerClass || "ECOSYSTEM").toUpperCase();
  if (!PROVIDER_CLASSES.includes(providerClass)) throw new QuoteCatalogAdminError(`providerClass must be one of ${PROVIDER_CLASSES.join(", ")}.`, { code: "QUOTE_CATALOG_PROVIDER_CLASS_INVALID" });
  const decimals = Number(input.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new QuoteCatalogAdminError("decimals must be an integer between 0 and 36.", { code: "QUOTE_CATALOG_DECIMALS_INVALID" });
  const rawAddress = text(input.contractAddressOrMint);
  const isNative = assetClass === "NATIVE" && (!rawAddress || /^native(:|$)/i.test(rawAddress));
  let identity;
  if (isNative) {
    const key = chain.cluster === "devnet" ? `native:${chain.chainId}:devnet` : `native:${chain.chainId}`;
    identity = { identityKind: "NATIVE", contractAddressOrMint: `native:${chain.chainId}`, identityKey: key };
  } else {
    if (!rawAddress) throw new QuoteCatalogAdminError("contractAddressOrMint is required.", { code: "QUOTE_CATALOG_IDENTITY_INVALID" });
    try {
      identity = normalizeQuoteIdentity({ chainId: chain.chainId, identityKind: chain.family === "SOLANA" ? "SOLANA_MINT" : "EVM_ADDRESS", contractAddressOrMint: rawAddress });
    } catch (error) {
      throw new QuoteCatalogAdminError(String(error?.message || "Invalid identity."), { code: "QUOTE_CATALOG_IDENTITY_INVALID" });
    }
    if (chain.cluster === "devnet") identity = { ...identity, identityKey: `${identity.identityKey}:devnet` };
  }
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => text(tag).toUpperCase()).filter(Boolean) : text(input.tags) ? text(input.tags).split(",").map((tag) => tag.trim().toUpperCase()).filter(Boolean) : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence.map(text).filter(Boolean) : text(input.evidence) ? text(input.evidence).split(/\s+/).filter(Boolean) : [];
  const wrapped = assetClass === "NATIVE" ? (isNative ? "NATIVE" : "WRAPPED_NATIVE") : "NONE";
  return {
    chain,
    providerKey,
    providerDisplayName: text(input.providerDisplayName) || providerKey,
    providerClass,
    symbol,
    displayName: text(input.displayName) || symbol,
    assetClass,
    category,
    assetKey: text(input.providerAssetId || symbol).toLowerCase(),
    providerAssetId: text(input.providerAssetId) || null,
    logoUrl: text(input.logoUrl) || null,
    tags,
    decimals,
    identity,
    nativeWrappedStatus: wrapped,
    evidence,
    reason: text(input.reason),
  };
}

export async function createQuoteCatalogCandidate(input, { actorIdentity, db = pool } = {}) {
  const candidate = normalizeCandidateInput(input);
  if (!candidate.reason) throw new QuoteCatalogAdminError("reason is required.", { code: "REASON_REQUIRED" });
  const client = await db.connect();
  try {
    await client.query("begin");
    let provider = (await client.query(`select id, authority_mode from public.quote_asset_providers where provider_key = $1`, [candidate.providerKey])).rows[0];
    if (provider && provider.authority_mode !== "GENERIC_POLICY") throw new QuoteCatalogAdminError(`Provider ${candidate.providerKey} is registry-driven; add its assets through the registry.`, { code: "QUOTE_CATALOG_PROVIDER_REGISTRY", httpStatus: 409 });
    if (!provider) {
      provider = (await client.query(
        `insert into public.quote_asset_providers (provider_key, display_name, authority_mode, provider_class, admin_state, state_version)
         values ($1, $2, 'GENERIC_POLICY', $3, 'enabled', 1) returning id, authority_mode`,
        [candidate.providerKey, candidate.providerDisplayName, candidate.providerClass],
      )).rows[0];
    }
    let asset = (await client.query(`select id, symbol, display_name, category, logo_url, tags::text as tags from public.quote_assets where provider_id = $1 and asset_key = $2`, [provider.id, candidate.assetKey])).rows[0];
    if (asset) {
      // Same logical asset (provider + key) seen again, e.g. on another chain or
      // cluster: refresh its presentation so the picker shows what the operator
      // just entered rather than a stale category from an earlier import.
      const same = asset.symbol === candidate.symbol && asset.display_name === candidate.displayName && asset.category === candidate.category
        && (asset.logo_url || null) === candidate.logoUrl && JSON.stringify(JSON.parse(asset.tags || "[]")) === JSON.stringify(candidate.tags);
      if (!same) {
        await client.query(
          `update public.quote_assets set symbol = $2, display_name = $3, category = $4, logo_url = coalesce($5, logo_url), tags = $6::jsonb, state_version = state_version + 1, updated_at = now() where id = $1`,
          [asset.id, candidate.symbol, candidate.displayName, candidate.category, candidate.logoUrl, JSON.stringify(candidate.tags)],
        );
      }
    }
    if (!asset) {
      asset = (await client.query(
        `insert into public.quote_assets (provider_id, asset_key, asset_class, symbol, display_name, logo_url, category, tags, provider_asset_id, admin_state, state_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'enabled', 1) returning id`,
        [provider.id, candidate.assetKey, candidate.assetClass, candidate.symbol, candidate.displayName, candidate.logoUrl, candidate.category, JSON.stringify(candidate.tags), candidate.providerAssetId],
      )).rows[0];
    }
    const existing = (await client.query(
      `select id from public.quote_asset_deployments where provider_id = $1 and chain_id = $2 and identity_key = $3`,
      [provider.id, candidate.chain.chainId, candidate.identity.identityKey],
    )).rows[0];
    if (existing) throw new QuoteCatalogAdminError("This asset is already in the catalog on this chain.", { code: "QUOTE_CATALOG_DEPLOYMENT_EXISTS", httpStatus: 409, current: { id: existing.id } });
    const inserted = (await client.query(
      `insert into public.quote_asset_deployments (
         quote_asset_id, provider_id, chain_id, chain_family, network_cluster, identity_kind, contract_address_or_mint, identity_key, decimals,
         identity_status, security_status, market_health_status, existing_market_support,
         canonical_status, native_wrapped_status, transferability_status, acquisition_route_status, price_authority_status, lp_venue_status,
         catalog_state, evidence_sources, admin_state, state_version
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         'pending', 'pending', 'pending', false,
         'CANDIDATE', $10, 'PENDING', 'PENDING', 'PENDING', 'PENDING',
         'CANDIDATE', $11::jsonb, 'enabled', 1) returning id`,
      [asset.id, provider.id, candidate.chain.chainId, candidate.chain.family, candidate.chain.cluster, candidate.identity.identityKind, candidate.identity.contractAddressOrMint, candidate.identity.identityKey, candidate.decimals, candidate.nativeWrappedStatus, JSON.stringify(candidate.evidence)],
    )).rows[0];
    await client.query(
      `insert into public.quote_asset_decision_history (deployment_id, provider_id, policy_version_id, state_version, decision, reason, decision_snapshot, actor_identity)
       values ($1, $2, null, 1, 'review', $3, $4::jsonb, $5)`,
      [inserted.id, provider.id, candidate.reason, JSON.stringify({ action: "create_candidate", chain: candidate.chain.key, symbol: candidate.symbol, identity: candidate.identity }), actorIdentity],
    );
    await client.query("commit");
    return await getQuoteCatalogAdminDetail(inserted.id, { db });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error?.code === "23505") throw new QuoteCatalogAdminError("This asset is already in the catalog on this chain.", { code: "QUOTE_CATALOG_DEPLOYMENT_EXISTS", httpStatus: 409 });
    throw error;
  } finally {
    client.release();
  }
}

/** The policy config an approval activates: the sync's shape plus operator overrides (price source, route). Pure. */
export function buildApprovedPolicyConfig(item, overrides = {}) {
  const chainFamily = item.chainFamily || (item.identityKind === "SOLANA_MINT" || (item.identityKind === "NATIVE" && String(item.chainId) === "101") ? "SOLANA" : "EVM");
  const base = policyConfigFor(
    { decimals: item.decimals, assetClass: item.assetClass },
    chainFamily,
    { identityKind: item.identityKind, contractAddressOrMint: item.contractAddressOrMint },
  );
  const key = chainFamily === "SOLANA" ? "solanaGraduation" : "evmGraduation";
  const allowed = ["coinGeckoId", "binanceSymbol", "referenceUsdMicros", "acquisitionProgram", "acquisitionAdapter", "orcaPool", "routerAddress", "oracleFeedAddress", "maxSlippageBps", "maxImpactBps", "maxDeviationBps"];
  const patch = {};
  for (const field of allowed) {
    if (overrides[field] == null || overrides[field] === "") continue;
    patch[field] = /Bps$|Micros$/.test(field) ? Number(overrides[field]) : String(overrides[field]).trim();
    if (/Bps$|Micros$/.test(field) && (!Number.isFinite(patch[field]) || patch[field] < 0)) throw new QuoteCatalogAdminError(`${field} must be a non-negative number.`, { code: "QUOTE_CATALOG_POLICY_INVALID" });
  }
  for (const field of ["maxSlippageBps", "maxImpactBps", "maxDeviationBps"]) {
    if (patch[field] != null && patch[field] > 300) throw new QuoteCatalogAdminError(`${field} may not exceed 300 bps.`, { code: "QUOTE_CATALOG_POLICY_INVALID" });
  }
  // Adapter-specific keys (Orca devnet pool config, Topaz pool ids ...) are
  // passed through as scalars; nothing here can override the mint or decimals.
  const adapter = {};
  if (overrides.adapterConfig && typeof overrides.adapterConfig === "object") {
    for (const [field, value] of Object.entries(overrides.adapterConfig)) {
      if (["quoteMint", "quoteToken", "decimals", "native", "chainId", "cluster"].includes(field)) continue;
      if (["string", "number", "boolean"].includes(typeof value)) adapter[field] = value;
    }
  }
  const merged = { ...base[key], ...adapter, ...patch, chainId: String(item.chainId) };
  if (item.solanaCluster) merged.cluster = item.solanaCluster;
  return { [key]: merged };
}

async function lockDeployment(client, id) {
  const result = await client.query(`select id, quote_asset_id, provider_id, chain_id, state_version, catalog_state from public.quote_asset_deployments where id = $1::uuid for update`, [id]);
  return result.rows[0] || null;
}

async function retireActivePolicies(client, { assetId, deploymentId }) {
  await client.query(
    `update public.quote_asset_policy_versions
        set policy_status = 'retired', basic_approved = false, new_graduation_enabled = false
      where quote_asset_id = $1::uuid and policy_status = 'active' and (deployment_id = $2::uuid or deployment_id is null)`,
    [assetId, deploymentId],
  );
}

/**
 * One operator decision on a deployment. `approve` attests every gate and
 * activates a deployment-bound policy; `suspend` and `reject` take it out of
 * new graduations; `review` reopens it as a candidate.
 */
export async function decideQuoteCatalogDeployment({ id, action, expectedVersion, reason, policyOverrides = {}, evidence = [], actorIdentity, db = pool }) {
  if (!QUOTE_CATALOG_ACTIONS.includes(action)) throw new QuoteCatalogAdminError(`Unknown action ${action}.`, { code: "QUOTE_CATALOG_ACTION_UNKNOWN", httpStatus: 404 });
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) throw new QuoteCatalogAdminError("expectedVersion is required.", { code: "EXPECTED_VERSION_REQUIRED" });
  const why = text(reason);
  if (!why) throw new QuoteCatalogAdminError("reason is required.", { code: "REASON_REQUIRED" });
  const client = await db.connect();
  try {
    await client.query("begin");
    const row = await lockDeployment(client, id);
    if (!row) { await client.query("rollback"); return null; }
    const before = (await getQuoteCatalogAdminDetail(id, { db: client }))?.item;
    if (Number(row.state_version) !== version) throw new QuoteCatalogAdminError("Catalog entry changed since you loaded it.", { code: "STATE_VERSION_CONFLICT", httpStatus: 409, current: before });
    const nextVersion = version + 1;
    let decision;
    let policyVersionId = null;

    if (action === "approve") {
      const evidenceList = (Array.isArray(evidence) ? evidence : []).map(text).filter(Boolean);
      await client.query(
        `update public.quote_asset_deployments
            set catalog_state = 'ACTIVE', admin_state = 'enabled',
                identity_status = 'verified', security_status = 'verified', market_health_status = 'healthy',
                canonical_status = case when canonical_status in ('CANDIDATE', 'NONE', '') or canonical_status is null then 'IDENTITY_VERIFIED' else canonical_status end,
                transferability_status = 'VERIFIED', acquisition_route_status = 'VERIFIED', price_authority_status = 'VERIFIED', lp_venue_status = 'VERIFIED',
                existing_market_support = true,
                evidence_sources = (select coalesce(jsonb_agg(distinct value), '[]'::jsonb) from jsonb_array_elements(coalesce(evidence_sources, '[]'::jsonb) || $2::jsonb)),
                last_scan_at = now(), last_identity_verified_at = now(), last_security_verified_at = now(), last_route_verified_at = now(), last_price_verified_at = now(), last_lp_verified_at = now(),
                state_version = $3, updated_at = now()
          where id = $1::uuid`,
        [id, JSON.stringify(evidenceList), nextVersion],
      );
      await client.query(
        `insert into public.quote_asset_scan_history (deployment_id, provider_id, state_version, scan_kind, identity_status, security_status, market_health_status, evidence, scanner_identity)
         values ($1, $2, $3, 'operator_attestation', 'verified', 'verified', 'healthy', $4::jsonb, $5)`,
        [id, row.provider_id, nextVersion, JSON.stringify({ reason: why, evidence: evidenceList }), actorIdentity],
      );
      await retireActivePolicies(client, { assetId: row.quote_asset_id, deploymentId: id });
      // No operator overrides: use what the automated verification proposed,
      // so a one-click approval carries verified ids and addresses.
      const givenOverrides = policyOverrides && typeof policyOverrides === "object"
        ? Object.fromEntries(Object.entries(policyOverrides).filter(([, value]) => value != null && value !== "" && !(typeof value === "object" && !Object.keys(value).length)))
        : {};
      const effectiveOverrides = Object.keys(givenOverrides).length ? givenOverrides : (before?.verification?.proposal || {});
      const config = buildApprovedPolicyConfig(before, effectiveOverrides);
      const previous = (await client.query(
        `select policy_key, max(version)::int as version from public.quote_asset_policy_versions
          where quote_asset_id = $1::uuid and (deployment_id = $2::uuid or deployment_id is null) group by policy_key order by max(created_at) desc limit 1`,
        [row.quote_asset_id, id],
      )).rows[0];
      const policyKey = previous?.policy_key || `${before.provider.key}-${before.assetKey}-${row.chain_id}${before.solanaCluster === "devnet" ? "-devnet" : ""}-v1`;
      const maxVersion = (await client.query(`select coalesce(max(version), 0)::int as version from public.quote_asset_policy_versions where provider_id = $1 and policy_key = $2`, [row.provider_id, policyKey])).rows[0];
      const inserted = (await client.query(
        `insert into public.quote_asset_policy_versions (quote_asset_id, provider_id, deployment_id, policy_key, version, policy_status, basic_approved, new_graduation_enabled, require_identity_verified, require_security_verified, require_market_healthy, policy_config)
         values ($1::uuid, $2, $3::uuid, $4, $5, 'active', true, true, true, true, true, $6::jsonb) returning id`,
        [row.quote_asset_id, row.provider_id, id, policyKey, Number(maxVersion.version) + 1, JSON.stringify(config)],
      )).rows[0];
      policyVersionId = inserted.id;
      decision = "eligible";
    } else if (action === "suspend") {
      await client.query(`update public.quote_asset_deployments set catalog_state = 'SUSPENDED', admin_state = 'disabled', state_version = $2, updated_at = now() where id = $1::uuid`, [id, nextVersion]);
      decision = "disabled";
    } else if (action === "reject") {
      await client.query(`update public.quote_asset_deployments set catalog_state = 'REJECTED', admin_state = 'disabled', identity_status = case when identity_status = 'verified' then identity_status else 'rejected' end, state_version = $2, updated_at = now() where id = $1::uuid`, [id, nextVersion]);
      await retireActivePolicies(client, { assetId: row.quote_asset_id, deploymentId: id });
      decision = "ineligible";
    } else {
      await client.query(`update public.quote_asset_deployments set catalog_state = 'CANDIDATE', admin_state = 'enabled', market_health_status = 'review', state_version = $2, updated_at = now() where id = $1::uuid`, [id, nextVersion]);
      await retireActivePolicies(client, { assetId: row.quote_asset_id, deploymentId: id });
      decision = "review";
    }

    const after = (await getQuoteCatalogAdminDetail(id, { db: client }))?.item;
    await client.query(
      `insert into public.quote_asset_decision_history (deployment_id, provider_id, policy_version_id, state_version, decision, reason, decision_snapshot, actor_identity)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [id, row.provider_id, policyVersionId, nextVersion, decision, why, JSON.stringify({ action, before: { catalogState: before?.catalogState, eligible: before?.newGraduationEligible, stateVersion: version }, after: { catalogState: after?.catalogState, eligible: after?.newGraduationEligible, stateVersion: nextVersion }, policyOverrides, verificationState: before?.verification?.state || null }), actorIdentity],
    );
    await client.query("commit");
    return await getQuoteCatalogAdminDetail(id, { db });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function normalizeClusterKey(value) {
  return normalizeSolanaCluster(value);
}

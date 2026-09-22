import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import {
  getRobinhoodStockRegistryDetail,
  listRobinhoodStockRegistry,
  ROBINHOOD_MAINNET_CHAIN_ID,
} from "./robinhoodStockGraduationRegistry.js";

export const QUOTE_ASSET_CLASSES = Object.freeze([
  "NATIVE",
  "STABLECOIN",
  "PROVIDER_RWA",
  "MWZ_NATIVE",
  "COMMUNITY",
]);

export const ROBINHOOD_STOCK_PROVIDER_KEY = "robinhood-stock-token";
export const ROBINHOOD_BASIC_PROVIDER_KEY = "robinhood-basic";
export const ROBINHOOD_STOCK_COMPAT_PREFIX = "rh-stock:";

function normalizeEnum(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || fallback;
}

/** 'devnet' or 'mainnet-beta'; anything else (mainnet, empty) is mainnet-beta. */
export function normalizeSolanaCluster(value) {
  return String(value || "").trim().toLowerCase() === "devnet" ? "devnet" : "mainnet-beta";
}

/** The Solana cluster this API serves: catalog rows on chain 101 tagged for another cluster are invisible here. */
export function runtimeSolanaCluster() {
  return normalizeSolanaCluster(process.env.SOLANA_CLUSTER || process.env.VITE_SOLANA_CLUSTER || "mainnet-beta");
}

export function normalizeQuoteIdentity({ chainId, identityKind, contractAddressOrMint }) {
  const chain = String(chainId ?? "").trim();
  if (!chain) throw new Error("Quote asset chainId is required");
  const kind = String(identityKind || "").trim().toUpperCase();
  const raw = String(contractAddressOrMint || "").trim();
  if (kind === "EVM_ADDRESS") {
    if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error("Quote asset EVM address is invalid");
    return { chainId: chain, identityKind: kind, identityKey: ethers.getAddress(raw).toLowerCase(), contractAddressOrMint: ethers.getAddress(raw) };
  }
  if (kind === "SOLANA_MINT") {
    if (!raw || raw.length < 32 || raw.length > 64) throw new Error("Quote asset Solana mint is invalid");
    return { chainId: chain, identityKind: kind, identityKey: raw, contractAddressOrMint: raw };
  }
  if (kind === "NATIVE") {
    return { chainId: chain, identityKind: kind, identityKey: `native:${chain}`, contractAddressOrMint: `native:${chain}` };
  }
  throw new Error("Quote asset identity kind is unsupported");
}

export function deriveGenericQuoteAuthority({ provider, asset, deployment, policy }) {
  const providerEnabled = normalizeEnum(provider?.admin_state, "disabled") === "enabled";
  const assetEnabled = normalizeEnum(asset?.admin_state, "disabled") === "enabled";
  const deploymentEnabled = normalizeEnum(deployment?.admin_state, "disabled") === "enabled";
  const policyActive = normalizeEnum(policy?.policy_status, "draft") === "active";
  const basicApproved = policy?.basic_approved === true;
  const identityPass = policy?.require_identity_verified === false || deployment?.identity_status === "verified";
  const securityPass = policy?.require_security_verified === false || deployment?.security_status === "verified";
  const marketPass = policy?.require_market_healthy === false || deployment?.market_health_status === "healthy";
  const newGraduationEligible = Boolean(
    providerEnabled &&
      assetEnabled &&
      deploymentEnabled &&
      policyActive &&
      basicApproved &&
      policy?.new_graduation_enabled === true &&
      identityPass &&
      securityPass &&
      marketPass
  );
  return {
    newGraduationEligible,
    existingMarketSupport: Boolean(providerEnabled && assetEnabled && deploymentEnabled && deployment?.existing_market_support === true),
    identityStatus: deployment?.identity_status || "pending",
    securityStatus: deployment?.security_status || "pending",
    marketHealthStatus: deployment?.market_health_status || "pending",
    policyVersion: policy?.version ? Number(policy.version) : null,
    policyKey: policy?.policy_key || null,
    policyActive,
    basicApproved,
  };
}

export function mapRobinhoodStockToQuoteAsset(stock) {
  return {
    id: `${ROBINHOOD_STOCK_COMPAT_PREFIX}${stock.id}`,
    assetId: null,
    provider: {
      key: ROBINHOOD_STOCK_PROVIDER_KEY,
      displayName: "Robinhood Stock Token Registry",
      authorityMode: "ROBINHOOD_STOCK_REGISTRY",
      providerClass: "PROVIDER_RWA",
    },
    chainId: String(stock.chainId),
    identityKind: "EVM_ADDRESS",
    contractAddressOrMint: stock.contractAddress,
    assetClass: "PROVIDER_RWA",
    symbol: stock.symbol,
    displayName: stock.displayName,
    stateVersion: Number(stock.stateVersion || 0),
    identityStatus: stock.canonical ? "verified" : "rejected",
    securityStatus: stock.automatedHealthStatus === "healthy" ? "verified" : stock.automatedHealthStatus === "review" ? "review" : "rejected",
    marketHealthStatus: stock.marketStatus === "eligible" ? "healthy" : stock.automatedHealthStatus || "stale",
    newGraduationEligible: stock.enabledForGraduation === true,
    existingMarketSupport: stock.enabledForTrading === true || stock.existingMarketSupport === true,
    adminState: stock.adminState,
    policy: {
      authority: "delegated",
      source: "robinhood_stock_token_registry",
      policyKey: "robinhood-stock-authority",
      version: Number(stock.stateVersion || 0),
    },
    lastVerifiedAt: stock.lastVerifiedAt,
  };
}

function mapGenericRow(row) {
  const provider = {
    id: row.provider_id,
    provider_key: row.provider_key,
    admin_state: row.provider_admin_state,
  };
  const asset = {
    id: row.quote_asset_id,
    admin_state: row.asset_admin_state,
  };
  const deployment = {
    admin_state: row.deployment_admin_state,
    identity_status: row.identity_status,
    security_status: row.security_status,
    market_health_status: row.market_health_status,
    existing_market_support: row.existing_market_support,
  };
  const policy = {
    id: row.policy_version_id,
    policy_key: row.policy_key,
    version: row.policy_version,
    policy_status: row.policy_status,
    basic_approved: row.basic_approved,
    new_graduation_enabled: row.new_graduation_enabled,
    require_identity_verified: row.require_identity_verified,
    require_security_verified: row.require_security_verified,
    require_market_healthy: row.require_market_healthy,
  };
  const authority = deriveGenericQuoteAuthority({ provider, asset, deployment, policy });
  return {
    id: row.deployment_id,
    assetId: row.quote_asset_id,
    provider: {
      id: row.provider_id,
      key: row.provider_key,
      displayName: row.provider_display_name,
      authorityMode: row.authority_mode,
      providerClass: row.provider_class,
    },
    chainId: String(row.chain_id),
    solanaCluster: row.chain_id === "101" || row.chain_family === "SOLANA" ? String(row.network_cluster || "mainnet-beta") : null,
    identityKind: row.identity_kind,
    contractAddressOrMint: row.contract_address_or_mint,
    assetClass: row.asset_class,
    symbol: row.symbol,
    displayName: row.display_name,
    logoUrl: row.logo_url,
    category: row.category || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    providerAssetId: row.provider_asset_id || null,
    decimals: row.decimals == null ? null : Number(row.decimals),
    catalogState: row.catalog_state || null,
    chainFamily: row.chain_family || null,
    stateVersion: Number(row.deployment_state_version),
    identityStatus: authority.identityStatus,
    securityStatus: authority.securityStatus,
    marketHealthStatus: authority.marketHealthStatus,
    newGraduationEligible: authority.newGraduationEligible,
    existingMarketSupport: authority.existingMarketSupport,
    adminState: row.deployment_admin_state,
    policy: {
      authority: "generic",
      id: row.policy_version_id,
      policyKey: authority.policyKey,
      version: authority.policyVersion,
      active: authority.policyActive,
      basicApproved: authority.basicApproved,
      newGraduationEnabled: row.new_graduation_enabled === true,
      requireIdentityVerified: row.require_identity_verified !== false,
      requireSecurityVerified: row.require_security_verified !== false,
      requireMarketHealthy: row.require_market_healthy !== false,
      config: row.policy_config || {},
    },
    lastVerifiedAt: row.last_scan_at,
    bindingRisks: bindingRisksFromVerification(row.verification),
  };
}

/**
 * The issuer powers the verifier found on this mint, for the creator-facing
 * catalog.
 *
 * Graduation accepts every asset the catalog approves, whatever its issuer can
 * do, so the only place those powers can still change a decision is in front of
 * the person making it. They are read back out of the verification snapshot
 * rather than recomputed: the scan is what the gate saw, and showing anything
 * else would be showing a different fact than the one on file.
 */
export function bindingRisksFromVerification(verification) {
  const risks = verification?.metrics?.bindingRisks;
  return Array.isArray(risks) ? risks : [];
}

export const GENERIC_SELECT = `
select
  d.id as deployment_id,
  d.quote_asset_id,
  d.provider_id,
  d.chain_id,
  d.identity_kind,
  d.contract_address_or_mint,
  d.chain_family,
  d.network_cluster,
  d.identity_status,
  d.security_status,
  d.market_health_status,
  d.existing_market_support,
  d.admin_state as deployment_admin_state,
  d.state_version as deployment_state_version,
  d.last_scan_at,
  d.verification,
  a.asset_class,
  a.symbol,
  a.display_name,
  a.logo_url,
  a.category,
  a.tags,
  a.provider_asset_id,
  d.decimals,
  d.catalog_state,
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
  pv.policy_config
from public.quote_asset_deployments d
join public.quote_assets a on a.id = d.quote_asset_id
join public.quote_asset_providers p on p.id = d.provider_id and p.id = a.provider_id
left join public.quote_asset_policy_versions pv
  on pv.quote_asset_id = a.id
 and pv.policy_status = 'active'
 and (pv.deployment_id = d.id or pv.deployment_id is null)
`;

/** Chain-101 rows belong to one Solana cluster; only the runtime's cluster is authoritative here. */
const CLUSTER_WHERE = `(d.chain_id <> '101' or coalesce(d.network_cluster, 'mainnet-beta') = $CLUSTER)`;

export async function listGenericQuoteAssets({ chainId }) {
  const chain = String(chainId ?? "").trim();
  if (!chain) throw new Error("chainId is required");
  const result = await pool.query(
    `${GENERIC_SELECT} where d.chain_id = $1 and ${CLUSTER_WHERE.replace("$CLUSTER", "$2")} order by a.asset_class, a.symbol nulls last, a.display_name`,
    [chain, runtimeSolanaCluster()],
  );
  return result.rows.map(mapGenericRow).filter((item) => item.policy.basicApproved && (item.newGraduationEligible || item.existingMarketSupport));
}

export async function getGenericQuoteAssetDetail(id) {
  const result = await pool.query(
    `${GENERIC_SELECT} where d.id = $1::uuid and ${CLUSTER_WHERE.replace("$CLUSTER", "$2")} limit 1`,
    [id, runtimeSolanaCluster()],
  );
  if (!result.rows[0]) return null;
  const item = mapGenericRow(result.rows[0]);
  const [scans, decisions] = await Promise.all([
    pool.query(`select id, state_version, scan_kind, identity_status, security_status, market_health_status, evidence, scanner_identity, created_at from public.quote_asset_scan_history where deployment_id = $1::uuid order by created_at desc limit 200`, [id]),
    pool.query(`select id, policy_version_id, state_version, decision, reason, decision_snapshot, actor_identity, created_at from public.quote_asset_decision_history where deployment_id = $1::uuid order by created_at desc limit 200`, [id]),
  ]);
  return { item, history: { scans: scans.rows, decisions: decisions.rows } };
}

export async function listGraduationQuoteAssets({ chainId }) {
  const chain = String(chainId ?? "").trim();
  if (!chain) throw new Error("chainId is required");
  const genericItems = await listGenericQuoteAssets({ chainId: chain });
  if (Number(chain) !== ROBINHOOD_MAINNET_CHAIN_ID) return genericItems;
  const stockItems = await listRobinhoodStockRegistry({ chainId: ROBINHOOD_MAINNET_CHAIN_ID, publicOnly: true });
  return [...genericItems, ...stockItems.map(mapRobinhoodStockToQuoteAsset)];
}

export async function getGraduationQuoteAssetDetail(id) {
  const raw = String(id || "").trim();
  if (!raw) return null;
  if (raw.startsWith(ROBINHOOD_STOCK_COMPAT_PREFIX)) {
    const stockId = raw.slice(ROBINHOOD_STOCK_COMPAT_PREFIX.length);
    const detail = await getRobinhoodStockRegistryDetail(stockId);
    if (!detail) return null;
    return {
      item: mapRobinhoodStockToQuoteAsset(detail.item),
      compatibility: {
        source: "robinhood_stock_token_registry",
        stockActionPolicy: detail.actionPolicy,
        stockHistory: detail.history,
      },
    };
  }
  return getGenericQuoteAssetDetail(raw);
}

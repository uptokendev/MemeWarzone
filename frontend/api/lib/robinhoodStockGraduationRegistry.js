import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getServerReadProvider } from "./getServerReadProvider.js";
import {
  certifyRobinhoodStockRuntime,
  isExactRobinhoodReleaseCandidate,
} from "./robinhoodStockRuntimeCertification.js";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_CANONICAL_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
export const ROBINHOOD_RUNTIME_CERTIFICATION_VERSION = "runtime-parity-v1";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function healthMaxAgeSeconds() {
  const parsed = Number(process.env.ROBINHOOD_STOCK_HEALTH_MAX_AGE_SECONDS || 900);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 900;
}

export function normalizeStockAddress(value) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) return "";
  return ethers.getAddress(raw);
}

export function robinhoodAssetIsActive(status) {
  return String(status || "").trim().toUpperCase() === "ASSET_STATUS_ACTIVE";
}

export function deriveTradingHalted(asset) {
  const capabilities = asset?.tradingCapabilities;
  if (!capabilities || typeof capabilities !== "object") return null;
  const statuses = [];
  for (const session of Object.values(capabilities)) {
    if (!session || typeof session !== "object") continue;
    for (const value of Object.values(session)) {
      if (typeof value === "string") statuses.push(value.toUpperCase());
    }
  }
  if (!statuses.length) return null;
  if (statuses.some((status) => status.includes("HALT"))) return true;
  return !statuses.some((status) => status === "TRADING_STATUS_TRADABLE");
}

export function parseCanonicalRobinhoodDeployments(payload) {
  const assets = Array.isArray(payload) ? payload : Array.isArray(payload?.assets) ? payload.assets : [];
  const rows = [];
  for (const asset of assets) {
    const deployments = Array.isArray(asset?.deployments) ? asset.deployments : [];
    for (const deployment of deployments) {
      if (Number(deployment?.chainId) !== ROBINHOOD_MAINNET_CHAIN_ID) continue;
      const contractAddress = normalizeStockAddress(deployment?.contractAddress);
      if (!contractAddress) continue;
      const symbol = String(asset?.tokenSymbol || asset?.symbol || "").trim().toUpperCase();
      const displayName = String(asset?.tokenName || asset?.displayName || symbol).trim();
      if (!symbol || !displayName) continue;
      rows.push({
        chainId: ROBINHOOD_MAINNET_CHAIN_ID,
        robinhoodAssetUid: String(asset?.id || asset?.uid || "").trim() || null,
        contractAddress,
        symbol,
        displayName,
        underlyingSymbol: String(asset?.underlyingSymbol || symbol).trim().toUpperCase(),
        robinhoodStatus: String(asset?.status || "UNKNOWN").trim() || "UNKNOWN",
        tradingHalted: deriveTradingHalted(asset),
      });
    }
  }
  return rows;
}

export function isHealthFresh(row, now = Date.now()) {
  if (!row?.last_health_check_at) return false;
  const checked = new Date(row.last_health_check_at).getTime();
  if (!Number.isFinite(checked)) return false;
  return now - checked <= healthMaxAgeSeconds() * 1000;
}

export function deriveEffectiveAuthority(row, { healthFresh = isHealthFresh(row) } = {}) {
  const hardSafe = Boolean(
    row?.canonical === true &&
    robinhoodAssetIsActive(row?.robinhood_status) &&
    row?.trading_halted !== true &&
    row?.automated_health_status === "healthy" &&
    row?.health_certification_version === ROBINHOOD_RUNTIME_CERTIFICATION_VERSION &&
    healthFresh &&
    row?.route_enabled === true &&
    normalizeStockAddress(row?.oracle_feed_address) &&
    normalizeStockAddress(row?.acquisition_pool_address)
  );
  const adminState = String(row?.admin_state || "default");
  const adminEligible = adminState === "force_enabled" || (adminState === "default" && row?.candidate === true);
  return {
    hardSafe,
    enabledForGraduation: hardSafe && adminEligible && adminState !== "force_disabled",
    enabledForDiscovery: Boolean(row?.canonical === true && (row?.candidate === true || adminState === "force_enabled") && adminState !== "force_disabled"),
    enabledForTrading: Boolean(row?.existing_market_support === true),
  };
}

function rowToAsset(row) {
  const authority = deriveEffectiveAuthority(row);
  return {
    id: row.id,
    chainId: Number(row.chain_id),
    robinhoodAssetUid: row.robinhood_asset_uid,
    contractAddress: row.contract_address,
    symbol: row.symbol,
    displayName: row.display_name,
    underlyingSymbol: row.underlying_symbol || row.symbol,
    canonical: row.canonical === true,
    robinhoodStatus: row.robinhood_status,
    tradingHalted: row.trading_halted,
    candidate: row.candidate === true,
    adminState: row.admin_state,
    automatedHealthStatus: row.automated_health_status,
    automatedHealthReason: row.automated_health_reason,
    healthCertificationVersion: row.health_certification_version || null,
    certificationEvidence: row.certification_evidence || null,
    existingMarketSupport: row.existing_market_support === true,
    stateVersion: Number(row.state_version),
    oracleFeedAddress: row.oracle_feed_address,
    acquisitionPoolAddress: row.acquisition_pool_address,
    routeEnabled: row.route_enabled,
    enabledForGraduation: authority.enabledForGraduation,
    enabledForDiscovery: authority.enabledForDiscovery,
    enabledForTrading: authority.enabledForTrading,
    marketStatus: authority.enabledForGraduation ? "eligible" : row.automated_health_status,
    lastCanonicalSyncAt: row.last_canonical_sync_at,
    lastHealthCheckAt: row.last_health_check_at,
    lastVerifiedAt: row.last_health_check_at || row.last_canonical_sync_at,
  };
}

export function actionPolicyForRow(row) {
  const authority = deriveEffectiveAuthority(row);
  return {
    canEnable: authority.hardSafe && row.admin_state !== "force_enabled",
    canDisable: row.admin_state !== "force_disabled",
    canClearOverride: row.admin_state !== "default",
    canRescan: true,
    requiresExpectedVersion: true,
    requiresReasonForOverride: true,
    forceEnableBypassesHardSafety: false,
  };
}

async function selectRow(client, id, { forUpdate = false } = {}) {
  const result = await client.query(
    `select * from public.robinhood_stock_token_registry where id = $1::uuid ${forUpdate ? "for update" : ""}`,
    [id],
  );
  return result.rows[0] || null;
}

export async function listRobinhoodStockRegistry({ chainId = ROBINHOOD_MAINNET_CHAIN_ID, publicOnly = false } = {}) {
  const values = [Number(chainId)];
  const where = publicOnly ? "and canonical = true" : "";
  const result = await pool.query(
    `select * from public.robinhood_stock_token_registry where chain_id = $1 ${where} order by candidate desc, symbol asc`,
    values,
  );
  return result.rows.map(rowToAsset).filter((item) => !publicOnly || item.enabledForDiscovery || item.enabledForTrading);
}

export async function getRobinhoodStockRegistryDetail(id) {
  const row = await selectRow(pool, id);
  if (!row) return null;
  const history = await pool.query(
    `select id, action, reason, operator_identity, previous_state, next_state, previous_version, next_version, created_at
       from public.robinhood_stock_token_registry_audit
      where registry_id = $1::uuid order by created_at desc limit 200`,
    [id],
  );
  return { item: rowToAsset(row), actionPolicy: actionPolicyForRow(row), history: history.rows };
}

export async function getRobinhoodStockGraduationAsset({ chainId, contractAddress, requireFresh = true }) {
  const normalized = normalizeStockAddress(contractAddress);
  if (!normalized) throw new Error("Selected Stock Token address is invalid");
  const result = await pool.query(
    `select * from public.robinhood_stock_token_registry
      where chain_id = $1 and lower(contract_address) = lower($2) limit 1`,
    [Number(chainId), normalized],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Selected Stock Token is not present in the canonical registry");
  const authority = deriveEffectiveAuthority(row, { healthFresh: requireFresh ? isHealthFresh(row) : true });
  if (!row.canonical) throw new Error("Selected Stock Token contract is not canonical for this Robinhood chain");
  if (!authority.enabledForGraduation) {
    throw new Error(`Selected Stock Token is not currently enabled for graduation (${row.automated_health_status}: ${row.automated_health_reason || "policy blocked"})`);
  }
  return rowToAsset(row);
}

function getFactoryAddress(chainId) {
  return normalizeStockAddress(
    process.env[`VITE_FACTORY_ADDRESS_${chainId}`] ||
    process.env[`FACTORY_ADDRESS_${chainId}`] ||
    process.env.VITE_FACTORY_ADDRESS ||
    process.env.FACTORY_ADDRESS ||
    "",
  );
}

export async function evaluateRobinhoodStockHealth(row) {
  if (!row?.canonical) return { status: "unhealthy", reason: "noncanonical Robinhood deployment", route: null, evidence: null };
  if (!robinhoodAssetIsActive(row.robinhood_status)) return { status: "unhealthy", reason: "Robinhood asset is inactive", route: null, evidence: null };
  if (row.trading_halted === true) return { status: "unhealthy", reason: "Robinhood asset trading is halted", route: null, evidence: null };
  if (!isExactRobinhoodReleaseCandidate({ chainId: row.chain_id, contractAddress: row.contract_address })) {
    return { status: "unhealthy", reason: "exact chain + provider + contract identity is not an approved Robinhood release candidate", route: null, evidence: null };
  }

  try {
    const chainId = Number(row.chain_id);
    const provider = await getServerReadProvider(chainId);
    const factoryAddress = getFactoryAddress(chainId);
    const evidence = await certifyRobinhoodStockRuntime({ row, provider, factoryAddress });
    return {
      status: "healthy",
      reason: "runtime-parity certification passed: exact identity, executable acquisition, fresh price authority, deviation/impact/slippage policy, and permanent MEME/QUOTE LP custody verified",
      route: {
        oracleFeed: evidence.oracleFeed,
        acquisitionPool: evidence.acquisitionPool,
        enabled: evidence.routeEnabled === true,
      },
      evidence,
    };
  } catch (error) {
    return {
      status: "review",
      reason: `runtime-parity certification pending: ${String(error?.shortMessage || error?.message || error)}`,
      route: null,
      evidence: null,
    };
  }
}

async function persistHealth(client, row, health) {
  const route = health.route || {};
  const staged = {
    ...row,
    automated_health_status: health.status,
    automated_health_reason: health.reason,
    health_certification_version: health.status === "healthy" ? ROBINHOOD_RUNTIME_CERTIFICATION_VERSION : null,
    certification_evidence: health.evidence || null,
    oracle_feed_address: route.oracleFeed ?? row.oracle_feed_address,
    acquisition_pool_address: route.acquisitionPool ?? row.acquisition_pool_address,
    route_enabled: route.enabled ?? false,
    last_health_check_at: new Date(),
  };
  const authority = deriveEffectiveAuthority(staged, { healthFresh: true });
  const result = await client.query(
    `update public.robinhood_stock_token_registry
        set automated_health_status = $2,
            automated_health_reason = $3,
            health_certification_version = $4,
            certification_evidence = $5::jsonb,
            oracle_feed_address = $6,
            acquisition_pool_address = $7,
            route_enabled = $8,
            enabled_for_graduation = $9,
            enabled_for_discovery = $10,
            enabled_for_trading = $11,
            last_health_check_at = now(),
            state_version = state_version + 1,
            updated_at = now()
      where id = $1::uuid returning *`,
    [
      row.id,
      health.status,
      health.reason,
      health.status === "healthy" ? ROBINHOOD_RUNTIME_CERTIFICATION_VERSION : null,
      JSON.stringify(health.evidence || null),
      route.oracleFeed ?? row.oracle_feed_address,
      route.acquisitionPool ?? row.acquisition_pool_address,
      route.enabled ?? false,
      authority.enabledForGraduation,
      authority.enabledForDiscovery,
      authority.enabledForTrading,
    ],
  );
  return result.rows[0];
}

export async function refreshRobinhoodStockHealthById(id) {
  const row = await selectRow(pool, id);
  if (!row) return null;
  const health = await evaluateRobinhoodStockHealth(row);
  return rowToAsset(await persistHealth(pool, row, health));
}

export async function refreshAllRobinhoodStockHealth() {
  const result = await pool.query(`select * from public.robinhood_stock_token_registry where chain_id = $1 order by candidate desc, symbol asc`, [ROBINHOOD_MAINNET_CHAIN_ID]);
  const items = [];
  for (const row of result.rows) {
    const health = await evaluateRobinhoodStockHealth(row);
    items.push(rowToAsset(await persistHealth(pool, row, health)));
  }
  return items;
}

export async function syncCanonicalRobinhoodStockTokens({ fetchImpl = fetch, operatorIdentity = "system:canonical-sync" } = {}) {
  const response = await fetchImpl(ROBINHOOD_CANONICAL_ASSETS_URL, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Robinhood canonical asset sync failed (${response.status})`);
  const canonicalRows = parseCanonicalRobinhoodDeployments(await response.json());
  if (!canonicalRows.length) throw new Error("Robinhood canonical asset sync returned no chain-4663 deployments");

  const client = await pool.connect();
  const syncStartedAt = new Date();
  try {
    await client.query("begin");
    for (const asset of canonicalRows) {
      const exactCandidate = isExactRobinhoodReleaseCandidate({
        chainId: asset.chainId,
        contractAddress: asset.contractAddress,
      });
      await client.query(
        `insert into public.robinhood_stock_token_registry (
           chain_id, robinhood_asset_uid, contract_address, symbol, display_name, underlying_symbol,
           canonical, robinhood_status, trading_halted, candidate, automated_health_status,
           automated_health_reason, health_certification_version, certification_evidence,
           enabled_for_graduation, enabled_for_discovery, enabled_for_trading,
           existing_market_support, last_canonical_sync_at
         ) values ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,'stale','canonical identity sync requires runtime-parity health rescan',null,null,false,$9,false,true,now())
         on conflict (chain_id, contract_address) do update set
           robinhood_asset_uid = excluded.robinhood_asset_uid,
           symbol = excluded.symbol,
           display_name = excluded.display_name,
           underlying_symbol = excluded.underlying_symbol,
           canonical = true,
           robinhood_status = excluded.robinhood_status,
           trading_halted = excluded.trading_halted,
           candidate = excluded.candidate,
           automated_health_status = 'stale',
           automated_health_reason = 'canonical identity sync requires runtime-parity health rescan',
           health_certification_version = null,
           certification_evidence = null,
           enabled_for_graduation = false,
           enabled_for_discovery = excluded.candidate and public.robinhood_stock_token_registry.admin_state <> 'force_disabled',
           last_canonical_sync_at = now(),
           state_version = public.robinhood_stock_token_registry.state_version + 1,
           updated_at = now()`,
        [asset.chainId, asset.robinhoodAssetUid, asset.contractAddress, asset.symbol, asset.displayName, asset.underlyingSymbol, asset.robinhoodStatus, asset.tradingHalted, exactCandidate],
      );
    }

    const missing = await client.query(
      `update public.robinhood_stock_token_registry
          set canonical = false,
              automated_health_status = 'unhealthy',
              automated_health_reason = 'deployment missing from latest Robinhood canonical chain-4663 sync',
              health_certification_version = null,
              certification_evidence = null,
              enabled_for_graduation = false,
              enabled_for_discovery = false,
              last_canonical_sync_at = now(),
              state_version = state_version + 1,
              updated_at = now()
        where chain_id = $1 and (last_canonical_sync_at is null or last_canonical_sync_at < $2)
        returning *`,
      [ROBINHOOD_MAINNET_CHAIN_ID, syncStartedAt],
    );
    for (const row of missing.rows) {
      await client.query(
        `insert into public.robinhood_stock_token_registry_audit
          (registry_id, action, reason, operator_identity, next_state, previous_version, next_version)
         values ($1,'canonical_missing',$2,$3,$4::jsonb,$5,$6)`,
        [row.id, row.automated_health_reason, operatorIdentity, JSON.stringify(rowToAsset(row)), Number(row.state_version) - 1, Number(row.state_version)],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { synced: canonicalRows.length, chainId: ROBINHOOD_MAINNET_CHAIN_ID, syncedAt: syncStartedAt.toISOString() };
}

export class RegistryVersionConflictError extends Error {
  constructor(current) {
    super("Robinhood Stock Token registry stateVersion conflict");
    this.name = "RegistryVersionConflictError";
    this.current = current;
  }
}

export async function setRobinhoodStockAdminState({ id, adminState, expectedVersion, reason, operatorIdentity }) {
  if (!new Set(["default", "force_enabled", "force_disabled"]).has(adminState)) throw new Error("invalid admin state");
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error("expectedVersion is required");
  if (adminState !== "default" && !String(reason || "").trim()) throw new Error("reason is required for manual enable/disable");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row = await selectRow(client, id, { forUpdate: true });
    if (!row) {
      await client.query("rollback");
      return null;
    }
    if (Number(row.state_version) !== version) throw new RegistryVersionConflictError(rowToAsset(row));
    if (adminState === "force_enabled") {
      const authority = deriveEffectiveAuthority({ ...row, admin_state: "force_enabled" });
      if (!authority.hardSafe) throw new Error("force-enable cannot bypass canonical/onchain health safety failures");
    }
    const updatedResult = await client.query(
      `update public.robinhood_stock_token_registry
          set admin_state = $2,
              state_version = state_version + 1,
              updated_at = now()
        where id = $1::uuid returning *`,
      [id, adminState],
    );
    let updated = updatedResult.rows[0];
    const authority = deriveEffectiveAuthority(updated);
    const finalResult = await client.query(
      `update public.robinhood_stock_token_registry
          set enabled_for_graduation=$2, enabled_for_discovery=$3, enabled_for_trading=$4
        where id=$1::uuid returning *`,
      [id, authority.enabledForGraduation, authority.enabledForDiscovery, authority.enabledForTrading],
    );
    updated = finalResult.rows[0];
    await client.query(
      `insert into public.robinhood_stock_token_registry_audit
        (registry_id, action, reason, operator_identity, previous_state, next_state, previous_version, next_version)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [id, adminState === "default" ? "clear_override" : adminState === "force_enabled" ? "enable" : "disable", String(reason || "").trim() || null, operatorIdentity, JSON.stringify(rowToAsset(row)), JSON.stringify(rowToAsset(updated)), Number(row.state_version), Number(updated.state_version)],
    );
    await client.query("commit");
    return { item: rowToAsset(updated), actionPolicy: actionPolicyForRow(updated) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function stockRegistryFeatureEnabled() {
  return truthy(process.env.ROBINHOOD_STOCK_GRADUATION);
}

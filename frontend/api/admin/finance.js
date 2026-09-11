import { pool } from "../../server/db.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";
import { configuredRewardVaultAddresses, readRewardFunding } from "../lib/financeFunding.js";
import { readNativeUpvoteRevenue } from "../lib/financeVoteRevenue.js";
import { defaultEvmChainId } from "../lib/defaultEvmChain.js";
import { resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";

const FINANCE_NETWORKS = new Map([
  [56, { chain: "bnb", decimals: 18, asset: "BNB", environment: "mainnet" }],
  [97, { chain: "bnb", decimals: 18, asset: "BNB", environment: "testnet" }],
]);

const INDEXER_BASE = String(
  process.env.INDEXER_API_BASE_URL ||
  process.env.INDEXER_BASE_URL ||
  process.env.RAILWAY_INDEXER_URL ||
  process.env.VITE_TOKEN_API_BASE ||
  process.env.VITE_REALTIME_API_BASE ||
  "",
).trim().replace(/\/+$/, "");

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function atomicToDecimal(value, decimals) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+(?=\d)/, "") || "0";
  if (normalized === "0") return "0";
  const padded = normalized.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function rawBigInt(value) {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

function safeAsset(value, fallback) {
  const text = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9._-]{1,20}$/.test(text) ? text : fallback;
}

function selectedNetwork(req) {
  const chainId = Number(req.query?.chainId ?? defaultEvmChainId());
  const evmNetwork = FINANCE_NETWORKS.get(chainId);
  if (evmNetwork) return { chainId, ...evmNetwork };

  if (chainId !== 101) return null;
  const authority = resolveCurrentSolanaAuthority({
    chainId,
    environment: req.query?.environment,
    cluster: req.query?.solanaCluster ?? req.query?.cluster,
  });
  if (!authority) return null;
  return {
    chainId: 101,
    chain: "solana",
    decimals: 9,
    asset: "SOL",
    environment: authority.environment,
    cluster: authority.cluster,
  };
}

function rewardState(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "approved" || normalized === "allocated") return "allocated";
  if (normalized === "claimable") return "claimable";
  if (normalized === "claimed") return "claimed";
  if (normalized === "expired") return "expired";
  if (normalized === "returned" || normalized === "rolled_over") return "returned";
  if (normalized === "claim_pending" || normalized === "pending" || normalized === "failed") return "pending";
  return null;
}

function rewardChainCandidates(network) {
  if (network.chain !== "solana") return [String(network.chainId)];
  if (network.environment === "staging" && network.cluster === "devnet") {
    return ["101", "solana-devnet"];
  }
  if (network.environment === "production" && network.cluster === "mainnet-beta") {
    return ["101", "solana", "solana-mainnet", "solana-mainnet-beta"];
  }
  return [];
}

async function loadRewardRows(network) {
  const candidates = rewardChainCandidates(network);
  if (candidates.length === 0) return [];
  const { rows } = await pool.query(
    `select chain::text as chain,
            coalesce(nullif(token_symbol, ''), '') as token_symbol,
            reward_type,
            status,
            count(*)::int as evidence_count,
            count(distinct wallet_address)::int as recipient_count,
            coalesce(sum(amount), 0)::text as amount_raw,
            min(created_at) as period_start,
            max(coalesce(claimed_at, updated_at, created_at)) as period_end
       from public.reward_ledger
      where chain::text = any($1::text[])
      group by chain::text, token_symbol, reward_type, status
      order by period_end desc nulls last`,
    [candidates],
  );
  return rows;
}

function buildNativeRewardModel(rows, network) {
  const aggregates = [];
  let obligationRaw = 0n;

  for (const [index, row] of rows.entries()) {
    const state = rewardState(row.status);
    const assetSymbol = safeAsset(row.token_symbol, network.asset);
    if (!state || assetSymbol !== network.asset) continue;

    const rawAmount = rawBigInt(row.amount_raw);
    const nativeAmount = atomicToDecimal(rawAmount.toString(), network.decimals);
    const periodStart = toIso(row.period_start);
    const periodEnd = toIso(row.period_end);
    if (nativeAmount == null || !periodStart || !periodEnd) continue;

    if (state === "allocated" || state === "claimable" || state === "pending") obligationRaw += rawAmount;

    aggregates.push({
      id: `reward:${network.chainId}:${String(row.reward_type || "unknown")}:${String(row.status || "unknown")}:${index}`,
      periodStart,
      periodEnd,
      chain: network.chain,
      program: String(row.reward_type || "reward"),
      assetSymbol,
      state,
      nativeAmount,
      recipientCount: Number(row.recipient_count || 0),
      evidenceCount: Number(row.evidence_count || 0),
    });
  }

  return { aggregates, obligationRaw };
}

async function rewardCoverage(network, obligationRaw) {
  const funding = await readRewardFunding(network);
  const obligationAmount = atomicToDecimal(obligationRaw.toString(), network.decimals) || "0";
  const fundedAmount = atomicToDecimal(funding.fundedRaw.toString(), network.decimals) || "0";
  const coverageStatus = !funding.configured || !funding.readable
    ? "blocked"
    : funding.fundedRaw >= obligationRaw
      ? "covered"
      : "attention";

  return {
    funding,
    coverage: [{
      chain: network.chain,
      assetSymbol: network.asset,
      obligationAmount,
      fundedAmount,
      coverageStatus,
    }],
  };
}

async function financeRewards(req, res, network) {
  try {
    const rows = await loadRewardRows(network);
    const { aggregates, obligationRaw } = buildNativeRewardModel(rows, network);
    const { coverage } = await rewardCoverage(network, obligationRaw);
    return res.status(200).json({
      schemaVersion: "finance-rewards-v1",
      generatedAt: new Date().toISOString(),
      source: "dashboard-api",
      aggregates,
      coverage,
    });
  } catch (error) {
    if (schemaMissing(error)) {
      return res.status(200).json({
        schemaVersion: "finance-rewards-v1",
        generatedAt: new Date().toISOString(),
        source: "dashboard-api",
        aggregates: [],
        coverage: [{
          chain: network.chain,
          assetSymbol: network.asset,
          obligationAmount: "0",
          fundedAmount: "0",
          coverageStatus: "blocked",
        }],
      });
    }
    throw error;
  }
}

async function bondingRevenueAggregate(network) {
  const { rows } = await pool.query(
    `select min(occurred_at) as period_start,
            max(occurred_at) as period_end,
            count(*)::int as evidence_count,
            coalesce(sum(protocol_amount), 0)::text as amount_raw
       from public.reward_events
      where chain_id = $1
        and route_kind = 'trade'
        and protocol_amount > 0`,
    [network.chainId],
  );
  const row = rows[0] || {};
  const nativeAmount = atomicToDecimal(row.amount_raw, network.decimals);
  const periodStart = toIso(row.period_start);
  const periodEnd = toIso(row.period_end);
  if (!nativeAmount || nativeAmount === "0" || !periodStart || !periodEnd) return null;

  return {
    id: `bonding-route:${network.chainId}`,
    periodStart,
    periodEnd,
    chain: network.chain,
    lane: "bonding_curve_fee",
    assetSymbol: network.asset,
    sourceInventoryId: `bnb${network.chainId}-treasury-router`,
    nativeAmount,
    evidenceCount: Number(row.evidence_count || 0),
  };
}

async function financeRevenue(req, res, network) {
  if (network.chain !== "bnb") {
    return res.status(200).json({
      schemaVersion: "finance-revenue-v1",
      generatedAt: new Date().toISOString(),
      source: "dashboard-api",
      aggregates: [],
      quarantine: [],
    });
  }

  const aggregates = [];
  try {
    const bonding = await bondingRevenueAggregate(network);
    if (bonding) aggregates.push(bonding);
  } catch (error) {
    if (!schemaMissing(error)) throw error;
  }

  try {
    const upvotes = await readNativeUpvoteRevenue(network);
    if (upvotes.approved && upvotes.aggregate) {
      const nativeAmount = atomicToDecimal(upvotes.aggregate.amountRaw, network.decimals);
      const periodStart = toIso(upvotes.aggregate.periodStart);
      const periodEnd = toIso(upvotes.aggregate.periodEnd);
      if (nativeAmount && nativeAmount !== "0" && periodStart && periodEnd) {
        aggregates.push({
          id: `upvotes:${network.chainId}:native`,
          periodStart,
          periodEnd,
          chain: network.chain,
          lane: "upvotes",
          assetSymbol: network.asset,
          sourceInventoryId: `bnb${network.chainId}-vote-treasury`,
          nativeAmount,
          evidenceCount: upvotes.aggregate.evidenceCount,
        });
      }
    }
  } catch (error) {
    if (!schemaMissing(error)) console.warn("[finance/revenue] upvote lane omitted", error?.message || error);
  }

  return res.status(200).json({
    schemaVersion: "finance-revenue-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    aggregates,
    quarantine: [],
  });
}

function financeInventoryItems(network) {
  const items = [];
  const seenAddresses = new Set();
  const add = (id, kind, label, address, role) => {
    const value = String(address || "").trim();
    if (!value) return;
    const key = `${network.chain}:${value.toLowerCase()}`;
    if (seenAddresses.has(key)) return;
    seenAddresses.add(key);
    items.push({ id, chain: network.chain, kind, label, address: value, role, status: "configured" });
  };

  if (network.chain === "bnb") {
    const suffix = network.chainId === 97 ? "97" : "56";
    const env = (name) => process.env[`${name}_${suffix}`] || process.env[`VITE_${name}_${suffix}`] || (network.chainId === 56 ? process.env[name] || process.env[`VITE_${name}`] : undefined);
    add(`bnb${network.chainId}-factory`, "contract", "Launch Factory", env("FACTORY_ADDRESS"), "campaign creation authority");
    add(`bnb${network.chainId}-treasury-router`, "contract", "Treasury Router", env("TREASURY_ROUTER_ADDRESS"), "fee route authority");
    add(`bnb${network.chainId}-treasury-vault`, "vault", "Treasury Vault", env("TREASURY_VAULT_ADDRESS"), "treasury custody");
    add(`bnb${network.chainId}-protocol-revenue`, "vault", "Protocol Revenue Vault", env("PROTOCOL_REVENUE_VAULT_ADDRESS"), "protocol revenue custody");
    add(`bnb${network.chainId}-community-rewards`, "vault", "Community Rewards Vault", env("COMMUNITY_REWARDS_VAULT_ADDRESS"), "community reward routing");
    add(`bnb${network.chainId}-recruiter-rewards`, "vault", "Recruiter Rewards Vault", env("RECRUITER_REWARDS_VAULT_ADDRESS"), "recruiter reward routing");
    configuredRewardVaultAddresses(network).forEach((address, index) => add(`bnb${network.chainId}-claim-custody-${index + 1}`, "vault", "Reward Claim Custody", address, "active reward claim funding"));
    add(`bnb${network.chainId}-lp-locker`, "contract", "Permanent LP Locker", env("PERMANENT_LP_LOCKER_ADDRESS") || env("LP_LOCKER_ADDRESS"), "permanently locked graduation liquidity");
    add(`bnb${network.chainId}-vote-treasury`, "contract", "UP Vote Treasury", env("VOTE_TREASURY_ADDRESS"), "verified paid-vote collection");
  } else if (network.environment === "staging" && network.cluster === "devnet") {
    add("sol101-devnet-protocol-treasury", "wallet", "Solana Protocol Treasury", process.env.SOLANA_DEVNET_PROTOCOL_TREASURY_ADDRESS || process.env.SOLANA_PROTOCOL_TREASURY_ADDRESS || process.env.SOLANA_VOTE_TREASURY_ADDRESS, "protocol revenue destination");
    configuredRewardVaultAddresses(network).forEach((address, index) => add(`sol101-devnet-claim-custody-${index + 1}`, "vault", "Solana Reward Claim Custody", address, "reward claim funding"));
    add("sol101-devnet-operator", "wallet", "Solana LP Operator", process.env.SOLANA_DEVNET_OPERATOR_ADDRESS || process.env.SOLANA_OPERATOR_ADDRESS || process.env.SOLANA_HARVEST_OPERATOR_ADDRESS, "Meteora position operator");
  } else if (network.environment === "production" && network.cluster === "mainnet-beta") {
    add("sol101-mainnet-protocol-treasury", "wallet", "Solana Protocol Treasury", process.env.SOLANA_MAINNET_PROTOCOL_TREASURY_ADDRESS || process.env.SOLANA_MAINNET_VOTE_TREASURY_ADDRESS, "protocol revenue destination");
    configuredRewardVaultAddresses(network).forEach((address, index) => add(`sol101-mainnet-claim-custody-${index + 1}`, "vault", "Solana Reward Claim Custody", address, "reward claim funding"));
    add("sol101-mainnet-operator", "wallet", "Solana LP Operator", process.env.SOLANA_MAINNET_OPERATOR_ADDRESS || process.env.SOLANA_MAINNET_HARVEST_OPERATOR_ADDRESS, "Meteora position operator");
  }
  return items;
}

async function financeInventory(req, res, network) {
  return res.status(200).json({
    schemaVersion: "finance-inventory-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    network: {
      chainId: network.chainId,
      chain: network.chain,
      environment: network.environment,
      ...(network.cluster ? { cluster: network.cluster } : {}),
    },
    items: financeInventoryItems(network),
  });
}

function indexerHeaders() {
  const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
  return opsKey ? { Accept: "application/json", "x-ops-key": opsKey } : { Accept: "application/json" };
}

async function readIndexerLpFees(network) {
  if (!INDEXER_BASE) throw new Error("Indexer base URL is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const params = new URLSearchParams({ chainId: String(network.chainId), limit: "50" });
    if (network.chain === "solana") {
      params.set("environment", network.environment);
      params.set("solanaCluster", network.cluster);
    }
    const response = await fetch(`${INDEXER_BASE}/api/dashboard/lp-fees?${params.toString()}`, {
      headers: indexerHeaders(),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !Array.isArray(payload.items)) {
      throw new Error(String(payload?.error || `Indexer LP read failed (${response.status}).`));
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildReconciliationSummary(network) {
  const inventory = financeInventoryItems(network);
  let sourceErrorCount = 0;
  let staleSourceCount = 0;

  try {
    const lp = await readIndexerLpFees(network);
    for (const item of lp.items) if (item?.fees?.error) sourceErrorCount += 1;
    const updatedAt = Date.parse(String(lp.updatedAt || ""));
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 15 * 60 * 1000) staleSourceCount += 1;
  } catch {
    sourceErrorCount += 1;
    staleSourceCount += 1;
  }

  let obligationRaw = 0n;
  try {
    const rows = await loadRewardRows(network);
    obligationRaw = buildNativeRewardModel(rows, network).obligationRaw;
  } catch (error) {
    if (!schemaMissing(error)) throw error;
    sourceErrorCount += 1;
  }

  const { funding } = await rewardCoverage(network, obligationRaw);
  const fundingBlocked = !funding.configured || !funding.readable;
  const underfunded = funding.readable && funding.fundedRaw < obligationRaw;
  if (funding.configured && !funding.readable) staleSourceCount += 1;

  const trackedInventoryCount = inventory.length;
  const balancedInventoryCount = funding.readable && !underfunded ? funding.vaultCount : 0;
  const balanceBreakCount = underfunded ? 1 : 0;
  const status = trackedInventoryCount === 0 || fundingBlocked || sourceErrorCount > 0
    ? "blocked"
    : balanceBreakCount > 0 || staleSourceCount > 0 || balancedInventoryCount < trackedInventoryCount
      ? "attention"
      : "ready";

  return {
    chain: network.chain,
    status,
    trackedInventoryCount,
    balancedInventoryCount,
    balanceBreakCount,
    missingPriceCount: 0,
    duplicateCandidateCount: 0,
    quarantinedTransferCount: 0,
    staleSourceCount: staleSourceCount + sourceErrorCount,
  };
}

async function financeReconciliation(req, res, network) {
  return res.status(200).json({
    schemaVersion: "finance-reconciliation-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    chains: [await buildReconciliationSummary(network)],
  });
}

async function revenueModuleStatus(network) {
  const now = new Date().toISOString();
  let blockerCount = 0;
  let warningCount = 0;
  let status = "ready";

  try {
    const lp = await readIndexerLpFees(network);
    const errors = lp.items.filter((item) => item?.fees?.error).length;
    const registered = lp.items.filter((item) => item?.fees?.registered === true).length;
    if (errors > 0) {
      warningCount += errors;
      status = "attention";
    } else if (lp.items.length === 0 || registered === 0) {
      status = "pending";
      warningCount += 1;
    }
  } catch {
    blockerCount += 1;
    status = "blocked";
  }

  if (network.chain === "bnb") {
    try {
      await pool.query(`select 1 from public.reward_events where chain_id = $1 limit 1`, [network.chainId]);
    } catch (error) {
      if (schemaMissing(error)) {
        blockerCount += 1;
        status = "blocked";
      } else {
        throw error;
      }
    }
  }

  return { key: "revenue", status, blockerCount, warningCount, lastUpdatedAt: now };
}

async function financeOverview(req, res, network) {
  const generatedAt = new Date().toISOString();
  const inventory = financeInventoryItems(network);
  const productionLike = network.environment === "mainnet" || network.environment === "production";
  const inventoryStatus = inventory.length > 0 ? "ready" : productionLike ? "pending" : "blocked";

  let rewardStatus = "blocked";
  let rewardBlockers = 1;
  let rewardWarnings = 0;
  try {
    const rows = await loadRewardRows(network);
    const { obligationRaw } = buildNativeRewardModel(rows, network);
    const { coverage } = await rewardCoverage(network, obligationRaw);
    const state = coverage[0]?.coverageStatus || "blocked";
    rewardStatus = state === "covered" ? "ready" : state;
    rewardBlockers = state === "blocked" ? 1 : 0;
    rewardWarnings = state === "attention" ? 1 : 0;
  } catch (error) {
    if (!schemaMissing(error)) throw error;
  }

  const reconciliation = await buildReconciliationSummary(network);
  const revenue = await revenueModuleStatus(network);
  const reconciliationBlockers = reconciliation.status === "blocked" ? 1 : 0;
  const reconciliationWarnings = reconciliation.status === "attention" ? 1 : 0;

  const modules = [
    {
      key: "inventory",
      status: inventoryStatus,
      blockerCount: inventoryStatus === "blocked" ? 1 : 0,
      warningCount: inventoryStatus === "pending" ? 1 : 0,
      lastUpdatedAt: generatedAt,
    },
    revenue,
    {
      key: "rewards",
      status: rewardStatus,
      blockerCount: rewardBlockers,
      warningCount: rewardWarnings,
      lastUpdatedAt: generatedAt,
    },
    { key: "costs", status: "disabled", blockerCount: 0, warningCount: 0 },
    { key: "taxReserves", status: "disabled", blockerCount: 0, warningCount: 0 },
    {
      key: "reconciliation",
      status: reconciliation.status,
      blockerCount: reconciliationBlockers,
      warningCount: reconciliationWarnings,
      lastUpdatedAt: generatedAt,
    },
    { key: "close", status: "disabled", blockerCount: 0, warningCount: 0 },
    { key: "distributions", status: "disabled", blockerCount: 0, warningCount: 0 },
  ];

  const blockingStatuses = new Set(["blocked", "disabled"]);
  const warningStatuses = new Set(["attention", "pending"]);
  const blockerCount = modules.filter((module) => blockingStatuses.has(module.status)).length;
  const warningCount = modules.filter((module) => warningStatuses.has(module.status)).length;

  return res.status(200).json({
    schemaVersion: "finance-overview-v1",
    generatedAt,
    source: "dashboard-api",
    modules,
    chains: [{
      chain: network.chain,
      closeStatus: "not_ready",
      blockerCount,
      warningCount,
    }],
  });
}

async function financeLpHarvest(req, res, network) {
  if (String(req.method || "").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "LP harvest requires POST." });
  }

  const pair = String(req.body?.pair || req.body?.pairAddress || "").trim();
  const campaign = String(req.body?.campaign || req.body?.campaignAddress || "").trim();
  if (!pair) return res.status(400).json({ ok: false, error: "LP pair / position is required." });

  const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
  if (!opsKey) return res.status(503).json({ ok: false, error: "LP harvest is not configured on the Frontend API." });
  if (!INDEXER_BASE) return res.status(503).json({ ok: false, error: "Indexer base URL is not configured." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const upstream = await fetch(`${INDEXER_BASE}/api/dashboard/lp-fees/collect`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-ops-key": opsKey },
      body: JSON.stringify({
        chainId: network.chainId,
        ...(network.chain === "solana"
          ? { environment: network.environment, solanaCluster: network.cluster }
          : {}),
        pair,
        pairAddress: pair,
        campaign: campaign || undefined,
        campaignAddress: campaign || undefined,
      }),
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ ok: false, error: String(payload?.error || payload?.message || `Indexer harvest failed (${upstream.status}).`) });
    }
    return res.status(200).json({
      ok: true,
      chainId: network.chainId,
      chain: network.chain,
      environment: network.environment,
      ...(network.cluster ? { cluster: network.cluster } : {}),
      txHash: payload?.txHash || null,
      note: payload?.note || null,
      harvestedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "Indexer harvest timed out." : "Indexer harvest request failed.";
    return res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function financeAdmin(req, res) {
  const auth = await requireAdminOrOps(req, res, { routeLabel: "admin/finance", allowOps: true });
  if (!auth) return;

  const network = selectedNetwork(req);
  if (!network) {
    return res.status(400).json({
      ok: false,
      error: "Finance network must be BNB 56/97 or Solana 101 with explicit staging/devnet or production/mainnet-beta identity.",
    });
  }

  const pathname = String(req.path || new URL(req.url, "http://localhost").pathname);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (pathname === "/api/admin/finance/lp-harvest") return await financeLpHarvest(req, res, network);
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }
    if (pathname === "/api/admin/finance/overview") return await financeOverview(req, res, network);
    if (pathname === "/api/admin/finance/rewards") return await financeRewards(req, res, network);
    if (pathname === "/api/admin/finance/revenue") return await financeRevenue(req, res, network);
    if (pathname === "/api/admin/finance/inventory") return await financeInventory(req, res, network);
    if (pathname === "/api/admin/finance/reconciliation") return await financeReconciliation(req, res, network);
    return res.status(404).json({ ok: false, error: "Unknown finance admin route." });
  } catch (error) {
    console.error("[api/admin/finance]", pathname, error);
    if (!res.headersSent) return res.status(500).json({ ok: false, error: "Finance operation failed." });
  }
}

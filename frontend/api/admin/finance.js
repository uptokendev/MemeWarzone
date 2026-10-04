import { pool } from "../../server/db.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";
import { configuredRewardVaultAddresses, readRewardFunding } from "../lib/financeFunding.js";
import { readNativeUpvoteRevenue } from "../lib/financeVoteRevenue.js";
import { defaultEvmChainId } from "../lib/defaultEvmChain.js";
import { normalizeSolanaCluster, resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";
import { cachedFeeRouting, feeRoutingAllNetworks, feeRoutingDays, feeRoutingNetwork } from "../lib/financeFeeRouting.js";
import { dashboardPrincipalCan } from "../dashboard/_access.js";
import { cachedInventoryBalances } from "../lib/financeInventoryBalances.js";
import { buildTotals, defaultPriceService, mergeTotals, priceAssetFor } from "../lib/financePrices.js";
import { notPublicHiddenCampaignSql, publicHiddenWhere } from "../lib/publicHiddenCampaigns.js";
import { financePayouts } from "../lib/financePayouts.js";

// Finance shows mainnets only (founder decision 2026-10-04): nothing is earned
// on a testnet. chainId=all reads all three and adds a cross-chain total.
export const FINANCE_MAINNETS = Object.freeze([
  Object.freeze({ chainId: 101, chain: "solana", decimals: 9, asset: "SOL", environment: "production", cluster: "mainnet-beta", label: "Solana" }),
  Object.freeze({ chainId: 56, chain: "bnb", decimals: 18, asset: "BNB", environment: "mainnet", label: "BNB" }),
  Object.freeze({ chainId: 4663, chain: "robinhood", decimals: 18, asset: "ETH", environment: "mainnet", label: "Robinhood" }),
]);

const FINANCE_SCOPE_ERROR = "Finance covers mainnets only: chainId=all, BNB 56, Robinhood 4663, or Solana 101 with environment=production&solanaCluster=mainnet-beta.";
const TEST_COINS_NOTE = "Test coins (campaigns hidden from public listings) are left out of revenue and fee figures. Vault balances are shown as they are on chain.";

/**
 * Finance scope from the query: { all: true, networks: [3] } for chainId=all
 * (or no chainId), { all: false, networks: [one] } for a mainnet, null for a
 * testnet, devnet or unknown chain.
 */
export function financeScope(query = {}) {
  const raw = String(query.chainId ?? "").trim().toLowerCase();
  if (raw === "" || raw === "all") return { all: true, networks: FINANCE_MAINNETS.map((n) => ({ ...n })) };
  const chainId = Number(raw);
  if (chainId === 56 || chainId === 4663) return { all: false, networks: [{ ...FINANCE_MAINNETS.find((n) => n.chainId === chainId) }] };
  if (chainId !== 101) return null;
  const authority = resolveCurrentSolanaAuthority({
    chainId,
    environment: query.environment,
    cluster: query.solanaCluster ?? query.cluster,
  });
  if (!authority || authority.environment !== "production" || authority.cluster !== "mainnet-beta") return null;
  return { all: false, networks: [{ ...FINANCE_MAINNETS[0] }] };
}

function evmPrefix(network) {
  return network.chain === "robinhood" ? `rh${network.chainId}` : `bnb${network.chainId}`;
}

// LP harvest keeps its own network parsing (BNB 56/97, Solana by authority).
// The route then refuses anything that is not a mainnet (founder decision
// 2026-10-04, see lpHarvestMainnetOnly) before any harvest logic runs.
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

export function harvestNetwork(req) {
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

export const LP_HARVEST_SCOPE_ERROR = "LP harvest covers mainnets only: BNB 56, or Solana 101 with environment=production&solanaCluster=mainnet-beta. Testnets and devnet are refused.";

/** The harvest network if it is a mainnet; null for BNB 97, Solana devnet or anything else. */
export function lpHarvestMainnetOnly(network) {
  if (!network) return null;
  if (network.chain === "bnb" && network.chainId === 56 && network.environment === "mainnet") return network;
  if (network.chain === "solana" && network.chainId === 101 && network.environment === "production" && network.cluster === "mainnet-beta") return network;
  return null;
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

// The Solana cluster this API's database belongs to. reward_ledger stores
// chain "101" for both clusters, so the live API (production DB, mainnet) must
// not report its rows as devnet, and the test API not as mainnet. Same default
// as quoteAssetCatalog.js.
export function apiSolanaCluster(env = process.env) {
  return normalizeSolanaCluster(env.SOLANA_CLUSTER || env.VITE_SOLANA_CLUSTER || "mainnet-beta");
}

export function rewardChainCandidates(network) {
  if (network.chain !== "solana") return [String(network.chainId)];
  if (network.cluster !== apiSolanaCluster()) return [];
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

export function rewardsNotice(network) {
  if (network.chain !== "solana" || network.cluster === apiSolanaCluster()) return null;
  return network.cluster === "devnet"
    ? "This API reads the production database, which holds Solana mainnet rewards only. Devnet rewards are on the test stack."
    : "This API reads the test database, which holds Solana devnet rewards only. Mainnet rewards are on the live API.";
}

const NO_USD = Object.freeze({ amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null });

async function rewardsUsd(payload, network, prices) {
  for (const item of payload.aggregates) {
    item.chainId = network.chainId;
    Object.assign(item, await prices.valueAtSpot(item.assetSymbol, item.nativeAmount));
  }
  for (const row of payload.coverage) {
    row.chainId = network.chainId;
    const obligation = await prices.valueAtSpot(row.assetSymbol, row.obligationAmount);
    // A blocked custody read has no funded amount: no USD for it either.
    const funded = row.coverageStatus === "blocked" ? NO_USD : await prices.valueAtSpot(row.assetSymbol, row.fundedAmount);
    Object.assign(row, {
      obligationUsd: obligation.amountUsd,
      fundedUsd: funded.amountUsd,
      priceUsd: obligation.priceUsd,
      priceSource: obligation.priceSource,
      priceAt: obligation.priceAt,
      priceBasis: obligation.priceBasis,
    });
  }
  const entry = (item, amount, amountUsd) => ({ chainId: network.chainId, chain: network.chain, asset: item.assetSymbol, amount, amountUsd });
  payload.totals = {
    outstanding: buildTotals(payload.aggregates.filter((a) => ["allocated", "claimable", "pending"].includes(a.state)).map((a) => entry(a, a.nativeAmount, a.amountUsd)), { seed: [network] }),
    claimed: buildTotals(payload.aggregates.filter((a) => a.state === "claimed").map((a) => entry(a, a.nativeAmount, a.amountUsd)), { seed: [network] }),
    funded: buildTotals(payload.coverage.map((c) => entry(c, c.coverageStatus === "blocked" ? null : c.fundedAmount, c.fundedUsd)), { seed: [network] }),
  };
  payload.prices = await prices.spotTable([priceAssetFor(network.asset)]);
  return payload;
}

export async function buildRewards(network, { prices = defaultPriceService() } = {}) {
  const notice = rewardsNotice(network);
  let payload;
  try {
    const rows = await loadRewardRows(network);
    const { aggregates, obligationRaw } = buildNativeRewardModel(rows, network);
    const { coverage } = await rewardCoverage(network, obligationRaw);
    payload = {
      schemaVersion: "finance-rewards-v1",
      generatedAt: new Date().toISOString(),
      source: "dashboard-api",
      aggregates,
      coverage,
      ...(notice ? { notice } : {}),
    };
  } catch (error) {
    if (!schemaMissing(error)) throw error;
    payload = {
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
    };
  }
  return rewardsUsd(payload, network, prices);
}

// The Solana cluster of this API's database must be mainnet for chain 101
// revenue: on the test API chain 101 rows are devnet.
function solanaRowsAreMainnet(network) {
  return network.chain !== "solana" || apiSolanaCluster() === "mainnet-beta";
}

function mergeHourlyRows(rows) {
  let total = 0n;
  let evidenceCount = 0;
  let periodStart = null;
  let periodEnd = null;
  const buckets = [];
  for (const row of rows) {
    const raw = String(row.amount_raw || "0").split(".")[0];
    if (!/^\d+$/.test(raw)) continue;
    total += BigInt(raw);
    evidenceCount += Number(row.evidence_count || 0);
    const start = toIso(row.period_start);
    const end = toIso(row.period_end);
    if (start && (!periodStart || start < periodStart)) periodStart = start;
    if (end && (!periodEnd || end > periodEnd)) periodEnd = end;
    buckets.push({ hour: row.hour, raw });
  }
  return { total, evidenceCount, periodStart, periodEnd, buckets };
}

async function bondingRevenueAggregate(network) {
  // Grouped by hour so each slice is valued at the price of its hour; hidden
  // test coins are left out (same rule as the KPI endpoint).
  const { rows } = await pool.query(
    `select date_trunc('hour', r.occurred_at) as hour,
            min(r.occurred_at) as period_start,
            max(r.occurred_at) as period_end,
            count(*)::int as evidence_count,
            coalesce(sum(r.protocol_amount), 0)::text as amount_raw
       from public.reward_events r
      where r.chain_id = $1
        and r.route_kind = 'trade'
        and r.protocol_amount > 0
        and ${notPublicHiddenCampaignSql("r")}
      group by 1`,
    [network.chainId],
  );
  const merged = mergeHourlyRows(rows);
  const nativeAmount = atomicToDecimal(merged.total.toString(), network.decimals);
  if (!nativeAmount || nativeAmount === "0" || !merged.periodStart || !merged.periodEnd) return null;

  return {
    aggregate: {
      id: `bonding-route:${network.chainId}`,
      periodStart: merged.periodStart,
      periodEnd: merged.periodEnd,
      chain: network.chain,
      lane: "bonding_curve_fee",
      assetSymbol: network.asset,
      sourceInventoryId: network.chain === "solana"
        ? "sol101-mainnet-protocol-vault"
        : `${evmPrefix(network)}-treasury-router`,
      nativeAmount,
      evidenceCount: merged.evidenceCount,
    },
    buckets: merged.buckets,
  };
}

async function excludedTestCoinEvents(network) {
  const { rows } = await pool.query(
    `select count(*)::int as n
       from public.reward_events r
      where r.chain_id = $1
        and r.route_kind = 'trade'
        and r.protocol_amount > 0
        and not ${notPublicHiddenCampaignSql("r")}`,
    [network.chainId],
  );
  return Number(rows[0]?.n || 0);
}

// The browser merges LP-fee lanes from /api/dashboard/lp-fees; it drops the
// hidden test coins with this list.
async function hiddenCampaignAddresses(network) {
  const { rows } = await pool.query(
    `select campaign_address
       from public.campaigns
      where chain_id = $1
        and campaign_address is not null
        and ${publicHiddenWhere()}
      limit 5000`,
    [network.chainId],
  );
  return rows.map((row) => String(row.campaign_address));
}

export async function buildRevenue(network, { prices = defaultPriceService() } = {}) {
  const lanes = [];
  let excludedEvents = 0;
  let hiddenCampaigns = [];
  let notice = null;

  if (!solanaRowsAreMainnet(network)) {
    notice = "This API reads the test database, whose chain 101 rows are Solana devnet. Mainnet revenue is on the live API.";
  } else {
    try {
      const bonding = await bondingRevenueAggregate(network);
      if (bonding) lanes.push(bonding);
      excludedEvents = await excludedTestCoinEvents(network);
      hiddenCampaigns = await hiddenCampaignAddresses(network);
    } catch (error) {
      if (!schemaMissing(error)) throw error;
    }

    if (network.chain === "bnb" || network.chain === "robinhood") {
      try {
        const upvotes = await readNativeUpvoteRevenue(network);
        if (upvotes.approved && upvotes.aggregate) {
          const nativeAmount = atomicToDecimal(upvotes.aggregate.amountRaw, network.decimals);
          const periodStart = toIso(upvotes.aggregate.periodStart);
          const periodEnd = toIso(upvotes.aggregate.periodEnd);
          if (nativeAmount && nativeAmount !== "0" && periodStart && periodEnd) {
            lanes.push({
              aggregate: {
                id: `upvotes:${network.chainId}:native`,
                periodStart,
                periodEnd,
                chain: network.chain,
                lane: "upvotes",
                assetSymbol: network.asset,
                sourceInventoryId: `${evmPrefix(network)}-vote-treasury`,
                nativeAmount,
                evidenceCount: upvotes.aggregate.evidenceCount,
              },
              buckets: upvotes.aggregate.buckets,
            });
          }
        }
      } catch (error) {
        if (!schemaMissing(error)) console.warn("[finance/revenue] upvote lane omitted", error?.message || error);
      }
    }
  }

  const aggregates = [];
  for (const lane of lanes) {
    const usd = await prices.valueEvents(lane.aggregate.assetSymbol, lane.buckets, network.decimals);
    aggregates.push({ ...lane.aggregate, chainId: network.chainId, ...usd });
  }

  return {
    schemaVersion: "finance-revenue-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    aggregates,
    quarantine: [],
    totals: buildTotals(aggregates.map((a) => ({ chainId: network.chainId, chain: network.chain, asset: a.assetSymbol, amount: a.nativeAmount, amountUsd: a.amountUsd })), { seed: [network] }),
    // Spot rows: for the page footer and for the browser's LP-fee lanes, which
    // carry no event times and are therefore valued at current price.
    prices: await prices.spotTable([priceAssetFor(network.asset), "USD"]),
    testCoinsExcluded: true,
    excludedTestCoinEvents: excludedEvents,
    hiddenCampaigns,
    ...(notice ? { notice } : {}),
  };
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
  } else if (network.chain === "robinhood") {
    // Robinhood 4663: chain-suffixed names only, never the BNB defaults.
    const p = evmPrefix(network);
    const env = (name) => process.env[`${name}_${network.chainId}`] || process.env[`VITE_${name}_${network.chainId}`];
    add(`${p}-factory`, "contract", "Launch Factory", env("FACTORY_ADDRESS"), "campaign creation authority");
    add(`${p}-treasury-router`, "contract", "Treasury Router", env("TREASURY_ROUTER_ADDRESS"), "fee route authority");
    add(`${p}-treasury-vault`, "vault", "Treasury Vault", env("TREASURY_VAULT_ADDRESS"), "treasury custody");
    add(`${p}-protocol-revenue`, "vault", "Protocol Revenue Vault", env("PROTOCOL_REVENUE_VAULT_ADDRESS"), "protocol revenue custody");
    add(`${p}-community-rewards`, "vault", "Community Rewards Vault", env("COMMUNITY_REWARDS_VAULT_ADDRESS"), "community reward routing");
    add(`${p}-recruiter-rewards`, "vault", "Recruiter Rewards Vault", env("RECRUITER_REWARDS_VAULT_ADDRESS"), "recruiter reward routing");
    add(`${p}-lp-locker`, "contract", "Permanent LP Locker", env("PERMANENT_LP_LOCKER_ADDRESS") || env("LP_LOCKER_ADDRESS"), "permanently locked graduation liquidity");
    add(`${p}-vote-treasury`, "contract", "UP Vote Treasury", env("VOTE_TREASURY_ADDRESS"), "verified paid-vote collection");
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

export async function buildInventory(network, { balances = cachedInventoryBalances, prices = defaultPriceService() } = {}) {
  const items = await balances(financeInventoryItems(network), network);
  // Balances at spot. A failed read stays unknown with no USD.
  for (const item of items) {
    if (!item.balance) continue;
    const usd = item.balance.status === "ok" ? await prices.valueAtSpot(item.balance.asset, item.balance.amount) : NO_USD;
    item.balance = { ...item.balance, ...usd };
  }
  return {
    schemaVersion: "finance-inventory-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    network: {
      chainId: network.chainId,
      chain: network.chain,
      environment: network.environment,
      ...(network.cluster ? { cluster: network.cluster } : {}),
    },
    // Each item carries a live native balance; a failed read is "unknown", never 0.
    items,
    totals: buildTotals(items.filter((item) => item.balance).map((item) => ({
      chainId: network.chainId,
      chain: network.chain,
      asset: item.balance.asset,
      amount: item.balance.status === "ok" ? item.balance.amount : null,
      amountUsd: item.balance.amountUsd ?? null,
    })), { seed: [network] }),
    prices: await prices.spotTable([priceAssetFor(network.asset)]),
  };
}

export async function financeInventory(req, res, network, options = {}) {
  return res.status(200).json(await buildInventory(network, options));
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

export async function buildReconciliation(network) {
  return {
    schemaVersion: "finance-reconciliation-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    chains: [{ ...(await buildReconciliationSummary(network)), chainId: network.chainId }],
  };
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

  if (network.chain === "bnb" || network.chain === "robinhood") {
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

export async function buildOverview(network, options = {}) {
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

  // Money on the overview: protocol revenue (test coins excluded), what the
  // tracked inventory holds now, and from the fee-routing map what every fee
  // destination holds ("Held now") and the protocol-owned part of it ("Ours").
  // A failed read leaves its total out, not zero.
  const feeNetwork = feeRoutingNetwork({ chainId: network.chainId, environment: network.environment, solanaCluster: network.cluster });
  const readFeeRouting = options.feeRouting || ((n) => cachedFeeRouting({ network: n, days: feeRoutingDays(undefined), db: pool }));
  const [revenueRead, inventoryRead, feeRoutingRead] = await Promise.allSettled([
    buildRevenue(network, options),
    buildInventory(network, options),
    feeNetwork ? readFeeRouting(feeNetwork) : Promise.reject(new Error(`No fee routing for chain ${network.chainId}.`)),
  ]);

  return {
    schemaVersion: "finance-overview-v1",
    generatedAt,
    source: "dashboard-api",
    modules,
    chains: [{
      chain: network.chain,
      chainId: network.chainId,
      closeStatus: "not_ready",
      blockerCount,
      warningCount,
    }],
    totals: {
      revenue: revenueRead.status === "fulfilled" ? revenueRead.value.totals : null,
      holdings: inventoryRead.status === "fulfilled" ? inventoryRead.value.totals : null,
      feeHoldings: feeRoutingRead.status === "fulfilled" ? feeRoutingRead.value.totals?.holdings ?? null : null,
      ours: feeRoutingRead.status === "fulfilled" ? feeRoutingRead.value.totals?.ours ?? null : null,
    },
    prices: revenueRead.status === "fulfilled" ? revenueRead.value.prices : [],
    testCoinsExcluded: true,
  };
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

// --------------------------------------------------------------------------
// chainId=all: every mainnet, side by side, plus a cross-chain total. One
// chain failing does not hide the other two; it is reported per chain.

const MODULE_RANK = { disabled: 0, ready: 1, pending: 2, attention: 3, blocked: 4 };

export function mergeOverviewModules(perChain) {
  const merged = new Map();
  for (const modules of perChain) {
    for (const module of modules) {
      const prev = merged.get(module.key);
      if (!prev) { merged.set(module.key, { ...module }); continue; }
      prev.status = (MODULE_RANK[module.status] ?? 0) > (MODULE_RANK[prev.status] ?? 0) ? module.status : prev.status;
      prev.blockerCount += module.blockerCount;
      prev.warningCount += module.warningCount;
      if (module.lastUpdatedAt && (!prev.lastUpdatedAt || module.lastUpdatedAt > prev.lastUpdatedAt)) prev.lastUpdatedAt = module.lastUpdatedAt;
    }
  }
  return [...merged.values()];
}

function uniquePrices(payloads) {
  const out = new Map();
  for (const payload of payloads) for (const row of payload?.prices || []) if (!out.has(row.asset)) out.set(row.asset, row);
  return [...out.values()];
}

const ALL_CHAIN_MERGERS = {
  overview: (datas) => ({
    modules: mergeOverviewModules(datas.map((d) => d.modules)),
    totals: {
      revenue: mergeTotals(datas.map((d) => d.totals?.revenue)),
      holdings: mergeTotals(datas.map((d) => d.totals?.holdings)),
      feeHoldings: mergeTotals(datas.map((d) => d.totals?.feeHoldings)),
      ours: mergeTotals(datas.map((d) => d.totals?.ours)),
    },
  }),
  revenue: (datas) => ({ totals: mergeTotals(datas.map((d) => d.totals)), excludedTestCoinEvents: datas.reduce((s, d) => s + (d.excludedTestCoinEvents || 0), 0) }),
  rewards: (datas) => ({
    totals: {
      outstanding: mergeTotals(datas.map((d) => d.totals?.outstanding)),
      claimed: mergeTotals(datas.map((d) => d.totals?.claimed)),
      funded: mergeTotals(datas.map((d) => d.totals?.funded)),
    },
  }),
  inventory: (datas) => ({ totals: mergeTotals(datas.map((d) => d.totals)) }),
  reconciliation: () => ({}),
  "fee-routing": (datas) => ({
    totals: {
      holdings: mergeTotals(datas.map((d) => d.totals?.holdings)),
      ours: mergeTotals(datas.map((d) => d.totals?.ours)),
      inflows: mergeTotals(datas.map((d) => d.totals?.inflows)),
    },
  }),
};

export async function buildAllChains(page, networks, build) {
  const settled = await Promise.allSettled(networks.map((network) => build(network)));
  const datas = [];
  const sections = settled.map((result, index) => {
    const network = networks[index];
    const identity = {
      chainId: network.chainId,
      chain: network.chain,
      environment: network.environment,
      ...(network.cluster ? { cluster: network.cluster } : {}),
    };
    if (result.status === "fulfilled") {
      datas.push(result.value);
      return { ...identity, status: "ok", data: result.value };
    }
    console.error(`[api/admin/finance] ${page} chain ${network.chainId}`, result.reason);
    return { ...identity, status: "error", error: `The ${page} read failed for chain ${network.chainId}.` };
  });
  return {
    schemaVersion: "finance-all-chains-v1",
    page,
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    networks: sections,
    ...ALL_CHAIN_MERGERS[page](datas),
    prices: uniquePrices(datas),
    testCoinsExcluded: page !== "reconciliation",
    testCoinsNote: TEST_COINS_NOTE,
  };
}

// GET /api/admin/finance/fee-routing: read-only fee routing map, balances and
// inflows. Bearer only: the dashboard permission gate in railwayProxy.js must
// have resolved a principal with finance.view; ops keys and the legacy
// no-auth fallback are refused here.
export async function financeFeeRouting(req, res, { build = cachedFeeRouting, db = pool } = {}) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Fee routing is read-only (GET)." });
  }
  if (!req.dashboardPrincipal || !dashboardPrincipalCan(req.dashboardPrincipal, "finance.view")) {
    return res.status(401).json({ ok: false, error: "Dashboard sign-in with finance.view is required.", code: "FINANCE_VIEW_REQUIRED" });
  }
  const all = String(req.query?.chainId ?? "").trim().toLowerCase() === "all";
  const network = all ? null : feeRoutingNetwork(req.query || {});
  if (!all && !network) {
    return res.status(400).json({
      ok: false,
      error: "Fee routing covers mainnets only: chainId=all, BNB 56, Robinhood 4663, or Solana 101 with environment=production&solanaCluster=mainnet-beta.",
    });
  }
  try {
    const days = feeRoutingDays(req.query?.days);
    const payload = all
      ? await buildAllChains("fee-routing", feeRoutingAllNetworks(), (n) => build({ network: n, days, db }))
      : await build({ network, days, db });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[api/admin/finance/fee-routing]", error);
    return res.status(500).json({ ok: false, error: "Fee routing read failed." });
  }
}

export default async function financeAdmin(req, res) {
  const routePath = String(req.path || new URL(req.url, "http://localhost").pathname);
  if (routePath === "/api/admin/finance/fee-routing") return financeFeeRouting(req, res);
  // Payouts overview (read-only, bearer + finance.view): api/lib/financePayouts.js.
  if (routePath === "/api/admin/finance/payouts") return financePayouts(req, res, { db: pool, canView: (p) => dashboardPrincipalCan(p, "finance.view") });

  const auth = await requireAdminOrOps(req, res, { routeLabel: "admin/finance", allowOps: true });
  if (!auth) return;

  const pathname = String(req.path || new URL(req.url, "http://localhost").pathname);
  const method = String(req.method || "GET").toUpperCase();

  // LP harvest: mainnets only. Pure input check; financeLpHarvest is unchanged.
  if (pathname === "/api/admin/finance/lp-harvest") {
    const network = lpHarvestMainnetOnly(harvestNetwork(req));
    if (!network) return res.status(400).json({ ok: false, error: LP_HARVEST_SCOPE_ERROR });
    try {
      return await financeLpHarvest(req, res, network);
    } catch (error) {
      console.error("[api/admin/finance]", pathname, error);
      if (!res.headersSent) return res.status(500).json({ ok: false, error: "Finance operation failed." });
      return undefined;
    }
  }

  const scope = financeScope(req.query || {});
  if (!scope) return res.status(400).json({ ok: false, error: FINANCE_SCOPE_ERROR });

  const builders = {
    "/api/admin/finance/overview": ["overview", (n) => buildOverview(n)],
    "/api/admin/finance/rewards": ["rewards", (n) => buildRewards(n)],
    "/api/admin/finance/revenue": ["revenue", (n) => buildRevenue(n)],
    "/api/admin/finance/inventory": ["inventory", (n) => buildInventory(n)],
    "/api/admin/finance/reconciliation": ["reconciliation", (n) => buildReconciliation(n)],
  };
  try {
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }
    const route = builders[pathname];
    if (route) {
      const [page, build] = route;
      const payload = scope.all ? await buildAllChains(page, scope.networks, build) : await build(scope.networks[0]);
      return res.status(200).json(payload);
    }
    return res.status(404).json({ ok: false, error: "Unknown finance admin route." });
  } catch (error) {
    console.error("[api/admin/finance]", pathname, error);
    if (!res.headersSent) return res.status(500).json({ ok: false, error: "Finance operation failed." });
  }
}

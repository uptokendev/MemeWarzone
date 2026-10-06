import { pool } from "../../server/db.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";
import { defaultEvmChainId } from "../lib/defaultEvmChain.js";
import { normalizeSolanaCluster, resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";
import { cachedFeeRouting, feeRoutingAllNetworks, feeRoutingDays, feeRoutingNetwork } from "../lib/financeFeeRouting.js";
import { dashboardPrincipalCan } from "../dashboard/_access.js";
import { buildTotals, defaultPriceService, mergeTotals, priceAssetFor } from "../lib/financePrices.js";
import { publicHiddenWhere } from "../lib/publicHiddenCampaigns.js";
import { cachedPayouts, financePayouts, payoutsDays } from "../lib/financePayouts.js";
import { ACCOUNTING_MODULES, CHAIN_MODULES, STATUS_MODULES, accountingChecks, lpReadSummary, modulesFromChecks, openPastMonths, reconciliationChecks, revenueChecks, rewardChecks, walletChecks } from "../lib/financeStatus.js";
import { ACCOUNTING_MIGRATION, accountingTablesMissing, assertAccountingTables, listCloses, listCosts, readSettings } from "../lib/financeAccountingStore.js";
import { expandCost } from "../lib/financeAccountingCosts.js";
import { effectiveTaxRules } from "../lib/financeAccountingTax.js";
import { effectiveDistributionSettings } from "../lib/financeAccountingDistributions.js";
import { buildFinanceSummary, cachedFinanceSummary, summaryMonths } from "../lib/financeSummary.js";
import financeAccounting, { isFinanceAccountingPath } from "./financeAccounting.js";
import { sharedRevenueLanes, summaryRevenueLanes, valueRevenueLanes } from "../lib/financeRevenueLanes.js";
import { ageSnapshotMeta, runWithSnapshotUsage, snapshotCacheFor, snapshotKeys, snapshotMeta, trackSnapshots } from "../lib/financeSnapshots.js";
import { refreshFinanceSnapshots } from "../lib/financeSnapshotJobs.js";

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

export const LP_HARVEST_SCOPE_ERROR = "LP harvest runs on Solana mainnet only: chainId=101 with environment=production&solanaCluster=mainnet-beta. Testnets and devnet are refused.";

// Founder decision 2026-10-04: harvest on BNB 56 and Robinhood 4663 is paused. Their protocol 20%
// would land as WBNB/WETH in ProtocolRevenueVault, which has no ERC20 withdraw. Read-only fee
// views stay; only the harvest write is refused.
export const LP_HARVEST_EVM_PAUSED_ERROR = "Harvest on BNB and Robinhood is paused until the protocol share has a vault that can pay it out.";
const LP_HARVEST_PAUSED_CHAIN_IDS = new Set([56, 4663]);

/** True when the request names (or defaults to) BNB 56 or Robinhood 4663. */
export function lpHarvestEvmPaused(req) {
  return LP_HARVEST_PAUSED_CHAIN_IDS.has(Number(req.query?.chainId ?? defaultEvmChainId()));
}

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

// The vault that pays the reward_ledger rewards (the weekly airdrop), from the
// fee-routing map the Payouts page also reads: Solana airdrop_vault PDA, EVM
// airdrop distributor. No env list: the map already knows the addresses.
const REWARD_VAULT_IDS = Object.freeze({ solana: Object.freeze(["airdrop_vault"]), evm: Object.freeze(["airdrop_distributor"]) });

export function rewardFundingFromFeeRouting(network, feeRouting) {
  const ids = network.chain === "solana" ? REWARD_VAULT_IDS.solana : REWARD_VAULT_IDS.evm;
  const vaults = (feeRouting?.destinations || []).filter((d) => ids.includes(d.id) && d.address);
  if (vaults.length === 0) return { configured: false, readable: false, vaultCount: 0, fundedRaw: 0n, vaults: [], error: "The fee routing map has no reward vault for this chain." };
  let fundedRaw = 0n;
  for (const vault of vaults) {
    const balance = (vault.balances || []).find((b) => b.asset === network.asset);
    if (!balance || balance.status !== "ok" || !/^\d+$/.test(String(balance.raw ?? ""))) {
      return { configured: true, readable: false, vaultCount: vaults.length, fundedRaw: 0n, vaults: vaults.map(({ id, label, address }) => ({ id, label, address })), error: balance?.error || `${vault.label} balance could not be read.` };
    }
    fundedRaw += BigInt(balance.raw);
  }
  return { configured: true, readable: true, vaultCount: vaults.length, fundedRaw, vaults: vaults.map(({ id, label, address }) => ({ id, label, address })), error: null };
}

async function readRewardFunding(network, { feeRouting } = {}) {
  try {
    return rewardFundingFromFeeRouting(network, feeRouting || await readFeeRoutingFor(network));
  } catch (error) {
    return { configured: true, readable: false, vaultCount: 0, fundedRaw: 0n, vaults: [], error: String(error?.message || "The fee routing read failed.").slice(0, 200) };
  }
}

async function rewardCoverage(network, obligationRaw, options = {}) {
  const funding = await readRewardFunding(network, options);
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
      vaults: funding.vaults,
      ...(funding.error ? { error: funding.error } : {}),
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

// The revenue lanes with their hourly buckets: protocol share of bonding-curve
// trades, paid UP votes, arena boosts / entries, sponsorships, Home
// placements, DBC referral and EVM graduation (api/lib/financeRevenueLanes.js,
// the one definition the accounting Close / tax / CSV also read); hidden test
// coins left out. /revenue values them as one lifetime figure, /summary month
// by month.
export async function revenueLanes(network) {
  if (!solanaRowsAreMainnet(network)) {
    return { lanes: [], excludedEvents: 0, hiddenCampaigns: [], notice: "This API reads the test database, whose chain 101 rows are Solana devnet. Mainnet revenue is on the live API." };
  }
  let hiddenCampaigns = [];
  try {
    hiddenCampaigns = await hiddenCampaignAddresses(network);
  } catch (error) {
    if (!schemaMissing(error)) throw error;
  }
  const shared = await sharedRevenueLanes(pool, network);
  return { lanes: shared.lanes, excludedEvents: shared.excludedEvents, hiddenCampaigns, notes: shared.notes || [], notice: null };
}

export async function buildRevenue(network, { prices = defaultPriceService() } = {}) {
  return buildRevenueFromLanes(network, await revenueLanes(network), { prices });
}

async function buildRevenueFromLanes(network, read, { prices = defaultPriceService() } = {}) {
  const { lanes, excludedEvents, hiddenCampaigns, notice, notes = [] } = read;

  const aggregates = await valueRevenueLanes(lanes, network, prices);

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
    ...(notes.length ? { warnings: notes } : {}),
    ...(notice ? { notice } : {}),
  };
}

// Fee routing for a finance mainnet, cached 60 s and shared with the Fee
// Routing, Payouts and Summary pages.
function feeNetworkFor(network) {
  const feeNetwork = feeRoutingNetwork({ chainId: network.chainId, environment: network.environment, solanaCluster: network.cluster });
  if (!feeNetwork) throw new Error(`No fee routing for chain ${network.chainId}.`);
  return feeNetwork;
}

function readFeeRoutingFor(network) {
  return cachedFeeRouting({ network: feeNetworkFor(network), days: feeRoutingDays(undefined), db: pool });
}

function readPayoutsFor(network) {
  return cachedPayouts({ network: feeNetworkFor(network), days: payoutsDays(undefined), db: pool });
}

const INVENTORY_KINDS = Object.freeze({ wallet: "wallet", multisig: "multisig", vault: "vault", pda: "vault", "token-account": "wallet", contract: "contract" });
const KIND_LABELS = Object.freeze({ wallet: "wallet", multisig: "multisig", vault: "vault", pda: "program account", "token-account": "token account", contract: "contract" });

/**
 * The wallet and vault list for Settings, taken from the fee-routing map:
 * every destination it knows (addresses from the deployment records and the
 * program seeds), with the balances it read. No env list is needed. A
 * destination without an address is listed under `missing` with what to set.
 */
export function inventoryFromFeeRouting(network, feeRouting) {
  const items = [];
  const missing = [];
  const seen = new Set();
  for (const d of feeRouting?.destinations || []) {
    if (d.kind === "pda-set") continue;
    if (!d.address) {
      const notSet = (d.balances || []).find((b) => b.status === "not_configured");
      missing.push({ id: d.id, label: d.label, note: notSet?.error || "No address recorded for this chain." });
      continue;
    }
    const key = network.chain === "solana" ? d.address : d.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const balances = d.balances || [];
    const native = balances.find((b) => b.asset === network.asset) || balances[0] || null;
    items.push({
      id: `${network.chainId}-${d.id}`,
      chain: network.chain,
      kind: INVENTORY_KINDS[d.kind] || "contract",
      kindLabel: KIND_LABELS[d.kind] || d.kind || "contract",
      label: String(d.label || d.id).slice(0, 120),
      address: d.address,
      role: String(d.role || d.custody || d.label || d.id).slice(0, 120),
      status: "configured",
      ownership: d.ownership || null,
      watchOnly: (d.flags || []).includes("watch") || d.ownership === "watch",
      ...(native ? { balance: { asset: native.asset, amount: native.status === "ok" ? native.amount : null, raw: native.status === "ok" ? native.raw : null, status: native.status === "ok" ? "ok" : "unknown", source: native.source || "rpc", asOf: native.asOf || null, ...(native.status === "ok" ? {} : { error: native.error || "Balance read failed." }), amountUsd: native.amountUsd ?? null, priceUsd: native.priceUsd ?? null, priceSource: native.priceSource ?? null, priceAt: native.priceAt ?? null, priceBasis: native.priceBasis ?? null } } : {}),
      balances: balances.map((b) => ({ asset: b.asset, amount: b.status === "ok" ? b.amount : null, status: b.status === "ok" ? "ok" : "unknown", amountUsd: b.amountUsd ?? null, ...(b.status === "ok" ? {} : { error: b.error || "Balance read failed." }) })),
    });
  }
  return { items, missing };
}

export async function buildInventory(network, { feeRouting, prices = defaultPriceService() } = {}) {
  const routing = feeRouting || await readFeeRoutingFor(network);
  const { items, missing } = inventoryFromFeeRouting(network, routing);
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
    addressSource: "fee-routing",
    // Each item carries its live balances; a failed read is "unknown", never 0.
    items,
    missing,
    // Same total as "Held now": every balance except watch-only wallets.
    totals: routing?.totals?.holdings ?? buildTotals([], { seed: [network] }),
    prices: routing?.prices?.length ? routing.prices : await prices.spotTable([priceAssetFor(network.asset)]),
  };
}

export async function financeInventory(req, res, network, options = {}) {
  return res.status(200).json(await buildInventory(network, options));
}

function indexerHeaders() {
  const opsKey = String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
  return opsKey ? { Accept: "application/json", "x-ops-key": opsKey } : { Accept: "application/json" };
}

// The indexer LP read from the stored snapshot (rebuilt by cron:finance-snapshots).
function readIndexerLpFees(network) {
  return snapshotCacheFor(pool).get(snapshotKeys.indexerLp(network), "indexer-lp", () => readIndexerLpFeesLive(network));
}

export async function readIndexerLpFeesLive(network) {
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

// The protocol's harvested LP share after graduation, as the Revenue page adds
// it in the browser (financeRevenue.ts): lifetime only, no event times, so the
// native side is valued at current price. The coin's own token has no price
// and is counted, not guessed. Hidden test coins are left out.
const WRAPPED_NATIVE = new Set(["SOL", "WSOL", "BNB", "WBNB", "ETH", "WETH"]);

export function lpShareFromIndexer(payload, network, hidden) {
  const solana = network.chain === "solana";
  const skip = new Set(hidden.map((a) => (solana ? a : a.toLowerCase())));
  const amounts = [];
  let unpricedTokenCount = 0;
  for (const item of payload?.items || []) {
    const campaign = typeof item?.campaignAddress === "string" ? item.campaignAddress.trim() : "";
    if (campaign && skip.has(solana ? campaign : campaign.toLowerCase())) continue;
    const harvested = item?.fees?.harvestedLifetime;
    if (!harvested || typeof harvested !== "object") continue;
    if (solana) {
      const unharvested = item.fees.unharvested || {};
      for (const [amount, symbol] of [[harvested.protocolToken0Display, unharvested.token0Symbol], [harvested.protocolToken1Display, unharvested.token1Symbol]]) {
        if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) === 0) continue;
        if (WRAPPED_NATIVE.has(String(symbol || "").toUpperCase())) amounts.push(amount);
        else unpricedTokenCount += 1;
      }
      continue;
    }
    if (item.fees.registered !== true) continue;
    const token = String(item.tokenAddress || "").toLowerCase();
    for (const [side, raw] of [[item.fees.token0, harvested.protocolToken0Raw], [item.fees.token1, harvested.protocolToken1Raw]]) {
      if (typeof raw !== "string" || !/^\d+$/.test(raw) || /^0+$/.test(raw)) continue;
      if (String(side || "").toLowerCase() === token) { unpricedTokenCount += 1; continue; }
      const amount = atomicToDecimal(raw, network.decimals);
      if (amount) amounts.push(amount);
    }
  }
  return { amounts, unpricedTokenCount };
}

async function readLpShare(network, prices) {
  const [payload, hidden] = await Promise.all([readIndexerLpFees(network), hiddenCampaignAddresses(network)]);
  const { amounts, unpricedTokenCount } = lpShareFromIndexer(payload, network, hidden);
  const entries = [];
  for (const amount of amounts) {
    const usd = await prices.valueAtSpot(network.asset, amount);
    entries.push({ asset: network.asset, amount, amountUsd: usd.amountUsd });
  }
  return { entries, unpricedTokenCount };
}

function errorText(reason, fallback) {
  return String(reason?.message || reason || fallback).slice(0, 300);
}

/**
 * Every check of one chain (financeStatus.js) from the reads the other pages
 * make: fee routing, payouts, the revenue lanes and the indexer LP read.
 * Each read is settled on its own, so one failing source becomes one check.
 */
export async function chainStatus(network, { readFeeRouting = readFeeRoutingFor, readPayouts = readPayoutsFor, readRevenueLanes = revenueLanes, readLpFees = readIndexerLpFees } = {}) {
  const [feeRead, payoutsRead, lanesRead, lpRead] = await Promise.allSettled([
    readFeeRouting(network),
    readPayouts(network),
    readRevenueLanes(network),
    readLpFees(network),
  ]);
  const feeRouting = feeRead.status === "fulfilled" ? feeRead.value : null;
  const payouts = payoutsRead.status === "fulfilled" ? payoutsRead.value : null;
  const lanes = lanesRead.status === "fulfilled" ? lanesRead.value : null;
  if (feeRead.status === "rejected") console.error(`[api/admin/finance] status fee routing ${network.chainId}`, feeRead.reason);
  if (payoutsRead.status === "rejected") console.error(`[api/admin/finance] status payouts ${network.chainId}`, payoutsRead.reason);
  if (lanesRead.status === "rejected") console.error(`[api/admin/finance] status revenue ${network.chainId}`, lanesRead.reason);
  const lp = lpRead.status === "fulfilled" ? lpReadSummary(lpRead.value, lanes?.hiddenCampaigns || [], { solana: network.chain === "solana" }) : null;
  const checks = [
    ...walletChecks(network, feeRouting, feeRead.status === "rejected" ? errorText(feeRead.reason, "The fee routing read failed.") : null),
    ...revenueChecks(network, {
      revenueError: lanesRead.status === "rejected" ? errorText(lanesRead.reason, "The revenue read failed.") : lanes?.notice || null,
      notes: lanes?.notes || [],
      lp,
      lpError: lpRead.status === "rejected" ? errorText(lpRead.reason, "Indexer LP read failed.") : null,
    }),
    ...rewardChecks(network, { payouts, payoutsError: payoutsRead.status === "rejected" ? errorText(payoutsRead.reason, "The payouts read failed.") : null }),
    ...reconciliationChecks(network, { feeRouting, payouts }),
  ];
  return { checks, feeRouting, payouts, lanes, lp };
}

export async function buildReconciliation(network, options = {}) {
  const { checks, feeRouting, payouts, lp } = await chainStatus(network, options);
  const own = checks.filter((c) => c.module === "reconciliation" || c.module === "inventory" || c.module === "rewards");
  const tracked = (feeRouting?.destinations || []).filter((d) => d.address && !(d.flags || []).includes("watch") && (d.balances || []).length);
  const balanced = tracked.filter((d) => d.balances.every((b) => b.status === "ok"));
  const status = own.some((c) => c.status === "blocked") ? "blocked" : own.some((c) => c.status === "attention") ? "attention" : "ready";
  return {
    schemaVersion: "finance-reconciliation-v1",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    chains: [{
      chain: network.chain,
      chainId: network.chainId,
      status,
      trackedInventoryCount: tracked.length,
      balancedInventoryCount: balanced.length,
      balanceBreakCount: (payouts?.types || []).filter((t) => t.coverage?.status === "short").length,
      missingPriceCount: feeRouting?.totals?.holdings?.missingPriceCount ?? 0,
      duplicateCandidateCount: 0,
      quarantinedTransferCount: 0,
      staleSourceCount: (feeRouting?.wiring || []).filter((w) => w.status === "unknown").length + (lp?.errors.length ?? 0),
    }],
    checks: own,
  };
}

// Accounting status (costs, tax, close, distributions): one set for all
// chains, from the accounting tables. `activeMonths` are the months with
// revenue (from the lanes the chain status read) or costs.
export async function accountingStatus({ db = pool, revenueMonths = [], now = Date.now() } = {}) {
  const currentMonth = new Date(now).toISOString().slice(0, 7);
  try {
    await assertAccountingTables(db);
    const [costs, settingsRow] = await Promise.all([listCosts(db), readSettings(db)]);
    const costMonths = [];
    for (const cost of costs) for (const occurrence of expandCost(cost, "2024-01", currentMonth, { onOrBefore: new Date(now).toISOString().slice(0, 10) })) costMonths.push(occurrence.month);
    const activeMonths = [...new Set([...revenueMonths, ...costMonths])].filter((m) => m < currentMonth);
    const closes = activeMonths.length ? await listCloses(db, [...activeMonths].sort()[0], currentMonth) : new Map();
    const closed = [...closes.entries()].filter(([, row]) => row?.status === "closed").map(([month]) => month);
    const openMonths = openPastMonths(activeMonths, closed, currentMonth);
    return accountingChecks({
      costCount: costs.length,
      taxIsDefault: effectiveTaxRules(settingsRow?.tax_reserve_rules).isDefault !== false,
      openMonths,
      activeMonths: activeMonths.length,
      distribution: effectiveDistributionSettings(settingsRow?.distribution),
    });
  } catch (error) {
    if (accountingTablesMissing(error)) return accountingChecks({ tablesMissing: true, migration: ACCOUNTING_MIGRATION });
    console.error("[api/admin/finance] accounting status", error);
    return accountingChecks({ readError: errorText(error, "The accounting read failed.") });
  }
}

/** Months (YYYY-MM) with revenue in the lanes of one chain. */
export function laneMonths(lanes) {
  const out = new Set();
  for (const lane of lanes?.lanes || []) for (const bucket of lane.buckets || []) {
    const ms = bucket.hour instanceof Date ? bucket.hour.getTime() : Date.parse(String(bucket.hour ?? ""));
    if (Number.isFinite(ms)) out.add(new Date(ms).toISOString().slice(0, 7));
  }
  return [...out];
}

/**
 * Overview of one chain: the status checks, module tiles and the money
 * totals. Revenue uses the same lanes and valuation as Revenue and Summary;
 * Held now and Ours come from the fee-routing map. `options.accounting` (the
 * accounting checks, computed once for all chains) is added when given.
 */
export async function buildOverview(network, options = {}) {
  const generatedAt = new Date().toISOString();
  const status = await chainStatus(network, options);
  const accounting = options.accounting || [];
  const checks = [...status.checks, ...accounting];
  const chainChecks = status.checks;
  const blockerCount = chainChecks.filter((c) => c.status === "blocked").length;
  const warningCount = chainChecks.filter((c) => c.status === "attention").length;

  let revenue = null;
  try {
    revenue = status.lanes ? (await buildRevenueFromLanes(network, status.lanes, options)).totals : null;
  } catch (error) {
    console.error(`[api/admin/finance] overview revenue ${network.chainId}`, error);
  }
  const prices = status.feeRouting?.prices || [];

  return {
    schemaVersion: "finance-overview-v1",
    generatedAt,
    source: "dashboard-api",
    modules: modulesFromChecks(checks, accounting.length ? STATUS_MODULES : CHAIN_MODULES, generatedAt),
    // Kept for older dashboards: counts of this chain's checks. A month is
    // closed for all chains together (see the close checks), not per chain.
    chains: [{ chain: network.chain, chainId: network.chainId, closeStatus: blockerCount ? "not_ready" : "review_ready", blockerCount, warningCount }],
    checks,
    revenueMonths: laneMonths(status.lanes),
    totals: {
      revenue,
      holdings: status.feeRouting?.totals?.holdings ?? null,
      feeHoldings: status.feeRouting?.totals?.holdings ?? null,
      ours: status.feeRouting?.totals?.ours ?? null,
    },
    prices,
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
    revenueMonths: [...new Set(datas.flatMap((d) => d.revenueMonths || []))],
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

/**
 * The overview for a scope. Chain checks per mainnet; the accounting checks
 * (costs, tax, close, distributions) once, because they cover all chains.
 * The close check needs the months with revenue on every mainnet, so a
 * single-chain overview also reads the other chains' revenue months.
 */
export async function buildOverviewScope(scope, { build = buildOverview, accounting = accountingStatus, readRevenueMonths = async (n) => laneMonths(await revenueLanes(n)) } = {}) {
  if (scope.all) {
    const payload = await buildAllChains("overview", scope.networks, (n) => build(n));
    const checks = await accounting({ revenueMonths: payload.revenueMonths || [] });
    const chainModules = (payload.modules || []).filter((m) => CHAIN_MODULES.includes(m.key));
    return { ...payload, modules: [...chainModules, ...modulesFromChecks(checks, ACCOUNTING_MODULES, payload.generatedAt)], checks };
  }
  const network = scope.networks[0];
  const others = FINANCE_MAINNETS.filter((n) => n.chainId !== network.chainId);
  const [data, otherMonths] = await Promise.all([
    build(network),
    Promise.allSettled(others.map((n) => readRevenueMonths({ ...n }))),
  ]);
  const months = [...(data.revenueMonths || []), ...otherMonths.flatMap((r) => (r.status === "fulfilled" ? r.value : []))];
  const checks = await accounting({ revenueMonths: months });
  const all = [...(data.checks || []), ...checks];
  return { ...data, checks: all, modules: modulesFromChecks(all, STATUS_MODULES, data.generatedAt) };
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

// GET /api/admin/finance/summary: the plain summary page in one read. Bearer
// only, like fee routing (it carries the fee-routing balances): the dashboard
// gate in railwayProxy.js resolves finance.view for a GET. Cached 60 s.
export async function financeSummary(req, res, { build = defaultSummaryBuild } = {}) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "The finance summary is read-only (GET)." });
  }
  if (!req.dashboardPrincipal || !dashboardPrincipalCan(req.dashboardPrincipal, "finance.view")) {
    return res.status(401).json({ ok: false, error: "Dashboard sign-in with finance.view is required.", code: "FINANCE_VIEW_REQUIRED" });
  }
  const currency = String(req.query?.currency ?? "usd").trim().toLowerCase();
  if (currency !== "usd" && currency !== "native") {
    return res.status(400).json({ ok: false, error: "currency must be usd or native." });
  }
  try {
    const months = summaryMonths(req.query?.months);
    const payload = build === defaultSummaryBuild
      ? await snapshotCacheFor(pool).get(snapshotKeys.summary(months), "summary", () => build(months))
      : await cachedFinanceSummary(`months:${months}`, () => build(months));
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json(payload?.snapshot ? { ...payload, snapshot: ageSnapshotMeta(payload.snapshot) } : payload);
  } catch (error) {
    console.error("[api/admin/finance/summary]", error);
    return res.status(500).json({ ok: false, error: "Finance summary read failed." });
  }
}

// The summary is stored as a whole (snapshot summary:<months>, rebuilt by the
// cron), so it carries the snapshot block of the chain reads it was built from.
export async function defaultSummaryBuild(months) {
  const { value, used } = await trackSnapshots(() => summaryBuild(months));
  const meta = snapshotMeta(used);
  return meta ? { ...value, snapshot: meta } : value;
}

function summaryBuild(months) {
  const prices = defaultPriceService();
  const days = feeRoutingDays(undefined);
  return buildFinanceSummary({
    networks: FINANCE_MAINNETS.map((n) => ({ ...n })),
    months,
    prices,
    readRevenue: async (network) => {
      const read = await revenueLanes(network);
      if (read.notice) return { unavailable: read.notice, lanes: [] };
      return {
        lanes: summaryRevenueLanes(read.lanes, network),
        excludedTestCoinEvents: read.excludedEvents,
      };
    },
    readLpShare: (network) => readLpShare(network, prices),
    readFeeRouting: (network) => {
      const feeNetwork = feeRoutingNetwork({ chainId: network.chainId, environment: network.environment, solanaCluster: network.cluster });
      if (!feeNetwork) throw new Error(`No fee routing for chain ${network.chainId}.`);
      return cachedFeeRouting({ network: feeNetwork, days, db: pool });
    },
    // Owed to users = the Payouts page's "Owed now" (league, battle league,
    // MWL, recruiter, airdrop and creator fees), so both pages agree. The
    // reward ledger alone (/rewards) is only the weekly airdrop.
    readRewards: async (network) => {
      const payouts = await readPayoutsFor(network);
      return { totals: { outstanding: payouts?.totals?.owed ?? null } };
    },
  });
}

/**
 * GET  /api/admin/finance/snapshots          when each stored chain read was built (finance.view)
 * POST /api/admin/finance/snapshots/refresh  rebuild them now (finance.manage), body {chainId?}
 * Bearer only, like fee routing. The refresh reads the chain (view calls only) and stores the result.
 */
export async function financeSnapshots(req, res, { db = pool, refresh = refreshFinanceSnapshots } = {}) {
  const routePath = String(req.path || new URL(req.url, "http://localhost").pathname).replace(/\/+$/, "");
  const method = String(req.method || "GET").toUpperCase();
  if (!req.dashboardPrincipal || !dashboardPrincipalCan(req.dashboardPrincipal, "finance.view")) {
    return res.status(401).json({ ok: false, error: "Dashboard sign-in with finance.view is required.", code: "FINANCE_VIEW_REQUIRED" });
  }
  res.setHeader("Cache-Control", "no-store");
  try {
    if (routePath === "/api/admin/finance/snapshots") {
      if (method !== "GET" && method !== "HEAD") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ ok: false, error: "Method not allowed." });
      }
      return res.status(200).json({ ok: true, ...(await snapshotCacheFor(db).list()) });
    }
    if (routePath === "/api/admin/finance/snapshots/refresh") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ ok: false, error: "Refresh requires POST." });
      }
      if (!dashboardPrincipalCan(req.dashboardPrincipal, "finance.manage")) {
        return res.status(403).json({ ok: false, error: "finance.manage is required to refresh the chain reads.", code: "FINANCE_MANAGE_REQUIRED" });
      }
      const raw = String(req.body?.chainId ?? req.query?.chainId ?? "all").trim().toLowerCase();
      const chainIds = raw === "" || raw === "all" ? null : [Number(raw)];
      if (chainIds && !FINANCE_MAINNETS.some((n) => n.chainId === chainIds[0])) {
        return res.status(400).json({ ok: false, error: FINANCE_SCOPE_ERROR });
      }
      const { apiLpFeesSnapshotKey, lpFeesSnapshotBuild } = await import("../dashboard/lp-fees.js");
      const result = await refresh({ db, chainIds, readIndexerLp: readIndexerLpFeesLive, readApiLpFees: { key: apiLpFeesSnapshotKey, build: (q) => lpFeesSnapshotBuild(q) }, buildSummary: chainIds ? null : defaultSummaryBuild, timeoutMs: 100_000 });
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(404).json({ ok: false, error: "Unknown finance admin route." });
  } catch (error) {
    console.error("[api/admin/finance/snapshots]", error);
    return res.status(500).json({ ok: false, error: "Finance snapshot request failed." });
  }
}

/**
 * Every finance response says how old its chain data is: `snapshot` (asOf,
 * ageSeconds, stale, sources) when the request read any stored chain snapshot.
 * Added to object payloads only; the figures are untouched.
 */
export default async function financeAdmin(req, res) {
  const used = [];
  const json = typeof res.json === "function" ? res.json.bind(res) : null;
  if (json) {
    res.json = (payload) => {
      const meta = snapshotMeta(used);
      const plain = payload && typeof payload === "object" && !Array.isArray(payload) && payload.ok !== false && payload.snapshot === undefined;
      return json(meta && plain ? { ...payload, snapshot: meta } : payload);
    };
  }
  return runWithSnapshotUsage(used, () => financeAdminRoutes(req, res));
}

async function financeAdminRoutes(req, res) {
  const routePath = String(req.path || new URL(req.url, "http://localhost").pathname);
  if (routePath === "/api/admin/finance/snapshots" || routePath.startsWith("/api/admin/finance/snapshots/")) return financeSnapshots(req, res);
  if (routePath === "/api/admin/finance/fee-routing") return financeFeeRouting(req, res);
  // Payouts overview (read-only, bearer + finance.view): api/lib/financePayouts.js.
  if (routePath === "/api/admin/finance/payouts") return financePayouts(req, res, { db: pool, canView: (p) => dashboardPrincipalCan(p, "finance.view") });
  if (routePath === "/api/admin/finance/summary") return financeSummary(req, res);
  // Accounting (costs, close, tax reserve, exports, distributions): dashboard sign-in only, see financeAccounting.js.
  if (isFinanceAccountingPath(routePath)) return financeAccounting(req, res);

  const auth = await requireAdminOrOps(req, res, { routeLabel: "admin/finance", allowOps: true });
  if (!auth) return;

  const pathname = String(req.path || new URL(req.url, "http://localhost").pathname);
  const method = String(req.method || "GET").toUpperCase();

  // LP harvest: mainnets only. Pure input check; financeLpHarvest is unchanged.
  if (pathname === "/api/admin/finance/lp-harvest") {
    if (lpHarvestEvmPaused(req)) return res.status(400).json({ ok: false, code: "LP_HARVEST_PAUSED", error: LP_HARVEST_EVM_PAUSED_ERROR });
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

  if (pathname === "/api/admin/finance/overview" && method === "GET") {
    try {
      return res.status(200).json(await buildOverviewScope(scope));
    } catch (error) {
      console.error("[api/admin/finance]", pathname, error);
      return res.status(500).json({ ok: false, error: "Finance operation failed." });
    }
  }

  const builders = {
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

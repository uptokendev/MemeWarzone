// Finance payouts read model: per payout type and mainnet, what was paid, what
// is owed now and from which vault, whether that vault covers it, and what is
// scheduled next.
//
// Strictly read-only. Database reads are SELECTs on existing tables; vault
// balances come from the fee-routing read model (cachedFeeRouting, JSON-RPC
// balance reads) plus a few view getters (eth_call / getAccountInfo /
// getMultipleAccounts). Nothing is built, signed or sent, and no key is loaded.
// A read that fails is "unknown" with no amount, never a zero.

import { normalizeSolanaCluster } from "../../shared/solanaCurrentAuthority.mjs";
import {
  atomicToDecimal,
  cachedFeeRouting,
  feeRoutingAllNetworks,
  feeRoutingNetwork,
  solanaRpcUrls,
} from "./financeFeeRouting.js";
import { readEvmCall, readEvmNative, readSolanaAccountData } from "./financeFeeRoutingReaders.js";
import { decodeRouteState, deriveSolanaTreasuryPdas } from "./financeFeeRoutingSolana.js";
import { evmGetterSelector } from "./financeFeeRoutingEvm.js";
import { buildTotals, defaultPriceService, mergeTotals, priceAssetFor } from "./financePrices.js";
import { mwlVaultAddress } from "./mwlPayoutVaults.js";
import { notPublicHiddenCampaignSql, publicHiddenWhere } from "./publicHiddenSql.js";
import {
  CREATOR_FEE_VAULT_BYTES,
  FEE_ESCROW_BYTES,
  SOLANA_LAUNCHPAD_PROGRAM_ID,
  computeCreatorFeeClaimable,
  decodeRpcAccount,
  deriveCampaignFeeAccounts,
} from "./solanaCreatorFeeMath.js";
import { getRpcUrls } from "./getServerReadProvider.js";

export const PAYOUTS_SCHEMA = "finance-payouts-v1";
const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

// Retired monthly league vaults (wei cap bug). league.js,
// evmLeagueClaimVerification.js and publish-evm-league-roots.mjs still fall
// back to these when MONTHLY_LEAGUE_TREASURY_ADDRESS_<id> is not set.
export const PAYOUT_CODE_MONTHLY_FALLBACK = Object.freeze({
  56: "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8",
  4663: "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238",
});
// publish-evm-league-roots.mjs falls back to these weekly vaults.
const PAYOUT_CODE_WEEKLY_FALLBACK = Object.freeze({
  56: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
  4663: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
});

const EXPLORERS = Object.freeze({
  101: { tx: "https://solscan.io/tx/", account: "https://solscan.io/account/" },
  56: { tx: "https://bscscan.com/tx/", account: "https://bscscan.com/address/" },
  4663: { tx: "https://explorer.chain.robinhood.com/tx/", account: "https://explorer.chain.robinhood.com/address/" },
});

export const PAYOUT_TYPES = Object.freeze([
  { id: "weekly_league", label: "Weekly league prizes", explain: "Prizes for the best traders and coins of each week, paid from the weekly league vault." },
  { id: "monthly_league", label: "Monthly league prizes", explain: "Prizes for the best traders and coins of each month, paid from the monthly league vault." },
  { id: "mwl", label: "Major War League (monthly and quarterly)", explain: "Battle league prizes for the owners of winning coins: 60% of the league money pays each month, 40% pays at quarter end." },
  { id: "recruiter", label: "Recruiter rewards", explain: "The recruiter share of each trade made by a wallet a recruiter brought in." },
  { id: "creator_fees", label: "Creator fees", explain: "The coin creator's share of every trade fee. Creators claim it themselves." },
  { id: "airdrop", label: "Weekly airdrop", explain: "Weekly draw for active traders and creators, paid from the airdrop pot." },
  { id: "squad", label: "Squad rewards", explain: "The squad share of linked trades. It is collected, but there is no rule yet for who gets it." },
  { id: "arena_prizes", label: "War pool and arena prizes", explain: "Stakes and boosts in battles; winners claim their prize after the battle ends." },
  { id: "operator_fill", label: "Operator cap fill", explain: "The first $10,000 of protocol revenue goes to the operator wallet to cover running costs; everything after goes to the multisig." },
]);

// One plain line per vault id, for a reader who does not know the contracts.
const VAULT_PLAIN = Object.freeze({
  league_weekly: "Program-held account that holds weekly league money until winners claim it.",
  league_monthly: "Program-held account that holds monthly league money until winners claim it.",
  weekly_league: "Contract that holds weekly league money until winners claim it.",
  monthly_league: "Contract the fee router now sends monthly league money to.",
  monthly_league_old: "Older monthly league contract, replaced because its prize cap was set in the wrong unit.",
  monthly_payout: "Contract the payout code pays monthly league claims from.",
  mwl_vault: "Program-held account for Major War League money (both monthly and quarterly prizes).",
  mwl_monthly: "Contract that pays Major War League monthly prizes.",
  mwl_quarterly: "Contract that pays Major War League quarterly prizes.",
  post_grad_league: "Contract that collects the league share of battles and splits it 60/40 into the two prize contracts.",
  recruiter_vault: "Holds recruiter rewards until they are paid out.",
  creator_fee_accounts: "One fee account per coin; the creator's share stays there until the creator claims it.",
  creator_vault_v2: "Holds creator, holder and buyback balances for each newer coin.",
  creator_vault_v1: "Holds unclaimed creator fees for older coins.",
  airdrop_vault: "Program-held account that holds the weekly airdrop pot.",
  airdrop_distributor: "Contract that pays each week's airdrop winners.",
  community_vault: "Holds the airdrop and squad pots before they are handed out.",
  squad_vault: "Program-held account that collects the squad share.",
  war_pool: "Holds battle stakes, boosts and unclaimed prizes.",
  event_prize: "Holds sponsorship money set aside as event prizes.",
  protocol_vault: "Program-held account where protocol revenue waits before it is sent to the operator or the multisig.",
  route_operator: "Operator wallet that receives the first $10,000.",
  protocol_operator: "Operator wallet that receives the first $10,000.",
});

export function payoutsDays(value) {
  const days = Number.parseInt(String(value ?? DEFAULT_DAYS), 10);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_DAYS;
  return Math.min(days, MAX_DAYS);
}

/** Explorer link for a real transaction hash, or null (wallet message signatures and junk are not links). */
export function explorerTxUrl(chainId, hash) {
  const text = String(hash || "").trim();
  const base = EXPLORERS[Number(chainId)]?.tx;
  if (!base || !text) return null;
  if (Number(chainId) === 101) return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text) ? `${base}${text}` : null;
  return /^0x[0-9a-fA-F]{64}$/.test(text) ? `${base}${text}` : null;
}

export function explorerAddressUrl(chainId, address) {
  const base = EXPLORERS[Number(chainId)]?.account;
  return base && address ? `${base}${address}` : null;
}

function rawBig(value) {
  const text = value == null ? "0" : String(value).split(".")[0];
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

/**
 * Does the vault cover what is owed? Pure. `balanceRaw` null means the balance
 * could not be read; `owedRaw` null means nothing is known about what is owed.
 */
export function coverage({ owedRaw, balanceRaw }) {
  if (owedRaw == null) return { status: "not_applicable", shortByRaw: null };
  const owed = BigInt(owedRaw);
  if (owed === 0n) return { status: "nothing_owed", shortByRaw: "0" };
  if (balanceRaw == null) return { status: "unknown", shortByRaw: null };
  const balance = BigInt(balanceRaw);
  return balance >= owed ? { status: "covered", shortByRaw: "0" } : { status: "short", shortByRaw: (owed - balance).toString() };
}

/** Next week end (Monday 00:00 UTC), month start and quarter start after `now`. */
export function nextSchedule(nowIso) {
  const now = new Date(nowIso);
  const day = now.getUTCDay();
  const daysToMonday = ((8 - day) % 7) || 7;
  const weekEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const quarterEnd = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 + 3, 1));
  const airdropRun = new Date(weekEnd.getTime() + 15 * 60_000);
  return { weekEnd: weekEnd.toISOString(), monthEnd: monthEnd.toISOString(), quarterEnd: quarterEnd.toISOString(), airdropRun: airdropRun.toISOString() };
}

function apiSolanaCluster(env) {
  return normalizeSolanaCluster(env.SOLANA_CLUSTER || env.VITE_SOLANA_CLUSTER || "mainnet-beta");
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function safeQuery(db, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return { rows, error: null };
  } catch (error) {
    return { rows: [], error: error?.code === "42P01" || error?.code === "42703" ? `Table or column missing (${error.code}).` : String(error?.message || "Query failed.").slice(0, 300) };
  }
}

// --------------------------------------------------------------------------
// Amount accumulators. A bucket is { hour, raw } so paid amounts can be valued
// at the price of the hour they happened in; owed amounts are valued at spot.

function acc() {
  return { raw: 0n, count: 0, buckets: [], lastAt: null, lastTx: null, lastRaw: null };
}

function addTo(a, raw, { at = null, tx = null } = {}) {
  const value = rawBig(raw);
  a.raw += value;
  a.count += 1;
  a.buckets.push({ hour: at, raw: value.toString() });
  const iso = toIso(at);
  if (iso && (!a.lastAt || iso > a.lastAt)) {
    a.lastAt = iso;
    a.lastRaw = value.toString();
    a.lastTx = tx || null;
  } else if (iso && iso === a.lastAt && tx && !a.lastTx) {
    a.lastTx = tx;
  }
}

async function priced(a, ctx, { events }) {
  const amount = atomicToDecimal(a.raw.toString(), ctx.decimals);
  const usd = events
    ? await ctx.prices.valueEvents(ctx.asset, a.buckets.length ? a.buckets : [{ hour: null, raw: "0" }], ctx.decimals)
    : await ctx.prices.valueAtSpot(ctx.asset, amount);
  return { amount, raw: a.raw.toString(), count: a.count, ...usd };
}

function unknownAmount(note) {
  return { amount: null, raw: null, count: null, amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null, ...(note ? { note } : {}) };
}

async function paidBlock(period, allTime, ctx, extra = {}) {
  const last = allTime.lastAt
    ? { at: allTime.lastAt, amount: atomicToDecimal(allTime.lastRaw || "0", ctx.decimals), txHash: allTime.lastTx, txUrl: explorerTxUrl(ctx.chainId, allTime.lastTx) }
    : null;
  return { recorded: true, period: await priced(period, ctx, { events: true }), allTime: await priced(allTime, ctx, { events: true }), lastPayout: last, ...extra };
}

async function owedBlock(claimable, pending, testCoins, ctx, extra = {}) {
  const total = acc();
  total.raw = claimable.raw + pending.raw;
  total.count = claimable.count + pending.count;
  return {
    known: true,
    claimable: await priced(claimable, ctx, { events: false }),
    pending: await priced(pending, ctx, { events: false }),
    total: await priced(total, ctx, { events: false }),
    testCoins: await priced(testCoins, ctx, { events: false }),
    ...extra,
  };
}

function unrecordedPaid(note) {
  return { recorded: false, period: unknownAmount(), allTime: unknownAmount(), lastPayout: null, note };
}

function unknownOwed(note) {
  return { known: false, claimable: unknownAmount(), pending: unknownAmount(), total: unknownAmount(), testCoins: unknownAmount(), note };
}

// --------------------------------------------------------------------------
// Vaults (balances from the fee-routing read model)

function nativeBalanceOf(destination, nativeSymbol) {
  const b = (destination?.balances || []).find((x) => x.asset === nativeSymbol);
  if (!b) return null;
  return b;
}

function vaultFromDestination(ctx, id, { label, plainId = id, address } = {}) {
  const d = ctx.destinations.get(id);
  const b = nativeBalanceOf(d, ctx.asset);
  const addr = address ?? d?.address ?? null;
  return {
    id,
    label: label || d?.label || id,
    plain: VAULT_PLAIN[plainId] || "",
    address: addr,
    addressUrl: explorerAddressUrl(ctx.chainId, addr),
    balance: b && b.status === "ok"
      ? { status: "ok", amount: b.amount, raw: b.raw, amountUsd: b.amountUsd ?? null, priceUsd: b.priceUsd ?? null, priceSource: b.priceSource ?? null, priceAt: b.priceAt ?? null, priceBasis: b.priceBasis ?? null, source: b.source, asOf: b.asOf }
      : { status: b?.status || "unknown", amount: null, raw: null, amountUsd: null, error: b?.error || "Balance not read.", source: b?.source || null, asOf: null },
  };
}

async function vaultFromAddress(ctx, id, label, address) {
  const known = [...ctx.destinations.values()].find((d) => d.address && address && d.address.toLowerCase() === address.toLowerCase());
  if (known) return { ...vaultFromDestination(ctx, known.id, { label, plainId: id, address }), id };
  const base = { id, label, plain: VAULT_PLAIN[id] || "", address, addressUrl: explorerAddressUrl(ctx.chainId, address) };
  try {
    const read = await ctx.readers.readEvmNative({ urls: ctx.evmUrls, address, fetchImpl: ctx.fetchImpl });
    const amount = atomicToDecimal(read.raw, 18);
    const usd = await ctx.prices.valueAtSpot(ctx.asset, amount);
    return { ...base, balance: { status: "ok", amount, raw: read.raw, ...usd, source: `rpc:${read.rpc}`, asOf: ctx.now } };
  } catch (error) {
    return { ...base, balance: { status: "unknown", amount: null, raw: null, amountUsd: null, error: String(error?.message || "read failed").slice(0, 200), source: "rpc", asOf: null } };
  }
}

async function coverageBlock(ctx, owedRaw, vaults, note) {
  const reads = vaults.map((v) => v.balance);
  const balanceRaw = reads.length && reads.every((b) => b.status === "ok") ? reads.reduce((s, b) => s + BigInt(b.raw), 0n).toString() : null;
  const result = coverage({ owedRaw, balanceRaw });
  const shortByAmount = result.shortByRaw == null ? null : atomicToDecimal(result.shortByRaw, ctx.decimals);
  const shortUsd = result.status === "short" ? await ctx.prices.valueAtSpot(ctx.asset, shortByAmount) : null;
  return {
    status: result.status,
    owedAmount: owedRaw == null ? null : atomicToDecimal(String(owedRaw), ctx.decimals),
    vaultAmount: balanceRaw == null ? null : atomicToDecimal(balanceRaw, ctx.decimals),
    shortByAmount: result.status === "short" ? shortByAmount : result.shortByRaw === "0" ? "0" : null,
    shortByUsd: shortUsd ? shortUsd.amountUsd : result.status === "short" ? null : result.shortByRaw === "0" ? 0 : null,
    note: note || null,
  };
}

// --------------------------------------------------------------------------
// Database reads

const LEAGUE_PERIODS = { weekly: "weekly_league", monthly: "monthly_league", mwl_monthly: "mwl", quarterly: "mwl" };

async function readLeagueRows(db, chainId) {
  return safeQuery(db, `
    select w.period, w.category, w.epoch_start, w.rank, w.amount_raw::text as amount_raw, w.expires_at,
           c.claimed_at, p.tx_hash as pay_tx, p.paid_at, r.published_at as root_at, r.tx_hash as root_tx,
           not (${notPublicHiddenCampaignSql("w", "payload->>'campaign_address'")}) as test_coin
      from public.league_epoch_winners w
      left join public.league_epoch_claims c
        on c.chain_id = w.chain_id and c.period = w.period and c.epoch_start = w.epoch_start and c.category = w.category and c.rank = w.rank
      left join public.league_epoch_payouts p
        on p.chain_id = w.chain_id and p.period = w.period and p.epoch_start = w.epoch_start and p.category = w.category and p.rank = w.rank
      left join public.league_epoch_roots r
        on r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start
     where w.chain_id = $1`, [chainId]);
}

async function readLastRoots(db, chainId) {
  return safeQuery(db, `
    select period, max(published_at) as last_root_at, max(epoch_start) as last_epoch
      from public.league_epoch_roots where chain_id = $1 group by period`, [chainId]);
}

/**
 * Classifies league winner rows into paid / claimable / pending / expired per
 * payout type. A prize is claimable once its claim list (root) is on chain;
 * before that it is pending. Test-coin rows are kept apart.
 */
export function classifyLeagueRows(rows, { since, now }) {
  const out = {};
  const get = (type) => (out[type] ||= { paidPeriod: acc(), paidAll: acc(), claimable: acc(), pending: acc(), expired: acc(), testOwed: acc(), testPaid: acc(), owedAllRaw: 0n, byPeriod: {} });
  for (const row of rows || []) {
    const type = LEAGUE_PERIODS[row.period];
    if (!type) continue;
    const t = get(type);
    const per = (t.byPeriod[row.period] ||= { paid: acc(), owed: acc() });
    const claimedAt = toIso(row.claimed_at);
    const paidAt = toIso(row.paid_at) || claimedAt;
    const expired = !claimedAt && row.expires_at && toIso(row.expires_at) < now;
    if (claimedAt) {
      if (row.test_coin) { addTo(t.testPaid, row.amount_raw, { at: paidAt }); continue; }
      addTo(t.paidAll, row.amount_raw, { at: paidAt, tx: row.pay_tx });
      addTo(per.paid, row.amount_raw, { at: paidAt });
      if (paidAt && paidAt >= since) addTo(t.paidPeriod, row.amount_raw, { at: paidAt, tx: row.pay_tx });
      continue;
    }
    if (expired) { addTo(t.expired, row.amount_raw); continue; }
    t.owedAllRaw += rawBig(row.amount_raw);
    if (row.test_coin) { addTo(t.testOwed, row.amount_raw); continue; }
    addTo(row.root_at ? t.claimable : t.pending, row.amount_raw);
    addTo(per.owed, row.amount_raw);
  }
  return out;
}

async function readRewardLedger(db, chains, rewardType) {
  return safeQuery(db, `
    select status, amount::text as amount_raw, created_at, claimed_at, claim_tx_hash, expires_at,
           nullif(metadata->>'claimDeadline', '') as claim_deadline
      from public.reward_ledger
     where chain::text = any($1::text[]) and reward_type = $2`, [chains, rewardType]);
}

export function classifyRewardLedger(rows, { since, now }) {
  const t = { paidPeriod: acc(), paidAll: acc(), claimable: acc(), pending: acc(), expired: acc(), nextDeadline: null };
  const nowSec = Math.floor(Date.parse(now) / 1000);
  for (const row of rows || []) {
    const status = String(row.status || "").toLowerCase();
    if (status === "claimed" || status === "paid") {
      const at = toIso(row.claimed_at) || toIso(row.created_at);
      addTo(t.paidAll, row.amount_raw, { at, tx: row.claim_tx_hash });
      if (at && at >= since) addTo(t.paidPeriod, row.amount_raw, { at, tx: row.claim_tx_hash });
      continue;
    }
    const deadline = row.claim_deadline != null && /^\d+$/.test(String(row.claim_deadline)) ? Number(row.claim_deadline) : null;
    const expiredByTime = (row.expires_at && toIso(row.expires_at) < now) || (deadline != null && deadline < nowSec);
    if (status === "expired" || status === "rolled_over" || expiredByTime) { addTo(t.expired, row.amount_raw); continue; }
    if (status === "claimable") {
      addTo(t.claimable, row.amount_raw);
      if (deadline != null) {
        const iso = new Date(deadline * 1000).toISOString();
        if (!t.nextDeadline || iso < t.nextDeadline) t.nextDeadline = iso;
      }
    } else if (["allocated", "pending", "pending_finality", "funded", "published", "claim_pending"].includes(status)) {
      addTo(t.pending, row.amount_raw);
    }
  }
  return t;
}

async function readRecruiterLedger(db, chainId) {
  return safeQuery(db, `
    select l.status, l.amount_raw::text as amount_raw, l.created_at, l.updated_at, c.tx_hash,
           not (${notPublicHiddenCampaignSql("l", "metadata->>'campaign'")}) as test_coin
      from public.recruiter_reward_ledger l
      left join public.recruiter_reward_claims c on c.id = l.claim_id
     where l.chain_id = $1`, [chainId]);
}

export function classifyRecruiterLedger(rows, { since }) {
  const t = { paidPeriod: acc(), paidAll: acc(), claimable: acc(), pending: acc(), testOwed: acc(), testPaid: acc(), owedAllRaw: 0n };
  for (const row of rows || []) {
    const status = String(row.status || "").toLowerCase();
    if (status === "claimed") {
      const at = toIso(row.updated_at) || toIso(row.created_at);
      if (row.test_coin) { addTo(t.testPaid, row.amount_raw, { at }); continue; }
      addTo(t.paidAll, row.amount_raw, { at, tx: row.tx_hash });
      if (at && at >= since) addTo(t.paidPeriod, row.amount_raw, { at, tx: row.tx_hash });
      continue;
    }
    if (!["claimable", "retriable", "pending", "pending_finality", "created", "submitted"].includes(status)) continue;
    t.owedAllRaw += rawBig(row.amount_raw);
    if (row.test_coin) { addTo(t.testOwed, row.amount_raw); continue; }
    addTo(status === "claimable" || status === "retriable" ? t.claimable : t.pending, row.amount_raw);
  }
  return t;
}

// --------------------------------------------------------------------------
// Chain reads beyond balances

async function readOperatorFill(ctx) {
  try {
    if (ctx.solana) {
      const pda = deriveSolanaTreasuryPdas();
      const account = await ctx.readers.readSolanaAccountData({ urls: ctx.solanaUrls, address: pda.routeState, fetchImpl: ctx.fetchImpl });
      const state = decodeRouteState(account.data);
      return {
        status: "ok",
        capUsd: Number(state.capUsdMicros) / 1e6,
        filledUsd: Number(state.filledUsdMicros) / 1e6,
        nativeUsdPrice: Number(state.nativeUsdMicros) / 1e6,
        source: `rpc:${account.rpc} route_state ${pda.routeState}`,
      };
    }
    const vault = ctx.destinations.get("protocol_vault")?.address;
    if (!vault) throw new Error("No ProtocolRevenueVault address.");
    const read = async (getter) => BigInt((await ctx.readers.readEvmCall({ urls: ctx.evmUrls, to: vault, data: evmGetterSelector(getter), fetchImpl: ctx.fetchImpl })).hex);
    const [cap, filled, price] = await Promise.all([read("operatorFillCapUsd"), read("operatorFilledUsd"), read("nativeUsdPrice")]);
    const wad = (v) => Number(v) / 1e18;
    return { status: "ok", capUsd: wad(cap), filledUsd: wad(filled), nativeUsdPrice: wad(price), source: `rpc ProtocolRevenueVault ${vault} operatorFillCapUsd/operatorFilledUsd/nativeUsdPrice` };
  } catch (error) {
    return { status: "unknown", capUsd: null, filledUsd: null, nativeUsdPrice: null, error: String(error?.message || "read failed").slice(0, 200) };
  }
}

async function solanaJsonRpc(ctx, method, params) {
  let last = new Error("No RPC configured.");
  for (const url of ctx.solanaUrls) {
    try {
      const response = await ctx.fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(`${method}: ${payload.error.message || "rpc error"}`);
      return payload.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** Creator fees still claimable on every public Solana launchpad coin (same math as claim_creator_fees). */
async function readSolanaCreatorClaimable(ctx, campaigns) {
  if (campaigns.length === 0) return { status: "ok", raw: "0", coins: 0, coinsWithFees: 0 };
  const programId = SOLANA_LAUNCHPAD_PROGRAM_ID;
  const derived = campaigns.map((c) => deriveCampaignFeeAccounts(c, programId));
  const [escrowRent, vaultRent] = await Promise.all([
    solanaJsonRpc(ctx, "getMinimumBalanceForRentExemption", [FEE_ESCROW_BYTES]),
    solanaJsonRpc(ctx, "getMinimumBalanceForRentExemption", [CREATOR_FEE_VAULT_BYTES]),
  ]);
  let total = 0n;
  let withFees = 0;
  for (let i = 0; i < derived.length; i += 50) {
    const chunk = derived.slice(i, i + 50);
    const result = await solanaJsonRpc(ctx, "getMultipleAccounts", [chunk.flatMap((d) => [d.feeEscrow, d.creatorFeeVault]), { encoding: "base64", commitment: "confirmed" }]);
    const values = result?.value || [];
    chunk.forEach((_, j) => {
      const computed = computeCreatorFeeClaimable({ escrow: decodeRpcAccount(values[j * 2]), vault: decodeRpcAccount(values[j * 2 + 1]), escrowRent, vaultRent, programId });
      total += computed.claimableLamports;
      if (computed.claimableLamports > 0n) withFees += 1;
    });
  }
  return { status: "ok", raw: total.toString(), coins: campaigns.length, coinsWithFees: withFees };
}

// --------------------------------------------------------------------------
// Per-type builders

function leagueUpcoming(type, schedule, lastRoots) {
  const rootAt = (period) => toIso(lastRoots.find((r) => r.period === period)?.last_root_at);
  if (type === "weekly_league") {
    return [
      { label: "This week ends", at: schedule.weekEnd, note: "Winners are worked out after the week ends; the claim list then goes on chain." },
      ...(rootAt("weekly") ? [{ label: "Last weekly claim list posted", at: rootAt("weekly"), note: null }] : []),
    ];
  }
  if (type === "monthly_league") {
    return [
      { label: "This month ends", at: schedule.monthEnd, note: "Winners are worked out after the month ends; the claim list then goes on chain." },
      ...(rootAt("monthly") ? [{ label: "Last monthly claim list posted", at: rootAt("monthly"), note: null }] : []),
    ];
  }
  return [
    { label: "Monthly prizes for this month", at: schedule.monthEnd, note: "Paid from 60% of the league money collected." },
    { label: "Quarterly prizes for this quarter", at: schedule.quarterEnd, note: "Paid from 40% of the league money collected." },
    ...(rootAt("mwl_monthly") ? [{ label: "Last monthly claim list posted", at: rootAt("mwl_monthly"), note: null }] : []),
    ...(rootAt("quarterly") ? [{ label: "Last quarterly claim list posted", at: rootAt("quarterly"), note: null }] : []),
  ];
}

function payoutCodeMonthly(chainId, env) {
  const configured = String(env[`MONTHLY_LEAGUE_TREASURY_ADDRESS_${chainId}`] || "").trim();
  return configured ? { address: configured, from: `MONTHLY_LEAGUE_TREASURY_ADDRESS_${chainId}` } : { address: PAYOUT_CODE_MONTHLY_FALLBACK[chainId], from: "the address written into league.js, evmLeagueClaimVerification.js and publish-evm-league-roots.mjs" };
}

function payoutCodeWeekly(chainId, env) {
  const configured = String(env[`TREASURY_VAULT_V2_ADDRESS_${chainId}`] || (chainId === 56 ? env.TREASURY_VAULT_V2_ADDRESS : "") || "").trim();
  return configured ? { address: configured, from: `TREASURY_VAULT_V2_ADDRESS_${chainId}`, claimsWork: true } : { address: PAYOUT_CODE_WEEKLY_FALLBACK[chainId], from: "the fallback in publish-evm-league-roots.mjs", claimsWork: false };
}

function wiringActual(feeRouting, id) {
  const check = (feeRouting?.wiring || []).find((w) => w.id === id);
  return check && check.status !== "unknown" ? check.actual : null;
}

const same = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());

function typeShell(ctx, id) {
  const def = PAYOUT_TYPES.find((t) => t.id === id);
  return { id, label: def.label, explain: def.explain, chainId: ctx.chainId, chain: ctx.chain, asset: ctx.asset, decimals: ctx.decimals, warnings: [], sources: [], notes: [] };
}

async function leagueType(ctx, id, classified, lastRoots, leagueError) {
  const t = typeShell(ctx, id);
  const c = classified[id] || { paidPeriod: acc(), paidAll: acc(), claimable: acc(), pending: acc(), expired: acc(), testOwed: acc(), testPaid: acc(), owedAllRaw: 0n, byPeriod: {} };
  t.sources.push("db:league_epoch_winners", "db:league_epoch_claims", "db:league_epoch_payouts (transaction)", "db:league_epoch_roots");
  if (leagueError) t.warnings.push({ level: "warning", message: `League tables could not be read: ${leagueError}` });
  t.paid = await paidBlock(c.paidPeriod, c.paidAll, ctx, c.testPaid.count ? { testCoinsLeftOut: atomicToDecimal(c.testPaid.raw.toString(), ctx.decimals), testCoinsLeftOutCount: c.testPaid.count } : {});
  t.owed = await owedBlock(c.claimable, c.pending, c.testOwed, ctx, {
    expired: { amount: atomicToDecimal(c.expired.raw.toString(), ctx.decimals), count: c.expired.count },
    note: "Claimable: the claim list is on chain and the winner can collect. Waiting: the winners are known but the claim list is not on chain yet.",
  });

  if (id === "mwl") {
    t.breakdown = [];
    for (const [period, label] of [["mwl_monthly", "Monthly"], ["quarterly", "Quarterly"]]) {
      const per = c.byPeriod[period];
      t.breakdown.push({ label, paid: atomicToDecimal((per?.paid.raw || 0n).toString(), ctx.decimals), paidCount: per?.paid.count || 0, owed: atomicToDecimal((per?.owed.raw || 0n).toString(), ctx.decimals), owedCount: per?.owed.count || 0 });
    }
  }

  let vaults;
  let coverNote = "Compared with everything still owed from this vault, test-coin prizes included, because the vault has to pay those too.";
  if (ctx.solana) {
    const vid = id === "weekly_league" ? "league_weekly" : id === "monthly_league" ? "league_monthly" : "mwl_vault";
    vaults = [vaultFromDestination(ctx, vid)];
    if (id !== "mwl") coverNote += " The vault also holds the prize pot of the period that is still running.";
  } else if (id === "weekly_league") {
    const code = payoutCodeWeekly(ctx.chainId, ctx.env);
    const router = wiringActual(ctx.feeRouting, "v4_weeklyLeagueVault");
    vaults = [vaultFromDestination(ctx, "weekly_league")];
    if (!code.claimsWork) {
      t.warnings.push({ level: "warning", message: `TREASURY_VAULT_V2_ADDRESS_${ctx.chainId} is not set on this API, so weekly league claims on this chain would be refused (league.js needs it). Roots are posted to ${code.address} (${code.from}).` });
    }
    if (router && !same(router, code.address)) {
      t.warnings.push({ level: "critical", message: `Vault mismatch: the fee router sends weekly league money to ${router}, but the payout code uses ${code.address} (${code.from}).` });
    }
  } else if (id === "monthly_league") {
    const code = payoutCodeMonthly(ctx.chainId, ctx.env);
    const router = wiringActual(ctx.feeRouting, "v4_monthlyLeagueTreasury") || ctx.destinations.get("monthly_league")?.address;
    vaults = [await vaultFromAddress(ctx, "monthly_payout", "Monthly league vault the payout code pays from", code.address)];
    if (router && !same(router, code.address)) {
      vaults.push(vaultFromDestination(ctx, "monthly_league", { label: "Monthly league vault the fee router sends to", address: router }));
      t.warnings.push({ level: "critical", message: `Vault mismatch: the fee router sends monthly league money to ${router}, but claims and claim lists use ${code.address} (${code.from}). New monthly prizes would be posted against the old vault.` });
      coverNote = "Compared with the vault the payout code pays from. The vault the fee router fills is shown beside it.";
    }
  } else {
    const pgMonthly = wiringActual(ctx.feeRouting, "pg_monthly");
    const pgQuarterly = wiringActual(ctx.feeRouting, "pg_quarterly");
    const codeMonthly = mwlVaultAddress("mwl_monthly", ctx.chainId, ctx.env);
    const codeQuarterly = mwlVaultAddress("quarterly", ctx.chainId, ctx.env);
    vaults = [vaultFromDestination(ctx, "mwl_monthly"), vaultFromDestination(ctx, "mwl_quarterly"), vaultFromDestination(ctx, "post_grad_league")];
    for (const [label, router, code] of [["monthly", pgMonthly, codeMonthly], ["quarterly", pgQuarterly, codeQuarterly]]) {
      if (router && code && !same(router, code)) t.warnings.push({ level: "critical", message: `Vault mismatch: battle league money for the ${label} prizes goes to ${router}, but the payout code uses ${code}.` });
    }
    coverNote += " The splitter contract holds battle money not yet moved into the two prize contracts; it counts toward cover.";
  }
  t.vaults = vaults;
  const owedForCover = c.owedAllRaw.toString();
  t.coverage = await coverageBlock(ctx, owedForCover, vaults.filter((v) => v.id !== "monthly_league"), coverNote);
  t.upcoming = leagueUpcoming(id, ctx.schedule, lastRoots);
  if (id === "mwl") {
    t.notes.push("Prize goes to the creator of the winning coin, or to the verified owner of an imported coin.");
    t.notes.push("Q3 2026 closes without extra placement bonuses (founder decision 2026-10-02); the quarterly prize from the 40% pot is paid as normal.");
  }
  return t;
}

async function mwlExtras(ctx, t) {
  const runs = await safeQuery(ctx.db, `
    select period, epoch_start, status, pot_raw::text as pot_raw, paid_raw::text as paid_raw, winners, reason, created_at
      from public.arena_mwl_payout_runs where chain_id = $1 order by created_at desc limit 6`, [ctx.chainId]);
  const reserved = await safeQuery(ctx.db, `
    select coalesce(sum(monthly_raw) filter (where monthly_payout_epoch is null), 0)::text as monthly,
           coalesce(sum(quarterly_raw) filter (where quarterly_payout_epoch is null), 0)::text as quarterly,
           count(*)::int as n
      from public.arena_league_share_ledger where chain_id = $1`, [ctx.chainId]);
  t.sources.push("db:arena_mwl_payout_runs", "db:arena_league_share_ledger");
  if (!runs.error) {
    t.runs = runs.rows.map((r) => ({ period: r.period, periodStart: toIso(r.epoch_start), status: r.status, pot: atomicToDecimal(String(r.pot_raw || "0").split(".")[0], ctx.decimals), paid: atomicToDecimal(String(r.paid_raw || "0").split(".")[0], ctx.decimals), winners: Number(r.winners || 0), reason: r.reason || null, at: toIso(r.created_at) }));
  }
  if (!reserved.error && reserved.rows[0]) {
    const m = rawBig(reserved.rows[0].monthly);
    const q = rawBig(reserved.rows[0].quarterly);
    const mUsd = await ctx.prices.valueAtSpot(ctx.asset, atomicToDecimal(m.toString(), ctx.decimals));
    const qUsd = await ctx.prices.valueAtSpot(ctx.asset, atomicToDecimal(q.toString(), ctx.decimals));
    t.reserved = {
      monthly: { amount: atomicToDecimal(m.toString(), ctx.decimals), ...mUsd },
      quarterly: { amount: atomicToDecimal(q.toString(), ctx.decimals), ...qUsd },
      note: "Battle league money already collected for prizes that are not decided yet (this month and this quarter). It sits in the same vault.",
    };
    if (t.upcoming[0]) t.upcoming[0].note = `Pot so far: ${t.reserved.monthly.amount} ${ctx.asset}. Paid from 60% of the league money collected.`;
    if (t.upcoming[1]) t.upcoming[1].note = `Pot so far: ${t.reserved.quarterly.amount} ${ctx.asset}. Paid from 40% of the league money collected.`;
  }
}

async function recruiterType(ctx) {
  const t = typeShell(ctx, "recruiter");
  const ledger = ctx.dbRowsAllowed ? await readRecruiterLedger(ctx.db, ctx.chainId) : { rows: [], error: null };
  if (ledger.error) t.warnings.push({ level: "warning", message: `Recruiter ledger could not be read: ${ledger.error}` });
  const c = classifyRecruiterLedger(ledger.rows, { since: ctx.since });
  t.sources.push("db:recruiter_reward_ledger", "db:recruiter_reward_claims (transaction)");
  t.paid = await paidBlock(c.paidPeriod, c.paidAll, ctx);
  t.owed = await owedBlock(c.claimable, c.pending, c.testOwed, ctx, { note: "Earned by recruiters and not paid yet. Claimable: ready to collect. Waiting: still being confirmed or in a payout that has not landed." });
  t.vaults = [vaultFromDestination(ctx, "recruiter_vault")];
  t.coverage = await coverageBlock(ctx, c.owedAllRaw.toString(), t.vaults, "Compared with every recorded recruiter reward not yet paid, test coins included.");
  if (ctx.solana) {
    t.sources.push("db:solana_reward_lane_batches");
    const batches = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `
      select b.status, b.total_lamports::text as total, b.epoch_start, b.epoch_end, b.published_at, b.publish_tx_hash,
             (select string_agg(distinct c.payout_wallet, ',') from public.recruiter_reward_claims c
               where c.chain = 'solana' and c.amount_raw = b.total_lamports and c.created_at between b.created_at - interval '1 minute' and b.created_at + interval '1 minute') as payout_wallets
        from public.solana_reward_lane_batches b
       where b.chain_id = 101 and b.lane = 'recruiter'
       order by b.epoch_end desc nulls last limit 6`, []) : { rows: [] };
    t.batches = (batches.rows || []).map((b) => ({ status: b.status, total: atomicToDecimal(String(b.total || "0").split(".")[0], 9), weekStart: toIso(b.epoch_start), weekEnd: toIso(b.epoch_end), postedAt: toIso(b.published_at), txHash: b.publish_tx_hash || null, txUrl: explorerTxUrl(101, b.publish_tx_hash) }));
    const prepared = t.batches.find((b) => b.status === "prepared");
    t.upcoming = [{ label: "Next weekly recruiter payout list", at: ctx.schedule.weekEnd, note: prepared ? `A list of ${prepared.total} SOL for the week to ${prepared.weekEnd?.slice(0, 10)} is prepared but not on chain yet.` : "Recruiters collect from a weekly list posted on chain." }];
    for (const b of batches.rows || []) {
      if (String(b.payout_wallets || "").split(",").includes("HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9")) {
        t.warnings.push({ level: "warning", message: `A recruiter payout list (${atomicToDecimal(String(b.total).split(".")[0], 9)} SOL, status ${b.status}) pays the devnet deployer key HuKfoF. Check that this recruiter's payout wallet is right before it goes on chain.` });
      }
    }
  } else {
    t.upcoming = [{ label: "Paid when the recruiter claims", at: null, note: "The operator pays each claim from the recruiter vault, within its daily cap." }];
    const held = t.vaults[0].balance;
    if (held.status === "ok" && held.raw !== "0" && c.owedAllRaw === 0n && c.paidAll.count === 0) {
      t.warnings.push({ level: "warning", message: `The recruiter vault holds ${held.amount} ${ctx.asset} but no recruiter rewards are recorded for this chain, so nobody can claim it yet. Trades on the newest router are not being recorded (see Fee routing).` });
    }
  }
  return t;
}

async function creatorType(ctx) {
  const t = typeShell(ctx, "creator_fees");
  t.paid = unrecordedPaid("Creator claims are made straight on chain and are not recorded in our database.");
  if (ctx.solana) {
    t.sources.push("db:campaigns (public launchpad coins)", "rpc: each coin's fee escrow and creator fee vault", "db:reward_events (creator share)");
    const campaigns = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `
      select campaign_address from public.campaigns
       where chain_id = 101 and campaign_address is not null and coalesce(launch_type, 'launchpad') <> 'dbc'
         and not (${publicHiddenWhere("")})`, []) : { rows: [] };
    const earned = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `
      select date_trunc('hour', r.occurred_at) as hour, count(*)::int as n,
             coalesce(sum(nullif(r.metadata->>'creatorLamports', '')::numeric), 0)::text as creator
        from public.reward_events r
       where r.chain_id = 101 and ${notPublicHiddenCampaignSql("r")}
       group by 1`, []) : { rows: [] };
    const earnedAll = acc();
    const earnedPeriod = acc();
    for (const row of earned.rows || []) {
      if (rawBig(row.creator) === 0n) continue;
      addTo(earnedAll, row.creator, { at: row.hour });
      if (toIso(row.hour) >= ctx.since) addTo(earnedPeriod, row.creator, { at: row.hour });
    }
    t.earned = { period: await priced(earnedPeriod, ctx, { events: true }), allTime: await priced(earnedAll, ctx, { events: true }), note: "Creator share of trade fees on public coins, from recorded trades." };
    let read;
    try {
      read = campaigns.error ? { status: "unknown", error: campaigns.error } : await ctx.readers.readSolanaCreatorClaimable(ctx, campaigns.rows.map((r) => r.campaign_address));
    } catch (error) {
      read = { status: "unknown", error: String(error?.message || "read failed").slice(0, 200) };
    }
    const claimable = acc();
    if (read.status === "ok") { claimable.raw = BigInt(read.raw); claimable.count = read.coinsWithFees; }
    t.owed = read.status === "ok"
      ? await owedBlock(claimable, acc(), acc(), ctx, { note: `Still claimable by creators across ${read.coins} public coin${read.coins === 1 ? "" : "s"}, read from each coin's fee accounts. Test coins are left out.` })
      : unknownOwed(`Creator fee accounts could not be read: ${read.error}`);
    const amount = read.status === "ok" ? atomicToDecimal(read.raw, 9) : null;
    const usd = amount != null ? await ctx.prices.valueAtSpot("SOL", amount) : {};
    t.vaults = [{ id: "creator_fee_accounts", label: "Creator fee accounts (one per coin)", plain: VAULT_PLAIN.creator_fee_accounts, address: null, addressUrl: null, balance: read.status === "ok" ? { status: "ok", amount, raw: read.raw, ...usd, source: "rpc getMultipleAccounts", asOf: ctx.now } : { status: "unknown", amount: null, raw: null, amountUsd: null, error: read.error, source: "rpc", asOf: null } }];
    t.coverage = await coverageBlock(ctx, read.status === "ok" ? read.raw : null, t.vaults, "Covered by design: what a creator can claim is what the coin's fee accounts hold above rent.");
  } else {
    t.sources.push("rpc: CreatorRewardsVault (older coins) and CreatorRewardsVaultV2 (newer coins) balances");
    t.vaults = [vaultFromDestination(ctx, "creator_vault_v2"), vaultFromDestination(ctx, "creator_vault_v1")];
    const reads = t.vaults.map((v) => v.balance);
    if (reads.every((b) => b.status === "ok")) {
      const owed = acc();
      owed.raw = reads.reduce((s, b) => s + BigInt(b.raw), 0n);
      t.owed = await owedBlock(owed, acc(), acc(), ctx, { note: "Everything in these two vaults belongs to creators (and, for newer coins, to holders or buybacks the creator chose), so what is owed equals what they hold. Balances are on chain and cannot be split by coin here, so test coins are included." });
      // A vault balance is not a count of claims.
      t.owed.claimable.count = null;
      t.owed.total.count = null;
      t.coverage = await coverageBlock(ctx, owed.raw.toString(), t.vaults, "Covered by design: the vaults only hold creator money.");
    } else {
      t.owed = unknownOwed("Creator vault balances could not be read.");
      t.coverage = await coverageBlock(ctx, null, t.vaults, null);
    }
  }
  t.upcoming = [{ label: "Creators claim any time", at: null, note: null }];
  return t;
}

async function airdropType(ctx) {
  const t = typeShell(ctx, "airdrop");
  const ledger = ctx.dbRowsAllowed ? await readRewardLedger(ctx.db, ctx.rewardChains, "airdrop") : { rows: [], error: null };
  if (ledger.error) t.warnings.push({ level: "warning", message: `Airdrop ledger could not be read: ${ledger.error}` });
  const c = classifyRewardLedger(ledger.rows, { since: ctx.since, now: ctx.now });
  t.sources.push("db:reward_ledger (reward_type airdrop)", "db:reward_batches");
  t.paid = await paidBlock(c.paidPeriod, c.paidAll, ctx);
  t.owed = await owedBlock(c.claimable, c.pending, acc(), ctx, {
    expired: { amount: atomicToDecimal(c.expired.raw.toString(), ctx.decimals), count: c.expired.count },
    note: "Winners have 60 days to claim; what is not claimed goes back into the pot. Airdrops are drawn per wallet, not per coin, so nothing is left out for test coins.",
  });
  t.vaults = ctx.solana ? [vaultFromDestination(ctx, "airdrop_vault")] : [vaultFromDestination(ctx, "airdrop_distributor"), vaultFromDestination(ctx, "community_vault")];
  t.coverage = await coverageBlock(ctx, (c.claimable.raw + c.pending.raw).toString(), ctx.solana ? t.vaults : t.vaults.slice(0, 1), ctx.solana
    ? "The airdrop vault also holds next week's pot."
    : "Compared with the distributor, which holds each week's winnings. The community vault beside it holds the pot for coming weeks and the squad share.");
  const lastRun = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `select max(created_at) as at, count(*)::int as n from public.reward_batches where chain::text = any($1::text[]) and reward_type = 'airdrop'`, [ctx.rewardChains]) : { rows: [] };
  const lastAt = toIso(lastRun.rows?.[0]?.at);
  t.upcoming = [
    { label: "Next weekly draw", at: ctx.schedule.airdropRun, note: "Scheduled every Monday at 00:15 UTC." },
    ...(lastAt ? [{ label: "Last draw", at: lastAt, note: null }] : [{ label: "Last draw", at: null, note: "No draw recorded on this chain yet." }]),
    ...(c.nextDeadline ? [{ label: "Oldest open claim expires", at: c.nextDeadline, note: "Unclaimed money then rolls back into the pot." }] : []),
  ];
  return t;
}

async function squadType(ctx) {
  const t = typeShell(ctx, "squad");
  const ledger = ctx.dbRowsAllowed ? await readRewardLedger(ctx.db, ctx.rewardChains, "squad") : { rows: [], error: null };
  const c = classifyRewardLedger(ledger.rows, { since: ctx.since, now: ctx.now });
  t.sources.push("db:reward_ledger (reward_type squad)");
  t.paid = await paidBlock(c.paidPeriod, c.paidAll, ctx);
  t.owed = unknownOwed("There is no rule yet for which squad gets what, so nothing is owed to anyone yet. The money builds up in the vault.");
  t.vaults = [vaultFromDestination(ctx, ctx.solana ? "squad_vault" : "community_vault")];
  t.coverage = await coverageBlock(ctx, null, t.vaults, ctx.solana ? null : "On BNB and Robinhood the squad share sits in the community vault together with the airdrop pot.");
  t.upcoming = [{ label: "No payout scheduled", at: null, note: "Waiting for a squad payout rule." }];
  return t;
}

async function arenaType(ctx) {
  const t = typeShell(ctx, "arena_prizes");
  const deposits = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `select purpose, created_at, amount_wei::text as amount_raw from public.arena_war_pool_deposits where chain_id = $1`, [ctx.chainId]) : { rows: [] };
  const claims = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `select created_at, amount_wei::text as amount_raw, tx_hash from public.arena_war_pool_claims where chain_id = $1`, [ctx.chainId]) : { rows: [] };
  // Boosts are recorded per payment in arena_contest_actions (Solana and EVM), not in the deposits table.
  const boosts = ctx.dbRowsAllowed ? await safeQuery(ctx.db, `select confirmed_at as created_at, gross_native_raw::text as amount_raw from public.arena_contest_actions where chain_id = $1 and action_type = 'boost' and confirmed_at is not null and coalesce(tx_hash, signature_reference) is not null and gross_native_raw > 0`, [ctx.chainId]) : { rows: [] };
  t.sources.push("db:arena_war_pool_deposits", "db:arena_war_pool_claims", "db:arena_contest_actions");
  const paidAll = acc();
  const paidPeriod = acc();
  for (const row of claims.rows || []) {
    addTo(paidAll, row.amount_raw, { at: row.created_at, tx: row.tx_hash });
    if (toIso(row.created_at) >= ctx.since) addTo(paidPeriod, row.amount_raw, { at: row.created_at, tx: row.tx_hash });
  }
  t.paid = await paidBlock(paidPeriod, paidAll, ctx, { note: "Prize claims recorded by the app." });
  const inAll = acc();
  for (const row of deposits.rows || []) addTo(inAll, row.amount_raw, { at: row.created_at });
  for (const row of boosts.rows || []) addTo(inAll, row.amount_raw, { at: row.created_at });
  t.paidIn = { allTime: await priced(inAll, ctx, { events: true }), note: "Stakes and boosts put into battle pools (recorded by the app). 90% of boosts and 75% of stakes are prize money; the protocol's 10% / 5% is in Revenue." };
  t.owed = unknownOwed("Each winner's prize is worked out on chain when they claim, so it is not listed here. The pool balance below is the money still in play or unclaimed.");
  if (ctx.solana) {
    t.vaults = [];
    t.coverage = await coverageBlock(ctx, null, [], "Each battle has its own pool account on Solana; they are not read here.");
  } else {
    t.vaults = [vaultFromDestination(ctx, "war_pool"), vaultFromDestination(ctx, "event_prize")];
    t.coverage = await coverageBlock(ctx, null, t.vaults, null);
  }
  t.upcoming = [{ label: "Winners claim after each battle ends", at: null, note: null }];
  return t;
}

async function operatorType(ctx) {
  const t = typeShell(ctx, "operator_fill");
  const fill = await readOperatorFill(ctx);
  t.sources.push(ctx.solana ? "rpc:route_state (cap and amount filled)" : "rpc:ProtocolRevenueVault (cap and amount filled)");
  t.fill = { ...fill, remainingUsd: fill.status === "ok" ? Math.max(0, Math.round((fill.capUsd - fill.filledUsd) * 100) / 100) : null };
  t.paid = { recorded: fill.status === "ok", period: unknownAmount("Only the running total is kept on chain."), allTime: { amount: null, raw: null, count: null, amountUsd: fill.status === "ok" ? Math.round(fill.filledUsd * 100) / 100 : null, priceUsd: null, priceSource: "valued when paid, at the price set in the contract", priceAt: null, priceBasis: fill.status === "ok" ? "event_time" : null }, lastPayout: null, note: "Total sent to the operator so far, in dollars, as counted by the contract." };
  t.owed = unknownOwed("Nothing is owed: this is protocol revenue going to our own operator wallet.");
  if (ctx.solana) {
    t.vaults = [vaultFromDestination(ctx, "protocol_vault"), vaultFromDestination(ctx, "route_operator")];
    t.upcoming = [{ label: "Protocol vault is emptied every hour", at: null, note: "When it holds at least 0.05 SOL. Up to the cap it goes to the operator, then to the multisig." }];
  } else {
    t.vaults = [vaultFromDestination(ctx, "protocol_operator")];
    t.upcoming = [{ label: "Sent on every deposit", at: null, note: "No waiting: each fee is forwarded as it arrives." }];
  }
  t.coverage = await coverageBlock(ctx, null, t.vaults, null);
  if (fill.status !== "ok") t.warnings.push({ level: "warning", message: `Operator cap could not be read: ${fill.error}` });
  t.excludedFromTotals = true;
  return t;
}

// --------------------------------------------------------------------------

function sinceIso(days, now) {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

function totalsFor(network, types) {
  const paid = [];
  const owed = [];
  const vaults = [];
  const seen = new Set();
  for (const t of types) {
    if (t.excludedFromTotals) continue;
    if (t.paid?.recorded && t.paid.period) paid.push({ chainId: network.chainId, chain: network.chain, asset: t.asset, amount: t.paid.period.amount, amountUsd: t.paid.period.amountUsd });
    if (t.owed?.known) owed.push({ chainId: network.chainId, chain: network.chain, asset: t.asset, amount: t.owed.total.amount, amountUsd: t.owed.total.amountUsd });
    for (const v of t.vaults || []) {
      const key = `${String(v.address || v.id).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vaults.push({ chainId: network.chainId, chain: network.chain, asset: t.asset, amount: v.balance.status === "ok" ? v.balance.amount : null, amountUsd: v.balance.amountUsd ?? null });
    }
  }
  return { paid: buildTotals(paid, { seed: [network] }), owed: buildTotals(owed, { seed: [network] }), vaults: buildTotals(vaults, { seed: [network] }) };
}

/** Payouts for one mainnet. */
export async function buildPayouts({ network, days, db, env = process.env, fetchImpl = fetch, readers, prices, feeRouting, now = () => new Date().toISOString() }) {
  const generatedAt = now();
  const priceService = prices || defaultPriceService();
  const solana = network.chain === "solana";
  const routing = feeRouting || (await cachedFeeRouting({ network, days, db }));
  const dbRowsAllowed = !solana || apiSolanaCluster(env) === "mainnet-beta";
  const ctx = {
    db, env, fetchImpl, solana, now: generatedAt,
    chainId: network.chainId, chain: network.chain,
    asset: network.nativeSymbol, decimals: network.nativeDecimals || (solana ? 9 : 18),
    prices: priceService,
    readers: { readEvmCall, readEvmNative, readSolanaAccountData, readSolanaCreatorClaimable, ...(readers || {}) },
    solanaUrls: solana ? solanaRpcUrls(env) : [],
    evmUrls: solana ? [] : getRpcUrls(network.chainId),
    feeRouting: routing,
    destinations: new Map((routing?.destinations || []).map((d) => [d.id, d])),
    since: sinceIso(days, generatedAt),
    schedule: nextSchedule(generatedAt),
    dbRowsAllowed,
    rewardChains: solana ? ["101", "solana", "solana-mainnet", "solana-mainnet-beta"] : [String(network.chainId)],
  };

  const league = dbRowsAllowed ? await readLeagueRows(db, network.chainId) : { rows: [], error: null };
  const roots = dbRowsAllowed ? await readLastRoots(db, network.chainId) : { rows: [] };
  const classified = classifyLeagueRows(league.rows, { since: ctx.since, now: generatedAt });

  const weekly = await leagueType(ctx, "weekly_league", classified, roots.rows || [], league.error);
  const monthly = await leagueType(ctx, "monthly_league", classified, roots.rows || [], league.error);
  const mwl = await leagueType(ctx, "mwl", classified, roots.rows || [], league.error);
  if (dbRowsAllowed) await mwlExtras(ctx, mwl);
  const types = [weekly, monthly, mwl, await recruiterType(ctx), await creatorType(ctx), await airdropType(ctx), await squadType(ctx), await arenaType(ctx), await operatorType(ctx)];

  const warnings = [];
  for (const t of types) for (const w of t.warnings) warnings.push({ ...w, typeId: t.id });
  for (const t of types) {
    if (t.coverage?.status === "short") warnings.push({ level: "critical", typeId: t.id, message: `${t.label}: the vault is short by ${t.coverage.shortByAmount} ${t.asset} of what is owed.` });
  }
  if (!solana && ctx.destinations.get("monthly_league_old")) {
    const old = vaultFromDestination(ctx, "monthly_league_old");
    if (old.balance.status === "ok" && old.balance.raw !== "0") warnings.push({ level: "warning", typeId: "monthly_league", message: `The old monthly league vault ${old.address} still holds ${old.balance.amount} ${ctx.asset}.` });
  }
  const notice = dbRowsAllowed ? null : "This API reads the test database, whose Solana rows are devnet. Mainnet payouts are on the live API; only vault balances are shown.";

  return {
    schemaVersion: PAYOUTS_SCHEMA,
    generatedAt,
    source: "dashboard-api",
    network: { chainId: network.chainId, chain: network.chain, environment: network.environment, ...(network.cluster ? { cluster: network.cluster } : {}), nativeSymbol: network.nativeSymbol },
    period: { days, from: ctx.since, to: generatedAt },
    types,
    warnings,
    totals: totalsFor(network, types),
    prices: await priceService.spotTable([priceAssetFor(network.nativeSymbol)]),
    ...(notice ? { notice } : {}),
    testCoinsExcluded: true,
    testCoinsNote: "Prizes and rewards tied to test coins (coins hidden from public listings) are left out of paid and owed, and shown apart. The vault check still counts them, because the vault has to pay them. Creator vault balances on BNB and Robinhood cannot be split by coin and are shown in full.",
  };
}

export async function cachedPayouts(args) {
  const key = `${args.network.chainId}:${args.network.cluster || ""}:${args.days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await buildPayouts(args);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearPayoutsCache() {
  cache.clear();
}

/** chainId=all: one section per mainnet (a failing chain is reported, not hidden) and merged totals. */
export async function buildPayoutsAllChains(networks, build) {
  const settled = await Promise.allSettled(networks.map((network) => build(network)));
  const datas = [];
  const sections = settled.map((result, index) => {
    const network = networks[index];
    const identity = { chainId: network.chainId, chain: network.chain, environment: network.environment, ...(network.cluster ? { cluster: network.cluster } : {}) };
    if (result.status === "fulfilled") {
      datas.push(result.value);
      return { ...identity, status: "ok", data: result.value };
    }
    console.error(`[api/admin/finance] payouts chain ${network.chainId}`, result.reason);
    return { ...identity, status: "error", error: `The payouts read failed for chain ${network.chainId}.` };
  });
  const prices = [];
  for (const d of datas) for (const p of d.prices || []) if (!prices.some((x) => x.asset === p.asset)) prices.push(p);
  return {
    schemaVersion: "finance-all-chains-v1",
    page: "payouts",
    generatedAt: new Date().toISOString(),
    source: "dashboard-api",
    networks: sections,
    totals: {
      paid: mergeTotals(datas.map((d) => d.totals?.paid)),
      owed: mergeTotals(datas.map((d) => d.totals?.owed)),
      vaults: mergeTotals(datas.map((d) => d.totals?.vaults)),
    },
    prices,
    testCoinsExcluded: true,
    testCoinsNote: datas[0]?.testCoinsNote || null,
  };
}

/**
 * GET /api/admin/finance/payouts?chainId=all|56|4663|101(&environment=production&solanaCluster=mainnet-beta)&days=…
 * Read-only. Bearer only: the dashboard gate in railwayProxy.js must have
 * resolved a principal with finance.view; ops keys are refused here.
 */
export async function financePayouts(req, res, { build = cachedPayouts, db, canView } = {}) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Payouts is read-only (GET)." });
  }
  if (!req.dashboardPrincipal || !canView(req.dashboardPrincipal)) {
    return res.status(401).json({ ok: false, error: "Dashboard sign-in with finance.view is required.", code: "FINANCE_VIEW_REQUIRED" });
  }
  const raw = String(req.query?.chainId ?? "").trim().toLowerCase();
  const all = raw === "" || raw === "all";
  const network = all ? null : feeRoutingNetwork(req.query || {});
  if (!all && !network) {
    return res.status(400).json({ ok: false, error: "Payouts covers mainnets only: chainId=all, BNB 56, Robinhood 4663, or Solana 101 with environment=production&solanaCluster=mainnet-beta." });
  }
  try {
    const days = payoutsDays(req.query?.days);
    const payload = all
      ? await buildPayoutsAllChains(feeRoutingAllNetworks(), (n) => build({ network: n, days, db }))
      : await build({ network, days, db });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[api/admin/finance/payouts]", error);
    return res.status(500).json({ ok: false, error: "Payouts read failed." });
  }
}

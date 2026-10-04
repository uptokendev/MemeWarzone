// Finance Summary: one plain read for the Command Center summary page, made
// for a read-only partner. No new sources and no new tables:
//
//   money earned    the /revenue lanes (protocol share of bonding-curve trades,
//                   paid UP votes and the financeRevenueLanes.js lanes: arena
//                   boosts / entries, sponsorships, Home placements, DBC
//                   referral, EVM graduation; hidden test coins left out), split by
//                   UTC calendar month and valued with the same event-time
//                   rule (Binance hourly close of each event's hour);
//   LP fee share    the protocol's harvested LP share after graduation, as the
//                   Revenue page adds it: lifetime only, at current price;
//   where it is     the fee-routing map's cached balances, split into "ours"
//                   (protocol-owned) and "held for others" (owed + mixed);
//   owed to users   what Payouts lists as owed now (league, battle league,
//                   MWL, recruiter, airdrop, creator fees), test coins left out.
//
// A chain whose read fails is reported as unavailable and its amounts are
// unknown, never zero. Read-only: GET, no keys, no signing.

import { buildTotals } from "./financePrices.js";

export const SUMMARY_SCHEMA = "finance-summary-v1";
export const SUMMARY_DEFAULT_MONTHS = 12;
const SUMMARY_MIN_MONTHS = 2;
const SUMMARY_MAX_MONTHS = 24;
const CACHE_TTL_MS = 60_000;

export function summaryMonths(value) {
  const months = Number.parseInt(String(value ?? SUMMARY_DEFAULT_MONTHS), 10);
  if (!Number.isFinite(months)) return SUMMARY_DEFAULT_MONTHS;
  return Math.min(Math.max(months, SUMMARY_MIN_MONTHS), SUMMARY_MAX_MONTHS);
}

/** "YYYY-MM" of a timestamp in UTC, or null. */
export function monthKey(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last `months` UTC calendar months up to and including the month of `now`, oldest first. */
export function monthWindow(now, months) {
  const ref = new Date(now);
  const out = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - back, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    out.push({ month: monthKey(start), start: start.toISOString(), end: end.toISOString() });
  }
  return out;
}

/** Sum of atomic amounts as a decimal string. */
export function rawSumToDecimal(raws, decimals) {
  let total = 0n;
  for (const raw of raws) {
    const text = String(raw ?? "0").split(".")[0];
    if (/^\d+$/.test(text)) total += BigInt(text);
  }
  const digits = total.toString();
  if (decimals === 0 || digits === "0") return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// Where the protocol-owned money sits, in plain groups. The ownership class
// comes from financeFeeRoutingOwnership.js; this table only names the groups.
export const OURS_GROUPS = Object.freeze([
  Object.freeze({
    key: "protocol_vault",
    label: "Protocol vault",
    description: "Where the protocol's cut of every trade lands first. From here it moves on to the operator wallet and the multisig.",
    ids: Object.freeze(["protocol_vault"]),
  }),
  Object.freeze({
    key: "operator",
    label: "Operator wallet",
    description: "Day-to-day wallet. Gets the first $10,000 of protocol income on each chain and pays its own network fees.",
    ids: Object.freeze(["route_operator", "protocol_operator"]),
  }),
  Object.freeze({
    key: "multisig",
    label: "Safe / multisig",
    description: "Protocol income above the operator limit. Moving it needs more than one signer.",
    ids: Object.freeze(["squads_vault", "safe"]),
  }),
  Object.freeze({
    key: "collection",
    label: "Fee collection wallets",
    description: "Wallets that receive paid upvotes, our share of trading fees after a coin graduates, and swap fees on imported coins.",
    ids: Object.freeze(["vote_treasury", "lp_protocol_treasury", "dbc_referral", "import_swap_fee_owner"]),
  }),
]);

const OTHER_OURS_GROUP = Object.freeze({
  key: "other",
  label: "Other protocol wallets",
  description: "Protocol-owned balances that do not fit the groups above.",
});

function oursGroupKey(destinationId) {
  return OURS_GROUPS.find((group) => group.ids.includes(destinationId))?.key ?? OTHER_OURS_GROUP.key;
}

/**
 * Splits one chain's fee-routing destinations into protocol-owned and
 * held-for-others entries. Same rules as feeRoutingTotals: watch-only wallets
 * are left out, each address and asset is counted once, a balance that could
 * not be read is an unknown amount. Mixed balances count as held for others.
 */
export function splitHoldings(network, feeRouting) {
  const ours = [];
  const others = [];
  const groups = new Map();
  const seen = new Set();
  for (const d of feeRouting?.destinations || []) {
    if ((d.flags || []).includes("watch") || d.ownership === "watch") continue;
    for (const b of d.balances || []) {
      const key = `${String(d.address || d.id).toLowerCase()}:${b.asset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { chainId: network.chainId, chain: network.chain, asset: b.asset, amount: b.status === "ok" ? b.amount : null, amountUsd: b.amountUsd ?? null };
      if (d.ownership === "ours") {
        ours.push(entry);
        const group = oursGroupKey(d.id);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(entry);
      } else {
        others.push(entry);
      }
    }
  }
  return { ours, others, groups };
}

function emptyEntry(network) {
  return { chainId: network.chainId, chain: network.chain, asset: network.asset, amount: "0", amountUsd: 0 };
}

function unknownEntry(network) {
  return { chainId: network.chainId, chain: network.chain, asset: network.asset, amount: null, amountUsd: null };
}

async function valueLane(prices, network, lane, buckets) {
  if (buckets.length === 0) return { chainId: network.chainId, chain: network.chain, asset: lane.asset, amount: "0", amountUsd: 0 };
  const amount = rawSumToDecimal(buckets.map((b) => b.raw), lane.decimals);
  const usd = await prices.valueEvents(lane.asset, buckets, lane.decimals);
  return { chainId: network.chainId, chain: network.chain, asset: lane.asset, amount, amountUsd: usd.amountUsd, priceBasis: usd.priceBasis };
}

/** Revenue entries per month (window keys) and all time, for one chain. */
async function revenueEntries(network, read, window, prices) {
  const perMonth = new Map(window.map((m) => [m.month, []]));
  const allTime = [];
  const bases = new Set();
  for (const lane of read.lanes) {
    const byMonth = new Map();
    for (const bucket of lane.buckets) {
      const key = monthKey(bucket.hour);
      if (!key) continue;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(bucket);
    }
    for (const m of window) {
      const entry = await valueLane(prices, network, lane, byMonth.get(m.month) || []);
      if (entry.priceBasis) bases.add(entry.priceBasis);
      perMonth.get(m.month).push(entry);
    }
    const all = await valueLane(prices, network, lane, lane.buckets);
    if (all.priceBasis) bases.add(all.priceBasis);
    allTime.push(all);
  }
  if (read.lanes.length === 0) {
    for (const m of window) perMonth.get(m.month).push(emptyEntry(network));
    allTime.push(emptyEntry(network));
  }
  return { perMonth, allTime, bases };
}

function strip(entry) {
  return { chainId: entry.chainId, chain: entry.chain, asset: entry.asset, amount: entry.amount, amountUsd: entry.amountUsd };
}

function combinedBasis(bases) {
  if (bases.size === 0) return null;
  if (bases.size === 1) return [...bases][0];
  return "mixed";
}

/**
 * Builds the summary. Every reader is injected so the test can run it without
 * a database, RPC or price feed.
 *
 * readRevenue(network)    -> { lanes: [{asset, decimals, buckets:[{hour, raw}]}], excludedTestCoinEvents, unavailable? }
 * readLpShare(network)    -> { entries: [{asset, amount, amountUsd}], unpricedTokenCount }
 * readFeeRouting(network) -> fee-routing payload (destinations with ownership and balances)
 * readRewards(network)    -> rewards payload (totals.outstanding)
 * prices                  -> financePrices service (valueEvents, spotTable)
 */
export async function buildFinanceSummary({ networks, months = SUMMARY_DEFAULT_MONTHS, now = new Date().toISOString(), readRevenue, readLpShare, readFeeRouting, readRewards, prices }) {
  const window = monthWindow(now, months);
  const seed = networks;

  const [revenueReads, lpReads, feeReads, rewardReads] = await Promise.all([
    Promise.allSettled(networks.map(async (n) => readRevenue(n))),
    Promise.allSettled(networks.map(async (n) => readLpShare(n))),
    Promise.allSettled(networks.map(async (n) => readFeeRouting(n))),
    Promise.allSettled(networks.map(async (n) => readRewards(n))),
  ]);

  // Money earned.
  const monthEntries = new Map(window.map((m) => [m.month, []]));
  const allTimeEntries = [];
  const revenueNetworks = [];
  const bases = new Set();
  let excludedTestCoinEvents = 0;
  for (const [index, network] of networks.entries()) {
    const result = revenueReads[index];
    const identity = { chainId: network.chainId, chain: network.chain };
    if (result.status !== "fulfilled" || result.value?.unavailable) {
      const reason = result.status === "fulfilled" ? String(result.value.unavailable) : "The revenue read failed.";
      if (result.status !== "fulfilled") console.error(`[finance/summary] revenue chain ${network.chainId}`, result.reason);
      revenueNetworks.push({ ...identity, status: "unavailable", reason });
      for (const m of window) monthEntries.get(m.month).push(unknownEntry(network));
      allTimeEntries.push(unknownEntry(network));
      continue;
    }
    try {
      const entries = await revenueEntries(network, result.value, window, prices);
      for (const m of window) monthEntries.get(m.month).push(...entries.perMonth.get(m.month).map(strip));
      allTimeEntries.push(...entries.allTime.map(strip));
      for (const basis of entries.bases) bases.add(basis);
      excludedTestCoinEvents += Number(result.value.excludedTestCoinEvents || 0);
      revenueNetworks.push({ ...identity, status: "ok" });
    } catch (error) {
      console.error(`[finance/summary] revenue pricing chain ${network.chainId}`, error);
      revenueNetworks.push({ ...identity, status: "unavailable", reason: "The revenue could not be valued." });
      for (const m of window) monthEntries.get(m.month).push(unknownEntry(network));
      allTimeEntries.push(unknownEntry(network));
    }
  }
  const monthRows = window.map((m) => ({ ...m, totals: buildTotals(monthEntries.get(m.month), { seed }) }));

  // LP fee share after graduation (lifetime, current price).
  const lpEntries = [];
  const lpNetworks = [];
  let unpricedTokenCount = 0;
  for (const [index, network] of networks.entries()) {
    const result = lpReads[index];
    const identity = { chainId: network.chainId, chain: network.chain };
    if (result.status !== "fulfilled") {
      lpNetworks.push({ ...identity, status: "unavailable", reason: "The LP fee read failed." });
      lpEntries.push(unknownEntry(network));
      continue;
    }
    lpNetworks.push({ ...identity, status: "ok" });
    const entries = result.value.entries || [];
    if (entries.length === 0) lpEntries.push(emptyEntry(network));
    for (const e of entries) lpEntries.push({ chainId: network.chainId, chain: network.chain, asset: e.asset, amount: e.amount, amountUsd: e.amountUsd });
    unpricedTokenCount += Number(result.value.unpricedTokenCount || 0);
  }

  // Where the money is.
  const oursEntries = [];
  const othersEntries = [];
  const groupEntries = new Map();
  const holdingNetworks = [];
  for (const [index, network] of networks.entries()) {
    const result = feeReads[index];
    const identity = { chainId: network.chainId, chain: network.chain };
    if (result.status !== "fulfilled") {
      console.error(`[finance/summary] fee routing chain ${network.chainId}`, result.reason);
      holdingNetworks.push({ ...identity, status: "unavailable", reason: "The wallet balance read failed." });
      oursEntries.push(unknownEntry(network));
      othersEntries.push(unknownEntry(network));
      continue;
    }
    holdingNetworks.push({ ...identity, status: "ok", asOf: result.value.generatedAt || null });
    const split = splitHoldings(network, result.value);
    oursEntries.push(...(split.ours.length ? split.ours : [emptyEntry(network)]));
    othersEntries.push(...(split.others.length ? split.others : [emptyEntry(network)]));
    for (const [key, entries] of split.groups) {
      if (!groupEntries.has(key)) groupEntries.set(key, []);
      groupEntries.get(key).push(...entries);
    }
  }
  const groupDefs = [...OURS_GROUPS, ...(groupEntries.has(OTHER_OURS_GROUP.key) ? [OTHER_OURS_GROUP] : [])];
  const groups = groupDefs.map((group) => ({
    key: group.key,
    label: group.label,
    description: group.description,
    totals: buildTotals(groupEntries.get(group.key) || [], { seed: networks.filter((n) => holdingNetworks.find((h) => h.chainId === n.chainId)?.status === "ok") }),
  }));
  const holdingTimes = holdingNetworks.map((h) => h.asOf).filter(Boolean).sort();

  // Owed to users.
  const outstandingEntries = [];
  const owedNetworks = [];
  for (const [index, network] of networks.entries()) {
    const result = rewardReads[index];
    const identity = { chainId: network.chainId, chain: network.chain };
    const outstanding = result.status === "fulfilled" ? result.value?.totals?.outstanding : null;
    if (!outstanding || result.value?.notice) {
      if (result.status !== "fulfilled") console.error(`[finance/summary] rewards chain ${network.chainId}`, result.reason);
      owedNetworks.push({ ...identity, status: "unavailable", reason: result.status === "fulfilled" && result.value?.notice ? String(result.value.notice) : "The rewards read failed." });
      outstandingEntries.push(unknownEntry(network));
      continue;
    }
    owedNetworks.push({ ...identity, status: "ok" });
    const chainRow = (outstanding.byChain || []).find((row) => Number(row.chainId) === network.chainId);
    const assets = chainRow?.assets || [];
    if (assets.length === 0) outstandingEntries.push(emptyEntry(network));
    for (const asset of assets) {
      outstandingEntries.push({ chainId: network.chainId, chain: network.chain, asset: asset.asset, amount: asset.amountNative, amountUsd: asset.amountUsd });
    }
  }

  return {
    schemaVersion: SUMMARY_SCHEMA,
    generatedAt: now,
    source: "dashboard-api",
    months,
    networks: networks.map((n) => ({ chainId: n.chainId, chain: n.chain, label: n.label, asset: n.asset })),
    revenue: {
      priceBasis: combinedBasis(bases),
      months: monthRows,
      thisMonth: monthRows[monthRows.length - 1],
      lastMonth: monthRows[monthRows.length - 2],
      allTime: buildTotals(allTimeEntries, { seed }),
      networks: revenueNetworks,
      excludedTestCoinEvents,
      lpShare: {
        totals: buildTotals(lpEntries, { seed }),
        priceBasis: "current",
        unpricedTokenCount,
        networks: lpNetworks,
      },
    },
    holdings: {
      asOf: holdingTimes[0] || null,
      ours: buildTotals(oursEntries, { seed }),
      heldForOthers: buildTotals(othersEntries, { seed }),
      groups,
      networks: holdingNetworks,
      priceBasis: "current",
    },
    owed: {
      asOf: now,
      outstanding: buildTotals(outstandingEntries, { seed }),
      networks: owedNetworks,
      priceBasis: "current",
    },
    prices: await prices.spotTable(["SOL", "BNB", "ETH"]),
    testCoinsExcluded: true,
  };
}

const cache = new Map();

/** 60-second cache with in-flight sharing, keyed by the month count. */
export async function cachedFinanceSummary(key, build) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < CACHE_TTL_MS)) return hit.pending || hit.value;
  const pending = build();
  cache.set(key, { pending, at: 0 });
  try {
    const value = await pending;
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export function clearFinanceSummaryCache() {
  cache.clear();
}

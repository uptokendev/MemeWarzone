import { canonicalTokenKey } from "./arenaLeagueScoreMath.js";

export const VOLUME_EXCLUDE = Object.freeze({
  SELF_TRADE: "SELF_TRADE",
  COMMON_CONTROL_CLUSTER: "COMMON_CONTROL_CLUSTER",
  CREATOR_FUNDED_FAKE_DEMAND: "CREATOR_FUNDED_FAKE_DEMAND",
  CIRCULAR_TRADE: "CIRCULAR_TRADE",
  FAILED_TRADE: "FAILED_TRADE",
  OUTSIDE_WINDOW: "OUTSIDE_WINDOW",
  UNPRICED_QUOTE: "UNPRICED_QUOTE",
});

function asTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function identWallet(value) {
  return canonicalTokenKey(value);
}

function usdOf(trade) {
  const raw = trade?.usdAmount ?? trade?.usd_amount;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tradeTime(trade) {
  return asTime(trade?.blockTime ?? trade?.block_time);
}

export function clusterIdFor(wallet, clusterByWallet = new Map()) {
  const key = identWallet(wallet);
  if (!key) return "wallet:";
  return clusterByWallet.get(key) || clusterByWallet.get(String(wallet || "")) || `wallet:${key}`;
}

export function battleVolumeWindow(row = {}, metrics = {}, now = new Date()) {
  const state = String(row.state || "");
  const liveAt = metrics.baseline_timestamp || metrics.baselineTimestamp
    || ((state === "live" || state === "finished") ? (row.started_at || row.startedAt) : null);
  const nowDate = now instanceof Date ? now : new Date(now);
  let finishAt = row.finished_at || row.finishedAt || null;
  if (!finishAt) {
    const ends = row.ends_at || row.endsAt || null;
    if (state === "live") {
      const endsDate = ends ? new Date(ends) : nowDate;
      finishAt = endsDate.getTime() < nowDate.getTime() ? endsDate : nowDate;
    } else {
      finishAt = ends || nowDate;
    }
  }
  return { liveAt, finishAt };
}

function inWindow(trade, liveAt, finishAt) {
  const t = tradeTime(trade);
  const start = asTime(liveAt);
  const end = asTime(finishAt);
  if (!Number.isFinite(t) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  return t >= start && t < end;
}

function isConfirmed(trade) {
  const status = String(trade?.status || "confirmed").toLowerCase();
  return status === "confirmed";
}

function setHasWallet(set, wallet) {
  if (!set) return false;
  const key = identWallet(wallet);
  return set.has(key) || set.has(String(wallet || "")) || set.has(String(wallet || "").toLowerCase());
}

function setHasCluster(set, clusterId) {
  if (!set) return false;
  return set.has(clusterId);
}

/**
 * Battle-period volume eligibility filter.
 *
 * Important boundaries:
 * - recipient === wallet is NOT a self-trade signal. Bonding and router executions
 *   routinely deliver bought tokens to the initiating wallet.
 * - a cluster buying and selling during a battle is NOT automatically wash volume.
 *   Circular/wash exclusion must come from explicit risk evidence.
 * - concentration is a scoring-influence control and is applied by the Battle
 *   Points engine, not by deleting otherwise legitimate USD volume here.
 */
export function computeEligibleBattleVolume({
  trades = [],
  liveAt,
  finishAt,
  clusterByWallet = new Map(),
  creatorWallets = new Set(),
  creatorClusterIds = new Set(),
  fundedWallets = new Set(),
  restrictedWallets = new Set(),
  restrictedClusters = new Set(),
  washWallets = new Set(),
  washClusters = new Set(),
} = {}) {
  const legs = [];

  for (const trade of trades) {
    const wallet = identWallet(trade.wallet);
    const usd = usdOf(trade);
    const clusterId = clusterIdFor(wallet, clusterByWallet);
    const rawNative = trade.nativeAmount ?? trade.native_amount;
    const nativeNumber = rawNative === null || rawNative === undefined || rawNative === ""
      ? null
      : Number(rawNative);
    const base = {
      wallet,
      clusterId,
      txHash: trade.txHash || trade.tx_hash || null,
      logIndex: trade.logIndex ?? trade.log_index ?? 0,
      blockTime: trade.blockTime || trade.block_time || null,
      nativeAmount: Number.isFinite(nativeNumber) ? nativeNumber : null,
      usdAmount: usd,
      usdCounted: 0,
      sideKind: String(trade.side || trade.sideKind || "").toLowerCase() === "sell" ? "sell" : "buy",
      source: trade.source || null,
      quoteAssetType: trade.quoteAssetType || trade.quote_asset_type || null,
      quoteTokenAddress: trade.quoteTokenAddress || trade.quote_token_address || null,
      valuationSource: trade.valuationSource || trade.valuation_source || null,
      included: false,
      excludeReason: null,
      rawClusterUsd: 0,
      countedClusterUsd: 0,
    };

    if (!inWindow(trade, liveAt, finishAt)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.OUTSIDE_WINDOW });
      continue;
    }
    if (!isConfirmed(trade)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.FAILED_TRADE });
      continue;
    }
    if (usd === null || trade.valuationHealthy === false) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.UNPRICED_QUOTE });
      continue;
    }
    if (trade.selfTrade === true) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.SELF_TRADE });
      continue;
    }
    if (
      trade.circularTrade === true || trade.washTrade === true
      || setHasWallet(washWallets, wallet) || setHasCluster(washClusters, clusterId)
    ) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.CIRCULAR_TRADE });
      continue;
    }
    if (setHasWallet(restrictedWallets, wallet) || setHasCluster(restrictedClusters, clusterId)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.COMMON_CONTROL_CLUSTER });
      continue;
    }
    if (setHasWallet(creatorWallets, wallet)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.SELF_TRADE });
      continue;
    }
    if (setHasCluster(creatorClusterIds, clusterId)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.COMMON_CONTROL_CLUSTER });
      continue;
    }
    if (setHasWallet(fundedWallets, wallet)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.CREATOR_FUNDED_FAKE_DEMAND });
      continue;
    }

    legs.push({ ...base, included: true, usdCounted: usd });
  }

  const eligibleLegs = legs.filter((leg) => leg.included && !leg.excludeReason);
  const perClusterRaw = new Map();
  for (const leg of eligibleLegs) {
    perClusterRaw.set(leg.clusterId, (perClusterRaw.get(leg.clusterId) || 0) + (leg.usdAmount || 0));
  }

  const sortedClusters = [...perClusterRaw.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const eligibleUsd = [...perClusterRaw.values()].reduce((sum, n) => sum + n, 0);

  for (const leg of eligibleLegs) {
    const rawClusterUsd = perClusterRaw.get(leg.clusterId) || 0;
    leg.rawClusterUsd = rawClusterUsd;
    leg.countedClusterUsd = rawClusterUsd;
  }

  const excludedUsd = legs
    .filter((leg) => leg.excludeReason && leg.usdAmount !== null)
    .reduce((sum, leg) => sum + (leg.usdAmount || 0), 0);

  return {
    rawUsd: eligibleUsd,
    excludedUsd,
    // Compatibility: no legitimate USD is removed here. The 20% concentration
    // policy is enforced on points in calculateBattlePoints().
    cappedUsd: eligibleUsd,
    eligibleUsd,
    legs,
    clusters: sortedClusters.map((clusterId) => ({
      clusterId,
      rawUsd: perClusterRaw.get(clusterId) || 0,
      countedUsd: perClusterRaw.get(clusterId) || 0,
    })),
  };
}

export function volumeAuditRows({ battleId, tokenId, side, result }) {
  return (result?.legs || []).map((leg) => ({
    battle_id: battleId,
    token_id: tokenId,
    side,
    wallet: leg.wallet,
    cluster_id: leg.clusterId,
    tx_hash: leg.txHash,
    log_index: leg.logIndex,
    block_time: leg.blockTime,
    native_amount: leg.nativeAmount,
    usd_amount: leg.usdAmount,
    usd_counted: leg.usdCounted,
    side_kind: leg.sideKind,
    source: leg.source,
    quote_asset_type: leg.quoteAssetType,
    quote_token_address: leg.quoteTokenAddress,
    valuation_source: leg.valuationSource,
    included: Boolean(leg.included && !leg.excludeReason),
    exclude_reason: leg.excludeReason,
    raw_cluster_usd: leg.rawClusterUsd,
    counted_cluster_usd: leg.countedClusterUsd,
  }));
}

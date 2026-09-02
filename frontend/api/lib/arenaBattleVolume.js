import { canonicalTokenKey } from "./arenaLeagueScoreMath.js";
import { BATTLE_POINTS_CONFIG } from "./arenaBattlePointsConfig.js";

export const VOLUME_EXCLUDE = Object.freeze({
  SELF_TRADE: "SELF_TRADE",
  COMMON_CONTROL_CLUSTER: "COMMON_CONTROL_CLUSTER",
  CREATOR_FUNDED_FAKE_DEMAND: "CREATOR_FUNDED_FAKE_DEMAND",
  CIRCULAR_TRADE: "CIRCULAR_TRADE",
  FAILED_TRADE: "FAILED_TRADE",
  OUTSIDE_WINDOW: "OUTSIDE_WINDOW",
  CLUSTER_CAP: "CLUSTER_CAP",
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
  const n = Number(trade?.usdAmount ?? trade?.usd_amount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

function sameWallet(a, b) {
  const left = identWallet(a);
  const right = identWallet(b);
  return Boolean(left) && left === right;
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
 * Eligible battle-period volume. Pure: trades must already be native-converted to USD.
 * Cluster cap is 20% of raw eligible USD. Circular clusters (buy and sell) are fully excluded.
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
  capRatio = BATTLE_POINTS_CONFIG.volume.singleClusterCap,
} = {}) {
  const legs = [];
  for (const trade of trades) {
    const wallet = identWallet(trade.wallet);
    const counterparty = identWallet(trade.counterparty ?? trade.recipient);
    const usd = usdOf(trade);
    const clusterId = clusterIdFor(wallet, clusterByWallet);
    const base = {
      wallet,
      clusterId,
      txHash: trade.txHash || trade.tx_hash || null,
      logIndex: trade.logIndex ?? trade.log_index ?? 0,
      blockTime: trade.blockTime || trade.block_time || null,
      nativeAmount: Number(trade.nativeAmount ?? trade.native_amount ?? 0) || 0,
      usdAmount: usd,
      sideKind: String(trade.side || trade.sideKind || "").toLowerCase() === "sell" ? "sell" : "buy",
      source: trade.source || null,
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
    if (counterparty && sameWallet(wallet, counterparty)) {
      legs.push({ ...base, excludeReason: VOLUME_EXCLUDE.SELF_TRADE });
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
    legs.push(base);
  }

  const candidates = legs.filter((leg) => !leg.excludeReason);
  const clusterSides = new Map();
  for (const leg of candidates) {
    const current = clusterSides.get(leg.clusterId) || { buy: 0, sell: 0 };
    if (leg.sideKind === "sell") current.sell += 1;
    else current.buy += 1;
    clusterSides.set(leg.clusterId, current);
  }
  const circularClusters = new Set(
    [...clusterSides.entries()].filter(([, sides]) => sides.buy > 0 && sides.sell > 0).map(([id]) => id),
  );
  for (const leg of candidates) {
    if (circularClusters.has(leg.clusterId)) {
      leg.excludeReason = VOLUME_EXCLUDE.CIRCULAR_TRADE;
    }
  }

  const eligibleLegs = legs.filter((leg) => !leg.excludeReason);
  const perClusterRaw = new Map();
  for (const leg of eligibleLegs) {
    perClusterRaw.set(leg.clusterId, (perClusterRaw.get(leg.clusterId) || 0) + leg.usdAmount);
  }
  const rawEligibleUsd = [...perClusterRaw.values()].reduce((sum, n) => sum + n, 0);
  const capUsd = rawEligibleUsd > 0 ? capRatio * rawEligibleUsd : 0;
  const sortedClusters = [...perClusterRaw.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const countedByCluster = new Map();
  let eligibleUsd = 0;
  for (const clusterId of sortedClusters) {
    const raw = perClusterRaw.get(clusterId) || 0;
    const counted = Math.min(raw, capUsd);
    countedByCluster.set(clusterId, counted);
    eligibleUsd += counted;
  }

  for (const leg of eligibleLegs) {
    const rawClusterUsd = perClusterRaw.get(leg.clusterId) || 0;
    const countedClusterUsd = countedByCluster.get(leg.clusterId) || 0;
    const share = rawClusterUsd > 0 ? leg.usdAmount / rawClusterUsd : 0;
    leg.rawClusterUsd = rawClusterUsd;
    leg.countedClusterUsd = countedClusterUsd;
    leg.included = true;
    if (countedClusterUsd + 1e-12 < rawClusterUsd) {
      leg.excludeReason = VOLUME_EXCLUDE.CLUSTER_CAP;
      leg.usdCounted = share * countedClusterUsd;
    } else {
      leg.usdCounted = leg.usdAmount;
    }
  }

  const excludedUsd = legs
    .filter((leg) => leg.excludeReason && leg.excludeReason !== VOLUME_EXCLUDE.CLUSTER_CAP)
    .reduce((sum, leg) => sum + leg.usdAmount, 0);

  return {
    rawUsd: rawEligibleUsd,
    excludedUsd,
    cappedUsd: eligibleUsd,
    eligibleUsd,
    capUsd,
    legs,
    clusters: sortedClusters.map((clusterId) => ({
      clusterId,
      rawUsd: perClusterRaw.get(clusterId) || 0,
      countedUsd: countedByCluster.get(clusterId) || 0,
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
    side_kind: leg.sideKind,
    source: leg.source,
    included: Boolean(leg.included),
    exclude_reason: leg.excludeReason,
    raw_cluster_usd: leg.rawClusterUsd,
    counted_cluster_usd: leg.countedClusterUsd,
  }));
}

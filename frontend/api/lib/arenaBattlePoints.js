import { BATTLE_POINTS_CONFIG, BATTLE_POINTS_V1, BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundPoints(value) {
  const n = finiteNumber(value);
  if (n === null) return 0;
  return Math.round(n * 10000) / 10000;
}

function saturatingPoints(weight, k, x) {
  const w = finiteNumber(weight) || 0;
  const gain = finiteNumber(x) || 0;
  const curve = finiteNumber(k) || 0;
  if (!(w > 0) || !(gain > 0) || !(curve > 0)) return 0;
  return w * (1 - Math.exp(-curve * gain));
}

function meanPositive(values, fallback) {
  const nums = values.map(finiteNumber).filter((n) => n !== null && n > 0);
  if (!nums.length) return fallback;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function lagSeconds(updatedAt, nowMs) {
  if (!updatedAt) return null;
  const ts = typeof updatedAt === "number" ? updatedAt : Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (nowMs - ts) / 1000);
}

function dataHealthFrom({ baseline, current, startMcap, startHolders, currentMcap, currentHolders, nowMs, staleSeconds }) {
  const reasons = [];
  const currentLag = finiteNumber(current?.dataLagSeconds) ?? lagSeconds(current?.updatedAt || current?.marketDataUpdatedAt, nowMs);
  const marketDataUpdatedAt = current?.updatedAt || current?.marketDataUpdatedAt || null;

  if (!(startMcap > 0)) reasons.push("invalid_baseline_mcap");
  if (startHolders === null) reasons.push("invalid_baseline_holders");
  if (currentMcap === null) reasons.push("missing_current_mcap");
  if (currentHolders === null) reasons.push("missing_current_holders");

  const stale = currentLag !== null && currentLag > staleSeconds;
  if (stale) reasons.push("stale");

  const upstreamReasons = Array.isArray(current?.reasons)
    ? current.reasons
    : current?.reason
      ? [current.reason]
      : [];
  if (current?.healthy === false) {
    for (const reason of upstreamReasons) {
      const normalized = String(reason || "unhealthy").trim();
      if (normalized) reasons.push(normalized);
    }
    if (!upstreamReasons.length) reasons.push("unhealthy");
  }

  const unique = [...new Set(reasons)];
  const status = unique.includes("stale") ? "stale" : unique.length ? "missing" : "healthy";
  return {
    status,
    healthy: unique.length === 0,
    reasons: unique,
    reason: unique[0] || null,
    dataLagSeconds: currentLag,
    marketDataUpdatedAt,
    baselineTimestamp: baseline?.baselineTimestamp || baseline?.baseline_timestamp || null,
  };
}

function normalizedClusters(clusters, eligibleUsd) {
  const rows = Array.isArray(clusters) ? clusters : [];
  const normalized = rows
    .map((row, index) => ({
      clusterId: String(row?.clusterId ?? row?.cluster_id ?? `cluster:${index}`),
      usd: Math.max(0, finiteNumber(row?.countedUsd ?? row?.counted_usd ?? row?.rawUsd ?? row?.raw_usd) || 0),
    }))
    .filter((row) => row.usd > 0);
  if (normalized.length || !(eligibleUsd > 0)) return normalized;
  // Missing cluster evidence must not accidentally bypass the concentration rule.
  return [{ clusterId: "unclustered", usd: eligibleUsd }];
}

function applyVolumeConcentrationCap({ rawPoints, eligibleUsd, clusters, weight, capRatio }) {
  const maxComponentPoints = Math.max(0, finiteNumber(weight) || 0);
  const ratio = Math.min(1, Math.max(0, finiteNumber(capRatio) ?? 0.2));
  const clusterPointCap = maxComponentPoints * ratio;
  const normalized = normalizedClusters(clusters, eligibleUsd);
  if (!(rawPoints > 0) || !(eligibleUsd > 0) || !normalized.length) {
    return {
      points: 0,
      rawPoints: Math.max(0, rawPoints || 0),
      clusterPointCap,
      concentrationDiscountPoints: Math.max(0, rawPoints || 0),
      clusterContributions: [],
    };
  }

  const representedUsd = normalized.reduce((sum, row) => sum + row.usd, 0);
  const denominator = representedUsd > 0 ? representedUsd : eligibleUsd;
  const clusterContributions = normalized.map((row) => {
    const share = denominator > 0 ? row.usd / denominator : 0;
    const uncappedPoints = rawPoints * share;
    const countedPoints = Math.min(uncappedPoints, clusterPointCap);
    return {
      clusterId: row.clusterId,
      usd: row.usd,
      share,
      uncappedPoints: roundPoints(uncappedPoints),
      countedPoints: roundPoints(countedPoints),
      capped: countedPoints + 1e-12 < uncappedPoints,
    };
  });
  const points = Math.min(maxComponentPoints, clusterContributions.reduce((sum, row) => sum + row.countedPoints, 0));
  return {
    points,
    rawPoints,
    clusterPointCap,
    concentrationDiscountPoints: Math.max(0, rawPoints - points),
    clusterContributions,
  };
}

/**
 * Canonical Battle Points V2. Consumes normalized USD / holder / volume values only.
 */
export function calculateBattlePoints({
  baseline = {},
  current = {},
  eligibleVolume = {},
  now = Date.now(),
  config = BATTLE_POINTS_CONFIG,
} = {}) {
  const cfg = config || BATTLE_POINTS_CONFIG;
  const nowMs = typeof now === "number" ? now : Date.parse(now) || Date.now();
  const startMcap = finiteNumber(baseline.startMcapUsd ?? baseline.start_mcap_usd);
  const startHolders = finiteNumber(baseline.startHolders ?? baseline.start_holders);
  const currentMcap = finiteNumber(current.marketCapUsd ?? current.currentMcapUsd ?? current.current_mcap_usd);
  const currentHolders = finiteNumber(current.holders ?? current.currentHolders ?? current.current_holders);
  const eligibleUsd = Math.max(0, finiteNumber(eligibleVolume.usd ?? eligibleVolume.eligibleUsd ?? eligibleVolume.eligible_battle_volume_usd) || 0);
  const rawUsd = Math.max(0, finiteNumber(eligibleVolume.rawUsd ?? eligibleVolume.volume_raw_usd) || 0);
  const cappedUsd = Math.max(0, finiteNumber(eligibleVolume.cappedUsd ?? eligibleVolume.volume_capped_usd) ?? eligibleUsd);

  let mcapChangePct = null;
  let mcapPoints = 0;
  if (startMcap > 0 && currentMcap !== null) {
    mcapChangePct = (currentMcap - startMcap) / startMcap;
    mcapPoints = saturatingPoints(cfg.mcap.weight, cfg.mcap.k, Math.max(0, mcapChangePct));
  }

  const holderFloor = cfg.holders.confidenceFloor;
  const holderStart = startHolders === null ? 0 : startHolders;
  const holderCurrent = currentHolders === null ? 0 : currentHolders;
  const confidence = holderStart > 0 ? holderStart / (holderStart + holderFloor) : 0;
  let holderChangePct = null;
  if (holderStart > 0 && currentHolders !== null) {
    holderChangePct = (holderCurrent - holderStart) / holderStart;
  } else if (currentHolders !== null) {
    holderChangePct = Math.log1p(Math.max(holderCurrent, 0)) - Math.log1p(Math.max(holderStart, 0));
  }
  const holderGain = Math.max(0, holderChangePct || 0);
  const holderPoints = saturatingPoints(cfg.holders.weight, cfg.holders.k, holderGain) * confidence;

  const avgMcap = meanPositive([startMcap, currentMcap], cfg.volume.minMcapDenom);
  const denom = Math.max(avgMcap, cfg.volume.minMcapDenom);
  const turnoverPct = denom > 0 ? eligibleUsd / denom : 0;
  const rawVolumePoints = saturatingPoints(cfg.volume.weight, cfg.volume.k, Math.max(0, turnoverPct));
  const concentration = applyVolumeConcentrationCap({
    rawPoints: rawVolumePoints,
    eligibleUsd,
    clusters: eligibleVolume.clusters,
    weight: cfg.volume.weight,
    capRatio: cfg.volume.singleClusterCap,
  });

  const mcap = {
    start: startMcap,
    current: currentMcap,
    changePct: mcapChangePct,
    points: roundPoints(Math.min(cfg.mcap.weight, Math.max(0, mcapPoints))),
  };
  const holders = {
    start: startHolders,
    current: currentHolders,
    changePct: holderChangePct,
    points: roundPoints(Math.min(cfg.holders.weight, Math.max(0, holderPoints))),
  };
  const volume = {
    eligibleUsd,
    rawUsd,
    cappedUsd,
    points: roundPoints(Math.min(cfg.volume.weight, Math.max(0, concentration.points))),
    rawPoints: roundPoints(Math.min(cfg.volume.weight, Math.max(0, concentration.rawPoints))),
    turnoverPct,
    clusterPointCap: roundPoints(concentration.clusterPointCap),
    concentrationDiscountPoints: roundPoints(concentration.concentrationDiscountPoints),
    clusterContributions: concentration.clusterContributions,
  };

  const totalPoints = roundPoints(Math.min(100, mcap.points + holders.points + volume.points));
  const health = dataHealthFrom({
    baseline,
    current,
    startMcap,
    startHolders,
    currentMcap,
    currentHolders,
    nowMs,
    staleSeconds: cfg.staleSeconds,
  });

  return {
    scoringVersion: cfg.version || BATTLE_POINTS_V2,
    totalPoints,
    mcap,
    holders,
    volume,
    components: {
      mcapPoints: mcap.points,
      holderPoints: holders.points,
      volumePoints: volume.points,
    },
    performance: {
      mcapPct: mcap.changePct,
      holderPct: holders.changePct,
      turnoverPct: volume.turnoverPct,
    },
    marketDataUpdatedAt: health.marketDataUpdatedAt,
    dataHealth: health,
  };
}

export function interpretHistoricalBattle(row = {}, metricsRow = null) {
  const settlementVersion = row.settlement_version ?? row.settlementVersion ?? null;
  const scoringVersion = metricsRow?.scoring_version || metricsRow?.scoringVersion || null;
  if (scoringVersion === BATTLE_POINTS_V2) {
    return {
      scoringVersion: BATTLE_POINTS_V2,
      settlementVersion,
      interpretable: true,
    };
  }
  return {
    scoringVersion: BATTLE_POINTS_V1,
    settlementVersion: settlementVersion ?? 1,
    scoreBasis: BATTLE_POINTS_V1,
    interpretable: true,
    leftStartMcap: finiteNumber(row.challenger_start_mcap_usd ?? row.challengerStartMcapUsd),
    rightStartMcap: finiteNumber(row.defender_start_mcap_usd ?? row.defenderStartMcapUsd),
    leftEndMcap: finiteNumber(row.challenger_end_mcap_usd ?? row.challengerEndMcapUsd),
    rightEndMcap: finiteNumber(row.defender_end_mcap_usd ?? row.defenderEndMcapUsd),
    leftPct: finiteNumber(row.challenger_pct_change ?? row.challengerPctChange),
    rightPct: finiteNumber(row.defender_pct_change ?? row.defenderPctChange),
  };
}

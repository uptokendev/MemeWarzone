import type { Battle } from "@/features/postgrad/contracts";

export type BattleRealtimeLeader = "left" | "right" | "tied" | null;
export type BattleSettlementMode = "v1_mcap_pct_change" | "battle_points_v2";

export type BattleRealtimeSide = {
  side: "left" | "right";
  tokenId: string;
  scoringVersion: string;
  pointsReady: boolean;
  baseline: {
    marketCapUsd: number | null;
    holders: number | null;
    liquidityUsd: number | null;
    timestamp: string | null;
    marketDataUpdatedAt: string | null;
    healthy: boolean;
    dataSource: string | null;
  };
  current: {
    marketCapUsd: number | null;
    holders: number | null;
    liquidityUsd: number | null;
    marketDataUpdatedAt: string | null;
    dataLagSeconds: number | null;
    healthy: boolean;
    dataSource: string | null;
  };
  eligibleBattleVolumeUsd: number;
  points: {
    marketCap: number;
    holders: number;
    volume: number;
    total: number;
  };
  metricsUpdatedAt: string | null;
};

export type BattleRealtimeMetrics = {
  battleId: string;
  chainId: number;
  state: string;
  scoringVersion: string;
  settlementMode: BattleSettlementMode;
  settlementVersion: number | null;
  settlementScoringVersion: string | null;
  moneyTieBreak: string | null;
  tieBreakUsed: boolean;
  finalBattlePoints: { left: number | null; right: number | null } | null;
  settlementMetricsUpdatedAt: string | null;
  leaderSide: BattleRealtimeLeader;
  pointDifference: number | null;
  metricsUpdatedAt: string | null;
  dataHealth: {
    healthy: boolean;
    status: "healthy" | "data_delay";
    reasons: string[];
  };
  sides: {
    left: BattleRealtimeSide | null;
    right: BattleRealtimeSide | null;
  };
};

export const ARENA_BATTLE_REALTIME_EVENTS = new Set([
  "arena_battle_metrics_patch",
  "arena_battle_points_patch",
  "arena_battle_lead_changed",
  "arena_battle_finished",
]);

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finite(value) ?? 0);
}

function settlementMode(value: unknown): BattleSettlementMode {
  return String(value || "") === "battle_points_v2" ? "battle_points_v2" : "v1_mcap_pct_change";
}

function normalizeSide(value: any, expected: "left" | "right"): BattleRealtimeSide | null {
  if (!value || String(value.side || expected) !== expected || !value.tokenId) return null;
  return {
    side: expected,
    tokenId: String(value.tokenId),
    scoringVersion: String(value.scoringVersion || "battle_points_v2"),
    pointsReady: value.pointsReady === true,
    baseline: {
      marketCapUsd: finite(value.baseline?.marketCapUsd),
      holders: finite(value.baseline?.holders),
      liquidityUsd: finite(value.baseline?.liquidityUsd),
      timestamp: value.baseline?.timestamp ? String(value.baseline.timestamp) : null,
      marketDataUpdatedAt: value.baseline?.marketDataUpdatedAt ? String(value.baseline.marketDataUpdatedAt) : null,
      healthy: value.baseline?.healthy === true,
      dataSource: value.baseline?.dataSource ? String(value.baseline.dataSource) : null,
    },
    current: {
      marketCapUsd: finite(value.current?.marketCapUsd),
      holders: finite(value.current?.holders),
      liquidityUsd: finite(value.current?.liquidityUsd),
      marketDataUpdatedAt: value.current?.marketDataUpdatedAt ? String(value.current.marketDataUpdatedAt) : null,
      dataLagSeconds: finite(value.current?.dataLagSeconds),
      healthy: value.current?.healthy === true,
      dataSource: value.current?.dataSource ? String(value.current.dataSource) : null,
    },
    eligibleBattleVolumeUsd: nonNegative(value.eligibleBattleVolumeUsd),
    points: {
      marketCap: nonNegative(value.points?.marketCap),
      holders: nonNegative(value.points?.holders),
      volume: nonNegative(value.points?.volume),
      total: nonNegative(value.points?.total),
    },
    metricsUpdatedAt: value.metricsUpdatedAt ? String(value.metricsUpdatedAt) : null,
  };
}

export function normalizeBattleRealtimeMetrics(value: any): BattleRealtimeMetrics | null {
  if (!value || !value.battleId) return null;
  const leader = ["left", "right", "tied"].includes(String(value.leaderSide))
    ? String(value.leaderSide) as Exclude<BattleRealtimeLeader, null>
    : null;
  const reasons = Array.isArray(value.dataHealth?.reasons)
    ? value.dataHealth.reasons.map((reason: unknown) => String(reason)).filter(Boolean)
    : [];
  const healthy = value.dataHealth?.healthy === true;
  const finalLeft = finite(value.finalBattlePoints?.left);
  const finalRight = finite(value.finalBattlePoints?.right);
  return {
    battleId: String(value.battleId),
    chainId: Number(value.chainId) || 0,
    state: String(value.state || ""),
    scoringVersion: String(value.scoringVersion || "battle_points_v2"),
    settlementMode: settlementMode(value.settlementMode),
    settlementVersion: finite(value.settlementVersion),
    settlementScoringVersion: value.settlementScoringVersion ? String(value.settlementScoringVersion) : null,
    moneyTieBreak: value.moneyTieBreak ? String(value.moneyTieBreak) : null,
    tieBreakUsed: value.tieBreakUsed === true,
    finalBattlePoints: finalLeft !== null || finalRight !== null ? { left: finalLeft, right: finalRight } : null,
    settlementMetricsUpdatedAt: value.settlementMetricsUpdatedAt ? String(value.settlementMetricsUpdatedAt) : null,
    leaderSide: leader,
    pointDifference: finite(value.pointDifference),
    metricsUpdatedAt: value.metricsUpdatedAt ? String(value.metricsUpdatedAt) : null,
    dataHealth: {
      healthy,
      status: healthy ? "healthy" : "data_delay",
      reasons,
    },
    sides: {
      left: normalizeSide(value.sides?.left, "left"),
      right: normalizeSide(value.sides?.right, "right"),
    },
  };
}

export function decorateBattleWithRealtimeMetrics(battle: Battle, metrics: BattleRealtimeMetrics | null): Battle {
  if (!metrics) return battle;
  const participants = battle.participants.map((participant: any, index) => {
    const side = index === 0 ? metrics.sides.left : index === 1 ? metrics.sides.right : null;
    if (!side) return participant;
    return {
      ...participant,
      battlePointsReady: side.pointsReady,
      battlePoints: side.points.total,
      mcapPoints: side.points.marketCap,
      holderPoints: side.points.holders,
      volumePoints: side.points.volume,
      battleVolumeUsd: side.eligibleBattleVolumeUsd,
      marketCapUsd: side.current.marketCapUsd ?? participant.marketCapUsd,
      holderCount: side.current.holders ?? participant.holderCount,
      liquidityUsd: side.current.liquidityUsd ?? participant.liquidityUsd,
      marketDataHealthy: side.current.healthy,
      marketDataUpdatedAt: side.current.marketDataUpdatedAt,
    };
  });
  return {
    ...battle,
    participants,
    battlePointsPreview: metrics,
    battlePointsLeaderSide: metrics.leaderSide,
    battlePointsDifference: metrics.pointDifference,
    battlePointsDataHealth: metrics.dataHealth,
    battlePointsUpdatedAt: metrics.metricsUpdatedAt,
    settlementMode: metrics.settlementMode,
    settlementScoringVersion: metrics.settlementScoringVersion,
    settlementTieBreak: metrics.moneyTieBreak,
    settlementTieBreakUsed: metrics.tieBreakUsed,
  } as Battle;
}

function mergeMetricsPatch(current: BattleRealtimeMetrics | null, data: any): BattleRealtimeMetrics | null {
  if (!current && data?.battleId) {
    return normalizeBattleRealtimeMetrics({
      ...data,
      leaderSide: data.leaderSide ?? null,
      pointDifference: data.pointDifference ?? null,
      sides: data.sides || { left: null, right: null },
    });
  }
  if (!current) return null;
  if (data?.battleId && String(data.battleId) !== current.battleId) return current;
  const next: any = {
    ...current,
    scoringVersion: data?.scoringVersion || current.scoringVersion,
    settlementMode: data?.settlementMode || current.settlementMode,
    settlementVersion: data?.settlementVersion ?? current.settlementVersion,
    settlementScoringVersion: data?.settlementScoringVersion ?? current.settlementScoringVersion,
    moneyTieBreak: data?.moneyTieBreak ?? current.moneyTieBreak,
    tieBreakUsed: data?.tieBreakUsed ?? current.tieBreakUsed,
    finalBattlePoints: data?.finalBattlePoints ?? current.finalBattlePoints,
    settlementMetricsUpdatedAt: data?.settlementMetricsUpdatedAt ?? current.settlementMetricsUpdatedAt,
    metricsUpdatedAt: data?.metricsUpdatedAt || current.metricsUpdatedAt,
    dataHealth: data?.dataHealth || current.dataHealth,
    sides: data?.sides ? { ...current.sides, ...data.sides } : current.sides,
  };
  if (data?.leaderSide === "left" || data?.leaderSide === "right" || data?.leaderSide === "tied") {
    next.leaderSide = data.leaderSide;
  }
  if (data?.pointDifference !== undefined) next.pointDifference = data.pointDifference;
  if (data?.left && next.sides.left) next.sides.left = { ...next.sides.left, points: { ...next.sides.left.points, ...data.left } };
  if (data?.right && next.sides.right) next.sides.right = { ...next.sides.right, points: { ...next.sides.right.points, ...data.right } };
  return normalizeBattleRealtimeMetrics(next);
}

export function applyArenaBattleRealtimeEvent(
  battle: Battle | null,
  metrics: BattleRealtimeMetrics | null,
  name: string,
  data: any,
): { battle: Battle | null; metrics: BattleRealtimeMetrics | null; shouldRefetch: boolean } {
  if (!ARENA_BATTLE_REALTIME_EVENTS.has(name)) return { battle, metrics, shouldRefetch: false };
  if (data?.battleId && battle?.id && String(data.battleId) !== String(battle.id)) {
    return { battle, metrics, shouldRefetch: false };
  }
  if (name === "arena_battle_finished") {
    return { battle, metrics, shouldRefetch: true };
  }
  const nextMetrics = mergeMetricsPatch(metrics, data);
  return {
    battle: battle && nextMetrics ? decorateBattleWithRealtimeMetrics(battle, nextMetrics) : battle,
    metrics: nextMetrics,
    shouldRefetch: false,
  };
}

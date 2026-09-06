import { apiFetch } from "@/lib/apiBase";
import { normalizeBattleRealtimeMetrics, type BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import {
  authoritativeLeaderSide,
  normalizeAuthoritativeBattleResult,
} from "@/lib/arena/battleAuthoritativePresentation.mjs";

function authoritativeMetrics(metrics: any, authoritative: any) {
  if (!authoritative) return metrics;
  const left = authoritative.sides?.left;
  const right = authoritative.sides?.right;
  const healthy = authoritative.dataHealth?.healthy === true;
  const enrich = (side: any, resultSide: any) => {
    if (!side || !resultSide) return side;
    return {
      ...side,
      scoringVersion: authoritative.scoringVersion || side.scoringVersion,
      pointsReady: healthy && resultSide.totalPoints != null,
      eligibleBattleVolumeUsd: resultSide.volume?.eligibleUsd ?? side.eligibleBattleVolumeUsd,
      points: {
        ...side.points,
        marketCap: resultSide.mcap?.points ?? side.points?.marketCap,
        holders: resultSide.holders?.points ?? side.points?.holders,
        volume: resultSide.volume?.points ?? side.points?.volume,
        boost: authoritative.scoringGeneration === 3 ? resultSide.boost?.points ?? null : null,
        total: resultSide.totalPoints ?? side.points?.total,
        totalAuthoritative: resultSide.totalPoints != null,
        boostCurveVersion: resultSide.boost?.curveVersion ?? null,
        confirmedBoostUnits: resultSide.boost?.confirmedUnits == null ? null : String(resultSide.boost.confirmedUnits),
      },
    };
  };
  const leaderSide = authoritativeLeaderSide(authoritative);
  const leftTotal = Number(left?.totalPoints);
  const rightTotal = Number(right?.totalPoints);
  const pointDifference = Number.isFinite(leftTotal) && Number.isFinite(rightTotal)
    ? Math.abs(leftTotal - rightTotal)
    : null;
  return {
    ...metrics,
    scoringVersion: authoritative.scoringVersion || metrics?.scoringVersion,
    settlementMode: authoritative.scoringVersion || metrics?.settlementMode,
    leaderSide,
    pointDifference,
    dataHealth: authoritative.dataHealth,
    sides: {
      left: enrich(metrics?.sides?.left, left),
      right: enrich(metrics?.sides?.right, right),
    },
  };
}

export async function fetchArenaBattleMetrics(
  battleId: string,
  signal?: AbortSignal,
): Promise<BattleRealtimeMetrics | null> {
  const id = String(battleId || "").trim();
  if (!id) return null;
  const response = await apiFetch(`/api/arena/battle-metrics/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null);
  if (!json?.metrics) return null;
  const authoritativeResult = normalizeAuthoritativeBattleResult(json.authoritativeResult);
  const normalized = normalizeBattleRealtimeMetrics({
    ...authoritativeMetrics(json.metrics, authoritativeResult),
    settlementMode: json.settlementMode ?? json.metrics.settlementMode,
    settlementVersion: json.settlementVersion ?? null,
    settlementScoringVersion: json.settlementScoringVersion ?? null,
    moneyTieBreak: json.moneyTieBreak ?? null,
    tieBreakUsed: json.tieBreakUsed === true,
    finalBattlePoints: json.finalBattlePoints ?? null,
    settlementMetricsUpdatedAt: json.settlementMetricsUpdatedAt ?? null,
  });
  if (!normalized) return null;
  return {
    ...normalized,
    scoringVersion: authoritativeResult?.scoringVersion || json.scoringVersion || normalized.scoringVersion,
    scoringGeneration: authoritativeResult?.scoringGeneration ?? json.scoringGeneration ?? null,
    authoritativeResult,
    battleResult: authoritativeResult?.battleResult ?? null,
    moneyResult: authoritativeResult?.moneyResult ?? null,
  } as BattleRealtimeMetrics;
}

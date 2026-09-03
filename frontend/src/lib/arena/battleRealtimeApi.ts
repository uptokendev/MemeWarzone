import { apiFetch } from "@/lib/apiBase";
import { normalizeBattleRealtimeMetrics, type BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";

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
  return normalizeBattleRealtimeMetrics({
    ...json.metrics,
    settlementMode: json.settlementMode ?? json.metrics.settlementMode,
    settlementVersion: json.settlementVersion ?? null,
    settlementScoringVersion: json.settlementScoringVersion ?? null,
    moneyTieBreak: json.moneyTieBreak ?? null,
    tieBreakUsed: json.tieBreakUsed === true,
    finalBattlePoints: json.finalBattlePoints ?? null,
    settlementMetricsUpdatedAt: json.settlementMetricsUpdatedAt ?? null,
  });
}

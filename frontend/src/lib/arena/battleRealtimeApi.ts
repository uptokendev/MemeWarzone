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
  return normalizeBattleRealtimeMetrics(json?.metrics);
}

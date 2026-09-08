import { useEffect, useMemo, useState } from "react";
import type { Battle } from "@/features/postgrad/contracts";
import { fetchArenaBattleMetrics } from "@/lib/arena/battleRealtimeApi";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { selectFeedMetricBattleIds } from "@/lib/arena/arenaMatchRowPresentation.mjs";

const TTL_MS = 8_000;

const cache = new Map<string, { at: number; metrics: BattleRealtimeMetrics | null }>();
const inflight = new Map<string, Promise<BattleRealtimeMetrics | null>>();

function loadMetrics(battleId: string, signal: AbortSignal): Promise<BattleRealtimeMetrics | null> {
  const hit = cache.get(battleId);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.metrics);
  const pending = inflight.get(battleId);
  if (pending) return pending;

  const request = fetchArenaBattleMetrics(battleId, signal)
    .then((metrics) => {
      if (!signal.aborted) cache.set(battleId, { at: Date.now(), metrics });
      return metrics;
    })
    .catch((error) => {
      if (signal.aborted || error?.name === "AbortError") return null;
      if (!signal.aborted) cache.set(battleId, { at: Date.now(), metrics: null });
      return null;
    })
    .finally(() => {
      inflight.delete(battleId);
    });

  inflight.set(battleId, request);
  return request;
}

export function useArenaFeedBattleMetrics(battles: Battle[] | undefined) {
  const requestedIds = useMemo(() => selectFeedMetricBattleIds(battles || []), [battles]);
  const requestedKey = requestedIds.join("|");
  const [metricsById, setMetricsById] = useState<Record<string, BattleRealtimeMetrics | null>>({});
  const [loadedKey, setLoadedKey] = useState("");

  useEffect(() => {
    const ids = requestedKey ? requestedKey.split("|") : [];
    if (!ids.length) {
      setMetricsById({});
      setLoadedKey("");
      return;
    }
    const controller = new AbortController();
    setLoadedKey("");
    void Promise.all(ids.map(async (id) => [id, await loadMetrics(id, controller.signal)] as const)).then((entries) => {
      if (controller.signal.aborted) return;
      const next: Record<string, BattleRealtimeMetrics | null> = {};
      for (const [id, metrics] of entries) next[id] = metrics;
      setMetricsById(next);
      setLoadedKey(requestedKey);
    });
    return () => controller.abort();
  }, [requestedKey]);

  return {
    requestedIds,
    metricsById,
    loaded: loadedKey === requestedKey,
  };
}

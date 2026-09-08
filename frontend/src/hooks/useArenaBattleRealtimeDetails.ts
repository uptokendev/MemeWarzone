import { useCallback, useEffect, useRef, useState } from "react";
import type { Battle } from "@/features/postgrad/contracts";
import { fetchPostGradBattleDetails } from "@/features/postgrad/apiClient";
import { useArenaBattleDetails } from "@/hooks/useArenaBattleFeed";
import { useAblyBattleChannel } from "@/hooks/useAblyBattleChannel";
import {
  applyArenaBattleRealtimeEvent,
  decorateBattleWithRealtimeMetrics,
  type BattleRealtimeMetrics,
} from "@/lib/arena/battleRealtime";
import { fetchArenaBattleMetrics } from "@/lib/arena/battleRealtimeApi";

function isBattle(value: any): value is Battle {
  return Boolean(value?.id && value?.state && Array.isArray(value?.participants));
}

function timestamp(value: unknown) {
  const parsed = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function useArenaBattleRealtimeDetails(battleId?: string) {
  const base = useArenaBattleDetails(battleId);
  const [battle, setBattle] = useState<Battle | null>(base.battle);
  const [metrics, setMetrics] = useState<BattleRealtimeMetrics | null>(null);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [realtimeState, setRealtimeState] = useState<"idle" | "connecting" | "connected" | "disconnected" | "unavailable">("idle");
  const battleRef = useRef<Battle | null>(battle);
  const metricsRef = useRef<BattleRealtimeMetrics | null>(metrics);
  const connectedOnce = useRef(false);
  const requestGeneration = useRef(0);

  useEffect(() => {
    battleRef.current = battle;
  }, [battle]);
  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);
  useEffect(() => {
    if (base.battle) {
      battleRef.current = base.battle;
      setBattle((current) => current?.id === base.battle?.id ? current : base.battle);
    }
  }, [base.battle]);

  const reconcile = useCallback(async (signal?: AbortSignal) => {
    const id = String(battleId || "").trim();
    if (!id) {
      setMetrics(null);
      setSnapshotReady(false);
      return null;
    }
    const generation = ++requestGeneration.current;
    const [battleJson, metricSnapshot] = await Promise.all([
      fetchPostGradBattleDetails(id, signal).catch(() => null),
      fetchArenaBattleMetrics(id, signal).catch(() => null),
    ]);
    if (signal?.aborted || generation !== requestGeneration.current) return null;
    const candidate = battleJson?.battle ?? battleJson;
    const authoritativeBattle = isBattle(candidate) ? candidate : battleRef.current;
    const decorated = authoritativeBattle && metricSnapshot
      ? decorateBattleWithRealtimeMetrics(authoritativeBattle, metricSnapshot)
      : authoritativeBattle;
    battleRef.current = decorated || null;
    metricsRef.current = metricSnapshot;
    setBattle(decorated || null);
    setMetrics(metricSnapshot);
    setSnapshotReady(true);
    return { battle: decorated || null, metrics: metricSnapshot };
  }, [battleId]);

  useEffect(() => {
    const controller = new AbortController();
    connectedOnce.current = false;
    setSnapshotReady(false);
    setRealtimeState(battleId ? "connecting" : "idle");
    void reconcile(controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        console.warn("[useArenaBattleRealtimeDetails] initial reconciliation failed", error);
        setSnapshotReady(true);
      }
    });
    return () => controller.abort();
  }, [battleId, reconcile]);

  const realtime = useAblyBattleChannel({ enabled: Boolean(battleId && snapshotReady), battleId });

  useEffect(() => {
    if (!battleId || !snapshotReady) return;
    if (realtime.missingBase) {
      setRealtimeState("unavailable");
      return;
    }
    const { client, channel } = realtime;
    if (!client || !channel) {
      setRealtimeState("connecting");
      return;
    }

    const onMessage = (message: any) => {
      const name = String(message?.name || "");
      const data = message?.data || {};
      const currentMetricTs = timestamp(metricsRef.current?.metricsUpdatedAt);
      const incomingMetricTs = timestamp(data?.metricsUpdatedAt);
      if (currentMetricTs !== null && incomingMetricTs !== null && incomingMetricTs < currentMetricTs) return;

      const applied = applyArenaBattleRealtimeEvent(battleRef.current, metricsRef.current, name, data);
      if (applied.shouldRefetch) {
        void reconcile().catch((error) => console.warn("[useArenaBattleRealtimeDetails] finish reconciliation failed", error));
        return;
      }
      battleRef.current = applied.battle;
      metricsRef.current = applied.metrics;
      setBattle(applied.battle);
      setMetrics(applied.metrics);
    };

    const onConnected = () => {
      setRealtimeState("connected");
      if (connectedOnce.current) {
        // REST is authoritative after any disconnect/suspend gap. The channel
        // remains subscribed, but stale rewind patches are timestamp-gated.
        void reconcile().catch((error) => console.warn("[useArenaBattleRealtimeDetails] reconnect reconciliation failed", error));
      }
      connectedOnce.current = true;
    };
    const onDisconnected = () => setRealtimeState("disconnected");
    const onSuspended = () => setRealtimeState("disconnected");
    const onFailed = () => setRealtimeState("unavailable");

    channel.subscribe(onMessage);
    client.connection.on("connected", onConnected);
    client.connection.on("disconnected", onDisconnected);
    client.connection.on("suspended", onSuspended);
    client.connection.on("failed", onFailed);
    if (client.connection.state === "connected") onConnected();

    return () => {
      try {
        channel.unsubscribe(onMessage);
      } catch {
        // ignore
      }
      client.connection.off("connected", onConnected);
      client.connection.off("disconnected", onDisconnected);
      client.connection.off("suspended", onSuspended);
      client.connection.off("failed", onFailed);
    };
  }, [battleId, realtime.client, realtime.channel, realtime.missingBase, reconcile, snapshotReady]);

  return {
    ...base,
    loading: base.loading || !snapshotReady,
    battle: battle ?? base.battle,
    metrics,
    realtimeState,
    realtimeReady: realtime.ready,
    refresh: () => reconcile(),
  };
}

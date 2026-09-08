import { useArenaBattleRealtimeDetails } from "@/hooks/useArenaBattleRealtimeDetails";

export function useBattleWallRealtime(battleId: string | undefined, enabled: boolean) {
  const id = enabled && battleId ? String(battleId).trim() : undefined;
  const details = useArenaBattleRealtimeDetails(id);
  return {
    ...details,
    active: Boolean(id),
    snapshotReady: Boolean(id) && !details.loading,
  };
}

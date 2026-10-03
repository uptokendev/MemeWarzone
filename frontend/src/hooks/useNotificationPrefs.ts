import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";

/** The wallet's notification toggles (CO-5). Missing or unreadable = everything on. */
export function useNotificationPrefs(wallet?: string | null) {
  const w = String(wallet || "").trim();
  return useQuery({
    queryKey: ["notification-prefs", w],
    enabled: Boolean(w),
    staleTime: 60_000,
    retry: 0,
    queryFn: async () => {
      const res = await apiFetch(`/api/notification-prefs?wallet=${encodeURIComponent(w)}`);
      if (!res.ok) return null;
      const j = await res.json().catch(() => null);
      return (j?.prefs || null) as Record<string, { bell?: boolean; email?: boolean }> | null;
    },
  }).data ?? null;
}

export function bellAllowed(prefs: Record<string, { bell?: boolean }> | null, category: string) {
  return prefs?.[category]?.bell !== false;
}

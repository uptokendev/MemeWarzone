import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";

/** Portfolio display settings (founder, 2026-10-03). Both off = show every holding. */
export type DisplayPrefs = { hideNativeAndStables: boolean; hideSmall: boolean };
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { hideNativeAndStables: false, hideSmall: false };

export const displayPrefsKey = (wallet: string) => ["display-prefs", String(wallet || "")];

export async function fetchDisplayPrefs(wallet: string): Promise<{ supported: boolean; prefs: DisplayPrefs }> {
  const res = await apiFetch(`/api/display-prefs?wallet=${encodeURIComponent(wallet)}`);
  if (!res.ok) return { supported: false, prefs: DEFAULT_DISPLAY_PREFS };
  const j = await res.json().catch(() => null);
  return {
    supported: j?.supported === true,
    prefs: { hideNativeAndStables: j?.prefs?.hideNativeAndStables === true, hideSmall: j?.prefs?.hideSmall === true },
  };
}

export function useDisplayPrefs(wallet?: string | null) {
  const q = useQuery({
    queryKey: displayPrefsKey(String(wallet || "")),
    enabled: Boolean(wallet),
    staleTime: 60_000,
    queryFn: () => fetchDisplayPrefs(String(wallet)),
  });
  return { supported: q.data?.supported === true, prefs: q.data?.prefs || DEFAULT_DISPLAY_PREFS, loading: q.isLoading };
}

type Filterable = { kind?: string; native?: boolean; stable?: boolean; valueUsd?: number | null };

/** The owner's choices applied to a holdings list. Total value is never filtered, only lists. */
export function applyDisplayPrefs<T extends Filterable>(rows: T[], prefs: DisplayPrefs): T[] {
  return rows.filter((row) => {
    if (prefs.hideNativeAndStables && (row.kind === "native" || row.native || row.stable)) return false;
    if (prefs.hideSmall && !(Number(row.valueUsd) >= 1)) return false;
    return true;
  });
}

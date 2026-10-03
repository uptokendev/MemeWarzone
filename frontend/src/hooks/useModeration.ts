import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";
import { useFeedSession } from "@/hooks/useFeedSession";

export type HiddenItemType = "post" | "comment" | "coin_post" | "battle_comment";
type ModerationState = { supported: boolean; blocked: string[]; hidden: string[] };

/** Wallet key as the API stores it: EVM lowercased, Solana as-is. */
export function moderationKey(wallet?: string | null) {
  const w = String(wallet || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : w;
}

/**
 * Block and hide (CO-30, founder 2026-10-03): the connected wallet's blocked accounts and hidden
 * posts/comments. Only changes what this wallet sees; blocking never touches coin pages or trading.
 */
export function useModeration() {
  const { account, withSession } = useFeedSession();
  const queryClient = useQueryClient();
  const key = moderationKey(account);
  const queryKey = ["moderation", key];
  const state =
    useQuery({
      queryKey,
      enabled: Boolean(key),
      staleTime: 60_000,
      retry: 0,
      queryFn: async (): Promise<ModerationState> => {
        const res = await apiFetch(`/api/moderation?wallet=${encodeURIComponent(key)}`);
        if (!res.ok) return { supported: false, blocked: [], hidden: [] };
        const j = await res.json().catch(() => null);
        return { supported: j?.supported === true, blocked: Array.isArray(j?.blocked) ? j.blocked : [], hidden: Array.isArray(j?.hidden) ? j.hidden : [] };
      },
    }).data || { supported: false, blocked: [], hidden: [] };

  const blockedSet = new Set(state.blocked);
  const hiddenSet = new Set(state.hidden);

  const send = useCallback(
    async (body: Record<string, string>, optimistic: (s: ModerationState) => ModerationState) => {
      const previous = queryClient.getQueryData<ModerationState>(queryKey);
      if (previous) queryClient.setQueryData(queryKey, optimistic(previous));
      try {
        await withSession(async (token) => {
          const res = await apiFetch("/api/moderation", {
            method: "POST",
            headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          const j = await res.json().catch(() => null);
          if (!res.ok) {
            const err = new Error(j?.error || `Request failed (${res.status})`) as Error & { code?: string };
            if (j?.code) err.code = j.code;
            throw err;
          }
        });
      } catch (error) {
        if (previous) queryClient.setQueryData(queryKey, previous);
        throw error;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, withSession, key],
  );

  return {
    account,
    supported: state.supported,
    isBlocked: (wallet?: string | null) => Boolean(wallet) && blockedSet.has(moderationKey(wallet)),
    isHidden: (type: HiddenItemType, id?: string | number | null) => id != null && hiddenSet.has(`${type}:${id}`),
    blockedList: state.blocked,
    block: (wallet: string) => send({ action: "block", target: moderationKey(wallet) }, (s) => ({ ...s, blocked: [moderationKey(wallet), ...s.blocked] })),
    unblock: (wallet: string) => send({ action: "unblock", target: moderationKey(wallet) }, (s) => ({ ...s, blocked: s.blocked.filter((b) => b !== moderationKey(wallet)) })),
    hide: (type: HiddenItemType, id: string | number) => send({ action: "hide", itemType: type, itemId: String(id) }, (s) => ({ ...s, hidden: [`${type}:${id}`, ...s.hidden] })),
    unhide: (type: HiddenItemType, id: string | number) => send({ action: "unhide", itemType: type, itemId: String(id) }, (s) => ({ ...s, hidden: s.hidden.filter((h) => h !== `${type}:${id}`) })),
  };
}

/** Battle page data (UI redesign phase 4b): activity, supporters, boost totals, entries and comments. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { apiFetch } from "@/lib/apiBase";
import { fetchArenaStakeStatus } from "@/features/postgrad/apiClient";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type BattleActivityItem =
  | { id: string; kind: "boost"; at: string; side: "left" | "right"; wallet: string; units: number; amountNative: number }
  | { id: string; kind: "votes"; at: string; side: "left" | "right"; count: number; windowMinutes: number };
export type BattleSupporter = { rank: number; wallet: string; side: "left" | "right"; boosts: number; amountNative: number };
export type BattleBoostTotals = Record<"left" | "right" | "total", { boosts: number; grossNative: number; poolNative: number }>;
export type BattleComment = { id: string; at: string; wallet: string; body: string; side: "left" | "right" | null };

async function readJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(String(data?.error || `Request failed (${res.status})`)), { status: res.status, code: data?.code });
  return data;
}

const retry404 = (count: number, error: any) => error?.status !== 404 && count < 1;

export function useBattleActivity(battleId: string | null | undefined) {
  return useQuery({
    queryKey: ["battle-activity", battleId],
    enabled: Boolean(battleId),
    queryFn: async () =>
      (await readJson(await apiFetch(`/api/arena/battles/${encodeURIComponent(String(battleId))}/activity`, { cache: "no-store" }))) as {
        chainId: number;
        activity: BattleActivityItem[];
        supporters: BattleSupporter[];
        boosts: BattleBoostTotals;
      },
    refetchInterval: 20_000,
    retry: retry404,
    retryOnMount: false,
  });
}

export function useBattleComments(battleId: string | null | undefined) {
  return useQuery({
    queryKey: ["battle-comments", battleId],
    enabled: Boolean(battleId),
    queryFn: async () =>
      (await readJson(await apiFetch(`/api/arena/battles/${encodeURIComponent(String(battleId))}/comments`, { cache: "no-store" }))) as {
        comments: BattleComment[];
        unavailable?: boolean;
      },
    refetchInterval: 20_000,
    retry: retry404,
    retryOnMount: false,
  });
}

/** Paid entries for the pool breakdown (same read as the live prize pool on the card). */
export function useBattleEntries(battleId: string | null | undefined) {
  return useQuery({
    queryKey: ["battle-entries", battleId],
    enabled: Boolean(battleId),
    queryFn: () => fetchArenaStakeStatus(String(battleId)) as Promise<Record<string, unknown>>,
    refetchInterval: 20_000,
    retry: 1,
  });
}

/** Same normalisation as the server, so the signed text is the stored text. */
export function normalizeBattleCommentText(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function usePostBattleComment(battleId: string) {
  const client = useQueryClient();
  return useCallback(
    async (input: {
      text: string;
      chainId: number;
      walletAddress: string;
      sign: (action: string, lines: string[]) => Promise<WalletActionAuthPayload>;
      /** Feed session (one signature per 12 h): when given, the comment needs no signature of its own. */
      withSession?: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
    }) => {
      const text = normalizeBattleCommentText(input.text);
      const url = `/api/arena/battles/${encodeURIComponent(battleId)}/comments`;
      const data = input.withSession
        ? await input.withSession(async (token) =>
            readJson(
              await apiFetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ body: text }),
              }),
            ),
          )
        : await readJson(
            await apiFetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chainId: input.chainId,
                walletAddress: input.walletAddress,
                body: text,
                auth: await input.sign("arena_battle_comment", [`Battle: ${battleId}`, `Comment: ${text}`]),
              }),
            }),
          );
      await client.invalidateQueries({ queryKey: ["battle-comments", battleId] });
      return data.comment as BattleComment;
    },
    [battleId, client],
  );
}

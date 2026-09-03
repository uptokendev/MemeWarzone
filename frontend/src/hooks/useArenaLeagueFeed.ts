import { useEffect, useState } from "react";
import { postGradFlags } from "@/features/postgrad/config";
import { fetchPostGradLeagueFeed, mutatePostGradLeague, type PostGradLeagueAction } from "@/features/postgrad/apiClient";
import { useMockLeagueSeason } from "@/hooks/useMockLeagueRuntime";

export type ArenaLeagueFeedSource = "qa-runtime" | "api" | "empty";

export type ArenaLeagueSeason = ReturnType<typeof useMockLeagueSeason>["season"];
export type ArenaLeagueHistoryEntry = ReturnType<typeof useMockLeagueSeason>["history"][number];

type ArenaLeagueFeedPayload = {
  season: ArenaLeagueSeason;
  history: ArenaLeagueHistoryEntry[];
};

const SEASON_STATES = new Set(["preseason", "live", "playoffs", "quarter_finals", "completed"]);
const DIVISIONS = new Set(["bronze", "silver", "gold", "apex"]);
const MOVEMENTS = new Set(["promoted", "safe", "relegated"]);

function isLeagueEntry(value: any): boolean {
  return Boolean(
    (value?.tokenId || value?.tokenAddress) &&
      typeof value?.tokenName === "string" &&
      typeof value?.symbol === "string" &&
      Number.isFinite(Number(value?.points)) &&
      Number.isFinite(Number(value?.wins)) &&
      Number.isFinite(Number(value?.losses)),
  );
}

function normalizeSeason(value: any): ArenaLeagueSeason | null {
  if (!value || typeof value !== "object") return null;
  if (!value.id || !value.label || !SEASON_STATES.has(value.state)) return null;
  const entries = Array.isArray(value.entries) ? value.entries.filter(isLeagueEntry) : [];

  return {
    id: String(value.id),
    label: String(value.label),
    state: value.state,
    week: Number.isFinite(Number(value.week)) && Number(value.week) > 0 ? Number(value.week) : 1,
    rewardPoolUsd: Number.isFinite(Number(value.rewardPoolUsd)) ? Number(value.rewardPoolUsd) : 0,
    resetAt: String(value.resetAt || new Date().toISOString()),
    divisions: Array.isArray(value.divisions) ? value.divisions.filter((division: unknown) => DIVISIONS.has(String(division))) : [],
    quarterFinalsTournamentId: value.quarterFinalsTournamentId ? String(value.quarterFinalsTournamentId) : undefined,
    entries: entries.map((entry: any) => ({
      tokenId: String(entry.tokenId || entry.tokenAddress),
      tokenName: String(entry.tokenName),
      symbol: String(entry.symbol),
      imageUrl: entry.imageUrl || entry.logoUri || entry.logo_uri || undefined,
      division: DIVISIONS.has(entry.division) ? entry.division : "apex",
      points: Number(entry.points),
      wins: Number(entry.wins),
      losses: Number(entry.losses),
      finishedFights: Number.isFinite(Number(entry.finishedFights ?? entry.finished_fights))
        ? Number(entry.finishedFights ?? entry.finished_fights)
        : 0,
      streak: Number.isFinite(Number(entry.streak)) ? Number(entry.streak) : 0,
      movement: MOVEMENTS.has(entry.movement) ? entry.movement : "safe",
    })),
  } as ArenaLeagueSeason;
}

function normalizeHistory(value: unknown): ArenaLeagueHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry: any) => Boolean(entry?.seasonId && entry?.label && entry?.completedAt && entry?.topTokenName && entry?.topTokenSymbol))
    .map((entry: any) => ({
      seasonId: String(entry.seasonId),
      label: String(entry.label),
      completedAt: String(entry.completedAt),
      week: Number.isFinite(Number(entry.week)) ? Number(entry.week) : 1,
      rewardPoolUsd: Number.isFinite(Number(entry.rewardPoolUsd)) ? Number(entry.rewardPoolUsd) : 0,
      topTokenName: String(entry.topTokenName),
      topTokenSymbol: String(entry.topTokenSymbol),
    }));
}

async function loadLeagueFeed(signal?: AbortSignal): Promise<ArenaLeagueFeedPayload | null> {
  const json = await fetchPostGradLeagueFeed(signal);
  if (!json) return null;

  const season = normalizeSeason(json.season ?? json.currentSeason ?? json.items?.season);
  if (!season) return null;

  return {
    season,
    history: normalizeHistory(json.history ?? json.archive ?? json.items?.history),
  };
}

async function mutateLeague(action: PostGradLeagueAction): Promise<boolean> {
  return mutatePostGradLeague(action);
}

const EMPTY_SEASON: ArenaLeagueSeason = {
  id: "arena-league-empty",
  label: "Major War League",
  state: "live",
  week: 1,
  rewardPoolUsd: 0,
  resetAt: new Date(0).toISOString(),
  divisions: [],
  entries: [],
};

/**
 * Adapter boundary for Arena league surfaces.
 *
 * It attempts the API-shaped league feed first and only falls back to the QA
 * runtime when mock mode is explicitly enabled.
 */
export function useArenaLeagueFeed() {
  const runtime = useMockLeagueSeason();
  const allowMockFallback = postGradFlags.mocks;
  const [apiPayload, setApiPayload] = useState<ArenaLeagueFeedPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshFeed = async () => {
    const payload = await loadLeagueFeed().catch(() => null);
    setApiPayload(payload);
    return payload;
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    loadLeagueFeed(controller.signal)
      .then((payload) => {
        if (!cancelled) setApiPayload(payload);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaLeagueFeed] API feed unavailable", error);
        if (!cancelled) setApiPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime.season.id, runtime.season.week, runtime.history.length]);

  const advanceWeek = async () => {
    try {
      const advanced = await mutateLeague("advance-week");
      if (advanced) {
        await refreshFeed();
        return true;
      }
    } catch (error) {
      console.warn("[useArenaLeagueFeed] API advance week unavailable", error);
    }
    return allowMockFallback ? runtime.advanceLeagueWeek() : false;
  };

  const rebalanceDivisions = async () => {
    try {
      const rebalanced = await mutateLeague("rebalance-divisions");
      if (rebalanced) {
        await refreshFeed();
        return true;
      }
    } catch (error) {
      console.warn("[useArenaLeagueFeed] API rebalance unavailable", error);
    }
    return allowMockFallback ? runtime.rebalanceLeagueDivisions() : false;
  };

  const cycleSeasonState = async () => {
    try {
      const cycled = await mutateLeague("cycle-season-state");
      if (cycled) {
        await refreshFeed();
        return true;
      }
    } catch (error) {
      console.warn("[useArenaLeagueFeed] API season cycle unavailable", error);
    }
    return allowMockFallback ? runtime.cycleMockLeagueState() : false;
  };

  return {
    source: apiPayload ? "api" as ArenaLeagueFeedSource : allowMockFallback ? "qa-runtime" as ArenaLeagueFeedSource : "empty" as ArenaLeagueFeedSource,
    loading,
    season: apiPayload?.season ?? (allowMockFallback ? runtime.season : EMPTY_SEASON),
    history: apiPayload?.history ?? (allowMockFallback ? runtime.history : []),
    advanceWeek,
    cycleSeasonState,
    rebalanceDivisions,
    refreshFeed,
  };
}

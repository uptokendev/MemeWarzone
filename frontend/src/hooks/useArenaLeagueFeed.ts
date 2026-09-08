import { useEffect, useState } from "react";
import { postGradFlags } from "@/features/postgrad/config";
import { MOCK_LEAGUE_OWNED_TOKEN_IDS } from "@/features/postgrad/mockRegistry";
import { fetchPostGradLeagueFeed, mutatePostGradLeague, type PostGradLeagueAction } from "@/features/postgrad/apiClient";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useMockLeagueSeason } from "@/hooks/useMockLeagueRuntime";

export type ArenaLeagueFeedSource = "qa-runtime" | "api" | "empty";

export type ArenaLeagueSeason = ReturnType<typeof useMockLeagueSeason>["season"];
export type ArenaLeagueHistoryEntry = ReturnType<typeof useMockLeagueSeason>["history"][number];

export type ArenaQuarterlyChampionshipEntry = {
  tokenAddress: string;
  tokenName: string;
  symbol: string;
  rank: number;
  basePoints: number;
  mwlBonusPoints: number;
  totalPoints: number;
};

export type ArenaQuarterlyChampionship = {
  id: string;
  eventType: "quarterly_championship";
  chainId: number;
  year: number;
  quarter: number;
  state: "open" | "closed";
  opensAt: string | null;
  closesAt: string | null;
  closedAt: string | null;
  pendingBonusTransfers: number;
  bonusPolicyStatus: "not_authoritative" | null;
  entries: ArenaQuarterlyChampionshipEntry[];
};

type ArenaLeagueFeedPayload = {
  season: ArenaLeagueSeason;
  championship: ArenaQuarterlyChampionship | null;
  history: ArenaLeagueHistoryEntry[];
  owned: string[];
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
    frozenAt: value.frozenAt ? String(value.frozenAt) : value.frozen_at ? String(value.frozen_at) : null,
    regularSeasonClosed: value.regularSeasonClosed === true || value.regular_season_closed === true,
    quarterFinalsTournamentId: value.quarterFinalsTournamentId || value.quarter_finals_tournament_id
      ? String(value.quarterFinalsTournamentId || value.quarter_finals_tournament_id)
      : undefined,
    month: Number.isFinite(Number(value.month)) && Number(value.month) >= 1 && Number(value.month) <= 12 ? Number(value.month) : undefined,
    quarterlyChampionshipId: value.quarterlyChampionshipId || value.championship_epoch_id
      ? String(value.quarterlyChampionshipId || value.championship_epoch_id)
      : undefined,
    finalizedAt: value.finalizedAt || value.finalized_at ? String(value.finalizedAt || value.finalized_at) : null,
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
      rank: Number.isFinite(Number(entry.rank)) && Number(entry.rank) > 0 ? Number(entry.rank) : undefined,
      streak: Number.isFinite(Number(entry.streak)) ? Number(entry.streak) : 0,
      movement: MOVEMENTS.has(entry.movement) ? entry.movement : "safe",
    })),
  } as ArenaLeagueSeason;
}

function normalizeChampionship(value: any): ArenaQuarterlyChampionship | null {
  if (!value || typeof value !== "object") return null;
  if (!value.id || value.eventType !== "quarterly_championship") return null;
  if (!Number.isFinite(Number(value.chainId)) || !Number.isFinite(Number(value.year)) || !Number.isFinite(Number(value.quarter))) return null;
  if (value.state !== "open" && value.state !== "closed") return null;
  const entries = Array.isArray(value.entries)
    ? value.entries
        .filter((entry: any) => entry?.tokenAddress && Number.isFinite(Number(entry.rank)) && Number.isFinite(Number(entry.totalPoints)))
        .map((entry: any) => ({
          tokenAddress: String(entry.tokenAddress),
          tokenName: String(entry.tokenName || entry.symbol || "Unknown token"),
          symbol: String(entry.symbol || "---"),
          rank: Number(entry.rank),
          basePoints: Number(entry.basePoints || 0),
          mwlBonusPoints: Number(entry.mwlBonusPoints || 0),
          totalPoints: Number(entry.totalPoints || 0),
        }))
    : [];
  return {
    id: String(value.id),
    eventType: "quarterly_championship",
    chainId: Number(value.chainId),
    year: Number(value.year),
    quarter: Number(value.quarter),
    state: value.state,
    opensAt: value.opensAt ? String(value.opensAt) : null,
    closesAt: value.closesAt ? String(value.closesAt) : null,
    closedAt: value.closedAt ? String(value.closedAt) : null,
    pendingBonusTransfers: Number.isFinite(Number(value.pendingBonusTransfers)) ? Number(value.pendingBonusTransfers) : 0,
    bonusPolicyStatus: value.bonusPolicyStatus === "not_authoritative" ? "not_authoritative" : null,
    entries,
  };
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

async function loadLeagueFeed(
  signal?: AbortSignal,
  options?: { wallet?: string | null; chainId?: number | null },
): Promise<ArenaLeagueFeedPayload | null> {
  const json = await fetchPostGradLeagueFeed(signal, options);
  if (!json) return null;

  const season = normalizeSeason(json.season ?? json.currentSeason ?? json.items?.season);
  const championship = normalizeChampionship(json.championship ?? json.quarterlyChampionship ?? json.items?.championship);
  if (!season && !championship) return null;

  return {
    season: season || EMPTY_SEASON,
    championship,
    history: normalizeHistory(json.history ?? json.archive ?? json.items?.history),
    owned: Array.isArray(json.owned) ? json.owned.filter(isLeagueEntry).map((entry: any) => String(entry.tokenId || entry.tokenAddress)) : [],
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
  const wallet = useActiveFeedWallet();
  const allowMockFallback = postGradFlags.mocks;
  const [apiPayload, setApiPayload] = useState<ArenaLeagueFeedPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const walletAddress = String(wallet.address || "").trim();
  const chainId = Number(wallet.chainId || 0) || null;

  const refreshFeed = async () => {
    const payload = await loadLeagueFeed(undefined, { wallet: walletAddress || null, chainId }).catch(() => null);
    setApiPayload(payload);
    return payload;
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    loadLeagueFeed(controller.signal, { wallet: walletAddress || null, chainId })
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
  }, [runtime.season.id, runtime.season.week, runtime.history.length, walletAddress, chainId]);

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

  const source = apiPayload ? "api" as ArenaLeagueFeedSource : allowMockFallback ? "qa-runtime" as ArenaLeagueFeedSource : "empty" as ArenaLeagueFeedSource;
  return {
    source,
    loading,
    season: apiPayload?.season ?? (allowMockFallback ? runtime.season : EMPTY_SEASON),
    championship: apiPayload?.championship ?? null,
    history: apiPayload?.history ?? (allowMockFallback ? runtime.history : []),
    ownedTokenIds: apiPayload?.owned?.length
      ? apiPayload.owned
      : source === "qa-runtime"
        ? MOCK_LEAGUE_OWNED_TOKEN_IDS
        : [],
    advanceWeek,
    cycleSeasonState,
    rebalanceDivisions,
    refreshFeed,
  };
}

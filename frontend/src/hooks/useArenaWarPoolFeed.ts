import { useEffect, useState } from "react";
import type { WarPool } from "@/features/postgrad/contracts";
import { postGradFlags } from "@/features/postgrad/config";
import type { WarPoolSettlementSummary } from "@/features/postgrad/mockWarPoolRuntime";
import {
  fetchPostGradWarPool,
  fetchPostGradWarPoolSummary,
  supportPostGradWarPool,
  transitionPostGradWarPool,
} from "@/features/postgrad/apiClient";
import { useMockWarPool, useMockWarPoolSummary } from "@/hooks/useMockWarPoolRuntime";

export type ArenaWarPoolFeedSource = "qa-runtime" | "api" | "empty";

export type ArenaWarPoolState = WarPool["state"];
type WarPoolSummary = ReturnType<typeof useMockWarPoolSummary>["summary"];

export type ArenaWarPoolMeta = {
  kind?: "battle" | "tournament";
  configured?: boolean;
  live?: boolean;
  treasury?: string;
  onchainPoolId?: string;
  onchainOpened?: boolean;
  supportOpen?: boolean;
  redirectTournamentId?: string | null;
  nativeSymbol?: string;
  chainId?: number;
  sides?: Array<{ tokenId: string; ownerWallet?: string; eligible?: boolean }>;
};

type ArenaWarPoolPayload = {
  pool: WarPool;
  settlementSummary: WarPoolSettlementSummary | null;
  meta: ArenaWarPoolMeta;
};

type ArenaWarPoolSummaryPayload = WarPoolSummary;

const EMPTY_WAR_POOL_SUMMARY: WarPoolSummary = {
  pools: [],
  totalPotUsd: 0,
  openPools: 0,
  lockedPools: 0,
  paidPools: 0,
};

const WAR_POOL_STATES = new Set(["open", "locked", "settling", "paid"]);

function isWarPoolEntry(value: any): boolean {
  return Boolean(
    value?.battleId &&
      value?.sideTokenId &&
      Number.isFinite(Number(value?.amountUsd)) &&
      typeof value?.enteredAt === "string" &&
      typeof value?.payoutEligible === "boolean",
  );
}

function normalizeRouting(value: any, totalPotUsd: number): WarPool["routingBreakdown"] {
  const winnersUsd = Number(value?.winnersUsd);
  const protocolUsd = Number(value?.protocolUsd);
  const featuredUsd = Number(value?.featuredUsd);
  if (Number.isFinite(winnersUsd) && Number.isFinite(protocolUsd) && Number.isFinite(featuredUsd)) {
    return { winnersUsd, protocolUsd, featuredUsd };
  }

  return {
    winnersUsd: Math.round(totalPotUsd * 0.85),
    protocolUsd: Math.round(totalPotUsd * 0.05),
    featuredUsd: Math.round(totalPotUsd * 0.1),
  };
}

function normalizeWarPool(value: any): WarPool | null {
  if (!value || typeof value !== "object") return null;
  if (!value.battleId || !WAR_POOL_STATES.has(String(value.state))) return null;

  const entries = Array.isArray(value.entries)
    ? value.entries.filter(isWarPoolEntry).map((entry: any) => ({
        battleId: String(entry.battleId),
        sideTokenId: String(entry.sideTokenId),
        amountUsd: Number(entry.amountUsd),
        enteredAt: String(entry.enteredAt),
        payoutEligible: Boolean(entry.payoutEligible),
      }))
    : [];

  const totalPotUsd = Number.isFinite(Number(value.totalPotUsd))
    ? Number(value.totalPotUsd)
    : entries.reduce((total: number, entry: WarPool["entries"][number]) => total + entry.amountUsd, 0);

  return {
    battleId: String(value.battleId),
    state: value.state,
    totalPotUsd,
    cutoffAt: String(value.cutoffAt || new Date().toISOString()),
    routingBreakdown: normalizeRouting(value.routingBreakdown, totalPotUsd),
    entries,
  };
}

function normalizeSettlementSummary(value: any): WarPoolSettlementSummary | null {
  if (!value || typeof value !== "object") return null;
  const routingBreakdown = normalizeRouting(value.routingBreakdown, Number(value.totalPotUsd ?? 0));
  return {
    winnerTokenId: value.winnerTokenId ? String(value.winnerTokenId) : null,
    winnerLabel: String(value.winnerLabel ?? "No winner yet"),
    totalPotUsd: Number.isFinite(Number(value.totalPotUsd)) ? Number(value.totalPotUsd) : 0,
    winnerSideUsd: Number.isFinite(Number(value.winnerSideUsd)) ? Number(value.winnerSideUsd) : 0,
    loserSideUsd: Number.isFinite(Number(value.loserSideUsd)) ? Number(value.loserSideUsd) : 0,
    projectedPayoutMultiple: Number.isFinite(Number(value.projectedPayoutMultiple)) ? Number(value.projectedPayoutMultiple) : 0,
    projectedWinnerPayoutUsd: Number.isFinite(Number(value.projectedWinnerPayoutUsd)) ? Number(value.projectedWinnerPayoutUsd) : 0,
    projectedNetProfitUsd: Number.isFinite(Number(value.projectedNetProfitUsd)) ? Number(value.projectedNetProfitUsd) : 0,
    eligibleWinningEntries: Number.isFinite(Number(value.eligibleWinningEntries)) ? Number(value.eligibleWinningEntries) : 0,
    settlementStateLabel: String(value.settlementStateLabel ?? "Settlement preview"),
    settlementStateBody: String(value.settlementStateBody ?? "Settlement details will update as the pool advances."),
    routingBreakdown,
  };
}

function normalizeWarPoolSummary(value: any): WarPoolSummary | null {
  if (!value || typeof value !== "object") return null;
  const pools = Array.isArray(value.pools) ? value.pools.map(normalizeWarPool).filter(Boolean) as WarPool[] : [];
  return {
    pools,
    totalPotUsd: Number.isFinite(Number(value.totalPotUsd)) ? Number(value.totalPotUsd) : pools.reduce((total, pool) => total + pool.totalPotUsd, 0),
    openPools: Number.isFinite(Number(value.openPools)) ? Number(value.openPools) : pools.filter((pool) => pool.state === "open").length,
    lockedPools: Number.isFinite(Number(value.lockedPools)) ? Number(value.lockedPools) : pools.filter((pool) => pool.state === "locked" || pool.state === "settling").length,
    paidPools: Number.isFinite(Number(value.paidPools)) ? Number(value.paidPools) : pools.filter((pool) => pool.state === "paid").length,
  };
}

async function loadWarPool(battleId: string, signal?: AbortSignal): Promise<ArenaWarPoolPayload | null> {
  const json = await fetchPostGradWarPool(battleId, signal);
  if (!json) return null;
  const pool = normalizeWarPool(json.pool ?? json);
  if (!pool) return null;
  return {
    pool,
    settlementSummary: normalizeSettlementSummary(json.settlementSummary),
    meta: {
      kind: json.kind === "tournament" ? "tournament" : "battle",
      configured: Boolean(json.configured),
      live: json.live === true,
      treasury: json.treasury ? String(json.treasury) : "",
      onchainPoolId: json.onchainPoolId ? String(json.onchainPoolId) : "",
      onchainOpened: Boolean(json.onchainOpened),
      supportOpen: json.supportOpen !== false,
      redirectTournamentId: json.redirectTournamentId ? String(json.redirectTournamentId) : null,
      nativeSymbol: json.nativeSymbol ? String(json.nativeSymbol) : undefined,
      chainId: Number(json.chainId || 0) || undefined,
      sides: Array.isArray(json.sides) ? json.sides : [],
    },
  };
}

async function loadWarPoolSummary(signal?: AbortSignal): Promise<ArenaWarPoolSummaryPayload | null> {
  const json = await fetchPostGradWarPoolSummary(signal);
  if (!json) return null;
  return normalizeWarPoolSummary(json.summary ?? json);
}

/**
 * Adapter boundary for War Pool surfaces.
 *
 * It attempts API-shaped War Pool endpoints first and only falls back to the QA
 * runtime when mock mode is explicitly enabled.
 */
export function useArenaWarPool(battleId?: string | null) {
  const runtime = useMockWarPool(battleId);
  const allowMockFallback = postGradFlags.mocks;
  const [apiPayload, setApiPayload] = useState<ArenaWarPoolPayload | null>(null);
  const [loading, setLoading] = useState(Boolean(battleId));

  const refreshPool = async (battleIdToRefresh: string) => {
    const freshPayload = await loadWarPool(battleIdToRefresh).catch(() => null);
    setApiPayload(freshPayload);
    return freshPayload;
  };

  useEffect(() => {
    if (!battleId) {
      setApiPayload(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    loadWarPool(battleId, controller.signal)
      .then((payload) => {
        if (!cancelled) setApiPayload(payload);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaWarPool] API pool unavailable", error);
        if (!cancelled) setApiPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [battleId, runtime.pool?.state, runtime.pool?.entries.length]);

  const supportSide = async (battleIdToSupport: string, sideTokenId: string, amountUsd = 500) => {
    try {
      const supported = await supportPostGradWarPool(battleIdToSupport, sideTokenId, amountUsd);
      if (supported) {
        await refreshPool(battleIdToSupport);
        return true;
      }
    } catch (error) {
      console.warn("[useArenaWarPool] API support unavailable", error);
    }
    return allowMockFallback ? runtime.supportWarPoolSide(battleIdToSupport, sideTokenId, amountUsd) : false;
  };

  const transitionWarPool = async (battleIdToUpdate: string, state: ArenaWarPoolState) => {
    try {
      const transitioned = await transitionPostGradWarPool(battleIdToUpdate, state);
      if (transitioned) {
        await refreshPool(battleIdToUpdate);
        return true;
      }
    } catch (error) {
      console.warn("[useArenaWarPool] API transition unavailable", error);
    }
    return allowMockFallback ? runtime.transitionMockWarPool(battleIdToUpdate, state) : false;
  };

  return {
    source: apiPayload ? "api" as ArenaWarPoolFeedSource : allowMockFallback ? "qa-runtime" as ArenaWarPoolFeedSource : "empty" as ArenaWarPoolFeedSource,
    loading,
    pool: apiPayload?.pool ?? (allowMockFallback ? runtime.pool : null),
    meta: apiPayload?.meta ?? {},
    settlementSummary: apiPayload?.settlementSummary ?? (allowMockFallback ? runtime.settlementSummary : null),
    supportSide,
    transitionWarPool,
    refreshPool,
    resetWarPoolRuntime: runtime.resetMockWarPoolRuntime,
  };
}

export function useArenaWarPoolSummary() {
  const runtime = useMockWarPoolSummary();
  const allowMockFallback = postGradFlags.mocks;
  const [apiSummary, setApiSummary] = useState<ArenaWarPoolSummaryPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSummary = async () => {
    const summary = await loadWarPoolSummary().catch(() => null);
    setApiSummary(summary);
    return summary;
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    loadWarPoolSummary(controller.signal)
      .then((summary) => {
        if (!cancelled) setApiSummary(summary);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaWarPoolSummary] API summary unavailable", error);
        if (!cancelled) setApiSummary(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime.summary.totalPotUsd, runtime.summary.pools.length]);

  const transitionWarPool = async (battleId: string, state: ArenaWarPoolState) => {
    try {
      const transitioned = await transitionPostGradWarPool(battleId, state);
      if (transitioned) {
        await refreshSummary();
        return true;
      }
    } catch (error) {
      console.warn("[useArenaWarPoolSummary] API transition unavailable", error);
    }
    return false;
  };

  const hasApiData = apiSummary !== null;

  return {
    source: hasApiData ? "api" as ArenaWarPoolFeedSource : allowMockFallback ? "qa-runtime" as ArenaWarPoolFeedSource : "empty" as ArenaWarPoolFeedSource,
    loading,
    summary: apiSummary ?? (allowMockFallback ? runtime.summary : EMPTY_WAR_POOL_SUMMARY),
    refreshSummary,
    transitionWarPool,
    resetWarPoolRuntime: runtime.resetMockWarPoolRuntime,
  };
}

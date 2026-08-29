import { useEffect, useMemo, useState } from "react";
import type { Battle } from "@/features/postgrad/contracts";
import { postGradFlags } from "@/features/postgrad/config";
import {
  fetchPostGradBattleDetails,
  fetchPostGradBattleFeed,
  fetchPostGradCreatorBattleStatuses,
  openPostGradBattle,
} from "@/features/postgrad/apiClient";
import {
  useMockBattleDetails,
  useMockBattleLists,
} from "@/hooks/useMockBattleRuntime";

export type ArenaBattleFeedSource = "qa-runtime" | "api" | "empty";
export type CreatorBattleStatusState = "eligible" | Battle["state"] | "unavailable";
export type CreatorOpenForBattleState = "not_open" | "open" | "matched";

export type CreatorBattleStatus = {
  tokenId: string;
  campaignAddress: string;
  tokenAddress?: string | null;
  tokenName: string;
  symbol: string;
  origin?: string;
  eligibility: boolean;
  currentState: CreatorBattleStatusState;
  battleState?: Battle["state"] | null;
  battleId?: string | null;
  openForBattleState?: CreatorOpenForBattleState;
  unavailableReason?: string | null;
};

type ArchivedBattleEntry = ReturnType<typeof useMockBattleLists>["archivedBattles"][number];

type ArenaBattleFeedPayload = {
  liveBattles?: Battle[];
  openForBattleQueue?: Battle[];
  archivedBattles?: ArchivedBattleEntry[];
};

const SOLANA_CHAIN_ID = 101;

const CREATOR_BATTLE_STATES = new Set([
  "eligible",
  "waiting",
  "challenged",
  "matched",
  "live",
  "finished",
  "expired",
  "open_for_battle",
  "pending",
  "accepted",
  "completed",
  "settled",
  "unavailable",
]);

function isBattle(value: any): value is Battle {
  return Boolean(value?.id && value?.state && Array.isArray(value?.participants));
}

function normalizeBattleList(value: unknown): Battle[] {
  return Array.isArray(value) ? value.filter(isBattle) : [];
}

function normalizeArchivedBattleList(value: unknown): ArchivedBattleEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => isBattle((entry as any)?.battle) && typeof (entry as any)?.archivedAt === "string") as ArchivedBattleEntry[];
}

function isSolanaIdentity(value: string) {
  return value.length >= 32 && value.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

function normalizeIdentity(value: unknown) {
  const raw = String(value ?? "").trim();
  if (isSolanaIdentity(raw)) return raw;
  return raw.toLowerCase();
}

function isHexIdentity(value: string) {
  return /^0x[a-f0-9]{40}$/i.test(value);
}

function battleMatchesIdentity(battle: Battle, identity: string) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) return false;

  return battle.participants.some((participant: any) => {
    const participantIdentity = normalizeIdentity(participant?.tokenId);
    const campaignIdentity = normalizeIdentity(participant?.campaignAddress ?? participant?.campaign_address ?? participant?.campaign);
    const tokenIdentity = normalizeIdentity(participant?.tokenAddress ?? participant?.token_address ?? participant?.token);
    return participantIdentity === normalized || campaignIdentity === normalized || tokenIdentity === normalized;
  });
}

function normalizeCreatorBattleStatuses(value: unknown): CreatorBattleStatus[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry: any) => Boolean(entry?.tokenId || entry?.campaignAddress))
    .map((entry: any) => {
      const currentState = CREATOR_BATTLE_STATES.has(String(entry?.currentState)) ? String(entry.currentState) : "unavailable";
      return {
        tokenId: normalizeIdentity(entry?.tokenId ?? entry?.campaignAddress ?? ""),
        campaignAddress: normalizeIdentity(entry?.campaignAddress ?? entry?.tokenId ?? ""),
        tokenAddress: entry?.tokenAddress ? normalizeIdentity(entry.tokenAddress) : null,
        tokenName: String(entry?.tokenName ?? entry?.name ?? entry?.symbol ?? "Unknown token"),
        symbol: String(entry?.symbol ?? ""),
        origin: entry?.origin ? String(entry.origin) : undefined,
        eligibility: Boolean(entry?.eligibility),
        currentState: currentState as CreatorBattleStatusState,
        battleState: entry?.battleState ? String(entry.battleState) as Battle["state"] : null,
        battleId: entry?.battleId ? String(entry.battleId) : null,
        openForBattleState: entry?.openForBattleState === "open" || entry?.openForBattleState === "matched" ? entry.openForBattleState : "not_open",
        unavailableReason: entry?.unavailableReason ? String(entry.unavailableReason) : null,
      };
    });
}

async function loadBattleFeed(signal?: AbortSignal): Promise<ArenaBattleFeedPayload | null> {
  const json = await fetchPostGradBattleFeed(signal);
  if (!json) return null;

  const liveBattles = normalizeBattleList(json.liveBattles ?? json.live ?? json.items?.liveBattles);
  const openForBattleQueue = normalizeBattleList(json.openForBattleQueue ?? json.openForBattle ?? json.items?.openForBattleQueue);
  const archivedBattles = normalizeArchivedBattleList(json.archivedBattles ?? json.recentSettled ?? json.items?.archivedBattles);

  if (!liveBattles.length && !openForBattleQueue.length && !archivedBattles.length) return null;

  return { liveBattles, openForBattleQueue, archivedBattles };
}

async function loadCreatorBattleStatuses(creatorAddress: string, chainId?: number | null, signal?: AbortSignal): Promise<CreatorBattleStatus[] | null> {
  const normalized = normalizeIdentity(creatorAddress);
  if (!normalized) return null;
  const json = await fetchPostGradCreatorBattleStatuses(normalized, chainId, signal);
  if (!json) return [];
  return normalizeCreatorBattleStatuses(json.items ?? json.statuses ?? []);
}

async function loadBattleDetails(battleId: string, signal?: AbortSignal): Promise<Battle | null> {
  const json = await fetchPostGradBattleDetails(battleId, signal);
  const battle = json?.battle ?? json;
  return isBattle(battle) ? battle : null;
}

/**
 * Adapter boundary for Arena battle surfaces.
 *
 * User-facing code may read battle state and open owned coins for battle.
 * Platform/operator transitions are intentionally excluded from the launchpad bundle.
 */
export function useArenaBattleFeed(creatorAddress?: string | null, chainId?: number | null) {
  const runtime = useMockBattleLists();
  const allowMockFallback = postGradFlags.mocks;
  const normalizedCreatorAddress = normalizeIdentity(creatorAddress);
  const normalizedChainId = Number(chainId) || 97;
  const canLoadCreatorStatuses = Boolean(
    normalizedCreatorAddress && (!isSolanaIdentity(normalizedCreatorAddress) || normalizedChainId === SOLANA_CHAIN_ID)
  );
  const [apiPayload, setApiPayload] = useState<ArenaBattleFeedPayload | null>(null);
  const [creatorStatuses, setCreatorStatuses] = useState<CreatorBattleStatus[] | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshFeed = async () => {
    const [battlePayload, creatorPayload] = await Promise.all([
      loadBattleFeed().catch(() => null),
      canLoadCreatorStatuses ? loadCreatorBattleStatuses(normalizedCreatorAddress, normalizedChainId).catch(() => null) : Promise.resolve(null),
    ]);

    setApiPayload(battlePayload);
    setCreatorStatuses(creatorPayload);
    return { battlePayload, creatorPayload };
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    Promise.all([
      loadBattleFeed(controller.signal).catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaBattleFeed] API feed unavailable", error);
        return null;
      }),
      canLoadCreatorStatuses
        ? loadCreatorBattleStatuses(normalizedCreatorAddress, normalizedChainId, controller.signal).catch((error) => {
            if (!controller.signal.aborted) console.warn("[useArenaBattleFeed] creator status unavailable", error);
            return null;
          })
        : Promise.resolve(null),
    ])
      .then(([battlePayload, creatorPayload]) => {
        if (cancelled) return;
        setApiPayload(battlePayload);
        setCreatorStatuses(creatorPayload);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [normalizedCreatorAddress, normalizedChainId, canLoadCreatorStatuses, runtime.tick]);

  const liveBattles = apiPayload?.liveBattles ?? (allowMockFallback ? runtime.liveBattles : []);
  const openForBattleQueue = apiPayload?.openForBattleQueue ?? (allowMockFallback ? runtime.openForBattleQueue : []);
  const archivedBattles = apiPayload?.archivedBattles ?? (allowMockFallback ? runtime.archivedBattles : []);

  const getBattleForToken = useMemo(() => {
    if (!apiPayload && allowMockFallback) return runtime.getBattleForToken;
    const allBattles = [...liveBattles, ...openForBattleQueue, ...archivedBattles.map((entry) => entry.battle)];
    return (tokenId: string) => {
      const normalized = normalizeIdentity(tokenId);
      if (!normalized) return null;
      return allBattles.find((battle) => battleMatchesIdentity(battle, normalized)) ?? null;
    };
  }, [allowMockFallback, apiPayload, archivedBattles, liveBattles, openForBattleQueue, runtime.getBattleForToken]);

  const getCreatorCoinStatus = useMemo(() => {
    const statuses = creatorStatuses ?? [];
    return (tokenId: string) => {
      const normalized = normalizeIdentity(tokenId);
      if (!normalized) return null;
      return (
        statuses.find((status) => {
          return [status.tokenId, status.campaignAddress, status.tokenAddress].some((value) => normalizeIdentity(value) === normalized);
        }) ?? null
      );
    };
  }, [creatorStatuses]);

  const openCreatorCoinForBattle = async (tokenId: string, initialPotBnb?: number) => {
    try {
      const normalized = normalizeIdentity(tokenId);
      if (isSolanaIdentity(normalized) && normalizedChainId !== SOLANA_CHAIN_ID) return false;
      const opened = await openPostGradBattle({ tokenId, chainId: normalizedChainId, stakeNative: initialPotBnb, initialPotBnb });
      if (opened) {
        await refreshFeed();
        return true;
      }
    } catch (error) {
      console.warn("[useArenaBattleFeed] API open-for-battle unavailable", error);
    }

    const normalized = normalizeIdentity(tokenId);
    if (allowMockFallback && !isHexIdentity(normalized)) {
      return runtime.createMockOpenForBattle(tokenId);
    }

    return false;
  };

  const hasApiData = Boolean(apiPayload) || creatorStatuses !== null;

  return {
    source: hasApiData ? "api" as ArenaBattleFeedSource : allowMockFallback ? "qa-runtime" as ArenaBattleFeedSource : "empty" as ArenaBattleFeedSource,
    loading,
    liveBattles,
    openForBattleQueue,
    archivedBattles,
    creatorStatuses: creatorStatuses ?? [],
    getBattleForToken,
    getCreatorCoinStatus,
    openCreatorCoinForBattle,
    refreshFeed,
    tick: runtime.tick,
  };
}

export function useArenaBattleDetails(battleId?: string) {
  const runtime = useMockBattleDetails(battleId);
  const allowMockFallback = postGradFlags.mocks;
  const [apiBattle, setApiBattle] = useState<Battle | null>(null);
  const [loading, setLoading] = useState(Boolean(battleId));

  useEffect(() => {
    if (!battleId) {
      setApiBattle(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    loadBattleDetails(battleId, controller.signal)
      .then((battle) => {
        if (!cancelled) setApiBattle(battle);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaBattleDetails] API detail unavailable", error);
        if (!cancelled) setApiBattle(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [battleId]);

  return {
    source: apiBattle ? "api" as ArenaBattleFeedSource : allowMockFallback ? "qa-runtime" as ArenaBattleFeedSource : "empty" as ArenaBattleFeedSource,
    loading,
    battle: apiBattle ?? (allowMockFallback ? runtime.battle : null),
  };
}

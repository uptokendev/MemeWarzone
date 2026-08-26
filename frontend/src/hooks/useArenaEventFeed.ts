import { useEffect, useState } from "react";
import type { EventCardContract, TournamentBracketStage } from "@/features/postgrad/contracts";
import { postGradFlags } from "@/features/postgrad/config";
import {
  fetchPostGradEventDetails,
  fetchPostGradEventFeed,
  fetchPostGradTournamentDetails,
  fetchPostGradTournamentFeed,
} from "@/features/postgrad/apiClient";
import { useMockEvents, useMockEventDetails } from "@/hooks/useMockEventRuntime";

export type ArenaEventFeedSource = "qa-runtime" | "api" | "empty";

export type ArenaEventSummary = EventCardContract & {
  bracketStage?: TournamentBracketStage;
};

export type ArenaArchivedEvent = ArenaEventSummary & {
  completedAt: string;
};

type ArenaEventFeedPayload = {
  events: ArenaEventSummary[];
  archivedEvents: ArenaArchivedEvent[];
};

const EVENT_STATUSES = new Set(["scheduled", "deploying", "live", "completed"]);
const EVENT_TYPES = new Set(["battle_weekend", "battle_night", "featured_rivalry", "tournament", "seasonal_league"]);
const BRACKET_STAGES = new Set(["registration", "quarterfinals", "semifinals", "finals", "completed"]);

function isEventSummary(value: any): value is ArenaEventSummary {
  return Boolean(
    value?.id &&
      EVENT_TYPES.has(value?.type) &&
      EVENT_STATUSES.has(value?.status) &&
      typeof value?.title === "string" &&
      typeof value?.startsAt === "string" &&
      typeof value?.endsAt === "string" &&
      Number.isFinite(Number(value?.participantCount)),
  );
}

function normalizeEventList(value: unknown): ArenaEventSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isEventSummary)
    .map((event) => ({
      ...event,
      participantCount: Number(event.participantCount),
      summary: String(event.summary ?? ""),
      bracketStage: BRACKET_STAGES.has((event as any).bracketStage) ? (event as any).bracketStage : undefined,
    }));
}

function normalizeArchivedEventList(value: unknown): ArenaArchivedEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry: any) => isEventSummary(entry) && typeof entry.completedAt === "string")
    .map((entry: any) => ({
      ...entry,
      participantCount: Number(entry.participantCount),
      summary: String(entry.summary ?? ""),
      bracketStage: BRACKET_STAGES.has(entry.bracketStage) ? entry.bracketStage : undefined,
      completedAt: String(entry.completedAt),
    }));
}

async function loadEventFeed(signal?: AbortSignal): Promise<ArenaEventFeedPayload | null> {
  const json = await fetchPostGradEventFeed(signal);
  const tournamentJson = await fetchPostGradTournamentFeed(signal);

  const events = [
    ...normalizeEventList(json?.events ?? json?.items?.events ?? json?.items),
    ...normalizeEventList(tournamentJson?.events),
  ];
  const archivedEvents = [
    ...normalizeArchivedEventList(json?.archivedEvents ?? json?.archive ?? json?.items?.archivedEvents),
    ...normalizeArchivedEventList(tournamentJson?.archivedEvents),
  ];

  if (!events.length && !archivedEvents.length) return null;
  return { events, archivedEvents };
}

async function loadEventDetails(eventId: string, signal?: AbortSignal): Promise<ArenaEventSummary | null> {
  const json = await fetchPostGradEventDetails(eventId, signal);
  const event = json?.event ?? json;
  if (isEventSummary(event)) return event;
  const tournamentJson = await fetchPostGradTournamentDetails(eventId, signal);
  const tournament = tournamentJson?.event ?? tournamentJson;
  return isEventSummary(tournament) ? tournament : null;
}

/**
 * Adapter boundary for Arena event surfaces.
 *
 * User-facing code may read events only. Platform/operator event transitions
 * and bracket advancement belong exclusively in web-dashboard.
 */
export function useArenaEventFeed() {
  const runtime = useMockEvents();
  const allowMockFallback = postGradFlags.mocks;
  const [apiPayload, setApiPayload] = useState<ArenaEventFeedPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshFeed = async () => {
    const payload = await loadEventFeed().catch(() => null);
    setApiPayload(payload);
    return payload;
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    loadEventFeed(controller.signal)
      .then((payload) => {
        if (!cancelled) setApiPayload(payload);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaEventFeed] API feed unavailable", error);
        if (!cancelled) setApiPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime.events.length, runtime.archivedEvents.length]);

  return {
    source: apiPayload ? "api" as ArenaEventFeedSource : allowMockFallback ? "qa-runtime" as ArenaEventFeedSource : "empty" as ArenaEventFeedSource,
    loading,
    events: apiPayload?.events ?? (allowMockFallback ? runtime.events : []),
    archivedEvents: apiPayload?.archivedEvents ?? (allowMockFallback ? runtime.archivedEvents : []),
    refreshFeed,
  };
}

export function useArenaEventDetails(eventId?: string) {
  const runtime = useMockEventDetails(eventId);
  const allowMockFallback = postGradFlags.mocks;
  const [apiEvent, setApiEvent] = useState<ArenaEventSummary | null>(null);
  const [loading, setLoading] = useState(Boolean(eventId));

  const refreshEvent = async (eventIdToRefresh: string) => {
    const freshEvent = await loadEventDetails(eventIdToRefresh).catch(() => null);
    setApiEvent(freshEvent);
    return freshEvent;
  };

  useEffect(() => {
    if (!eventId) {
      setApiEvent(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    loadEventDetails(eventId, controller.signal)
      .then((event) => {
        if (!cancelled) setApiEvent(event);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("[useArenaEventDetails] API detail unavailable", error);
        if (!cancelled) setApiEvent(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [eventId]);

  return {
    source: apiEvent ? "api" as ArenaEventFeedSource : allowMockFallback ? "qa-runtime" as ArenaEventFeedSource : "empty" as ArenaEventFeedSource,
    loading,
    event: apiEvent ?? (allowMockFallback ? runtime.event : null),
    refreshEvent,
  };
}

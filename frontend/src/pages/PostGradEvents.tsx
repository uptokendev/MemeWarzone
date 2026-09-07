import { Link } from "react-router-dom";
import { EventSponsorAttribution } from "@/components/arena/EventSponsorAttribution";
import { ArenaCampaignRail } from "@/components/postgrad/ArenaCampaignRailCard";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { getPostGradWarRoomSearchRoute } from "@/features/postgrad/identityRoutes";
import { useArenaCampaignFeed } from "@/hooks/useArenaCampaignFeed";
import type { ArenaEventSummary } from "@/hooks/useArenaEventFeed";
import { useArenaEventFeed } from "@/hooks/useArenaEventFeed";
import { tournamentSponsorEventType, useEventSponsors } from "@/hooks/useEventSponsors";
import { isQuarterlyChampionshipRuntime, QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME } from "@/lib/arena/quarterlyChampionshipPresentation.mjs";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState, useEffect, useMemo } from "react";
import { useLaunchpad } from "@/lib/launchpadClient";
import { resolveImageUri } from "@/lib/media";

const bracketLabels = {
  registration: "Registration",
  quarterfinals: "Quarterfinals",
  semifinals: "Semifinals",
  finals: "Finals",
  completed: "Completed",
};

const eventTypeLabels = {
  battle_weekend: "Battle weekend",
  battle_night: "Battle night",
  featured_rivalry: "Featured rivalry",
  tournament: "Tournament",
  seasonal_league: "Seasonal league",
};

type ArenaEventWithRuntimeIdentity = ArenaEventSummary & {
  origin?: string;
  chainId?: number;
  eventType?: string;
};

function formatWhen(value: string) {
  return new Date(value).toLocaleDateString();
}

function quarterlyEvent(event?: ArenaEventSummary | null) {
  return Boolean(event && isQuarterlyChampionshipRuntime(event as ArenaEventWithRuntimeIdentity));
}

function publicEventTitle(event?: ArenaEventSummary | null) {
  if (!event) return "";
  return quarterlyEvent(event) ? QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME : event.title;
}

function EventSurfaceCard({ event }: { event: ArenaEventSummary }) {
  const runtimeEvent = event as ArenaEventWithRuntimeIdentity;
  const quarterly = quarterlyEvent(event);
  const bracketLabel = !quarterly && event.type === "tournament" && event.bracketStage ? bracketLabels[event.bracketStage] : null;
  const tone = event.status === "live" ? "success" : event.type === "tournament" ? "sponsored" : "default";
  const sponsors = useEventSponsors({
    eventType: quarterly ? "quarterly_championship" : tournamentSponsorEventType(runtimeEvent as Record<string, unknown>),
    eventReferenceId: event.id,
    chainId: Number(runtimeEvent.chainId || 0) || null,
    enabled: event.type === "tournament",
  });

  return (
    <div className="mwz-hud-frame p-4" data-quarterly-championship={quarterly ? "true" : undefined}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <TacticalTag label={quarterly ? QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME : eventTypeLabels[event.type]} tone={event.type === "tournament" ? "sponsored" : "default"} />
            <TacticalTag label={event.status} tone={tone} />
            {bracketLabel ? <TacticalTag label={bracketLabel} tone="hot" /> : null}
          </div>
          <div className="mt-3 font-retro text-lg text-foreground">{publicEventTitle(event)}</div>
          <EventSponsorAttribution sponsors={sponsors} variant={quarterly ? "premium" : "compact"} />
          <div className="mt-2 text-sm text-muted-foreground">{event.summary}</div>
          <div className="mt-3 text-xs text-muted-foreground/80">
            {event.participantCount} participants · Starts {formatWhen(event.startsAt)} · Ends {formatWhen(event.endsAt)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {event.type === "tournament" ? (
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to={`/tournament/${event.id}`}>{quarterly ? "View championship" : "Open bracket"}</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ArchivedEventSurfaceCard({ event }: { event: ArenaEventSummary & { completedAt: string } }) {
  const runtimeEvent = event as ArenaEventWithRuntimeIdentity & { completedAt: string };
  const quarterly = quarterlyEvent(event);
  const sponsors = useEventSponsors({
    eventType: quarterly ? "quarterly_championship" : tournamentSponsorEventType(runtimeEvent as Record<string, unknown>),
    eventReferenceId: event.id,
    chainId: Number(runtimeEvent.chainId || 0) || null,
    enabled: event.type === "tournament",
  });

  return (
    <div className="mwz-hud-frame p-4" data-quarterly-championship={quarterly ? "true" : undefined}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-retro text-sm text-foreground">{publicEventTitle(event)}</div>
            <TacticalTag label={quarterly ? QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME : eventTypeLabels[event.type]} tone="sponsored" />
          </div>
          <EventSponsorAttribution sponsors={sponsors} variant={quarterly ? "premium" : "compact"} />
          <div className="mt-2 text-xs text-muted-foreground/80">
            Completed {new Date(event.completedAt).toLocaleString()} · {event.participantCount} participants
          </div>
          <div className="mt-2 text-sm text-muted-foreground">{event.summary}</div>
        </div>
        {event.type === "tournament" ? (
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to={`/tournament/${event.id}`}>{quarterly ? "View championship results" : "Open bracket"}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const PostGradEvents = () => {
  const { events, archivedEvents, source: eventSource } = useArenaEventFeed();
  const { railItems: eventEntrants, hasRealCampaigns, loading: eventEntrantsLoading, source: campaignSource } = useArenaCampaignFeed(10);

  const liveEvents = events.filter((event) => event.status === "live");
  const upcomingEvents = events.filter((event) => event.status === "scheduled" || event.status === "deploying");
  const tournaments = events.filter((event) => event.type === "tournament");
  const trackedTournament = tournaments[0] || null;
  const trackedQuarterly = quarterlyEvent(trackedTournament);
  const eventEntrantFeedLabel = hasRealCampaigns ? "Live data" : eventEntrantsLoading ? "Loading" : campaignSource === "empty" ? "Data unavailable" : "Awaiting data";

  const eventRailRef = useRef<HTMLDivElement | null>(null);

  const scrollBy = (ref: React.RefObject<HTMLDivElement>, dir: "left" | "right") => {
    const el = ref.current;
    if (!el) return;
    const amount = Math.max(320, Math.floor(el.clientWidth * 0.85));
    el.scrollBy({ left: dir === "left" ? -amount : amount, behavior: "smooth" });
  };

  const [logoCache, setLogoCache] = useState<Record<string, string>>({});
  const { fetchCampaignLogoURI } = useLaunchpad();

  useEffect(() => {
    let cancelled = false;
    const missing = (eventEntrants || [])
      .map((c: any) => (c.campaignAddress || c.id || "").toLowerCase())
      .filter((addr: string): addr is string => !!addr && !logoCache[addr]);

    if (!missing.length) return;

    (async () => {
      try {
        const pairs = await Promise.all(
          missing.map(async (addr) => [addr, await fetchCampaignLogoURI(addr).catch(() => null)] as const)
        );
        if (cancelled) return;
        setLogoCache((prev) => {
          const next = { ...prev };
          for (const [addr, uri] of pairs) {
            if (uri) next[addr] = uri;
          }
          return next;
        });
      } catch {}
    })();

    return () => { cancelled = true; };
  }, [eventEntrants, logoCache, fetchCampaignLogoURI]);

  const hydratedEventEntrants = useMemo(() => {
    return (eventEntrants || []).map((c: any) => {
      const addr = (c.campaignAddress || c.id || "").toLowerCase();
      const hydrated = addr && logoCache[addr] ? logoCache[addr] : c.imageUrl;
      return {
        ...c,
        imageUrl: resolveImageUri(hydrated) || c.imageUrl || "/placeholder.svg",
      };
    });
  }, [eventEntrants, logoCache]);

  return (
    <>
      <div className="mt-14 space-y-4 pl-1 pr-8 pb-10">
        <section className="mwz-hud-frame p-5 md:p-7">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="text-[10px] uppercase tracking-[0.32em] text-accent/80">Events</div>
              <h1 className="mt-2 font-retro text-3xl tracking-tight text-foreground md:text-5xl">See live events, upcoming tournaments, and past results.</h1>
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">Track what is live, what is coming up next, which tournaments need attention, and what already completed in the Arena cycle.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <TacticalTag label={`${liveEvents.length} live`} tone="success" />
              <TacticalTag label={`${upcomingEvents.length} upcoming`} tone="default" />
              <TacticalTag label={`${archivedEvents.length} archived`} tone="sponsored" />
              <TacticalTag label={`${hasRealCampaigns ? eventEntrants.length : 0} entrants`} tone="hot" />
            </div>
          </div>
        </section>
      </div>

      <ContentContainer className="-mt-8 space-y-4 px-1 pb-10">
      <section className="grid gap-4 xl:grid-cols-3">
        <div className="mwz-hud-frame p-4">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Live now</div>
          <div className="mt-2 font-retro text-lg text-foreground">{liveEvents[0] ? publicEventTitle(liveEvents[0]) : "No live event"}</div>
          <div className="mt-1 text-sm text-muted-foreground">{liveEvents[0] ? `${liveEvents[0].participantCount} participants in motion` : eventSource === "empty" ? "Live event data isn’t available right now." : "The next event will appear here when it goes live."}</div>
        </div>
        <div className="mwz-hud-frame p-4">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Next up</div>
          <div className="mt-2 font-retro text-lg text-foreground">{upcomingEvents[0] ? publicEventTitle(upcomingEvents[0]) : "No scheduled event"}</div>
          <div className="mt-1 text-sm text-muted-foreground">{upcomingEvents[0] ? `Starts ${formatWhen(upcomingEvents[0].startsAt)}` : eventSource === "empty" ? "Upcoming event data isn’t available right now." : "The schedule is clear right now."}</div>
        </div>
        <div className="mwz-hud-frame p-4">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Tournament tracker</div>
          <div className="mt-2 font-retro text-lg text-foreground">{trackedTournament ? publicEventTitle(trackedTournament) : "No tournament scheduled"}</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {trackedQuarterly
              ? "Quarterly standings remain live through the epoch."
              : trackedTournament?.bracketStage
                ? `Current stage: ${bracketLabels[trackedTournament.bracketStage]}`
                : eventSource === "empty"
                  ? "Tournament event data isn’t available right now."
                  : "Bracket updates appear here when available."}
          </div>
        </div>
      </section>

      <section className="mwz-hud-frame p-5 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Featured coins in this event</div>
            <h2 className="mt-1 font-retro text-2xl text-foreground">Coins featured in this event</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">When live data is available it appears here, so event planning can be viewed against the current lineup.</p>
          </div>
          <div className="flex items-center gap-2">
            <TacticalTag label={eventEntrantFeedLabel} tone="success" />
            <Button variant="ghost" size="sm" className="mwz-button hidden md:inline-flex !h-7 !w-6 !min-h-0 !min-w-0 !p-0" onClick={() => scrollBy(eventRailRef, "left")}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" className="mwz-button hidden md:inline-flex !h-7 !w-6 !min-h-0 !min-w-0 !p-0" onClick={() => scrollBy(eventRailRef, "right")}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div ref={eventRailRef} className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory scroll-smooth" style={{ scrollbarWidth: "none" } as React.CSSProperties}>
          <ArenaCampaignRail
            items={hydratedEventEntrants}
            rankTone="hot"
            loading={eventEntrantsLoading}
            emptyLabel={campaignSource === "empty" ? "Event coin data isn’t available right now." : "Event coins will appear here when live data is available."}
            actionBuilder={(item) => [
              { label: "Token details", href: item.href },
              { label: "Trade War Room", href: getPostGradWarRoomSearchRoute(item.symbol || item.title) },
            ]}
            scrollRef={eventRailRef}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Live events</div>
            <div className="mt-1 font-retro text-xl text-foreground">Events already in motion</div>
          </div>
          <TacticalTag label={`${liveEvents.length} active`} tone="success" />
        </div>
        <div className="space-y-3">
          {liveEvents.length ? (
            liveEvents.map((event) => <EventSurfaceCard key={event.id} event={event} />)
          ) : (
            <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
              {eventSource === "empty" ? "Live event data isn’t available right now." : "No event is live right now."}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Upcoming</div>
            <div className="mt-1 font-retro text-xl text-foreground">Coming up</div>
          </div>
          <TacticalTag label={`${upcomingEvents.length} scheduled`} tone="default" />
        </div>
        <div className="space-y-3">
          {upcomingEvents.length ? (
            upcomingEvents.map((event) => <EventSurfaceCard key={event.id} event={event} />)
          ) : (
            <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
              {eventSource === "empty" ? "Upcoming event data isn’t available right now." : "No scheduled events are waiting in the queue."}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Tournament tracker</div>
            <div className="mt-1 font-retro text-xl text-foreground">Tournaments</div>
          </div>
          <TacticalTag label={`${tournaments.length} shown`} tone="sponsored" />
        </div>
        <div className="space-y-3">
          {tournaments.length ? (
            tournaments.map((event) => <EventSurfaceCard key={event.id} event={event} />)
          ) : (
            <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
              {eventSource === "empty" ? "Tournament event data isn’t available right now." : "No tournament event is currently shown."}
            </div>
          )}
        </div>
      </section>

      <section className="mwz-hud-frame p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Past events</div>
            <div className="mt-1 font-retro text-xl text-foreground">Past event results</div>
          </div>
          <TacticalTag label={`${archivedEvents.length} saved`} tone="sponsored" />
        </div>
        <div className="mt-4 space-y-3">
          {archivedEvents.length ? (
            archivedEvents.map((event) => <ArchivedEventSurfaceCard key={`${event.id}-${event.completedAt}`} event={event} />)
          ) : (
            <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
              {eventSource === "empty" ? "Archived event data isn’t available right now." : "Completed events will appear here after they wrap."}
            </div>
          )}
        </div>
      </section>
      </ContentContainer>
    </>
  );
};

export default PostGradEvents;

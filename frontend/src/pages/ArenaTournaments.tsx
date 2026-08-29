import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useArenaEventFeed, type ArenaEventSummary } from "@/hooks/useArenaEventFeed";

type TournamentTab = "upcoming" | "live" | "results";

const TABS: Array<{ key: TournamentTab; label: string }> = [
  { key: "upcoming", label: "Upcoming" },
  { key: "live", label: "Live" },
  { key: "results", label: "Results" },
];

function isTournament(event: ArenaEventSummary) {
  return event.type === "tournament" || event.type === "seasonal_league";
}

const ArenaTournaments = () => {
  const { events, archivedEvents, source } = useArenaEventFeed();
  const [tab, setTab] = useState<TournamentTab>("upcoming");

  const rows = useMemo(() => {
    const live = events.filter((event) => isTournament(event) && event.status === "live");
    const upcoming = events.filter((event) => isTournament(event) && (event.status === "scheduled" || event.status === "deploying"));
    const results = archivedEvents.filter((event) => isTournament(event) || event.status === "completed");
    if (tab === "live") return live;
    if (tab === "results") return results;
    return upcoming;
  }, [archivedEvents, events, tab]);

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Warzone</div>
            <h1 className="mt-1 font-retro text-2xl text-foreground">Tournaments</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Upcoming opt-ins, running events, and previous results. Standings live on the tournament page.
            </p>
          </div>
          <TacticalTag label={source === "api" ? "Live data" : source === "empty" ? "Feed unavailable" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
        </div>
        <div className="mt-4 inline-flex flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${tab === item.key ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        {rows.length ? (
          rows.map((event) => (
            <Link
              key={event.id}
              to={`/warzone/tournament/${encodeURIComponent(event.id)}`}
              className="mwz-hud-frame flex flex-col gap-2 p-4 transition hover:border-accent/50 hover:bg-accent/5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <TacticalTag label={tab === "live" ? "Live" : tab === "results" ? "Finished" : "Upcoming"} tone={tab === "live" ? "success" : "default"} />
                </div>
                <div className="mt-2 font-retro text-sm text-foreground">{event.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {event.participantCount} coins · {tab === "upcoming" ? `Starts ${new Date(event.startsAt).toLocaleString()}` : `Ends ${new Date(event.endsAt).toLocaleString()}`}
                </div>
              </div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
                {tab === "upcoming" ? "View / opt in" : "Open"}
              </div>
            </Link>
          ))
        ) : (
          <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
            {source === "empty"
              ? "Tournament data is not available right now."
              : tab === "upcoming"
                ? "No upcoming tournaments. Ops create them in the web dashboard."
                : tab === "live"
                  ? "No tournaments are running."
                  : "Finished tournaments will appear here."}
          </div>
        )}
      </section>
    </ContentContainer>
  );
};

export default ArenaTournaments;

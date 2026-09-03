import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TournamentDetailsModal } from "@/components/arena/TournamentDetailsModal";
import { TournamentEventCard } from "@/components/arena/TournamentEventCard";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzonePageHeader } from "@/components/warzone/WarzonePageHeader";
import { useArenaEventFeed, type ArenaEventSummary } from "@/hooks/useArenaEventFeed";
import { presentTournamentEmpty } from "@/lib/arena/tournamentCommandPresentation.mjs";

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
  const { tournamentId } = useParams();
  const navigate = useNavigate();
  const focusedId = String(tournamentId || "").trim();
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

  const empty = presentTournamentEmpty(tab, source);

  return (
    <WarzoneContent className="space-y-5">
      <div data-warzone-tournaments="true">
        <WarzonePageHeader title="Tournaments" />

        <div className="flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-[0.14em]" role="tablist" aria-label="Tournament status">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              data-selected={tab === item.key ? "true" : undefined}
              className={`px-1 py-1 ${tab === item.key ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <section className="space-y-3" data-tournament-list={tab}>
          {rows.length ? (
            rows.map((event) => (
              <TournamentEventCard key={event.id} event={event} tab={tab} focused={focusedId === event.id} />
            ))
          ) : (
            <div className="py-4 text-sm text-muted-foreground" data-tournament-empty={empty.kind}>
              <div className="font-black text-foreground">{empty.title}</div>
              <p className="mt-1">{empty.body}</p>
            </div>
          )}
        </section>
      </div>
      <TournamentDetailsModal
        tournamentId={focusedId}
        open={Boolean(focusedId)}
        onOpenChange={(open) => {
          if (!open) navigate("/warzone/tournaments", { replace: true });
        }}
      />
    </WarzoneContent>
  );
};

export default ArenaTournaments;

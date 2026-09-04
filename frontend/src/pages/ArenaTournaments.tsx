import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TournamentEventCard } from "@/components/arena/TournamentEventCard";
import { TournamentLiveOverviewModal } from "@/components/arena/TournamentLiveOverviewModal";
import { TournamentRegistrationModal } from "@/components/arena/TournamentRegistrationModal";
import { TournamentResultsModal } from "@/components/arena/TournamentResultsModal";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzonePageHeader } from "@/components/warzone/WarzonePageHeader";
import { useArenaEventFeed, type ArenaEventSummary } from "@/hooks/useArenaEventFeed";
import { presentTournamentEmpty } from "@/lib/arena/tournamentCommandPresentation.mjs";

type TournamentTab = "upcoming" | "live" | "results";
type ModalKind = "registration" | "live" | "results";

const TABS: Array<{ key: TournamentTab; label: string }> = [
  { key: "upcoming", label: "Upcoming" },
  { key: "live", label: "Live" },
  { key: "results", label: "Results" },
];

function isTournament(event: ArenaEventSummary) {
  return event.type === "tournament" || event.type === "seasonal_league";
}

function kindFromEvent(event?: { status?: string } | null): ModalKind {
  const status = String(event?.status || "").toLowerCase();
  if (status === "live") return "live";
  if (status === "completed" || status === "finished") return "results";
  return "registration";
}

const ArenaTournaments = () => {
  const { tournamentId } = useParams();
  const navigate = useNavigate();
  const focusedId = String(tournamentId || "").trim();
  const { events, archivedEvents, source } = useArenaEventFeed();
  const [tab, setTab] = useState<TournamentTab>("upcoming");
  const [localModal, setLocalModal] = useState<{ kind: ModalKind; id: string } | null>(null);

  const live = events.filter((event) => isTournament(event) && event.status === "live");
  const upcoming = events.filter((event) => isTournament(event) && (event.status === "scheduled" || event.status === "deploying"));
  const results = archivedEvents.filter((event) => isTournament(event) || event.status === "completed");

  const focusedEvent = useMemo(() => {
    if (!focusedId) return null;
    return [...upcoming, ...live, ...results, ...events, ...archivedEvents].find((event) => event.id === focusedId) || null;
  }, [archivedEvents, events, focusedId, live, results, upcoming]);

  useEffect(() => {
    if (!focusedEvent) return;
    const next = kindFromEvent(focusedEvent);
    if (next === "live") setTab("live");
    else if (next === "results") setTab("results");
    else setTab("upcoming");
  }, [focusedEvent]);

  const rows = tab === "live" ? live : tab === "results" ? results : upcoming;
  const empty = presentTournamentEmpty(tab, source);
  const openId = localModal?.id || focusedId;
  const openKind = localModal?.kind || (focusedId ? kindFromEvent(focusedEvent) : null);

  function closeDetails() {
    setLocalModal(null);
    if (focusedId) navigate("/warzone/tournaments", { replace: true });
  }

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
              <TournamentEventCard
                key={event.id}
                event={event}
                tab={tab}
                focused={openId === event.id}
                onEnter={(id) => setLocalModal({ kind: "registration", id })}
                onViewTournament={(id) => setLocalModal({ kind: "live", id })}
                onViewResults={(id) => setLocalModal({ kind: "results", id })}
              />
            ))
          ) : (
            <div className="py-4 text-sm text-muted-foreground" data-tournament-empty={empty.kind}>
              <div className="font-black text-foreground">{empty.title}</div>
              <p className="mt-1">{empty.body}</p>
            </div>
          )}
        </section>
      </div>

      <TournamentRegistrationModal
        tournamentId={openKind === "registration" ? openId : ""}
        open={Boolean(openId) && openKind === "registration"}
        onOpenChange={(open) => {
          if (!open) closeDetails();
        }}
      />
      <TournamentLiveOverviewModal
        tournamentId={openKind === "live" ? openId : ""}
        open={Boolean(openId) && openKind === "live"}
        onOpenChange={(open) => {
          if (!open) closeDetails();
        }}
      />
      <TournamentResultsModal
        tournamentId={openKind === "results" ? openId : ""}
        open={Boolean(openId) && openKind === "results"}
        onOpenChange={(open) => {
          if (!open) closeDetails();
        }}
      />
    </WarzoneContent>
  );
};

export default ArenaTournaments;

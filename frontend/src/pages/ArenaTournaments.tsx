import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TournamentEventCard } from "@/components/arena/TournamentEventCard";
import { TournamentLiveOverviewModal } from "@/components/arena/TournamentLiveOverviewModal";
import { TournamentRegistrationModal } from "@/components/arena/TournamentRegistrationModal";
import { TournamentResultsModal } from "@/components/arena/TournamentResultsModal";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
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
    <WarzoneContent className="flex flex-col gap-4 font-mw-body text-mw-text">
      <div data-warzone-tournaments="true" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3.5">
          <div>
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Warzone</div>
            <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Tournaments</h1>
          </div>
          <span className="hidden flex-1 lg:block" />
          <span
            className={`hidden h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-semibold lg:inline-flex ${source === "api" ? "border-[#1F5133] bg-[#171B20] text-[#6EE7A0]" : "border-mw-edge bg-[#171B20] text-[#C9CED4]"}`}
          >
            {source === "api" ? <span className="h-2 w-2 rounded-full bg-mw-up" aria-hidden="true" /> : null}
            {source === "api" ? "Live data" : source === "empty" ? "Feed unavailable" : "Awaiting data"}
          </span>
        </div>

        <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-[#2A3038] bg-mw-input p-1 [scrollbar-width:none] lg:w-max [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Tournament status">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              data-selected={tab === item.key ? "true" : undefined}
              className={`mw-focus min-h-10 shrink-0 rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] transition-colors ${tab === item.key ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <section className="flex flex-col gap-3" data-tournament-list={tab}>
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
            <div className="rounded-[14px] border border-mw-border bg-mw-surface px-4 py-10 text-center" data-tournament-empty={empty.kind}>
              <div className="font-mw-cond text-xl font-bold text-mw-text">{empty.title}</div>
              <p className="mx-auto mt-1 max-w-md text-[15px] text-mw-muted">{empty.body}</p>
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

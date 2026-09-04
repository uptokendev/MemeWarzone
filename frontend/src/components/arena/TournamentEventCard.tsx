import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TournamentLiveRoundPanel } from "@/components/arena/TournamentLiveRoundBattles";
import { TournamentProgressionBar } from "@/components/arena/TournamentProgressionBar";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { fetchPostGradTournamentDetails } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockTournamentDetails } from "@/features/postgrad/mockTournamentFixtures.mjs";
import { presentTournamentCard, presentTournamentChampion, readBracketRounds } from "@/lib/arena/tournamentCommandPresentation.mjs";
import { cn } from "@/lib/utils";

type Entrant = {
  tokenAddress?: string;
  symbol?: string;
  tokenName?: string;
  imageUrl?: string;
  logoUri?: string;
};

function stageLabel(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.replaceAll("_", " ").toUpperCase();
}

export function TournamentEventCard({
  event,
  tab,
  focused = false,
  embedded = false,
  onEnter,
  onViewTournament,
  onViewResults,
}: {
  event: { id: string; title?: string; status?: string; [key: string]: unknown };
  tab?: "upcoming" | "live" | "results";
  focused?: boolean;
  embedded?: boolean;
  onEnter?: (id: string) => void;
  onViewTournament?: (id: string) => void;
  onViewResults?: (id: string) => void;
}) {
  const [hydrated, setHydrated] = useState<Record<string, unknown> | null>(null);
  const source = hydrated ? { ...event, ...hydrated } : event;
  const card = presentTournamentCard(source, { tab, focused });
  const preview = (card.preview || []) as Entrant[];
  const extra = Number(card.extraEntrants || 0);
  const [bracketOpen, setBracketOpen] = useState(false);
  const [bracketBusy, setBracketBusy] = useState(false);
  const [roundOpen, setRoundOpen] = useState(false);
  const [bracketRounds, setBracketRounds] = useState(() => readBracketRounds(event));
  const [bracketEntries, setBracketEntries] = useState<Entrant[]>(Array.isArray(event.entrants) ? (event.entrants as Entrant[]) : []);

  useEffect(() => {
    let cancelled = false;
    const hasPreview = Array.isArray(event.entrants) && event.entrants.length > 0;
    const hasRounds = readBracketRounds(event).length > 0;
    if (hasPreview && hasRounds) return;
    void fetchPostGradTournamentDetails(event.id)
      .then((json) => json || (postGradFlags.mocks ? getMockTournamentDetails(event.id) : null))
      .catch(() => (postGradFlags.mocks ? getMockTournamentDetails(event.id) : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        setHydrated({
          ...((payload as { event?: Record<string, unknown> }).event || {}),
          bracket: (payload as { bracket?: unknown }).bracket,
          entrants: (payload as { entries?: unknown }).entries || (payload as { event?: { entrants?: unknown } }).event?.entrants,
          entries: (payload as { entries?: unknown }).entries,
          winnerToken: (payload as { event?: { winnerToken?: string } }).event?.winnerToken,
        });
        setBracketRounds(readBracketRounds(payload));
        const nextEntries = Array.isArray((payload as { entries?: Entrant[] }).entries)
          ? (payload as { entries: Entrant[] }).entries
          : Array.isArray((payload as { event?: { entrants?: Entrant[] } }).event?.entrants)
            ? (payload as { event: { entrants: Entrant[] } }).event.entrants
            : [];
        if (nextEntries.length) setBracketEntries(nextEntries);
      });
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  async function handleViewBracket() {
    if (bracketRounds.length) {
      setBracketOpen(true);
      return;
    }
    setBracketBusy(true);
    try {
      const json = await fetchPostGradTournamentDetails(card.id);
      const payload = json || (postGradFlags.mocks ? getMockTournamentDetails(card.id) : null);
      setBracketRounds(readBracketRounds(payload));
      const nextEntries = Array.isArray(payload?.entries) ? payload.entries : Array.isArray(payload?.event?.entrants) ? payload.event.entrants : bracketEntries;
      setBracketEntries(nextEntries as Entrant[]);
      setBracketOpen(true);
    } catch {
      const fallback = postGradFlags.mocks ? getMockTournamentDetails(card.id) : null;
      setBracketRounds(readBracketRounds(fallback));
      setBracketOpen(true);
    } finally {
      setBracketBusy(false);
    }
  }

  const champion = presentTournamentChampion(source, bracketEntries);
  const live = card.status.key === "live";
  const finished = card.status.key === "finished";
  const showLiveRound = live && !embedded;

  function handlePrimary() {
    if (live) onViewTournament?.(card.id);
    else if (finished) onViewResults?.(card.id);
    else onEnter?.(card.id);
  }

  const primary = (
    <button
      type="button"
      data-tournament-enter={card.id}
      onClick={handlePrimary}
      className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
    >
      {card.primaryCta}
    </button>
  );

  return (
    <article
      data-tournament-card={card.id}
      className={cn(!embedded && "mwz-flat-card relative overflow-hidden p-4", focused && !embedded && "ring-1 ring-accent/60")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={card.status.label} tone={card.status.key === "live" ? "success" : "default"} />
          {card.registration && !live && !finished ? (
            <TacticalTag label={card.registration.label} tone={card.registration.key === "open" ? "success" : "default"} />
          ) : null}
        </div>
        {card.chain ? <TacticalTag label={card.chain.label} tone="default" /> : null}
      </div>
      <h2 className="mt-3 font-black text-xl leading-tight text-foreground md:text-2xl">{card.title}</h2>

      {finished && champion ? (
        <div className="mt-3 flex items-center gap-3" data-tournament-champion="true">
          <WarzoneTokenMark imageUrl={champion.imageUrl} symbol={champion.symbol} name={champion.tokenName} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-orange-200">Champion</div>
            <div className="font-black text-foreground">{champion.symbol ? `$${champion.symbol}` : "TOKEN"}</div>
            {champion.tokenName ? <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{champion.tokenName}</div> : null}
          </div>
        </div>
      ) : preview.length ? (
        <div className="mt-3 flex flex-wrap items-start gap-3" data-tournament-entrant-rail="true">
          {preview.map((entrant, index) => {
            const ticker = String(entrant.symbol || "").replace(/^\$/, "");
            const name = String(entrant.tokenName || "").trim();
            return (
              <div key={`${entrant.tokenAddress || ticker || index}`} className="w-[4.5rem] min-w-0 text-center">
                <div className="mx-auto">
                  <WarzoneTokenMark
                    imageUrl={entrant.imageUrl || entrant.logoUri}
                    symbol={entrant.symbol}
                    name={entrant.tokenName}
                    size="sm"
                  />
                </div>
                {ticker ? <div className="mt-1 truncate text-[10px] font-black text-foreground">${ticker}</div> : null}
                {name ? <div className="truncate text-[9px] uppercase tracking-[0.08em] text-white/50">{name}</div> : null}
              </div>
            );
          })}
          {extra > 0 ? <span className="self-center text-xs uppercase tracking-[0.14em] text-white/50">+{extra}</span> : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.14em] text-white/55">
        {live && card.participantCount != null ? <span>{card.participantCount} STARTED</span> : null}
        {live && card.remaining != null ? <span>{card.remaining} REMAINING</span> : null}
        {!live && card.participantCount != null ? <span>{card.participantCount} CONTENDERS</span> : null}
        {card.dateTimeLabel || card.dateLabel ? <span>{card.dateTimeLabel || card.dateLabel}</span> : null}
        {card.buyIn ? <span>{card.buyIn.label} ENTRY</span> : null}
        {stageLabel(card.bracketStage) ? <span>{stageLabel(card.bracketStage)}</span> : null}
        {live && card.liveBattleCount != null ? <span>{card.liveBattleCount} BATTLES LIVE</span> : null}
      </div>

      {card.progression?.nodes ? <TournamentProgressionBar nodes={card.progression.nodes} /> : null}

      <div className="mt-4 flex flex-wrap gap-3">
        {showLiveRound ? (
          <button
            type="button"
            data-tournament-watch-live-round={card.id}
            aria-expanded={roundOpen}
            aria-controls={`tournament-live-round-${card.id}`}
            onClick={() => setRoundOpen((open) => !open)}
            className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
          >
            {card.liveRoundCta || "Watch live round"}
            <span className="ml-2 text-[10px]" aria-hidden="true">{roundOpen ? "↑" : "↓"}</span>
          </button>
        ) : embedded ? (
          <Link
            to={card.href}
            data-tournament-enter={card.id}
            className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
          >
            {card.primaryCta}
          </Link>
        ) : (
          primary
        )}
        <button
          type="button"
          data-tournament-view-bracket={card.id}
          onClick={() => void handleViewBracket()}
          disabled={bracketBusy}
          className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-accent hover:underline disabled:opacity-60"
        >
          {bracketBusy ? "Loading bracket" : card.bracketCta}
        </button>
        {showLiveRound ? (
          <button
            type="button"
            data-tournament-enter={card.id}
            onClick={handlePrimary}
            className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-white/55 underline-offset-4 hover:text-accent hover:underline"
          >
            {card.primaryCta}
          </button>
        ) : null}
      </div>
      {showLiveRound && roundOpen ? (
        <div id={`tournament-live-round-${card.id}`} data-tournament-live-round-dropdown={card.id}>
          <TournamentLiveRoundPanel
            tournamentId={card.id}
            statusLabel={card.status.label}
            stageLabel={card.bracketStage}
          />
        </div>
      ) : null}
      <TournamentBracketModal
        open={bracketOpen}
        onOpenChange={setBracketOpen}
        title={card.title}
        statusLabel={card.status.label}
        stageLabel={card.bracketStage}
        rounds={bracketRounds}
        entries={bracketEntries}
      />
    </article>
  );
}

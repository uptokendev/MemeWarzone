import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TournamentLiveRoundPanel } from "@/components/arena/TournamentLiveRoundBattles";
import { TournamentProgressionBar } from "@/components/arena/TournamentProgressionBar";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { fetchPostGradTournamentDetails } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockTournamentDetails } from "@/features/postgrad/mockTournamentFixtures.mjs";
import { presentTournamentCard, presentTournamentChampion, readBracketRounds } from "@/lib/arena/tournamentCommandPresentation.mjs";
import { cp } from "@/components/token/coinPageStyles";
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
      className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
    >
      {card.primaryCta}
    </button>
  );

  // Warzone overview: the artboard's compact card (banner, status, name, one info line). The full card
  // with entrants, progress, Enter and bracket stays on the Tournaments page (founder, 2026-10-02).
  if (embedded) {
    const info = [
      card.participantCount != null ? `${card.participantCount} coins` : null,
      card.buyIn ? `${card.buyIn.label} entry` : null,
      card.dateTimeLabel || card.dateLabel || null,
    ].filter(Boolean).join(" · ");
    return (
      <Link
        to={card.href}
        data-tournament-card={card.id}
        data-tournament-enter={card.id}
        className="mw-focus block overflow-hidden rounded-[14px] border border-mw-border bg-mw-input font-mw-body text-mw-text hover:border-[#3A424C] hover:text-mw-text"
      >
        <div className="mw-banner h-20 lg:h-[90px]" aria-hidden="true" />
        <div className="flex flex-col gap-1.5 p-3">
          <span className="inline-flex h-[22px] w-max items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-xs font-semibold text-mw-accent-soft">
            {card.status.label}{stageLabel(card.bracketStage) ? ` · ${stageLabel(card.bracketStage)}` : ""}
          </span>
          <span className="text-[17px] font-bold leading-tight">{card.title}</span>
          {info ? <span className="text-[13px] text-mw-muted lg:text-sm">{info}</span> : null}
        </div>
      </Link>
    );
  }

  return (
    <article
      data-tournament-card={card.id}
      className={cn(!embedded && "relative overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface p-4 font-mw-body text-mw-text", focused && !embedded && "ring-1 ring-mw-accent/60")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={card.status.key === "live" ? cp.chipGood : cp.chipAccent}>{card.status.label}</span>
          {card.registration && !live && !finished ? (
            <span className={card.registration.key === "open" ? cp.chipGood : cp.chip}>{card.registration.label}</span>
          ) : null}
        </div>
        {card.chain ? <span className={cp.chip}>{card.chain.label}</span> : null}
      </div>
      <h2 className="m-0 mt-3 font-mw-cond text-2xl font-bold leading-tight text-mw-text md:text-[28px]">{card.title}</h2>

      {finished && champion ? (
        <div className="mt-3 flex items-center gap-3" data-tournament-champion="true">
          <WarzoneTokenMark imageUrl={champion.imageUrl} symbol={champion.symbol} name={champion.tokenName} chainId={card.chain?.chainId} tokenAddress={champion.tokenAddress} />
          <div className="min-w-0">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Champion</div>
            <div className="font-bold text-mw-text">{champion.symbol ? `$${champion.symbol}` : "TOKEN"}</div>
            {champion.tokenName ? <div className="truncate text-[13px] text-mw-muted">{champion.tokenName}</div> : null}
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
                    chainId={card.chain?.chainId}
                    tokenAddress={entrant.tokenAddress}
                    symbol={entrant.symbol}
                    name={entrant.tokenName}
                    size="sm"
                  />
                </div>
                {ticker ? <div className="mt-1 truncate text-xs font-bold text-mw-text">${ticker}</div> : null}
                {name ? <div className="truncate text-[11px] text-mw-muted">{name}</div> : null}
              </div>
            );
          })}
          {extra > 0 ? <span className="self-center font-mw-mono text-sm text-mw-muted">+{extra}</span> : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
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
            className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
          >
            {card.liveRoundCta || "Watch live round"}
            <span className="ml-2 text-[10px]" aria-hidden="true">{roundOpen ? "↑" : "↓"}</span>
          </button>
        ) : embedded ? (
          <Link
            to={card.href}
            data-tournament-enter={card.id}
            className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
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
          className={cp.btn}
        >
          {bracketBusy ? "Loading bracket" : card.bracketCta}
        </button>
        {showLiveRound ? (
          <button
            type="button"
            data-tournament-enter={card.id}
            onClick={handlePrimary}
            className="mw-focus inline-flex min-h-11 items-center px-3 text-[15px] font-semibold text-mw-muted hover:text-mw-text"
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

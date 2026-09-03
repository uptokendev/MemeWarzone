import { useState } from "react";
import { Link } from "react-router-dom";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { fetchPostGradTournamentDetails } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockTournamentDetails } from "@/features/postgrad/mockTournamentFixtures.mjs";
import { presentTournamentCard } from "@/lib/arena/tournamentCommandPresentation.mjs";
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

function readRounds(source: unknown): Array<{ round: number; matches?: never[] }> {
  const rounds = (source as { bracket?: { rounds?: unknown[] } } | null)?.bracket?.rounds;
  return Array.isArray(rounds) ? (rounds as Array<{ round: number; matches?: never[] }>) : [];
}

export function TournamentEventCard({
  event,
  tab,
  focused = false,
  embedded = false,
}: {
  event: { id: string; title?: string; status?: string; [key: string]: unknown };
  tab?: "upcoming" | "live" | "results";
  focused?: boolean;
  embedded?: boolean;
}) {
  const card = presentTournamentCard(event, { tab, focused });
  const entrants = Array.isArray(event.entrants) ? (event.entrants as Entrant[]) : [];
  const preview = entrants.slice(0, 4);
  const extra = Math.max(0, (card.participantCount || entrants.length) - preview.length);
  const [bracketOpen, setBracketOpen] = useState(false);
  const [bracketBusy, setBracketBusy] = useState(false);
  const [bracketRounds, setBracketRounds] = useState(() => readRounds(event));
  const [bracketEntries, setBracketEntries] = useState<Entrant[]>(entrants);

  async function handleViewBracket() {
    if (bracketRounds.length) {
      setBracketOpen(true);
      return;
    }
    setBracketBusy(true);
    try {
      const json = await fetchPostGradTournamentDetails(card.id);
      const payload = json || (postGradFlags.mocks ? getMockTournamentDetails(card.id) : null);
      setBracketRounds(readRounds(payload));
      const nextEntries = Array.isArray(payload?.entries) ? payload.entries : Array.isArray(payload?.event?.entrants) ? payload.event.entrants : entrants;
      setBracketEntries(nextEntries as Entrant[]);
      setBracketOpen(true);
    } catch {
      const fallback = postGradFlags.mocks ? getMockTournamentDetails(card.id) : null;
      setBracketRounds(readRounds(fallback));
      setBracketOpen(true);
    } finally {
      setBracketBusy(false);
    }
  }

  return (
    <article
      data-tournament-card={card.id}
      className={cn(!embedded && "mwz-flat-card relative overflow-hidden p-4", focused && !embedded && "ring-1 ring-accent/60")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={card.status.label} tone={card.status.key === "live" ? "success" : "default"} />
          {card.registration ? (
            <TacticalTag label={card.registration.label} tone={card.registration.key === "open" ? "success" : "default"} />
          ) : null}
        </div>
        {card.chain ? <TacticalTag label={card.chain.label} tone="default" /> : null}
      </div>
      <h2 className="mt-3 font-black text-xl leading-tight text-foreground md:text-2xl">{card.title}</h2>
      {preview.length ? (
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
        {card.participantCount != null ? <span>{card.participantCount} CONTENDERS</span> : null}
        {card.dateLabel ? <span>{card.dateLabel}</span> : null}
        {stageLabel(card.bracketStage) ? <span>{stageLabel(card.bracketStage)}</span> : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          to={card.href}
          data-tournament-enter={card.id}
          className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
        >
          {tab === "upcoming" ? "Enter tournament" : "Open tournament"}
        </Link>
        <button
          type="button"
          data-tournament-view-bracket={card.id}
          onClick={() => void handleViewBracket()}
          disabled={bracketBusy}
          className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-accent hover:underline disabled:opacity-60"
        >
          {bracketBusy ? "Loading bracket" : "View bracket"}
        </button>
      </div>
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

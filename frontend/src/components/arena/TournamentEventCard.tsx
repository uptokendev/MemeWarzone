import { useState } from "react";
import { Link } from "react-router-dom";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { presentTournamentCard } from "@/lib/arena/tournamentCommandPresentation.mjs";
import { cn } from "@/lib/utils";

type Entrant = {
  tokenAddress?: string;
  symbol?: string;
  tokenName?: string;
  imageUrl?: string;
  logoUri?: string;
};

export function TournamentEventCard({
  event,
  tab,
  focused = false,
}: {
  event: { id: string; title?: string; status?: string; [key: string]: unknown };
  tab?: "upcoming" | "live" | "results";
  focused?: boolean;
}) {
  const [bracketOpen, setBracketOpen] = useState(false);
  const card = presentTournamentCard(event, { tab, focused });
  const entrants = Array.isArray(event.entrants) ? (event.entrants as Entrant[]) : [];
  const preview = entrants.slice(0, 4);
  const extra = Math.max(0, (card.participantCount || entrants.length) - preview.length);
  const rounds = Array.isArray((event as { bracket?: { rounds?: unknown[] } }).bracket?.rounds)
    ? ((event as { bracket: { rounds: Array<{ round: number; matches?: never[] }> } }).bracket.rounds)
    : [];
  const canOpenBracket = rounds.length > 0;

  return (
    <article
      data-tournament-card={card.id}
      className={cn("mwz-flat-card relative overflow-hidden p-4", focused && "ring-1 ring-accent/60")}
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
      <h2 className="mt-3 font-retro text-xl text-foreground md:text-2xl">{card.title}</h2>
      {preview.length ? (
        <div className="mt-3 flex items-center gap-2" data-tournament-entrant-rail="true">
          {preview.map((entrant, index) => (
            <WarzoneTokenMark
              key={`${entrant.tokenAddress || entrant.symbol || index}`}
              imageUrl={entrant.imageUrl || entrant.logoUri}
              symbol={entrant.symbol}
              name={entrant.tokenName}
              size="sm"
            />
          ))}
          {extra > 0 ? <span className="text-xs uppercase tracking-[0.14em] text-white/50">+{extra}</span> : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.14em] text-white/55">
        {card.participantLabel ? <span>{card.participantCount} CONTENDERS</span> : null}
        {card.startsLabel ? <span>STARTS {card.startsLabel}</span> : null}
        {card.bracketStage ? <span>{String(card.bracketStage).replaceAll("_", " ")}</span> : null}
      </div>
      {card.summary ? <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{card.summary}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          to={card.href}
          className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
        >
          {tab === "upcoming" ? "Enter tournament" : "Open tournament"}
        </Link>
        {canOpenBracket ? (
          <button
            type="button"
            onClick={() => setBracketOpen(true)}
            className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-accent hover:underline"
          >
            View bracket
          </button>
        ) : (
          <Link
            to={card.href}
            className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-white/55 hover:text-accent"
          >
            View bracket
          </Link>
        )}
      </div>
      {canOpenBracket ? (
        <TournamentBracketModal
          open={bracketOpen}
          onOpenChange={setBracketOpen}
          title={card.title}
          statusLabel={card.status.label}
          stageLabel={card.bracketStage}
          rounds={rounds}
          entries={entrants}
        />
      ) : null}
    </article>
  );
}

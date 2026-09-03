import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { presentTournamentCard } from "@/lib/arena/tournamentCommandPresentation.mjs";
import { cn } from "@/lib/utils";

export function TournamentEventCard({
  event,
  tab,
  focused = false,
}: {
  event: { id: string; title?: string; status?: string; [key: string]: unknown };
  tab?: "upcoming" | "live" | "results";
  focused?: boolean;
}) {
  const card = presentTournamentCard(event, { tab, focused });
  const tags = [
    { key: "status", label: card.status.label, tone: card.status.key === "live" ? "success" : "default" },
    card.chain ? { key: "chain", label: card.chain.label, tone: "default" as const } : null,
    card.mode ? { key: "mode", label: card.mode.label, tone: "default" as const } : null,
    card.registration ? { key: "registration", label: card.registration.label, tone: card.registration.key === "open" ? "success" : "default" } : null,
  ].filter(Boolean) as Array<{ key: string; label: string; tone: "success" | "default" }>;

  return (
    <Link
      to={card.href}
      data-tournament-card={card.id}
      data-selected={focused ? "true" : undefined}
      className={cn("mwz-flat-card block p-4", focused && "ring-1 ring-accent/70")}
    >
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((tag) => (
          <TacticalTag key={tag.key} label={tag.label} tone={tag.tone} />
        ))}
      </div>
      <h2 className="mt-3 font-retro text-lg text-foreground">{card.title}</h2>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.14em] text-white/55">
        {card.participantLabel ? <span>{card.participantLabel}</span> : null}
        {card.scheduleLabel ? <span>{card.scheduleLabel}</span> : null}
        {card.bracketStage ? <span>{card.bracketStage.replaceAll("_", " ")}</span> : null}
        {card.buyIn ? <span>BUY-IN {card.buyIn.label}</span> : null}
      </div>
      {card.summary ? <p className="mt-2 text-sm text-muted-foreground">{card.summary}</p> : null}
      <div className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
        {focused ? "Focused" : tab === "upcoming" ? "View / expand" : "Open"}
      </div>
    </Link>
  );
}

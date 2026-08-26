import { Link, useParams } from "react-router-dom";
import { useState } from "react";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useArenaEventDetails } from "@/hooks/useArenaEventFeed";

type DetailTab = "standings" | "bracket" | "matches";

const TournamentDetails = () => {
  const { id } = useParams();
  const { event: tournament, source } = useArenaEventDetails(id);
  const [tab, setTab] = useState<DetailTab>("standings");

  if (!tournament) {
    return (
      <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
        <section className="mwz-hud-frame p-5">
          <h1 className="font-retro text-2xl text-foreground">Tournament unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {source === "empty" ? "Tournament data is not available right now." : "This tournament could not be loaded."}
          </p>
          <div className="mt-4">
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/arena/tournaments">Back to tournaments</Link>
            </Button>
          </div>
        </section>
      </ContentContainer>
    );
  }

  const upcoming = tournament.status === "scheduled" || tournament.status === "deploying";

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={tournament.status} tone={tournament.status === "live" ? "success" : "default"} />
          <TacticalTag label={source === "api" ? "Live data" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
        </div>
        <h1 className="mt-3 font-retro text-2xl text-foreground">{tournament.title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {tournament.participantCount} coins · Starts {new Date(tournament.startsAt).toLocaleString()}
        </p>
        {tournament.summary ? <p className="mt-3 text-sm text-muted-foreground">{tournament.summary}</p> : null}
        <div className="mt-4">
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to="/arena/tournaments">Back to tournaments</Link>
          </Button>
        </div>
      </section>

      {upcoming ? (
        <section className="mwz-hud-frame p-5 text-sm text-muted-foreground">
          Opt-in and buy-in will open here for eligible coins. Tournaments are created in the web dashboard.
        </section>
      ) : (
        <>
          <div className="inline-flex flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1">
            {(["standings", "bracket", "matches"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${tab === item ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {item}
              </button>
            ))}
          </div>
          <section className="mwz-hud-frame p-5 text-sm text-muted-foreground">
            {tab === "standings" && "Standings appear once the roster is locked and matches are scored."}
            {tab === "bracket" && "The bracket tree appears here after lock. Matches open as 1v1 battle pages."}
            {tab === "matches" && "Tournament matches will list here and open /battle/:id."}
          </section>
        </>
      )}
    </ContentContainer>
  );
};

export default TournamentDetails;

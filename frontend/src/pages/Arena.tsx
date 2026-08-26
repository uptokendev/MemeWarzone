import { Link } from "react-router-dom";
import { ArenaMatchRow } from "@/components/postgrad/ArenaMatchRow";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaEventFeed } from "@/hooks/useArenaEventFeed";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";

const Arena = () => {
  const { liveBattles, source: battleSource } = useArenaBattleFeed();
  const { events, source: eventSource } = useArenaEventFeed();
  const { season, source: leagueSource } = useArenaLeagueFeed();

  const liveTournaments = events.filter((event) => event.status === "live" && event.type === "tournament");
  const lead = season.entries[0];

  return (
    <ContentContainer className="space-y-6 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Arena UpVotes</div>
        <h1 className="mt-1 font-retro text-2xl text-foreground">Featured memecoins</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Top 20 from Arena UpVotes (graduated MemeWarzone coins and approved imports). Launchpad UpVotes stay on Showcase.
        </p>
        <div className="mt-4 rounded-md border border-border/50 bg-background/40 p-4 text-sm text-muted-foreground">
          Arena UpVotes are not live yet. This rail stays empty until the Arena vote ledger is on.
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Live battles</h2>
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/arena/battles">Open battles</Link>
            </Button>
          </div>
          {liveBattles.slice(0, 3).length ? (
            liveBattles.slice(0, 3).map((battle) => <ArenaMatchRow key={battle.id} battle={battle} />)
          ) : (
            <div className="mwz-hud-frame p-4 text-sm text-muted-foreground">
              {battleSource === "empty" ? "Battle feed is unavailable." : "No live battles right now."}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Live tournaments</h2>
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/arena/tournaments">Open tournaments</Link>
            </Button>
          </div>
          {liveTournaments.slice(0, 2).length ? (
            liveTournaments.slice(0, 2).map((event) => (
              <Link key={event.id} to={`/arena/tournament/${encodeURIComponent(event.id)}`} className="mwz-hud-frame block p-4 transition hover:border-accent/50">
                <TacticalTag label="Live" tone="success" />
                <div className="mt-2 font-retro text-sm text-foreground">{event.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{event.participantCount} coins</div>
              </Link>
            ))
          ) : (
            <div className="mwz-hud-frame p-4 text-sm text-muted-foreground">
              {eventSource === "empty" ? "Tournament feed is unavailable." : "No live tournaments right now."}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Major War League</h2>
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/arena/major-war-league">Open table</Link>
            </Button>
          </div>
          {lead ? (
            <Link to="/arena/major-war-league" className="mwz-hud-frame block p-4 transition hover:border-accent/50">
              <TacticalTag label={season.label || "Season"} tone="default" />
              <div className="mt-2 font-retro text-sm text-foreground">Leader {lead.tokenName || lead.symbol}</div>
              <div className="mt-1 text-xs text-muted-foreground">{Number(lead.points || 0).toLocaleString()} pts · week {season.week}</div>
            </Link>
          ) : (
            <div className="mwz-hud-frame p-4 text-sm text-muted-foreground">
              {leagueSource === "empty" ? "League feed is unavailable." : "Standings appear once the season has results."}
            </div>
          )}
        </div>
      </section>
    </ContentContainer>
  );
};

export default Arena;

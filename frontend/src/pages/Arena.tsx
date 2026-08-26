import { Link } from "react-router-dom";
import { ArenaMatchRow } from "@/components/postgrad/ArenaMatchRow";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaEventFeed } from "@/hooks/useArenaEventFeed";
import { useArenaFeaturedVotes } from "@/hooks/useArenaFeaturedVotes";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";

const Arena = () => {
  const { liveBattles, source: battleSource } = useArenaBattleFeed();
  const { events, source: eventSource } = useArenaEventFeed();
  const { season, source: leagueSource } = useArenaLeagueFeed();
  const featured = useArenaFeaturedVotes();

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
        {featured.items.length ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {featured.items.slice(0, 20).map((item, index) => {
              const route = getArenaTokenRoute(item.tokenAddress);
              const card = (
                <div className="rounded-md border border-border/50 bg-background/40 p-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">#{index + 1}</div>
                  <div className="mt-1 font-retro text-sm text-foreground">{item.tokenName} <span className="text-muted-foreground">{item.symbol}</span></div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.votes24h} Arena UpVotes (24h)</div>
                </div>
              );
              return route ? (
                <Link key={`${item.chainId}-${item.tokenAddress}`} to={route} className="block transition hover:border-accent/50">
                  {card}
                </Link>
              ) : (
                <div key={`${item.chainId}-${item.tokenAddress}`}>{card}</div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-border/50 bg-background/40 p-4 text-sm text-muted-foreground">
            {featured.loading
              ? "Loading Arena UpVotes..."
              : "No Arena UpVotes yet. Ranking uses the Arena ledger, separate from launchpad UpVotes. Paying votes waits on a dedicated Arena treasury."}
          </div>
        )}
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

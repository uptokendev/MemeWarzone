import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { TournamentEventCard } from "@/components/arena/TournamentEventCard";
import { WarzoneBattlePreview } from "@/components/warzone/WarzoneBattlePreview";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzonePageHeader } from "@/components/warzone/WarzonePageHeader";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaEventFeed } from "@/hooks/useArenaEventFeed";
import { useArenaFeaturedVotes } from "@/hooks/useArenaFeaturedVotes";
import { useArenaFeedBattleMetrics } from "@/hooks/useArenaFeedBattleMetrics";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";
import { battleChainLabel } from "@/lib/arena/battlePresentation";
import { presentWarzoneLeagueBoard } from "@/lib/arena/warzoneChrome.mjs";

function isTournament(event: { type?: string; status?: string }) {
  return event.type === "tournament" || event.type === "seasonal_league";
}

const Arena = () => {
  const { liveBattles, source: battleSource } = useArenaBattleFeed();
  const livePreview = useMemo(() => liveBattles.slice(0, 2), [liveBattles]);
  const feedMetrics = useArenaFeedBattleMetrics(livePreview);
  const { events, source: eventSource } = useArenaEventFeed();
  const { season, source: leagueSource } = useArenaLeagueFeed();
  const featured = useArenaFeaturedVotes();
  const liveTournaments = events.filter((event) => event.status === "live" && isTournament(event));
  const upcomingTournaments = events.filter((event) => isTournament(event) && (event.status === "scheduled" || event.status === "deploying"));
  const tournamentPreview = (liveTournaments[0] || upcomingTournaments[0]) ?? null;
  const board = presentWarzoneLeagueBoard(season.entries);
  const podium = board.podium.slice(0, 3);

  return (
    <WarzoneContent className="space-y-8">
      <WarzonePageHeader title="Warzone" copy="The post-grad battlefield" />

      <section data-warzone-active-battles="true">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-retro text-lg text-foreground">Active battles</h2>
          <Link to="/warzone/battles" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
            Open battles
          </Link>
        </div>
        {livePreview.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {livePreview.map((battle) => (
              <WarzoneBattlePreview
                key={battle.id}
                battle={battle}
                metrics={feedMetrics.metricsById[battle.id]}
                metricsRequested={feedMetrics.requestedIds.includes(battle.id)}
                metricsLoaded={feedMetrics.loaded}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {battleSource === "empty" ? "No live battles right now." : "No live battles right now."}
          </p>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Tournaments</h2>
            <Link to="/warzone/tournaments" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open tournaments
            </Link>
          </div>
          {tournamentPreview ? (
            <TournamentEventCard event={tournamentPreview} tab={tournamentPreview.status === "live" ? "live" : "upcoming"} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {eventSource === "empty" ? "No live tournaments right now." : "No live tournaments right now."}
            </p>
          )}
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Major War League</h2>
            <Link to="/warzone/major-war-league" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open standings
            </Link>
          </div>
          {podium.length ? (
            <Link to="/warzone/major-war-league" className="mwz-flat-card block space-y-3 p-4" data-warzone-mwl-preview="true">
              {podium.map((entry, index) => (
                <div key={entry.tokenId} className="flex items-center gap-3">
                  <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">#{index + 1}</div>
                    <div className="truncate font-retro text-sm text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</div>
                  </div>
                  <div className="font-retro text-sm text-white/80">{Number(entry.points).toLocaleString()} PTS</div>
                </div>
              ))}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              {leagueSource === "empty" ? "Standings appear once the season has results." : "Standings appear once the season has results."}
            </p>
          )}
        </div>
      </section>

      <section data-warzone-featured="true">
        <h2 className="font-retro text-lg text-foreground">Featured memecoins</h2>
        {featured.items.length ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {featured.items.slice(0, 8).map((item, index) => {
              const route = getArenaTokenRoute(item.tokenAddress, item.chainId);
              const body = (
                <>
                  <div className="flex items-center gap-3">
                    <WarzoneTokenMark imageUrl={item.imageUrl} symbol={item.symbol} name={item.tokenName} />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-white/42">#{index + 1}</div>
                      <div className="truncate font-retro text-sm text-foreground">${String(item.symbol || "").replace(/^\$/, "")}</div>
                      <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{item.tokenName}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-white/50">
                    <span>{battleChainLabel(item.chainId)}</span>
                    <span>{item.votes24h} UpVotes</span>
                  </div>
                </>
              );
              return (
                <div key={`${item.chainId}-${item.tokenAddress}`} className="mwz-flat-card p-3">
                  {route ? (
                    <Link to={route} className="block hover:text-accent">
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                  <div className="mt-3">
                    <ArenaUpvoteDialog tokenAddress={item.tokenAddress} chainId={item.chainId} buttonSize="sm" className="h-8 px-3 text-xs" />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" data-warzone-featured-empty="true">
            {featured.loading ? "Loading featured coins..." : "No featured memecoins yet."}
          </p>
        )}
      </section>
    </WarzoneContent>
  );
};

export default Arena;

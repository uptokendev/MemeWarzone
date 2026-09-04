import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { FeaturedCampaignCard } from "@/components/home/FeaturedCampaignCard";
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
import { presentWarzoneLeagueBoard } from "@/lib/arena/warzoneChrome.mjs";
import { resolveImageUri } from "@/lib/media";

function isTournament(event: { type?: string; status?: string }) {
  return event.type === "tournament" || event.type === "seasonal_league";
}

const Arena = () => {
  const navigate = useNavigate();
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

      <section data-warzone-featured="true">
        <h2 className="font-black text-lg uppercase tracking-[0.08em] text-foreground">Featured memecoins</h2>
        {featured.items.length ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {featured.items.slice(0, 8).map((item, index) => {
              const route = getArenaTokenRoute(item.tokenAddress, item.chainId);
              const image = resolveImageUri(item.imageUrl) || null;
              return (
                <FeaturedCampaignCard
                  key={`${item.chainId}-${item.tokenAddress}`}
                  liveId={`${item.chainId}:${item.tokenAddress}`}
                  rank={index + 1}
                  name={item.tokenName}
                  symbol={item.symbol}
                  imageUrl={image}
                  votes24h={item.votes24h}
                  mcapUsdLabel={null}
                  athUsdLabel="—"
                  onOpen={route ? () => navigate(route) : undefined}
                  actions={
                    <ArenaUpvoteDialog
                      tokenAddress={item.tokenAddress}
                      chainId={item.chainId}
                      className="mwz-button mwz-button-active h-9 w-full text-[11px]"
                      buttonVariant="ghost"
                      buttonSize="sm"
                    />
                  }
                />
              );
            })}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" data-warzone-featured-empty="true">
            {featured.loading ? "Loading featured coins..." : "No featured memecoins yet."}
          </p>
        )}
      </section>

      <section data-warzone-overview-pillars="true" className="grid gap-4 lg:grid-cols-3 lg:items-stretch">
        <article className="mwz-flat-card flex h-full min-w-0 flex-col p-4" data-warzone-active-battles="true">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-black text-sm uppercase tracking-[0.12em] text-foreground">Active battles</h2>
            <Link to="/warzone/battles" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open battles
            </Link>
          </div>
          {livePreview.length ? (
            <div className="divide-y divide-white/10">
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
        </article>

        <article className="mwz-flat-card flex h-full min-w-0 flex-col p-4" data-warzone-tournament-preview="true">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-black text-sm uppercase tracking-[0.12em] text-foreground">Tournaments</h2>
            <Link to="/warzone/tournaments" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open tournaments
            </Link>
          </div>
          {tournamentPreview ? (
            <TournamentEventCard
              event={tournamentPreview}
              tab={tournamentPreview.status === "live" ? "live" : "upcoming"}
              embedded
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {eventSource === "empty" ? "No live tournaments right now." : "No live tournaments right now."}
            </p>
          )}
        </article>

        <article className="mwz-flat-card flex h-full min-w-0 flex-col p-4" data-warzone-mwl-preview="true">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-black text-sm uppercase tracking-[0.12em] text-foreground">Major War League</h2>
            <Link to="/warzone/major-war-league" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open standings
            </Link>
          </div>
          {podium.length ? (
            <Link to="/warzone/major-war-league" className="block space-y-3">
              {podium.map((entry, index) => (
                <div key={entry.tokenId} className="flex items-center gap-3">
                  <div className="w-6 shrink-0 text-[10px] uppercase tracking-[0.16em] text-white/45">#{index + 1}</div>
                  <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-black text-sm text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</div>
                    <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{entry.tokenName}</div>
                  </div>
                  <div className="shrink-0 font-black text-sm tabular-nums text-white/80">{Number(entry.points).toLocaleString()} PTS</div>
                </div>
              ))}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              {leagueSource === "empty" ? "Standings appear once the season has results." : "Standings appear once the season has results."}
            </p>
          )}
        </article>
      </section>
    </WarzoneContent>
  );
};

export default Arena;

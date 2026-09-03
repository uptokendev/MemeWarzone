import { useMemo } from "react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
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
import { presentWarzoneCommandStrip, presentWarzoneFeedTone } from "@/lib/arena/warzoneChrome.mjs";

const Arena = () => {
  const { liveBattles, source: battleSource } = useArenaBattleFeed();
  const livePreview = useMemo(() => liveBattles.slice(0, 3), [liveBattles]);
  const feedMetrics = useArenaFeedBattleMetrics(livePreview);
  const { events, source: eventSource } = useArenaEventFeed();
  const { season, source: leagueSource } = useArenaLeagueFeed();
  const featured = useArenaFeaturedVotes();
  const liveTournaments = events.filter((event) => event.status === "live" && event.type === "tournament");
  const lead = season.entries[0];
  const strip = presentWarzoneCommandStrip({
    liveBattleCount: liveBattles.length,
    liveTournamentCount: liveTournaments.length,
    season,
  });
  const battleTone = presentWarzoneFeedTone(battleSource);

  return (
    <WarzoneContent className="space-y-5">
      <WarzonePageHeader
        title="Post-grad command"
        copy="Featured coins, active battles, tournaments, and Major War League from the same Warzone feed."
      >
        <TacticalTag label={battleTone.label} tone={battleTone.tone as "success" | "default"} />
      </WarzonePageHeader>

      <div
        data-warzone-status-strip="true"
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border border-white/10 bg-black/30 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/55"
      >
        <span>{strip.liveBattleCount} live battles</span>
        <span className="text-white/20" aria-hidden="true">|</span>
        <span>{strip.liveTournamentCount} live tournaments</span>
        {strip.week ? (
          <>
            <span className="text-white/20" aria-hidden="true">|</span>
            <span>MWL week {strip.week}</span>
          </>
        ) : null}
      </div>

      <section className="mwz-hud-frame p-3 md:p-4" data-warzone-featured="true">
        <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Featured memecoins</div>
        <h2 className="mt-1 font-retro text-lg text-foreground">Warzone UpVotes</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Top 20 from graduated MemeWarzone coins and approved imports. Launchpad UpVotes stay on Showcase.
        </p>
        {featured.items.length ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {featured.items.slice(0, 20).map((item, index) => {
              const route = getArenaTokenRoute(item.tokenAddress, item.chainId);
              const body = (
                <>
                  <div className="flex items-center gap-3">
                    <WarzoneTokenMark symbol={item.symbol} name={item.tokenName} />
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
                <div key={`${item.chainId}-${item.tokenAddress}`} className="border border-white/10 bg-black/35 p-3">
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
          <div className="mt-4 border border-white/10 bg-black/35 p-4 text-sm text-muted-foreground" data-warzone-featured-empty="true">
            {featured.loading
              ? "Loading Warzone UpVotes..."
              : featured.votingLive
                ? "No Warzone UpVotes yet. Rank this rail from graduated coins and approved imports."
                : "No Warzone UpVotes yet. Ranking uses the Warzone ledger. Paying votes waits on a dedicated Warzone treasury address in this environment."}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-retro text-lg text-foreground">Active battles</h2>
          <Link to="/warzone/battles" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
            Open battles
          </Link>
        </div>
        {livePreview.length ? (
          <div className="grid gap-2 md:grid-cols-1 xl:grid-cols-3">
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
          <div className="mwz-hud-frame p-4 text-sm text-muted-foreground">
            {battleSource === "empty" ? "Battle feed is unavailable." : "No live battles right now."}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Tournaments</h2>
            <Link to="/warzone/tournaments" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open tournaments
            </Link>
          </div>
          {liveTournaments.slice(0, 2).length ? (
            liveTournaments.slice(0, 2).map((event) => (
              <Link
                key={event.id}
                to={`/warzone/tournament/${encodeURIComponent(event.id)}`}
                className="mwz-hud-frame mb-2 block p-4 transition hover:border-accent/50"
              >
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

        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-retro text-lg text-foreground">Major War League</h2>
            <Link to="/warzone/major-war-league" className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline">
              Open table
            </Link>
          </div>
          {lead ? (
            <Link to="/warzone/major-war-league" className="mwz-hud-frame flex items-center gap-3 p-4 transition hover:border-accent/50">
              <WarzoneTokenMark symbol={lead.symbol} name={lead.tokenName} size="lg" />
              <div className="min-w-0">
                <TacticalTag label={season.label || "Season"} tone="default" />
                <div className="mt-2 truncate font-retro text-sm text-foreground">${String(lead.symbol || "").replace(/^\$/, "")}</div>
                <div className="text-xs text-muted-foreground">
                  {Number(lead.points || 0).toLocaleString()} pts · week {season.week}
                </div>
              </div>
            </Link>
          ) : (
            <div className="mwz-hud-frame p-4 text-sm text-muted-foreground">
              {leagueSource === "empty" ? "League feed is unavailable." : "Standings appear once the season has results."}
            </div>
          )}
        </div>
      </section>
    </WarzoneContent>
  );
};

export default Arena;

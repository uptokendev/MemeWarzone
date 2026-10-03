import { useMemo, type ComponentProps } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { FeaturedCampaignCard } from "@/components/home/FeaturedCampaignCard";
import { TournamentEventCard } from "@/components/arena/TournamentEventCard";
import { WarzoneBattlePreview } from "@/components/warzone/WarzoneBattlePreview";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { ChainFeedSwitch } from "@/components/common/ChainFeedSwitch";
import { WarzoneRankCard } from "@/components/warzone/WarzoneRankCard";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaEventFeed } from "@/hooks/useArenaEventFeed";
import { useArenaFeaturedVotes } from "@/hooks/useArenaFeaturedVotes";
import { useArenaFeedBattleMetrics } from "@/hooks/useArenaFeedBattleMetrics";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";
import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import { formatCompactUsd } from "@/lib/arena/battlePresentation";
import { presentWarzoneLeagueBoard } from "@/lib/arena/warzoneChrome.mjs";
import { resolveImageUri } from "@/lib/media";

function isTournament(event: { type?: string; status?: string }) {
  return event.type === "tournament" || event.type === "seasonal_league";
}

/** The profile carries no ATH yet. */
function athLabel(marketCapUsd?: number | null) {
  return marketCapUsd != null ? formatCompactUsd(marketCapUsd) : "—";
}

/** The featured-votes feed carries no art; resolve it the way the battle cards do. */
function FeaturedArenaCoinCard({
  imageUrl,
  chainId,
  tokenAddress,
  ...props
}: Omit<ComponentProps<typeof FeaturedCampaignCard>, "imageUrl"> & { imageUrl?: string | null; chainId: number; tokenAddress: string }) {
  const profile = useArenaTokenProfile(chainId, tokenAddress);
  const mcapUsdLabel = profile?.marketCapUsd != null ? formatCompactUsd(profile.marketCapUsd) : null;
  return (
    <FeaturedCampaignCard
      {...props}
      imageUrl={resolveImageUri(imageUrl || profile?.imageUrl) || null}
      mcapUsdLabel={mcapUsdLabel}
      athUsdLabel={athLabel(profile?.marketCapUsd)}
    />
  );
}

const Arena = () => {
  const navigate = useNavigate();
  const { liveBattles, source: battleSource } = useArenaBattleFeed();
  const livePreview = useMemo(() => liveBattles.slice(0, 2), [liveBattles]);
  const feedMetrics = useArenaFeedBattleMetrics(livePreview);
  const { events, source: eventSource } = useArenaEventFeed();
  const { season, source: leagueSource, chainId: leagueChainId } = useArenaLeagueFeed();
  const featured = useArenaFeaturedVotes();
  const liveTournaments = events.filter((event) => event.status === "live" && isTournament(event));
  const upcomingTournaments = events.filter((event) => isTournament(event) && (event.status === "scheduled" || event.status === "deploying"));
  const tournamentPreview = (liveTournaments[0] || upcomingTournaments[0]) ?? null;
  const board = presentWarzoneLeagueBoard(season.entries);
  const podium = board.podium.slice(0, 3);

  const sectionCard = "flex h-full min-w-0 flex-col gap-3 rounded-[14px] border border-mw-border bg-mw-surface p-3.5 lg:p-4";
  const cardTitle = "m-0 font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text";
  const cardLink = "text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]";

  return (
    <WarzoneContent className="flex flex-col gap-5 font-mw-body text-mw-text">
      <header
        data-warzone-page-header="true"
        className="bg-[#17120e] font-mw-body -mx-4 flex flex-col gap-3 border-b border-[#1E2329] px-4 py-5 md:mx-0 md:rounded-[18px] md:border md:border-[#2A3038] lg:flex-row lg:items-end lg:gap-5 lg:p-7"
       style={{ backgroundImage: "url(/assets/warzone-banner.jpg)", backgroundSize: "cover", backgroundPosition: "center" }}>
        <div className="min-w-0 flex-1">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Warzone</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[34px] font-bold leading-none lg:text-5xl">The post-grad battlefield</h1>
          <p className="m-0 mt-2 hidden max-w-[70ch] text-base text-mw-muted lg:block">
            Graduated coins fight in battles and tournaments for prize pools and Major War League points.
          </p>
        </div>
        <ChainFeedSwitch className="shrink-0" />
      </header>

      {/* Phones: quick links to the Warzone sections (artboard WarzoneMobile). */}
      <nav aria-label="Warzone sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden">
        {[
          ["Battles", "/warzone/battles"],
          ["Leagues", "/league"],
          ["Major War League", "/warzone/major-war-league"],
          ["War Trade Room", "/war-room"],
        ].map(([label, to]) => (
          <Link key={to} to={to} className="mw-focus inline-flex min-h-10 shrink-0 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text">
            {label}
          </Link>
        ))}
      </nav>

      <section data-warzone-featured="true" className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className={cardTitle}>Featured memecoins</h2>
          <span className="text-xs text-mw-muted lg:text-[13px]"><span className="lg:hidden">UpVotes 24h</span><span className="hidden lg:inline">Ranked by UpVotes, 24h</span></span>
        </div>
        {featured.items.length ? (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3">
            {featured.items.slice(0, 8).map((item, index) => {
              const route = getArenaTokenRoute(item.tokenAddress, item.chainId);
              return (
                <FeaturedArenaCoinCard
                  key={`${item.chainId}-${item.tokenAddress}`}
                  liveId={`${item.chainId}:${item.tokenAddress}`}
                  rank={index + 1}
                  name={item.tokenName}
                  symbol={item.symbol}
                  imageUrl={item.imageUrl}
                  chainId={item.chainId}
                  tokenAddress={item.tokenAddress}
                  votes24h={item.votes24h}
                  layout="grid"
                  onOpen={route ? () => navigate(route) : undefined}
                  actions={
                    <ArenaUpvoteDialog
                      tokenAddress={item.tokenAddress}
                      chainId={item.chainId}
                      className="h-10 w-full rounded-[10px] border border-mw-edge bg-mw-raised text-sm font-semibold text-mw-text hover:border-mw-accent hover:bg-mw-accent hover:text-[#140A02]"
                      buttonVariant="ghost"
                      buttonSize="sm"
                    />
                  }
                />
              );
            })}
          </div>
        ) : (
          <p className="m-0 text-sm text-mw-muted" data-warzone-featured-empty="true">
            {featured.loading ? "Loading featured coins..." : "No featured memecoins yet."}
          </p>
        )}
      </section>

      <section data-warzone-overview-pillars="true" className="grid gap-3 lg:grid-cols-3 lg:items-stretch lg:gap-4">
        <article className={sectionCard} data-warzone-active-battles="true">
          <div className="flex items-center justify-between gap-2">
            <h2 className={cardTitle}>Active battles</h2>
            <Link to="/warzone/battles" className={cardLink}>
              <span className="lg:hidden">Open</span>
              <span className="hidden lg:inline">Open battles</span>
            </Link>
          </div>
          {livePreview.length ? (
            <div className="flex flex-col gap-2.5">
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
            <p className="m-0 text-sm text-mw-muted">
              {battleSource === "empty" ? "No live battles right now." : "No live battles right now."}
            </p>
          )}
        </article>

        <article className={sectionCard} data-warzone-tournament-preview="true">
          <div className="flex items-center justify-between gap-2">
            <h2 className={cardTitle}>Tournaments</h2>
            <Link to="/warzone/tournaments" className={cardLink}>
              <span className="lg:hidden">Open</span>
              <span className="hidden lg:inline">Open tournaments</span>
            </Link>
          </div>
          {tournamentPreview ? (
            <TournamentEventCard
              event={tournamentPreview}
              tab={tournamentPreview.status === "live" ? "live" : "upcoming"}
              embedded
            />
          ) : (
            <p className="m-0 text-sm text-mw-muted">
              {eventSource === "empty" ? "No live tournaments right now." : "No live tournaments right now."}
            </p>
          )}
        </article>

        <article className={sectionCard} data-warzone-mwl-preview="true">
          <div className="flex items-center justify-between gap-2">
            <h2 className={cardTitle}>Major War League</h2>
            <Link to="/warzone/major-war-league" className={cardLink}>
              <span className="lg:hidden">Standings</span>
              <span className="hidden lg:inline">Open standings</span>
            </Link>
          </div>
          {podium.length ? (
            <Link to="/warzone/major-war-league" className="flex flex-col gap-2.5 text-mw-text hover:text-mw-text">
              {podium.map((entry, index) => (
                <WarzoneRankCard
                  key={entry.tokenId}
                  rank={index + 1}
                  imageUrl={(entry as { imageUrl?: string }).imageUrl}
                  chainId={leagueChainId}
                  tokenAddress={entry.tokenId}
                  symbol={entry.symbol}
                  name={entry.tokenName}
                  points={entry.points}
                  wins={entry.wins}
                  losses={entry.losses}
                  variant="row"
                />
              ))}
            </Link>
          ) : (
            <p className="m-0 text-sm text-mw-muted">
              {leagueSource === "empty" ? "Standings appear once the season has results." : "Standings appear once the season has results."}
            </p>
          )}
        </article>
      </section>
    </WarzoneContent>
  );
};

export default Arena;

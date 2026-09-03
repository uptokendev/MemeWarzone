import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzoneLeagueHowItWorks } from "@/components/warzone/WarzoneLeagueHowItWorks";
import { WarzonePageHeader } from "@/components/warzone/WarzonePageHeader";
import { WarzoneRankCard } from "@/components/warzone/WarzoneRankCard";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";
import {
  presentWarzoneLeagueBoard,
  presentWarzoneLeagueEmpty,
  presentWarzoneLeagueStatus,
} from "@/lib/arena/warzoneChrome.mjs";

type LeagueTab = "regular" | "quarter_finals";

function TokenLink({
  tokenId,
  children,
  className,
}: {
  tokenId: string;
  children: ReactNode;
  className?: string;
}) {
  const route = getArenaTokenRoute(tokenId);
  if (!route) return <div className={className}>{children}</div>;
  return (
    <Link to={route} className={className || "block"}>
      {children}
    </Link>
  );
}

const PostGradLeague = () => {
  const { season, source } = useArenaLeagueFeed();
  const [tab, setTab] = useState<LeagueTab>("regular");
  const quarterFinalsId = (season as { quarterFinalsTournamentId?: string }).quarterFinalsTournamentId;
  const board = presentWarzoneLeagueBoard(season.entries);
  const empty = presentWarzoneLeagueEmpty(source);
  const first = board.podium[0];
  const second = board.podium[1];
  const third = board.podium[2];

  return (
    <WarzoneContent className="space-y-6">
      <WarzonePageHeader title="Major War League" copy="The monthly fight for Warzone supremacy">
        {season.label ? <TacticalTag label={season.label} tone="default" /> : null}
        <TacticalTag label={`Week ${season.week || 1}`} tone="default" />
        <WarzoneLeagueHowItWorks />
      </WarzonePageHeader>

      <div className="flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-[0.14em]">
        <button
          type="button"
          onClick={() => setTab("regular")}
          data-selected={tab === "regular" ? "true" : undefined}
          className={`px-1 py-1 ${tab === "regular" ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
        >
          Regular season
        </button>
        <button
          type="button"
          onClick={() => setTab("quarter_finals")}
          data-selected={tab === "quarter_finals" ? "true" : undefined}
          className={`px-1 py-1 ${tab === "quarter_finals" ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
        >
          Quarter Finals
        </button>
      </div>

      {tab === "quarter_finals" ? (
        <section data-warzone-mwl-quarter-finals="true">
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Quarter Finals</div>
          <h2 className="mt-1 font-retro text-lg text-foreground">Top 8 qualify</h2>
          {quarterFinalsId ? (
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>Top 8 from this table enter the Quarter Finals.</p>
              <Link
                to={`/warzone/tournaments/${encodeURIComponent(quarterFinalsId)}`}
                className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
              >
                Enter Quarter Finals
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Quarter Finals open when the season table is frozen.
            </p>
          )}
        </section>
      ) : season.entries.length ? (
        <>
          <section data-warzone-mwl-podium="true">
            <div className="mb-3 text-[10px] uppercase tracking-[0.22em] text-white/45">Top command</div>
            <div className="grid gap-3 md:grid-cols-3">
              {first ? (
                <TokenLink tokenId={first.tokenId}>
                  <WarzoneRankCard
                    rank={1}
                    imageUrl={(first as { imageUrl?: string }).imageUrl}
                    symbol={first.symbol}
                    name={first.tokenName}
                    points={first.points}
                    wins={first.wins}
                    losses={first.losses}
                  />
                </TokenLink>
              ) : null}
              {second ? (
                <TokenLink tokenId={second.tokenId}>
                  <WarzoneRankCard
                    rank={2}
                    imageUrl={(second as { imageUrl?: string }).imageUrl}
                    symbol={second.symbol}
                    name={second.tokenName}
                    points={second.points}
                    wins={second.wins}
                    losses={second.losses}
                  />
                </TokenLink>
              ) : null}
              {third ? (
                <TokenLink tokenId={third.tokenId}>
                  <WarzoneRankCard
                    rank={3}
                    imageUrl={(third as { imageUrl?: string }).imageUrl}
                    symbol={third.symbol}
                    name={third.tokenName}
                    points={third.points}
                    wins={third.wins}
                    losses={third.losses}
                  />
                </TokenLink>
              ) : null}
            </div>
          </section>

          {board.table.length ? (
            <section data-warzone-mwl-table="true">
              <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-white/45">Standings</div>
              <div className="hidden md:block">
                <div
                  className="grid grid-cols-[3.5rem_minmax(0,1.4fr)_5rem_3rem_3rem_5rem_7rem] gap-2 border-b px-1 py-2 text-[10px] uppercase tracking-[0.16em] text-white/42"
                  style={{ borderColor: "var(--mwz-flat-card-border)" }}
                >
                  <span>Rank</span>
                  <span>Token</span>
                  <span>Pts</span>
                  <span>W</span>
                  <span>L</span>
                  <span>Fights</span>
                  <span>Status</span>
                </div>
                {board.table.map((entry) => {
                  const status = presentWarzoneLeagueStatus(entry);
                  return (
                    <TokenLink key={entry.tokenId} tokenId={entry.tokenId}>
                      <div
                        className="grid grid-cols-[3.5rem_minmax(0,1.4fr)_5rem_3rem_3rem_5rem_7rem] items-center gap-2 border-b px-1 py-2.5 text-sm"
                        style={{ borderColor: "var(--mwz-flat-card-border)" }}
                      >
                        <span className="font-retro text-white/60">#{entry.rank}</span>
                        <span className="min-w-0 truncate">
                          <span className="font-retro text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</span>
                          <span className="ml-2 text-xs text-white/45">{entry.tokenName}</span>
                        </span>
                        <span>{Number(entry.points).toLocaleString()}</span>
                        <span>{entry.wins}</span>
                        <span>{entry.losses}</span>
                        <span>{Number.isFinite(Number(entry.finishedFights)) ? Number(entry.finishedFights) : "—"}</span>
                        <span className="text-[10px] uppercase tracking-[0.12em] text-white/50">{status || "—"}</span>
                      </div>
                    </TokenLink>
                  );
                })}
              </div>
              <div className="md:hidden">
                {board.table.map((entry) => (
                  <TokenLink key={entry.tokenId} tokenId={entry.tokenId}>
                    <div
                      className="flex items-center justify-between gap-2 border-b py-3"
                      style={{ borderColor: "var(--mwz-flat-card-border)" }}
                    >
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-white/42">#{entry.rank}</div>
                        <div className="truncate font-retro text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</div>
                        <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{entry.tokenName}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-retro text-sm">{Number(entry.points).toLocaleString()} PTS</div>
                        <div className="text-xs text-white/50">
                          {entry.wins}W / {entry.losses}L
                        </div>
                      </div>
                    </div>
                  </TokenLink>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <div className="py-4 text-sm text-muted-foreground" data-warzone-mwl-empty={empty.kind}>
          <div className="font-retro text-foreground">{empty.title}</div>
          <p className="mt-1">{empty.body}</p>
        </div>
      )}
    </WarzoneContent>
  );
};

export default PostGradLeague;

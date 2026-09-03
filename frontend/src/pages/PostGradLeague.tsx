import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzonePageHeader } from "@/components/warzone/WarzonePageHeader";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";
import {
  presentWarzoneFeedTone,
  presentWarzoneLeagueBoard,
  presentWarzoneLeagueEmpty,
  presentWarzoneLeagueStatus,
} from "@/lib/arena/warzoneChrome.mjs";

type LeagueTab = "regular" | "quarter_finals";

function TokenLink({
  tokenId,
  children,
}: {
  tokenId: string;
  children: ReactNode;
}) {
  const route = getArenaTokenRoute(tokenId);
  if (!route) return <div>{children}</div>;
  return (
    <Link to={route} className="block transition hover:border-accent/50">
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
  const tone = presentWarzoneFeedTone(source);
  const first = board.podium[0];
  const second = board.podium[1];
  const third = board.podium[2];

  return (
    <WarzoneContent className="space-y-5">
      <WarzonePageHeader
        title="Major War League"
        copy="Weekly table for graduated MemeWarzone coins and approved imports. Win 3 / loss 1 / draw 0. Prize Leagues stay on /league."
      >
        {season.label ? <TacticalTag label={season.label} tone="default" /> : null}
        <TacticalTag label={`Week ${season.week || 1}`} tone="default" />
        <TacticalTag label={tone.label} tone={tone.tone as "success" | "default"} />
      </WarzonePageHeader>

      <div className="inline-flex flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1">
        <button
          type="button"
          onClick={() => setTab("regular")}
          className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${tab === "regular" ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Regular season
        </button>
        <button
          type="button"
          onClick={() => setTab("quarter_finals")}
          className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${tab === "quarter_finals" ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Quarter Finals
        </button>
      </div>

      {tab === "quarter_finals" ? (
        <section className="mwz-hud-frame p-5" data-warzone-mwl-quarter-finals="true">
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Quarter Finals</div>
          <h2 className="mt-1 font-retro text-lg text-foreground">Top 8 qualify</h2>
          {quarterFinalsId ? (
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>Quarter Finals are a system tournament seeded from this table.</p>
              <Link
                to={`/warzone/tournament/${encodeURIComponent(quarterFinalsId)}`}
                className="inline-flex min-h-11 items-center border border-orange-400/35 bg-orange-500/10 px-4 text-xs uppercase tracking-[0.16em] text-orange-100 hover:bg-orange-500/20"
              >
                Enter Quarter Finals
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Quarter Finals open when the table is frozen. Ops freeze this table and seed the top 8 coins with at least 3 finished fights.
            </p>
          )}
        </section>
      ) : season.entries.length ? (
        <>
          <section data-warzone-mwl-podium="true" className="grid gap-3 md:grid-cols-3">
            {first ? (
              <TokenLink tokenId={first.tokenId}>
                <div className="mwz-hud-frame flex flex-col items-center p-4 text-center md:col-start-2 md:row-start-1">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-orange-200">#1</div>
                  <div className="mt-3">
                    <WarzoneTokenMark symbol={first.symbol} name={first.tokenName} size="lg" />
                  </div>
                  <div className="mt-3 font-retro text-lg text-foreground">${String(first.symbol || "").replace(/^\$/, "")}</div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-white/50">{first.tokenName}</div>
                  <div className="mt-2 font-retro text-xl text-orange-100">{Number(first.points).toLocaleString()} PTS</div>
                  <div className="text-xs text-white/55">
                    {first.wins}W / {first.losses}L
                  </div>
                </div>
              </TokenLink>
            ) : null}
            {second ? (
              <TokenLink tokenId={second.tokenId}>
                <div className="mwz-hud-frame flex items-center gap-3 p-4 md:col-start-1 md:row-start-1 md:flex-col md:text-center">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/55">#2</div>
                  <WarzoneTokenMark symbol={second.symbol} name={second.tokenName} />
                  <div className="min-w-0">
                    <div className="font-retro text-foreground">${String(second.symbol || "").replace(/^\$/, "")}</div>
                    <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{second.tokenName}</div>
                    <div className="mt-1 text-sm text-white/80">{Number(second.points).toLocaleString()} PTS</div>
                    <div className="text-xs text-white/50">
                      {second.wins}W / {second.losses}L
                    </div>
                  </div>
                </div>
              </TokenLink>
            ) : null}
            {third ? (
              <TokenLink tokenId={third.tokenId}>
                <div className="mwz-hud-frame flex items-center gap-3 p-4 md:col-start-3 md:row-start-1 md:flex-col md:text-center">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/55">#3</div>
                  <WarzoneTokenMark symbol={third.symbol} name={third.tokenName} />
                  <div className="min-w-0">
                    <div className="font-retro text-foreground">${String(third.symbol || "").replace(/^\$/, "")}</div>
                    <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{third.tokenName}</div>
                    <div className="mt-1 text-sm text-white/80">{Number(third.points).toLocaleString()} PTS</div>
                    <div className="text-xs text-white/50">
                      {third.wins}W / {third.losses}L
                    </div>
                  </div>
                </div>
              </TokenLink>
            ) : null}
          </section>

          {board.table.length ? (
            <section data-warzone-mwl-table="true">
              <div className="hidden md:block">
                <div className="grid grid-cols-[3.5rem_minmax(0,1.4fr)_5rem_3rem_3rem_5rem_7rem] gap-2 border-b border-white/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/42">
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
                  const row = (
                    <div className="grid grid-cols-[3.5rem_minmax(0,1.4fr)_5rem_3rem_3rem_5rem_7rem] items-center gap-2 border-b border-white/8 px-3 py-2 text-sm">
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
                  );
                  return (
                    <TokenLink key={entry.tokenId} tokenId={entry.tokenId}>
                      {row}
                    </TokenLink>
                  );
                })}
              </div>
              <div className="space-y-2 md:hidden">
                {board.table.map((entry) => (
                  <TokenLink key={entry.tokenId} tokenId={entry.tokenId}>
                    <div className="mwz-hud-frame p-3">
                      <div className="flex items-center justify-between gap-2">
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
                    </div>
                  </TokenLink>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <div className="mwz-hud-frame p-5 text-sm text-muted-foreground" data-warzone-mwl-empty={empty.kind}>
          <div className="font-retro text-foreground">{empty.title}</div>
          <p className="mt-1">{empty.body}</p>
        </div>
      )}
    </WarzoneContent>
  );
};

export default PostGradLeague;

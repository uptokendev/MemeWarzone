import { useState } from "react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";

type LeagueTab = "regular" | "quarter_finals";

const PostGradLeague = () => {
  const { season, source } = useArenaLeagueFeed();
  const [tab, setTab] = useState<LeagueTab>("regular");
  const quarterFinalsId = (season as { quarterFinalsTournamentId?: string }).quarterFinalsTournamentId;

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Arena</div>
            <h1 className="mt-1 font-retro text-2xl text-foreground">Major War League</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Weekly table for graduated MemeWarzone coins and approved imports. Prize Leagues stay on /league.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {season.label ? <TacticalTag label={season.label} tone="default" /> : null}
            <TacticalTag label={`Week ${season.week || 1}`} tone="default" />
            <TacticalTag label={source === "api" ? "Live data" : source === "empty" ? "Feed unavailable" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
          </div>
        </div>
        <div className="mt-4 inline-flex flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1">
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
      </section>

      {tab === "quarter_finals" ? (
        <section className="mwz-hud-frame p-5 text-sm text-muted-foreground">
          {quarterFinalsId ? (
            <div className="space-y-3">
              <p>Quarter Finals are a system tournament seeded from this table.</p>
              <Button asChild size="sm" variant="outline" className="font-retro">
                <Link to={`/arena/tournament/${encodeURIComponent(quarterFinalsId)}`}>Open Quarter Finals</Link>
              </Button>
            </div>
          ) : (
            "Quarter Finals open at the end of the quarter. The top of this table is seeded automatically."
          )}
        </section>
      ) : (
        <section className="space-y-3">
          {season.entries.length ? (
            season.entries.map((entry, index) => {
              const tokenRoute = getArenaTokenRoute(entry.tokenId);
              const row = (
                <div className="mwz-hud-frame flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="font-retro text-sm text-foreground">
                      #{index + 1} {entry.tokenName} <span className="text-muted-foreground">{entry.symbol}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {entry.points} pts · {entry.wins}W / {entry.losses}L
                    </div>
                  </div>
                </div>
              );
              return tokenRoute ? (
                <Link key={entry.tokenId} to={tokenRoute} className="block transition hover:border-accent/50">
                  {row}
                </Link>
              ) : (
                <div key={entry.tokenId}>{row}</div>
              );
            })
          ) : (
            <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
              {source === "empty"
                ? "Major War League data is not available right now."
                : "Standings appear once battles and tournaments produce results."}
            </div>
          )}
        </section>
      )}
    </ContentContainer>
  );
};

export default PostGradLeague;

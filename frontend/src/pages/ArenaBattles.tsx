import { useMemo, useState } from "react";
import { ArenaMatchRow } from "@/components/postgrad/ArenaMatchRow";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaFeedBattleMetrics } from "@/hooks/useArenaFeedBattleMetrics";
import type { Battle } from "@/features/postgrad/contracts";
import { publicBattleLane, type PublicBattleLane } from "@/lib/arena/publicBattleState";

const TABS: Array<{ key: PublicBattleLane; label: string }> = [
  { key: "live", label: "Live" },
  { key: "waiting", label: "Waiting" },
  { key: "finished", label: "Finished" },
];

const ArenaBattles = () => {
  const { liveBattles, openForBattleQueue, archivedBattles, source } = useArenaBattleFeed();
  const [tab, setTab] = useState<PublicBattleLane>("live");

  const rows = useMemo(() => {
    const waiting = openForBattleQueue.filter((battle) => publicBattleLane(battle.state) === "waiting");
    const live = liveBattles.filter((battle) => publicBattleLane(battle.state) === "live");
    const finished = archivedBattles.map((entry) => entry.battle).filter((battle) => publicBattleLane(battle.state) === "finished");
    if (tab === "waiting") return waiting;
    if (tab === "finished") return finished;
    return live;
  }, [archivedBattles, liveBattles, openForBattleQueue, tab]);
  const feedMetrics = useArenaFeedBattleMetrics(rows);

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Warzone</div>
            <h1 className="mt-1 font-retro text-2xl text-foreground">Battles</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Watch live fights, waiting coins, and recent results. Creators start fights in Command Center.
            </p>
          </div>
          <TacticalTag label={source === "api" ? "Live data" : source === "empty" ? "Feed unavailable" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
        </div>
        <div className="mt-4 inline-flex flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${tab === item.key ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        {rows.length ? (
          rows.map((battle: Battle) => (
            <ArenaMatchRow
              key={battle.id}
              battle={battle}
              metrics={feedMetrics.metricsById[battle.id]}
              metricsRequested={feedMetrics.requestedIds.includes(battle.id)}
              metricsLoaded={feedMetrics.loaded}
            />
          ))
        ) : (
          <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
            {source === "empty"
              ? "Battle data is not available right now."
              : tab === "live"
                ? "No live battles right now."
                : tab === "waiting"
                  ? "No coins are waiting for a match."
                  : "Finished battles will appear here."}
          </div>
        )}
      </section>
    </ContentContainer>
  );
};

export default ArenaBattles;

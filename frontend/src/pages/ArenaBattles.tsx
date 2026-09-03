import { useMemo, useState } from "react";
import { BattleWallModule } from "@/components/arena/BattleWallModule";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaFeedBattleMetrics } from "@/hooks/useArenaFeedBattleMetrics";
import {
  collectWallBattles,
  filterWallBattles,
  presentBattleWallModule,
  sortWallBattles,
} from "@/lib/arena/battleWallPresentation.mjs";
import { getAllowedChainIds, isRobinhoodChainId } from "@/lib/chainConfig";

const TABS = [
  { key: "live", label: "Live" },
  { key: "upcoming", label: "Upcoming" },
  { key: "finished", label: "Finished" },
] as const;

const TYPES = [
  { key: "all", label: "All" },
  { key: "manual", label: "Manual" },
  { key: "auto_deploy", label: "AUTO DEPLOY / Queue" },
  { key: "tournament", label: "Tournament" },
] as const;

const SORTS = [
  { key: "default", label: "Default" },
  { key: "ending_soon", label: "Ending soon" },
  { key: "closest_fight", label: "Closest fight" },
  { key: "newest", label: "Newest" },
] as const;

export default function ArenaBattles() {
  const feed = useArenaBattleFeed();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("live");
  const [chain, setChain] = useState("all");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("default");
  const [search, setSearch] = useState("");
  const robinhood = getAllowedChainIds().some((id) => isRobinhoodChainId(id));

  const tabRows = useMemo(() => collectWallBattles(feed, tab), [feed, tab]);
  const filtered = useMemo(
    () => filterWallBattles(tabRows, { chain, type, search }),
    [tabRows, chain, type, search],
  );
  const feedMetrics = useArenaFeedBattleMetrics(filtered);
  const presentations = useMemo(() => {
    const map = new Map();
    for (const battle of filtered) {
      map.set(
        battle.id,
        presentBattleWallModule(battle, feedMetrics.metricsById[battle.id], {
          requested: feedMetrics.requestedIds.includes(battle.id),
          loaded: feedMetrics.loaded,
        }),
      );
    }
    return map;
  }, [filtered, feedMetrics]);
  const rows = useMemo(() => sortWallBattles(filtered, sort, presentations), [filtered, sort, presentations]);

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Warzone</div>
            <h1 className="mt-1 font-retro text-2xl text-foreground">Battles</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              The wars happening across MemeWarzone right now.
            </p>
          </div>
          <TacticalTag label={feed.source === "api" ? "Live data" : feed.source === "empty" ? "Feed unavailable" : "Awaiting data"} tone={feed.source === "api" ? "success" : "default"} />
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
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Chain
            <select className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground" value={chain} onChange={(event) => setChain(event.target.value)}>
              <option value="all">All</option>
              <option value="bnb">BNB</option>
              <option value="solana">Solana</option>
              {robinhood ? <option value="robinhood">Robinhood</option> : null}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Battle type
            <select className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground" value={type} onChange={(event) => setType(event.target.value)}>
              {TYPES.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Sort
            <select className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground" value={sort} onChange={(event) => setSort(event.target.value)}>
              {SORTS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Search token
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
              placeholder="$TICKER / name"
            />
          </label>
        </div>
      </section>

      <section className="space-y-4" data-battle-wall>
        {rows.length ? (
          rows.map((battle) => (
            <BattleWallModule
              key={battle.id}
              battle={battle}
              metrics={feedMetrics.metricsById[battle.id]}
              metricsRequested={feedMetrics.requestedIds.includes(battle.id)}
              metricsLoaded={feedMetrics.loaded}
            />
          ))
        ) : (
          <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
            {feed.source === "empty"
              ? "Battle data is not available right now."
              : tab === "live"
                ? "No live battles right now."
                : tab === "upcoming"
                  ? "No upcoming deployments."
                  : "Finished battles will appear here."}
          </div>
        )}
      </section>
    </ContentContainer>
  );
}

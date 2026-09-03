import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { BattleWallModule } from "@/components/arena/BattleWallModule";
import { CreatorChallengeCarousel } from "@/components/arena/CreatorChallengeCarousel";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  acceptPostGradBattle,
  counterPostGradBattle,
  declinePostGradBattle,
  fetchPostGradBattleDetails,
} from "@/features/postgrad/apiClient";
import type { Battle } from "@/features/postgrad/contracts";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useArenaFeedBattleMetrics } from "@/hooks/useArenaFeedBattleMetrics";
import { useBattleWallFocus } from "@/hooks/useBattleWallFocus";
import type { BattleWallViewportReport } from "@/hooks/useBattleWallViewport";
import { parseBattleDurationHours } from "@/lib/arena/battleDuration";
import { collectIncomingCreatorChallenges } from "@/lib/arena/creatorChallengePresentation.mjs";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import {
  collectWallBattles,
  commitFocusedFetch,
  filterWallBattles,
  findBattleInFeed,
  focusedRouteStatus,
  focusedWallFilterReset,
  mergeFocusedBattleForRoute,
  presentBattleWallModule,
  resolveFocusedWallBattle,
  shouldApplyFocusedWallReset,
  sortWallBattles,
  wallEmptyCopy,
  wallTabForBattle,
} from "@/lib/arena/battleWallPresentation.mjs";
import {
  sameIdList,
  selectActiveWallRealtimeIds,
  upsertWallViewportReport,
} from "@/lib/arena/battleWallRealtime.mjs";
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

function asBattle(value: unknown): Battle | null {
  const battle = value as Battle | null;
  if (!battle?.id || !battle?.state || !Array.isArray(battle.participants)) return null;
  return battle;
}

export default function ArenaBattles() {
  const { battleId } = useParams();
  const focusedId = String(battleId || "").trim();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feedWallet = useActiveFeedWallet();
  const feed = useArenaBattleFeed(feedWallet.address, feedWallet.chainId);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("live");
  const [chain, setChain] = useState("all");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("default");
  const [search, setSearch] = useState("");
  const [fetched, setFetched] = useState<{ battleId: string; battle: Battle | null } | null>(null);
  const appliedFocus = useRef("");
  const focusRequestSeq = useRef(0);
  const focusedIdRef = useRef(focusedId);
  const viewportReports = useRef(new Map());
  const [activeRealtimeIds, setActiveRealtimeIds] = useState<string[]>([]);
  const robinhood = getAllowedChainIds().some((id) => isRobinhoodChainId(id));
  focusedIdRef.current = focusedId;

  const reportViewport = useCallback((report: BattleWallViewportReport) => {
    viewportReports.current = upsertWallViewportReport(viewportReports.current, report);
    const next = selectActiveWallRealtimeIds([...viewportReports.current.values()], {
      focusedId: focusedIdRef.current,
    });
    setActiveRealtimeIds((current) => (sameIdList(current, next) ? current : next));
  }, []);

  useEffect(() => {
    const next = selectActiveWallRealtimeIds([...viewportReports.current.values()], { focusedId });
    setActiveRealtimeIds((current) => (sameIdList(current, next) ? current : next));
  }, [focusedId]);
  const inFeed = useMemo(() => findBattleInFeed(feed, focusedId), [feed, focusedId]);
  const focusedBattle = resolveFocusedWallBattle(focusedId, inFeed, fetched);
  const focusStatus = focusedRouteStatus(focusedId, inFeed, fetched);

  useEffect(() => {
    const seq = ++focusRequestSeq.current;
    if (!focusedId) {
      setFetched(null);
      appliedFocus.current = "";
      return;
    }
    setFetched((prev) => (prev && String(prev.battleId) === focusedId ? prev : null));
    if (inFeed) return;
    if (feed.loading) return;
    const controller = new AbortController();
    void fetchPostGradBattleDetails(focusedId, controller.signal)
      .then((json) => {
        if (seq !== focusRequestSeq.current) return;
        const committed = commitFocusedFetch(focusedId, asBattle(json?.battle ?? json));
        if (!committed) return;
        setFetched(committed);
      })
      .catch(() => {
        if (seq !== focusRequestSeq.current) return;
        if (controller.signal.aborted) return;
        setFetched(commitFocusedFetch(focusedId, null));
      });
    return () => controller.abort();
  }, [focusedId, inFeed, feed.loading]);

  useEffect(() => {
    if (!shouldApplyFocusedWallReset(appliedFocus.current, focusedId, focusedBattle)) return;
    const reset = focusedWallFilterReset(focusedBattle);
    appliedFocus.current = focusedId;
    setTab(reset.tab);
    setChain(reset.chain);
    setType(reset.type);
    setSearch(reset.search);
  }, [focusedId, focusedBattle]);

  const tabRows = useMemo(() => {
    const collected = collectWallBattles(feed, tab);
    return mergeFocusedBattleForRoute(collected, focusedBattle, tab, focusedId);
  }, [feed, tab, focusedBattle, focusedId]);
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
  const incomingChallenges = useMemo(
    () => collectIncomingCreatorChallenges(feed.openForBattleQueue, feed.creatorStatuses, feedWallet.address),
    [feed.creatorStatuses, feed.openForBattleQueue, feedWallet.address],
  );

  async function signChallenge(action: string, extraLines: string[]) {
    return signArenaWalletAction({
      action,
      extraLines,
      walletAddress: String(feedWallet.address || ""),
      chainId: feedWallet.chainId,
      evmWallet: wallet,
      solanaAccount,
    });
  }

  async function handleAcceptChallenge(battleId: string) {
    const auth = await signChallenge("arena_accept_battle", [`Battle: ${battleId}`]);
    const result = await acceptPostGradBattle(battleId, auth);
    await feed.refreshFeed();
    toast.success(
      result?.battle?.state === "matched" || result?.escrowRequired
        ? "Accepted. Pay your on-chain stake to start the fight."
        : "Challenge accepted.",
    );
  }

  async function handleDeclineChallenge(battleId: string) {
    const auth = await signChallenge("arena_decline_battle", [`Battle: ${battleId}`]);
    await declinePostGradBattle(battleId, auth);
    await feed.refreshFeed();
    toast.success("Challenge declined.");
  }

  async function handleCounterChallenge(battleId: string, stake: string, durationHours: number) {
    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Enter a counter-offer stake greater than zero.");
    }
    const hours = parseBattleDurationHours(durationHours, 24);
    const auth = await signChallenge("arena_counter_battle", [`Battle: ${battleId}`, `Stake: ${amount}`, `Duration: ${hours}`]);
    await counterPostGradBattle(battleId, amount, auth, hours);
    await feed.refreshFeed();
    toast.success("Counter-offer sent.");
  }
  const focusedReady = Boolean(
    focusedId &&
      focusedBattle &&
      String(focusedBattle.id) === focusedId &&
      wallTabForBattle(focusedBattle) === tab &&
      rows.some((row) => row.id === focusedBattle.id),
  );
  useBattleWallFocus(focusedReady ? focusedId : "", focusedReady);
  const empty = wallEmptyCopy({
    source: feed.source,
    tab,
    loading: feed.loading,
    focusedLoading: Boolean(focusedId && focusStatus === "loading"),
    tabCount: tabRows.length,
    filteredCount: rows.length,
  });
  const controlClass =
    "mt-1 w-full min-w-0 rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <WarzoneContent className="space-y-4">
      <section className="mwz-hud-frame space-y-3 p-3 md:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Warzone</div>
            <h1 className="font-retro text-xl text-foreground md:text-2xl">Battles</h1>
          </div>
          <TacticalTag label={feed.source === "api" ? "Live data" : feed.source === "empty" ? "Feed unavailable" : "Awaiting data"} tone={feed.source === "api" ? "success" : "default"} />
        </div>
        <div className="inline-flex max-w-full flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1" role="tablist" aria-label="Battle state">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={`rounded px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tab === item.key ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          <label className="min-w-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            All chains
            <select className={controlClass} value={chain} onChange={(event) => setChain(event.target.value)} aria-label="Filter by chain">
              <option value="all">All</option>
              <option value="bnb">BNB</option>
              <option value="solana">Solana</option>
              {robinhood ? <option value="robinhood">Robinhood</option> : null}
            </select>
          </label>
          <label className="min-w-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            All types
            <select className={controlClass} value={type} onChange={(event) => setType(event.target.value)} aria-label="Filter by battle type">
              {TYPES.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Sort
            <select className={controlClass} value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort battles">
              {SORTS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Search
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={controlClass}
              placeholder="$TICKER / name"
              aria-label="Search token"
            />
          </label>
        </div>
      </section>

      <CreatorChallengeCarousel
        challenges={incomingChallenges}
        chainId={feedWallet.chainId}
        onAccept={handleAcceptChallenge}
        onDecline={handleDeclineChallenge}
        onCounter={handleCounterChallenge}
      />

      {focusedId && focusStatus === "unavailable" ? (
        <div className="mwz-hud-frame p-4 text-sm text-muted-foreground" data-battle-unavailable="true" role="status">
          <div className="font-retro text-base text-foreground">Battle unavailable.</div>
          <p className="mt-1">This fight is private, missing, or not a public Battle Wall battle.</p>
        </div>
      ) : null}

      <section className="min-w-0 space-y-4" data-battle-wall>
        {rows.length ? (
          rows.map((battle, index) => (
            <BattleWallModule
              key={battle.id}
              battle={battle}
              metrics={feedMetrics.metricsById[battle.id]}
              metricsRequested={feedMetrics.requestedIds.includes(battle.id)}
              metricsLoaded={feedMetrics.loaded}
              realtimeActive={activeRealtimeIds.includes(battle.id)}
              viewportIndex={index}
              onViewportReport={reportViewport}
            />
          ))
        ) : empty.kind === "loading" || empty.kind === "loading-focus" ? (
          <div className="space-y-3" data-battle-wall-empty={empty.kind} role="status">
            <div className="text-sm text-muted-foreground">{empty.title}</div>
            <div className="space-y-3" data-battle-wall-skeleton="true" aria-hidden="true">
              {[0, 1].map((slot) => (
                <div key={slot} className="mwz-hud-frame animate-pulse p-4">
                  <div className="h-3 w-16 rounded bg-white/10" />
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="h-24 rounded bg-white/5" />
                    <div className="h-16 rounded bg-white/5" />
                    <div className="h-24 rounded bg-white/5" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mwz-hud-frame p-5" data-battle-wall-empty={empty.kind} role="status">
            <div className="font-retro text-base text-foreground">{empty.title}</div>
            <p className="mt-1 text-sm text-muted-foreground">{empty.body}</p>
          </div>
        )}
      </section>
    </WarzoneContent>
  );
}

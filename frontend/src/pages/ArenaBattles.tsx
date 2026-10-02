import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Swords } from "lucide-react";
import { toast } from "sonner";
import { BattleWallModule } from "@/components/arena/BattleWallModule";
import { ChallengeCoinModal } from "@/components/arena/ChallengeCoinModal";
import { CreatorChallengeCarousel } from "@/components/arena/CreatorChallengeCarousel";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
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
import { collectIncomingCreatorChallenges, creatorOwnedIdentityKeys } from "@/lib/arena/creatorChallengePresentation.mjs";
import { requestArenaBuyIn, shouldOpenBuyInAfterAccept } from "@/lib/arena/challengePopupPresentation.mjs";
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
  wallPhaseForBattle,
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
  { key: "mine", label: "My Battles" },
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
  // `?tab=` lets the battle page's list tabs open the right list (UI redesign phase 4b).
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>(() => {
    const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return (TABS.find((item) => item.key === requested)?.key || "live") as (typeof TABS)[number]["key"];
  });
  const [chain, setChain] = useState("all");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("default");
  const [search, setSearch] = useState("");
  const [challengeOpen, setChallengeOpen] = useState(false);
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

  const ownedKeys = useMemo(
    () => creatorOwnedIdentityKeys(feed.creatorStatuses),
    [feed.creatorStatuses],
  );
  const tabRows = useMemo(() => {
    const collected = collectWallBattles(feed, tab, {
      ownedKeys,
      walletAddress: feedWallet.address,
      creatorStatuses: feed.creatorStatuses,
    });
    return mergeFocusedBattleForRoute(collected, focusedBattle, tab, focusedId);
  }, [feed, tab, focusedBattle, focusedId, ownedKeys, feedWallet.address]);
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
    if (shouldOpenBuyInAfterAccept(result, result?.battle) && result?.battle) {
      requestArenaBuyIn(result.battle);
      toast.success("Accepted. Pay your buy-in.");
    } else {
      toast.success("Challenge accepted.");
    }
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
    walletConnected: Boolean(feedWallet.address),
  });
  const controlClass =
    "mw-focus h-11 w-full min-w-0 rounded-[10px] border border-mw-edge bg-mw-input px-3 font-mw-body text-[15px] normal-case tracking-normal text-mw-text placeholder:text-[#7C858F] focus-visible:outline-none";
  const filterLabel = "flex min-w-0 flex-col gap-1.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const heroFirst = tab === "live" && !focusedId;

  return (
    <WarzoneContent className="flex flex-col gap-4 font-mw-body text-mw-text">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3.5">
          <div>
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Warzone</div>
            <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Battles</h1>
          </div>
          <Button
            type="button"
            className="mw-focus ml-auto inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] lg:ml-0"
            data-challenge-coin-cta="true"
            onClick={() => setChallengeOpen(true)}
          >
            <Swords className="h-5 w-5" aria-hidden="true" />
            <span className="lg:hidden">Challenge</span>
            <span className="hidden lg:inline">Challenge a coin</span>
          </Button>
          <span className="hidden flex-1 lg:block" />
          <span
            className={`hidden h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-semibold lg:inline-flex ${feed.source === "api" ? "border-[#1F5133] bg-[#171B20] text-[#6EE7A0]" : "border-mw-edge bg-[#171B20] text-[#C9CED4]"}`}
          >
            {feed.source === "api" ? <span className="h-2 w-2 rounded-full bg-mw-up" aria-hidden="true" /> : null}
            {feed.source === "api" ? "Live data" : feed.source === "empty" ? "Feed unavailable" : "Awaiting data"}
          </span>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-[#2A3038] bg-mw-input p-1 [scrollbar-width:none] lg:w-max [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Battle state">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={`mw-focus min-h-10 shrink-0 rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] transition-colors ${tab === item.key ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 items-end gap-2 lg:grid-cols-[1fr_1fr_1fr_1.2fr] lg:gap-3">
          <label className={filterLabel}>
            <span className="hidden lg:inline">All chains</span>
            <select className={controlClass} value={chain} onChange={(event) => setChain(event.target.value)} aria-label="Filter by chain">
              <option value="all">All</option>
              <option value="bnb">BNB</option>
              <option value="solana">Solana</option>
              {robinhood ? <option value="robinhood">Robinhood</option> : null}
            </select>
          </label>
          <label className={filterLabel}>
            <span className="hidden lg:inline">All types</span>
            <select className={controlClass} value={type} onChange={(event) => setType(event.target.value)} aria-label="Filter by battle type">
              {TYPES.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={filterLabel}>
            <span className="hidden lg:inline">Sort</span>
            <select className={controlClass} value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort battles">
              {SORTS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={filterLabel}>
            <span className="hidden lg:inline">Search</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={controlClass}
              placeholder="$TICKER / name"
              aria-label="Search token"
            />
          </label>
        </div>
      </section>

      <ChallengeCoinModal
        open={challengeOpen}
        onOpenChange={setChallengeOpen}
        walletAddress={feedWallet.address}
        chainId={feedWallet.chainId}
        onSent={() => void feed.refreshFeed()}
      />

      <CreatorChallengeCarousel
        challenges={incomingChallenges}
        chainId={feedWallet.chainId}
        onAccept={handleAcceptChallenge}
        onDecline={handleDeclineChallenge}
        onCounter={handleCounterChallenge}
      />

      {focusedId && focusStatus === "unavailable" ? (
        <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 text-sm text-mw-muted" data-battle-unavailable="true" role="status">
          <div className="font-mw-cond text-xl font-bold text-mw-text">Battle unavailable.</div>
          <p className="mt-1">This fight is private, missing, or not a public Battle Wall battle.</p>
        </div>
      ) : null}

      <section className="flex min-w-0 flex-col gap-4" data-battle-wall>
        {rows.length ? (
          rows.map((battle, index) => (
            <div key={battle.id} className="contents">
              {heroFirst && index === 1 ? (
                <div className="mt-1.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                  More live battles · {rows.length - 1}
                </div>
              ) : null}
              <BattleWallModule
                key={battle.id}
                battle={battle}
                metrics={feedMetrics.metricsById[battle.id]}
                metricsRequested={feedMetrics.requestedIds.includes(battle.id)}
                metricsLoaded={feedMetrics.loaded}
                realtimeActive={activeRealtimeIds.includes(battle.id)}
                viewportIndex={index}
                onViewportReport={reportViewport}
                showBuyIn={tab === "mine" && wallPhaseForBattle(battle) === "matched"}
                variant={heroFirst && index === 0 ? "hero" : "list"}
              />
            </div>
          ))
        ) : empty.kind === "loading" || empty.kind === "loading-focus" ? (
          <div className="flex flex-col gap-3" data-battle-wall-empty={empty.kind} role="status">
            <div className="text-sm text-mw-muted">{empty.title}</div>
            <div className="flex flex-col gap-3" data-battle-wall-skeleton="true" aria-hidden="true">
              {[0, 1].map((slot) => (
                <div key={slot} className="animate-pulse rounded-[14px] border border-mw-border bg-mw-surface p-4">
                  <div className="h-3 w-16 rounded bg-mw-border" />
                  <div className="mt-4 grid gap-3 lg:grid-cols-3">
                    <div className="h-24 rounded bg-mw-input" />
                    <div className="h-16 rounded bg-mw-input" />
                    <div className="h-24 rounded bg-mw-input" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-[14px] border border-mw-border bg-mw-surface p-5" data-battle-wall-empty={empty.kind} role="status">
            <div className="font-mw-cond text-xl font-bold text-mw-text">{empty.title}</div>
            <p className="mt-1 text-sm text-mw-muted">{empty.body}</p>
          </div>
        )}
      </section>
    </WarzoneContent>
  );
}

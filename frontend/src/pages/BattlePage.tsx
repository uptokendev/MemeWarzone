/**
 * Single battle page (UI redesign phase 4b, artboard Battle / BattleMobile). The fight is the same
 * BattleWallModule as the list (votes, boosts, realtime, buy-in, claim, share unchanged), framed as the
 * page banner. Around it: live activity, comments (N8), supporters, prize pool breakdown and rules.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { BarChart3, Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { BattleWallModule } from "@/components/arena/BattleWallModule";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { fetchPostGradBattleDetails } from "@/features/postgrad/apiClient";
import type { Battle } from "@/features/postgrad/contracts";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaFeedBattleMetrics } from "@/hooks/useArenaFeedBattleMetrics";
import { getActiveWalletKind } from "@/lib/activeWalletChain";
import { battleRules } from "@/lib/arena/battlePageRules.mjs";
import { formatPrizePool, useBattlePrizePool } from "@/components/arena/useBattlePrizePool";
import { fetchBattleBoostState } from "@/lib/arena/battleBoostClient";
import { useQuery } from "@tanstack/react-query";
import { useBattleActivity, useBattleComments, useBattleEntries, usePostBattleComment, normalizeBattleCommentText, type BattleComment } from "@/lib/arena/battlePageApi";
import { creatorOwnedIdentityKeys } from "@/lib/arena/creatorChallengePresentation.mjs";
import { collectWallBattles, findBattleInFeed, presentBattleWallModule, wallPhaseForBattle } from "@/lib/arena/battleWallPresentation.mjs";
import { relativeTime } from "@/lib/coinPageFeed.mjs";
import { getNativeSymbol } from "@/lib/chainConfig";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";
import { cn } from "@/lib/utils";

const LIST_TABS = [
  { key: "live", label: "Live" },
  { key: "upcoming", label: "Upcoming" },
  { key: "mine", label: "My battles" },
  { key: "finished", label: "Finished" },
] as const;

type PageTab = "live" | "comments" | "supporters" | "pool" | "rules";

const card = "rounded-[14px] border border-mw-border bg-mw-surface";
const cardTitle = "font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text";
const label = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";

function shortWallet(value: string) {
  const v = String(value || "");
  return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-3)}` : v || "—";
}

function amount(value: number) {
  if (!Number.isFinite(value)) return "0";
  return value >= 100 ? value.toFixed(2) : value >= 1 ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function useIsDesktop() {
  const query = "(min-width: 1024px)";
  const [desktop, setDesktop] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

/** The wallet the visitor uses right now, and a signer for it (comments only). */
function useCommentSigner() {
  const wallet = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const solana = getActiveWalletKind() === "solana" ? isSolanaConnected : isSolanaConnected && !wallet.isConnected;
  const address = solana ? String(solanaAccount || "") : String(wallet.account || "");
  const chainId = solana ? 101 : Number(wallet.chainId || 0);
  const sign = async (action: string, extraLines: string[]) => {
    if (!address) throw new Error("Connect a wallet to comment.");
    if (solana) {
      return signWalletAction({ action, walletAddress: address, chainId, extraLines, walletType: "solana", signMessage: async (m) => (await signSolanaMessage(m, address)).signature });
    }
    return signWalletAction({ action, walletAddress: address, chainId, extraLines, signer: wallet.signer as any });
  };
  return { address, chainId, sign };
}

function SideChip({ side, ticker }: { side: "left" | "right"; ticker?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold", side === "left" ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft" : "border-mw-edge bg-[#171B20] text-[#C9CED4]")}>
      {ticker ? ticker : side === "left" ? "Side A" : "Side B"}
    </span>
  );
}

function CommentCard({ comment, tickers }: { comment: BattleComment; tickers: [string, string] }) {
  const initials = comment.wallet.replace(/^0x/, "").slice(0, 2).toUpperCase();
  return (
    <article className={`${card} flex gap-3 p-3.5 lg:gap-3.5 lg:px-[18px] lg:py-4`}>
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2B3440] font-mw-cond text-base font-bold text-[#C9CED4]" aria-hidden="true">{initials}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mw-mono font-bold">{shortWallet(comment.wallet)}</span>
          {comment.side ? <SideChip side={comment.side} ticker={comment.side === "left" ? `Side A · ${tickers[0]}` : `Side B · ${tickers[1]}`} /> : null}
          <span className="text-sm text-mw-muted"><time dateTime={comment.at}>{relativeTime(comment.at)}</time></span>
        </div>
        <p className="m-0 mt-1 whitespace-pre-line break-words text-[15px]">{comment.body}</p>
      </div>
    </article>
  );
}

export default function BattlePage() {
  const { battleId = "" } = useParams();
  const id = decodeURIComponent(battleId);
  const feed = useArenaBattleFeed();
  const feedWallet = useActiveFeedWallet();
  const desktop = useIsDesktop();
  const inFeed = useMemo(() => findBattleInFeed(feed, id), [feed, id]) as Battle | null;
  const [fetched, setFetched] = useState<{ id: string; battle: Battle | null } | null>(null);

  useEffect(() => {
    if (inFeed || feed.loading || !id) return;
    const controller = new AbortController();
    void fetchPostGradBattleDetails(id, controller.signal)
      .then((json: any) => setFetched({ id, battle: (json?.battle ?? json ?? null) as Battle | null }))
      .catch(() => {
        if (!controller.signal.aborted) setFetched({ id, battle: null });
      });
    return () => controller.abort();
  }, [id, inFeed, feed.loading]);

  const battle: Battle | null = inFeed || (fetched?.id === id ? fetched.battle : null);
  const loading = !battle && (feed.loading || fetched?.id !== id);
  const metrics = useArenaFeedBattleMetrics(battle ? [battle] : []);
  const presented = battle ? presentBattleWallModule(battle, metrics.metricsById[battle.id], { requested: metrics.requestedIds.includes(battle.id), loaded: metrics.loaded }) : null;
  const chainId = Number((battle as (Battle & { chainId?: number }) | null)?.chainId || 0);
  const native = String((presented as any)?.nativeSymbol || getNativeSymbol(chainId) || "");
  const tickers: [string, string] = [String(presented?.leftTicker || "Side A"), String(presented?.rightTicker || "Side B")];

  const ownedKeys = useMemo(() => creatorOwnedIdentityKeys(feed.creatorStatuses), [feed.creatorStatuses]);
  const mine = useMemo(
    () => (battle ? collectWallBattles(feed, "mine", { ownedKeys, walletAddress: feedWallet.address }).some((b: Battle) => b.id === battle.id) : false),
    [feed, ownedKeys, feedWallet.address, battle],
  );

  const activity = useBattleActivity(battle ? id : null);
  const comments = useBattleComments(battle ? id : null);
  const entries = useBattleEntries(battle ? id : null);
  // Pool total and boost totals come from the same existing reads as the battle card's band, so the page
  // and the card always show the same number.
  const prizePool = useBattlePrizePool(battle ? id : "", Number((battle as (Battle & { chainId?: number }) | null)?.chainId || 0), Boolean(battle));
  const boostState = useQuery({
    queryKey: ["battle-boost-state", id],
    enabled: Boolean(battle),
    queryFn: () => fetchBattleBoostState(id),
    refetchInterval: 20_000,
    retry: 1,
  });
  const postComment = usePostBattleComment(id);
  const signer = useCommentSigner();
  const [tab, setTab] = useState<PageTab>("live");
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (desktop && tab === "pool") setTab("live");
  }, [desktop, tab]);

  const submit = async () => {
    const text = normalizeBattleCommentText(draft);
    if (!text || posting) return;
    setPosting(true);
    try {
      await postComment({ text, chainId: signer.chainId, walletAddress: signer.address, sign: signer.sign });
      setDraft("");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not post the comment."));
    } finally {
      setPosting(false);
    }
  };

  if (loading) {
    return <WarzoneContent className="py-10 text-center text-mw-muted">Loading battle…</WarzoneContent>;
  }
  if (!battle || !presented) {
    return (
      <WarzoneContent>
        <div className={`${card} p-5`} data-battle-unavailable="true" role="status">
          <div className="font-mw-cond text-xl font-bold text-mw-text">Battle unavailable.</div>
          <p className="mt-1 text-sm text-mw-muted">This fight is private, missing, or not a public Battle Wall battle.</p>
          <Link to="/warzone/battles" className="mt-3 inline-flex min-h-11 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-sm font-semibold text-mw-text hover:text-mw-text">All battles</Link>
        </div>
      </WarzoneContent>
    );
  }

  const listTab = presented.tab === "upcoming" ? "upcoming" : presented.tab === "finished" ? "finished" : "live";
  const entryRaw = (() => {
    const e = entries.data || {};
    try {
      const paid = (e.paidA === true ? 1n : 0n) + (e.paidB === true ? 1n : 0n);
      return BigInt(String(e.stakeWei ?? "0").split(".")[0] || "0") * paid;
    } catch {
      return 0n;
    }
  })();
  const decimals = chainId === 101 || chainId === 102 ? 9 : 18;
  const entriesNative = Number(entryRaw) / 10 ** decimals;
  const boostTotal = (boostState.data as { summary?: { total?: { boostUnits?: string; grossNativeRaw?: string } } } | undefined)?.summary?.total;
  const boostCount = Number(boostTotal?.boostUnits || 0);
  const boostGross = (() => {
    try {
      return Number(BigInt(String(boostTotal?.grossNativeRaw || "0").split(".")[0] || "0")) / 10 ** decimals;
    } catch {
      return 0;
    }
  })();
  const supporters = activity.data?.supporters || [];
  const items = activity.data?.activity || [];
  const commentList = comments.data?.comments || [];
  const rules = battleRules(battle as any);
  const voteMode = String((battle as any)?.battleMode || "").toLowerCase() === "vote";

  const pageTabs: Array<{ key: PageTab; label: string }> = [
    { key: "live", label: "Live" },
    { key: "comments", label: "Comments" },
    { key: "supporters", label: "Supporters" },
    ...(desktop ? [] : [{ key: "pool" as PageTab, label: "Pool" }]),
    { key: "rules", label: "Rules" },
  ];

  const composer = (
    <section className={`${card} flex items-center gap-3 p-3 lg:gap-3.5 lg:px-[18px] lg:py-3.5`} aria-label="Write a comment">
      <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2B3440] font-mw-cond text-[15px] font-bold text-[#C9CED4] lg:inline-flex" aria-hidden="true">
        {signer.address ? signer.address.replace(/^0x/, "").slice(0, 2).toUpperCase() : "?"}
      </span>
      <input
        type="text"
        maxLength={280}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder={signer.address ? "Say something to both camps" : "Connect a wallet to comment"}
        aria-label="Write a comment"
        disabled={!signer.address}
        className="mw-focus h-11 min-w-0 flex-1 rounded-[10px] border border-mw-edge bg-mw-input px-3.5 text-[15px] text-mw-text placeholder:text-[#7C858F] focus-visible:outline-none disabled:opacity-60"
      />
      <button type="button" onClick={() => void submit()} disabled={!signer.address || !normalizeBattleCommentText(draft) || posting} className="mw-focus inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-60">
        {posting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        Post
      </button>
    </section>
  );

  const activityRows = (limit?: number) =>
    (limit ? items.slice(0, limit) : items).map((item) => (
      <div key={item.id} className="flex items-center gap-3 rounded-xl border border-mw-border bg-mw-input px-3 py-2.5 text-[13px] lg:px-4 lg:text-sm">
        {item.kind === "boost" ? <Zap className="h-[18px] w-[18px] shrink-0 text-[#FF9A4D]" aria-hidden="true" /> : <BarChart3 className="h-[18px] w-[18px] shrink-0 text-mw-muted" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          {item.kind === "boost"
            ? `${shortWallet(item.wallet)} boosted ${tickers[item.side === "left" ? 0 : 1]} with ${amount(item.amountNative)} ${native}`
            : `${item.count} new vote${item.count === 1 ? "" : "s"} for ${tickers[item.side === "left" ? 0 : 1]} in ${item.windowMinutes} minutes`}
        </span>
        <span className="shrink-0 text-mw-muted"><time dateTime={item.at}>{relativeTime(item.at)}</time></span>
      </div>
    ));

  const poolCard = (
    <section className={`${card} flex flex-col gap-3 p-4`} aria-label="Prize pool">
      <span className={label}>Prize pool</span>
      <span className="-mt-2 font-mw-mono text-[28px] font-bold lg:text-[34px]">{prizePool ? formatPrizePool(prizePool) : `0 ${native}`}</span>
      {voteMode ? <p className="m-0 text-[15px]">The more boosts, the more money there is to win. There is no limit on boosts.</p> : null}
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-mw-border bg-mw-input p-3 text-sm">
        <div className="flex justify-between gap-2"><span className="text-mw-muted">Entries</span><span className="font-mw-mono">{amount(entriesNative)} {native}</span></div>
        <div className="flex justify-between gap-2"><span className="text-mw-muted">{boostCount} boost{boostCount === 1 ? "" : "s"}</span><span className="font-mw-mono">{amount(boostGross)} {native}</span></div>
      </div>
    </section>
  );

  const supporterRows = (limit?: number) =>
    supporters.length ? (
      (limit ? supporters.slice(0, limit) : supporters).map((s) => (
        <div key={`${s.wallet}-${s.side}`} className="flex items-center gap-2.5 text-sm">
          <span className="w-[18px] font-mw-mono font-bold text-mw-muted">{s.rank}</span>
          <span className="min-w-0 flex-1 truncate font-mw-mono">{shortWallet(s.wallet)}</span>
          <span className="inline-flex h-[22px] items-center rounded-full border border-mw-edge bg-[#171B20] px-2 text-xs font-semibold text-[#C9CED4]">{tickers[s.side === "left" ? 0 : 1]}</span>
          <span className="w-20 text-right font-mw-mono">{amount(s.amountNative)} {native}</span>
        </div>
      ))
    ) : (
      <p className="m-0 text-sm text-mw-muted">No boosts yet.</p>
    );

  const rulesCard = (
    <section className={`${card} flex flex-col gap-1.5 p-4`} aria-label="Rules">
      <span className={cardTitle}>Rules</span>
      {rules.map((line) => (
        <p key={line} className="m-0 text-sm text-mw-muted">{line}</p>
      ))}
    </section>
  );

  let main: ReactNode;
  if (tab === "live") {
    main = (
      <>
        {composer}
        {activityRows(8)}
        {commentList.map((c) => <CommentCard key={c.id} comment={c} tickers={tickers} />)}
        {!items.length && !commentList.length ? <p className="m-0 text-sm text-mw-muted">No activity yet.</p> : null}
      </>
    );
  } else if (tab === "comments") {
    main = (
      <>
        {composer}
        {commentList.length ? commentList.map((c) => <CommentCard key={c.id} comment={c} tickers={tickers} />) : <p className="m-0 text-sm text-mw-muted">No comments yet.</p>}
      </>
    );
  } else if (tab === "supporters") {
    main = <section className={`${card} flex flex-col gap-2.5 p-4`}><span className={cardTitle}>Supporters</span>{supporterRows()}</section>;
  } else if (tab === "pool") {
    main = poolCard;
  } else {
    main = rulesCard;
  }

  return (
    <WarzoneContent className="flex flex-col gap-4 font-mw-body text-mw-text">
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Battle lists" className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-[#2A3038] bg-mw-input p-1 [scrollbar-width:none] lg:w-max [&::-webkit-scrollbar]:hidden">
          {LIST_TABS.map((t) => (
            <Link
              key={t.key}
              to={`/warzone/battles?tab=${t.key}`}
              aria-current={t.key === listTab ? "page" : undefined}
              className={cn(
                "mw-focus inline-flex min-h-10 shrink-0 items-center rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em]",
                t.key === listTab ? "border-[#3A424C] bg-[#1F252C] text-mw-text hover:text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>

      <BattleWallModule
        key={battle.id}
        battle={battle}
        metrics={metrics.metricsById[battle.id]}
        metricsRequested={metrics.requestedIds.includes(battle.id)}
        metricsLoaded={metrics.loaded}
        realtimeActive
        viewportIndex={0}
        showBuyIn={mine && wallPhaseForBattle(battle) === "matched"}
        variant="page"
      />

      <div role="tablist" aria-label="Battle sections" className="-mx-3 flex gap-5 overflow-x-auto border-b border-mw-border px-3 [scrollbar-width:none] lg:mx-0 lg:gap-6 lg:px-0 [&::-webkit-scrollbar]:hidden">
        {pageTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "mw-focus inline-flex h-[46px] shrink-0 items-center border-b-[3px] px-1 text-[15px] font-semibold lg:h-[52px]",
              tab === t.key ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 pb-16 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-2 lg:gap-3" role="tabpanel">
          {main}
        </div>
        {desktop ? (
          <aside className="sticky top-[calc(var(--mwz-topbar-offset)+16px)] flex flex-col gap-4">
            {poolCard}
            <section className={`${card} flex flex-col gap-2.5 p-4`} aria-label="Top supporters">
              <span className={cardTitle}>Top supporters</span>
              {supporterRows(3)}
              {supporters.length > 3 ? (
                <button type="button" onClick={() => setTab("supporters")} className="mw-focus self-start text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">
                  See all {supporters.length}
                </button>
              ) : null}
            </section>
            {rulesCard}
          </aside>
        ) : null}
      </div>
    </WarzoneContent>
  );
}

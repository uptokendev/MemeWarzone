/** Home (the feed on "/"), UI redesign phase 2 (artboard Home + HomeMobile). */
import { useCallback, useEffect, useState } from "react";
import { FeedItemView, FeedWhoToFollow } from "@/components/feed/FeedCards";
import {
  BattleFeedCard,
  GraduationCard,
  HomeComposer,
  LaunchCard,
  LeagueCard,
  LiveBattlesCard,
  RecruiterCard,
  StoryRow,
  TrendingCard,
} from "@/components/home-feed/HomeParts";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { isSolanaAddress } from "@/lib/address";
import { fetchFeedPosts, fetchFeedSuggestions, type FeedItem, type FeedSuggestion } from "@/lib/feedApi";
import { useHomeCoins } from "@/lib/homeFeedData";

type HomeTab = "for-you" | "following" | "launches" | "battles" | "graduations" | "trending" | "league" | "recruiters";

const TABS: Array<{ key: HomeTab; label: string; mobileOnly?: boolean }> = [
  { key: "for-you", label: "For you" },
  { key: "following", label: "Following" },
  { key: "launches", label: "Launches" },
  { key: "battles", label: "Battles" },
  { key: "graduations", label: "Graduations" },
  // Phones have no right rail, so its cards continue as tabs (artboard HomeMobile).
  { key: "trending", label: "Trending", mobileOnly: true },
  { key: "league", label: "League", mobileOnly: true },
  { key: "recruiters", label: "Recruiters", mobileOnly: true },
];

const TREND_CHAINS = [101, 56, 4663];
const empty = "rounded-[14px] border border-mw-border bg-mw-surface p-4 text-sm text-mw-muted";

export default function Feed() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const [feedChainId] = useSelectedFeedChainId();
  const coinChainId = Number(feedChainId || 101);
  const account = String(solanaWallet.solanaAccount || wallet.account || "").trim();
  const chainId = isSolanaAddress(account)
    ? SOLANA_CHAIN_ID
    : getActiveChainId((wallet as { chainId?: number })?.chainId) || 56;
  const [tab, setTab] = useState<HomeTab>("for-you");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [suggestions, setSuggestions] = useState<FeedSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const postsTab = tab === "for-you" || tab === "following";
  const { liveBattles = [] } = useArenaBattleFeed();
  const launches = useHomeCoins(coinChainId, "launches", 12, tab === "launches");
  const graduations = useHomeCoins(coinChainId, "graduations", 12, tab === "graduations");

  const load = useCallback(async () => {
    if (!postsTab) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchFeedPosts({ tab: tab as "for-you" | "following", viewer: account || undefined, chainId, limit: 40 }));
    } catch (e: unknown) {
      setError(String((e as Error)?.message || "Failed to load feed"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [account, chainId, postsTab, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  // Who to follow is optional: an API without it must not take the feed down.
  useEffect(() => {
    let cancelled = false;
    fetchFeedSuggestions(account || undefined)
      .then((who) => { if (!cancelled) setSuggestions(who); })
      .catch(() => { if (!cancelled) setSuggestions([]); });
    return () => { cancelled = true; };
  }, [account]);

  return (
    <ContentContainer className="px-0 pb-16 font-mw-body text-mw-text md:px-2">
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <h1 className="sr-only">Home</h1>
          <StoryRow chainId={coinChainId} liveBattles={liveBattles} />
          <div className="hidden lg:block"><HomeComposer onPosted={() => void load()} /></div>
          <nav role="tablist" aria-label="Feed filter" className="flex gap-5 overflow-x-auto border-b border-[#242A31] px-3 [scrollbar-width:none] lg:gap-6 lg:px-1 [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`mw-focus inline-flex h-[46px] shrink-0 items-center whitespace-nowrap border-b-[3px] px-1 text-[15px] font-semibold lg:h-[52px] ${t.mobileOnly ? "lg:hidden" : ""} ${tab === t.key ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex flex-col gap-2.5 px-2 lg:gap-4 lg:px-0">
            {tab === "for-you" ? (
              <div className="flex items-center gap-2.5 rounded-[14px] border border-mw-border bg-mw-surface px-3.5 py-2.5 text-[13px] text-[#C9CED4]">
                <span className="text-[#FF9A4D]" aria-hidden="true">●</span>
                <span>Ranked for you: posts taking off right now, people you follow, and creator updates from coins.</span>
              </div>
            ) : null}
            {tab === "for-you" ? <div className="lg:hidden"><HomeComposer onPosted={() => void load()} /></div> : null}

            {postsTab ? (
              loading ? (
                <div className={empty}>Loading feed...</div>
              ) : error ? (
                <div className="rounded-[14px] border border-[#5A1A26] bg-[#2A0E14] p-4 text-sm text-[#FFB4C0]">{error}</div>
              ) : items.length ? (
                items.map((item) => <FeedItemView key={item.id} item={item} onChanged={() => void load()} />)
              ) : (
                <div className={empty}>{tab === "following" ? "Follow people to see their posts here." : "The feed is quiet. Be first to post."}</div>
              )
            ) : null}

            {tab === "launches" ? (
              (launches.data || []).length ? (launches.data || []).map((coin) => <LaunchCard key={coin.campaignAddress} coin={coin} />)
                : <div className={empty}>{launches.isLoading ? "Loading launches..." : "No launches on this chain yet."}</div>
            ) : null}
            {tab === "battles" ? (
              liveBattles.length ? liveBattles.map((battle) => <BattleFeedCard key={battle.id} battle={battle} />)
                : <div className={empty}>No live battles right now.</div>
            ) : null}
            {tab === "graduations" ? (
              (graduations.data || []).length ? (graduations.data || []).map((coin, i) => <GraduationCard key={coin.campaignAddress} coin={coin} first={i === 0} />)
                : <div className={empty}>{graduations.isLoading ? "Loading graduations..." : "No graduated coins on this chain yet."}</div>
            ) : null}
            {tab === "trending" ? <TrendingCard chainIds={TREND_CHAINS} /> : null}
            {tab === "league" ? <LeagueCard chainId={coinChainId} /> : null}
            {tab === "recruiters" ? <RecruiterCard /> : null}
          </div>
        </div>

        <aside className="hidden flex-col gap-4 lg:sticky lg:top-[calc(var(--mwz-topbar-offset)+16px)] lg:flex">
          <LiveBattlesCard battles={liveBattles} />
          <TrendingCard chainIds={TREND_CHAINS} />
          <LeagueCard chainId={coinChainId} />
          <RecruiterCard />
          <FeedWhoToFollow authors={suggestions} />
        </aside>
      </div>
    </ContentContainer>
  );
}

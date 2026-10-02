import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useLaunchpad } from "@/lib/launchpadClient";
import {
  BNB_TESTNET_CHAIN_ID,
  getActiveChainId,
  isEvmChainId,
  SOLANA_CHAIN_ID,
} from "@/lib/chainConfig";
import { fetchUserProfile, fetchPublicPortfolioMetrics, type UserProfile } from "@/lib/profileApi";
import { fetchOwnerCampaignDrafts, fetchPublicCampaignDrafts, type CampaignDraft } from "@/lib/draftApi";
import { isSolanaAddress } from "@/lib/address";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { PortfolioMetricsGrid } from "@/components/profile/PortfolioMetricsGrid";
import type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";
import { useCreatedCampaignsQuery } from "@/hooks/profile/useCreatedCampaigns";
import { FeedItemView } from "@/components/feed/FeedCards";
import { HomeComposer } from "@/components/home-feed/HomeParts";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { fetchActivityTimeline, fetchProfileFeedPage, type FeedItem } from "@/lib/feedApi";
import {
  fetchRecruiterSummaryByWallet,
  fetchSquadSummary,
  fetchWalletAttributionState,
  type RecruiterSummary,
  type SquadSummary,
  type WalletAttributionPublicState,
} from "@/lib/recruiterApi";
import { followUser, getFollowersCount, getFollowingCount, isFollowingUser, unfollowUser } from "@/lib/followApi";
import { normalizeRank, type RankName } from "@/lib/ranks";
import { Award, Copy, Crown, ExternalLink, Flag, Megaphone, Rocket, ShieldCheck, Trophy, Users, type LucideIcon } from "lucide-react";
import { cp } from "@/components/token/coinPageStyles";
import { buildAbuseReportPath } from "@/lib/abuseReportLink";
import { toast } from "sonner";

type PublicCoin = {
  id: number;
  image: string;
  name: string;
  ticker: string;
  campaignAddress: string;
  tokenAddress?: string | null;
  chainId?: number;
  marketCap: string;
  progress?: string | null;
  status?: string | null;
  timeAgo?: string | null;
};

function shorten(addr?: string | null) {
  if (!addr) return "";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getExplorerBase(chainId?: number): string {
  if (chainId === 101 || chainId === 102) return "https://explorer.solana.com";
  if (chainId === 46630) return "https://explorer.testnet.chain.robinhood.com";
  if (chainId === 4663) return "https://explorer.chain.robinhood.com";
  if (chainId === 97) return "https://testnet.bscscan.com";
  if (chainId === 56) return "https://bscscan.com";
  return "https://bscscan.com";
}

function formatTimeAgo(createdAt?: number | string | null): string {
  if (!createdAt) return "";
  const seconds = typeof createdAt === "number" ? createdAt : Math.floor(new Date(createdAt).getTime() / 1000);
  if (!Number.isFinite(seconds)) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - seconds);
  if (diff < 60) return "now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function formatCompactNumber(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "0";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function safeRank(profile: UserProfile | null): RankName {
  const raw = (profile as any)?.rank;
  return raw ? normalizeRank(raw) : "Recruit";
}

function isDraftVisibleOnPublicProfile(draft: CampaignDraft) {
  if (draft.visibility !== "public") return false;
  if (draft.status === "archived") return false;
  return true;
}

function draftHref(draft: CampaignDraft) {
  // Deployed drafts should open the token page when we have on-chain ids.
  if (draft.status === "deployed" && (draft.tokenAddress || draft.campaignAddress)) {
    return `/token/${draft.tokenAddress || draft.campaignAddress}`;
  }
  return draft.slug ? `/prepare/${draft.slug}` : `/drafts/${draft.id}`;
}

function walletsEqual(a?: string | null, b?: string | null) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  if (isSolanaAddress(left) && isSolanaAddress(right)) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

const BADGE_ICONS: Record<string, LucideIcon> = {
  "Recruiter verified": ShieldCheck,
  "OG recruiter": Megaphone,
  "Squad-linked": Users,
  "Creator activity": Rocket,
  "Trader activity": Trophy,
  "Public posts": Award,
  "Public drafts": Crown,
};

function RailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={`${cp.card} p-4`}>
      <h2 className={`${cp.title} m-0 mb-3`}>{title}</h2>
      {children}
    </section>
  );
}

function KeyRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="m-0 flex flex-col">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-3 border-b border-mw-border py-2 text-sm last:border-b-0">
          <dt className="text-mw-muted">{label}</dt>
          <dd className="m-0 text-right font-semibold text-mw-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function PublicProfile({
  profileWallet,
  isOwnProfile,
}: {
  profileWallet: string;
  isOwnProfile: boolean;
}) {
  const navigate = useNavigate();
  const wallet = useWallet();
  const { fetchCampaigns, fetchCampaignSummary } = useLaunchpad();
  const anyWallet: any = wallet as any;
  const evmWalletChainId = anyWallet?.chainId ?? null;
  const activeChainId = isSolanaAddress(profileWallet)
    ? SOLANA_CHAIN_ID
    : isEvmChainId(evmWalletChainId)
      ? Number(evmWalletChainId)
      : getActiveChainId(evmWalletChainId) || BNB_TESTNET_CHAIN_ID;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [visibleDrafts, setVisibleDrafts] = useState<CampaignDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [recruiter, setRecruiter] = useState<RecruiterSummary | null>(null);
  const [walletAttribution, setWalletAttribution] = useState<WalletAttributionPublicState | null>(null);
  const [squad, setSquad] = useState<SquadSummary | null>(null);
  const [loadingBadges, setLoadingBadges] = useState(false);
  const [publicActivity, setPublicActivity] = useState<FeedItem[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  const { created, loading: loadingCoins } = useCreatedCampaignsQuery({
    viewedAddress: profileWallet,
    account: isOwnProfile ? (wallet.account || null) : null,
    chainId: activeChainId,
    fetchCampaigns,
    fetchCampaignSummary,
  });
  const createdCoins: PublicCoin[] = useMemo(
    () =>
      created.map((card, index) => ({
        id: card.id ?? index + 1,
        image: card.image,
        name: card.name,
        ticker: card.ticker,
        campaignAddress: card.campaignAddress,
        tokenAddress: card.tokenAddress,
        chainId: card.chainId,
        marketCap: card.marketCap,
        progress: card.progress ?? null,
        status: card.status ?? null,
        timeAgo: card.timeAgo,
      })),
    [created],
  );
  const publicPosts = useMemo(
    () => publicActivity.filter((item) => item.type === "post"),
    [publicActivity],
  );
  const publicEvents = useMemo(
    () => publicActivity.filter((item) => item.type !== "post"),
    [publicActivity],
  );
  const publicTrades = useMemo(
    () => publicActivity.filter((item) => item.type === "trade"),
    [publicActivity],
  );

  const [portfolioMetrics, setPortfolioMetrics] = useState<PortfolioMetrics | null>(null);
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followCounts, setFollowCounts] = useState<{ followers: number; following: number } | null>(null);
  const [tab, setTab] = useState("posts");
  const feedViewer = useActiveFeedWallet().address;
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [feedCursor, setFeedCursor] = useState<string | null>(null);
  const [feedSupported, setFeedSupported] = useState(true);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);

  const effectivePortfolioMetrics = portfolioMetrics;
  const effectiveLoadingPortfolio = loadingPortfolio;

  const displayName = useMemo(() => {
    const name = (profile?.displayName ?? "").trim();
    return name ? `@${name}` : shorten(profileWallet);
  }, [profile?.displayName, profileWallet]);

  const explorerUrl = useMemo(() => `${getExplorerBase(activeChainId)}/address/${profileWallet}`, [activeChainId, profileWallet]);
  const rank = useMemo(() => safeRank(profile), [profile]);
  const viewerAccount = wallet.account || null;

  useEffect(() => {
    let cancelled = false;
    if (isOwnProfile || !viewerAccount || !profileWallet) {
      setIsFollowing(false);
      return;
    }
    void isFollowingUser(viewerAccount, profileWallet, 0)
      .then((v) => {
        if (!cancelled) setIsFollowing(Boolean(v));
      })
      .catch(() => {
        if (!cancelled) setIsFollowing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, viewerAccount, profileWallet]);

  const handleToggleFollow = useCallback(async () => {
    if (isOwnProfile || !profileWallet) return;
    if (!viewerAccount) {
      toast.error("Connect wallet to follow");
      try {
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      } catch {
        // ignore
      }
      return;
    }
    if (followBusy) return;
    setFollowBusy(true);
    const next = !isFollowing;
    setIsFollowing(next);
    try {
      const signOpts = { signer: wallet.signer };
      if (next) await followUser(viewerAccount, profileWallet, 0, signOpts);
      else await unfollowUser(viewerAccount, profileWallet, 0, signOpts);
      toast.success(next ? "Following" : "Unfollowed");
    } catch (err: any) {
      setIsFollowing(!next);
      toast.error(String(err?.message || "Failed to update follow"));
    } finally {
      setFollowBusy(false);
    }
  }, [followBusy, isFollowing, isOwnProfile, profileWallet, viewerAccount]);

  const profileCompleteness = useMemo(() => {
    let score = 0;
    if ((profile?.displayName ?? "").trim()) score += 25;
    if ((profile?.bio ?? "").trim()) score += 25;
    if ((profile?.avatarUrl ?? "").trim()) score += 25;
    if (createdCoins.length > 0 || visibleDrafts.length > 0 || publicActivity.length > 0) score += 25;
    return score;
  }, [profile?.avatarUrl, profile?.bio, profile?.displayName, createdCoins.length, visibleDrafts.length, publicActivity.length]);

  const reputationSignals = useMemo(
    () => [
      { label: "Rank", value: rank, detail: "Current public progression" },
      { label: "Created", value: formatCompactNumber(createdCoins.length), detail: "Public launched coins" },
      { label: "Drafts", value: formatCompactNumber(visibleDrafts.length), detail: "Public Prepare drafts" },
      { label: "Activity", value: formatCompactNumber(publicActivity.length), detail: "Posts, deploys, and trades" },
    ],
    [rank, createdCoins.length, visibleDrafts.length, publicActivity.length]
  );

  const publicTrustTags = useMemo(() => {
    const tags: string[] = [];
    if (recruiter?.code) tags.push("Recruiter verified");
    if (recruiter?.isOg) tags.push("OG recruiter");
    if (squad?.recruiterCode || walletAttribution?.recruiterCode) tags.push("Squad-linked");
    if (createdCoins.length > 0) tags.push("Creator activity");
    if (publicTrades.length > 0) tags.push("Trader activity");
    if (publicPosts.length > 0) tags.push("Public posts");
    if (visibleDrafts.length > 0) tags.push("Public drafts");
    return tags;
  }, [createdCoins.length, publicPosts.length, publicTrades.length, recruiter?.code, recruiter?.isOg, squad?.recruiterCode, visibleDrafts.length, walletAttribution?.recruiterCode]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadingProfile(true);
      try {
        const p = await fetchUserProfile(activeChainId, profileWallet);
        if (!cancelled) setProfile(p);
      } catch (e) {
        console.warn("Failed to load public profile", e);
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setLoadingProfile(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [activeChainId, profileWallet]);

  useEffect(() => {
    if (!profileWallet || !activeChainId) {
      setPortfolioMetrics(null);
      setLoadingPortfolio(false);
      return;
    }

    let cancelled = false;

    const loadPortfolio = async () => {
      setLoadingPortfolio(true);
      setPortfolioError(null);
      try {
        const data = await fetchPublicPortfolioMetrics(activeChainId, profileWallet);
        if (!cancelled) {
          setPortfolioMetrics(data ?? null);
        }
      } catch (e: any) {
        if (!cancelled) {
          console.warn("Failed to load public portfolio metrics", e);
          setPortfolioError(String(e?.message || "Failed to load portfolio metrics."));
          setPortfolioMetrics(null);
        }
      } finally {
        if (!cancelled) setLoadingPortfolio(false);
      }
    };

    loadPortfolio();
    return () => {
      cancelled = true;
    };
  }, [activeChainId, profileWallet]);

  useEffect(() => {
    let cancelled = false;

    const loadDrafts = async () => {
      setLoadingDrafts(true);
      setDraftsError(null);
      try {
        const profileIsSolana = isSolanaAddress(profileWallet);
        const preferredChainId = profileIsSolana ? SOLANA_CHAIN_ID : activeChainId;

        // Own profile: show ALL owner drafts (including private / deployed).
        // Public profile: only public discoverable drafts.
        const drafts = isOwnProfile
          ? await fetchOwnerCampaignDrafts(profileWallet, {
              chainId: preferredChainId,
              limit: 100,
            })
          : await fetchPublicCampaignDrafts({ chainId: preferredChainId, limit: 100 });

        if (cancelled) return;

        const mine = drafts.filter((draft) => walletsEqual(draft.creatorWallet, profileWallet));
        setVisibleDrafts(
          isOwnProfile
            ? mine.filter((draft) => draft.status !== "archived")
            : mine.filter(isDraftVisibleOnPublicProfile),
        );
      } catch (e: any) {
        console.warn("Failed to load public profile drafts", e);
        if (!cancelled) {
          setDraftsError(String(e?.message || "Failed to load visible drafts."));
          setVisibleDrafts([]);
        }
      } finally {
        if (!cancelled) setLoadingDrafts(false);
      }
    };

    loadDrafts();
    return () => {
      cancelled = true;
    };
  }, [activeChainId, profileWallet, isOwnProfile]);

  useEffect(() => {
    let cancelled = false;

    const loadBadges = async () => {
      setLoadingBadges(true);
      try {
        const [recruiterResult, attributionResult] = await Promise.allSettled([
          fetchRecruiterSummaryByWallet(profileWallet),
          fetchWalletAttributionState(profileWallet),
        ]);

        if (cancelled) return;

        const nextRecruiter = recruiterResult.status === "fulfilled" ? recruiterResult.value : null;
        const nextAttribution = attributionResult.status === "fulfilled" ? attributionResult.value : null;
        setRecruiter(nextRecruiter);
        setWalletAttribution(nextAttribution);

        const squadCode = nextRecruiter?.code || nextAttribution?.recruiterCode || null;
        if (!squadCode) {
          setSquad(null);
          return;
        }

        try {
          const nextSquad = await fetchSquadSummary(squadCode);
          if (!cancelled) setSquad(nextSquad);
        } catch (e) {
          console.warn("Failed to load public squad badge", e);
          if (!cancelled) setSquad(null);
        }
      } catch (e) {
        console.warn("Failed to load public profile badges", e);
        if (!cancelled) {
          setRecruiter(null);
          setWalletAttribution(null);
          setSquad(null);
        }
      } finally {
        if (!cancelled) setLoadingBadges(false);
      }
    };

    loadBadges();
    return () => {
      cancelled = true;
    };
  }, [profileWallet]);

  const loadActivity = useCallback(async () => {
    if (!profileWallet) return;
    setLoadingActivity(true);
    setActivityError(null);
    try {
      const items = await fetchActivityTimeline(profileWallet, 40);
      setPublicActivity(items);
    } catch (e: any) {
      console.warn("Failed to load public profile activity", e);
      setActivityError(String(e?.message || "Failed to load public activity."));
      setPublicActivity([]);
    } finally {
      setLoadingActivity(false);
    }
  }, [profileWallet]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  // Follower / following counts for the hero (read-only, same endpoints as the Command Center).
  useEffect(() => {
    let cancelled = false;
    if (!profileWallet) return;
    void Promise.all([getFollowersCount(profileWallet, 0), getFollowingCount(profileWallet, 0)])
      .then(([followers, following]) => {
        if (!cancelled) setFollowCounts({ followers, following });
      })
      .catch(() => {
        if (!cancelled) setFollowCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profileWallet, isFollowing]);

  // Posts tab: this wallet's posts, reposts, coin posts and auto updates (newest first, infinite scroll).
  const loadFeed = useCallback(async () => {
    if (!profileWallet) return;
    setFeedLoading(true);
    try {
      const page = await fetchProfileFeedPage({ author: profileWallet, chainId: activeChainId, viewer: feedViewer || undefined });
      setFeedSupported(page.supported);
      setFeedItems(page.supported ? page.items : []);
      setFeedCursor(page.supported ? page.nextCursor : null);
    } catch {
      setFeedSupported(false);
      setFeedItems([]);
      setFeedCursor(null);
    } finally {
      setFeedLoading(false);
    }
  }, [activeChainId, feedViewer, profileWallet]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const loadMoreFeed = useCallback(async () => {
    if (!feedCursor || feedLoadingMore) return;
    setFeedLoadingMore(true);
    try {
      const page = await fetchProfileFeedPage({ author: profileWallet, chainId: activeChainId, viewer: feedViewer || undefined, before: feedCursor });
      setFeedItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setFeedCursor(page.nextCursor);
    } catch {
      // Keep what is shown; the next scroll retries.
    } finally {
      setFeedLoadingMore(false);
    }
  }, [activeChainId, feedCursor, feedLoadingMore, feedViewer, profileWallet]);

  useEffect(() => {
    const el = feedSentinelRef.current;
    if (!el || !feedCursor || tab !== "posts" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadMoreFeed();
    }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [feedCursor, loadMoreFeed, tab]);

  const copyAddress = () => {
    navigator.clipboard.writeText(profileWallet);
    toast.success("Address copied!");
  };

  const handlePortfolioRefresh = async () => {
    if (!profileWallet || !activeChainId) return;
    setLoadingPortfolio(true);
    try {
      const data = await fetchPublicPortfolioMetrics(activeChainId, profileWallet, { forceRefresh: true });
      setPortfolioMetrics(data ?? null);
      setPortfolioError(null);
    } catch (e: any) {
      setPortfolioError(String(e?.message || "Failed to refresh portfolio metrics."));
      setPortfolioMetrics(null);
    } finally {
      setLoadingPortfolio(false);
    }
  };

  // UI redesign phase 8 (artboard Profile): banner + round avatar hero, tab row, summary rail.
  // Every section shows data this page already loads; nothing new is written.
  const nameText = (profile?.displayName ?? "").trim() || shorten(profileWallet);
  const handle = (profile?.displayName ?? "").trim() ? `@${(profile?.displayName ?? "").trim()}` : null;
  const initials = ((profile?.displayName ?? "").trim() || profileWallet.replace(/^0x/i, "")).slice(0, 2).toUpperCase();
  const squadCode = recruiter?.code || walletAttribution?.recruiterCode || null;
  const hasSquad = Boolean(squad || walletAttribution?.recruiterCode);
  const postsToShow = feedSupported ? feedItems : publicPosts;
  const empty = `${cp.card} p-4 text-sm text-mw-muted`;
  const accentButton = "mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-bold text-[#140A02] hover:bg-[#FF8A3D] disabled:opacity-60";
  const reportPath = buildAbuseReportPath({
    entityType: "profile",
    reportedWallet: profileWallet,
    reportedUrl: typeof window !== "undefined" ? window.location.href : `/profile/${profileWallet}`,
  });
  const openCoin = (coin: PublicCoin) =>
    navigate(tokenDetailsPath({ tokenAddress: coin.tokenAddress, campaignAddress: coin.campaignAddress, chainId: coin.chainId }));
  const progressNumber = (value?: string | null) => {
    const n = Number(String(value ?? "").replace("%", ""));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  };
  const portfolioRows: Array<[string, ReactNode]> = [
    ["Value", effectivePortfolioMetrics?.totalValueUsd != null ? `$${Math.round(effectivePortfolioMetrics.totalValueUsd).toLocaleString()}` : "—"],
    ["Top holding", effectivePortfolioMetrics?.topHolding?.ticker ? `$${effectivePortfolioMetrics.topHolding.ticker}` : "—"],
    ["Coins held", effectivePortfolioMetrics ? formatCompactNumber(effectivePortfolioMetrics.coinsCount) : "—"],
    ["Wallet age", effectivePortfolioMetrics?.walletAge || "—"],
  ];
  const recruiterRows: Array<[string, ReactNode]> = recruiter
    ? [
        ["Status", `${String(recruiter.status || "active").replace(/^\w/, (c) => c.toUpperCase())}${recruiter.isOg ? " · OG" : ""}`],
        ["Linked wallets", formatCompactNumber(recruiter.linkedWalletCount)],
        ["Creators", formatCompactNumber(recruiter.linkedCreatorsCount)],
        ["Traders", formatCompactNumber(recruiter.linkedTradersCount)],
      ]
    : [];
  const squadRows: Array<[string, ReactNode]> = [
    ["State", String(walletAttribution?.squadState || squad?.recruiterStatus || "—").replace(/^\w/, (c) => c.toUpperCase())],
    ["Members", formatCompactNumber(squad?.activeMemberCount)],
    ["Eligible", formatCompactNumber(squad?.eligibleMemberCount)],
    ["Last routed", formatTimeAgo(squad?.lastRoutedAt) ? `${formatTimeAgo(squad?.lastRoutedAt)} ago` : "—"],
  ];
  const badgeTags = publicTrustTags.length ? publicTrustTags : [];

  const coinsGrid = loadingCoins ? (
    <div className={empty}>Loading created coins...</div>
  ) : createdCoins.length ? (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {createdCoins.map((coin) => (
        <button
          key={coin.campaignAddress}
          type="button"
          onClick={() => openCoin(coin)}
          className="mw-focus flex flex-col overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface text-left hover:border-[#3A424C]"
        >
          <div className="flex h-[96px] items-center justify-center bg-[#2A1609] md:h-[130px]">
            <img src={coin.image || "/placeholder.svg"} alt="" className="h-16 w-16 rounded-[14px] object-cover md:h-20 md:w-20" />
          </div>
          <div className="flex flex-col gap-1 p-3">
            <span className="truncate text-[15px] font-bold text-mw-text">{coin.name}</span>
            <span className="truncate font-mw-mono text-xs text-mw-muted">
              {[coin.marketCap, coin.status && /graduat/i.test(coin.status) ? "Graduated" : coin.progress, coin.timeAgo].filter((v) => v && v !== "—").join(" · ")}
            </span>
            {coin.progress && !(coin.status && /graduat/i.test(coin.status)) ? (
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-mw-border">
                <div className="h-full rounded-full bg-mw-accent" style={{ width: `${progressNumber(coin.progress)}%` }} />
              </div>
            ) : null}
          </div>
        </button>
      ))}
    </div>
  ) : (
    <div className={empty}>No public created coins yet.</div>
  );

  const draftsList = loadingDrafts ? (
    <div className={empty}>Loading visible drafts...</div>
  ) : draftsError ? (
    <div className="rounded-[14px] border border-[#5A1A26] bg-[#2A0E14] p-4 text-sm text-[#FFB4C0]">{draftsError}</div>
  ) : visibleDrafts.length ? (
    <div className="flex flex-col gap-3">
      {visibleDrafts.map((draft) => (
        <div key={draft.id} className={`${cp.card} flex flex-wrap items-center gap-3 p-3.5`}>
          <img src={draft.logoUrl || "/placeholder.svg"} alt="" className="h-12 w-12 shrink-0 rounded-[10px] object-cover" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold text-mw-text">{draft.name}</div>
            <div className="text-[13px] capitalize text-mw-muted">
              {[draft.visibility, draft.category, draft.status.replace(/_/g, " "), formatTimeAgo(draft.updatedAt) ? `updated ${formatTimeAgo(draft.updatedAt)} ago` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button type="button" className={cp.btn} onClick={() => navigate(draftHref(draft))}>
            {draft.status === "deployed" ? "Open coin" : "Promotion page"}
          </button>
        </div>
      ))}
    </div>
  ) : (
    <div className={empty}>No public drafts yet.</div>
  );

  const badgesGrid = (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div className={`${cp.card} flex flex-col items-center gap-2 p-4 text-center`}>
        <Award className="h-5 w-5 text-[#FFC94D]" aria-hidden="true" />
        <span className="text-[13px] font-bold text-mw-text">{rank}</span>
        <span className="text-xs text-mw-muted">Public rank</span>
      </div>
      {badgeTags.map((tag) => {
        const Icon = BADGE_ICONS[tag] || Award;
        return (
          <div key={tag} className={`${cp.card} flex flex-col items-center gap-2 p-4 text-center`}>
            <Icon className="h-5 w-5 text-[#FFC94D]" aria-hidden="true" />
            <span className="text-[13px] font-bold text-mw-text">{tag}</span>
          </div>
        );
      })}
      {!badgeTags.length ? <div className={`${empty} col-span-full`}>Building public history.</div> : null}
    </div>
  );

  const reputationCard = (
    <section aria-label="Reputation" className={`${cp.card} flex flex-col gap-3 p-4`}>
      <div className="flex items-center gap-3">
        <span className="font-mw-mono text-4xl font-bold text-mw-text">{profileCompleteness}</span>
        <div>
          <div className="text-[15px] font-bold text-mw-text">Profile {profileCompleteness}% complete</div>
          <div className="text-[13px] text-mw-muted">Name, bio, avatar and public activity</div>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-mw-border">
        <div className="h-full rounded-full bg-mw-buy" style={{ width: `${profileCompleteness}%` }} />
      </div>
      <KeyRows rows={reputationSignals.map((signal) => [signal.detail, signal.value] as [string, ReactNode])} />
    </section>
  );

  const activityList = loadingActivity ? (
    <div className={empty}>Loading public activity...</div>
  ) : activityError ? (
    <div className="rounded-[14px] border border-[#5A1A26] bg-[#2A0E14] p-4 text-sm text-[#FFB4C0]">{activityError}</div>
  ) : publicEvents.length ? (
    <div className="flex flex-col gap-3">
      {publicEvents.map((item) => (
        <FeedItemView key={item.id} item={item} />
      ))}
    </div>
  ) : (
    <div className={empty}>No public drafts, deploys, or trades yet.</div>
  );

  const postsList = (
    <div className="flex flex-col gap-3">
      {isOwnProfile ? <HomeComposer onPosted={() => { void loadFeed(); void loadActivity(); }} /> : null}
      {(feedSupported ? feedLoading && !feedItems.length : loadingActivity && !publicPosts.length) ? (
        <div className={empty}>Loading posts...</div>
      ) : postsToShow.length ? (
        <>
          {postsToShow.map((item) => (
            <FeedItemView key={item.id} item={item} onChanged={() => void loadFeed()} />
          ))}
          <div ref={feedSentinelRef} aria-hidden="true" />
          {feedLoadingMore ? <div className={empty}>Loading more...</div> : null}
        </>
      ) : (
        <div className={empty}>{isOwnProfile ? "No posts yet. Say what's moving." : "No public posts yet."}</div>
      )}
    </div>
  );

  const tabs: Array<{ value: string; label: string; content: ReactNode }> = [
    { value: "posts", label: "Posts", content: postsList },
    { value: "coins", label: "Coins", content: coinsGrid },
    { value: "drafts", label: "Drafts", content: draftsList },
    {
      value: "portfolio",
      label: "Portfolio",
      content: (
        <div className="flex flex-col gap-2">
          <PortfolioMetricsGrid metrics={effectivePortfolioMetrics} loading={effectiveLoadingPortfolio} onRefresh={isOwnProfile ? handlePortfolioRefresh : undefined} variant="public" />
          {portfolioError ? <p className="m-0 text-xs text-mw-muted">Portfolio metrics temporarily unavailable.</p> : null}
        </div>
      ),
    },
    ...(recruiter
      ? [{
          value: "recruiter",
          label: "Recruiter",
          content: (
            <section aria-label="Recruiter" className={`${cp.card} flex flex-col gap-3 p-4`}>
              <KeyRows rows={[...recruiterRows, ["Code", `/${recruiter.code}`]]} />
              <div><Link to={`/recruiters/${recruiter.code}`} className={cp.btn}>Open recruiter page</Link></div>
            </section>
          ),
        }]
      : []),
    ...(hasSquad
      ? [{
          value: "squad",
          label: "Squad",
          content: (
            <section aria-label="Squad" className={`${cp.card} flex flex-col gap-3 p-4`}>
              <p className="m-0 text-sm text-mw-muted">
                {squad?.recruiterCode ? `Squad /${squad.recruiterCode}` : walletAttribution?.recruiterCode ? `Linked via /${walletAttribution.recruiterCode}` : ""}
              </p>
              <KeyRows rows={squadRows} />
              {squadCode ? <div><Link to={`/squads?recruiter=${encodeURIComponent(squadCode)}`} className={cp.btn}>Squad Pool</Link></div> : null}
            </section>
          ),
        }]
      : []),
    { value: "badges", label: "Badges", content: badgesGrid },
    { value: "reputation", label: "Reputation", content: reputationCard },
    { value: "activity", label: "Activity", content: activityList },
  ];
  const currentTab = tabs.some((t) => t.value === tab) ? tab : "posts";

  return (
    <div className="mx-auto w-full max-w-[1480px] flex flex-col gap-4 px-3 pb-24 font-mw-body text-mw-text md:px-2 xl:pb-10" data-public-profile="true">
      {/* Hero: banner, round avatar, name, rank chips, wallet, bio, counts, actions. */}
      <section aria-label={nameText} className="flex flex-col">
        <div className="relative h-[120px] overflow-hidden rounded-2xl border border-[#1E2329] md:h-[200px] xl:h-[220px]">
          <div className="mw-banner h-full w-full" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-3 px-1 md:flex-row md:items-end md:gap-5 md:px-2">
          <div className="relative z-[1] -mt-12 h-24 w-24 shrink-0 overflow-hidden rounded-full border-4 border-mw-ground bg-[#2A3038] md:-mt-16 md:h-[132px] md:w-[132px]">
            {profile?.avatarUrl ? (
              <img src={profile.avatarUrl} alt={nameText} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center font-mw-cond text-3xl font-bold text-mw-text md:text-[44px]">{initials}</div>
            )}
          </div>
          <div className="min-w-0 flex-1 md:pb-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="m-0 break-words font-mw-cond text-3xl font-bold leading-tight text-mw-text md:text-[36px]">
                {loadingProfile && !profile ? "Loading profile..." : nameText}
              </h1>
              <span className={cp.chipAccent}>Public rank · {rank}</span>
              {recruiter?.isOg ? <span className={cp.chip}>OG recruiter</span> : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-mw-muted">
              {handle ? <span>{handle}</span> : null}
              <button type="button" onClick={copyAddress} className={`${cp.chipButton} h-8`} title="Copy address">
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mw-mono">{shorten(profileWallet)}</span>
              </button>
              <a href={explorerUrl} target="_blank" rel="noreferrer" className={`${cp.chipButton} h-8`}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Explorer
              </a>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:pb-1">
            {isOwnProfile ? (
              <button type="button" onClick={() => navigate("/profile")} className={accentButton}>
                Open Command Center
              </button>
            ) : (
              <>
                <button type="button" onClick={() => void handleToggleFollow()} disabled={followBusy} className={isFollowing ? cp.btn : accentButton}>
                  {followBusy ? "Updating…" : isFollowing ? "Unfollow" : "+ Follow"}
                </button>
                <Link to={reportPath} className={cp.btn} aria-label="Report abuse">
                  <Flag className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Report abuse</span>
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 px-1 md:px-2">
          {profile?.bio ? (
            <p className="m-0 max-w-[70ch] whitespace-pre-wrap break-words text-[15px] text-mw-text">{profile.bio}</p>
          ) : (
            <p className="m-0 text-sm text-mw-muted">No public bio yet.</p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-mw-muted">
            <span><b className="text-mw-text">{createdCoins.length}</b> coins created</span>
            <span><b className="text-mw-text">{visibleDrafts.length}</b> {visibleDrafts.length === 1 ? "draft" : "drafts"}</span>
            <span><b className="text-mw-text">{followCounts ? formatCompactNumber(followCounts.followers) : "—"}</b> followers</span>
            <span><b className="text-mw-text">{followCounts ? formatCompactNumber(followCounts.following) : "—"}</b> following</span>
            <span><b className="text-mw-text">{rank}</b> rank</span>
          </div>
        </div>
      </section>

      <div className="-mx-1 flex overflow-x-auto border-b border-mw-border px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Profile sections" className="flex gap-5">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              id={`profile-tab-${t.value}`}
              aria-selected={t.value === currentTab}
              aria-controls={`profile-panel-${t.value}`}
              onClick={() => setTab(t.value)}
              className={`mw-focus inline-flex h-[52px] shrink-0 items-center whitespace-nowrap border-b-[3px] px-1 text-[15px] font-semibold transition-colors ${t.value === currentTab ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-6">
        <div role="tabpanel" id={`profile-panel-${currentTab}`} aria-labelledby={`profile-tab-${currentTab}`} className="min-w-0">
          {tabs.find((t) => t.value === currentTab)?.content}
        </div>

        <aside className="hidden flex-col gap-4 self-start xl:sticky xl:top-[calc(var(--mwz-topbar-offset)+16px)] xl:flex">
          <RailCard title="Portfolio">
            <KeyRows rows={portfolioRows} />
          </RailCard>
          {createdCoins.length ? (
            <RailCard title="Created coins">
              <KeyRows
                rows={createdCoins.slice(0, 5).map((coin) => [
                  `$${coin.ticker}`,
                  <span key={coin.campaignAddress} className="font-mw-mono">{[coin.marketCap, coin.status && /graduat/i.test(coin.status) ? "Graduated" : coin.progress].filter((v) => v && v !== "—").join(" · ") || "—"}</span>,
                ] as [string, ReactNode])}
              />
            </RailCard>
          ) : null}
          {recruiter ? (
            <RailCard title="Recruiter">
              <KeyRows rows={recruiterRows} />
              <Link to={`/recruiters/${recruiter.code}`} className="mt-2 inline-block text-sm text-mw-accent-soft underline">Recruiter page</Link>
            </RailCard>
          ) : null}
          {hasSquad ? (
            <RailCard title="Squad">
              <KeyRows rows={squadRows} />
              {squadCode ? <Link to={`/squads?recruiter=${encodeURIComponent(squadCode)}`} className="mt-2 inline-block text-sm text-mw-accent-soft underline">Squad pool</Link> : null}
            </RailCard>
          ) : null}
          <RailCard title="Badges">
            <div className="flex flex-wrap gap-2">
              <span className={cp.chip}>{rank}</span>
              {badgeTags.map((tag) => <span key={tag} className={cp.chip}>{tag}</span>)}
            </div>
            {loadingBadges ? <p className="m-0 mt-2 text-xs text-mw-muted">Loading...</p> : null}
          </RailCard>
        </aside>
      </div>
    </div>
  );
}

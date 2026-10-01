import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useLaunchpad } from "@/lib/launchpadClient";
import type { CampaignSummary } from "@/lib/launchpadClient";
import {
  BNB_TESTNET_CHAIN_ID,
  getActiveChainId,
  isEvmChainId,
  isRobinhoodChainId,
  isSolanaChainId,
  SOLANA_CHAIN_ID,
} from "@/lib/chainConfig";
import { fetchUserProfile, fetchPublicPortfolioMetrics, type UserProfile } from "@/lib/profileApi";
import { fetchOwnerCampaignDrafts, fetchPublicCampaignDrafts, type CampaignDraft } from "@/lib/draftApi";
import { isSolanaAddress } from "@/lib/address";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { PortfolioMetricsGrid } from "@/components/profile/PortfolioMetricsGrid";
import type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";
import { useProfileBalances } from "@/hooks/profile/useProfileBalances";
import {
  fetchRecruiterSummaryByWallet,
  fetchSquadSummary,
  fetchWalletAttributionState,
  type RecruiterSummary,
  type SquadSummary,
  type WalletAttributionPublicState,
} from "@/lib/recruiterApi";
import { followUser, isFollowingUser, unfollowUser } from "@/lib/followApi";
import { buildRealtimeApiUrl } from "@/lib/realtimeApi";
import type { ActivityTradeRow } from "@/types/profilePage";
import { RankBadgeCard } from "@/components/rank/RankBadgeCard";
import { normalizeRank, type RankName } from "@/lib/ranks";
import { Copy, ExternalLink, Flag } from "lucide-react";
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

function nativeSymbol(chainId?: number) {
  if (isSolanaChainId(Number(chainId))) return "SOL";
  if (isRobinhoodChainId(Number(chainId))) return "ETH";
  return "BNB";
}

function formatNative(value?: number | null, chainId?: number) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 5 })} ${nativeSymbol(chainId)}`;
}

function normalizeMarketCapLabel(value: unknown, chainId?: number): string {
  const label = String(value ?? "—").trim() || "—";
  if (isRobinhoodChainId(Number(chainId))) return label.replace(/\s+BNB$/i, " ETH");
  if (isSolanaChainId(Number(chainId))) return label.replace(/\s+BNB$/i, " SOL");
  return label;
}

function formatTokenAmount(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function safeRank(profile: UserProfile | null): RankName {
  const raw = (profile as any)?.rank;
  return raw ? normalizeRank(raw) : "Recruit";
}

function coinFromSummary(summary: CampaignSummary, index: number, fallbackChainId: number): PublicCoin {
  const stats: any = summary.stats as any;
  const campaign: any = summary.campaign as any;
  const progress = stats?.progressPct ?? stats?.progress ?? campaign?.progressPct ?? null;
  const graduated = Boolean(campaign?.graduated || campaign?.isDexTrading || campaign?.graduatedAt);
  const chainId = Number(campaign?.chainId ?? fallbackChainId);

  return {
    id: typeof summary.campaign.id === "number" ? summary.campaign.id : index + 1,
    image: summary.campaign.logoURI || "/placeholder.svg",
    name: summary.campaign.name || "Unnamed coin",
    ticker: summary.campaign.symbol || "???",
    campaignAddress: summary.campaign.campaign,
    tokenAddress: summary.campaign.token || null,
    chainId,
    marketCap: normalizeMarketCapLabel(summary.stats.marketCap, chainId),
    progress: progress == null ? null : `${Number(progress).toFixed(0)}%`,
    status: graduated ? "graduated" : "live",
    timeAgo: campaign?.timeAgo || formatTimeAgo(summary.campaign.createdAt),
  };
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

function tradeFromApiItem(item: any, fallbackChainId: number): ActivityTradeRow {
  return {
    id: String(item?.id ?? `${item?.txHash ?? ""}:${item?.logIndex ?? 0}`),
    txHash: String(item?.txHash ?? ""),
    logIndex: Number(item?.logIndex ?? 0),
    blockNumber: Number(item?.blockNumber ?? 0),
    blockTime: String(item?.blockTime ?? ""),
    side: String(item?.side ?? "buy") === "sell" ? "sell" : "buy",
    wallet: String(item?.wallet ?? ""),
    tokenAmount: item?.tokenAmount == null ? null : Number(item.tokenAmount),
    bnbAmount: item?.bnbAmount == null ? null : Number(item.bnbAmount),
    priceBnb: item?.priceBnb == null ? null : Number(item.priceBnb),
    campaignAddress: String(item?.campaignAddress ?? ""),
    tokenAddress: item?.tokenAddress ? String(item.tokenAddress) : null,
    campaignName: item?.campaignName ?? null,
    campaignSymbol: item?.campaignSymbol ?? null,
    logoUri: item?.logoUri ?? null,
    chainId: Number(item?.chainId ?? fallbackChainId) || fallbackChainId,
  };
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
  const [createdCoins, setCreatedCoins] = useState<PublicCoin[]>([]);
  const [loadingCoins, setLoadingCoins] = useState(false);
  const [visibleDrafts, setVisibleDrafts] = useState<CampaignDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [recruiter, setRecruiter] = useState<RecruiterSummary | null>(null);
  const [walletAttribution, setWalletAttribution] = useState<WalletAttributionPublicState | null>(null);
  const [squad, setSquad] = useState<SquadSummary | null>(null);
  const [loadingBadges, setLoadingBadges] = useState(false);
  const [publicTrades, setPublicTrades] = useState<ActivityTradeRow[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  // Phase 6: cached portfolio metrics from backend
  const [portfolioMetrics, setPortfolioMetrics] = useState<PortfolioMetrics | null>(null);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  // Rich client-side portfolio metrics (same as Command Center).
  // Used when viewing your own public profile for accurate live TOTAL VALUE, TOP HOLDING, COINS, and on-chain WALLET AGE.
  const ownerBalances = useProfileBalances({
    viewedAddress: profileWallet,
    account: isOwnProfile ? (wallet.account || null) : null,
    wallet,
    fetchCampaigns,
    fetchCampaignSummary,
    profileCreatedAt: profile?.createdAt,
  });

  // When the viewer is the owner of this profile, we use the rich client-side metrics
  // (identical to Command Center) for accurate live data instead of the backend cache.
  const effectivePortfolioMetrics = isOwnProfile ? ownerBalances.portfolioMetrics : portfolioMetrics;
  const effectiveLoadingPortfolio = isOwnProfile ? ownerBalances.loadingPortfolioMetrics : loadingPortfolio;

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
    if (createdCoins.length > 0 || visibleDrafts.length > 0 || publicTrades.length > 0) score += 25;
    return score;
  }, [profile?.avatarUrl, profile?.bio, profile?.displayName, createdCoins.length, visibleDrafts.length, publicTrades.length]);

  const reputationSignals = useMemo(
    () => [
      { label: "Rank", value: rank, detail: "Current public progression" },
      { label: "Created", value: formatCompactNumber(createdCoins.length), detail: "Public launched coins" },
      { label: "Drafts", value: formatCompactNumber(visibleDrafts.length), detail: "Public Prepare drafts" },
      { label: "Trades", value: formatCompactNumber(publicTrades.length), detail: "Recent public activity" },
    ],
    [rank, createdCoins.length, visibleDrafts.length, publicTrades.length]
  );

  const publicTrustTags = useMemo(() => {
    const tags: string[] = [];
    if (recruiter?.code) tags.push("Recruiter verified");
    if (recruiter?.isOg) tags.push("OG recruiter");
    if (squad?.recruiterCode || walletAttribution?.recruiterCode) tags.push("Squad-linked");
    if (createdCoins.length > 0) tags.push("Creator activity");
    if (publicTrades.length > 0) tags.push("Trader activity");
    if (visibleDrafts.length > 0) tags.push("Public drafts");
    return tags;
  }, [createdCoins.length, publicTrades.length, recruiter?.code, recruiter?.isOg, squad?.recruiterCode, visibleDrafts.length, walletAttribution?.recruiterCode]);

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

  // Portfolio metrics on public profile — only for the owner for now
  // (uses client-side data when isOwnProfile so we don't depend on new backend routes on dev branch)
  useEffect(() => {
    // For non-owners viewing a public profile, load via the cached backend endpoint
    // (avoids putting heavy on-chain work on every visitor).
    if (isOwnProfile) {
      // Owners use the rich client-side path below (via ownerBalances).
      setPortfolioError(null);
      setLoadingPortfolio(false);
      return;
    }

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
  }, [activeChainId, profileWallet, isOwnProfile]);

  useEffect(() => {
    let cancelled = false;

    const loadCoins = async () => {
      setLoadingCoins(true);
      try {
        const campaigns = (await fetchCampaigns()) ?? [];
        const mine = campaigns.filter((campaign: any) => {
          const creator = String(campaign?.creator ?? campaign?.creatorAddress ?? "").toLowerCase();
          return creator === profileWallet.toLowerCase();
        });

        const settled = await Promise.allSettled(mine.map((campaign) => fetchCampaignSummary(campaign)));
        if (cancelled) return;

        const coins = settled
          .filter((item): item is PromiseFulfilledResult<CampaignSummary> => item.status === "fulfilled")
          .map((item, index) => coinFromSummary(item.value, index, activeChainId));

        setCreatedCoins(coins);
      } catch (e) {
        console.warn("Failed to load public created coins", e);
        if (!cancelled) setCreatedCoins([]);
      } finally {
        if (!cancelled) setLoadingCoins(false);
      }
    };

    loadCoins();
    return () => {
      cancelled = true;
    };
  }, [activeChainId, fetchCampaigns, fetchCampaignSummary, profileWallet]);

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

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    const loadActivity = async () => {
      setLoadingActivity(true);
      setActivityError(null);
      try {
        const qs = new URLSearchParams({
          chainId: String(activeChainId),
          wallet: profileWallet,
          limit: "12",
        });
        const res = await fetch(buildRealtimeApiUrl(`/api/activity/trades?${qs.toString()}`), {
          method: "GET",
          signal: ac.signal,
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(String(json?.error || `HTTP ${res.status}`));
        if (cancelled) return;

        const items = Array.isArray(json?.items) ? json.items : [];
        setPublicTrades(items.map((item: any) => tradeFromApiItem(item, activeChainId)));
      } catch (e: any) {
        if (cancelled || ac.signal.aborted) return;
        console.warn("Failed to load public profile activity", e);
        setActivityError(String(e?.message || "Failed to load public activity."));
        setPublicTrades([]);
      } finally {
        if (!cancelled) setLoadingActivity(false);
      }
    };

    loadActivity();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [activeChainId, profileWallet]);

  const copyAddress = () => {
    navigator.clipboard.writeText(profileWallet);
    toast.success("Address copied!");
  };

  // No refresh handler for portfolio on Public Profile for now
  // (we avoid calling the route that isn't on the dev branch yet).
  const handlePortfolioRefresh = async () => {
    if (!profileWallet || !activeChainId) return;

    // For owners we rely on the rich client-side calculation (refreshes on page load or wallet actions).
    // The button is shown for owners for future parity; currently a hard refresh gives fresh data.
    if (isOwnProfile) {
      // Future: we could add a way to force the useProfileBalances hook to re-run.
      return;
    }

    try {
      const data = await fetchPublicPortfolioMetrics(activeChainId, profileWallet, { forceRefresh: true });
      setPortfolioMetrics(data ?? null);
      setPortfolioError(null);
    } catch (e: any) {
      setPortfolioError(String(e?.message || "Failed to refresh portfolio metrics."));
    }
  };

  return (
    <div className="w-full pb-10 pt-4 md:pt-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <section className="rounded-3xl border border-border/50 bg-card/35 p-5 shadow-2xl backdrop-blur-md md:p-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 flex-col gap-5 sm:flex-row">
              <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full border-4 border-accent/30 bg-accent/10">
                {profile?.avatarUrl ? (
                  <img src={profile.avatarUrl} alt={displayName} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center font-retro text-3xl text-accent">
                    {profileWallet.slice(2, 4).toUpperCase()}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <div className="mb-2 inline-flex rounded-full border border-accent/30 bg-accent/10 px-3 py-1 font-retro text-[10px] uppercase tracking-[0.18em] text-accent">
                  Public Profile
                </div>
                <h1 className="truncate font-retro text-2xl text-foreground md:text-4xl">
                  {loadingProfile ? "Loading profile..." : displayName}
                </h1>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{profileWallet}</span>
                  <button onClick={copyAddress} className="rounded p-1 hover:bg-muted" title="Copy address">
                    <Copy className="h-4 w-4" />
                  </button>
                  <a href={explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    Explorer <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                {profile?.bio ? (
                  <p className="mt-4 max-w-2xl whitespace-pre-wrap text-sm text-muted-foreground">{profile.bio}</p>
                ) : (
                  <p className="mt-4 max-w-2xl text-sm text-muted-foreground">No public bio yet.</p>
                )}
              </div>
            </div>

            <div className="flex w-full flex-col gap-3 md:w-[280px]">
              <RankBadgeCard rank={rank} subtitle="Public rank" className="w-full" />
              {isOwnProfile ? (
                <Button onClick={() => navigate("/profile")} className="w-full font-retro">
                  Open Command Center
                </Button>
              ) : (
                <>
                  <Button
                    onClick={() => void handleToggleFollow()}
                    disabled={followBusy}
                    variant={isFollowing ? "outline" : "default"}
                    className="w-full font-retro"
                  >
                    {followBusy ? "Updating…" : isFollowing ? "Unfollow" : "Follow"}
                  </Button>
                  <Link
                    to={buildAbuseReportPath({
                      entityType: "profile",
                      reportedWallet: profileWallet,
                      reportedUrl: typeof window !== "undefined" ? window.location.href : `/profile/${profileWallet}`,
                    })}
                    className="inline-flex h-10 w-full items-center justify-center rounded-md px-4 font-retro text-xs text-muted-foreground hover:bg-card/70 hover:text-foreground"
                  >
                    <Flag className="mr-2 h-3.5 w-3.5" />
                    Report abuse
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Portfolio metrics grid — shown on all public profiles.
            Uses the cached /api/profile/portfolio backend endpoint.
            Owners see a Refresh button that forces a fresh server-side calculation. */}
        <PortfolioMetricsGrid
          metrics={effectivePortfolioMetrics}
          loading={effectiveLoadingPortfolio}
          onRefresh={isOwnProfile ? handlePortfolioRefresh : undefined}
          variant="public"
        />
        {portfolioError && !isOwnProfile ? (
          <div className="text-xs text-muted-foreground">Portfolio metrics temporarily unavailable.</div>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-border/50 bg-card/35 p-5 backdrop-blur-md">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-retro text-lg text-foreground">Badges</h2>
              {loadingBadges ? <div className="text-xs text-muted-foreground">Loading...</div> : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => recruiter?.code && navigate(`/recruiters/${recruiter.code}`)}
                disabled={!recruiter?.code}
                className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition enabled:hover:border-accent/50 enabled:hover:bg-background/50 disabled:cursor-default"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-retro text-sm text-foreground">Recruiter</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {recruiter ? `/${recruiter.code}` : "No recruiter badge yet."}
                    </div>
                  </div>
                  {recruiter?.isOg ? (
                    <span className="rounded-full border border-accent/40 px-2 py-0.5 text-[10px] font-retro text-accent">OG</span>
                  ) : null}
                </div>
                {recruiter ? (
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">Status</div>
                      <div className="capitalize text-foreground">{recruiter.status || "active"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Linked wallets</div>
                      <div className="text-foreground">{formatCompactNumber(recruiter.linkedWalletCount)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Creators</div>
                      <div className="text-foreground">{formatCompactNumber(recruiter.linkedCreatorsCount)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Traders</div>
                      <div className="text-foreground">{formatCompactNumber(recruiter.linkedTradersCount)}</div>
                    </div>
                  </div>
                ) : null}
              </button>

              <button
                type="button"
                onClick={() => {
                  const code = recruiter?.code || walletAttribution?.recruiterCode;
                  if (code) navigate(`/squads?recruiter=${encodeURIComponent(code)}`);
                }}
                disabled={!squad && !walletAttribution?.recruiterCode}
                className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition enabled:hover:border-accent/50 enabled:hover:bg-background/50 disabled:cursor-default"
              >
                <div className="font-retro text-sm text-foreground">Squad</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {squad?.recruiterCode
                    ? `Squad /${squad.recruiterCode}`
                    : walletAttribution?.recruiterCode
                      ? `Linked via /${walletAttribution.recruiterCode}`
                      : "No squad badge yet."}
                </div>
                {squad || walletAttribution ? (
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">State</div>
                      <div className="capitalize text-foreground">{walletAttribution?.squadState || squad?.recruiterStatus || "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Members</div>
                      <div className="text-foreground">{formatCompactNumber(squad?.activeMemberCount)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Eligible</div>
                      <div className="text-foreground">{formatCompactNumber(squad?.eligibleMemberCount)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Last routed</div>
                      <div className="text-foreground">{formatTimeAgo(squad?.lastRoutedAt) || "—"}</div>
                    </div>
                  </div>
                ) : null}
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-border/50 bg-card/35 p-5 backdrop-blur-md">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-retro text-lg text-foreground">Reputation</h2>
                   </div>
              <div className="rounded-full border border-accent/35 bg-accent/10 px-3 py-1 text-xs font-retro text-accent">
                {profileCompleteness}% complete
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {reputationSignals.map((signal) => (
                <div key={signal.label} className="rounded-xl border border-border/40 bg-background/30 p-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{signal.label}</div>
                  <div className="mt-1 font-retro text-base text-foreground">{signal.value}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{signal.detail}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {publicTrustTags.length ? (
                publicTrustTags.map((tag) => (
                  <span key={tag} className="rounded-full border border-border/40 bg-background/30 px-3 py-1 text-[11px] text-muted-foreground">
                    {tag}
                  </span>
                ))
              ) : (
                <span className="rounded-full border border-border/40 bg-background/30 px-3 py-1 text-[11px] text-muted-foreground">
                  Building public history
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border/50 bg-card/35 p-5 backdrop-blur-md">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-retro text-lg text-foreground">Created Coins</h2>
            </div>
            <div className="text-xs text-muted-foreground">{createdCoins.length} visible</div>
          </div>

          {loadingCoins ? (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">Loading created coins...</div>
          ) : createdCoins.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {createdCoins.map((coin) => (
                <button
                  key={coin.campaignAddress}
                  onClick={() =>
                    navigate(
                      tokenDetailsPath({
                        tokenAddress: coin.tokenAddress,
                        campaignAddress: coin.campaignAddress,
                        chainId: coin.chainId,
                      }),
                    )
                  }
                  className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition hover:border-accent/50 hover:bg-background/50"
                >
                  <div className="flex items-center gap-3">
                    <img src={coin.image} alt={coin.name} className="h-11 w-11 rounded-full object-cover" />
                    <div className="min-w-0">
                      <div className="truncate font-retro text-sm text-foreground">{coin.name}</div>
                      <div className="text-xs text-muted-foreground">${coin.ticker}</div>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">Status</div>
                      <div className="capitalize text-foreground">{coin.status ?? "live"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Market cap</div>
                      <div className="text-foreground">{coin.marketCap}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Progress</div>
                      <div className="text-foreground">{coin.progress ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Created</div>
                      <div className="text-foreground">{coin.timeAgo ?? "—"}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">No public created coins yet.</div>
          )}
        </section>

        <section className="rounded-2xl border border-border/50 bg-card/35 p-5 backdrop-blur-md">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-retro text-lg text-foreground">Visible Drafts</h2>
            </div>
            <div className="text-xs text-muted-foreground">{visibleDrafts.length} visible</div>
          </div>

          {loadingDrafts ? (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">Loading visible drafts...</div>
          ) : draftsError ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{draftsError}</div>
          ) : visibleDrafts.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleDrafts.map((draft) => (
                <button
                  key={draft.id}
                  onClick={() => navigate(draftHref(draft))}
                  className="rounded-xl border border-border/40 bg-background/30 p-4 text-left transition hover:border-accent/50 hover:bg-background/50"
                >
                  <div className="flex items-center gap-3">
                    <img src={draft.logoUrl || "/placeholder.svg"} alt={draft.name} className="h-11 w-11 rounded-full object-cover" />
                    <div className="min-w-0">
                      <div className="truncate font-retro text-sm text-foreground">{draft.name}</div>
                      <div className="text-xs text-muted-foreground">${draft.ticker}</div>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">Visibility</div>
                      <div className="capitalize text-foreground">{draft.visibility}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Status</div>
                      <div className="capitalize text-foreground">{draft.status.replace(/_/g, " ")}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Category</div>
                      <div className="capitalize text-foreground">{draft.category || "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Updated</div>
                      <div className="text-foreground">{formatTimeAgo(draft.updatedAt) || "—"}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
              No public drafts yet.
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border/50 bg-card/35 p-5 backdrop-blur-md">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-retro text-lg text-foreground">Public Activity</h2>
            </div>
            <div className="text-xs text-muted-foreground">{publicTrades.length} recent</div>
          </div>

          {loadingActivity ? (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">Loading public activity...</div>
          ) : activityError ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{activityError}</div>
          ) : publicTrades.length ? (
            <div className="space-y-3">
              {publicTrades.map((trade) => (
                <button
                  key={trade.id}
                  onClick={() => {
                    const path = tokenDetailsPath({
                      tokenAddress: trade.tokenAddress,
                      campaignAddress: trade.campaignAddress,
                      chainId: (trade as any).chainId,
                    });
                    if (path && path !== "/") navigate(path);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/40 bg-background/30 p-4 text-left transition hover:border-accent/50 hover:bg-background/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <img src={trade.logoUri || "/placeholder.svg"} alt={trade.campaignName || "Token"} className="h-10 w-10 rounded-full object-cover" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={trade.side === "buy" ? "text-emerald-400" : "text-orange-400"}>{trade.side.toUpperCase()}</span>
                        <span className="truncate font-retro text-sm text-foreground">{trade.campaignName || shorten(trade.campaignAddress)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {trade.campaignSymbol ? `$${trade.campaignSymbol}` : "Token"} · {formatTimeAgo(trade.blockTime) || "—"}
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-xs">
                    <div className="text-foreground">{formatNative(trade.bnbAmount, trade.chainId ?? activeChainId)}</div>
                    <div className="text-muted-foreground">{formatTokenAmount(trade.tokenAmount)} tokens</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
              No public trade activity yet.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

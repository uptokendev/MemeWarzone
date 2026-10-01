import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { useLaunchpad } from "@/lib/launchpadClient";
import {
  BNB_TESTNET_CHAIN_ID,
  getActiveChainId,
  isEvmChainId,
  SOLANA_CHAIN_ID,
} from "@/lib/chainConfig";
import { fetchOwnerCampaignDrafts, fetchPublicCampaignDrafts, type CampaignDraft } from "@/lib/draftApi";
import { isSolanaAddress } from "@/lib/address";
import { useCreatedCampaignsQuery } from "@/hooks/profile/useCreatedCampaigns";
import { useEditableProfile } from "@/hooks/profile/useEditableProfile";
import { EditProfileDialog } from "@/components/profile/EditProfileDialog";
import { ProfileShell, type ProfileTabKey } from "@/components/profile/ProfileShell";
import { ProfileTimeline, authorsFromFeed, type ProfileCoin } from "@/components/profile/ProfileTimeline";
import { fetchActivityTimeline, fetchFeedPosts, type FeedItem } from "@/lib/feedApi";
import {
  fetchRecruiterSummaryByWallet,
  fetchSquadSummary,
  fetchWalletAttributionState,
} from "@/lib/recruiterApi";
import { followUser, getFollowersCount, getFollowingCount, isFollowingUser, unfollowUser } from "@/lib/followApi";
import { toast } from "sonner";

function walletsEqual(a?: string | null, b?: string | null) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  if (isSolanaAddress(left) && isSolanaAddress(right)) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function isDraftVisibleOnPublicProfile(draft: CampaignDraft) {
  if (draft.visibility !== "public") return false;
  if (draft.status === "archived") return false;
  return true;
}

function getExplorerBase(chainId?: number): string {
  if (chainId === 101 || chainId === 102) return "https://explorer.solana.com";
  if (chainId === 46630) return "https://explorer.testnet.chain.robinhood.com";
  if (chainId === 4663) return "https://explorer.chain.robinhood.com";
  if (chainId === 97) return "https://testnet.bscscan.com";
  if (chainId === 56) return "https://bscscan.com";
  return "https://bscscan.com";
}

export default function PublicProfile({
  profileWallet,
  isOwnProfile,
}: {
  profileWallet: string;
  isOwnProfile: boolean;
}) {
  const wallet = useWallet();
  const { fetchCampaigns, fetchCampaignSummary } = useLaunchpad();
  const anyWallet: any = wallet as any;
  const evmWalletChainId = anyWallet?.chainId ?? null;
  const activeChainId = isSolanaAddress(profileWallet)
    ? SOLANA_CHAIN_ID
    : isEvmChainId(evmWalletChainId)
      ? Number(evmWalletChainId)
      : getActiveChainId(evmWalletChainId) || BNB_TESTNET_CHAIN_ID;

  const viewerAccount = wallet.account || null;
  const [tab, setTab] = useState<ProfileTabKey>("posts");
  const [visibleDrafts, setVisibleDrafts] = useState<CampaignDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [recruiterLabel, setRecruiterLabel] = useState<string | null>(null);
  const [squadLabel, setSquadLabel] = useState<string | null>(null);
  const [publicActivity, setPublicActivity] = useState<FeedItem[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [followSuggestions, setFollowSuggestions] = useState<Array<{ wallet: string; name?: string | null; avatar?: string | null }>>([]);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [loadingFollows, setLoadingFollows] = useState(true);

  const editable = useEditableProfile({
    chainId: activeChainId,
    account: viewerAccount,
    viewedAddress: profileWallet,
    wallet,
  });

  const { created, loading: loadingCoins } = useCreatedCampaignsQuery({
    viewedAddress: profileWallet,
    account: isOwnProfile ? (wallet.account || null) : null,
    chainId: activeChainId,
    fetchCampaigns,
    fetchCampaignSummary,
  });

  const createdCoins: ProfileCoin[] = useMemo(
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

  const explorerUrl = useMemo(
    () => `${getExplorerBase(activeChainId)}/address/${profileWallet}`,
    [activeChainId, profileWallet],
  );

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

  useEffect(() => {
    let cancelled = false;
    if (!profileWallet) {
      setFollowersCount(0);
      setFollowingCount(0);
      setLoadingFollows(false);
      return;
    }
    setLoadingFollows(true);
    void Promise.all([getFollowersCount(profileWallet, 0), getFollowingCount(profileWallet, 0)])
      .then(([followers, following]) => {
        if (cancelled) return;
        setFollowersCount(followers);
        setFollowingCount(following);
      })
      .catch(() => {
        if (cancelled) return;
        setFollowersCount(0);
        setFollowingCount(0);
      })
      .finally(() => {
        if (!cancelled) setLoadingFollows(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileWallet]);

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
  }, [followBusy, isFollowing, isOwnProfile, profileWallet, viewerAccount, wallet.signer]);

  useEffect(() => {
    let cancelled = false;
    const loadDrafts = async () => {
      setLoadingDrafts(true);
      setDraftsError(null);
      try {
        const profileIsSolana = isSolanaAddress(profileWallet);
        const preferredChainId = profileIsSolana ? SOLANA_CHAIN_ID : activeChainId;
        const drafts = isOwnProfile
          ? await fetchOwnerCampaignDrafts(profileWallet, { chainId: preferredChainId, limit: 100 })
          : await fetchPublicCampaignDrafts({ chainId: preferredChainId, limit: 100 });
        if (cancelled) return;
        const mine = drafts.filter((draft) => walletsEqual(draft.creatorWallet, profileWallet));
        setVisibleDrafts(
          isOwnProfile
            ? mine.filter((draft) => draft.status !== "archived")
            : mine.filter(isDraftVisibleOnPublicProfile),
        );
      } catch (e: any) {
        if (!cancelled) {
          setDraftsError(String(e?.message || "Failed to load visible drafts."));
          setVisibleDrafts([]);
        }
      } finally {
        if (!cancelled) setLoadingDrafts(false);
      }
    };
    void loadDrafts();
    return () => {
      cancelled = true;
    };
  }, [activeChainId, profileWallet, isOwnProfile]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [recruiterResult, attributionResult] = await Promise.allSettled([
          fetchRecruiterSummaryByWallet(profileWallet),
          fetchWalletAttributionState(profileWallet),
        ]);
        if (cancelled) return;
        const nextRecruiter = recruiterResult.status === "fulfilled" ? recruiterResult.value : null;
        const nextAttribution = attributionResult.status === "fulfilled" ? attributionResult.value : null;
        setRecruiterLabel(nextRecruiter?.code ? `/${nextRecruiter.code}` : null);
        const squadCode = nextRecruiter?.code || nextAttribution?.recruiterCode || null;
        if (!squadCode) {
          setSquadLabel(null);
          return;
        }
        try {
          const nextSquad = await fetchSquadSummary(squadCode);
          if (!cancelled) setSquadLabel(nextSquad?.recruiterCode ? `/${nextSquad.recruiterCode}` : `/${squadCode}`);
        } catch {
          if (!cancelled) setSquadLabel(`/${squadCode}`);
        }
      } catch {
        if (!cancelled) {
          setRecruiterLabel(null);
          setSquadLabel(null);
        }
      }
    })();
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
      setActivityError(String(e?.message || "Failed to load public activity."));
      setPublicActivity([]);
    } finally {
      setLoadingActivity(false);
    }
  }, [profileWallet]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    let cancelled = false;
    void fetchFeedPosts({ tab: "for-you", chainId: activeChainId, limit: 40 })
      .then((items) => {
        if (!cancelled) setFollowSuggestions(authorsFromFeed(items, profileWallet));
      })
      .catch(() => {
        if (!cancelled) setFollowSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChainId, profileWallet]);

  return (
    <div data-profile-page="public">
      <ProfileShell
        walletAddress={profileWallet}
        displayName={editable.profile?.displayName}
        handle={editable.profile?.displayName}
        bio={editable.profile?.bio}
        avatarUrl={editable.profile?.avatarUrl}
        bannerUrl={editable.profile?.bannerUrl}
        rank={editable.profile?.rank}
        createdAt={editable.profile?.createdAt}
        explorerUrl={explorerUrl}
        followersCount={followersCount}
        followingCount={followingCount}
        coinsCount={createdCoins.length}
        loadingFollows={loadingFollows}
        recruiterLabel={recruiterLabel}
        squadLabel={squadLabel}
        isOwner={isOwnProfile}
        isFollowing={isFollowing}
        followBusy={followBusy}
        onFollow={() => void handleToggleFollow()}
        onEdit={editable.handleEdit}
        commandBasePath={`/profile/${profileWallet}/command`}
        tab={tab}
        onTabChange={setTab}
        followSuggestions={followSuggestions}
      >
        <ProfileTimeline
          tab={tab}
          isOwner={isOwnProfile}
          chainId={activeChainId}
          posts={publicPosts}
          events={publicEvents}
          coins={createdCoins}
          drafts={visibleDrafts}
          loadingPosts={loadingActivity}
          loadingCoins={loadingCoins}
          loadingDrafts={loadingDrafts}
          loadingActivity={loadingActivity}
          activityError={activityError}
          draftsError={draftsError}
          onPosted={() => void loadActivity()}
        />
      </ProfileShell>

      {isOwnProfile ? (
        <>
          <input
            ref={editable.avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void editable.handleAvatarSelected(file);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={editable.bannerInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void editable.handleBannerSelected(file);
              event.currentTarget.value = "";
            }}
          />
          <EditProfileDialog
            open={editable.editOpen}
            onOpenChange={editable.setEditOpen}
            initialUsername={editable.profile?.displayName ?? ""}
            initialBio={editable.profile?.bio ?? ""}
            avatarUrl={editable.profile?.avatarUrl}
            bannerUrl={editable.profile?.bannerUrl}
            saving={editable.savingProfile}
            savingAvatar={editable.savingAvatar}
            savingBanner={editable.savingBanner}
            onPickAvatar={editable.handlePickAvatar}
            onPickBanner={editable.handlePickBanner}
            onSave={editable.handleSaveProfile}
          />
        </>
      ) : null}
    </div>
  );
}

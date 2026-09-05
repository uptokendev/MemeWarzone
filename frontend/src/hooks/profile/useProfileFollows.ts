import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ProfileTab } from "@/types/profile";
import type { CampaignSummary } from "@/lib/launchpadClient";
import {
  followUser,
  getFollowedCampaigns,
  getFollowers,
  getFollowersCount,
  getFollowing,
  getFollowingCount,
  isFollowingUser,
  unfollowUser,
} from "@/lib/followApi";
import {
  fetchFollowedCampaignDrafts,
  type CampaignDraft,
} from "@/lib/draftApi";
import { formatTimeAgo } from "@/lib/profile/profileFormatters";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { getActiveChainId } from "@/lib/chainConfig";

type FetchCampaigns = () => Promise<any[]>;
type FetchCampaignSummary = (campaign: any) => Promise<CampaignSummary>;

interface UseProfileFollowsArgs {
  activeTab: ProfileTab;
  viewedAddress: string | null;
  isOwnProfile: boolean;
  chainId?: number;
  account: string | null;
  /** Optional ethers signer for signed follow mutations */
  signer?: any;
  fetchCampaigns: FetchCampaigns;
  fetchCampaignSummary: FetchCampaignSummary;
}

export function useProfileFollows({
  activeTab,
  viewedAddress,
  isOwnProfile,
  chainId,
  account,
  signer,
  fetchCampaigns,
  fetchCampaignSummary,
}: UseProfileFollowsArgs) {
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followersList, setFollowersList] = useState<any[]>([]);
  const [followingList, setFollowingList] = useState<any[]>([]);
  const [followingView, setFollowingView] = useState<"campaigns" | "profiles">("campaigns");
  const [followedCampaigns, setFollowedCampaigns] = useState<string[]>([]);
  const [followedDrafts, setFollowedDrafts] = useState<CampaignDraft[]>([]);
  const [followedCards, setFollowedCards] = useState<any[]>([]);
  const [loadingFollows, setLoadingFollows] = useState(true);
  const resolvedChainId = useMemo(() => {
    const explicit = Number(chainId || 0);
    return explicit > 0 ? explicit : Number(getActiveChainId());
  }, [chainId]);

useEffect(() => {
  let cancelled = false;

  const loadFollows = async () => {
    if (!viewedAddress) {
      setFollowersCount(0);
      setFollowingCount(0);
      setIsFollowing(false);
      setFollowersList([]);
      setFollowingList([]);
      setFollowedCampaigns([]);
      setFollowedDrafts([]);
      setLoadingFollows(false);
      return;
    }

    setLoadingFollows(true);

    try {
      const [fc, profileFollowingCount, isF] = await Promise.all([
        getFollowersCount(viewedAddress, resolvedChainId),
        getFollowingCount(viewedAddress, resolvedChainId),
        isOwnProfile || !account
          ? Promise.resolve(false)
          : isFollowingUser(account, viewedAddress, resolvedChainId),
      ]);

      const followedCampaignAddresses: string[] = await getFollowedCampaigns(
        viewedAddress,
        resolvedChainId
      ).catch((): string[] => []);

      const draftItems: CampaignDraft[] = await fetchFollowedCampaignDrafts({
        walletAddress: viewedAddress,
      }).catch((): CampaignDraft[] => []);

      if (cancelled) return;

      setFollowersCount(fc);

      setFollowingCount(
        Number(profileFollowingCount || 0) +
          followedCampaignAddresses.length +
          draftItems.length
      );

      setIsFollowing(isF);
      setFollowedCampaigns(followedCampaignAddresses);
      setFollowedDrafts(draftItems);

      if (activeTab === "followers") {
        const fl = await getFollowers(viewedAddress, resolvedChainId);
        if (!cancelled) setFollowersList(fl);
      } else if (activeTab === "following") {
        const fl = await getFollowing(viewedAddress, resolvedChainId);
        if (!cancelled) setFollowingList(fl);
      }
    } catch (err) {
      console.error("Follow data load failed", err);
    } finally {
      if (!cancelled) setLoadingFollows(false);
    }
  };

  loadFollows();

  return () => {
    cancelled = true;
  };
}, [viewedAddress, activeTab, isOwnProfile, resolvedChainId, account]);

useEffect(() => {
  let cancelled = false;

  const loadFollowedCampaignCards = async () => {
    try {
      if (activeTab !== "following") {
        setFollowedCards([]);
        return;
      }

      if (!viewedAddress) {
        setFollowedCards([]);
        return;
      }

      const addrs = (followedCampaigns || [])
        .map((a) => String(a || "").toLowerCase())
        .filter(Boolean);

      const all = addrs.length > 0 ? (await fetchCampaigns()) ?? [] : [];

      const wanted = all.filter((c) =>
        addrs.includes(
          String((c as any).campaignAddress ?? (c as any).campaign ?? "").toLowerCase()
        )
      );

      const results = await Promise.allSettled(
        wanted.map((c) => fetchCampaignSummary(c))
      );

      if (cancelled) return;

      const liveCards = results
        .filter((r): r is PromiseFulfilledResult<CampaignSummary> => r.status === "fulfilled")
        .map((r, idx) => {
          const s = r.value;

          return {
            kind: "campaign",
            id: typeof s.campaign.id === "number" ? s.campaign.id : idx + 1,
            image: s.campaign.logoURI || "/placeholder.svg",
            name: s.campaign.name,
            ticker: s.campaign.symbol,
            campaignAddress: s.campaign.campaign,
            href: tokenDetailsPath({
              tokenAddress: s.campaign.token,
              campaignAddress: s.campaign.campaign,
              chainId: resolvedChainId,
            }, { chainId: resolvedChainId }),
            marketCap: s.stats.marketCap,
            timeAgo: (s.campaign as any).timeAgo || formatTimeAgo(s.campaign.createdAt),
            buyersCount: (s.stats as any)?.buyersCount ?? undefined,
          };
        });

      const draftCards = (followedDrafts || []).map((draft) => ({
        kind: "draft",
        id: `draft-${draft.id}`,
        image: draft.logoUrl || "/placeholder.svg",
        name: draft.name,
        ticker: draft.ticker,
        draftId: draft.id,
        slug: draft.slug,
        chainId: Number(draft.chainId || 0) || undefined,
        campaignAddress: draft.campaignAddress || "",
        href: `/prepare/${draft.slug}`,
        marketCap: "Prepare Mode",
        status: draft.status,
        timeAgo: draft.createdAt
          ? formatTimeAgo(Math.floor(new Date(draft.createdAt).getTime() / 1000))
          : "",
      }));

      setFollowedCards([...draftCards, ...liveCards]);
    } catch (e) {
      console.error("[Profile] Failed to load followed campaigns", e);
      if (!cancelled) setFollowedCards([]);
    }
  };

  loadFollowedCampaignCards();

  return () => {
    cancelled = true;
  };
}, [
  activeTab,
  viewedAddress,
  followedCampaigns,
  followedDrafts,
  fetchCampaigns,
  fetchCampaignSummary,
  resolvedChainId,
]);

  const handleToggleFollow = useCallback(async () => {
    if (!viewedAddress || isOwnProfile) return;

    try {
      if (!account) throw new Error("Connect wallet");

      const signOpts = signer ? { signer } : undefined;
      if (isFollowing) {
        await unfollowUser(account, viewedAddress, resolvedChainId, signOpts);
        setIsFollowing(false);
        setFollowersCount((c) => Math.max(0, c - 1));
      } else {
        await followUser(account, viewedAddress, resolvedChainId, signOpts);
        setIsFollowing(true);
        setFollowersCount((c) => c + 1);
      }
    } catch (err) {
      toast.error("Failed to update follow");
    }
  }, [account, resolvedChainId, isFollowing, isOwnProfile, viewedAddress, signer]);

  return {
    followersCount,
    followingCount,
    isFollowing,
    followersList,
    followingList,
    followingView,
    setFollowingView,
    followedCampaigns,
    followedCards,
    loadingFollows,
    handleToggleFollow,
  };
}

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
import { fetchArenaTokenProfile } from "@/lib/arenaImports";
import { getActiveChainId, isSolanaChainId } from "@/lib/chainConfig";
import { apiFetch } from "@/lib/apiBase";

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

      let wantedSolanaCards: any[] = [];
      const addrs = (followedCampaigns || [])
        .map((a) => String(a || "").toLowerCase())
        .filter(Boolean);

      const all = addrs.length > 0 ? (await fetchCampaigns()) ?? [] : [];

      const wanted = all.filter((c) =>
        addrs.includes(
          String((c as any).campaignAddress ?? (c as any).campaign ?? "").toLowerCase()
        )
      );

      // Solana campaigns: the on-chain adapter has no name, logo or USD market cap (it maps every
      // campaign to a "Solana Launch / $SOL" placeholder and prints lamports as BNB), so their cards
      // come from the API like the homepage cards. EVM chains keep fetchCampaignSummary.
      if (isSolanaChainId(resolvedChainId)) {
        const solanaCards = await Promise.allSettled(wanted.map(async (c, idx) => {
          const campaign = String((c as any).campaign ?? (c as any).campaignAddress ?? "");
          const token = String((c as any).token ?? (c as any).tokenAddress ?? campaign);
          const [metaRes, profile] = await Promise.all([
            apiFetch(`/api/token-metadata/${resolvedChainId}/${encodeURIComponent(token)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetchArenaTokenProfile(token, resolvedChainId).catch(() => null),
          ]);
          const meta = metaRes?.metadata || metaRes || {};
          return {
            kind: "campaign",
            id: typeof (c as any).id === "number" ? (c as any).id : idx + 1,
            image: meta.image || profile?.imageUrl || "/placeholder.svg",
            name: meta.name || profile?.name || token,
            ticker: meta.symbol || profile?.symbol || "",
            campaignAddress: campaign,
            href: tokenDetailsPath({ tokenAddress: token, campaignAddress: campaign, chainId: resolvedChainId }, { chainId: resolvedChainId }),
            marketCap: profile?.marketCapUsd != null ? `$${Number(profile.marketCapUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—",
            timeAgo: formatTimeAgo((c as any).createdAt),
            chainId: resolvedChainId,
          };
        }));
        if (cancelled) return;
        wantedSolanaCards = solanaCards.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled").map((r) => r.value);
      }

      const results = isSolanaChainId(resolvedChainId) ? [] : await Promise.allSettled(
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

      // Followed imported coins are not launched campaigns, so the campaign list above never matches
      // them; resolve them as imports (original address case: Solana mints are case-sensitive).
      const matched = new Set(wanted.map((c) => String((c as any).campaignAddress ?? (c as any).campaign ?? "").toLowerCase()));
      const unmatched = (followedCampaigns || []).map((a) => String(a || "").trim()).filter((a) => a && !matched.has(a.toLowerCase()));
      const importProfiles = await Promise.allSettled(unmatched.map((a) => fetchArenaTokenProfile(a, resolvedChainId)));
      if (cancelled) return;
      const importCards = importProfiles
        .map((r, i) => (r.status === "fulfilled" && r.value && r.value.origin === "import" ? { profile: r.value, address: unmatched[i] } : null))
        .filter((x): x is { profile: NonNullable<Awaited<ReturnType<typeof fetchArenaTokenProfile>>>; address: string } => Boolean(x))
        .map(({ profile, address }, idx) => ({
          kind: "campaign",
          id: `import-${idx}-${address}`,
          image: profile.imageUrl || "/placeholder.svg",
          name: profile.name || address,
          ticker: profile.symbol || "",
          campaignAddress: address,
          href: `/token/${address}?chainId=${resolvedChainId}`,
          marketCap: profile.marketCapUsd != null ? `$${Number(profile.marketCapUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—",
          timeAgo: "Imported",
          chainId: resolvedChainId,
        }));

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

      setFollowedCards([...draftCards, ...wantedSolanaCards, ...liveCards, ...importCards]);
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

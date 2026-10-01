import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { ArenaDailyBriefing } from "@/components/command-center/ArenaDailyBriefing";
import { CommandCenterDataProvider, useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { EditProfileDialog } from "@/components/profile/EditProfileDialog";
import { ProfileShell, type ProfileTabKey } from "@/components/profile/ProfileShell";
import { ProfileTimeline, authorsFromFeed, type ProfileCoin } from "@/components/profile/ProfileTimeline";
import { fetchOwnerCampaignDrafts, type CampaignDraft } from "@/lib/draftApi";
import { fetchActivityTimeline, fetchFeedPosts, type FeedItem } from "@/lib/feedApi";
import { isSolanaAddress } from "@/lib/address";
import { SOLANA_CHAIN_ID } from "@/lib/chainConfig";

type CommandCenterLayoutProps = {
  walletAddress: string;
  basePath: string;
  children: ReactNode;
};

const TOOL_TITLES: Record<string, string> = {
  overview: "Overview",
  coins: "Coins",
  battles: "Battles",
  recruiter: "Recruiter",
  squad: "Squad",
  airdrops: "Airdrops",
  claims: "Claims",
  settings: "Settings",
  followers: "Followers",
  following: "Following",
  support: "Support",
  feed: "Feed",
};

function isExactCommandHome(pathname: string, basePath: string) {
  const trimmed = pathname.replace(/\/+$/, "");
  const base = basePath.replace(/\/+$/, "");
  return trimmed === base;
}

function toolTitle(pathname: string, basePath: string) {
  const suffix = pathname.slice(basePath.length).split("/").filter(Boolean)[0] || "overview";
  return TOOL_TITLES[suffix] || "Command";
}

function explorerUrlFor(walletAddress: string, chainId?: number) {
  if (isSolanaAddress(walletAddress) || chainId === 101 || chainId === 102) {
    return `https://explorer.solana.com/address/${walletAddress}`;
  }
  if (chainId === 46630) return `https://explorer.testnet.chain.robinhood.com/address/${walletAddress}`;
  if (chainId === 4663) return `https://explorer.chain.robinhood.com/address/${walletAddress}`;
  if (chainId === 97) return `https://testnet.bscscan.com/address/${walletAddress}`;
  return `https://bscscan.com/address/${walletAddress}`;
}

function CommandCenterFileInputs() {
  const {
    avatarInputRef,
    bannerInputRef,
    handleAvatarSelected,
    handleBannerSelected,
  } = useCommandCenterData();

  return (
    <>
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleAvatarSelected(file);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleBannerSelected(file);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

function CommandCenterProfileHome({ basePath }: { basePath: string }) {
  const {
    walletAddress,
    chainId,
    profile,
    displayName,
    avatarUrl,
    bannerUrl,
    followersCount,
    followingCount,
    loadingFollows,
    created,
    liveRank,
    attribution,
    handleEdit,
    editOpen,
    setEditOpen,
    savingProfile,
    savingAvatar,
    savingBanner,
    handlePickAvatar,
    handlePickBanner,
    handleSaveProfile,
  } = useCommandCenterData();

  const [tab, setTab] = useState<ProfileTabKey>("posts");
  const [activity, setActivity] = useState<FeedItem[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<CampaignDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [followSuggestions, setFollowSuggestions] = useState<Array<{ wallet: string; name?: string | null; avatar?: string | null }>>([]);

  const resolvedChainId = isSolanaAddress(walletAddress) ? SOLANA_CHAIN_ID : Number(chainId || 56);

  const coins: ProfileCoin[] = useMemo(
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

  const posts = useMemo(() => activity.filter((item) => item.type === "post"), [activity]);
  const events = useMemo(() => activity.filter((item) => item.type !== "post"), [activity]);

  const loadActivity = useCallback(async () => {
    if (!walletAddress) return;
    setLoadingActivity(true);
    setActivityError(null);
    try {
      setActivity(await fetchActivityTimeline(walletAddress, 40));
    } catch (e: any) {
      setActivityError(String(e?.message || "Failed to load posts."));
      setActivity([]);
    } finally {
      setLoadingActivity(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDrafts(true);
    void fetchOwnerCampaignDrafts(walletAddress, { chainId: resolvedChainId, limit: 100 })
      .then((items) => {
        if (!cancelled) setDrafts(Array.isArray(items) ? items.filter((d) => d.status !== "archived") : []);
      })
      .catch(() => {
        if (!cancelled) setDrafts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDrafts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedChainId, walletAddress]);

  useEffect(() => {
    let cancelled = false;
    void fetchFeedPosts({ tab: "for-you", chainId: resolvedChainId, limit: 40 })
      .then((items) => {
        if (!cancelled) setFollowSuggestions(authorsFromFeed(items, walletAddress));
      })
      .catch(() => {
        if (!cancelled) setFollowSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedChainId, walletAddress]);

  const handle = String(profile?.displayName || "").trim() || null;
  const title = handle || displayName.replace(/^@/, "");

  return (
    <div data-profile-page="command">
      <ProfileShell
        walletAddress={walletAddress}
        displayName={title}
        handle={handle}
        bio={profile?.bio}
        avatarUrl={avatarUrl || null}
        bannerUrl={bannerUrl}
        rank={liveRank || profile?.rank}
        createdAt={profile?.createdAt}
        explorerUrl={explorerUrlFor(walletAddress, chainId)}
        followersCount={followersCount}
        followingCount={followingCount}
        coinsCount={coins.length}
        loadingFollows={loadingFollows}
        recruiterLabel={attribution?.recruiterCode ? `/${attribution.recruiterCode}` : null}
        squadLabel={attribution?.squadState ? attribution.squadState : null}
        isOwner
        onEdit={handleEdit}
        commandBasePath={basePath}
        tab={tab}
        onTabChange={setTab}
        followSuggestions={followSuggestions}
        followersHref={`${basePath}/followers`}
        followingHref={`${basePath}/following`}
      >
        <ProfileTimeline
          tab={tab}
          isOwner
          chainId={resolvedChainId}
          posts={posts}
          events={events}
          coins={coins}
          drafts={drafts}
          loadingPosts={loadingActivity}
          loadingCoins={false}
          loadingDrafts={loadingDrafts}
          loadingActivity={loadingActivity}
          activityError={activityError}
          onPosted={() => void loadActivity()}
        />
      </ProfileShell>

      <EditProfileDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initialUsername={profile?.displayName ?? ""}
        initialBio={profile?.bio ?? ""}
        avatarUrl={profile?.avatarUrl}
        bannerUrl={profile?.bannerUrl}
        saving={savingProfile}
        savingAvatar={savingAvatar}
        savingBanner={savingBanner}
        onPickAvatar={handlePickAvatar}
        onPickBanner={handlePickBanner}
        onSave={handleSaveProfile}
      />
    </div>
  );
}

function CommandCenterToolFrame({
  basePath,
  children,
}: {
  basePath: string;
  children: ReactNode;
}) {
  const location = useLocation();
  const title = toolTitle(location.pathname, basePath);

  return (
    <ContentContainer className="mwz-command-center-layout space-y-4 pb-8 pt-4">
      <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3" data-command-tool="true">
        <Link
          to={basePath}
          aria-label="Back to profile"
          data-command-back="true"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-accent text-accent"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-retro text-lg text-foreground">{title}</h1>
      </div>
      <ArenaDailyBriefing />
      <div className="min-w-0 px-4">{children}</div>
    </ContentContainer>
  );
}

export function CommandCenterLayout({ walletAddress, basePath, children }: CommandCenterLayoutProps) {
  const location = useLocation();
  const isHome = isExactCommandHome(location.pathname, basePath);

  return (
    <CommandCenterDataProvider key={walletAddress} walletAddress={walletAddress}>
      <div>
        <CommandCenterFileInputs />
        {isHome ? (
          <CommandCenterProfileHome basePath={basePath} />
        ) : (
          <CommandCenterToolFrame basePath={basePath}>{children}</CommandCenterToolFrame>
        )}
      </div>
    </CommandCenterDataProvider>
  );
}

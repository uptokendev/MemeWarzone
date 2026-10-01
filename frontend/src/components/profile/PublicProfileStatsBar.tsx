import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Users, UserPlus, Coins } from "lucide-react";

import { useWallet } from "@/contexts/WalletContext";
import { useLaunchpad } from "@/lib/launchpadClient";
import { getActiveChainId } from "@/lib/chainConfig";
import { useCreatedCampaigns } from "@/hooks/profile/useCreatedCampaigns";
import { useProfileFollows } from "@/hooks/profile/useProfileFollows";
import type { ProfileTab } from "@/types/profile";

type PublicProfileStatsBarProps = {
  profileWallet: string;
  isOwnProfile: boolean;
};

function shortenWallet(addr?: string | null) {
  if (!addr) return "";
  return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

function formatCount(value: number) {
  return Number(value || 0).toLocaleString();
}

function syncCreatedCoinsAnchor() {
  const sections = Array.from(document.querySelectorAll("section"));
  const createdSection = sections.find((section) =>
    section.textContent?.toLowerCase().includes("created coins"),
  );
  if (createdSection && !createdSection.id) {
    createdSection.id = "created-coins";
  }
  return createdSection as HTMLElement | undefined;
}

export function PublicProfileStatsBar({ profileWallet, isOwnProfile }: PublicProfileStatsBarProps) {
  const navigate = useNavigate();
  const wallet = useWallet();
  const anyWallet: any = wallet as any;
  const { fetchCampaigns, fetchCampaignSummary } = useLaunchpad();
  const chainId = getActiveChainId(anyWallet?.chainId ?? null);
  const account = wallet.account ?? null;
  const [activeTab, setActiveTab] = useState<ProfileTab>("balances");

  const created = useCreatedCampaigns({
    viewedAddress: profileWallet,
    account,
    fetchCampaigns,
    fetchCampaignSummary,
  });

  const {
    followersCount,
    followingCount,
    followersList,
    followingList,
    followedCards,
    loadingFollows,
  } = useProfileFollows({
    activeTab,
    viewedAddress: profileWallet,
    isOwnProfile,
    chainId,
    account,
    signer: anyWallet?.signer,
    fetchCampaigns,
    fetchCampaignSummary,
  });

  const panelTitle = useMemo(() => {
    if (activeTab === "followers") return "Followers";
    if (activeTab === "following") return "Following";
    return "";
  }, [activeTab]);

  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (hash === "followers") setActiveTab("followers");
      if (hash === "following") setActiveTab("following");
      if (hash === "created-coins") {
        setActiveTab("balances");
        setTimeout(() => syncCreatedCoinsAnchor()?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      }
    };

    syncCreatedCoinsAnchor();
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  const openTab = (tab: "followers" | "following") => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
    document.getElementById("public-profile-stats")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const openCreatedCoins = () => {
    setActiveTab("balances");
    window.history.replaceState(null, "", "#created-coins");
    setTimeout(() => syncCreatedCoinsAnchor()?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  return (
    <section id="public-profile-stats" className="mx-auto mt-4 w-full max-w-6xl rounded-3xl border border-border/50 bg-card/35 p-4 shadow-xl backdrop-blur-md">
      <div className="grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => openTab("followers")}
          className={`rounded-2xl border p-4 text-left transition hover:border-accent/50 hover:bg-background/40 ${
            activeTab === "followers" ? "border-accent/60 bg-accent/10" : "border-border/50 bg-background/25"
          }`}
        >
          <div className="mb-2 flex items-center gap-2 text-muted-foreground">
            <Users className="h-4 w-4 text-accent" />
            <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Followers</span>
          </div>
          <div className="font-retro text-2xl text-foreground">{loadingFollows ? "..." : formatCount(followersCount)}</div>
        </button>

        <button
          type="button"
          onClick={() => openTab("following")}
          className={`rounded-2xl border p-4 text-left transition hover:border-accent/50 hover:bg-background/40 ${
            activeTab === "following" ? "border-accent/60 bg-accent/10" : "border-border/50 bg-background/25"
          }`}
        >
          <div className="mb-2 flex items-center gap-2 text-muted-foreground">
            <UserPlus className="h-4 w-4 text-accent" />
            <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Following</span>
          </div>
          <div className="font-retro text-2xl text-foreground">{loadingFollows ? "..." : formatCount(followingCount)}</div>
        </button>

        <button
          type="button"
          onClick={openCreatedCoins}
          className="rounded-2xl border border-border/50 bg-background/25 p-4 text-left transition hover:border-accent/50 hover:bg-background/40"
        >
          <div className="mb-2 flex items-center gap-2 text-muted-foreground">
            <Coins className="h-4 w-4 text-accent" />
            <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Coins</span>
          </div>
          <div className="font-retro text-2xl text-foreground">{formatCount(created.length)}</div>
        </button>
      </div>

      {(activeTab === "followers" || activeTab === "following") && (
        <div className="mt-4 rounded-2xl border border-border/50 bg-background/25 p-4">
          <div className="mb-3 font-retro text-sm text-foreground">{panelTitle}</div>

          {activeTab === "followers" && (
            followersList.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {followersList.map((item: any, index: number) => {
                  const walletAddress = String(item?.follower ?? item?.wallet ?? item?.address ?? "");
                  return (
                    <button
                      key={`${walletAddress}-${index}`}
                      type="button"
                      onClick={() => walletAddress && navigate(`/profile/${walletAddress}`)}
                      className="rounded-xl border border-border/40 bg-card/25 p-3 text-left transition hover:border-accent/50 hover:bg-card/45"
                    >
                      <div className="font-retro text-xs text-foreground">{shortenWallet(walletAddress)}</div>
                      <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{walletAddress}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No followers to show yet.</div>
            )
          )}

          {activeTab === "following" && (
            followingList.length > 0 || followedCards.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {followingList.map((item: any, index: number) => {
                  const walletAddress = String(item?.following ?? item?.wallet ?? item?.address ?? "");
                  return (
                    <button
                      key={`${walletAddress}-${index}`}
                      type="button"
                      onClick={() => walletAddress && navigate(`/profile/${walletAddress}`)}
                      className="rounded-xl border border-border/40 bg-card/25 p-3 text-left transition hover:border-accent/50 hover:bg-card/45"
                    >
                      <div className="font-retro text-xs text-foreground">{shortenWallet(walletAddress)}</div>
                      <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{walletAddress}</div>
                    </button>
                  );
                })}
                {followedCards.map((card: any) => (
                  <button
                    key={`${card.kind}-${card.id}`}
                    type="button"
                    onClick={() => card.href && navigate(card.href)}
                    className="rounded-xl border border-border/40 bg-card/25 p-3 text-left transition hover:border-accent/50 hover:bg-card/45"
                  >
                    <div className="flex items-center gap-3">
                      <img src={card.image || "/placeholder.svg"} alt={card.name} className="h-9 w-9 rounded-xl object-cover" />
                      <div className="min-w-0">
                        <div className="truncate font-retro text-xs text-foreground">{card.name}</div>
                        <div className="text-[10px] text-muted-foreground">${card.ticker}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No following entries to show yet.</div>
            )
          )}
        </div>
      )}
    </section>
  );
}

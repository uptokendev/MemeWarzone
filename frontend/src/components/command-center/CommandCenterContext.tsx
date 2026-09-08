import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isEvmAddress, isSolanaAddress } from "@/lib/address";
import { BNB_CHAIN_ID, getActiveChainId, isEvmChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { useLaunchpad } from "@/lib/launchpadClient";
import { useEditableProfile } from "@/hooks/profile/useEditableProfile";
import { useProfileFollows } from "@/hooks/profile/useProfileFollows";
import { useCreatedCampaigns } from "@/hooks/profile/useCreatedCampaigns";
import { useProfileBalances } from "@/hooks/profile/useProfileBalances";
import { useProfileRank } from "@/hooks/profile/useProfileRank";
import { useLeagueCabinet } from "@/hooks/profile/useLeagueCabinet";
import { fetchWalletAttributionState, type WalletAttributionPublicState } from "@/lib/recruiterApi";
import { fetchOwnerCampaignDrafts } from "@/lib/draftApi";
import type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";

function shortenWallet(addr?: string | null) {
  if (!addr) return "";
  return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

type CommandCenterData = {
  walletAddress: string;
  chainId?: number;
  walletChainId?: number;
  profile: ReturnType<typeof useEditableProfile>["profile"];
  loadingProfile: boolean;
  editOpen: boolean;
  setEditOpen: ReturnType<typeof useEditableProfile>["setEditOpen"];
  savingProfile: boolean;
  savingAvatar: boolean;
  awaitingWallet: boolean;
  avatarInputRef: ReturnType<typeof useEditableProfile>["avatarInputRef"];
  handleEdit: ReturnType<typeof useEditableProfile>["handleEdit"];
  handlePickAvatar: ReturnType<typeof useEditableProfile>["handlePickAvatar"];
  handleAvatarSelected: ReturnType<typeof useEditableProfile>["handleAvatarSelected"];
  handleSaveProfile: ReturnType<typeof useEditableProfile>["handleSaveProfile"];
  displayName: string;
  avatarUrl: string;
  attribution: WalletAttributionPublicState | null;
  loadingAttribution: boolean;
  followersCount: number;
  followingCount: number;
  loadingFollows: boolean;
  createdCount: number;
  created: ReturnType<typeof useCreatedCampaigns>;
  draftCount: number;
  loadingDraftCount: boolean;
  nativeBalance: string;
  tokenBalances: ReturnType<typeof useProfileBalances>["tokenBalances"];
  loadingBalances: boolean;
  portfolioMetrics: ReturnType<typeof useProfileBalances>["portfolioMetrics"];
  loadingPortfolioMetrics: boolean;
  liveRank: ReturnType<typeof useProfileRank>["liveRank"];
  leagueCabinet: ReturnType<typeof useLeagueCabinet>["leagueCabinet"];
  loadingLeagueCabinet: boolean;
};

const CommandCenterContext = createContext<CommandCenterData | null>(null);

export function CommandCenterDataProvider({
  walletAddress,
  children,
}: {
  walletAddress: string;
  children: ReactNode;
}) {
  const wallet = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const anyWallet: any = wallet as any;
  const hasSolanaWallet = Boolean(isSolanaConnected && solanaAccount);

  const evmWalletChainId: number | undefined = anyWallet?.chainId ?? anyWallet?.network?.chainId;
  const activeAppChainId = getActiveChainId(evmWalletChainId);

  // A 0x address cannot identify which EVM network owns the current Command Center.
  // Prefer the wallet's actual supported EVM chain; if that is temporarily unavailable
  // during provider refresh, preserve the active app/feed EVM chain. Only fall back to
  // BNB mainnet when there is no EVM context at all. Never fall back to BNB testnet,
  // because that caused Robinhood pages to flip back to BNB after initially rendering ETH.
  const addressDrivenChainId = isSolanaAddress(walletAddress)
    ? SOLANA_CHAIN_ID
    : isEvmAddress(walletAddress)
      ? (isEvmChainId(evmWalletChainId)
        ? evmWalletChainId
        : isEvmChainId(activeAppChainId)
          ? activeAppChainId
          : BNB_CHAIN_ID)
      : undefined;

  const walletChainId: number | undefined = addressDrivenChainId
    ?? (hasSolanaWallet ? SOLANA_CHAIN_ID : evmWalletChainId);
  const chainId: number | undefined = addressDrivenChainId
    ?? (hasSolanaWallet ? SOLANA_CHAIN_ID : activeAppChainId);
  const account = isSolanaAddress(walletAddress)
    ? walletAddress
    : hasSolanaWallet
      ? solanaAccount
      : wallet.account || walletAddress;
  const { fetchCampaigns, fetchCampaignSummary } = useLaunchpad();
  const [attribution, setAttribution] = useState<WalletAttributionPublicState | null>(null);
  const [loadingAttribution, setLoadingAttribution] = useState(false);
  const [draftCount, setDraftCount] = useState(0);
  const [loadingDraftCount, setLoadingDraftCount] = useState(false);

  const editableProfile = useEditableProfile({
    chainId,
    account,
    viewedAddress: walletAddress,
    wallet,
  });

  const {
    profile,
    loadingProfile,
    editOpen,
    setEditOpen,
    savingProfile,
    savingAvatar,
    awaitingWallet,
    avatarInputRef,
    handleEdit,
    handlePickAvatar,
    handleAvatarSelected,
    handleSaveProfile,
  } = editableProfile;

  useEffect(() => {
    let cancelled = false;
    setLoadingAttribution(true);
    void fetchWalletAttributionState(walletAddress)
      .then((state) => {
        if (!cancelled) setAttribution(state ?? null);
      })
      .catch(() => {
        if (!cancelled) setAttribution(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingAttribution(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  const {
    followersCount,
    followingCount,
    loadingFollows,
  } = useProfileFollows({
    activeTab: "balances",
    viewedAddress: walletAddress,
    isOwnProfile: true,
    chainId,
    account,
    signer: wallet?.signer,
    fetchCampaigns,
    fetchCampaignSummary,
  });

  const created = useCreatedCampaigns({
    viewedAddress: walletAddress,
    account,
    chainId,
    fetchCampaigns,
    fetchCampaignSummary,
  });

  useEffect(() => {
    let cancelled = false;
    setLoadingDraftCount(true);

    void fetchOwnerCampaignDrafts(walletAddress, { chainId, limit: 100 })
      .then((items) => {
        if (!cancelled) setDraftCount(Array.isArray(items) ? items.length : 0);
      })
      .catch(() => {
        if (!cancelled) setDraftCount(0);
      })
      .finally(() => {
        if (!cancelled) setLoadingDraftCount(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress, chainId]);

  const {
    nativeBalance,
    tokenBalances,
    loadingBalances,
    portfolioMetrics,
    loadingPortfolioMetrics,
  } = useProfileBalances({
    viewedAddress: walletAddress,
    account,
    wallet,
    fetchCampaigns,
    fetchCampaignSummary,
    profileCreatedAt: profile?.createdAt,
    chainId,
  });

  const { liveRank } = useProfileRank({
    profile,
    isOwnProfile: true,
    chainId,
    viewedAddress: walletAddress,
  });

  const { leagueCabinet, loadingLeagueCabinet } = useLeagueCabinet(chainId, walletAddress);

  const displayName = useMemo(() => {
    const name = String(profile?.displayName ?? "").trim();
    return name ? `@${name}` : shortenWallet(walletAddress) || "Command Center";
  }, [profile?.displayName, walletAddress]);

  const avatarUrl =
    profile?.avatarUrl ||
    "https://images.unsplash.com/photo-1621504450181-5d356f61d307?w=200&h=200&fit=crop";

  const value = useMemo<CommandCenterData>(() => ({
    walletAddress,
    chainId,
    walletChainId,
    profile,
    loadingProfile,
    editOpen,
    setEditOpen,
    savingProfile,
    savingAvatar,
    awaitingWallet,
    avatarInputRef,
    handleEdit,
    handlePickAvatar,
    handleAvatarSelected,
    handleSaveProfile,
    displayName,
    avatarUrl,
    attribution,
    loadingAttribution,
    followersCount,
    followingCount,
    loadingFollows,
    createdCount: created.length,
    created,
    draftCount,
    loadingDraftCount,
    nativeBalance,
    tokenBalances,
    loadingBalances,
    portfolioMetrics,
    loadingPortfolioMetrics,
    liveRank,
    leagueCabinet,
    loadingLeagueCabinet,
  }), [
    walletAddress,
    chainId,
    walletChainId,
    profile,
    loadingProfile,
    editOpen,
    setEditOpen,
    savingProfile,
    savingAvatar,
    awaitingWallet,
    avatarInputRef,
    handleEdit,
    handlePickAvatar,
    handleAvatarSelected,
    handleSaveProfile,
    displayName,
    avatarUrl,
    attribution,
    loadingAttribution,
    followersCount,
    followingCount,
    loadingFollows,
    created,
    draftCount,
    loadingDraftCount,
    nativeBalance,
    tokenBalances,
    loadingBalances,
    portfolioMetrics,
    loadingPortfolioMetrics,
    liveRank,
    leagueCabinet,
    loadingLeagueCabinet,
  ]);

  return <CommandCenterContext.Provider value={value}>{children}</CommandCenterContext.Provider>;
}

export function useCommandCenterData() {
  const ctx = useContext(CommandCenterContext);
  if (!ctx) {
    throw new Error("useCommandCenterData must be used inside CommandCenterDataProvider");
  }
  return ctx;
}

export type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";

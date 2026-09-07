import type { SupportedChainId } from "@/lib/chainConfig";

export type LaunchpadProtocolStatus = "ready" | "protocol_pending" | "unavailable";
export type LaunchpadTxReceipt = any;

export type LaunchpadSafetyCheck = {
  id: string;
  label: string;
  state: "ready" | "pending" | "blocked";
  detail: string;
};

export type LaunchpadProtocolMilestone = {
  id: string;
  label: string;
  state: "ready" | "in_progress" | "pending" | "blocked";
  detail: string;
};

export type LaunchpadSafetyStatus = {
  adapterId: "bnb" | "solana";
  chainId: SupportedChainId;
  chainLabel: string;
  protocolStatus: LaunchpadProtocolStatus;
  protocolLabel?: string;
  title: string;
  description: string;
  primaryActionLabel: string;
  checks: LaunchpadSafetyCheck[];
  milestones?: LaunchpadProtocolMilestone[];
};

export type CampaignInfo = {
  id: number;
  campaign: string;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  logoURI: string;
  metadataURI?: string;
  xAccount: string;
  website: string;
  extraLink: string;
  createdAt?: number;
  holders?: string;
  volume?: string;
  marketCap?: string;
  timeAgo?: string;
  telegram?: string;
  discord?: string;
  dexPairAddress?: string;
  /** Solana V4 bonding vaults (from campaigns.meta.solana). */
  tokenVault?: string | null;
  solVault?: string | null;
  campaignIdHex?: string | null;
};

export type CampaignMetrics = {
  sold: bigint;
  curveSupply: bigint;
  liquiditySupply: bigint;
  creatorReserve: bigint;
  currentPrice: bigint;
  basePrice: bigint;
  priceSlope: bigint;
  graduationTarget: bigint;
  graduationNativeTarget: bigint;
  liquidityBps: bigint;
  protocolFeeBps: bigint;
  launched?: boolean;
  finalizedAt?: bigint;
};

export type CampaignActivity = {
  buyers: number;
  sellers: number;
  buyVolumeWei: bigint;
  sellVolumeWei: bigint;
  fromBlock: number;
  toBlock: number;
};

export type CampaignCardStats = {
  holders: string;
  volume: string;
  marketCap: string;
  marketCapBnb?: number;
};

export type CampaignSummary = {
  campaign: CampaignInfo;
  metrics: CampaignMetrics | null;
  stats: CampaignCardStats;
};

export type CreateCampaignParams = {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  basePriceWei?: bigint;
  priceSlopeWei?: bigint;
  graduationTargetWei?: bigint;
  /** Opaque server-side Quote Asset Catalog deployment id; never a raw quote token/router address. */
  graduationQuoteAssetId?: string;
  lpReceiver?: string;
};

export type FetchCampaignPageOptions = {
  newestFirst?: boolean;
};

export type LaunchpadAdapter = {
  adapterId: "bnb" | "solana";
  protocolStatus: LaunchpadProtocolStatus;
  fetchCampaignsCount: () => Promise<number>;
  fetchCampaignPage: (offset: number, limit: number, opts?: FetchCampaignPageOptions) => Promise<CampaignInfo[]>;
  fetchCampaigns: () => Promise<CampaignInfo[]>;
  fetchCampaignLogoURI: (campaignAddress: string) => Promise<string | null>;
  fetchCampaignMetrics: (campaignAddress: string) => Promise<CampaignMetrics | null>;
  fetchCampaignCardStats: (campaign: CampaignInfo) => Promise<CampaignCardStats>;
  fetchCampaignActivity: (campaignAddress: string) => Promise<CampaignActivity | null>;
  fetchCampaignSummary: (campaign: CampaignInfo) => Promise<CampaignSummary>;
  createCampaign: (params: CreateCampaignParams) => Promise<LaunchpadTxReceipt>;
  buyTokens: (campaignAddress: string, amountWei: bigint, maxCostWei: bigint) => Promise<LaunchpadTxReceipt>;
  sellTokens: (campaignAddress: string, amountWei: bigint, minAmountWei: bigint) => Promise<LaunchpadTxReceipt>;
  finalizeCampaign: (campaignAddress: string, minTokens: bigint, minBnb: bigint) => Promise<LaunchpadTxReceipt>;
  claimCreatorRewards?: (campaignAddress: string) => Promise<LaunchpadTxReceipt>;
  claimRecruiterRewards?: (campaignAddress: string) => Promise<LaunchpadTxReceipt>;
  claimSquadRewards?: (campaignAddress: string) => Promise<LaunchpadTxReceipt>;
  claimProtocolRewards?: (campaignAddress: string) => Promise<LaunchpadTxReceipt>;
  getSafetyStatus: () => LaunchpadSafetyStatus;
  walletProvider: unknown;
  activeChainId: SupportedChainId;
  factoryAddress: string;
};

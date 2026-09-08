export type LaunchpadChain = "bnb" | "solana" | "robinhood";

export type TradeSide = "buy" | "sell";

export type LaunchpadAdapterStatus = {
  chain: LaunchpadChain;
  protocolLive: boolean;
  label: string;
  message: string;
  routeAuthorizationReady: boolean;
  warnings: string[];
};

export type LaunchpadTradePreflight = {
  allowed: boolean;
  chain: LaunchpadChain;
  side: TradeSide;
  reasons: string[];
  warnings: string[];
  schemaReady?: boolean;
  campaign?: {
    campaignAddress?: string;
    creatorWallet?: string | null;
    paused?: boolean;
    buyPaused?: boolean;
    sellPaused?: boolean;
    graduationPaused?: boolean;
    creatorBuyLockUntil?: string | null;
    creatorBuyCapBnb?: number;
    creatorBoughtBnb?: number;
    updatedAt?: string | null;
  } | null;
  walletRisk?: {
    walletAddress?: string;
    riskLevel?: string;
    restricted?: boolean;
    clusterId?: string | null;
  } | null;
  cluster?: {
    id?: string;
    wallets?: number;
    riskLevel?: string;
    restricted?: boolean;
  } | null;
  lookupErrors?: string[];
};

export type LaunchpadAdapter = {
  chain: LaunchpadChain;
  getStatus(): Promise<LaunchpadAdapterStatus>;
  preflightTrade(input: {
    side: TradeSide;
    walletAddress?: string | null;
    campaignAddress?: string | null;
    chainId?: number | string | null;
  }): Promise<LaunchpadTradePreflight>;
};

export function normalizeEvmAddress(value?: string | null) {
  const address = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : "";
}

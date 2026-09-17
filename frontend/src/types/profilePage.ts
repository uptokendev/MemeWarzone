export type TokenBalanceRow = {
  campaignAddress: string;
  tokenAddress: string;
  image: string;
  name: string;
  ticker: string;
  balanceRaw: bigint;
  balanceFormatted: string;
};

export type ActivityTradeRow = {
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: string;
  side: "buy" | "sell";
  wallet: string;
  tokenAmount: number | null;
  bnbAmount: number | null;
  priceBnb: number | null;
  campaignAddress: string;
  tokenAddress?: string | null;
  campaignName: string | null;
  campaignSymbol: string | null;
  logoUri: string | null;
  chainId?: number;
};

export const BNB_CHAIN_ID = 97;
export const SOLANA_CHAIN_ID = 101;

export const BNB_CAMPAIGN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const BNB_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const BNB_CREATOR = "0xcccccccccccccccccccccccccccccccccccccccc";
export const BNB_NAME = "Pepe Phalanx";
export const BNB_SYMBOL = "PEPE";

export const SOLANA_MINT = "MWZSoLanaTestMint111111111111111111111";
export const SOLANA_CAMPAIGN = "MWZSoLanaTestCamp111111111111111111111";
export const SOLANA_CREATOR = "MWZSoLanaTestCrea111111111111111111111";
export const SOLANA_NAME = "Solana Strike";
export const SOLANA_SYMBOL = "STRIKE";

export const EVM_RPC_56 = "https://rpc-evm-56.test.mwz";
export const EVM_RPC_97 = "https://rpc-evm-97.test.mwz";
export const SOLANA_RPC = "https://rpc-solana-101.test.mwz";

export function bnbCampaignItem(chainId = BNB_CHAIN_ID) {
  return {
    chainId,
    campaignAddress: BNB_CAMPAIGN,
    tokenAddress: BNB_TOKEN,
    creatorAddress: BNB_CREATOR,
    name: BNB_NAME,
    symbol: BNB_SYMBOL,
    logoUri: "/placeholder.svg",
    createdAtChain: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    status: "live",
    isActive: true,
    isDexTrading: false,
    marketcapBnb: "1.25",
    athMarketcapBnb: "2.50",
    raisedTotalBnb: "0.40",
    votes24h: 17,
    progressPct: 42,
    holderCount: 9,
    lastPriceBnb: "0.00012",
    vol24hBnb: "0.08",
  };
}

export function solanaCampaignItem() {
  return {
    chainId: SOLANA_CHAIN_ID,
    campaignAddress: SOLANA_CAMPAIGN,
    tokenAddress: SOLANA_MINT,
    creatorAddress: SOLANA_CREATOR,
    name: SOLANA_NAME,
    symbol: SOLANA_SYMBOL,
    logoUri: "/placeholder.svg",
    createdAtChain: new Date("2026-08-02T00:00:00.000Z").toISOString(),
    status: "live",
    isActive: true,
    isDexTrading: false,
    marketcapBnb: "3.10",
    athMarketcapBnb: "4.20",
    raisedTotalBnb: "1.10",
    votes24h: 11,
    progressPct: 55,
    holderCount: 6,
    lastPriceBnb: "0.00040",
    vol24hBnb: "0.21",
  };
}

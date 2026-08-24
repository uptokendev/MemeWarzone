export const SOLANA_LEAGUE_CHAIN_ID = 101;

export type SolanaCampaignCreatedInput = {
  campaign: string;
  mint: string;
  creator: string;
};

export function buildCampaignCreatedMessage(
  event: SolanaCampaignCreatedInput,
  slot: number,
  blockTime: Date,
  nowSec: number = Math.floor(Date.now() / 1000),
) {
  return {
    type: "campaign_created" as const,
    chainId: SOLANA_LEAGUE_CHAIN_ID,
    ts: nowSec,
    item: {
      campaignAddress: event.campaign,
      tokenAddress: event.mint,
      creatorAddress: event.creator,
      name: "Solana Launch",
      symbol: "SOL",
      createdAtChain: blockTime.toISOString(),
      blockNumber: slot,
    },
  };
}

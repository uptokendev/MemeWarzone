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
      name: `Solana ${String(event.mint || event.campaign).slice(0, 4)}`,
      symbol: String(event.mint || event.campaign).slice(0, 4),
      createdAtChain: blockTime.toISOString(),
      blockNumber: slot,
    },
  };
}

import type { Pool, PoolClient } from "pg";
import { emitNotification } from "./notifications.js";
import { normalizeChain } from "./notificationContract.js";

function campaignAddressKey(chainId: number, address: string): string {
  const raw = String(address || "").trim();
  if (!raw) return "";
  return normalizeChain(chainId) === "solana" ? raw : raw.toLowerCase();
}

export async function notifyCampaignCreated(
  db: Pool | PoolClient,
  input: {
    chainId: number;
    campaignAddress: string;
    name?: string | null;
    ticker?: string | null;
    imageUrl?: string | null;
    creatorWallet?: string | null;
  },
): Promise<void> {
  const address = campaignAddressKey(input.chainId, input.campaignAddress);
  const chain = normalizeChain(input.chainId);
  if (!address || !chain) return;
  try {
    await emitNotification(db, {
      eventType: "campaign.created",
      chain,
      chainId: input.chainId,
      dedupKey: `campaign-created:${chain}:${address}`,
      payload: {
        campaign: address,
        campaignId: address,
        project: {
          name: input.name || input.ticker || null,
          ticker: input.ticker || null,
          imageUrl: input.imageUrl || null,
        },
        creator: { wallet: input.creatorWallet || null },
        launch: { mode: "direct", launchAt: null },
      },
    });
  } catch (error) {
    console.error("[campaign-lifecycle-notifications] campaign_created failed", error);
  }
}

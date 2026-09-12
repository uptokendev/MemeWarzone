/**
 * Shared campaign lifecycle producer (Discordfix N5).
 * One function per product event. Chain identity comes from chainId.
 */

import { enqueueNotification, getNativeSymbol, normalizeChain } from "./notificationContract.js";

function campaignAddressKey(chainId, address) {
  const raw = String(address || "").trim();
  if (!raw) return "";
  const chain = normalizeChain(chainId);
  return chain === "solana" ? raw : raw.toLowerCase();
}

async function safeEnqueue(db, input, label) {
  let usedSavepoint = false;
  try {
    try {
      await db.query("SAVEPOINT mwz_notify");
      usedSavepoint = true;
    } catch {
      usedSavepoint = false;
    }
    const result = await enqueueNotification(db, input);
    if (usedSavepoint) await db.query("RELEASE SAVEPOINT mwz_notify");
    return result;
  } catch (error) {
    if (usedSavepoint) {
      try {
        await db.query("ROLLBACK TO SAVEPOINT mwz_notify");
      } catch {
        // The product transaction remains the caller's responsibility.
      }
    }
    console.error(`[campaign-lifecycle-notifications] ${label} failed`, error);
    return false;
  }
}

export async function notifyDraftCreated(db, {
  chainId,
  draftId,
  slug,
  name,
  ticker,
  imageUrl,
  creatorWallet,
  scheduledFor = null,
}) {
  const id = String(draftId || "").trim();
  if (!db || !id) return false;
  const chain = normalizeChain(chainId);
  if (!chain) return false;
  return safeEnqueue(db, {
    eventType: "campaign.draft_created",
    chainId,
    entityType: "campaign",
    entityId: id,
    dedupKey: `campaign-draft-created:${chain}:${id}`,
    payload: {
      draftId: id,
      slug: slug || id,
      project: {
        name: name || ticker || null,
        ticker: ticker || null,
        imageUrl: imageUrl || null,
      },
      creator: { wallet: creatorWallet || null },
      launch: { mode: "draft", scheduledFor },
    },
  }, "draft_created");
}

export async function notifyCampaignGraduated(db, {
  chainId,
  campaignAddress,
  name,
  market = null,
  graduatedAt = null,
}) {
  const address = campaignAddressKey(chainId, campaignAddress);
  if (!db || !address) return false;
  const chain = normalizeChain(chainId);
  if (!chain) return false;
  return safeEnqueue(db, {
    eventType: "campaign.graduated",
    chainId,
    entityType: "campaign",
    entityId: address,
    dedupKey: `graduation:${chain}:${address}`,
    payload: {
      campaign: address,
      name: name || null,
      graduatedAt: graduatedAt ? new Date(graduatedAt).toISOString() : new Date().toISOString(),
      market,
    },
  }, "campaign_graduated");
}

export async function notifyCampaignCreated(db, {
  chainId,
  campaignAddress,
  name,
  ticker,
  imageUrl,
  creatorWallet,
  scheduledFor = null,
  graduationTarget = null,
}) {
  const address = campaignAddressKey(chainId, campaignAddress);
  if (!db || !address) return false;
  const chain = normalizeChain(chainId);
  if (!chain) return false;
  const scheduled = Boolean(scheduledFor);
  return safeEnqueue(db, {
    eventType: "campaign.created",
    chainId,
    entityType: "campaign",
    entityId: address,
    dedupKey: `campaign-created:${chain}:${address}`,
    payload: {
      campaign: address,
      campaignId: address,
      project: {
        name: name || ticker || null,
        ticker: ticker || null,
        imageUrl: imageUrl || null,
      },
      creator: { wallet: creatorWallet || null },
      launch: {
        mode: scheduled ? "scheduled" : "direct",
        launchAt: scheduledFor || null,
      },
      bonding: {
        nativeSymbol: getNativeSymbol(chain),
        graduationTarget,
      },
    },
  }, "campaign_created");
}

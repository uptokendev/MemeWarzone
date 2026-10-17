/**
 * GET /api/campaigns/hidden?chainId= -> { chainId, campaigns: [address] }
 *
 * Campaigns flagged meta.publicHidden (test coins). The API feed already leaves them out; the app's
 * on-chain fallbacks (Explore, Featured, Graduated, the ticker) read factories directly and use this
 * list to leave them out too (2026-10-08: the BNB and Robinhood test coins showed up on Explore and
 * filled the ticker once the API feed for those chains was empty).
 *
 * Blocked coins (Command Center -> Abuse, lib/blockedCoins.js) are in `campaigns` too, with both their
 * campaign and token address, and listed again in `blocked` with their mode (hide | remove).
 */
import { getQuery, json } from "../server/http.js";
import { pool } from "../server/db.js";
import { loadPublicHiddenCampaignKeys } from "./lib/publicHiddenCampaigns.js";
import { loadActiveBlocks } from "./lib/blockedCoins.js";

export default async function handler(req, res) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return json(res, 405, { error: "Method not allowed" });
  const chainId = Number(getQuery(req).chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) return json(res, 400, { error: "chainId is required" });
  try {
    const keys = await loadPublicHiddenCampaignKeys(chainId);
    const prefix = `${chainId}:`;
    const campaigns = Array.from(keys).map((key) => (key.startsWith(prefix) ? key.slice(prefix.length) : key));
    const blocked = (await loadActiveBlocks(pool, chainId)).map((row) => ({
      campaignAddress: row.campaign_address || null,
      tokenAddress: row.token_address || null,
      mode: String(row.mode),
    }));
    res.setHeader("Cache-Control", "public, max-age=300");
    return json(res, 200, { chainId, campaigns, blocked });
  } catch (error) {
    console.error("[api/campaigns/hidden]", error?.message || error);
    return json(res, 503, { error: "Hidden list unavailable", chainId, campaigns: [], blocked: [] });
  }
}

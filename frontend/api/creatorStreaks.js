/**
 * Creator check-in streaks and free upvotes (founder, 2026-10-08).
 *   GET  /api/creator-streaks?wallet=W           -> today's streak status for one wallet
 *   GET  /api/creator-streaks?wallets=A,B,C      -> { streaks: { wallet: days } } for badges (live streaks only)
 *   POST /api/votes/free { chainId, campaignAddress } (30-day sign-in, Bearer)
 *        -> spends one free upvote credit on that coin
 * The check-in itself is POST /api/arena/league/checkin (api/arenaLeague.js).
 */
import { pool } from "../server/db.js";
import { badMethod, getQuery, json, readJson } from "../server/http.js";
import { createFeedSessionAuth } from "./lib/feedSessionAuth.js";
import { publicHiddenOrBlockedWhere } from "./lib/publicHiddenCampaigns.js";
import { creatorStreakStatus, liveStreaks, spendUpvoteCredit, streakWalletKey } from "./lib/creatorStreak.js";
import { patchVoteAggregates } from "./dev-fix/solana-vote-ingest.js";

export async function creatorStreaksHandler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const q = getQuery(req);
  try {
    if (q.wallets) {
      const wallets = String(q.wallets).split(",").map((w) => w.trim()).filter(Boolean);
      const streaks = await liveStreaks(wallets);
      res.setHeader("Cache-Control", "public, max-age=60");
      return json(res, 200, { streaks: Object.fromEntries(streaks) });
    }
    const wallet = streakWalletKey(q.wallet || q.address);
    if (!wallet) return json(res, 400, { error: "wallet is required" });
    return json(res, 200, await creatorStreakStatus(wallet));
  } catch (error) {
    console.error("[api/creator-streaks]", error?.message || error);
    return json(res, 500, { error: "Server error" });
  }
}

export async function freeUpvoteHandler(req, res) {
  if (req.method !== "POST") return badMethod(res);
  try {
    const session = await createFeedSessionAuth({ pool }).requireSession(req, res);
    if (!session) return;
    const body = await readJson(req).catch(() => ({}));
    const chainId = Number(body.chainId);
    const campaign = String(body.campaignAddress || body.campaign || "").trim();
    if (!chainId || !campaign) return json(res, 400, { error: "chainId and campaignAddress are required" });
    // Only a listed coin on that chain: not a hidden test coin, not an unknown address.
    const coin = await pool.query(
      `select c.campaign_address from public.campaigns c
        where c.chain_id = $1
          and (c.campaign_address = $2 or lower(c.campaign_address) = lower($2))
          and not (${publicHiddenOrBlockedWhere("c")})
        limit 1`,
      [chainId, campaign],
    );
    const canonical = coin.rows[0]?.campaign_address;
    if (!canonical) return json(res, 404, { error: "Coin not found on this chain.", code: "COIN_NOT_FOUND" });
    const result = await spendUpvoteCredit({ wallet: session.walletAddress, chainId, campaign: canonical });
    if (!result.ok) return json(res, result.code === "NO_CREDIT" ? 409 : 400, result);
    await patchVoteAggregates(chainId, canonical).catch((error) => console.warn("[api/votes/free] aggregates", error?.message || error));
    return json(res, 200, result);
  } catch (error) {
    console.error("[api/votes/free]", error?.message || error);
    return json(res, 500, { error: "Server error" });
  }
}
